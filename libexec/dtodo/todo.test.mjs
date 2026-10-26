import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseArgs, localDay, readTasks, main } from './todo.mjs';
import { thingsTasks } from './things.mjs';
import { WrikeClient, wrikeBase } from './wrike.mjs';

const coverage = { pages: 1, complete: true, reason: 'exhausted' };
const task = (id, dueDate = null) => ({ id, dueDate, title: 'private-title' });
const wireTask = (id = 'task', overrides = {}) => ({ id, title: 'private-title', status: 'Active', responsibleIds: ['me'], parentIds: ['folder'], dates: { due: '2026-10-23T00:00:00Z' }, permalink: 'https://www.wrike.com/open.htm?id=123', ...overrides });
const response = data => ({ ok: true, json: async () => data });
function clientFor(pages, requests = []) {
  return new WrikeClient({ token: 'private-token', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return response(url.pathname.endsWith('/contacts') ? { data: [{ id: 'me', me: true }] } : pages.shift());
  } });
}

test('argument validation is strict, including paging and valid date ranges', () => {
  assert.deepEqual(parseArgs([]), { command: 'help' });
  assert.deepEqual(parseArgs(['list', '--source', 'things']), { command: 'list', options: { source: 'things' } });
  for (const args of [
    ['write'], ['list', '--source', 'other'], ['list', '--limit', '0'], ['today', '--max-pages', '101'],
    ['list', '--limit', '1001'], ['list', '--limit', '1.5'], ['list', '--source'], ['list', 'private-title'],
    ['list', '--source', 'wrike', '--source', 'things'], ['usage', '--since', '2026-02-30'],
    ['usage', '--since', '2026-10-23', '--before', '2026-10-23'], ['list', '--source', 'things', '--limit', '5'],
  ]) assert.throws(() => parseArgs(args), args.join(' '));
  assert.equal(parseArgs(['usage', '--since', '2024-02-29']).options.since, '2024-02-29');
  assert.equal(localDay(new Date(2026, 9, 23, 23, 59)), '2026-10-23');
});

test('Wrike requests only me and assigned unfinished tasks, preserves links, pages and deduplicates', async () => {
  const requests = [];
  const client = clientFor([
    { data: [wireTask(), wireTask('not-mine', { responsibleIds: ['other'] }), wireTask('done', { status: 'Completed' })], nextPageToken: 'private-next' },
    { data: [wireTask(), wireTask('second', { status: 'Deferred', dates: {} })] },
  ], requests);
  const result = await client.list({ limit: 20, maxPages: 3 });
  assert.deepEqual(result.tasks.map(t => t.id), ['task', 'second']);
  assert.equal(result.tasks[0].url, wireTask().permalink);
  assert.equal(result.tasks[0].dueDate, '2026-10-23');
  assert.deepEqual(result.tasks[0].projectIds, ['folder']);
  assert.equal(result.tasks[1].dueDate, null);
  assert.equal(result.tasks[1].status, 'deferred');
  assert.deepEqual(result.coverage, { pages: 2, complete: true, reason: 'exhausted' });
  assert.equal(requests[0].url.searchParams.get('me'), 'true');
  for (const { url, options } of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    assert.equal(url.origin, 'https://www.wrike.com');
    if (url.pathname.endsWith('/tasks')) {
      assert.deepEqual(JSON.parse(url.searchParams.get('responsibles')), ['me']);
      assert.deepEqual(JSON.parse(url.searchParams.get('status')), ['Active', 'Deferred']);
      assert.ok(JSON.parse(url.searchParams.get('fields')).includes('responsibleIds'));
    }
  }
  assert.equal(requests[2].url.searchParams.get('nextPageToken'), 'private-next');
});

test('Wrike caps pagination explicitly and refuses malformed assignments, links, identities, and cycles', async () => {
  const result = await clientFor([{ data: [wireTask()], nextPageToken: 'next' }]).list({ maxPages: 1 });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'max_pages');
  for (const overrides of [{ permalink: null }, { permalink: 'https://evil.example/task' }, { permalink: 'javascript:alert(1)' }, { responsibleIds: undefined }, { dates: { due: 'bad-date' } }]) {
    await assert.rejects(clientFor([{ data: [wireTask('task', overrides)] }]).list());
  }
  await assert.rejects(clientFor([{ data: [], nextPageToken: 'same' }, { data: [], nextPageToken: 'same' }]).list(), /repeated/);
  await assert.rejects(new WrikeClient({ token: 'secret', fetchImpl: async () => response({ data: [{ id: 'other' }] }) }).list(), /current user/);
  await assert.rejects(new WrikeClient({ fetchImpl: () => assert.fail('no requests without token') }).list(), /WRIKE_TOKEN/);
  assert.throws(() => wrikeBase('evil.example'));
  assert.equal(wrikeBase('app-eu.wrike.com'), 'https://app-eu.wrike.com/api/v4');
});

test('Wrike errors never echo credentials or remote error bodies', async () => {
  const client = new WrikeClient({ token: 'private-token', fetchImpl: async () => ({ ok: false, status: 401, json: () => assert.fail('do not read error body') }) });
  await assert.rejects(client.list(), error => error.usageCode === 'http_401' && !error.message.includes('private'));
  client.fetch = async () => { throw new Error('private-url-and-token'); };
  await assert.rejects(client.list(), error => error.usageCode === 'network' && !error.message.includes('private'));
});

test('today respects Things list membership rather than deadlines; overdue uses local calendar day', async () => {
  const calls = [];
  const things = async ({ command }) => { calls.push(command); return { tasks: [task('planned', '2026-10-24'), task('old', '2026-10-22')], coverage: { ...coverage, pages: 0 } }; };
  const wrike = { list: async () => ({ tasks: [task('work-today', '2026-10-23'), task('work-overdue', '2026-10-22'), task('undated')], coverage: { pages: 2, complete: false, reason: 'max_pages' } }) };
  const dependencies = { things, wrike, now: new Date(2026, 9, 23, 0, 1) };
  const today = await readTasks(parseArgs(['today']), dependencies);
  assert.deepEqual(today.tasks.map(t => t.id), ['planned', 'old', 'work-today']);
  assert.deepEqual(calls, ['today']);
  assert.equal(today.coverage.complete, false);
  assert.equal(today.coverage.count, 3);
  const overdue = await readTasks(parseArgs(['overdue']), dependencies);
  assert.deepEqual(overdue.tasks.map(t => t.id), ['old', 'work-overdue']);
  const personal = await readTasks(parseArgs(['list', '--source', 'things']), { ...dependencies, wrike: { list: () => assert.fail('not requested') } });
  assert.equal(personal.coverage.complete, true);
});

test('Things adapter uses static script arguments, bounds execution, and sanitizes process errors', async () => {
  const tasks = [{ source: 'things', id: 'id', title: 'private-title', status: 'open' }];
  const result = await thingsTasks({ platform: 'darwin', command: 'today', run: async (exe, args, options) => {
    assert.equal(exe, '/usr/bin/osascript');
    assert.equal(args.at(-1), 'today');
    assert.equal(options.timeout, 120_000);
    return { stdout: JSON.stringify(tasks) };
  } });
  assert.deepEqual(result.tasks, tasks);
  await assert.rejects(thingsTasks({ platform: 'linux' }), /macOS/);
  await assert.rejects(thingsTasks({ platform: 'darwin', run: async () => { throw new Error('private-title'); } }), error => !error.message.includes('private-title'));
  await assert.rejects(thingsTasks({ platform: 'darwin', run: async () => ({ stdout: '{}' }) }), /Invalid Things/);
});

test('Things JXA only reads properties, excludes trash/projects/closed items, and escapes titles safely', async () => {
  const script = await readFile(new URL('./things.js', import.meta.url), 'utf8');
  const make = (id, status = 'open') => ({ id: () => id, status: () => status, name: () => 'title\n"quoted"', dueDate: () => new Date(2026, 9, 23), project: () => ({ name: () => 'project' }), area: () => null });
  const items = [make('task'), make('trash'), make('project'), make('done', 'completed')];
  const app = { running: () => true, projects: { id: () => ['project'] }, toDos: { whose: () => () => items }, lists: { byId: id => ({ toDos: Object.assign(() => items, { id: () => id === 'TMTrash' ? ['trash'] : [] }) }) } };
  const context = vm.createContext({ Application: () => app });
  vm.runInContext(script, context);
  for (const mode of ['list', 'today']) {
    const tasks = JSON.parse(context.run([mode]));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'task');
    assert.equal(tasks[0].title, 'title\n"quoted"');
    assert.equal(tasks[0].dueDate, '2026-10-23');
    assert.equal(tasks[0].url, 'things:///show?id=task');
  }
  app.running = () => false;
  assert.throws(() => context.run(['list']), /Open Things/);
});

test('main never emits partial combined results and Things-only needs no Wrike configuration', async () => {
  const output = [], errors = [];
  const options = { env: { DTODO_USAGE_LOG: '0', WRIKE_HOST: 'invalid', WRIKE_TOKEN: 'private-test-token' }, stdout: x => output.push(x), stderr: x => errors.push(x), things: async () => ({ tasks: [], coverage }) };
  assert.equal(await main(['list', '--source', 'things'], options), 0);
  assert.deepEqual(JSON.parse(output.pop()).tasks, []);
  assert.equal(await main(['list'], options), 1);
  assert.equal(output.length, 0);
  assert.equal(errors.length, 1);
});
