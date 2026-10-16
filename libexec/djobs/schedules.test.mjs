import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseArgs } from './jobs.mjs';
import { locations, mergeSchedules, parseInterval, readSchedules, renderPlist } from './schedules.mjs';

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'djobs-schedule-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, 'project & <test>');
  mkdirSync(cwd);
  const script = join(cwd, "run 'thing'.sh");
  writeFileSync(script, '#!/bin/bash\necho example\n', { mode: 0o600 });
  const state = { loaded: new Set(), calls: [], fail: null };
  function execute(command, args) {
    state.calls.push([command, args]);
    assert.equal(command, '/bin/launchctl');
    if (state.fail === args[0]) throw new Error('simulated launchctl failure');
    if (args[0] === 'list') return 'PID\tStatus\tLabel\n' + (state.hideFromList ? [] : [...state.loaded]).map(label => `-\t0\t${label}\n`).join('');
    if (args[0] === 'bootstrap') {
      assert.equal(args[1], 'gui/501');
      const plist = readFileSync(args[2], 'utf8');
      const label = /<key>Label<\/key><string>([^<]+)<\/string>/.exec(plist)[1];
      state.loaded.add(label);
      return '';
    }
    if (args[0] === 'print') {
      if (!state.loaded.has(args[1].slice('gui/501/'.length))) {
        throw Object.assign(new Error('Service not found'), { status: 113, stderr: 'Could not find service' });
      }
      return `service = {\n\tpath = ${state.registeredPath || locations(home, args[1].slice('gui/501/com.drusellers.'.length)).plist}\n}`;
    }
    if (args[0] === 'bootout') {
      assert.match(args[1], /^gui\/501\/com\.drusellers\./);
      state.loaded.delete(args[1].slice('gui/501/'.length));
      return '';
    }
    throw new Error(`Unexpected command: ${args}`);
  }
  function run(args, overrides = {}) {
    let stdout = '';
    let stderr = '';
    const code = main(args, {
      platform: 'darwin', home, cwd, uid: 501, env: {}, execute,
      stdout: { write: value => { stdout += value; } },
      stderr: { write: value => { stderr += value; } },
      ...overrides,
    });
    return { code, stdout, stderr };
  }
  return { home, cwd, script, state, run, paths: locations(home, 'thing') };
}

const schedule = ["schedule", "./run 'thing'.sh", '2h', '--name', 'thing'];

test('intervals support positive integer seconds, minutes, hours, days with safe bounds', () => {
  for (const [value, seconds] of [['30s', 30], ['15m', 900], ['2h', 7200], ['1d', 86400], ['2147483647s', 2147483647]]) {
    assert.equal(parseInterval(value), seconds);
  }
  for (const value of ['', '0h', '-1s', '1.5h', '2H', '2', '2w', '1h30m', '2147483648s', '999999999999999999d']) {
    assert.throws(() => parseInterval(value));
  }
});

test('schedule argument validation rejects unsupported options and unsafe names', () => {
  assert.equal(parseArgs(schedule).interval, '2h');
  assert.equal(parseArgs(['unschedule', 'thing']).name, 'thing');
  for (const args of [
    ['schedule'], ['schedule', 'run.sh', '2h'], ['schedule', 'run.sh', '2h', '--name', '../bad'],
    ['schedule', 'run.sh', '2h', '--name', 'a.b'], ['schedule', 'run.sh', '2h', '--name', 'thing', '--json'],
    ['schedule', 'run.sh', '2h', '--name', 'thing', '--cwd'],
    ['schedule', 'run.sh', '2h', '--name', 'thing', '--name', 'other'],
    ['unschedule'], ['unschedule', 'one', 'two'], ['unschedule', 'thing', '--cwd', '.'],
  ]) assert.throws(() => parseArgs(args));
});

test('schedule writes a valid escaped LaunchAgent and boots into the GUI domain, without running immediately', t => {
  const { home, cwd, script, paths, state, run } = setup(t);
  const result = run(schedule);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Scheduled com.drusellers.thing every 2h/);
  assert.deepEqual(state.calls.map(call => call[1][0]), ['list', 'print', 'bootstrap']);
  const jobs = readSchedules(home);
  assert.deepEqual(jobs, [{ version: 1, name: 'thing', script, cwd, interval: '2h' }]);
  const plist = readFileSync(paths.plist, 'utf8');
  assert.equal(plist, renderPlist(jobs[0], home));
  assert.match(plist, /<key>StartInterval<\/key><integer>7200<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<string>\/bin\/bash<\/string><string>--<\/string>/);
  assert.match(plist, /project &amp; &lt;test&gt;/);
  assert.match(plist, /&apos;thing&apos;/);
  assert.ok(existsSync(paths.logs));
  assert.ok(!existsSync(join(paths.registry, '.lock')));
  if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', paths.plist]);
});

test('list shows interval and loaded state in JSON/table, including unloaded managed schedules', t => {
  const { state, run } = setup(t);
  assert.equal(run(schedule).code, 0);
  let result = run(['list', '--json']);
  assert.deepEqual(JSON.parse(result.stdout), [{ pid: null, status: 0, label: 'com.drusellers.thing', loaded: true, schedule: '2h' }]);
  assert.match(run(['list']).stdout, /loaded\s+every 2h/);
  state.loaded.clear();
  result = run(['list', '--json']);
  assert.deepEqual(JSON.parse(result.stdout), [{ pid: null, status: null, label: 'com.drusellers.thing', loaded: false, schedule: '2h' }]);
  assert.match(run(['list']).stdout, /unloaded\s+every 2h/);
  assert.deepEqual(JSON.parse(run(['list', '--running', '--json']).stdout), []);
  assert.deepEqual(JSON.parse(run(['list', '--json', 'other']).stdout), []);
  assert.equal(run(['ignore', 'com.drusellers']).code, 0);
  assert.deepEqual(JSON.parse(run(['--json']).stdout), []);
  assert.equal(JSON.parse(run(['--all', '--json']).stdout).length, 1);
});

test('merge preserves PID and exit status and marks third-party schedules unknown', () => {
  assert.deepEqual(mergeSchedules([{ pid: 45, status: -9, label: 'com.drusellers.thing' }, { pid: null, status: 0, label: 'vendor' }], [{ name: 'thing', interval: '2h' }]), [
    { pid: 45, status: -9, label: 'com.drusellers.thing', loaded: true, schedule: '2h' },
    { pid: null, status: 0, label: 'vendor', loaded: true, schedule: null },
  ]);
});

test('--cwd is resolved at schedule time; missing scripts/directories and root fail before launchctl', t => {
  const { cwd, paths, state, run, home } = setup(t);
  assert.equal(run([...schedule, '--cwd', '..']).code, 0);
  assert.equal(readSchedules(home)[0].cwd, home);
  assert.equal(run(['unschedule', 'thing']).code, 0);
  state.calls.length = 0;
  for (const [args, overrides] of [
    [['schedule', 'missing.sh', '2h', '--name', 'thing'], {}],
    [['schedule', '.', '2h', '--name', 'thing'], {}],
    [[...schedule, '--cwd', 'missing'], {}],
    [[...schedule, '--cwd', "run 'thing'.sh"], {}],
    [schedule, { uid: 0 }],
  ]) {
    const result = run(args, overrides);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
  }
  assert.equal(state.calls.length, 0);
  assert.ok(!existsSync(paths.plist));
  assert.ok(existsSync(cwd));
});

test('existing live jobs or plists are not overwritten and duplicate schedules are refused', t => {
  const { paths, state, run } = setup(t);
  mkdirSync(join(paths.plist, '..'), { recursive: true });
  writeFileSync(paths.plist, 'third-party plist');
  assert.equal(run(schedule).code, 1);
  assert.equal(readFileSync(paths.plist, 'utf8'), 'third-party plist');
  rmSync(paths.plist);
  state.loaded.add('com.drusellers.thing');
  assert.equal(run(schedule).code, 1);
  state.loaded.clear();
  assert.equal(run(schedule).code, 0);
  const original = readFileSync(paths.plist, 'utf8');
  assert.equal(run(schedule).code, 1);
  assert.equal(readFileSync(paths.plist, 'utf8'), original);
  assert.equal(state.calls.filter(call => call[1][0] === 'bootstrap').length, 1);
});

test('bootstrap failure keeps installed metadata and plist for inspection/removal', t => {
  const { state, paths, run } = setup(t);
  state.fail = 'bootstrap';
  const result = run(schedule);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Files remain installed/);
  assert.ok(existsSync(paths.plist));
  assert.ok(existsSync(paths.metadata));
  assert.ok(!existsSync(join(paths.registry, '.lock')));
  assert.equal(JSON.parse(run(['--json']).stdout)[0].loaded, false);
  state.fail = null;
  assert.equal(run(['unschedule', 'thing']).code, 0);
  assert.ok(!existsSync(paths.plist));
});

test('unschedule unloads only owned jobs, removes schedule files, and keeps logs', t => {
  const { run, paths, state } = setup(t);
  assert.equal(run(schedule).code, 0);
  writeFileSync(paths.stdout, 'logs');
  const result = run(['unschedule', 'thing']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.calls.at(-1)[1], ['bootout', 'gui/501/com.drusellers.thing']);
  assert.ok(!existsSync(paths.plist));
  assert.ok(!existsSync(paths.metadata));
  assert.equal(readFileSync(paths.stdout, 'utf8'), 'logs');
  const calls = state.calls.length;
  assert.equal(run(['unschedule', 'vendor']).code, 1);
  assert.equal(state.calls.length, calls);
});

test('unload failure or externally changed/missing plist does not destroy ownership records', t => {
  const { run, paths, state } = setup(t);
  assert.equal(run(schedule).code, 0);
  state.fail = 'bootout';
  assert.equal(run(['unschedule', 'thing']).code, 1);
  assert.ok(existsSync(paths.plist));
  assert.ok(existsSync(paths.metadata));
  state.fail = 'print';
  assert.equal(run(['unschedule', 'thing']).code, 1);
  assert.ok(existsSync(paths.metadata));
  state.fail = null;
  state.registeredPath = '/some/third-party.plist';
  assert.equal(run(['unschedule', 'thing']).code, 1);
  assert.ok(existsSync(paths.metadata));
  state.registeredPath = null;
  const original = readFileSync(paths.plist, 'utf8');
  writeFileSync(paths.plist, 'changed by someone');
  assert.equal(run(['unschedule', 'thing']).code, 1);
  assert.equal(readFileSync(paths.plist, 'utf8'), 'changed by someone');
  rmSync(paths.plist);
  assert.equal(run(['unschedule', 'thing']).code, 1);
  assert.ok(existsSync(paths.metadata));
  writeFileSync(paths.plist, original);
  assert.equal(run(['unschedule', 'thing']).code, 0);
});

test('unloaded schedules can be removed, even if their plist was already deleted', t => {
  const { run, paths, state } = setup(t);
  assert.equal(run(schedule).code, 0);
  state.loaded.clear();
  rmSync(paths.plist);
  assert.equal(run(['unschedule', 'thing']).code, 0);
  assert.ok(!existsSync(paths.metadata));
  assert.equal(state.calls.filter(call => call[1][0] === 'bootout').length, 0);
});

test('GUI domain collisions and removals are checked even outside the caller listing context', t => {
  const { run, state, paths } = setup(t);
  state.hideFromList = true;
  state.loaded.add('com.drusellers.thing');
  assert.equal(run(schedule).code, 1);
  assert.ok(!existsSync(paths.plist));
  state.loaded.clear();
  assert.equal(run(schedule).code, 0);
  assert.equal(run(['unschedule', 'thing']).code, 0);
  assert.equal(state.loaded.size, 0);
});

test('failed inspection does not install or delete files', t => {
  const { run, state, paths } = setup(t);
  state.fail = 'print';
  assert.equal(run(schedule).code, 1);
  assert.ok(!existsSync(paths.plist));
  state.fail = null;
  assert.equal(run(schedule).code, 0);
  state.hideFromList = true;
  state.fail = 'print';
  assert.equal(run(['unschedule', 'thing']).code, 1);
  assert.ok(existsSync(paths.plist));
  assert.ok(existsSync(paths.metadata));
});

test('invalid metadata and a concurrent-edit lock fail clearly', t => {
  const { run, paths } = setup(t);
  mkdirSync(paths.registry, { recursive: true });
  mkdirSync(join(paths.registry, '.lock'));
  assert.match(run(schedule).stderr, /Another schedule edit/);
  assert.ok(existsSync(join(paths.registry, '.lock')));
  rmSync(join(paths.registry, '.lock'), { recursive: true });
  writeFileSync(paths.metadata, '{}');
  assert.match(run(['list']).stderr, /Invalid schedule metadata/);
  assert.equal(run(['unschedule', 'thing']).code, 1);
  assert.equal(readFileSync(paths.metadata, 'utf8'), '{}');
  assert.ok(!existsSync(join(paths.registry, '.lock')));
});

test('schedule help is portable and does not contact launchctl', t => {
  const { run, state } = setup(t);
  for (const command of ['schedule', 'unschedule']) {
    const result = run([command, '--help'], { platform: 'linux' });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /djobs schedule SCRIPT INTERVAL/);
  }
  assert.equal(state.calls.length, 0);
});
