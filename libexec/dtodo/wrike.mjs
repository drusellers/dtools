const HOSTS = new Set(['www.wrike.com', 'app-eu.wrike.com', 'app-us2.wrike.com']);

export function wrikeBase(host = 'www.wrike.com') {
  if (!HOSTS.has(host)) throw new Error('WRIKE_HOST must be www.wrike.com, app-eu.wrike.com, or app-us2.wrike.com.');
  return `https://${host}/api/v4`;
}

// API contracts: https://developers.wrike.com/api/v4/contacts/
// https://developers.wrike.com/api/v4/tasks/
export class WrikeClient {
  constructor({ token, host, fetchImpl = fetch }) {
    this.token = token;
    this.base = wrikeBase(host);
    this.fetch = fetchImpl;
  }

  async get(path, params) {
    if (!this.token || /[\r\n]/.test(this.token)) throw new Error('Set WRIKE_TOKEN to your personal Wrike API token.');
    const url = new URL(`${this.base}/${path}`);
    url.search = new URLSearchParams(params).toString();
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET', headers: { Authorization: `Bearer ${this.token}` },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw Object.assign(new Error('Wrike request failed or timed out.'), { usageCode: 'network' });
    }
    if (!response.ok) throw Object.assign(new Error(`Wrike returned HTTP ${response.status}. Check token, host, and access.`), { usageCode: `http_${response.status}` });
    let data;
    try { data = await response.json(); } catch { throw new Error('Invalid Wrike response.'); }
    if (!Array.isArray(data?.data) || (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')) throw new Error('Invalid Wrike response.');
    return data;
  }

  async currentUser() {
    const contacts = await this.get('contacts', { me: 'true' });
    const me = contacts.data.filter(contact => contact?.me === true && typeof contact.id === 'string' && contact.id);
    if (me.length !== 1) throw new Error('Wrike did not identify exactly one current user.');
    return me[0].id;
  }

  async list({ maxPages = 10, limit = 100 } = {}) {
    const userId = await this.currentUser();
    const tasks = new Map();
    const seen = new Set();
    let next;
    let pages = 0;
    do {
      const params = {
        responsibles: JSON.stringify([userId]), status: JSON.stringify(['Active', 'Deferred']),
        fields: JSON.stringify(['responsibleIds', 'parentIds']), pageSize: String(limit), subTasks: 'true',
        ...(next ? { nextPageToken: next } : {}),
      };
      const data = await this.get('tasks', params);
      pages++;
      for (const task of data.data) {
        if (!Array.isArray(task.responsibleIds)) throw new Error('Wrike response is missing task assignments.');
        if (!task.responsibleIds.includes(userId) || !['Active', 'Deferred'].includes(task.status) || task.scope === 'RbTask') continue;
        if (typeof task.id !== 'string' || !task.id || typeof task.title !== 'string') throw new Error('Invalid Wrike task.');
        let link;
        try { link = new URL(task.permalink); } catch { throw new Error('Wrike task is missing a valid permalink.'); }
        if (link.protocol !== 'https:' || !HOSTS.has(link.hostname) || link.username || link.password || link.port) throw new Error('Invalid Wrike task permalink.');
        const due = task.dates?.due;
        if (due != null && (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(due) || !Number.isFinite(Date.parse(due)))) throw new Error('Invalid Wrike due date.');
        tasks.set(task.id, {
          source: 'wrike', id: task.id, title: task.title,
          status: task.status === 'Active' ? 'open' : 'deferred', sourceStatus: task.status,
          dueDate: due?.slice(0, 10) || null, project: null,
          // Tasks can belong to several folders/projects; don't invent a single name.
          projectIds: Array.isArray(task.parentIds) ? task.parentIds : [],
          url: task.permalink,
        });
      }
      next = data.nextPageToken;
      if (next && seen.has(next)) throw new Error('Wrike returned a repeated pagination token.');
      if (next) seen.add(next);
    } while (next && pages < maxPages);
    return { tasks: [...tasks.values()], coverage: { pages, complete: !next, reason: next ? 'max_pages' : 'exhausted' } };
  }
}
