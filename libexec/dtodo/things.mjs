import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export async function thingsTasks({ command, platform = process.platform, run = execute } = {}) {
  if (platform !== 'darwin') throw new Error('Things access requires macOS. Use --source wrike on other platforms.');
  let stdout;
  try {
    ({ stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./things.js', import.meta.url)), command === 'today' ? 'today' : 'list'], {
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
    }));
  } catch {
    throw new Error('Cannot read Things. Open Things and allow Automation access in System Settings > Privacy & Security.');
  }
  let tasks;
  try { tasks = JSON.parse(stdout); } catch { throw new Error('Invalid Things scripting response.'); }
  if (!Array.isArray(tasks) || tasks.some(task => task?.source !== 'things' || typeof task.id !== 'string' || typeof task.title !== 'string' || task.status !== 'open')) throw new Error('Invalid Things scripting response.');
  return { tasks, coverage: { pages: 0, complete: true, reason: 'exhausted' } };
}
