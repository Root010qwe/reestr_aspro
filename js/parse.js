// Разбор документа для реестра правилами: тип, номер, дата, контрагент, суммы, НДС, подписи ЭДО, ссылка на договор.
// На входе текст из extract.js (pdf.js) или ocr.js; работает и в браузере, и в Node (тесты).
// Договоры дочитывает contract.js из doc_aspro (стороны, роль, сумма договора).

import { parse as parseContract, parseDate, innOk } from './contract.js';

export const TYPES = {
  UPD: 'Счёт-фактура / УПД', INVOICE: 'Счёт', ACT: 'Акт выполненных работ', ACCEPT: 'Акт сдачи-приёмки',
  RECON: 'Акт сверки', PAY: 'Платёжное поручение', CONTRACT: 'Договор', SUPP: 'Доп. соглашение',
  ANNEX: 'Приложение / спецификация', OTHER: 'Другое',
};

const RX = (s, f = 'iu') => new RegExp(s, f);
const spaces = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// тип — по шапке документа (первые строки), иначе по имени файла
const TYPE_RULES = [
  ['универсальный\\s+передаточный|сч[её]т[\\s-]*фактура\\s*№', TYPES.UPD],
  ['акт\\s+сверки', TYPES.RECON],
  ['платежное\\s+поручение|платёжное\\s+поручение', TYPES.PAY],
  ['сч[её]т\\s+(?:на\\s+оплату\\s+)?№|сч[её]т\\s+на\\s+оплату', TYPES.INVOICE],
  ['акт\\s+сдачи[\\s-]*при[её]мки', TYPES.ACCEPT],
  ['акт\\s+(?:№|выполненных|об\\s+оказании|оказанных|о\\s+выполнении)', TYPES.ACT],
  ['сч[её]т[\\s-]*оферт', TYPES.CONTRACT],
  ['дополнительное\\s+соглашение|^\\s*соглашение\\s*№', TYPES.SUPP],
  ['^\\s*(?:приложение|спецификация|задание|запрос)\\s*№', TYPES.ANNEX],
  ['договор|контракт', TYPES.CONTRACT],
];

export function detectType(text, fileName = '') {
  const head = text.slice(0, 700);
  for (const [rx, t] of TYPE_RULES) if (RX(rx, 'imu').test(head)) return t;
  const fn = fileName.replace(/[_.]/g, ' ');
  for (const [rx, t] of TYPE_RULES) if (RX(rx.replace('^\\s*', ''), 'iu').test(fn)) return t;
  return TYPES.OTHER;
}

// «1 212 190.48» / «536 000,00» -> 1212190.48
export function money(s) {
  if (s == null) return null;
  const m = String(s).replace(/[  ]/g, ' ').match(/\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/);
  return m ? Math.round(Number(m[0].replace(/ /g, '').replace(',', '.')) * 100) / 100 : null;
}
const MONEY_SRC = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:[.,]\\d{2})|\\d+[.,]\\d{2})';

function vatRateFrom(amount, vat) {
  if (!amount) return null;
  if (!vat) return 'Без НДС';
  const r = vat / (amount - vat) * 100;
  return [5, 7, 10, 20, 22].find(x => Math.abs(r - x) < 0.3) ? `${[5, 7, 10, 20, 22].find(x => Math.abs(r - x) < 0.3)}%` : null;
}

// штампы ЭДО: «ОТПРАВЛЕНО ООО "Х", ФИО, 31.07.26 15:35 (MSK)». В тексте pdf.js штамп перемешан с полями формы,
// поэтому отметки и время ищем отдельно и сопоставляем по порядку.
export function edoStamps(text) {
  const marks = [...text.matchAll(/(ОТПРАВЛЕНО|УТВЕРЖДЕНО|ПОДПИСАНО|СОГЛАСОВАНО)\s+(?:\([^)]{0,20}\)\s*)?((?:ООО|АО|ПАО|ЗАО|ИП|НАО|ФГБОУ ВО|ФГБОУ|ГАУ|ГБУ)\s*"[^"]+")/gu)];
  const times = [...text.matchAll(/(\d{2})\.(\d{2})\.(\d{2,4})\s+\d{1,2}:\d{2}(?=\s*(?:\(MSK\)|Сертификат))/g)];
  return marks.map((m, i) => {
    const t = times[i];
    let date = null;
    if (t) { let y = +t[3]; if (y < 100) y += 2000; date = `${y}-${t[2]}-${t[1]}`; }
    return { action: m[1], org: m[2].replace(/\s+/g, ' '), date };
  });
}

function signature(text, ourName) {
  const st = edoStamps(text);
  const dates = st.map(s => s.date).filter(Boolean).sort();
  const orgs = new Set(st.map(s => s.org.toUpperCase()));
  if (orgs.size >= 2 && dates.length >= 2) return { signed_date: dates.at(-1), sign_status: 'Подписан (ЭДО)', stamps: st };
  if (st.length === 1) {
    const ours = ourName && st[0].org.toUpperCase().includes(ourName.toUpperCase());
    // отправили мы — ждём контрагента; отправил контрагент — на нашей проверке
    return { signed_date: null, sign_status: ours ? 'Ожидает подписи контрагента' : 'На проверке', stamps: st };
  }
  return { signed_date: null, sign_status: null, stamps: st };
}

// ссылка на договор: «Договор № 3-25 от 01.07.2025», «по договору 1103/26 от 14.04.2026», «к Договору № …»
export function contractRef(text) {
  const m = text.match(RX('(?:договор[ауе]?|контракт[ау]?)\\s*(?:№|N)?\\s*([\\p{L}\\p{N}][\\p{L}\\p{N}/\\-.]*?)\\s+от\\s+(\\d{2}\\.\\d{2}\\.\\d{4}|[«"]?\\d{1,2}[»"]?\\s+\\p{L}+\\s+\\d{4})'));
  return m ? { number: m[1].replace(/[.,]$/, ''), date: parseDate(m[2]) } : null;
}

// организация перед позицией: последняя «ООО "Х"» / «Общество … "Х"» в окне
function orgBefore(text, pos, win = 260) {
  const chunk = text.slice(Math.max(0, pos - win), pos);
  const all = [...chunk.matchAll(/((?:Общество с ограниченной ответственностью|Акционерное общество|Публичное акционерное общество|ООО|АО|ПАО|ЗАО|НАО|ИП|ФГБОУ ВО|ФГБОУ)\s*["«]([^"»]{2,80})["»])/giu)];
  if (!all.length) return null;
  const a = all.at(-1);
  const form = /^общество/i.test(a[1]) ? 'ООО' : /^публичное/i.test(a[1]) ? 'ПАО' : /^акционерное/i.test(a[1]) ? 'АО' : a[1].match(/^\S+(?:\s+ВО)?/)[0].toUpperCase();
  return `${form} «${spaces(a[2])}»`;
}

function innsIn(text, ourInns) {
  const out = [];
  for (const m of text.matchAll(/ИНН(?:\s*\/\s*КПП)?(?:\s+(?:продавца|покупателя|получателя|плательщика))?\s*[:№]?\s*(\d{12}|\d{10})(?:\s*\/\s*(\d{9}))?/gu)) {
    if (innOk(m[1]) && !ourInns.includes(m[1]) && !out.some(x => x.inn === m[1])) out.push({ inn: m[1], kpp: m[2] || null, pos: m.index });
  }
  return out;
}

function parseUpd(text, ourInns) {
  const r = {};
  const head = text.match(RX('сч[её]т[\\s-]*фактура\\s*№\\s*(\\S+)\\s+от\\s+([«"]?\\d{1,2}[»"]?\\s+\\p{L}+\\s+\\d{4}|\\d{2}\\.\\d{2}\\.\\d{4})'));
  if (head) { r.number = head[1]; r.date = parseDate(head[2]); }
  const seller = text.match(/ИНН\/КПП\s+продавца\s+(\d{10,12})\s*\/?\s*(\d{9})?/u);
  const buyer = text.match(/ИНН\/КПП\s+покупателя\s+(\d{10,12})\s*\/?\s*(\d{9})?/u);
  const sellerName = text.match(/Продавец\s+(.+?)\s+\(2\)/u)?.[1];
  const buyerName = text.match(/Покупатель\s+(.+?)\s+\(6\)/u)?.[1];
  const weSell = seller && ourInns.includes(seller[1]);
  const cp = weSell ? buyer : seller;
  r.direction = seller || buyer ? (weSell ? 'Доходный' : 'Расходный') : null;
  if (cp) { r.inn = cp[1]; r.kpp = cp[2] || null; }
  const cpRaw = weSell ? buyerName : sellerName;
  if (cpRaw) r.counterparty_name = orgBefore(cpRaw + ' ', cpRaw.length + 1, 400) || spaces(cpRaw);
  // предмет: строки таблицы между нумерацией граф («А 1 1а …») и «Всего к оплате», без кодов и цифр
  const rows = text.match(/\n\s*А\s+1\s+1а[^\n]*\n([\s\S]*?)\n\s*Всего\s+к\s+оплате/u);
  if (rows) {
    const MONEY_RE = /\d[\d ]*[.,]\d{2}(?!\d)/;
    const parts = [];
    for (const line of rows[1].split('\n')) {
      if (MONEY_RE.test(line)) {
        // строка с графами: «БС-00000097 1 Работы по … - - усл. 1 1 212 190.48 …» -> описание до первых граф
        const d = line.replace(/^\s*(?:\S*\d\S*\s+)?\d+\s+/, '').split(/\s+(?:-\s+-|\d{3}\s+шт|усл\.|шт\.?\s|\d+\s+\d[\d ]*[.,]\d{2})/u)[0];
        parts.push(d);
      } else parts.push(line);
    }
    const s = spaces(parts.join(' ')).replace(/^[-–—\s]+/, '');
    if (s.length > 5) r.subject = s.slice(0, 250);
  }
  // «Всего к оплате 1 212 190.48 Х 60 609.52 1 272 800.00» или «… Х без НДС 145 000.00»
  const tot = text.match(RX(`Всего\\s+к\\s+оплате[^\\n]*`));
  if (tot) {
    const nums = [...tot[0].matchAll(RX(MONEY_SRC, 'gu'))].map(x => money(x[1]));
    if (nums.length) r.amount = nums.at(-1);
    r.vat_amount = /без\s+НДС/i.test(tot[0]) ? null : (nums.length >= 3 ? nums.at(-2) : null);
  }
  return r;
}

function parseRecon(text, ourInns) {
  const r = {};
  const m = text.match(/акт\s+сверки[\s\S]{0,200}?(?:№\s*(\S+))?/iu);
  if (m && m[1]) r.number = m[1];
  // дата акта — на конец периода («на 31.12.2026») не всегда; берём первую дату вида дд.мм.гггг после «по состоянию»/«за период»
  const per = text.match(/(?:по\s+состоянию\s+на|на)\s+(\d{2}\.\d{2}\.\d{4})/iu);
  if (per) r.date = parseDate(per[1]);
  return r;
}

function parseGenericAmount(text) {
  const r = {};
  const total = text.match(RX(`(?:Итого\\s+к\\s+оплате|Всего\\s+к\\s+оплате|Всего\\s+оказано\\s+услуг[^\\n]{0,40}на\\s+сумму|Итого\\s+с\\s+НДС|Итого)[:\\s]*${MONEY_SRC}`));
  if (total) r.amount = money(total[1]);
  const vat = text.match(RX(`(?:в\\s+том\\s+числе\\s+)?НДС[^\\n\\d]{0,25}${MONEY_SRC}`));
  if (/без\s+(?:налога\s+)?\(?НДС|НДС\s+не\s+облагается/iu.test(text)) r.vat_amount = null;
  else if (vat) r.vat_amount = money(vat[1]);
  const sumPay = text.match(RX(`Сумма\\s*(?:прописью)?[^\\n]*?${MONEY_SRC}`));
  if (!r.amount && sumPay) r.amount = money(sumPay[1]);
  return r;
}

function headNumberDate(text) {
  // сначала заголовок (первые 3 строки): ниже по тексту «доверенность № 183 от …» и т.п.
  const title = text.split('\n').slice(0, 3).join(' ');
  const t = title.match(RX('(?:№|N)\\s*([\\p{L}\\p{N}][\\p{L}\\p{N}/\\-.]*)(?:\\s+от\\s+([«"]?\\d{1,2}[»"]?\\s+\\p{L}+\\s+\\d{4}|\\d{2}\\.\\d{2}\\.\\d{4}))?'));
  if (t && /\d/.test(t[1])) return { number: t[1].replace(/[.,]$/, ''), date: t[2] ? parseDate(t[2]) : parseDate(text.slice(0, 600)) };
  const head = text.slice(0, 600);
  const m = head.match(RX('(?:№|N)\\s*([\\p{L}\\p{N}][\\p{L}\\p{N}/\\-.]*)\\s+от\\s+([«"]?\\d{1,2}[»"]?\\s+\\p{L}+\\s+\\d{4}|\\d{2}\\.\\d{2}\\.\\d{4})'));
  if (m) return { number: m[1].replace(/[.,]$/, ''), date: parseDate(m[2]) };
  const n = head.match(RX('(?:№|N)\\s*([\\p{L}\\p{N}][\\p{L}\\p{N}/\\-.]*)'));
  return { number: n ? n[1] : null, date: parseDate(head) };
}

const BUYER_ROLES = /^(?:заказчик|покупател|лицензиат|сублицензиат|арендатор|принципал)/i;
const SUPPLIER_ROLES = /^(?:исполнител|подрядчик|поставщик|лицензиар|продав|арендодател|агент)/i;

// наша роль в преамбуле: «… «Нью Бренд», именуемое далее Заказчик» -> мы платим -> расходный
function directionByRole(text, ourNames) {
  const pre = text.slice(0, 4000).replace(/\s+/g, ' ');
  const roleRe = /именуем\S*\s+(?:в\s+дальнейшем\s+|далее\s+)?[«"]?\s*([А-ЯЁа-яё]+)/gu;
  for (const m of pre.matchAll(roleRe)) {
    const before = pre.slice(Math.max(0, m.index - 300), m.index).toLowerCase();
    const lastOur = Math.max(...ourNames.map(n => before.lastIndexOf(n.toLowerCase())));
    if (lastOur < 0) continue;
    // между нашим названием и «именуемое» не должно быть другой организации
    if (/(?:общество|ооо|ао|пао|ип)\s*[«"]/i.test(before.slice(lastOur + 10))) continue;
    if (BUYER_ROLES.test(m[1])) return 'Расходный';
    if (SUPPLIER_ROLES.test(m[1])) return 'Доходный';
  }
  // иначе по роли контрагента
  for (const m of pre.matchAll(roleRe)) {
    if (BUYER_ROLES.test(m[1])) return 'Доходный';
    if (SUPPLIER_ROLES.test(m[1])) return 'Расходный';
  }
  return null;
}

/**
 * Главная: текст документа -> поля реестра.
 * doc — { full, columns } из extract.js/ocr.js; opts — { ourInns: ['1686032615'], ourNames: ['Нью Бренд'], fileName }.
 * Возвращает поля и список того, что не нашлось (missing), чтобы карточка подсветила их для ручного ввода.
 */
export function parseDocument(doc, { ourInns = [], ourNames = [], fileName = '' } = {}) {
  const text = doc.full || '';
  const type = detectType(text, fileName);
  let r = { doc_type: type };

  if (type === TYPES.UPD) Object.assign(r, parseUpd(text, ourInns));
  else if (type === TYPES.CONTRACT || type === TYPES.SUPP) {
    const c = parseContract(doc, ourNames, ourInns);
    const hd = headNumberDate(text);
    Object.assign(r, { number: c.number || hd.number, date: c.date || hd.date, inn: c.inn, kpp: c.kpp, counterparty_name: c.counterparty, subject: c.subject });
    if (c.value >= 100) r.amount = c.value;          // «4,00 руб.» и подобное — номер пункта, а не цена
    else { const g = parseGenericAmount(text); if (g.amount) Object.assign(r, g); }
    r.direction = directionByRole(text, ourNames);
    if (c.vat) r.vat_rate = c.vat;
    if (r.amount && c.vat && /%/.test(c.vat)) { const k = parseFloat(c.vat); r.vat_amount = Math.round(r.amount * k / (100 + k) * 100) / 100; }
  } else {
    if (type === TYPES.RECON) Object.assign(r, parseRecon(text, ourInns));
    else Object.assign(r, headNumberDate(text));
    if ([TYPES.INVOICE, TYPES.ACT, TYPES.ACCEPT, TYPES.PAY].includes(type)) Object.assign(r, parseGenericAmount(text));
  }

  if (!r.inn) {
    const c = innsIn(text, ourInns);
    if (c.length === 1) { r.inn = c[0].inn; r.kpp = r.kpp || c[0].kpp; }
    else if (c.length > 1) r.inn_candidates = c.map(x => x.inn);
  }
  if (r.inn && !r.counterparty_name) {
    const pos = text.indexOf(r.inn);
    r.counterparty_name = orgBefore(text, pos);
  }
  if (r.amount && r.vat_rate === undefined) r.vat_rate = vatRateFrom(r.amount, r.vat_amount);
  if (type !== TYPES.CONTRACT) r.contract_ref = contractRef(text);

  Object.assign(r, signature(text, ourNames[0]));
  if (!r.sign_status && doc.ocr) r.sign_status = 'Подписан (оригинал)';

  const need = ['number', 'date', 'inn'];
  if ([TYPES.UPD, TYPES.INVOICE, TYPES.ACT, TYPES.ACCEPT, TYPES.PAY].includes(type)) need.push('amount');
  r.missing = need.filter(k => !r[k]);
  return r;
}
