import { mkdir, lstat, chmod, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { wrikeBase } from './wrike.mjs';

const FILE = 'wrike-credentials.json';

function validate(state) {
  if (!state || state.version !== 1 || typeof state.token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(state.token) || typeof state.host !== 'string') throw new Error('Invalid Wrike credentials. Run dtodo login again.');
  wrikeBase(state.host);
  return { version: 1, token: state.token, host: state.host };
}

async function privateHome(home, create = false) {
  if (create) await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory.');
  await chmod(home, 0o700);
}

export async function loadCredentials(home) {
  let file;
  try {
    await privateHome(home);
    file = await open(join(home, FILE), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 20_000) throw new Error('Unsafe credential file.');
    await file.chmod(0o600);
    return validate(JSON.parse(await file.readFile('utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read Wrike credentials. Check DTODO_HOME or run dtodo login again.');
  } finally { await file?.close(); }
}

export async function saveCredentials(home, state) {
  const value = validate(state);
  const temp = join(home, `.wrike-${randomUUID()}.tmp`);
  try {
    await privateHome(home, true);
    await (async () => {
      const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await file.writeFile(JSON.stringify(value)); } finally { await file.close(); }
    })();
    // Atomic replacement never follows an existing destination symlink/hardlink.
    await rename(temp, join(home, FILE));
  } catch {
    throw new Error('Cannot save Wrike credentials. Check DTODO_HOME permissions.');
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

export async function logout(home) {
  try {
    await privateHome(home);
    await rm(join(home, FILE), { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot remove Wrike credentials. Check DTODO_HOME permissions.');
  }
}

export async function resolveCredentials(home, env) {
  if (env.WRIKE_TOKEN) return validate({ version: 1, token: env.WRIKE_TOKEN, host: env.WRIKE_HOST || 'www.wrike.com' });
  const saved = await loadCredentials(home);
  if (!saved) throw new Error('Run dtodo login or set WRIKE_TOKEN to your personal Wrike API token.');
  if (env.WRIKE_HOST && env.WRIKE_HOST !== saved.host) throw new Error('WRIKE_HOST differs from saved credentials. Run dtodo login for that host.');
  return saved;
}

// Read through readline's hidden output sink so pasted tokens never reach stdout,
// stderr, argv, or history. readline handles editing and restores terminal mode.
export async function promptToken({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) throw new Error('Interactive login needs a terminal; alternatively supply WRIKE_TOKEN and run dtodo login.');
  output.write('Wrike personal access token (hidden): ');
  const hidden = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const wasRaw = input.isRaw;
  const rl = createInterface({ input, output: hidden, terminal: true, historySize: 0 });
  try {
    return await new Promise((resolve, reject) => {
      rl.once('SIGINT', () => reject(new Error('Login cancelled.')));
      rl.once('close', () => reject(new Error('Login cancelled.')));
      rl.question('', token => resolve(token));
    });
  } finally {
    rl.close();
    if (typeof wasRaw === 'boolean' && input.isRaw !== wasRaw) input.setRawMode(wasRaw);
    hidden.destroy();
    output.write('\n');
  }
}
