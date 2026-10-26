import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, readdir, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendUsage, usageEvent, usageSummary } from './usage.mjs';
import { parseArgs, main } from './todo.mjs';

const now = Date.parse('2026-10-23T15:00:00Z');
async function homeFor(t) {
  const home = await mkdtemp(join(tmpdir(), 'dtodo-usage-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
function event(overrides = {}) {
  return usageEvent({ parsed: parseArgs(['list', '--source', 'wrike', '--limit', '20']), timestamp: new Date(now).toISOString(), durationMs: 123.4,
    result: { tasks: [{ title: 'private-title', id: 'private-id', url: 'private-link', notes: 'private-notes' }], coverage: { pages: 1, complete: false, reason: 'max_pages' } }, ...overrides });
}

test('events allowlist shapes and numeric stats, never task content, IDs, links, raw errors, or option values', () => {
  const e = event();
  assert.deepEqual(e.options, { source: true, limit: 20 });
  assert.deepEqual(e.stats, { count: 1, pages: 1, complete: false, reason: 'max_pages' });
  assert.equal(e.durationMs, 123);
  assert.doesNotMatch(JSON.stringify(e), /private|wrike/);
  const failed = event({ error: Object.assign(new Error('private-error'), { usageCode: 'private-code' }) });
  assert.equal(failed.error, 'command_failed');
  assert.equal(failed.success, false);
  assert.equal(failed.stats, undefined);
  assert.doesNotMatch(JSON.stringify(failed), /private/);
  assert.equal(event({ error: { usageCode: 'http_429' } }).error, 'http_429');
  assert.equal(usageEvent({ command: 'private-command', durationMs: 1, error: {} }).command, 'unknown');
});

test('daily rotation, 90-day pruning, concurrent append, and private permissions', async t => {
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
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 20);
  await appendUsage(home, event({ timestamp: '2026-10-24T12:00:00Z' }), now + 86400_000);
  assert.ok((await readdir(dir)).includes('2026-10-24.jsonl'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test('summaries include errors, options, durations, coverage, date bounds, and malformed-line counts', async t => {
  const home = await homeFor(t);
  assert.equal((await usageSummary(home, {}, now)).total, 0);
  await appendUsage(home, event(), now);
  await appendUsage(home, event({ error: { usageCode: 'http_429' }, durationMs: 200 }), now);
  await appendUsage(home, event({ timestamp: '2026-10-22T12:00:00Z' }), now - 86400_000);
  await writeFile(join(home, 'usage', '2026-10-21.jsonl'), 'broken\nnull\n{}\n');
  const summary = await usageSummary(home, {}, now);
  assert.equal(summary.total, 3);
  assert.equal(summary.skippedLines, 3);
  assert.equal(summary.commands.list.results, 2);
  assert.equal(summary.commands.list.failures, 1);
  assert.equal(summary.commands.list.averageDurationMs, 149);
  assert.equal(summary.commands.list.incomplete, 2);
  assert.deepEqual(summary.commands.list.errors, { http_429: 1 });
  assert.deepEqual(summary.commands.list.options, { source: 3, limit: 3 });
  assert.equal((await usageSummary(home, { since: '2026-10-23', before: '2026-10-24' }, now)).total, 2);
  assert.doesNotMatch(JSON.stringify(summary), /private/);
});

test('logs refuse symlink directories/files and hardlinks', async t => {
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

test('main logs successes and failures, omits invalid inputs, and skips help/usage and disabled logging', async t => {
  const home = await homeFor(t);
  const output = [], errors = [];
  const options = { env: { DTODO_HOME: home }, stdout: x => output.push(x), stderr: x => errors.push(x), things: async () => ({ tasks: [{ title: 'private-title', id: 'private-id' }], coverage: { pages: 0, complete: true, reason: 'exhausted' } }) };
  for (const args of [[], ['--help'], ['usage'], ['usage', '--since', 'private-invalid']]) await main(args, options);
  assert.deepEqual(await readdir(home), []);
  assert.equal(await main(['list', '--source', 'things'], options), 0);
  assert.equal(await main(['list', '--source', 'wrike'], options), 1);
  assert.equal(await main(['private-command'], options), 1);
  assert.equal(await main(['list', '--limit', 'private-invalid'], options), 1);
  const path = join(home, 'usage', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const logs = await readFile(path, 'utf8');
  assert.doesNotMatch(logs, /private|wrike|things/);
  const rows = logs.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].stats.count, 1);
  assert.equal(rows[1].success, false);
  assert.equal(rows[2].command, 'unknown');
  assert.equal(rows[3].error, 'invalid_arguments');
  assert.deepEqual(rows[3].options, {});
  assert.equal(await main(['usage'], options), 0);
  assert.equal(JSON.parse(output.at(-1)).total, 4);
  assert.equal(await main(['list', '--source', 'things'], { ...options, env: { DTODO_HOME: home, DTODO_USAGE_LOG: '0' } }), 0);
  assert.equal(await readFile(path, 'utf8'), logs);
});

test('logging failures warn generically but cannot break successful reads', async t => {
  const home = await homeFor(t);
  await writeFile(join(home, 'usage'), 'blocked');
  const errors = [], output = [];
  const code = await main(['list', '--source', 'things'], { env: { DTODO_HOME: home }, stdout: x => output.push(x), stderr: x => errors.push(x), things: async () => ({ tasks: [], coverage: { pages: 0, complete: true, reason: 'exhausted' } }) });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output[0]).tasks, []);
  assert.deepEqual(errors, ['dtodo: Usage logging unavailable.']);
});
