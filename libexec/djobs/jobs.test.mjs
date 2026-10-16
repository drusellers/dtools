import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, loadConfig, parseJobs, filterJobs, formatJobs, main } from './jobs.mjs';

const fixture = `PID\tStatus\tLabel
-\t0\tcom.apple.Finder
123\t0\tcom.drusellers.worker
-\t-9\thomebrew.mxcl.example
456\t0\tcom.vendor.updater
-\t1\tcom.appleish.worker
`;
const emptyConfig = { excludePrefixes: [], excludeLabels: [] };

function temporaryDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'djobs-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(t, args = [], overrides = {}) {
  let stdout = '';
  let stderr = '';
  const calls = [];
  const code = main(args, {
    platform: 'darwin',
    home: temporaryDirectory(t),
    env: { XDG_CONFIG_HOME: temporaryDirectory(t) },
    execute: (...args) => { calls.push(args); return fixture; },
    stdout: { write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } },
    ...overrides,
  });
  return { code, stdout, stderr, calls };
}

test('default listing only calls launchctl list and hides Apple jobs', t => {
  const result = run(t, ['--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0][0], '/bin/launchctl');
  assert.deepEqual(result.calls[0][1], ['list']);
  assert.deepEqual(JSON.parse(result.stdout).map(job => job.label), [
    'com.appleish.worker', 'com.drusellers.worker', 'com.vendor.updater', 'homebrew.mxcl.example',
  ]);
});

test('parses PID, signed last exit status, and unloaded PID marker', () => {
  assert.deepEqual(parseJobs(fixture)[2], { pid: null, status: -9, label: 'homebrew.mxcl.example' });
  assert.deepEqual(parseJobs('PID Status Label\n'), []);
  for (const output of ['', 'wrong header', 'PID Status Label\ninvalid', 'PID Status Label\n0 0 bad']) {
    assert.throws(() => parseJobs(output));
  }
});

test('prefix and exact-label exclusions are additive; --all bypasses them', () => {
  const config = { excludePrefixes: ['com.vendor.'], excludeLabels: ['homebrew.mxcl.example'] };
  const jobs = parseJobs(fixture);
  assert.deepEqual(filterJobs(jobs, config, parseArgs([])).map(job => job.label), [
    'com.appleish.worker', 'com.drusellers.worker',
  ]);
  assert.equal(filterJobs(jobs, config, parseArgs(['--all'])).length, 5);
  assert.equal(filterJobs(jobs, emptyConfig, parseArgs(['--running', 'DRUSELLERS'])).length, 1);
  assert.equal(filterJobs(jobs, config, parseArgs(['--all', '--running', 'vendor'])).length, 1);
});

test('focused argument parsing rejects launchctl options and extra searches', () => {
  assert.equal(parseArgs(['list', '--json', 'worker']).search, 'worker');
  assert.equal(parseArgs(['--', '-worker']).search, '-worker');
  for (const args of [['--config'], ['--config', '--all'], ['--domain', 'system'], ['one', 'two']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('config files are optional only at the default path and validated strictly', t => {
  const path = join(temporaryDirectory(t), 'config.json');
  assert.deepEqual(loadConfig(path), emptyConfig);
  assert.throws(() => loadConfig(path, true), /Cannot read config/);
  for (const source of ['bad json', '[]', 'null', '{"unknown": []}', '{"excludePrefixes": "com."}', '{"excludeLabels": [""]}', '{"excludeLabels": [4]}', '{"excludeLabels": null}']) {
    writeFileSync(path, source);
    assert.throws(() => loadConfig(path));
  }
  writeFileSync(path, '{"excludePrefixes": ["com.vendor."]}');
  assert.deepEqual(loadConfig(path), { excludePrefixes: ['com.vendor.'], excludeLabels: [] });
});

test('XDG default, environment override, and explicit config precedence', t => {
  const dir = temporaryDirectory(t);
  const config = join(dir, 'config.json');
  writeFileSync(config, '{"excludePrefixes": ["com.vendor."]}');
  const env = { DJOBS_CONFIG: config, XDG_CONFIG_HOME: dir };
  const result = run(t, ['--json'], { env });
  assert.equal(result.code, 0);
  assert.ok(!result.stdout.includes('com.vendor.updater'));
  assert.equal(run(t, ['--config', config], { env: { DJOBS_CONFIG: join(dir, 'missing') } }).code, 0);
  const missing = run(t, [], { env: { DJOBS_CONFIG: join(dir, 'missing') } });
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.calls.length, 0);
});

test('errors are stderr-only; help works without macOS or config', t => {
  for (const overrides of [
    { platform: 'linux' },
    { execute: () => { throw new Error('failure'); } },
    { execute: () => 'unexpected output' },
  ]) {
    const result = run(t, [], overrides);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^djobs: /);
  }
  const help = run(t, ['--help'], { platform: 'linux', env: { DJOBS_CONFIG: '/missing' } });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: djobs/);
  assert.equal(help.calls.length, 0);
});

test('empty lists retain a table header or return an empty JSON array', () => {
  assert.equal(formatJobs([], false), 'PID  STATUS  LABEL  STATE  SCHEDULE\n');
  assert.equal(formatJobs([], true), '[]\n');
  assert.match(formatJobs(parseJobs(fixture), false), /-\s+-9\s+homebrew.mxcl.example/);
});

test('ignore creates config and listing uses it without duplicates', t => {
  const dir = temporaryDirectory(t);
  const env = { XDG_CONFIG_HOME: dir };
  const path = join(dir, 'dtools', 'djobs', 'config.json');
  const result = run(t, ['ignore', 'com.vendor'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /Ignoring prefix/);
  assert.deepEqual(loadConfig(path), { excludePrefixes: ['com.vendor'], excludeLabels: [] });
  assert.ok(!run(t, ['--json'], { env }).stdout.includes('com.vendor.updater'));
  const original = readFileSync(path, 'utf8');
  const duplicate = run(t, ['ignore', 'com.vendor'], { env });
  assert.equal(duplicate.code, 0);
  assert.match(duplicate.stdout, /Already ignoring/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(readdirSync(join(dir, 'dtools', 'djobs')), ['config.json']);
});

test('ignore preserves exclusions and respects config overrides', t => {
  const dir = temporaryDirectory(t);
  const path = join(dir, 'config.json');
  writeFileSync(path, '{"excludePrefixes":["com.google."],"excludeLabels":["some.job"]}');
  const result = run(t, ['ignore', 'com.microsoft', '--config', path], {
    env: { DJOBS_CONFIG: join(dir, 'unused.json') },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.length, 0);
  assert.deepEqual(loadConfig(path), {
    excludePrefixes: ['com.google.', 'com.microsoft'], excludeLabels: ['some.job'],
  });
  const other = join(dir, 'nested', 'new.json');
  assert.equal(run(t, ['ignore', 'com.vendor.'], { env: { DJOBS_CONFIG: other } }).code, 0);
  assert.deepEqual(loadConfig(other).excludePrefixes, ['com.vendor.']);
  const explicit = join(dir, 'explicit.json');
  assert.equal(run(t, ['ignore', 'com.example.', '--config', explicit]).code, 0);
  assert.deepEqual(loadConfig(explicit).excludePrefixes, ['com.example.']);
});

test('ignore rejects invalid arguments and does not overwrite invalid config', t => {
  for (const args of [
    ['ignore'], ['ignore', ''], ['ignore', ' '], ['ignore', 'com. vendor'],
    ['ignore', 'one', 'two'], ['ignore', 'com.vendor', '--all'],
    ['ignore', 'com.vendor', '--running'], ['ignore', 'com.vendor', '--json'],
  ]) {
    const result = run(t, args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.calls.length, 0);
  }
  const dir = temporaryDirectory(t);
  const path = join(dir, 'bad.json');
  writeFileSync(path, 'invalid');
  const result = run(t, ['ignore', 'com.vendor', '--config', path]);
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.equal(readFileSync(path, 'utf8'), 'invalid');
  const blocked = join(dir, 'file');
  writeFileSync(blocked, 'not a directory');
  assert.equal(run(t, ['ignore', 'com.vendor', '--config', join(blocked, 'config.json')]).code, 1);
  assert.equal(readFileSync(blocked, 'utf8'), 'not a directory');
  assert.equal(run(t, ['ignore', '--help']).code, 0);
  assert.equal(parseArgs(['list', 'ignore']).search, 'ignore');
});

test('shell launcher forwards focused arguments without contacting launchctl', () => {
  const result = spawnSync('bash', [new URL('../../bin/djobs', import.meta.url).pathname, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: djobs/);
  assert.equal(result.stderr, '');
});
