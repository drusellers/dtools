import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MailClient, parseArgs, messageListUrl, validateIdentity } from './mail.mjs';

const tenant = '11111111-1111-1111-1111-111111111111';
const client = '22222222-2222-2222-2222-222222222222';
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dmail-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return new MailClient({ home, ...options });
}

test('parses commands and rejects ambiguous/invalid arguments', () => {
  assert.deepEqual(parseArgs(['list', '--unread', '--limit', '5']), { command: 'list', options: { unread: true, limit: '5' }, id: undefined });
  assert.equal(parseArgs([]).command, 'help');
  assert.equal(parseArgs(['read', 'abc', '--html']).id, 'abc');
  for (const args of [['send'], ['read'], ['list', '--limit', '0'], ['list', '--limit', '101'], ['list', '--limit', '1.5'], ['list', '--folder'], ['list', '--unread', '--unread'], ['list', '--next', 'url', '--limit', '1'], ['logout', 'extra']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('tenant and client validation', () => {
  validateIdentity(tenant, client);
  validateIdentity('example.onmicrosoft.com', client);
  for (const value of ['common', 'organizations', 'consumers', 'bad/path', '', undefined]) {
    assert.throws(() => validateIdentity(value, client));
  }
  assert.throws(() => validateIdentity(tenant, 'not-a-uuid'));
});

test('list encodes folder IDs, selects summaries, and orders unread filter correctly', () => {
  const url = messageListUrl({ folder: 'A/B+==', unread: true, limit: '7' });
  assert.equal(url.pathname, '/v1.0/me/mailFolders/A%2FB%2B%3D%3D/messages');
  assert.equal(url.searchParams.get('$top'), '7');
  assert.equal(url.searchParams.get('$orderby'), 'receivedDateTime desc');
  assert.match(url.searchParams.get('$filter'), /^receivedDateTime ge .* and isRead eq false$/);
  assert.ok(!url.searchParams.get('$select').split(',').includes('body'));
});

test('pagination links cannot leak bearer tokens outside Graph or access other endpoints', () => {
  const link = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc';
  assert.equal(messageListUrl({ next: link }).href, link);
  for (const next of ['https://evil.example/v1.0/me/messages', 'http://graph.microsoft.com/v1.0/me/messages', 'https://graph.microsoft.com/v1.0/users', 'https://user@graph.microsoft.com/v1.0/me/messages', `${link}#fragment`]) {
    assert.throws(() => messageListUrl({ next }));
  }
});

test('device-code login handles pending, slow_down, and privately caches tokens', async t => {
  let now = 0;
  const sleeps = [];
  const calls = [];
  const replies = [
    response({ device_code: 'device-secret', message: 'Visit Microsoft and enter CODE', expires_in: 120, interval: 5 }),
    response({ error: 'authorization_pending' }, 400),
    response({ error: 'slow_down' }, 400),
    response({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }),
  ];
  const diagnostics = [];
  const mail = await fixture(t, {
    now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; },
    diagnostic: message => diagnostics.push(message),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return replies.shift(); },
  });
  assert.deepEqual(await mail.login(tenant, client), { status: 'signed_in' });
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  assert.equal(diagnostics.length, 1);
  assert.equal(calls[0].options.body.get('scope'), 'https://graph.microsoft.com/Mail.Read offline_access');
  assert.equal(calls[1].options.body.get('device_code'), 'device-secret');
  const state = await mail.load();
  assert.equal(state.refreshToken, 'refresh-secret');
  assert.equal(state.expiresAt, now + 3600_000);
  if (process.platform !== 'win32') {
    assert.equal((await stat(mail.home)).mode & 0o777, 0o700);
    assert.equal((await stat(mail.cachePath)).mode & 0o777, 0o600);
  }
});

test('device-code denial and expiry fail without caching', async t => {
  for (const error of ['access_denied', 'expired_token']) {
    let now = 0;
    const mail = await fixture(t, {
      now: () => now, sleep: async ms => { now += ms; }, diagnostic: () => {},
      fetchImpl: async url => String(url).endsWith('/devicecode')
        ? response({ device_code: 'code', message: 'sign in', expires_in: 60 })
        : response({ error }, 400),
    });
    await assert.rejects(mail.login(tenant, client), new RegExp(error));
    assert.equal(await mail.load(), null);
  }
  let now = 0;
  const mail = await fixture(t, {
    now: () => now, sleep: async ms => { now += ms; }, diagnostic: () => {},
    fetchImpl: async () => response({ device_code: 'code', message: 'sign in', expires_in: 1 }),
  });
  await assert.rejects(mail.login(tenant, client), /expired/);
});

test('refreshes expired tokens and keeps refresh token when not rotated', async t => {
  const mail = await fixture(t, { now: () => 1000, fetchImpl: async (url, options) => {
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.body.get('refresh_token'), 'old-refresh');
    return response({ access_token: 'new-access', expires_in: 3600 });
  } });
  await mail.save({ tenant, client, accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 0 });
  assert.equal(await mail.accessToken(tenant, client), 'new-access');
  assert.equal((await mail.load()).refreshToken, 'old-refresh');
  await assert.rejects(mail.accessToken('other', client), /Not signed in/);
});

test('Graph uses GET, does not follow redirects, and refreshes once after 401', async t => {
  const calls = [];
  const mail = await fixture(t, { now: () => 0, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('login.microsoftonline.com')) return response({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
    return calls.length === 1 ? response({}, 401) : response({ value: [{ id: 'message' }] });
  } });
  await mail.save({ tenant, client, accessToken: 'old', refreshToken: 'refresh', expiresAt: 3600_000 });
  assert.deepEqual(await mail.graph(messageListUrl({}), tenant, client), { value: [{ id: 'message' }] });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer old');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer new');
  assert.equal(calls[2].options.headers.Prefer, 'outlook.body-content-type="text"');
  assert.equal(calls[2].options.method, undefined);
  assert.equal(calls[2].options.redirect, 'error');
  assert.equal((await mail.load()).refreshToken, 'rotated');
});

test('permission, network, refresh, and cache errors are actionable and omit tokens', async t => {
  const mail = await fixture(t, { now: () => 0, fetchImpl: async () => response({ error: { code: 'ErrorAccessDenied', message: 'secret' } }, 403) });
  await mail.save({ tenant, client, accessToken: 'secret-token', expiresAt: 3600_000 });
  await assert.rejects(mail.graph(messageListUrl({}), tenant, client), /403, ErrorAccessDenied.*Mail.Read/);
  mail.fetch = async () => { throw new Error('secret-token'); };
  await assert.rejects(mail.graph(messageListUrl({}), tenant, client), /Check your network/);
  mail.fetch = async () => response({ error: 'invalid_grant' }, 400);
  await mail.save({ tenant, client, refreshToken: 'secret', expiresAt: 0 });
  await assert.rejects(mail.accessToken(tenant, client), /invalid_grant.*login/);
  await writeFile(mail.cachePath, 'broken');
  await assert.rejects(mail.load(), /Cannot read token cache/);
});

test('CLI help, invalid arguments, and logout work without network or credentials', async t => {
  const mail = await fixture(t);
  const run = args => spawnSync(process.execPath, ['libexec/dmail/mail.mjs', ...args], {
    encoding: 'utf8', env: { ...process.env, DMAIL_HOME: mail.home, DMAIL_TENANT_ID: '', DMAIL_CLIENT_ID: '' },
  });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /dmail login/);
  const bad = run(['send']);
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  await mail.save({ tenant, client, accessToken: 'secret' });
  const logout = run(['logout']);
  assert.equal(logout.status, 0);
  assert.equal(JSON.parse(logout.stdout).status, 'signed_out');
  await assert.rejects(readFile(mail.cachePath), { code: 'ENOENT' });
});
