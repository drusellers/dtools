#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { appendUsage, usageEvent, usageSummary } from './usage.mjs';

const GRAPH = 'https://graph.microsoft.com';
const SCOPES = 'https://graph.microsoft.com/Mail.Read offline_access';
const SUMMARY = 'id,subject,from,toRecipients,receivedDateTime,sentDateTime,conversationId,parentFolderId,isRead,hasAttachments,bodyPreview,webLink';
const DETAIL = `${SUMMARY},ccRecipients,body,internetMessageId`;
const HELP = `Usage:
  dmail login --tenant TENANT_ID --client CLIENT_ID
  dmail list [--folder inbox] [--limit 25] [--unread] [--since DATE] [--before DATE]
  dmail list [--all] [--max-pages 10] [--next NEXT_LINK]
  dmail search [QUERY] [--from PERSON] [--to PERSON] [--since DATE] [--before DATE]
               [--limit 100] [--max-pages 10]
  dmail thread MESSAGE_ID [--html] [--max-pages 10]
  dmail read MESSAGE_ID [--html]
  dmail attachments MESSAGE_ID [--next NEXT_LINK]
  dmail download MESSAGE_ID ATTACHMENT_ID --output FILE
  dmail folders
  dmail usage [--since DATE] [--before DATE]
  dmail logout

Dates: YYYY-MM-DD; --since inclusive, --before exclusive.
Search accepts KQL and spans mailbox folders (Microsoft caps search at 1,000 results).
Search/thread auto-page; list requires --all. Page bounds: --max-pages 1-100.
Paged JSON includes coverage; check complete/reason before assuming all matches.
JSON results go to stdout; sign-in instructions and errors go to stderr.
Tenant/client default to DMAIL_TENANT_ID / DMAIL_CLIENT_ID, then cached values.
Requires Node.js 20+. Uses delegated Mail.Read; never changes mailbox state.
DMAIL_HOME overrides the private local token-cache and usage-log directory.
Command shapes/stats are logged locally for 90 days; DMAIL_USAGE_LOG=0 disables logging.
No query text, identities, message IDs, response content, or credentials are logged.
`;

export function parseArgs(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') return { command: 'help' };
  const command = args[0];
  const allowed = {
    login: ['tenant', 'client'], list: ['folder', 'limit', 'unread', 'next', 'all', 'max-pages', 'since', 'before'],
    search: ['from', 'to', 'since', 'before', 'limit', 'max-pages'],
    thread: ['html', 'max-pages'], read: ['html'], attachments: ['next'], download: ['output'], folders: [], logout: [],
    usage: ['since', 'before'],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}`);
  const options = {};
  let id;
  let attachmentId;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { command: 'help' };
    if (['read', 'attachments', 'download', 'thread', 'search'].includes(command) && !arg.startsWith('-')) {
      if (id === undefined) { id = arg; continue; }
      if (command === 'download' && attachmentId === undefined) { attachmentId = arg; continue; }
    }
    const key = arg.startsWith('--') ? arg.slice(2) : '';
    if (!allowed[command].includes(key) || Object.hasOwn(options, key)) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    if (['unread', 'html', 'all'].includes(key)) options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[key] = value;
    }
  }
  if (['read', 'attachments', 'download', 'thread'].includes(command) && !id) throw new Error('A message ID is required.');
  if (command === 'download' && (!attachmentId || !options.output)) {
    throw new Error('An attachment ID and --output FILE are required.');
  }
  if (options.limit && (!/^\d+$/.test(options.limit) || +options.limit < 1 || +options.limit > 100)) {
    throw new Error('--limit must be an integer from 1 to 100.');
  }
  if (options['max-pages'] && (!/^\d+$/.test(options['max-pages']) || +options['max-pages'] < 1 || +options['max-pages'] > 100)) {
    throw new Error('--max-pages must be an integer from 1 to 100.');
  }
  if (command === 'list' && options['max-pages'] && !options.all) throw new Error('--max-pages requires --all.');
  for (const key of ['since', 'before']) {
    const date = options[key];
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
      throw new Error(`--${key} must be a valid YYYY-MM-DD date (UTC).`);
    }
  }
  if (options.since && options.before && options.since >= options.before) throw new Error('--since must precede --before.');
  if (command === 'search' && !id && !['from', 'to', 'since', 'before'].some(key => options[key])) {
    throw new Error('Provide a search query or person/date filter.');
  }
  if (options.next && Object.keys(options).some(key => !['next', ...(command === 'list' ? ['all', 'max-pages'] : [])].includes(key))) {
    throw new Error('--next cannot be combined with filters or --limit.');
  }
  return { command, options, id, ...(attachmentId === undefined ? {} : { attachmentId }) };
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
        !/^\/v1\.0\/me\/(?:mailFolders(?:\/[^/]+|\('[^'/]+'\))\/)?messages$/.test(url.pathname)) {
      throw new Error('--next must be a Microsoft Graph message-list nextLink.');
    }
    return url;
  }
  const url = new URL(`${GRAPH}/v1.0/me/mailFolders/${encodeURIComponent(options.folder || 'inbox')}/messages`);
  url.searchParams.set('$select', SUMMARY);
  url.searchParams.set('$top', options.limit || '25');
  const filters = [];
  if (options.since || options.unread) filters.push(`receivedDateTime ge ${options.since || '1970-01-01'}T00:00:00Z`);
  if (options.before) filters.push(`receivedDateTime lt ${options.before}T00:00:00Z`);
  // Graph requires order-by properties first in the filter to avoid InefficientFilter.
  if (options.unread) filters.push('isRead eq false');
  if (filters.length) url.searchParams.set('$filter', filters.join(' and '));
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  return url;
}

export function searchUrl(query, options = {}) {
  const terms = [];
  if (query) terms.push(`(${query})`);
  // Quote structured values as KQL phrases; disallow escapes/operators inside them.
  for (const key of ['from', 'to']) {
    if (!options[key]) continue;
    if (/["\\\r\n]/.test(options[key])) throw new Error(`--${key} cannot contain quotes, backslashes, or newlines.`);
    terms.push(`${key}:"${options[key]}"`);
  }
  if (options.since) terms.push(`received>=${options.since}`);
  if (options.before) terms.push(`received<${options.before}`);
  const url = new URL(`${GRAPH}/v1.0/me/messages`);
  url.searchParams.set('$search', JSON.stringify(terms.join(' AND ')));
  url.searchParams.set('$select', SUMMARY);
  url.searchParams.set('$top', options.limit || '100');
  return url;
}

export function attachmentListUrl(id, options = {}) {
  const base = `${GRAPH}/v1.0/me/messages/${encodeURIComponent(id)}/attachments`;
  const url = new URL(options.next || base);
  if (url.origin !== GRAPH || url.username || url.password || url.hash || url.pathname !== new URL(base).pathname) {
    throw new Error('--next must be a Microsoft Graph attachment-list nextLink for this message.');
  }
  if (!options.next) {
    url.searchParams.set('$select', 'id,name,contentType,size,isInline');
    url.searchParams.set('$top', '100');
  }
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
      throw Object.assign(new Error('Request failed or timed out. Check your network/VPN and try again.'), { usageCode: 'network' });
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

  async download(id, attachmentId, output, tenant, client) {
    const url = `${GRAPH}/v1.0/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`;
    const metadata = await this.graph(url + '?$select=id,name,contentType,size', tenant, client);
    if (metadata['@odata.type'] !== '#microsoft.graph.fileAttachment') {
      throw new Error('Only file attachments can be downloaded; attached Outlook items and reference links are not supported.');
    }
    const bytes = await this.graph(`${url}/$value`, tenant, client, false, true);
    const path = resolve(output);
    // Exclusive creation also refuses existing symlinks; never trust an email's filename.
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return { id: attachmentId, name: metadata.name, path, size: bytes.length };
  }

  async collect(url, tenant, client, { maxPages = 10, html = false, search = false } = {}) {
    const value = [];
    const seen = new Set();
    let pages = 0;
    let next = String(url);
    while (next && pages < maxPages) {
      if (seen.has(next)) throw new Error('Microsoft returned a repeated pagination link.');
      seen.add(next);
      const page = await this.graph(messageListUrl({ next }), tenant, client, html);
      if (!Array.isArray(page.value)) throw new Error('Microsoft returned an invalid message page.');
      value.push(...page.value);
      next = page['@odata.nextLink'];
      pages++;
    }
    const searchLimit = search && value.length >= 1000;
    return {
      value,
      ...(next ? { '@odata.nextLink': next } : {}),
      coverage: { count: value.length, pages, complete: !next && !searchLimit,
        reason: next ? 'max_pages' : searchLimit ? 'search_limit' : 'exhausted' },
    };
  }

  async thread(id, options, tenant, client) {
    const seed = new URL(`${GRAPH}/v1.0/me/messages/${encodeURIComponent(id)}`);
    seed.searchParams.set('$select', 'conversationId');
    const message = await this.graph(seed, tenant, client);
    if (!message.conversationId) throw new Error('Message has no conversation ID.');
    const url = new URL(`${GRAPH}/v1.0/me/messages`);
    url.searchParams.set('$filter', `conversationId eq '${message.conversationId.replace(/'/g, "''")}'`);
    url.searchParams.set('$select', DETAIL);
    url.searchParams.set('$top', '100');
    const result = await this.collect(url, tenant, client, { maxPages: +(options['max-pages'] || 10), html: options.html });
    result.value.sort((a, b) => (a.sentDateTime || a.receivedDateTime || '').localeCompare(b.sentDateTime || b.receivedDateTime || '') || a.id.localeCompare(b.id));
    return { conversationId: message.conversationId, ...result };
  }

  async graph(url, tenant, client, html = false, raw = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(tenant, client, attempt > 0);
      const response = await this.request(url, { headers: {
        Authorization: `Bearer ${token}`, Accept: raw ? 'application/octet-stream' : 'application/json',
        Prefer: `outlook.body-content-type="${html ? 'html' : 'text'}"`,
      } });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) {
        let code = '';
        try { code = (await response.json()).error?.code || ''; } catch { /* Non-JSON gateway errors. */ }
        const hint = response.status === 403 ? ' Check delegated Mail.Read permission and company consent/policies.' :
          response.status === 429 ? ` Retry later (Retry-After: ${response.headers.get('retry-after') || 'unspecified'}).` : '';
        throw Object.assign(new Error(`Graph request failed (${response.status}${code ? `, ${code}` : ''}).${hint}`), { usageCode: `http_${response.status}` });
      }
      return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
    }
  }
}

async function execute({ command, options = {}, id, attachmentId }, env, home) {
  if (command === 'usage') return usageSummary(home, options);
  const mail = new MailClient({ home });
  if (command === 'logout') {
    await rm(mail.cachePath, { force: true });
    return { status: 'signed_out' };
  }
  const cached = await mail.load();
  const tenant = options.tenant || env.DMAIL_TENANT_ID || cached?.tenant;
  const client = options.client || env.DMAIL_CLIENT_ID || cached?.client;
  validateIdentity(tenant, client);
  let result;
  if (command === 'login') result = await mail.login(tenant, client);
  else if (command === 'download') result = await mail.download(id, attachmentId, options.output, tenant, client);
  else if (command === 'thread') result = await mail.thread(id, options, tenant, client);
  else if (command === 'search' || (command === 'list' && options.all)) {
    result = await mail.collect(command === 'search' ? searchUrl(id, options) : messageListUrl(options), tenant, client,
      { maxPages: +(options['max-pages'] || 10), search: command === 'search' });
  } else {
    let url;
    if (command === 'list') url = messageListUrl(options);
    if (command === 'attachments') url = attachmentListUrl(id, options);
    if (command === 'read') {
      url = new URL(`${GRAPH}/v1.0/me/messages/${encodeURIComponent(id)}`);
      url.searchParams.set('$select', DETAIL);
    }
    if (command === 'folders') {
      url = new URL(`${GRAPH}/v1.0/me/mailFolders`);
      url.searchParams.set('$top', '100');
      url.searchParams.set('$select', 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount');
    }
    result = await mail.graph(url, tenant, client, options.html);
  }
  return result;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  const home = resolve(env.DMAIL_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dtools', 'dmail'));
  const started = performance.now();
  let parsed, result, failure;
  try {
    try { parsed = parseArgs(args); }
    catch (error) { error.usageCode = 'invalid_arguments'; throw error; }
    if (parsed.command === 'help') { process.stdout.write(HELP); return; }
    result = await execute(parsed, env, home);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Usage/help must not create their own history. Never let logging break mail.
    if (env.DMAIL_USAGE_LOG !== '0' && !['help', 'usage'].includes(parsed?.command || args[0]) && args.length) {
      try {
        const event = usageEvent({ parsed, command: args[0], result, error: failure, durationMs: performance.now() - started });
        await appendUsage(home, event);
      }
      catch { console.error('dmail: Usage logging unavailable; command result is unchanged.'); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`dmail: ${error.message}`);
    process.exitCode = 1;
  });
}
