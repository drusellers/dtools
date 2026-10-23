import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, readdir, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appendUsage, usageEvent, usageSummary } from './usage.mjs';
import { parseArgs } from './mail.mjs';

const now = Date.parse('2026-10-23T15:00:00Z');
async function homeFor(t) {
  const home = await mkdtemp(join(tmpdir(), 'dmail-usage-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
function event(overrides = {}) {
  return usageEvent({ parsed: parseArgs(['search', 'secret-query', '--from', 'secret-person', '--limit', '20']),
    timestamp: new Date(now).toISOString(), durationMs: 123.4,
    result: { value: [{ subject: 'secret-subject', body: 'secret-body' }],
      coverage: { count: 1, pages: 1, complete: false, reason: 'max_pages' }, '@odata.nextLink': 'secret-url' }, ...overrides });
}
function cli(home, args, env = {}, script) {
  return spawnSync(process.execPath, script ? ['--input-type=module', '-e', script] : ['libexec/dmail/mail.mjs', ...args], {
    encoding: 'utf8', env: { ...process.env, DMAIL_HOME: home, DMAIL_TENANT_ID: '', DMAIL_CLIENT_ID: '', DMAIL_USAGE_LOG: '', ...env },
  });
}

test('events allowlist command shapes and statistics, never raw inputs or responses', () => {
  const e = event();
  assert.deepEqual(e.options, { from: true, limit: 20 });
  assert.equal(e.hasQuery, true);
  assert.equal(e.durationMs, 123);
  assert.deepEqual(e.stats, { count: 1, pages: 1, complete: false, reason: 'max_pages' });
  assert.doesNotMatch(JSON.stringify(e), /secret/);
  for (const args of [
    ['download', 'secret-message', 'secret-attachment', '--output', '/secret/path'],
    ['login', '--tenant', 'secret-tenant', '--client', 'secret-client'],
    ['list', '--next', 'secret-next', '--all', '--max-pages', '4'],
    ['list', '--folder', 'secret-folder', '--since', '2026-09-23'],
  ]) {
    const value = usageEvent({ parsed: parseArgs(args), durationMs: 1, result: { name: 'secret-name', path: 'secret-path', size: 12 } });
    assert.doesNotMatch(JSON.stringify(value), /secret|2026-09-23/);
  }
  const failed = event({ error: Object.assign(new Error('secret-error'), { usageCode: 'secret-code' }) });
  assert.equal(failed.error, 'command_failed');
  assert.equal(failed.success, false);
  assert.equal(failed.stats, undefined);
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  assert.equal(event({ error: { usageCode: 'http_429' } }).error, 'http_429');
  assert.equal(usageEvent({ command: 'secret-command', durationMs: 1, error: {} }).command, 'unknown');
});

test('daily rotation, 90-day retention, concurrent append, and private permissions', async t => {
  const home = await homeFor(t);
  const dir = join(home, 'usage');
  await mkdir(dir);
  await writeFile(join(dir, '2026-07-25.jsonl'), 'expired');
  await writeFile(join(dir, '2026-07-26.jsonl'), 'retained');
  await writeFile(join(dir, 'unrelated.txt'), 'keep');
  await Promise.all(Array.from({ length: 20 }, () => appendUsage(home, event(), now)));
  assert.equal((await readdir(dir)).includes('2026-07-25.jsonl'), false);
  assert.equal(await readFile(join(dir, '2026-07-26.jsonl'), 'utf8'), 'retained');
  assert.equal(await readFile(join(dir, 'unrelated.txt'), 'utf8'), 'keep');
  const path = join(dir, '2026-10-23.jsonl');
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 20);
  for (const line of lines) assert.equal(JSON.parse(line).command, 'search');
  await appendUsage(home, event({ timestamp: '2026-10-24T12:00:00Z' }), now + 86400_000);
  assert.ok((await readdir(dir)).includes('2026-10-24.jsonl'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('usage summarizes failures, timing, coverage, option frequency, and date bounds', async t => {
  const home = await homeFor(t);
  assert.equal((await usageSummary(home, {}, now)).total, 0);
  await appendUsage(home, event(), now);
  await appendUsage(home, event({ error: { usageCode: 'http_429' }, durationMs: 200 }), now);
  await appendUsage(home, event({ timestamp: '2026-10-22T12:00:00Z' }), now - 86400_000);
  const dir = join(home, 'usage');
  await writeFile(join(dir, '2026-10-21.jsonl'), 'broken\nnull\n{}\n');
  await writeFile(join(dir, '2026-07-01.jsonl'), JSON.stringify(event({ timestamp: '2026-07-01T12:00:00Z' })));
  const summary = await usageSummary(home, {}, now);
  assert.equal(summary.total, 3);
  assert.equal(summary.skippedLines, 3);
  const search = summary.commands.search;
  assert.equal(search.failures, 1);
  assert.equal(search.results, 2);
  assert.equal(search.pages, 2);
  assert.equal(search.incomplete, 2);
  assert.deepEqual(search.errors, { http_429: 1 });
  assert.deepEqual(search.coverageReasons, { max_pages: 2 });
  assert.equal(search.options.from, 3);
  assert.equal(search.maxDurationMs, 200);
  assert.equal(search.averageDurationMs, 149);
  assert.equal((await usageSummary(home, { since: '2026-10-23', before: '2026-10-24' }, now)).total, 2);
  assert.doesNotMatch(JSON.stringify(summary), /secret/);
});

test('usage refuses symlink directories, symlink files, and hardlinked files', async t => {
  if (process.platform === 'win32') return;
  const home = await homeFor(t);
  const outside = join(home, 'outside');
  await mkdir(outside);
  await symlink(outside, join(home, 'usage'));
  await assert.rejects(appendUsage(home, event(), now));
  await assert.rejects(usageSummary(home, {}, now));
  await rm(join(home, 'usage'));
  await mkdir(join(home, 'usage'));
  const target = join(outside, 'secret');
  await writeFile(target, 'untouched');
  const path = join(home, 'usage', '2026-10-23.jsonl');
  await symlink(target, path);
  await assert.rejects(appendUsage(home, event(), now));
  await assert.rejects(usageSummary(home, {}, now));
  await rm(path);
  await link(target, path);
  await assert.rejects(appendUsage(home, event(), now));
  assert.equal(await readFile(target, 'utf8'), 'untouched');
});

test('CLI logs parse and command failures without changing stderr/stdout or leaking values', async t => {
  const home = await homeFor(t);
  let r = cli(home, ['search', 'secret-query', '--from', 'secret-person']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  r = cli(home, ['secret-command']);
  assert.equal(r.status, 1);
  r = cli(home, ['list', '--limit', 'secret-invalid']);
  assert.equal(r.status, 1);
  const logs = await readFile(join(home, 'usage', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.doesNotMatch(logs, /secret/);
  const rows = logs.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].command, 'search');
  assert.equal(rows[0].error, 'command_failed');
  assert.equal(rows[1].command, 'unknown');
  assert.equal(rows[2].error, 'invalid_arguments');
  r = cli(home, ['usage']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).total, 3);
  assert.equal(await readFile(join(home, 'usage', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8'), logs);
});

test('CLI records response stats only; disabled logging and help create no history', async t => {
  const home = await homeFor(t);
  for (const args of [[], ['--help'], ['usage']]) assert.equal(cli(home, args).status, 0);
  assert.deepEqual(await readdir(home), []);
  assert.equal(cli(home, ['logout'], { DMAIL_USAGE_LOG: '0' }).status, 0);
  assert.deepEqual(await readdir(home), []);
  // Stub Graph in a separate process: no real credentials or Microsoft requests.
  const script = `import { main, MailClient } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'libexec/dmail/mail.mjs')).href)};
    MailClient.prototype.load = async () => ({tenant:'example.com',client:'22222222-2222-2222-2222-222222222222'});
    MailClient.prototype.graph = async () => ({value:[{subject:'secret-subject',body:'secret-body'}]});
    await main(['search','secret-query','--from','secret-person']);`;
  const r = cli(home, [], {}, script);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).value[0].body, 'secret-body');
  const log = await readFile(join(home, 'usage', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.doesNotMatch(log, /secret/);
  assert.equal(JSON.parse(log).stats.count, 1);
});

test('logging failures warn generically but preserve successful command output and exit status', async t => {
  const home = await homeFor(t);
  await writeFile(join(home, 'usage'), 'blocked');
  const r = cli(home, ['logout']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { status: 'signed_out' });
  assert.match(r.stderr, /Usage logging unavailable/);
  assert.doesNotMatch(r.stderr, new RegExp(home));
});
