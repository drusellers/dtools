#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const GRAPH = 'https://graph.microsoft.com';
const SCOPES = 'https://graph.microsoft.com/Mail.Read offline_access';
const SUMMARY = 'id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,webLink';
const HELP = `Usage:
  dmail login --tenant TENANT_ID --client CLIENT_ID
  dmail list [--folder inbox] [--limit 25] [--unread]
  dmail list --next NEXT_LINK
  dmail read MESSAGE_ID [--html]
  dmail folders
  dmail logout

JSON results go to stdout; sign-in instructions and errors go to stderr.
Tenant/client default to DMAIL_TENANT_ID / DMAIL_CLIENT_ID, then cached values.
Requires Node.js 20+. Uses delegated Mail.Read; never changes mailbox state.
DMAIL_HOME overrides the private local token-cache directory.
`;

export function parseArgs(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') return { command: 'help' };
  const command = args[0];
  const allowed = {
    login: ['tenant', 'client'], list: ['folder', 'limit', 'unread', 'next'],
    read: ['html'], folders: [], logout: [],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}`);
  const options = {};
  let id;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { command: 'help' };
    if (command === 'read' && !arg.startsWith('-') && id === undefined) {
      id = arg;
      continue;
    }
    const key = arg.startsWith('--') ? arg.slice(2) : '';
    if (!allowed[command].includes(key) || Object.hasOwn(options, key)) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    if (key === 'unread' || key === 'html') options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[key] = value;
    }
  }
  if (command === 'read' && !id) throw new Error('A message ID is required.');
  if (options.limit && (!/^\d+$/.test(options.limit) || +options.limit < 1 || +options.limit > 100)) {
    throw new Error('--limit must be an integer from 1 to 100.');
  }
  if (options.next && Object.keys(options).length !== 1) throw new Error('--next cannot be combined with other options.');
  return { command, options, id };
}

export function validateIdentity(tenant, client) {
  // A specific tenant avoids accidentally authenticating against another organization.
  if (!tenant || !/^[a-zA-Z0-9.-]+$/.test(tenant) || ['common', 'organizations', 'consumers'].includes(tenant.toLowerCase())) {
    throw new Error('Provide a specific tenant ID/domain using --tenant or DMAIL_TENANT_ID.');
  }
  if (!client || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(client)) {
    throw new Error('Provide the application (client) UUID using --client or DMAIL_CLIENT_ID.');
  }
}

export function messageListUrl(options) {
  if (options.next) {
    const url = new URL(options.next);
    if (url.origin !== GRAPH || url.username || url.password || url.hash ||
        !/^\/v1\.0\/me\/(?:mailFolders\/[^/]+\/)?messages$/.test(url.pathname)) {
      throw new Error('--next must be a Microsoft Graph message-list nextLink.');
    }
    return url;
  }
  const url = new URL(`${GRAPH}/v1.0/me/mailFolders/${encodeURIComponent(options.folder || 'inbox')}/messages`);
  url.searchParams.set('$select', SUMMARY);
  url.searchParams.set('$top', options.limit || '25');
  if (options.unread) {
    // Graph requires order-by properties first in the filter to avoid InefficientFilter.
    url.searchParams.set('$filter', 'receivedDateTime ge 1970-01-01T00:00:00Z and isRead eq false');
  }
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  return url;
}

export class MailClient {
  constructor({ home, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), diagnostic = message => console.error(message) }) {
    this.home = home;
    this.cachePath = join(home, 'tokens.json');
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.diagnostic = diagnostic;
  }

  async load() {
    try { return JSON.parse(await readFile(this.cachePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('Cannot read token cache. Check DMAIL_HOME or run dmail logout.');
    }
  }

  async save(state) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);
    const temp = join(this.home, `.tokens-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.cachePath);
    } finally { await rm(temp, { force: true }); }
  }

  async request(url, options = {}) {
    try {
      return await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('Request failed or timed out. Check your network/VPN and try again.');
    }
  }

  async oauth(tenant, endpoint, fields) {
    const response = await this.request(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    const data = await response.json();
    return { ok: response.ok, data };
  }

  async storeTokens(tenant, client, data, previousRefresh) {
    if (!data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) {
      throw new Error('Microsoft returned an invalid token response.');
    }
    const state = {
      tenant, client, accessToken: data.access_token,
      refreshToken: data.refresh_token || previousRefresh,
      expiresAt: this.now() + Number(data.expires_in) * 1000,
    };
    await this.save(state);
    return state.accessToken;
  }

  async login(tenant, client) {
    validateIdentity(tenant, client);
    const { ok, data } = await this.oauth(tenant, 'devicecode', { client_id: client, scope: SCOPES });
    if (!ok) throw new Error(`Sign-in failed: ${data.error || 'unknown_error'}. Check tenant, client, public-client flow, and consent.`);
    if (!data.device_code || !data.message || !(Number(data.expires_in) > 0)) throw new Error('Invalid device-code response.');
    this.diagnostic(data.message);
    const deadline = this.now() + Number(data.expires_in) * 1000;
    let interval = Math.max(5, Number(data.interval) || 5) * 1000;
    while (this.now() < deadline) {
      await this.sleep(interval);
      if (this.now() >= deadline) break;
      const result = await this.oauth(tenant, 'token', {
        client_id: client, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: data.device_code,
      });
      if (result.ok) {
        await this.storeTokens(tenant, client, result.data);
        return { status: 'signed_in' };
      }
      if (result.data.error === 'authorization_pending') continue;
      if (result.data.error === 'slow_down') { interval += 5000; continue; }
      throw new Error(`Sign-in failed: ${result.data.error || 'unknown_error'}. Your company may block device-code sign-in.`);
    }
    throw new Error('Sign-in expired. Run dmail login again.');
  }

  async accessToken(tenant, client, force = false) {
    const state = await this.load();
    if (!state || state.tenant !== tenant || state.client !== client) throw new Error('Not signed in for this tenant/client. Run dmail login.');
    if (!force && state.accessToken && state.expiresAt > this.now() + 60_000) return state.accessToken;
    if (!state.refreshToken) throw new Error('Session expired. Run dmail login.');
    const { ok, data } = await this.oauth(tenant, 'token', {
      client_id: client, grant_type: 'refresh_token', refresh_token: state.refreshToken, scope: SCOPES,
    });
    if (!ok) throw new Error(`Token refresh failed: ${data.error || 'unknown_error'}. Run dmail login again.`);
    return this.storeTokens(tenant, client, data, state.refreshToken);
  }

  async graph(url, tenant, client, html = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(tenant, client, attempt > 0);
      const response = await this.request(url, { headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/json',
        Prefer: `outlook.body-content-type="${html ? 'html' : 'text'}"`,
      } });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) {
        let code = '';
        try { code = (await response.json()).error?.code || ''; } catch { /* Non-JSON gateway errors. */ }
        const hint = response.status === 403 ? ' Check delegated Mail.Read permission and company consent/policies.' :
          response.status === 429 ? ` Retry later (Retry-After: ${response.headers.get('retry-after') || 'unspecified'}).` : '';
        throw new Error(`Graph request failed (${response.status}${code ? `, ${code}` : ''}).${hint}`);
      }
      return response.json();
    }
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  const { command, options = {}, id } = parseArgs(args);
  if (command === 'help') { process.stdout.write(HELP); return; }
  const home = resolve(env.DMAIL_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dtools', 'dmail'));
  const mail = new MailClient({ home });
  if (command === 'logout') {
    await rm(mail.cachePath, { force: true });
    console.log(JSON.stringify({ status: 'signed_out' }));
    return;
  }
  const cached = await mail.load();
  const tenant = options.tenant || env.DMAIL_TENANT_ID || cached?.tenant;
  const client = options.client || env.DMAIL_CLIENT_ID || cached?.client;
  validateIdentity(tenant, client);
  let result;
  if (command === 'login') result = await mail.login(tenant, client);
  else {
    let url;
    if (command === 'list') url = messageListUrl(options);
    if (command === 'read') {
      url = new URL(`${GRAPH}/v1.0/me/messages/${encodeURIComponent(id)}`);
      url.searchParams.set('$select', `${SUMMARY},ccRecipients,body,internetMessageId`);
    }
    if (command === 'folders') {
      url = new URL(`${GRAPH}/v1.0/me/mailFolders`);
      url.searchParams.set('$top', '100');
      url.searchParams.set('$select', 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount');
    }
    result = await mail.graph(url, tenant, client, options.html);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`dmail: ${error.message}`);
    process.exitCode = 1;
  });
}
