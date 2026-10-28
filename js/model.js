// Реестр: записи списка -> документы -> свод по договорам и тревоги. Без DOM, работает и в Node (тесты).

export const CLOSING = new Set(['Счёт-фактура / УПД', 'Акт выполненных работ', 'Акт сдачи-приёмки']);
export const PAYMENT = 'Платёжное поручение';
export const CONTRACT = 'Договор';

const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const isoDate = (v) => {
  if (!v) return null;
  const s = String(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
};
const idOf = (v) => {
  if (v === null || v === undefined || v === '' || v === '0' || v === 0) return null;
  if (typeof v === 'object') return idOf(v.id ?? v.value ?? null);
  return String(v);
};
// «УПД № 38 от 31.05.2026, ООО «АйДеникс»» -> «ООО «АйДеникс»»
const cpFromName = (name) => { const i = String(name || '').indexOf(', '); return i > 0 ? name.slice(i + 2) : ''; };

export function normalize(items, cfg) {
  const f = cfg.list.fields, o = cfg.list.options;
  return items.map((it) => {
    const opt = (key) => o[key][idOf(it[f[key]])] || null;
    return {
      id: String(it.id),
      name: it[f.name] || '',
      type: opt('doc_type') || 'Другое',
      number: it[f.number] || '',
      date: isoDate(it[f.date]),
      subject: it[f.subject] || '',
      amount: num(it[f.amount]),
      vatAmount: num(it[f.vat_amount]),
      vatRate: opt('vat_rate'),
      status: opt('sign_status'),
      signed: isoDate(it[f.signed_date]),
      paidDate: isoDate(it[f.paid_date]),
      paidAmount: num(it[f.paid_amount]),
      link: it[f.file_link] || '',
      hash: it[f.file_hash] || '',
      notes: it[f.notes] || '',
      direction: opt('direction'),
      project: idOf(it[f.project]),
      projectName: cfg.projects[idOf(it[f.project])] || (idOf(it[f.project]) ? `Проект ${idOf(it[f.project])}` : 'Без проекта'),
      cp: idOf(it[f.counterparty]),
      cpName: cpFromName(it[f.name]),
      inn: it[f.inn] || '',
      contract: idOf(it[f.contract]),
    };
  });
}

/**
 * Свод: по каждому договору (или по контрагенту, если договора в реестре нет).
 * closed  — УПД и акты, paid — платёжки, invoiced — счета.
 * balance = closed - paid: у доходных > 0 значит «нам должны», у расходных > 0 — «мы должны».
 */
export function summarize(docs) {
  const byId = new Map(docs.map(d => [d.id, d]));
  const groups = new Map();
  const groupOf = (d) => {
    if (d.type === CONTRACT) return `c:${d.id}`;
    if (d.contract && byId.has(d.contract)) return `c:${d.contract}`;
    return `p:${d.cp || '—'}:${d.project || '—'}`;
  };
  for (const d of docs) {
    const key = groupOf(d);
    if (!groups.has(key)) groups.set(key, { key, contract: null, docs: [], cp: d.cp, cpName: d.cpName, project: d.project, projectName: d.projectName, direction: d.direction });
    const g = groups.get(key);
    g.docs.push(d);
    if (d.type === CONTRACT) g.contract = d;
    if (!g.direction && d.direction) g.direction = d.direction;
  }
  const out = [];
  for (const g of groups.values()) {
    const sum = (pred, field = 'amount') => g.docs.filter(pred).reduce((s, d) => s + d[field], 0);
    g.contractAmount = g.contract ? g.contract.amount : 0;
    g.closed = sum(d => CLOSING.has(d.type));
    g.paid = sum(d => d.type === PAYMENT);
    g.invoiced = sum(d => d.type === 'Счёт');
    g.balance = round2(g.closed - g.paid);
    g.left = g.contractAmount ? round2(g.contractAmount - g.closed) : null;
    g.title = g.contract ? `Договор № ${g.contract.number}${g.contract.date ? ' от ' + ru(g.contract.date) : ''}` : 'Без договора в реестре';
    g.lastDate = g.docs.map(d => d.date).filter(Boolean).sort().at(-1) || null;
    out.push(g);
  }
  return out.sort((a, b) => (a.direction === b.direction ? Math.abs(b.closed) - Math.abs(a.closed) : a.direction === 'Доходный' ? -1 : 1));
}

export function totals(groups) {
  const t = { owedToUs: 0, weOwe: 0, closedIncome: 0, paidIncome: 0, closedExpense: 0, paidExpense: 0 };
  for (const g of groups) {
    if (g.direction === 'Доходный') { t.closedIncome += g.closed; t.paidIncome += g.paid; if (g.balance > 0) t.owedToUs += g.balance; }
    else { t.closedExpense += g.closed; t.paidExpense += g.paid; if (g.balance > 0) t.weOwe += g.balance; }
  }
  for (const k of Object.keys(t)) t[k] = round2(t[k]);
  return t;
}

export function alerts(docs, groups, { staleDays = 14, today = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [];
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  for (const g of groups) {
    const who = `${g.cpName} · ${g.title}`;
    if (g.direction === 'Доходный' && g.balance > 0)
      out.push({ level: 'bad', group: g.key, text: `Нам должны ${money(g.balance)}: закрыто ${money(g.closed)}, оплачено ${money(g.paid)}`, who });
    if (g.direction !== 'Доходный' && g.balance > 0 && g.paid > 0)
      out.push({ level: 'warn', group: g.key, text: `Мы должны ${money(g.balance)}: закрыто ${money(g.closed)}, оплачено ${money(g.paid)}`, who });
    if (g.closed > 0 && g.paid === 0)
      out.push({ level: 'warn', group: g.key, text: `Закрыто ${money(g.closed)}, а оплат в реестре нет. Внесите платёжки или акт сверки`, who });
    if (g.balance < 0)
      out.push({ level: 'info', group: g.key, text: `Аванс ${money(-g.balance)}: оплачено больше, чем закрыто`, who });
    if (g.left !== null && g.left < 0)
      out.push({ level: 'bad', group: g.key, text: `Закрыто больше суммы договора на ${money(-g.left)}`, who });
  }
  for (const d of docs) {
    if (d.type !== PAYMENT && !d.link)
      out.push({ level: 'warn', doc: d.id, text: 'Нет файла', who: d.name });
    if ((d.status === 'На проверке' || d.status === 'Ожидает подписи контрагента') && d.date && days(d.date, today) > staleDays)
      out.push({ level: 'info', doc: d.id, text: `${d.status} уже ${days(d.date, today)} дн.`, who: d.name });
  }
  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

export function filterDocs(docs, q) {
  const s = (q.search || '').trim().toLowerCase();
  return docs.filter(d =>
    (!q.project || d.project === q.project) &&
    (!q.cp || d.cp === q.cp) &&
    (!q.type || d.type === q.type) &&
    (!q.status || (q.status === '—' ? !d.status : d.status === q.status)) &&
    (!q.direction || d.direction === q.direction) &&
    (!q.from || (d.date && d.date >= q.from)) &&
    (!q.to || (d.date && d.date <= q.to)) &&
    (!q.noFile || (!d.link && d.type !== PAYMENT)) &&
    (!s || `${d.name} ${d.number} ${d.inn} ${d.subject} ${d.notes}`.toLowerCase().includes(s)));
}

export const round2 = (x) => Math.round(x * 100) / 100;
export const ru = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
export const money = (x) => `${(Math.round(x * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ₽`;
