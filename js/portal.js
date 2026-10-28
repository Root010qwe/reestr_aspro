// Доступ к Аспро.Cloud из мини-приложения (тот же подход, что в doc_aspro).
//  • oauth   — штатный frame.rest SDK: токен текущего пользователя, права по scopes манифеста;
//  • session — Rest.request через родительское окно, с сессией пользователя в портале.
// Всё выполняется с правами текущего пользователя: кто не видит список, тот ничего не увидит.

export class PortalError extends Error {}

const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export class FrameTransport {
  constructor(frame) {
    this.frame = frame;
    this.base = `${frame.https === false ? 'http' : 'https'}://${frame.domain}`;
    this.n = 0;
  }
  async oauth(method, path, data) {
    const p = path.replace(/^\/api\/v1\/module/, '');
    const res = method === 'GET' ? await this.frame.rest.get(p) : await this.frame.rest.post(p, data || {});
    return { ok: true, status: 200, data: res };
  }
  async session(method, url, data) {
    const pm = this.frame.postman;
    const id = `${Date.now().toString(36)}${(this.n++).toString(36)}`;
    const config = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
    if (data) { config.headers['Content-Type'] = 'application/x-www-form-urlencoded'; config.body = qs(data); }
    const r = await pm.send(`${pm.prefix}/Rest:${id}/request:${id}`, { url: url.startsWith('http') ? url : this.base + url, config });
    return { ok: !!r?.response?.ok, status: r?.response?.status || 0, data: r?.data ?? null };
  }
}

export class Portal {
  constructor(transport) { this.t = transport; this.channel = {}; }

  async api(method, path, data, kind = 'api') {
    const full = `/api/v1/module/${path.replace(/^\//, '')}`;
    let r = null;
    if (this.channel[kind] !== 'session') {
      try { r = await this.t.oauth(method, full, data); } catch (e) { r = { ok: false, status: 0, data: { error: String(e.message || e) } }; }
      if (r.ok && !(r.data && r.data.error)) { this.channel[kind] = 'oauth'; return unwrap(r.data, full); }
    }
    const s = await this.t.session(method, full, data);
    if (s.ok && !(s.data && s.data.error)) { this.channel[kind] = 'session'; return unwrap(s.data, full); }
    const err = (s.data && s.data.error) || (r && r.data && r.data.error) || `HTTP ${s.status}`;
    throw new PortalError(`${path}: ${typeof err === 'object' ? JSON.stringify(err) : err}`);
  }

  async listItems(listId) {
    const out = [];
    for (let page = 1; page < 200; page++) {
      const r = await this.api('GET', `customlists/items/list?${qs({ 'filter[list_id]': listId, limit: 100, page })}`, null, 'items');
      const items = r.items || [];
      out.push(...items.filter(i => String(i.list_id) === String(listId)));
      if (items.length < 100) break;
    }
    return out;
  }
}

function unwrap(d, url) {
  if (d == null) throw new PortalError(`пустой ответ ${url}`);
  return d.response !== undefined ? d.response : d;
}
