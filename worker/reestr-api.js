// Cloudflare Worker для мини-приложения «Реестр документов».
//  POST /upload — кладёт файл в Nextcloud (WebDAV) и возвращает fileid и ссылку;
//  POST /ai     — разбор текста документа моделью через любой OpenAI-совместимый API (GLM, DeepSeek, Qwen…), если задан ключ.
// Пускает только пользователей портала: OAuth-токен мини-приложения проверяется запросом к API Аспро.
//
// Секреты (Workers → Settings → Variables, тип Secret):
//   NC_USER, NC_PASS   — логин и пароль приложения Nextcloud (бот);
//   AI_KEY             — ключ модели (необязательно: без него /ai отвечает 501).
// Переменные (plain text):
//   NC_URL      = https://nextcloud.it-nb.ru
//   NC_ROOT     = КазГАУ реестр документов/Реестр         — корневая папка внутри аккаунта бота
//   PORTAL      = https://aspro.it-nb.ru
//   ORIGIN      = https://root010qwe.github.io
//   AI_BASE_URL = https://open.bigmodel.cn/api/paas/v4    — пример для GLM; любой URL с /chat/completions
//   AI_MODEL    = glm-4-flash

const MAX_FILE = 25 * 1024 * 1024;

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
});
const json = (env, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) } });

// токен мини-приложения -> пользователь портала (или null)
async function portalUser(env, req) {
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+$/.test(auth)) return null;
  const r = await fetch(`${env.PORTAL}/api/v1/module/core/user/get`, { headers: { Authorization: auth } });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  const u = d && (d.response || d);
  return u && u.id ? { id: u.id, name: u.name || u.email || String(u.id) } : null;
}

const ncAuth = (env) => 'Basic ' + btoa(unescape(encodeURIComponent(`${env.NC_USER}:${env.NC_PASS}`)));
const davBase = (env) => `${env.NC_URL}/remote.php/dav/files/${encodeURIComponent(env.NC_USER)}`;
const enc = (path) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function safePath(p) {
  const parts = String(p || '').split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.some(s => s === '.' || s === '..' || /[\\:*?"<>|\x00-\x1f]/.test(s))) return null;
  return parts.join('/');
}

async function dav(env, method, path, init = {}) {
  return fetch(`${davBase(env)}/${enc(path)}`, { method, ...init, headers: { Authorization: ncAuth(env), ...(init.headers || {}) } });
}

async function mkdirs(env, path) {
  let cur = '';
  for (const part of path.split('/')) {
    cur = cur ? `${cur}/${part}` : part;
    const r = await dav(env, 'MKCOL', cur);
    if (![201, 405].includes(r.status)) throw new Error(`MKCOL ${cur}: ${r.status}`);   // 405 — уже есть
  }
}

async function exists(env, path) {
  const r = await dav(env, 'PROPFIND', path, { headers: { Depth: '0' } });
  return r.status === 207;
}

async function fileId(env, path) {
  const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>';
  const r = await dav(env, 'PROPFIND', path, { body, headers: { Depth: '0', 'Content-Type': 'application/xml' } });
  const m = (await r.text()).match(/<oc:fileid>(\d+)<\/oc:fileid>/);
  return m ? m[1] : null;
}

async function upload(env, req) {
  const form = await req.formData();
  const file = form.get('file');
  const dir = safePath(form.get('dir'));
  const name = safePath(form.get('name') || (file && file.name));
  if (!file || typeof file === 'string') return json(env, { error: 'нет файла' }, 400);
  if (file.size > MAX_FILE) return json(env, { error: 'файл больше 25 МБ' }, 413);
  if (!dir || !name || name.includes('/')) return json(env, { error: 'неверная папка или имя' }, 400);

  const root = safePath(env.NC_ROOT) || 'Реестр документов';
  const folder = `${root}/${dir}`;
  await mkdirs(env, folder);
  // не перезаписываем: «имя (2).pdf», «имя (3).pdf» …
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let path = `${folder}/${name}`;
  for (let i = 2; await exists(env, path); i++) {
    if (i > 50) return json(env, { error: 'слишком много файлов с таким именем' }, 409);
    path = `${folder}/${stem} (${i})${ext}`;
  }
  const put = await dav(env, 'PUT', path, { body: file.stream(), headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (![200, 201, 204].includes(put.status)) return json(env, { error: `Nextcloud: ${put.status}` }, 502);
  const id = await fileId(env, path);
  return json(env, { path, fileid: id, link: id ? `${env.NC_URL}/f/${id}` : null });
}

const AI_PROMPT = `Ты извлекаешь реквизиты из российского бухгалтерского документа. Наша компания — АО «Нью Бренд», ИНН 1686032615: её реквизиты НЕ являются контрагентом.
Верни только JSON без пояснений с ключами:
doc_type (одно из: "Договор","Доп. соглашение","Приложение / спецификация","Счёт","Счёт-фактура / УПД","Акт выполненных работ","Акт сдачи-приёмки","Акт сверки","Платёжное поручение","Другое"),
number, date (ГГГГ-ММ-ДД), counterparty_name, inn, kpp, direction ("Доходный" если платят нам, "Расходный" если платим мы),
amount (итог с НДС, число), vat_amount (число или null), vat_rate ("Без НДС","5%","7%","20%","22%" или null),
contract_number, contract_date (ГГГГ-ММ-ДД), subject (до 200 символов).
Если значения нет в тексте — null. Ничего не придумывай.`;

async function ai(env, req) {
  if (!env.AI_KEY || !env.AI_BASE_URL) return json(env, { error: 'ИИ не подключён' }, 501);
  const { text } = await req.json();
  if (!text || typeof text !== 'string') return json(env, { error: 'нет текста' }, 400);
  // экономия: первые и последние страницы, где реквизиты, итоги и подписи
  const t = text.length > 12000 ? text.slice(0, 8000) + '\n…\n' + text.slice(-4000) : text;
  const r = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.AI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.AI_MODEL, temperature: 0, max_tokens: 600,
      messages: [{ role: 'system', content: AI_PROMPT }, { role: 'user', content: t }],
    }),
  });
  if (!r.ok) return json(env, { error: `модель: ${r.status}` }, 502);
  const d = await r.json();
  const content = d?.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  try { return json(env, { fields: JSON.parse(m ? m[0] : content), usage: d.usage || null }); }
  catch { return json(env, { error: 'модель вернула не JSON' }, 502); }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (req.method !== 'POST') return json(env, { error: 'POST only' }, 405);
    const user = await portalUser(env, req);
    if (!user) return json(env, { error: 'нет доступа: откройте приложение из портала' }, 401);
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/upload') return await upload(env, req);
      if (pathname === '/ai') return await ai(env, req);
      return json(env, { error: 'не найдено' }, 404);
    } catch (e) {
      return json(env, { error: String(e.message || e) }, 500);
    }
  },
};
