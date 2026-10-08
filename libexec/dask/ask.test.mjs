import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { validateBatch, validateResult, startSession } from './ask.mjs';

const fixture = {
  title: 'Plan <script>alert(1)</script>',
  questions: [
    { id: 'storage', prompt: 'Where?', options: [{ id: 'sqlite', label: 'SQLite' }, { id: 'json', label: 'JSON' }] },
    { id: 'priorities', prompt: 'Priorities?', type: 'multiple', options: [{ id: 'tests', label: 'Tests' }, { id: 'ui', label: 'UI' }] },
    { id: 'extras', prompt: 'Extras?', required: false, options: [{ id: 'dark', label: 'Dark mode' }] },
  ],
};
const batch = validateBatch(fixture);
const valid = {
  status: 'answered',
  answers: [
    { questionId: 'storage', selected: ['sqlite'], note: 'Keep it local.' },
    { questionId: 'priorities', selected: ['tests', 'ui'], note: '' },
    { questionId: 'extras', selected: [] },
  ],
};

async function sessionFor(t) {
  const session = await startSession(batch);
  t.after(() => session.close());
  return session;
}

function post(session, body, overrides = {}) {
  return fetch(session.url + 'answers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(session.url).origin, ...overrides },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function cli(args, input) {
  const child = spawn(fileURLToPath(new URL('../../bin/dask', import.meta.url)), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let resolveUrl;
  const url = new Promise((resolve) => { resolveUrl = resolve; });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//);
    if (match) resolveUrl(match[0]);
  });
  child.stdin.end(input);
  const done = once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
  return { child, url, done };
}

test('normalizes question defaults and supports multiple choice', () => {
  assert.equal(batch.questions[0].type, 'single');
  assert.equal(batch.questions[0].required, true);
  assert.equal(batch.questions[1].type, 'multiple');
  assert.equal(batch.questions[2].required, false);
  assert.equal(validateBatch({ questions: fixture.questions }).title, 'A few questions for you');
});

test('rejects invalid or ambiguous batches', () => {
  for (const input of [
    null, [], {}, { questions: [] },
    { questions: [fixture.questions[0], fixture.questions[0]] },
    { questions: [{ ...fixture.questions[0], type: 'text' }] },
    { questions: [{ ...fixture.questions[0], required: 'yes' }] },
    { questions: [{ ...fixture.questions[0], options: [] }] },
    { questions: [{ ...fixture.questions[0], options: [{ id: 'x', label: 'X' }, { id: 'x', label: 'Y' }] }] },
    { questions: [{ ...fixture.questions[0], options: [null] }] },
  ]) assert.throws(() => validateBatch(input));
});

test('validates selections and notes, orders answers, and strips extra fields', () => {
  const result = validateResult({ ...valid, answers: [...valid.answers].reverse(), ignored: 'x' }, batch);
  assert.deepEqual(result.answers.map((answer) => answer.questionId), ['storage', 'priorities', 'extras']);
  assert.equal(result.answers[2].note, '');
  assert.equal(result.answers[0].note, 'Keep it local.');
  assert.deepEqual(validateResult({ status: 'cancelled', answers: valid.answers }, batch), { status: 'cancelled' });
});

test('rejects invalid answers', () => {
  const replace = (patch) => ({ ...valid, answers: [{ ...valid.answers[0], ...patch }, ...valid.answers.slice(1)] });
  for (const input of [
    null, { status: 'answered', answers: [] },
    replace({ questionId: 'unknown' }), replace({ selected: ['unknown'] }),
    replace({ selected: [] }), replace({ selected: ['sqlite', 'json'] }),
    replace({ selected: ['sqlite', 'sqlite'] }), replace({ selected: 'sqlite' }),
    replace({ note: 5 }),
    { ...valid, answers: [valid.answers[0], valid.answers[0], valid.answers[2]] },
  ]) assert.throws(() => validateResult(input, batch));
});

test('serves local UI with security headers and no injected question HTML', async (t) => {
  const session = await sessionFor(t);
  const response = await fetch(session.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(await response.text(), /alert\(1\)/);
  assert.deepEqual(await (await fetch(session.url + 'questions')).json(), batch);
  for (const asset of ['app.js', 'style.css']) assert.equal((await fetch(session.url + asset)).status, 200);
  assert.equal((await fetch(new URL('/questions', session.url))).status, 404);
});

test('rejects foreign hosts, origins, content types and invalid bodies without finishing', async (t) => {
  const session = await sessionFor(t);
  // Node's fetch rewrites Host, so use the raw HTTP client for this check.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(session.url, { headers: { Host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post(session, valid, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post(session, valid, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(session, '{')).status, 400);
  assert.equal((await post(session, { status: 'answered', answers: [] })).status, 400);
  assert.equal((await post(session, 'x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await post(session, valid)).status, 200);
  assert.equal((await session.result).status, 'answered');
  assert.equal((await post(session, valid)).status, 409);
});

test('explicit browser cancellation returns a structured result', async (t) => {
  const session = await sessionFor(t);
  assert.equal((await post(session, { status: 'cancelled' })).status, 200);
  assert.deepEqual(await session.result, { status: 'cancelled' });
});

test('concurrent sessions have isolated URLs and results', async (t) => {
  const first = await sessionFor(t);
  const second = await sessionFor(t);
  assert.notEqual(first.url, second.url);
  assert.equal((await fetch(new URL(new URL(first.url).pathname, second.url))).status, 404);
  await post(first, valid);
  await post(second, { status: 'cancelled' });
  assert.equal((await first.result).status, 'answered');
  assert.equal((await second.result).status, 'cancelled');
});

test('CLI stdin round trip has only one JSON object on stdout', { timeout: 10000 }, async (t) => {
  const run = cli(['ask', '-', '--no-open'], JSON.stringify(fixture));
  t.after(() => run.child.kill());
  const url = await run.url;
  assert.equal((await post({ url }, valid)).status, 200);
  const result = await run.done;
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout).answers[0].note, 'Keep it local.');
});

test('CLI file input times out cleanly', { timeout: 10000 }, async (t) => {
  const file = fileURLToPath(new URL('../../examples/dask/questions.json', import.meta.url));
  const run = cli(['ask', file, '--no-open', '--timeout', '1']);
  t.after(() => run.child.kill());
  const result = await run.done;
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'cancelled', reason: 'timeout' });
});

test('CLI interruption notifies agent and exits 130', { timeout: 10000 }, async (t) => {
  const run = cli(['ask', '-', '--no-open'], JSON.stringify(fixture));
  t.after(() => run.child.kill());
  await run.url;
  run.child.kill('SIGINT');
  const result = await run.done;
  assert.equal(result.code, 130);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'cancelled', reason: 'interrupted' });
});

test('CLI invalid input fails before opening a server and leaves stdout empty', async () => {
  for (const [args, input] of [
    [['ask', '-', '--no-open'], '{'],
    [['ask', '-', '--no-open'], '{"questions":[]}'],
    [['ask', '-', '--no-open'], 'x'.repeat(1024 * 1024 + 1)],
    [['ask', '-', '--timeout', '0'], '{}'],
    [['ask'], undefined],
  ]) {
    const result = await cli(args, input).done;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /dask:/);
    assert.doesNotMatch(result.stderr, /http:\/\//);
  }
});
