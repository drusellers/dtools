import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WrikeClient } from './wrike.mjs';
import { thingsTasks } from './things.mjs';
import { appendUsage, usageEvent, usageSummary } from './usage.mjs';
import { saveCredentials, resolveCredentials, promptToken, logout } from './auth.mjs';

const HELP = `Usage:
  dtodo login [--host www.wrike.com]
  dtodo logout
  dtodo list [--source things|wrike] [--limit 100] [--max-pages 10]
  dtodo today [--source things|wrike] [--limit 100] [--max-pages 10]
  dtodo overdue [--source things|wrike] [--limit 100] [--max-pages 10]
  dtodo usage [--since YYYY-MM-DD] [--before YYYY-MM-DD]

Read-only, JSON on stdout; diagnostics on stderr. No syncing or task writes.
Default source: both (both must succeed). Only open/deferred tasks are included.
Wrike: only assignments to the token owner; every task includes its permalink.
Login prompts for a hidden personal token, verifies it, and saves it privately.
WRIKE_TOKEN overrides saved credentials. Optional WRIKE_HOST (or login --host):
www.wrike.com, app-eu.wrike.com, app-us2.wrike.com. Logout removes only the saved token.
Things: macOS, Things running, Automation permission. Uses supported scripting, not SQLite.
Today: Things' Today list; Wrike tasks due today. Overdue: due before today.
Calendar dates use the machine's local day; Wrike due dates retain their source date.
--limit is Wrike page size (1-1000); --max-pages bounds Wrike paging (1-100).
Check coverage.complete: date-filtered results may be incomplete when paging is capped.
DTODO_HOME overrides the private credentials/usage directory (default: ~/.config/dtools/dtodo,
respecting XDG_CONFIG_HOME). Logs rotate daily in UTC and retain 90 days.
Only command shapes/counts/timing are logged; DTODO_USAGE_LOG=0 disables logging.
Requires Node.js 20+. Saved token: wrike-credentials.json, mode 600 (directory 700).
Tokens are unencrypted at rest; use disk encryption/private ACLs. No secrets are logged.
Task content is never cached. Login is token-based, not browser OAuth.
DTODO_DEBUG=1 prints the Wrike host and masked token suffix (last 5) to stderr only.
`;

export function parseArgs(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') return { command: 'help' };
  const command = args[0];
  const allowed = command === 'login' ? ['host'] : command === 'logout' ? [] : command === 'usage' ? ['since', 'before'] : ['list', 'today', 'overdue'].includes(command) ? ['source', 'limit', 'max-pages'] : null;
  if (!allowed) throw new Error('Unknown command. Use dtodo --help.');
  const options = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') return { command: 'help' };
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw new Error('Unexpected or repeated argument. Use dtodo --help.');
    const value = args[++i];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for --${key}.`);
    options[key] = value;
  }
  if (options.host && !['www.wrike.com', 'app-eu.wrike.com', 'app-us2.wrike.com'].includes(options.host)) throw new Error('--host must be www.wrike.com, app-eu.wrike.com, or app-us2.wrike.com.');
  if (options.source && !['things', 'wrike'].includes(options.source)) throw new Error('--source must be things or wrike.');
  for (const [key, max] of [['limit', 1000], ['max-pages', 100]]) {
    if (options[key] && (!/^\d+$/.test(options[key]) || +options[key] < 1 || +options[key] > max)) throw new Error(`--${key} must be an integer from 1 to ${max}.`);
  }
  if (options.source === 'things' && (options.limit || options['max-pages'])) throw new Error('Paging options apply only to Wrike.');
  for (const key of ['since', 'before']) {
    const date = options[key];
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error(`--${key} must be a valid YYYY-MM-DD date (UTC).`);
  }
  if (options.since && options.before && options.since >= options.before) throw new Error('--since must precede --before.');
  return { command, options };
}

export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export async function readTasks(parsed, { things = thingsTasks, wrike, now = new Date() }) {
  const { command, options } = parsed;
  const sources = options.source ? [options.source] : ['things', 'wrike'];
  const day = localDay(now);
  const tasks = [];
  const coverage = { count: 0, pages: 0, complete: true, reason: 'exhausted', sources: {} };
  // Fail closed: never report one source as a successful combined result.
  for (const source of sources) {
    const result = source === 'things' ? await things({ command }) : await wrike.list({ limit: +(options.limit || 100), maxPages: +(options['max-pages'] || 10) });
    const selected = result.tasks.filter(task => command === 'list' || (command === 'today' && source === 'things') ||
      (command === 'today' ? task.dueDate === day : task.dueDate && task.dueDate < day));
    tasks.push(...selected);
    coverage.sources[source] = { ...result.coverage, count: selected.length };
    coverage.pages += result.coverage.pages;
    if (!result.coverage.complete) { coverage.complete = false; coverage.reason = 'max_pages'; }
  }
  coverage.count = tasks.length;
  return { tasks, coverage };
}

export async function main(args = process.argv.slice(2), { env = process.env, stdout = value => console.log(value), stderr = value => console.error(value), things = thingsTasks, fetchImpl = fetch, tokenPrompt = promptToken } = {}) {
  const start = performance.now();
  const home = env.DTODO_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dtools', 'dtodo');
  let parsed, result, failure;
  const wrikeClient = credentials => {
    const client = new WrikeClient({ ...credentials, fetchImpl });
    if (env.DTODO_DEBUG === '1') {
      const suffix = credentials.token.length > 5 ? `…${credentials.token.slice(-5)}` : '[redacted]';
      stderr(`dtodo: Wrike host=${credentials.host} token=${suffix}`);
    }
    return client;
  };
  try {
    try { parsed = parseArgs(args); }
    catch (error) { error.usageCode = 'invalid_arguments'; throw error; }
    if (parsed.command === 'help') { stdout(HELP); return 0; }
    if (parsed.command === 'login') {
      const state = { version: 1, token: env.WRIKE_TOKEN || await tokenPrompt(), host: parsed.options.host || env.WRIKE_HOST || 'www.wrike.com' };
      if (!state.token) throw new Error('A Wrike token is required.');
      // Validate before any request or credential write, including token characters.
      const credentials = await resolveCredentials(home, { WRIKE_TOKEN: state.token, WRIKE_HOST: state.host });
      await wrikeClient(credentials).currentUser();
      await saveCredentials(home, credentials);
      result = { status: 'signed_in' };
    } else if (parsed.command === 'logout') {
      await logout(home);
      result = { status: 'signed_out', environmentTokenActive: Boolean(env.WRIKE_TOKEN) };
    } else {
      result = parsed.command === 'usage' ? await usageSummary(home, parsed.options) : await readTasks(parsed, {
        things, wrike: { list: async options => wrikeClient(await resolveCredentials(home, env)).list(options) },
      });
    }
    stdout(JSON.stringify(result, null, 2));
  } catch (error) {
    failure = error;
    stderr(`dtodo: ${error.message}`);
  } finally {
    if (parsed?.command !== 'help' && parsed?.command !== 'usage' && args[0] !== 'usage' && env.DTODO_USAGE_LOG !== '0') {
      try { await appendUsage(home, usageEvent({ parsed, command: args[0], result, error: failure, durationMs: performance.now() - start })); }
      catch { stderr('dtodo: Usage logging unavailable.'); }
    }
  }
  return failure ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
