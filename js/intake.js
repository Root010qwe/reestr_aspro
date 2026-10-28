// Приём документа в реестр: разобранные поля -> привязка к контрагенту/договору/проекту -> значения записи списка.
// Без DOM: работает и в браузере, и в Node (тесты).

import { TYPES } from './parse.js';

const SHORT = {
  [TYPES.UPD]: 'УПД', [TYPES.INVOICE]: 'Счёт', [TYPES.ACT]: 'Акт', [TYPES.ACCEPT]: 'Акт сдачи-приёмки', [TYPES.RECON]: 'Акт сверки',
  [TYPES.PAY]: 'П/п', [TYPES.CONTRACT]: 'Договор', [TYPES.SUPP]: 'Доп. соглашение', [TYPES.ANNEX]: 'Приложение', [TYPES.OTHER]: 'Документ',
};
const FILE_SHORT = { [TYPES.UPD]: 'СФ', [TYPES.PAY]: 'ПП', [TYPES.RECON]: 'АктСверки', [TYPES.SUPP]: 'ДС' };

export const ru = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const normNum = (s) => String(s || '').toLowerCase().replace(/[\s№]/g, '').replace(/^0+/, '');

export async function sha256(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const mostCommon = (arr) => {
  const c = new Map(); for (const v of arr.filter(Boolean)) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/**
 * Что уже известно в реестре про этот документ.
 * p — результат parseDocument (+ hash), docs — normalize(...) из model.js.
 */
export function matchDoc(p, docs) {
  const out = { cp: null, cpName: p.counterparty_name || '', project: null, direction: p.direction || null, contract: null, contracts: [], duplicates: [], notes: [] };
  const sameCp = p.inn ? docs.filter(d => d.inn === p.inn) : [];
  if (sameCp.length) {
    out.cp = mostCommon(sameCp.map(d => d.cp));
    out.cpName = mostCommon(sameCp.map(d => d.cpName)) || out.cpName;
    out.project = mostCommon(sameCp.map(d => d.project));
    if (!out.direction) out.direction = mostCommon(sameCp.map(d => d.direction));
  } else if (p.inn) out.notes.push(`контрагента с ИНН ${p.inn} в реестре ещё нет: заведите карточку в CRM и выберите её`);

  out.contracts = docs.filter(d => d.type === TYPES.CONTRACT && (!p.inn || d.inn === p.inn));
  if (p.contract_ref) {
    const hit = out.contracts.find(c => normNum(c.number) === normNum(p.contract_ref.number));
    if (hit) {
      out.contract = hit.id;
      out.project = hit.project || out.project;
      out.direction = out.direction || hit.direction;
    } else out.notes.push(`договор № ${p.contract_ref.number}${p.contract_ref.date ? ' от ' + ru(p.contract_ref.date) : ''} в реестре не найден`);
  } else if (out.contracts.length === 1 && p.doc_type !== TYPES.CONTRACT) {
    out.contract = out.contracts[0].id;
    out.notes.push('договор подставлен как единственный у контрагента: проверьте');
  }

  if (p.hash) out.duplicates.push(...docs.filter(d => d.hash && d.hash === p.hash).map(d => ({ id: d.id, name: d.name, why: 'тот же файл' })));
  if (p.number) {
    for (const d of docs) {
      if (out.duplicates.some(x => x.id === d.id)) continue;
      if (d.type === p.doc_type && normNum(d.number) === normNum(p.number) && (!p.inn || d.inn === p.inn))
        out.duplicates.push({ id: d.id, name: d.name, why: 'тот же тип, номер и контрагент' });
    }
  }
  return out;
}

export function title(f) {
  return `${SHORT[f.doc_type] || 'Документ'} № ${f.number || 'б/н'}${f.date ? ' от ' + ru(f.date) : ''}${f.cpName ? ', ' + f.cpName : ''}`;
}

// папка и имя в Nextcloud по правилу из схемы: <Проект>/<Контрагент ИНН>/<Год>/<ГГГГ-ММ-ДД>_<Тип>_<Номер>_<Сумма>.<ext>
const clean = (s) => String(s || '').replace(/[«»"]/g, '').replace(/[\\/:*?<>|]+/g, '-').replace(/\s+/g, ' ').trim();
export function storage(f, projectName, ext = 'pdf') {
  const cp = clean((f.cpName || 'Без контрагента').replace(/^(ООО|АО|ПАО|ЗАО|ИП)\s+/, ''));
  const dir = [clean(projectName || 'Без проекта'), `${cp}${f.inn ? ' ' + f.inn : ''}`, (f.date || '').slice(0, 4) || 'Без даты'].join('/');
  const amount = f.amount ? String(Math.round(f.amount * 100) / 100).replace('.', ',') : '';
  const name = [f.date || 'без-даты', FILE_SHORT[f.doc_type] || clean(SHORT[f.doc_type] || 'Документ'), clean(f.number || 'бн'), amount].filter(Boolean).join('_');
  return { dir, name: `${name}.${ext}` };
}

const optId = (options, label) => {
  if (!label) return undefined;
  const e = Object.entries(options).find(([, t]) => t === label);
  return e ? e[0] : undefined;
};
const money2 = (v) => (v || v === 0 ? Number(v).toFixed(2) : undefined);

/** Значения полей записи для customlists/items/create. f — поля из карточки подтверждения. */
export function itemValues(f, cfg, userId) {
  const F = cfg.list.fields, O = cfg.list.options;
  const v = {
    [F.name]: title(f),
    [F.doc_type]: optId(O.doc_type, f.doc_type),
    [F.direction]: optId(O.direction, f.direction),
    [F.number]: f.number || undefined,
    [F.date]: f.date || undefined,
    [F.counterparty]: f.cp || undefined,
    [F.inn]: f.inn || undefined,
    [F.kpp]: f.kpp || undefined,
    [F.project]: f.project || undefined,
    [F.contract]: f.contract || undefined,
    [F.subject]: f.subject || undefined,
    [F.amount]: money2(f.amount),
    [F.vat_amount]: money2(f.vat_amount),
    [F.vat_rate]: optId(O.vat_rate, f.vat_rate),
    [F.sign_status]: f.doc_type === TYPES.PAY ? undefined : optId(O.sign_status, f.sign_status),
    [F.signed_date]: f.signed_date || undefined,
    [F.file_link]: f.link || undefined,
    [F.file_hash]: f.hash || undefined,
    [F.notes]: f.notes || undefined,
    [F.responsible]: userId || undefined,
  };
  if (f.doc_type === TYPES.PAY) { v[F.paid_date] = f.date || undefined; v[F.paid_amount] = money2(f.amount); }
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => k && k !== 'undefined' && x !== undefined && x !== ''));
}
