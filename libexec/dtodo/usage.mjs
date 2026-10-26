import { mkdir, lstat, chmod, readdir, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

// Keep storage/retention aligned with dmail; task-specific event allowlists below.
const COMMANDS = new Set(['list', 'today', 'overdue', 'login', 'logout']);
const OPTIONS = new Set(['source', 'limit', 'max-pages', 'host']);
const REASONS = new Set(['exhausted', 'max_pages']);
const DAY = 86400_000;
const LOG_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function usageEvent({ parsed, command, durationMs, result, error, timestamp = new Date().toISOString() }) {
  const name = parsed?.command || command;
  const options = {};
  for (const [key, value] of Object.entries(parsed?.options || {})) {
    if (OPTIONS.has(key)) options[key] = ['limit', 'max-pages'].includes(key) ? number(Number(value)) : true;
  }
  return {
    version: 1, timestamp, command: COMMANDS.has(name) ? name : 'unknown', options,
    durationMs: number(Math.round(durationMs)), success: !error,
    ...(error ? { error: error.usageCode === 'invalid_arguments' ? 'invalid_arguments' :
      /^http_[1-5]\d{2}$/.test(error.usageCode || '') ? error.usageCode :
      error.usageCode === 'network' ? 'network' : 'command_failed' } : {}),
    ...(!error && Array.isArray(result?.tasks) ? { stats: {
      count: number(result.tasks?.length), pages: number(result.coverage?.pages),
      ...(typeof result.coverage?.complete === 'boolean' ? { complete: result.coverage.complete } : {}),
      ...(REASONS.has(result.coverage?.reason) ? { reason: result.coverage.reason } : {}),
    } } : {}),
  };
}

async function privateDirectory(home) {
  const dir = join(home, 'usage');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe usage directory.');
  await chmod(dir, 0o700);
  return dir;
}

async function openPrivate(path, flags) {
  const file = await open(path, flags | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw new Error('Unsafe usage file.');
    await file.chmod(0o600);
    return file;
  } catch (error) { await file.close(); throw error; }
}

export async function appendUsage(home, event, now = Date.now()) {
  const dir = await privateDirectory(home);
  const today = new Date(now).toISOString().slice(0, 10);
  // Today plus the preceding 89 UTC dates. Concurrent appends use O_APPEND;
  // no rename-based rotation or read/modify/write that could lose events.
  const cutoff = new Date(now - 89 * DAY).toISOString().slice(0, 10);
  for (const name of await readdir(dir)) {
    if (LOG_FILE.test(name) && name.slice(0, 10) < cutoff) {
      try { await unlink(join(dir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const file = await openPrivate(join(dir, `${today}.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
  try { await file.writeFile(`${JSON.stringify(event)}\n`); } finally { await file.close(); }
}

export async function usageSummary(home, options = {}, now = Date.now()) {
  const dir = join(home, 'usage');
  const since = options.since || new Date(now - 89 * DAY).toISOString().slice(0, 10);
  const before = options.before || new Date(now + DAY).toISOString().slice(0, 10);
  const summary = { since, before, retentionDays: 90, total: 0, skippedLines: 0, commands: {} };
  let names;
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe usage directory.');
    names = await readdir(dir);
  } catch (error) { if (error.code === 'ENOENT') return summary; throw error; }
  const cutoff = new Date(now - 89 * DAY).toISOString().slice(0, 10);
  for (const name of names.sort()) {
    if (!LOG_FILE.test(name) || name.slice(0, 10) < cutoff || name.slice(0, 10) < since || name.slice(0, 10) >= before) continue;
    let file;
    try { file = await openPrivate(join(dir, name), constants.O_RDONLY); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    let content;
    try { content = await file.readFile('utf8'); } finally { await file.close(); }
    for (const line of content.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { summary.skippedLines++; continue; }
      if (!event || typeof event !== 'object' || event.version !== 1 || ![...COMMANDS, 'unknown'].includes(event.command) ||
          typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp)) ||
          typeof event.success !== 'boolean' || number(event.durationMs) === null) {
        summary.skippedLines++; continue;
      }
      const date = event.timestamp.slice(0, 10);
      if (date < since || date >= before || date < cutoff) continue;
      const row = summary.commands[event.command] ||= {
        calls: 0, failures: 0, durationMs: 0, maxDurationMs: 0, results: 0, pages: 0,
        incomplete: 0, errors: {}, options: {}, coverageReasons: {},
      };
      summary.total++; row.calls++;
      row.failures += event.success ? 0 : 1;
      row.durationMs += event.durationMs;
      row.maxDurationMs = Math.max(row.maxDurationMs, event.durationMs);
      row.results += number(event.stats?.count) || 0;
      row.pages += number(event.stats?.pages) || 0;
      row.incomplete += event.stats?.complete === false ? 1 : 0;
      if (REASONS.has(event.stats?.reason)) row.coverageReasons[event.stats.reason] = (row.coverageReasons[event.stats.reason] || 0) + 1;
      if (['invalid_arguments', 'network', 'command_failed'].includes(event.error) || /^http_[1-5]\d{2}$/.test(event.error || '')) {
        row.errors[event.error] = (row.errors[event.error] || 0) + 1;
      }
      for (const key of Object.keys(event.options || {})) {
        if (OPTIONS.has(key)) row.options[key] = (row.options[key] || 0) + 1;
      }
    }
  }
  for (const row of Object.values(summary.commands)) row.averageDurationMs = Math.round(row.durationMs / row.calls);
  return summary;
}
