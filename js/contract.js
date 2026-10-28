// Извлечение полей договора правилами + проверка реквизитов. Работает и в браузере, и в Node (тесты).
// Номер, даты, ИНН/КПП/ОГРН, сумма и НДС берутся только регулярками и проверяются контрольными суммами.

const L = '[\\p{L}\\p{N}_]';          // «буква слова» с кириллицей (\w в JS кириллицу не видит)
const RX = (s, f = 'iu') => new RegExp(s, f);

const MONTHS = { января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12 };
const MON = Object.keys(MONTHS).join('|');
const QO = '«"“„', QC = '»"”“';
const DATE_ANY = `(?:[«"]?\\s*\\d{1,2}\\s*[»"]?\\s+(?:${MON})\\s+\\d{4}|\\d{1,2}\\.\\d{1,2}\\.\\d{4})`;

const ORG_FORMS = [
  ['публичное\\s+акционерное\\s+общество', 'ПАО'],
  ['непубличное\\s+акционерное\\s+общество', 'АО'],
  ['закрытое\\s+акционерное\\s+общество', 'ЗАО'],
  ['открытое\\s+акционерное\\s+общество', 'ОАО'],
  ['акционерное\\s+общество', 'АО'],
  ['общество\\s+с\\s+ограниченной\\s+ответственностью', 'ООО'],
  ['федеральное\\s+государственное\\s+бюджетное\\s+образовательное\\s+учреждение\\s+высшего\\s+образования', 'ФГБОУ ВО'],
  ['федеральное\\s+государственное\\s+бюджетное\\s+учреждение', 'ФГБУ'],
  ['федеральное\\s+государственное\\s+унитарное\\s+предприятие', 'ФГУП'],
  ['государственное\\s+бюджетное\\s+учреждение', 'ГБУ'],
  ['государственное\\s+автономное\\s+учреждение', 'ГАУ'],
  ['государственное\\s+унитарное\\s+предприятие', 'ГУП'],
  ['муниципальное\\s+унитарное\\s+предприятие', 'МУП'],
  ['муниципальное\\s+бюджетное\\s+учреждение', 'МБУ'],
  ['автономная\\s+некоммерческая\\s+организация', 'АНО'],
];
const SHORT = '(?:ПАО|НАО|ЗАО|ОАО|АО|ООО|ФГБОУ\\s+ВО|ФГБОУ|ФГБУ|ФГУП|ГБУ|ГАУ|ГУП|МУП|МБУ|АНО)';
const LONG = ORG_FORMS.map(f => f[0]).join('|');
const ORG_SRC = `(${LONG}|(?<!\\p{L})${SHORT})\\s*[${QO}]\\s*([^${QC}]{2,120}?)\\s*[${QC}]`;
const IP_SRC = '([Ии]ндивидуальный\\s+предприниматель|(?<!\\p{L})ИП)\\s+(\\p{Lu}[\\p{Ll}\\-]+(?:\\s+\\p{Lu}[\\p{Ll}\\-]+){1,2}|\\p{Lu}[\\p{Ll}\\-]+\\s+\\p{Lu}\\.\\s*\\p{Lu}\\.)';
const ALIAS_SRC = `именуем${L}*\\s+(?:в\\s+дальнейшем\\s+)?[${QO}]\\s*([^${QC}]{3,40})\\s*[${QC}]`;
const INN_SRC = 'ИНН(?:\\s*\\/\\s*КПП)?\\s*[:№]?\\s*(\\d{12}|\\d{10})(?:\\s*\\/\\s*(\\d{9}))?';
const KPP_SRC = 'КПП\\s*[:№]?\\s*(\\d{4}[\\dA-Z]{2}\\d{3})';
const OGRN_SRC = 'ОГРН(?:ИП)?\\s*[:№]?\\s*(\\d{15}|\\d{13})';

const TYPES = [
  [`оказ${L}*\\s+(?:${L}+\\s+){0,3}услуг|услуг${L}*\\s+по`, 'Оказание услуг'],
  ['поставк|поставщик', 'Поставка'],
  [`подряд|выполн${L}*\\s+(?:${L}+\\s+){0,3}работ`, 'Подряд'],
  ['аренд', 'Аренда'],
  [`лицензи|неисключительн${L}+\\s+прав|сублицензи`, 'Лицензионный'],
  ['купли[\\s\\-]*продаж', 'Купля-продажа'],
  ['агентск', 'Агентский'],
  ['займ|кредит', 'Заём'],
];

// ---------- проверки ----------
export function innOk(inn) {
  if (!inn || !/^\d+$/.test(inn)) return false;
  const d = [...inn].map(Number);
  const sum = (k) => k.reduce((s, v, i) => s + v * d[i], 0) % 11 % 10;
  if (d.length === 10) return d[9] === sum([2, 4, 10, 3, 5, 9, 4, 6, 8]);
  if (d.length === 12) return d[10] === sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) && d[11] === sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return false;
}
export function ogrnOk(o) {
  if (!o || !/^\d+$/.test(o)) return false;
  if (o.length === 13) return Number(o[12]) === Number(BigInt(o.slice(0, 12)) % 11n % 10n);
  if (o.length === 15) return Number(o[14]) === Number(BigInt(o.slice(0, 14)) % 13n % 10n);
  return false;
}
export const kppOk = (k) => !!k && /^\d{4}[\dA-Z]{2}\d{3}$/.test(k);

// даты храним строкой ГГГГ-ММ-ДД, чтобы не зависеть от часового пояса
const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
export const ru = (isoDate) => isoDate ? isoDate.split('-').reverse().join('.') : '';

export function dateSane(isoDate, today = new Date()) {
  if (!isoDate) return false;
  const max = new Date(today.getTime() + 366 * 864e5).toISOString().slice(0, 10);
  return isoDate >= '1995-01-01' && isoDate <= max;
}

export function check(f, ourInns) {
  const errors = [], warns = [];
  if (!f.number) errors.push('не найден номер договора');
  if (!dateSane(f.date)) errors.push('не найдена или неправдоподобна дата договора');
  if (!f.counterparty) errors.push('не найден контрагент');
  if (!f.inn) errors.push('не найден ИНН контрагента');
  else if (!innOk(f.inn)) errors.push(`ИНН ${f.inn} не проходит контрольную сумму`);
  else if (ourInns.includes(f.inn)) errors.push('ИНН контрагента совпал с нашим: стороны перепутаны');
  if (f.inn && f.inn.length === 10 && !f.kpp) warns.push('у юрлица не найден КПП');
  if (f.kpp && !kppOk(f.kpp)) warns.push(`КПП ${f.kpp} выглядит некорректно`);
  if (f.ogrn && !ogrnOk(f.ogrn)) warns.push(`ОГРН ${f.ogrn} не проходит контрольную сумму`);
  if (f.inn && f.ogrn && f.inn.length === 10 && f.ogrn.slice(3, 5) !== f.inn.slice(0, 2)) warns.push('регион в ОГРН и ИНН не совпадает, проверьте реквизиты');
  if (f.end_date && f.date && f.end_date < f.date) errors.push('дата окончания раньше даты договора');
  if (!f.amount) warns.push('сумма не найдена (рамочный договор?)');
  if (!f.vat) warns.push('ставка НДС не определена');
  if (!f.subject) warns.push('не найден предмет договора');
  if (!f.end_date) warns.push('срок действия не найден или «до полного исполнения обязательств»');
  return { errors, warns };
}

// ---------- утилиты ----------
const flat = (s) => s.replace(/ /g, ' ').replace(/‑/g, '-').replace(/-\n(?=[а-яё])/g, '').replace(/[ \t]*\n[ \t]*/g, ' ').trim();
const spaces = (s) => s.replace(/\s+/g, ' ').trim();

export function parseDate(s) {
  let m = s.match(RX(`[«"]?\\s*(\\d{1,2})\\s*[»"]?\\s+(${MON})\\s+(\\d{4})`));
  if (m) { const v = iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]); if (v) return v; }
  m = s.match(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/);
  if (m) { const v = iso(+m[3], +m[2], +m[1]); if (v) return v; }
  return null;
}

function normOrg(form, name) {
  let f = spaces(form);
  const hit = ORG_FORMS.find(([p]) => RX(`^${p}$`).test(f));
  f = hit ? hit[1] : f.toUpperCase();
  return `${f} «${spaces(name)}»`;
}
const isOurs = (name, ourNames) => ourNames.some(n => name.toLowerCase().includes(n.toLowerCase()));

// ---------- поля ----------
export function findNumber(head) {
  const m = head.match(RX('(?:ДОГОВОР|КОНТРАКТ|СОГЛАШЕНИЕ)[^\\n№]{0,80}?(?:№|N[°º]?\\s|No\\.?\\s?)\\s*([^\\s,;]+)'));
  if (!m) return null;
  const num = m[1].replace(/^[\s.,:;«»"]+|[\s.,:;«»"]+$/g, '');
  return /\d/.test(num) ? num : null;
}
const findDocDate = (head) => parseDate(head.split(RX('именуем'))[0]);

export function findSignatureDates(text) {
  const out = new Set();
  const re = RX(`(?:ПОДПИСАН${L}*|ОТПРАВЛЕН${L}*|УТВЕРЖДЕН${L}*|СОГЛАСОВАН${L}*)[^\\n]{0,220}?(\\d{2})\\.(\\d{2})\\.(\\d{2,4})\\s+\\d{1,2}:\\d{2}`, 'gu');
  for (const m of text.matchAll(re)) {
    let y = +m[3]; if (y < 100) y += 2000;
    const v = iso(y, +m[2], +m[1]); if (v) out.add(v);
  }
  return [...out].sort();
}

export function findParties(pre, ourNames) {
  const parties = [];
  let lastEnd = 0;
  for (const am of pre.matchAll(RX(ALIAS_SRC, 'giu'))) {
    const chunk = pre.slice(lastEnd, am.index);
    const orgs = [...chunk.matchAll(RX(ORG_SRC, 'giu'))];
    let name = null;
    if (orgs.length) { const o = orgs.at(-1); name = normOrg(o[1], o[2]); }
    else {
      const ips = [...chunk.matchAll(RX(IP_SRC, 'gu'))];
      if (ips.length) name = `ИП ${spaces(ips.at(-1)[2])}`;
    }
    if (name) parties.push([name, spaces(am[1])]);
    lastEnd = am.index + am[0].length;
  }
  if (!parties.length) {
    const seen = [];
    for (const o of pre.matchAll(RX(ORG_SRC, 'giu'))) { const n = normOrg(o[1], o[2]); if (!seen.includes(n)) seen.push(n); }
    return seen.slice(0, 2).map(n => [n, null]);
  }
  return parties;
}

export function findRequisites(doc, cpName, ourInns) {
  const notes = [];
  const full = doc.full;
  const innRe = () => RX(INN_SRC, 'gu');
  const allInns = [];
  const bad = new Set();
  for (const m of full.matchAll(innRe())) {
    if (!innOk(m[1])) bad.add(m[1]);
    else if (!ourInns.includes(m[1]) && !allInns.includes(m[1])) allInns.push(m[1]);
  }
  if (bad.size) notes.push(`в тексте есть ИНН с неверной контрольной суммой: ${[...bad].sort().join(', ')}`);

  let inn = null, colHit = null, key = null;
  if (cpName) { const m = cpName.match(/«([^»]+)»/); key = (m ? m[1] : cpName.replace('ИП ', '')).toLowerCase(); }
  if (key) {
    for (const col of doc.columns || []) {
      if (!col.toLowerCase().includes(key)) continue;
      const ins = [...new Set([...col.matchAll(innRe())].map(x => x[1]).filter(x => innOk(x) && !ourInns.includes(x)))];
      if (ins.length === 1) { inn = ins[0]; colHit = col; break; }
    }
  }
  if (!inn && allInns.length === 1) inn = allInns[0];
  if (!inn && key) {
    const pos = full.toLowerCase().lastIndexOf(key);
    if (pos >= 0) {
      const c = [...full.slice(pos, pos + 600).matchAll(innRe())].map(x => x[1]).filter(x => innOk(x) && !ourInns.includes(x));
      if (c.length) { inn = c[0]; notes.push('ИНН определён по близости к названию: проверьте'); }
    }
  }
  if (!inn && allInns.length) { notes.push(`несколько кандидатов ИНН контрагента: ${allInns.join(', ')}`); return { inn: null, kpp: null, ogrn: null, notes }; }

  let kpp = null, ogrn = null;
  if (inn) {
    const src = colHit || full;
    const slash = src.match(new RegExp(inn + '\\s*\\/\\s*(\\d{9})'));
    const kpps = [...(slash ? [slash[1]] : []), ...[...src.matchAll(RX(KPP_SRC, 'gu'))].map(x => x[1])];
    const ogrns = [...src.matchAll(RX(OGRN_SRC, 'gu'))].map(x => x[1]).filter(ogrnOk);
    if (inn.length === 10) {
      const same = kpps.filter(k => k.slice(0, 2) === inn.slice(0, 2) && kppOk(k));
      kpp = same[0] || (colHit && kpps[0]) || null;
      if (!same.length && kpp) notes.push('регион КПП отличается от ИНН (бывает у крупнейших налогоплательщиков)');
      const og = ogrns.filter(o => o.length === 13 && o.slice(3, 5) === inn.slice(0, 2));
      ogrn = og[0] || (colHit && ogrns[0]) || null;
    } else {
      ogrn = ogrns.find(o => o.length === 15) || null;
    }
  }
  return { inn, kpp, ogrn, notes };
}

function money(num, kop) {
  const digits = num.replace(/\D/g, '');
  const value = Number(digits) + (kop ? Number(kop) / 100 : 0);
  const rub = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return [`${rub},${kop || '00'} руб.`, value];
}

function vatOf(s) {
  if (!s) return null;
  if (RX(`без\\s+(?:учета\\s+)?НДС|НДС\\s+не\\s+облага|не\\s+облага${L}*\\s+НДС|не\\s+является\\s+плательщиком\\s+НДС|ст\\.?\\s*145\\s+НК|ст\\.?\\s*346\\.1\\d|упрощенн${L}+\\s+систем`).test(s)) return 'Без НДС';
  const m = s.match(RX(`(?:НДС|налог${L}*\\s+на\\s+добавленную\\s+стоимость)[^.\\d%]{0,40}?(\\d{1,2})\\s*%`)) || s.match(RX('(\\d{1,2})\\s*%\\s*\\)?[^.]{0,15}НДС'));
  return m ? `${+m[1]}%` : null;
}

export function findAmountVat(fl) {
  let amount = null, value = null, sentence = '';
  const m = fl.match(RX('(?:цена|стоимость|сумма)\\s+(?:настоящего\\s+|по\\s+настоящему\\s+)?(?:договора|контракта|услуг|работ)[^.]{0,60}?(?:составляет|составит|равна|\\u2014|-|:)\\s*(\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+)(?:[,.](\\d{2}))?'));
  if (m) {
    [amount, value] = money(m[1], m[2]);
    const endAt = m.index + m[0].length;
    const dot = fl.indexOf('.', endAt + 3);
    sentence = fl.slice(m.index, (dot > 0 ? dot : endAt + 300) + 200);
  }
  const vat = vatOf(sentence) || vatOf(fl);
  if (amount && vat) amount = `${amount} ${vat === 'Без НДС' ? 'без НДС' : 'в т.ч. НДС ' + vat}`;
  if (!amount && RX(`рамочн${L}+|без\\s+фиксированн${L}+\\s+(?:цены|суммы)`).test(fl)) amount = 'Рамочный / без фиксированной суммы';
  return { amount, value, vat };
}

export function findEndDate(fl) {
  const pats = [
    `(?:действует|срок\\s+действия\\s+(?:настоящего\\s+)?договора)[^.]{0,200}?(?:до|по)\\s+(${DATE_ANY})`,
    `срок\\s+(?:оказания\\s+услуг|выполнения\\s+работ|поставки)[^.]{0,200}?(?:до|по)\\s+(${DATE_ANY})`,
    `(?:оказать|выполнить|поставить)[^.]{0,200}?(?:в\\s+срок\\s+)?до\\s+(${DATE_ANY})`,
  ];
  for (const p of pats) { const m = fl.match(RX(p)); if (m) { const d = parseDate(m[1]); if (d) return d; } }
  return null;
}

function sectionClause(text, headSrc, clause, limit) {
  const m = text.match(RX(headSrc));
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const c = rest.match(RX(`(?:^|\\n)\\s*${clause.replace('.', '\\.')}\\.?\\s+([\\s\\S]+?)(?=\\n\\s*\\d+\\.\\d+\\.?\\s|\\n\\s*\\d+\\.?\\s+\\p{Lu}{3,})`));
  const body = c ? c[1] : rest.slice(0, limit);
  return spaces(flat(body)).slice(0, limit) || null;
}
export const findSubject = (t) => sectionClause(t, '(?:^|\\n)\\s*\\d*\\.?\\s*предмет\\s+(?:договора|контракта)', '1.1', 900);

export function findPayment(t) {
  const m = t.match(RX('(?:^|\\n)\\s*(\\d+\\.\\d+)\\.?\\s+(Оплата\\s+(?:производится|осуществляется)|(?:Заказчик|Покупатель|Арендатор|Лицензиат)\\s+(?:оплачивает|производит\\s+оплату|перечисляет))([\\s\\S]+?)(?=\\n\\s*\\d+\\.\\d+\\.?\\s)'));
  return m ? spaces(flat(m[2] + m[3])).slice(0, 700) : null;
}

export function findType(title, subject) {
  const hay = `${title} ${subject || ''}`;
  const hit = TYPES.find(([rx]) => RX(rx).test(hay));
  return hit ? hit[1] : null;
}

// ---------- главная ----------
export function parse(doc, ourNames, ourInns) {
  const text = doc.full;
  const head = text.slice(0, 1500);
  const fl = flat(text);
  const preEnd = fl.match(RX('о\\s+нижеследующем|заключили\\s+настоящий'));
  const preamble = fl.slice(0, preEnd ? preEnd.index + preEnd[0].length : 3000);

  const p = { notes: [] };
  p.number = findNumber(head);
  p.date = findDocDate(flat(head));
  p.signature_dates = findSignatureDates(text);

  const parties = findParties(preamble, ourNames);
  const others = parties.filter(([n]) => !isOurs(n, ourNames));
  const ours = parties.filter(([n]) => isOurs(n, ourNames));
  p.our_party = ours[0]?.[0] || null;
  if (others.length) {
    [p.counterparty, p.role] = others[0];
    if (others.length > 1) p.notes.push('в преамбуле больше двух сторон: ' + others.map(o => o[0]).join('; '));
  } else if (parties.length) p.notes.push('не удалось понять, какая сторона наша: проверьте настройку «Наши юрлица»');

  const r = findRequisites(doc, p.counterparty, ourInns);
  Object.assign(p, { inn: r.inn, kpp: r.kpp, ogrn: r.ogrn });
  p.notes.push(...r.notes);
  Object.assign(p, findAmountVat(fl));
  p.end_date = findEndDate(fl);
  p.subject = findSubject(text);
  p.payment = findPayment(text);
  p.type = findType(head.split('\n')[0] + ' ' + head.slice(0, 300), p.subject);
  if (RX('до\\s+полного\\s+исполнения').test(fl)) p.notes.push('договор действует до полного исполнения обязательств');
  return p;
}
