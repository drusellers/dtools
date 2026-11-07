import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const command = fileURLToPath(new URL('../../../bin/dnet', import.meta.url));

function run(args, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dnet-remote-login-'));
  const calls = join(home, 'calls');
  const fake = (name, body) => writeFileSync(join(home, name), '#!/bin/bash\n' + body, { mode: 0o755 });
  try {
    fake('uname', 'echo "$OS"');
    fake('id', 'echo "$USER_ID"');
    // Never run real sudo or systemsetup in tests, including on macOS.
    fake('sudo', 'printf "sudo" >> "$CALLS"; printf " <%s>" "$@" >> "$CALLS"; echo >> "$CALLS"; exit 7');
    fake('systemsetup', `
echo "systemsetup $*" >> "$CALLS"
case "$1" in
  -setremotelogin) [ "$#" -eq 2 ] || exit 99; exit "$SET_CODE" ;;
  -getremotelogin) echo "$STATE"; exit "$GET_CODE" ;;
  *) exit 99 ;;
esac`);
    const result = spawnSync('/bin/bash', [command, 'remote-login', ...args], {
      encoding: 'utf8', input: '',
      env: {
        ...process.env, PATH: home + ':/usr/bin:/bin:/usr/sbin:/sbin',
        DNET_LIBEXEC: fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''),
        HOME: home, CALLS: calls, OS: 'Darwin', USER_ID: '0',
        SET_CODE: '0', GET_CODE: '0', STATE: 'Remote Login: On', ...overrides,
      },
    });
    return { ...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const state of ['on', 'off']) {
  test(`remote-login ${state} sets only SSH and verifies state`, () => {
    const label = state === 'on' ? 'On' : 'Off';
    const result = run([state], { STATE: `Remote Login: ${label}` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Remote Login: ${label}\n`);
    assert.equal(result.calls, `systemsetup -setremotelogin ${state}\nsystemsetup -getremotelogin\n`);
    if (state === 'off') assert.match(result.stderr, /disconnect SSH sessions/);
  });
}

test('non-root delegates to sudo with the exact helper and action', () => {
  const result = run(['on'], { USER_ID: '501' });
  assert.equal(result.status, 7);
  assert.equal(result.calls, `sudo </bin/bash> <${fileURLToPath(new URL('../remote-login', import.meta.url))}> <on>\n`);
});

for (const args of [[], ['toggle'], ['on', 'extra'], ['off', '-f']]) {
  test(`rejects invalid arguments ${JSON.stringify(args)} before any action`, () => {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.calls, '');
  });
}

test('help is read-only', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.calls, '');
});

test('rejects non-macOS before any action', () => {
  const result = run(['on'], { OS: 'Linux' });
  assert.equal(result.status, 1);
  assert.equal(result.calls, '');
});

test('propagates mutation failure without claiming success', () => {
  const result = run(['on'], { SET_CODE: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.calls, 'systemsetup -setremotelogin on\n');
  assert.match(result.stderr, /Full Disk Access/);
});

for (const overrides of [
  { STATE: 'Remote Login: Off' },
  { STATE: 'You need administrator access to run this tool... exiting!' },
  { GET_CODE: '1' },
]) {
  test(`does not claim success when verification fails: ${JSON.stringify(overrides)}`, () => {
    const result = run(['on'], overrides);
    assert.equal(result.status, 1);
    assert.notEqual(result.stdout, 'Remote Login: On\n');
  });
}
