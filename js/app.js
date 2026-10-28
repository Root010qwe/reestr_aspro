import { DEFAULTS, mergeConfig } from './config.js';
import { Portal, FrameTransport } from './portal.js';
import { normalize, summarize, totals, alerts, filterDocs, money, ru, CLOSING, PAYMENT } from './model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let cfg = structuredClone(DEFAULTS), portal = null, base = '', docs = [], groups = [], alertList = [];
const q = { search: '', project: '', cp: '', type: '', status: '', from: '', to: '', noFile: false };
const sq = { project: '', direction: '' };

// ---------- загрузка ----------
async function waitSdk() {
  for (let i = 0; i < 100 && !window.ACloudMiniApp; i++) await new Promise(r => setTimeout(r, 100));
  if (!window.ACloudMiniApp) throw new Error('не загрузилась библиотека Аспро (JS SDK)');
  return window.ACloudMiniApp;
}

async function connect() {
  // локальная отладка: ?demo=<файл.json> — выгрузка элементов списка в формате API
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) return { load: async () => (await fetch(demo)).json(), label: `демо-данные: ${demo}` };
  if (window.parent === window) throw new Error('Откройте приложение из меню портала Аспро.Cloud: вне портала оно не работает.');
  const App = await waitSdk();
  const frame = await App.initializeFrame();
  base = `${frame.https === false ? 'http' : 'https'}://${frame.domain}`;
  // из пункта меню приложение открывается в узкой панели — уводим на домашнюю страницу (app.homepage), там вся ширина
  try {
    const placement = (await frame.getContext())?.placement?.code;
    if (placement && placement !== 'app.homepage') {
      $('btnFull').hidden = false;
      $('btnFull').addEventListener('click', () => frame.openHomepage({ blank: false }));
      frame.openHomepage({ blank: false });
    }
  } catch { /* без домашней страницы остаёмся в панели */ }
  try {
    const raw = await frame.options.get('config_json');
    if (raw) cfg = mergeConfig(cfg, typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch { /* настройка не задана или не разобрана: остаёмся на значениях по умолчанию */ }
  portal = new Portal(new FrameTransport(frame));
  return { load: () => portal.listItems(cfg.list.id), label: `список «Реестр документов», ${frame.domain}` };
}

let source = null;
async function load() {
  $('btnRefresh').disabled = true;
  try {
    const items = await source.load();
    docs = normalize(items, cfg).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    groups = summarize(docs);
    alertList = alerts(docs, groups, { staleDays: cfg.rules.stale_days, ...(cfg.rules.today ? { today: cfg.rules.today } : {}) });
    $('source').textContent = `${source.label} · ${docs.length} документов · обновлено ${new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`;
    fillFilters();
    renderAll();
    $('boot').hidden = true; $('app').hidden = false;
    const v = location.hash.slice(1);
    if (['summary', 'registry', 'alerts'].includes(v)) show(v);
  } catch (e) {
    $('boot').hidden = false;
    $('boot').innerHTML = `<span class="chip bad">ошибка</span> Не удалось загрузить реестр: ${esc(e.message)}`;
  } finally { $('btnRefresh').disabled = false; }
}

// ---------- фильтры ----------
function options(sel, values, all) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${esc(all)}</option>` + values.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  if (values.some(([v]) => v === cur)) sel.value = cur;
}
function fillFilters() {
  const uniq = (pairs) => [...new Map(pairs).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  const projects = uniq(docs.filter(d => d.project).map(d => [d.project, d.projectName]));
  options($('fProject'), projects, 'Все проекты');
  options($('sProject'), projects, 'Все проекты');
  options($('fCp'), uniq(docs.filter(d => d.cp).map(d => [d.cp, d.cpName || `Контрагент ${d.cp}`])), 'Все контрагенты');
  options($('fType'), Object.values(cfg.list.options.doc_type).map(t => [t, t]), 'Все типы');
  options($('fStatus'), [...Object.values(cfg.list.options.sign_status).map(t => [t, t]), ['—', 'Без статуса']], 'Все статусы');
}

// ---------- свод ----------
function statusChip(s) {
  if (!s) return '<span class="chip grey">—</span>';
  const k = /Подписан/.test(s) ? 'ok' : s === 'Аннулирован' ? 'grey' : 'warn';
  return `<span class="chip ${k}">${esc(s)}</span>`;
}
function balanceCell(g) {
  if (!g.closed && !g.paid) return '<span class="muted">—</span>';
  if (Math.abs(g.balance) < 0.01) return '<span class="chip ok">рассчитались</span>';
  if (g.balance < 0) return `<span class="chip info">аванс ${money(-g.balance)}</span>`;
  if (g.direction === 'Доходный') return `<span class="chip bad">нам должны ${money(g.balance)}</span>`;
  return g.paid === 0 ? `<span class="chip warn">оплат нет: ${money(g.balance)}</span>` : `<span class="chip warn">мы должны ${money(g.balance)}</span>`;
}
function renderSummary() {
  const gs = groups.filter(g => (!sq.project || g.project === sq.project) && (!sq.direction || g.direction === sq.direction));
  const t = totals(gs);
  const unpaidExpense = gs.filter(g => g.direction !== 'Доходный' && g.balance > 0 && g.paid === 0).reduce((s, g) => s + g.balance, 0);
  $('kpis').innerHTML = [
    ['Нам должны', money(t.owedToUs), `закрыто ${money(t.closedIncome)}, получено ${money(t.paidIncome)}`, t.owedToUs > 0 ? 'bad' : ''],
    ['Мы должны подрядчикам', money(t.weOwe), unpaidExpense ? `из них ${money(unpaidExpense)} — нет данных об оплате` : `закрыто ${money(t.closedExpense)}, оплачено ${money(t.paidExpense)}`, t.weOwe > 0 ? 'warn' : ''],
    ['Закрыто подрядчиками', money(t.closedExpense), `оплачено ${money(t.paidExpense)}`, ''],
    ['Требует внимания', String(alertList.filter(a => a.level !== 'info').length), 'долги, документы без файла и оплат', alertList.some(a => a.level === 'bad') ? 'bad' : ''],
  ].map(([l, v, h, k]) => `<div class="kpi ${k}"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="hint">${esc(h)}</div></div>`).join('');

  $('groups').innerHTML = gs.length ? gs.map(g => {
    const pct = g.contractAmount ? Math.min(100, Math.round(g.closed / g.contractAmount * 100)) : null;
    return `<tr class="click" data-cp="${esc(g.cp)}" tabindex="0">
      <td><div>${esc(g.cpName || '—')}</div><div class="small muted">${esc(g.direction || '')} · ${esc(g.projectName)}</div></td>
      <td><div>${esc(g.title)}</div><div class="small muted">${g.docs.length} док.${g.contract && !g.contractAmount ? ' · без фиксированной суммы' : ''}</div></td>
      <td class="num">${g.contractAmount ? money(g.contractAmount) : '<span class="muted">—</span>'}</td>
      <td class="num">${money(g.closed)}${pct !== null ? `<div class="bar" title="закрыто ${pct}% договора"><i style="width:${pct}%"></i></div>` : ''}</td>
      <td class="num">${money(g.paid)}</td>
      <td class="num">${balanceCell(g)}</td>
      <td class="num">${g.left === null ? '<span class="muted">—</span>' : money(g.left)}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">Нет договоров по выбранным условиям</td></tr>';
}

// ---------- реестр ----------
function renderRegistry() {
  const list = filterDocs(docs, q);
  $('cntDocs').textContent = docs.length;
  $('docs').innerHTML = list.length ? list.map(d => `<tr>
      <td class="nowrap">${esc(ru(d.date)) || '<span class="muted">—</span>'}</td>
      <td><div>${esc(d.name)}</div><div class="small muted">${esc(d.projectName)}${d.inn ? ' · ИНН ' + esc(d.inn) : ''}</div></td>
      <td><span class="chip ${d.type === PAYMENT ? 'ok' : CLOSING.has(d.type) ? 'info' : 'grey'}">${esc(d.type)}</span></td>
      <td class="num">${d.amount ? money(d.amount) : '<span class="muted">—</span>'}${d.vatRate ? `<div class="small muted">${esc(d.vatRate)}</div>` : ''}</td>
      <td>${d.type === PAYMENT ? '<span class="muted small">оплата</span>' : statusChip(d.status)}</td>
      <td class="nowrap">${esc(ru(d.signed)) || '<span class="muted">—</span>'}</td>
      <td>${d.link ? `<a href="${esc(d.link)}" target="_blank" rel="noopener">открыть</a>` : (d.type === PAYMENT ? '<span class="muted">—</span>' : '<span class="chip warn">нет</span>')}</td>
      <td><div class="notes" title="${esc(d.notes)}">${esc(d.notes.length > 140 ? d.notes.slice(0, 139) + '…' : d.notes)}</div></td></tr>`).join('')
    : '<tr><td colspan="8" class="empty">Ничего не найдено. Измените фильтры или нажмите «Сбросить».</td></tr>';
  $('docsCount').textContent = `Показано ${list.length} из ${docs.length}`;
  $('docsSum').textContent = list.length ? money(list.filter(d => d.type !== 'Договор').reduce((s, d) => s + d.amount, 0)) : '';
  $('docsSum').title = 'Сумма документов без договоров';
  return list;
}

// ---------- тревоги ----------
function renderAlerts() {
  const label = { bad: 'важно', warn: 'проверить', info: 'к сведению' };
  $('cntAlerts').textContent = alertList.filter(a => a.level !== 'info').length;
  $('alertList').innerHTML = alertList.length ? alertList.map(a => `<div class="alert">
      <span class="chip ${a.level}">${label[a.level]}</span>
      <div><div>${esc(a.text)}</div><div class="who">${esc(a.who)}</div></div></div>`).join('')
    : '<div class="empty">Всё сходится: долгов и пропусков нет.</div>';
}

function renderAll() { renderSummary(); renderRegistry(); renderAlerts(); }

// ---------- вкладки и события ----------
function show(view) {
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  for (const v of ['summary', 'registry', 'alerts']) $(`view-${v}`).hidden = v !== view;
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.view)));

const bind = (id, key, prop = 'value') => $(id).addEventListener(prop === 'checked' ? 'change' : 'input', (e) => { q[key] = e.target[prop]; renderRegistry(); });
bind('fSearch', 'search'); bind('fFrom', 'from'); bind('fTo', 'to'); bind('fNoFile', 'noFile', 'checked');
for (const [id, key] of [['fProject', 'project'], ['fCp', 'cp'], ['fType', 'type'], ['fStatus', 'status']])
  $(id).addEventListener('change', (e) => { q[key] = e.target.value; renderRegistry(); });
$('sProject').addEventListener('change', (e) => { sq.project = e.target.value; renderSummary(); });
$('sDirection').addEventListener('change', (e) => { sq.direction = e.target.value; renderSummary(); });
$('btnReset').addEventListener('click', () => {
  Object.assign(q, { search: '', project: '', cp: '', type: '', status: '', from: '', to: '', noFile: false });
  for (const id of ['fSearch', 'fProject', 'fCp', 'fType', 'fStatus', 'fFrom', 'fTo']) $(id).value = '';
  $('fNoFile').checked = false; renderRegistry();
});
const openGroup = (tr) => { if (!tr) return; q.cp = tr.dataset.cp; $('fCp').value = q.cp; renderRegistry(); show('registry'); };
$('groups').addEventListener('click', (e) => openGroup(e.target.closest('tr[data-cp]')));
$('groups').addEventListener('keydown', (e) => { if (e.key === 'Enter') openGroup(e.target.closest('tr[data-cp]')); });
$('btnRefresh').addEventListener('click', load);
$('btnCsv').addEventListener('click', () => {
  const rows = filterDocs(docs, q);
  const head = ['Дата', 'Документ', 'Тип', 'Номер', 'Контрагент', 'ИНН', 'Проект', 'Направление', 'Сумма', 'НДС', 'Статус', 'Подписан', 'Оплата', 'Файл', 'Замечания'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head, ...rows.map(d => [ru(d.date), d.name, d.type, d.number, d.cpName, d.inn, d.projectName, d.direction, String(d.amount).replace('.', ','),
    d.vatRate, d.status, ru(d.signed), ru(d.paidDate), d.link, d.notes])].map(r => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `реестр_документов_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

connect()
  .then((s) => { source = s; $('lnkList').href = `${base}/_module/customlists/view/list/${cfg.list.id}`; if (!base) $('lnkList').hidden = true; return load(); })
  .catch((e) => { $('boot').innerHTML = `<span class="chip bad">ошибка</span> ${esc(e.message)}`; $('source').textContent = ''; });
