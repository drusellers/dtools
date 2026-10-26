import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { loadCredentials, saveCredentials, resolveCredentials, logout, promptToken } from './auth.mjs';
import { main, parseArgs } from './todo.mjs';

const credentials = { version: 1, token: 'secret-token', host: 'app-eu.wrike.com' };
async function homeFor(t) {
  const home = await mkdtemp(join(tmpdir(), 'dtodo-auth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
const response = data => ({ ok: true, json: async () => ({ data }) });

test('login/logout parsing rejects token arguments and non-allowlisted hosts', () => {
  assert.deepEqual(parseArgs(['login']), { command: 'login', options: {} });
  assert.equal(parseArgs(['login', '--host', credentials.host]).options.host, credentials.host);
  assert.equal(parseArgs(['logout']).command, 'logout');
  for (const args of [['login', 'secret-token'], ['login', '--token', 'secret-token'], ['logout', '--host', credentials.host], ['login', '--host', 'evil.example']]) assert.throws(() => parseArgs(args));
});

test('credentials save atomically with private modes, environment overrides, host binding, and logout', async t => {
  const home = await homeFor(t);
  assert.equal(await loadCredentials(home), null);
  await saveCredentials(home, credentials);
  assert.deepEqual(await loadCredentials(home), credentials);
  assert.deepEqual(await readdir(home), ['wrike-credentials.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, 'wrike-credentials.json'))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await resolveCredentials(home, {}), credentials);
  assert.deepEqual(await resolveCredentials(home, { WRIKE_TOKEN: 'replacement' }), { version: 1, token: 'replacement', host: 'www.wrike.com' });
  await assert.rejects(resolveCredentials(home, { WRIKE_HOST: 'www.wrike.com' }), /differs/);
  for (const token of ['', 'secret\nheader', 'secret token', 'x'.repeat(17000)]) await assert.rejects(saveCredentials(home, { ...credentials, token }));
  assert.deepEqual(await loadCredentials(home), credentials);
  await logout(home);
  await logout(home);
  assert.equal(await loadCredentials(home), null);
  await assert.rejects(resolveCredentials(home, {}), /dtodo login/);
});

test('credential reads reject malformed JSON, symlinks, hardlinks, and unsafe homes without leaking contents', async t => {
  const home = await homeFor(t);
  const path = join(home, 'wrike-credentials.json');
  await writeFile(path, 'secret-malformed-json');
  await assert.rejects(loadCredentials(home), error => !error.message.includes('secret'));
  if (process.platform === 'win32') return;
  const outside = await homeFor(t);
  const target = join(outside, 'target');
  await writeFile(target, JSON.stringify(credentials));
  await rm(path);
  await symlink(target, path);
  await assert.rejects(loadCredentials(home));
  // Saving replaces the symlink, never the external target.
  await saveCredentials(home, { ...credentials, token: 'replacement' });
  assert.equal(JSON.parse(await readFile(target, 'utf8')).token, 'secret-token');
  await rm(path);
  await link(target, path);
  await assert.rejects(loadCredentials(home));
  await rm(path);
  const alias = join(outside, 'alias');
  await symlink(home, alias);
  await assert.rejects(loadCredentials(alias));
  await assert.rejects(saveCredentials(alias, credentials));
  await assert.rejects(logout(alias));
});

test('login verifies me via GET before saving, cached reads use the saved host, logout keeps private history', async t => {
  const home = await homeFor(t);
  const output = [], errors = [], requests = [];
  const options = {
    env: { DTODO_HOME: home }, stdout: x => output.push(x), stderr: x => errors.push(x), tokenPrompt: async () => credentials.token,
    fetchImpl: async (url, request) => {
      requests.push({ url, request });
      assert.equal(url.origin, 'https://app-eu.wrike.com');
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.Authorization, 'Bearer secret-token');
      assert.equal(request.redirect, 'error');
      return response(url.pathname.endsWith('/contacts') ? [{ id: 'secret-user', me: true }] : []);
    },
  };
  assert.equal(await main(['login', '--host', credentials.host], options), 0);
  assert.deepEqual(JSON.parse(output.pop()), { status: 'signed_in' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get('me'), 'true');
  assert.deepEqual(await loadCredentials(home), credentials);
  assert.equal(await main(['list', '--source', 'wrike'], options), 0);
  assert.deepEqual(JSON.parse(output.pop()).tasks, []);
  assert.equal(await main(['logout'], options), 0);
  assert.deepEqual(JSON.parse(output.pop()), { status: 'signed_out', environmentTokenActive: false });
  assert.equal(await loadCredentials(home), null);
  assert.equal(errors.length, 0);
  const logs = await readFile(join(home, 'usage', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.doesNotMatch(logs, /secret|app-eu/);
  const events = logs.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.command), ['login', 'list', 'logout']);
  assert.deepEqual(events[0].options, { host: true });
  assert.equal(events[0].stats, undefined);
  assert.equal(events[2].stats, undefined);
});

test('failed/cancelled/empty login preserves old credentials, hides errors, and never returns token or identity', async t => {
  const home = await homeFor(t);
  await saveCredentials(home, credentials);
  const output = [], errors = [];
  const base = { env: { DTODO_HOME: home, DTODO_USAGE_LOG: '0' }, stdout: x => output.push(x), stderr: x => errors.push(x), tokenPrompt: async () => 'secret-new-token' };
  assert.equal(await main(['login'], { ...base, fetchImpl: async () => ({ ok: false, status: 401 }) }), 1);
  assert.equal(await main(['login'], { ...base, tokenPrompt: async () => '' }), 1);
  assert.equal(await main(['login'], { ...base, tokenPrompt: async () => 'secret\nheader', fetchImpl: () => assert.fail('invalid token must not be sent') }), 1);
  assert.deepEqual(await loadCredentials(home), credentials);
  assert.equal(output.length, 0);
  assert.doesNotMatch(errors.join('\n'), /secret/);
});

test('environment login needs no prompt and logout reports the still-active environment override', async t => {
  const home = await homeFor(t);
  const output = [];
  const options = { env: { DTODO_HOME: home, WRIKE_TOKEN: 'secret-env', DTODO_USAGE_LOG: '0' }, stdout: x => output.push(x), tokenPrompt: () => assert.fail('no prompt'), fetchImpl: async () => response([{ id: 'me', me: true }]) };
  assert.equal(await main(['login'], options), 0);
  assert.equal((await loadCredentials(home)).token, 'secret-env');
  assert.equal(await main(['logout'], options), 0);
  assert.equal(JSON.parse(output.at(-1)).environmentTokenActive, true);
});

test('opt-in diagnostics print only host and last five token characters, never to JSON or usage logs', async t => {
  const home = await homeFor(t);
  const token = 'secret-prefix-ABCDE';
  const output = [], errors = [];
  const options = {
    env: { DTODO_HOME: home, WRIKE_TOKEN: token, WRIKE_HOST: 'app-eu.wrike.com', DTODO_DEBUG: '1' },
    stdout: value => output.push(value), stderr: value => errors.push(value),
    fetchImpl: async (_url, request) => {
      assert.equal(request.redirect, 'error');
      return { ok: false, status: 300 };
    },
  };
  for (const args of [['login'], ['list', '--source', 'wrike']]) {
    assert.equal(await main(args, options), 1);
  }
  assert.equal(output.length, 0);
  assert.equal(errors[0], 'dtodo: Wrike host=app-eu.wrike.com token=…ABCDE');
  assert.doesNotMatch(errors.join('\n'), /secret-prefix/);
  const logs = await readFile(join(home, 'usage', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  assert.doesNotMatch(logs, /ABCDE|secret-prefix|app-eu/);
  assert.ok(logs.includes('http_300'));
  errors.length = 0;
  await main(['login'], { ...options, env: { ...options.env, DTODO_DEBUG: '0' } });
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /ABCDE|app-eu/);
  errors.length = 0;
  await main(['login'], { ...options, env: { ...options.env, WRIKE_TOKEN: 'tiny' } });
  assert.equal(errors[0], 'dtodo: Wrike host=app-eu.wrike.com token=[redacted]');
});

test('hidden prompt does not echo input and restores terminal mode on submit, interrupt, or EOF', async () => {
  for (const ending of ['\r', '\u0003', 'end']) {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    let output = '';
    const pending = promptToken({ input, output: { write: value => { output += value; } } });
    // Attach rejection before simulating cancellation to avoid unhandled rejections.
    const result = pending.then(value => ({ value }), error => ({ error }));
    input.write('secret-pasted-token');
    if (ending === 'end') input.end(); else input.write(ending);
    const settled = await result;
    if (ending === '\r') assert.equal(settled.value, 'secret-pasted-token');
    else assert.match(settled.error.message, /cancelled/);
    assert.equal(input.isRaw, false);
    assert.doesNotMatch(output, /secret/);
    input.destroy();
  }
  await assert.rejects(promptToken({ input: { isTTY: false } }), /terminal/);
});

test('CLI rejects noninteractive login cleanly and logout works without credentials or network', async t => {
  const home = await homeFor(t);
  const env = { ...process.env, DTODO_HOME: home, DTODO_USAGE_LOG: '0', WRIKE_TOKEN: '', WRIKE_HOST: '' };
  const failed = spawnSync(process.execPath, ['libexec/dtodo/todo.mjs', 'login'], { env, input: '', encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /terminal/);
  const signedOut = spawnSync(process.execPath, ['libexec/dtodo/todo.mjs', 'logout'], { env, encoding: 'utf8' });
  assert.equal(signedOut.status, 0);
  assert.equal(JSON.parse(signedOut.stdout).status, 'signed_out');
  assert.deepEqual(await readdir(home), []);
});
