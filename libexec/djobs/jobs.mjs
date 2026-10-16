import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeSchedules, parseScheduleArgs, readSchedules, scheduleJob, unscheduleJob } from './schedules.mjs';

const HELP = `Usage: djobs [list] [options] [search]
       djobs ignore PREFIX [--config PATH]
       djobs schedule SCRIPT INTERVAL --name NAME [--cwd PATH]
       djobs unschedule NAME

List jobs and manage user interval schedules (macOS, Node.js 20+).
Listing is read-only. No arbitrary launchctl arguments are accepted.

schedule runs a Bash-compatible file via /bin/bash, with an interval such as
30s, 15m, 2h, or 1d. Names produce com.drusellers.NAME labels.
The working directory defaults to the directory where you schedule the job.
Runs are skipped during sleep or when the job is already running; no immediate
run on installation. Scripts must set PATH or use absolute paths for tools.
unschedule unloads only djobs-managed jobs and removes their schedule files.
Logs remain in ~/Library/Logs/dtools/djobs/.

  --all          Include jobs hidden by default or config
  --running      Only jobs with a PID
  --json         Output a JSON array instead of a table
  --config PATH  Use a specific JSON config (ignore creates it if missing)
  -h, --help     Show help
  --             Treat remaining argument as search text

Search is a case-insensitive label substring.
ignore saves a literal, case-sensitive exclude prefix; duplicates are a no-op.
Use a trailing dot (com.microsoft.) to match a namespace boundary.
Default config: ~/.config/dtools/djobs/config.json (respects XDG_CONFIG_HOME).
DJOBS_CONFIG overrides the default config path.
Config: {"excludePrefixes": ["com.vendor."], "excludeLabels": ["some.job"]}
Exclusions add to the built-in com.apple. prefix; --all bypasses them.
`;

export function parseArgs(args) {
  if (['schedule', 'unschedule'].includes(args[0])) return parseScheduleArgs(args);
  const options = { all: false, running: false, json: false, help: false, search: '' };
  let positional = false;
  let hasSearch = false;
  const command = args[0] === 'ignore' ? 'ignore' : 'list';
  if (['list', 'ignore'].includes(args[0])) args = args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && ['--all', '--running', '--json'].includes(arg)) {
      options[arg.slice(2)] = true;
    } else if (!positional && ['--help', '-h'].includes(arg)) {
      options.help = true;
    } else if (!positional && arg === '--config') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config requires a path');
      options.config = args[++i];
    } else if (!positional && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      if (hasSearch) throw new Error('Only one search argument is supported');
      options.search = arg;
      hasSearch = true;
    }
  }
  if (command === 'ignore') {
    options.command = command;
    if (options.all || options.running || options.json) throw new Error('ignore only supports --config and --help');
    if (!options.help && (!hasSearch || !options.search.trim() || /\s/.test(options.search))) {
      throw new Error('ignore requires one nonempty prefix without whitespace');
    }
  }
  return options;
}

export function loadConfig(path, required = false) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return { excludePrefixes: [], excludeLabels: [] };
    throw new Error(`Cannot read config ${path}: ${error.message}`);
  }
  let config;
  try { config = JSON.parse(source); } catch {
    throw new Error(`Invalid JSON in config ${path}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Config ${path} must be an object`);
  }
  for (const key of Object.keys(config)) {
    if (!['excludePrefixes', 'excludeLabels'].includes(key)) throw new Error(`Unknown config key: ${key}`);
  }
  for (const key of ['excludePrefixes', 'excludeLabels']) {
    const values = config[key] === undefined ? [] : config[key];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error(`${key} must be an array of nonempty strings`);
    }
    config[key] = values;
  }
  return config;
}

export function ignorePrefix(path, prefix) {
  const config = loadConfig(path);
  if (config.excludePrefixes.includes(prefix)) return false;
  config.excludePrefixes.push(prefix);
  const directory = dirname(path);
  let temporary;
  try {
    mkdirSync(directory, { recursive: true });
    temporary = mkdtempSync(join(directory, '.djobs-'));
    const file = join(temporary, 'config.json');
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync(file, path);
  } catch (error) {
    throw new Error(`Cannot write config ${path}: ${error.message}`);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  return true;
}

export function parseJobs(output) {
  const lines = output.trim().split(/\r?\n/);
  if (!/^PID\s+Status\s+Label$/i.test(lines.shift()?.trim() ?? '')) {
    throw new Error('Unexpected launchctl list header');
  }
  return lines.filter(line => line.trim()).map(line => {
    const match = line.trim().match(/^(\d+|-)\s+(-?\d+)\s+(\S+)$/);
    if (!match) throw new Error('Unexpected launchctl list row');
    const pid = match[1] === '-' ? null : Number(match[1]);
    const status = Number(match[2]);
    if ((pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) || !Number.isSafeInteger(status)) {
      throw new Error('Invalid launchctl PID or status');
    }
    return { pid, status, label: match[3] };
  });
}

export function filterJobs(jobs, config, options) {
  const prefixes = ['com.apple.', ...config.excludePrefixes];
  const labels = new Set(config.excludeLabels);
  const search = options.search.toLowerCase();
  return jobs.filter(job =>
    (options.all || (!labels.has(job.label) && !prefixes.some(prefix => job.label.startsWith(prefix)))) &&
    (!options.running || job.pid !== null) &&
    job.label.toLowerCase().includes(search)
  ).sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

export function formatJobs(jobs, json) {
  if (json) return JSON.stringify(jobs, null, 2) + '\n';
  const rows = [['PID', 'STATUS', 'LABEL', 'STATE', 'SCHEDULE'], ...jobs.map(job => [
    String(job.pid ?? '-'), String(job.status ?? '-'), job.label,
    job.loaded === false ? 'unloaded' : 'loaded', job.schedule ? `every ${job.schedule}` : '-',
  ])];
  const widths = [0, 1, 2, 3].map(index => rows.reduce((width, row) => Math.max(width, row[index].length), 0));
  return rows.map(row => row.map((value, index) => index < 4 ? value.padEnd(widths[index]) : value).join('  ')).join('\n') + '\n';
}

export function main(args, {
  platform = process.platform,
  env = process.env,
  execute = execFileSync,
  home = homedir(),
  cwd = process.cwd(),
  uid = process.getuid?.(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const options = parseArgs(args);
    if (options.help) { stdout.write(HELP); return 0; }
    if (platform !== 'darwin') throw new Error('Only macOS is supported');
    const listJobs = () => {
      let output;
      try {
        output = execute('/bin/launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        throw new Error('launchctl list failed; run djobs from your normal macOS user session');
      }
      return parseJobs(output);
    };
    const context = { home, cwd, uid, execute, listJobs };
    if (options.command === 'schedule') {
      const job = scheduleJob(options, context);
      stdout.write(`Scheduled ${job.label} every ${job.interval}\nLogs: ${job.stdout}\n      ${job.stderr}\n`);
      return 0;
    }
    if (options.command === 'unschedule') {
      stdout.write(`Unscheduled ${unscheduleJob(options.name, context)} (logs kept)\n`);
      return 0;
    }
    const explicit = options.config || env.DJOBS_CONFIG;
    const path = explicit || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'dtools', 'djobs', 'config.json');
    if (options.command === 'ignore') {
      const added = ignorePrefix(path, options.search);
      stdout.write(`${added ? 'Ignoring' : 'Already ignoring'} prefix ${JSON.stringify(options.search)} in ${path}\n`);
      return 0;
    }
    const config = loadConfig(path, Boolean(explicit));
    const jobs = mergeSchedules(listJobs(), readSchedules(home));
    stdout.write(formatJobs(filterJobs(jobs, config, options), options.json));
    return 0;
  } catch (error) {
    stderr.write(`djobs: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
