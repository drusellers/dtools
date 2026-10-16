import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function parseInterval(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  const seconds = match && Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2147483647) {
    throw new Error('Interval must be a positive whole number with s, m, h, or d (at most 2147483647 seconds)');
  }
  return seconds;
}

export function validateName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) {
    throw new Error('Name must be 1–80 letters, digits, underscores, or hyphens, starting with a letter or digit');
  }
  return name;
}

export function parseScheduleArgs(args) {
  const command = args[0];
  const options = { command };
  const positional = [];
  let literal = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && ['--help', '-h'].includes(arg)) { options.help = true; continue; }
    if (!literal && ['--name', '--cwd'].includes(arg) && command === 'schedule') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2);
      if (options[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
      options[key] = args[++i];
    } else if (!literal && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else positional.push(arg);
  }
  if (options.help) return options;
  if (command === 'schedule') {
    if (positional.length !== 2 || !positional[0]) throw new Error('Usage: djobs schedule SCRIPT INTERVAL --name NAME [--cwd PATH]');
    options.script = positional[0];
    options.interval = positional[1];
    parseInterval(options.interval);
    validateName(options.name);
  } else {
    if (positional.length !== 1) throw new Error('Usage: djobs unschedule NAME');
    options.name = validateName(positional[0]);
  }
  return options;
}

export function locations(home, name) {
  const registry = join(home, 'Library', 'Application Support', 'dtools', 'djobs');
  const logs = join(home, 'Library', 'Logs', 'dtools', 'djobs');
  return {
    registry, logs,
    metadata: join(registry, `${name}.json`),
    plist: join(home, 'Library', 'LaunchAgents', `com.drusellers.${name}.plist`),
    stdout: join(logs, `${name}.stdout.log`),
    stderr: join(logs, `${name}.stderr.log`),
  };
}

function xml(value) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Paths cannot contain XML control characters');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function renderPlist(job, home) {
  const paths = locations(home, job.name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.drusellers.${xml(job.name)}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>--</string><string>${xml(job.script)}</string></array>
  <key>WorkingDirectory</key><string>${xml(job.cwd)}</string>
  <key>StartInterval</key><integer>${parseInterval(job.interval)}</integer>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xml(paths.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.stderr)}</string>
</dict>
</plist>
`;
}

export function readSchedules(home) {
  const directory = locations(home, '').registry;
  let files;
  try { files = readdirSync(directory); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files.filter(file => file.endsWith('.json')).sort().map(file => {
    const path = join(directory, file);
    let job;
    try {
      job = JSON.parse(readFileSync(path, 'utf8'));
      if (!job || job.version !== 1 || validateName(job.name) + '.json' !== file ||
          typeof job.script !== 'string' || !isAbsolute(job.script) ||
          typeof job.cwd !== 'string' || !isAbsolute(job.cwd)) throw new Error('Invalid metadata');
      parseInterval(job.interval);
      renderPlist(job, home);
    } catch (error) {
      throw new Error(`Invalid schedule metadata ${path}: ${error.message}`);
    }
    return job;
  });
}

export function mergeSchedules(jobs, schedules) {
  const result = new Map(jobs.map(job => [job.label, { ...job, loaded: true, schedule: null }]));
  for (const schedule of schedules) {
    const label = `com.drusellers.${schedule.name}`;
    result.set(label, {
      ...(result.get(label) || { pid: null, status: null, label, loaded: false }),
      schedule: schedule.interval,
    });
  }
  return [...result.values()];
}

function launchctl(execute, args) {
  return execute('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function inspectJob(execute, uid, label) {
  try { return launchctl(execute, ['print', `gui/${uid}/${label}`]); } catch (error) {
    if (error.status === 113 && String(error.stderr).includes('Could not find service')) return null;
    throw new Error(`Could not inspect ${label} in your GUI launchd domain; no schedule files were changed`);
  }
}

function withLock(home, action) {
  const directory = locations(home, '').registry;
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, '.lock');
  try { mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another schedule edit is active; if interrupted, remove stale lock ${lock}`);
    throw error;
  }
  try { return action(); } finally { rmSync(lock, { recursive: true }); }
}

function requireUser(uid) {
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error('Schedule jobs as your normal user, not with sudo');
}

export function scheduleJob(options, { home, cwd, uid, execute, listJobs }) {
  requireUser(uid);
  const script = resolve(cwd, options.script);
  const workingDirectory = resolve(cwd, options.cwd || '.');
  if (!statSync(script).isFile()) throw new Error('Script must be a regular Bash-compatible file');
  accessSync(script, constants.R_OK);
  if (!statSync(workingDirectory).isDirectory()) throw new Error('--cwd must be a directory');
  const job = { version: 1, name: validateName(options.name), script, cwd: workingDirectory, interval: options.interval };
  const plist = renderPlist(job, home);
  const paths = locations(home, job.name);
  return withLock(home, () => {
    const label = `com.drusellers.${job.name}`;
    if (existsSync(paths.metadata) || existsSync(paths.plist) ||
        listJobs().some(job => job.label === label) || inspectJob(execute, uid, label) !== null) {
      throw new Error(`Job ${label} already exists; use a different name or unschedule the managed job first`);
    }
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(paths.logs, { recursive: true });
    let wrotePlist = false;
    try {
      writeFileSync(paths.plist, plist, { flag: 'wx', mode: 0o600 });
      wrotePlist = true;
      writeFileSync(paths.metadata, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (wrotePlist) rmSync(paths.plist);
      throw error;
    }
    try { launchctl(execute, ['bootstrap', `gui/${uid}`, paths.plist]); } catch {
      throw new Error(`Saved ${label}, but launchctl bootstrap failed. Files remain installed; check your GUI session and use djobs unschedule ${job.name} before retrying`);
    }
    return { label, interval: job.interval, ...paths };
  });
}

export function unscheduleJob(name, { home, uid, execute, listJobs }) {
  requireUser(uid);
  validateName(name);
  return withLock(home, () => {
    const job = readSchedules(home).find(job => job.name === name);
    if (!job) throw new Error(`No djobs-managed schedule named ${name}`);
    const paths = locations(home, name);
    if (existsSync(paths.plist) && readFileSync(paths.plist, 'utf8') !== renderPlist(job, home)) {
      throw new Error(`Refusing to remove changed or unowned plist ${paths.plist}`);
    }
    const label = `com.drusellers.${name}`;
    const listed = listJobs().some(job => job.label === label);
    const details = inspectJob(execute, uid, label);
    if (listed && details === null) throw new Error(`Could not verify ownership of loaded job ${label}; schedule files were kept`);
    if (details !== null) {
      if (!existsSync(paths.plist)) throw new Error(`Refusing to unload ${label}: its managed plist is missing`);
      const registeredPath = /^\s*path = (.+)$/m.exec(details)?.[1];
      if (registeredPath !== paths.plist) throw new Error(`Refusing to unload ${label}: launchd reports a different plist path`);
      try { launchctl(execute, ['bootout', `gui/${uid}/${label}`]); } catch {
        throw new Error(`Could not unload ${label}; schedule files were kept`);
      }
    }
    rmSync(paths.plist, { force: true });
    rmSync(paths.metadata);
    return label;
  });
}
