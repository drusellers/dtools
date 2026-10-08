import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
const assets = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['style.css', ['style.css', 'text/css; charset=utf-8']],
]);

const usage = `dask — ask an agent's questions in your browser

Usage:
  dask ask file.json [--no-open] [--timeout seconds]
  dask ask -         [--no-open] [--timeout seconds]

Reads a question batch from a file or stdin. Waits for answers and prints one
JSON result to stdout. Browser URL and diagnostics go to stderr.
Requires Node.js 20+. Automatically opens the browser on macOS.
`;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateBatch(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Expected a question batch object.');
  requireValue(input.title === undefined || nonempty(input.title), 'title must be a nonempty string.');
  requireValue(Array.isArray(input.questions) && input.questions.length > 0, 'questions must be a nonempty array.');
  const ids = new Set();
  const questions = input.questions.map((question) => {
    requireValue(question && nonempty(question.id) && nonempty(question.prompt), 'Each question needs a nonempty id and prompt.');
    requireValue(!ids.has(question.id), `Duplicate question id: ${question.id}`);
    ids.add(question.id);
    const type = question.type ?? 'single';
    requireValue(type === 'single' || type === 'multiple', `${question.id}: type must be single or multiple.`);
    requireValue(question.required === undefined || typeof question.required === 'boolean', `${question.id}: required must be boolean.`);
    requireValue(Array.isArray(question.options) && question.options.length > 0, `${question.id}: options must be a nonempty array.`);
    const optionIds = new Set();
    const options = question.options.map((option) => {
      requireValue(option && nonempty(option.id) && nonempty(option.label), `${question.id}: each option needs an id and label.`);
      requireValue(!optionIds.has(option.id), `${question.id}: duplicate option id ${option.id}.`);
      requireValue(option.description === undefined || typeof option.description === 'string', `${question.id}: option description must be a string.`);
      optionIds.add(option.id);
      return { id: option.id, label: option.label, description: option.description ?? '' };
    });
    return { id: question.id, prompt: question.prompt, type, required: question.required ?? true, options };
  });
  return { title: input.title ?? 'A few questions for you', questions };
}

export function validateResult(input, batch) {
  requireValue(input && typeof input === 'object', 'Expected an answer object.');
  if (input.status === 'cancelled') return { status: 'cancelled' };
  requireValue(input.status === 'answered' && Array.isArray(input.answers), 'Expected status answered and an answers array.');
  requireValue(input.answers.length === batch.questions.length, 'Answer every question exactly once.');
  const seen = new Set();
  const byId = new Map(batch.questions.map((question) => [question.id, question]));
  const answers = input.answers.map((answer) => {
    const question = byId.get(answer?.questionId);
    requireValue(question && !seen.has(question.id), 'Unknown or duplicate question id.');
    seen.add(question.id);
    requireValue(Array.isArray(answer.selected), `${question.id}: selected must be an array.`);
    const allowed = new Set(question.options.map((option) => option.id));
    requireValue(answer.selected.every((id) => allowed.has(id)), `${question.id}: unknown option.`);
    requireValue(new Set(answer.selected).size === answer.selected.length, `${question.id}: duplicate selection.`);
    requireValue(!question.required || answer.selected.length > 0, `${question.id}: select an option.`);
    requireValue(question.type !== 'single' || answer.selected.length <= 1, `${question.id}: select only one option.`);
    requireValue(answer.note === undefined || typeof answer.note === 'string', `${question.id}: note must be a string.`);
    return { questionId: question.id, selected: answer.selected, note: answer.note ?? '' };
  });
  const ordered = new Map(answers.map((answer) => [answer.questionId, answer]));
  return { status: 'answered', answers: batch.questions.map((question) => ordered.get(question.id)) };
}

async function readLimited(stream) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of stream) {
    bytes += chunk.length;
    requireValue(bytes <= MAX_BYTES, 'JSON input exceeds 1 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startSession(batch) {
  const prefix = `/${randomBytes(24).toString('hex')}/`;
  const files = new Map(await Promise.all([...assets].map(async ([route, [file, type]]) =>
    [route, { body: await readFile(new URL(file, import.meta.url)), type }])));
  let origin;
  let complete = false;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const finish = (value) => {
    if (complete) return false;
    complete = true;
    resolveResult(value);
    return true;
  };
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8', callback) => {
      response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Connection': 'close',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      response.end(body, callback);
    };
    const error = (status, message) => send(status, JSON.stringify({ error: message }));
    try {
      if (request.headers.host !== new URL(origin).host) return error(403, 'Invalid host.');
      if (!request.url.startsWith(prefix)) return error(404, 'Not found.');
      const route = request.url.slice(prefix.length);
      if (request.method === 'GET' && files.has(route)) {
        const asset = files.get(route);
        return send(200, asset.body, asset.type);
      }
      if (request.method === 'GET' && route === 'questions') return send(200, JSON.stringify(batch));
      if (request.method !== 'POST' || route !== 'answers') return error(404, 'Not found.');
      if (request.headers.origin !== origin) return error(403, 'Invalid origin.');
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return error(415, 'Expected application/json.');
      if (complete) return error(409, 'This session is already complete.');
      const length = Number(request.headers['content-length']);
      // Require a bounded body before reading it. Browser fetch supplies this header.
      if (!Number.isInteger(length) || length < 0) return error(411, 'Content-Length required.');
      if (length > MAX_BYTES) return error(413, 'Answer exceeds 1 MiB.');
      const value = validateResult(JSON.parse(await readLimited(request)), batch);
      if (complete) return error(409, 'This session is already complete.');
      complete = true;
      send(200, JSON.stringify({ ok: true }), undefined, () => resolveResult(value));
    } catch (err) {
      if (!response.headersSent && !response.destroyed) error(400, err.message);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin + prefix,
    result,
    finish,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function parseArgs(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) return { help: true };
  requireValue(args[0] === 'ask', 'Expected "dask ask file.json" or "dask ask -".');
  let source;
  let noOpen = false;
  let timeout = 0;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--no-open') noOpen = true;
    else if (arg === '--timeout') {
      const raw = args[++index];
      requireValue(raw && /^\d+$/.test(raw), '--timeout needs a positive whole number of seconds.');
      timeout = Number(raw);
      requireValue(timeout > 0 && timeout <= 2147483, '--timeout is out of range.');
    } else {
      requireValue((arg === '-' || !arg.startsWith('-')) && !source, `Unexpected argument: ${arg}`);
      source = arg;
    }
  }
  requireValue(source, 'Provide a JSON file or - for stdin.');
  return { source, noOpen, timeout };
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.help) { process.stdout.write(usage); return; }
  requireValue(Number(process.versions.node.split('.')[0]) >= 20, 'Node.js 20 or newer is required.');
  const raw = options.source === '-' ? await readLimited(process.stdin) : await readFile(options.source);
  requireValue(Buffer.byteLength(raw) <= MAX_BYTES, 'JSON input exceeds 1 MiB.');
  const batch = validateBatch(JSON.parse(raw.toString()));
  const session = await startSession(batch);
  const interrupt = () => session.finish({ status: 'cancelled', reason: 'interrupted' });
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.stderr.write(`dask: waiting for answers\n${session.url}\n`);
  const timer = options.timeout ? setTimeout(() => session.finish({ status: 'cancelled', reason: 'timeout' }), options.timeout * 1000) : undefined;
  try {
    if (!options.noOpen && process.platform === 'darwin') {
      const browser = spawn('open', [session.url], { stdio: 'ignore' });
      browser.on('error', (err) => process.stderr.write(`dask: could not open browser: ${err.message}; open the URL above.\n`));
      browser.on('exit', (code) => {
        if (code) process.stderr.write('dask: could not open browser; open the URL above.\n');
      });
    }
    const result = await session.result;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.reason === 'interrupted') process.exitCode = 130;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`dask: ${err.message}\n`);
    process.exitCode = 1;
  });
}
