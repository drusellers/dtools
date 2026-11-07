import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const command = fileURLToPath(new URL('../../../bin/dnet', import.meta.url));

for (const [name, output, code, expected] of [
  ['enabled', 'Remote Login: On', 0, 'On'],
  ['enabled without addresses', 'Remote Login: On', 0, 'On'],
  ['disabled', 'Remote Login: Off', 0, 'Off'],
  ['denied despite zero exit', 'You need administrator access to run this tool... exiting!', 0, 'unknown'],
  ['failed', 'Remote Login: Off', 1, 'unknown'],
  ['unexpected response', 'unexpected', 0, 'unknown'],
]) {
  test(`status reports Remote Login: ${name}, without mutations or sudo`, () => {
    const home = mkdtempSync(join(tmpdir(), 'dnet-status-'));
    const calls = join(home, 'calls');
    function fake(name, body) {
      writeFileSync(join(home, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
    }
    try {
      fake('uname', 'echo Darwin');
      fake('ifconfig', `
echo 'ifconfig' >> "$CALLS"
[ "$EMPTY_ADDRESSES" = yes ] && exit 1
printf '%s\\n' 'lo0: flags=8049' '    inet 127.0.0.1 netmask 0xff000000' '    inet6 ::1 prefixlen 128' 'en0: flags=8863' '    inet 192.168.1.20 netmask 0xffffff00' '    inet 169.254.1.2 netmask 0xffff0000' '    inet6 fe80::1%en0 prefixlen 64' '    inet6 fd12::1234 prefixlen 64' 'utun4: flags=8051' '    inet 10.20.0.2 --> 10.20.0.2 netmask 0xffffffff'
`);
      fake('networksetup', `
case "$1" in
  -listallnetworkservices) printf 'Services\\nWi-Fi\\n' ;;
  -getinfo) echo 'IPv6: Automatic' ;;
  *) echo "forbidden networksetup $*" >> "$CALLS"; exit 1 ;;
esac`);
      fake('systemsetup', `
echo "systemsetup $*" >> "$CALLS"
[ "$#" -eq 1 ] && [ "$1" = "-getremotelogin" ] || exit 99
printf '%s\\n' "$RESPONSE"
exit "$RESULT"`);
      for (const name of ['sudo', 'launchctl', 'dscacheutil', 'killall']) {
        fake(name, `echo "forbidden ${name} $*" >> "$CALLS"; exit 99`);
      }
      const result = spawnSync('/bin/bash', [command, 'status'], {
        encoding: 'utf8',
        env: {
          ...process.env, PATH: home + ':/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: home, DNET_SERVICES: 'Wi-Fi', DNET_PLIST: join(home, 'missing.plist'),
          DNET_GUARD_INSTALL_PATH: join(home, 'missing-guard'),
          CALLS: calls, RESPONSE: output, RESULT: String(code),
          EMPTY_ADDRESSES: name === 'enabled without addresses' ? 'yes' : 'no',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /IPv6: Automatic/);
      assert.match(result.stdout, /auto-guard daemon/);
      assert.match(result.stdout, new RegExp('Remote Login \\(SSH\\) +' + expected));
      assert.equal(readFileSync(calls, 'utf8'), 'systemsetup -getremotelogin\n' + (expected === 'On' ? 'ifconfig\n' : ''));
      if (name === 'enabled') {
        assert.match(result.stdout, /SSH address +192\.168\.1\.20 \(en0\)/);
        assert.match(result.stdout, /SSH address +10\.20\.0\.2 \(utun4\)/);
        assert.match(result.stdout, /SSH address +fd12::1234 \(en0\)/);
        assert.doesNotMatch(result.stdout, /127\.0\.0\.1|169\.254|fe80|SSH address +::1/);
      } else if (name === 'enabled without addresses') {
        assert.match(result.stdout, /No non-loopback, non-link-local IP addresses found/);
      } else {
        assert.doesNotMatch(result.stdout, /SSH address|192\.168\.1\.20/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
