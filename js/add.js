// Вкладка «Добавить документ»: файл -> текст (pdf.js, при скане OCR) -> правила (parse.js) -> при пробелах ИИ (Worker)
// -> карточка подтверждения -> файл в Nextcloud (Worker) -> запись в списке.

import { parseDocument, TYPES } from './parse.js';
import { matchDoc, itemValues, storage, sha256, title } from './intake.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let pdfjs = null, ocr = null;
async function libs(useOcr) {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  if (useOcr && !ocr) ocr = (await import('./ocr.js')).makeOcr(pdfjs);
  return { pdfjs, ocr };
}

const FIELDS = ['doc_type', 'direction', 'number', 'date', 'cp', 'inn', 'kpp', 'project', 'contract', 'amount', 'vat_amount', 'vat_rate', 'sign_status', 'signed_date', 'subject', 'notes'];

export function initAdd(ctx) {
  // ctx: { cfg(), docs(), portal(), reload() }
  const queue = [];
  let cur = null;

  const fill = (sel, pairs, empty) => { $(sel).innerHTML = (empty ? `<option value="">${esc(empty)}</option>` : '') + pairs.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join(''); };

  function renderQueue() {
    $('addQueue').innerHTML = queue.length ? queue.map((it, i) => `<div class="qrow${it === cur ? ' cur' : ''}" data-i="${i}">
      <span class="chip ${{ done: 'ok', error: 'bad', review: 'warn', skip: 'grey' }[it.state] || 'info'}">${esc({ wait: 'в очереди', work: 'читаю…', review: 'проверить', done: 'в реестре', error: 'ошибка', skip: 'пропущен' }[it.state])}</span>
      <span class="grow">${esc(it.file.name)}</span><span class="small muted">${esc(it.msg || '')}</span></div>`).join('')
      : '<div class="empty">Перетащите сюда PDF или нажмите «Выбрать файлы»</div>';
  }

  async function read(it) {
    const cfg = ctx.cfg();
    const bytes = new Uint8Array(await it.file.arrayBuffer());
    it.hash = await sha256(bytes);
    const { pdfjs } = await libs(false);
    const { extractPdf } = await import('./extract.js');
    let doc = await extractPdf(bytes.slice(), pdfjs);
    if (doc.scan && cfg.intake.ocr) {
      it.msg = 'скан: распознаю текст, 1–2 минуты'; renderQueue();
      const { ocr } = await libs(true);
      doc = await ocr(bytes.slice(), doc, (i, n) => { it.msg = `распознаю страницу ${i} из ${n}`; renderQueue(); });
    }
    it.text = doc.full;
    let p = parseDocument(doc, { ourInns: cfg.company.our_inns, ourNames: cfg.company.our_names, fileName: it.file.name });
    it.source = doc.ocr ? 'OCR + правила' : 'правила';
    // ИИ — только если правила чего-то не нашли и Worker подключён
    if ((p.missing.length || doc.ocr) && cfg.intake.api) {
      try {
        const ai = await callApi(ctx, '/ai', { json: { text: doc.full } });
        if (ai.fields) {
          for (const [k, v] of Object.entries(ai.fields)) if (v !== null && v !== '' && (p[k] === null || p[k] === undefined)) p[k] = v;
          if (ai.fields.contract_number && !p.contract_ref) p.contract_ref = { number: ai.fields.contract_number, date: ai.fields.contract_date || null };
          p.missing = p.missing.filter(k => !p[k]);
          it.source += ' + ИИ';
        }
      } catch { /* ИИ не подключён или недоступен — остаёмся на правилах */ }
    }
    p.hash = it.hash;
    it.parsed = p;
    it.match = matchDoc(p, ctx.docs());
  }

  function showCard(it) {
    cur = it; renderQueue();
    const cfg = ctx.cfg(), docs = ctx.docs(), p = it.parsed, m = it.match, O = cfg.list.options;
    $('addCard').hidden = false;
    $('addTitle').textContent = it.file.name;
    $('addSource').textContent = it.source;
    $('addPreview').href = it.url || (it.url = URL.createObjectURL(it.file));

    fill('a_doc_type', Object.values(O.doc_type).map(t => [t, t]));
    fill('a_direction', Object.values(O.direction).map(t => [t, t]), '—');
    fill('a_vat_rate', Object.values(O.vat_rate).map(t => [t, t]), '—');
    fill('a_sign_status', Object.values(O.sign_status).map(t => [t, t]), '—');
    const cps = [...new Map(docs.filter(d => d.cp).map(d => [d.cp, d.cpName || `Контрагент ${d.cp}`])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
    fill('a_cp', cps, '— нет в реестре —');
    fill('a_project', Object.entries(cfg.projects), '—');
    const contracts = (m.contracts.length ? m.contracts : docs.filter(d => d.type === TYPES.CONTRACT)).map(c => [c.id, c.name]);
    fill('a_contract', contracts, '— без договора —');

    const val = {
      doc_type: p.doc_type, direction: m.direction, number: p.number, date: p.date, cp: m.cp, inn: p.inn, kpp: p.kpp,
      project: m.project, contract: m.contract, amount: p.amount, vat_amount: p.vat_amount, vat_rate: p.vat_rate,
      sign_status: p.sign_status, signed_date: p.signed_date, subject: p.subject || '', notes: '',
    };
    for (const k of FIELDS) {
      const el = $(`a_${k}`); if (!el) continue;
      el.value = val[k] ?? '';
      el.classList.toggle('miss', !el.value && ['number', 'date', 'inn', 'amount', 'cp', 'direction', 'project'].includes(k)
        && !(k === 'amount' && [TYPES.CONTRACT, TYPES.SUPP, TYPES.ANNEX, TYPES.RECON].includes(p.doc_type)));
    }

    const warn = [];
    if (m.duplicates.length) warn.push(...m.duplicates.map(d => `<b>возможный дубль</b> (${esc(d.why)}): ${esc(d.name)}`));
    if (p.inn_candidates) warn.push(`несколько ИНН в тексте: ${esc(p.inn_candidates.join(', '))}`);
    warn.push(...m.notes.map(esc));
    if (p.missing.length) warn.push(`не найдено в документе: ${esc(p.missing.join(', '))} — заполните вручную`);
    if (p.counterparty_name && !m.cp) warn.push(`в документе: ${esc(p.counterparty_name)}`);
    $('addWarn').innerHTML = warn.length ? warn.map(w => `<li>${w}</li>`).join('') : '<li class="ok">всё основное найдено, проверьте и сохраните</li>';
    $('addMsg').textContent = '';
    $('btnAddSave').disabled = false;
    $('a_number').focus();
  }

  function form() {
    const f = {};
    for (const k of FIELDS) { const el = $(`a_${k}`); if (el) f[k] = el.value.trim(); }
    for (const k of ['amount', 'vat_amount']) f[k] = f[k] ? Number(f[k].replace(/\s/g, '').replace(',', '.')) : null;
    f.cpName = f.cp ? $('a_cp').selectedOptions[0]?.textContent : (cur.parsed.counterparty_name || '');
    return f;
  }

  async function save() {
    const it = cur; if (!it) return;
    const cfg = ctx.cfg(), f = form();
    const errs = [];
    if (!f.number && f.doc_type !== TYPES.RECON) errs.push('номер');
    if (!f.date) errs.push('дата');
    if (!f.inn && !f.cp) errs.push('контрагент или ИНН');
    if (errs.length) { $('addMsg').textContent = `Заполните: ${errs.join(', ')}`; return; }
    if (it.match.duplicates.length && !confirm(`Похоже, документ уже есть в реестре:\n${it.match.duplicates.map(d => d.name).join('\n')}\n\nВсё равно добавить?`)) return;

    $('btnAddSave').disabled = true;
    try {
      f.hash = it.hash;
      f.notes = [f.notes, `распознано: ${it.source}`].filter(Boolean).join('; ');
      if (cfg.intake.api) {
        $('addMsg').textContent = 'загружаю файл в Nextcloud…';
        const st = storage(f, cfg.projects[f.project], (it.file.name.split('.').pop() || 'pdf').toLowerCase());
        const fd = new FormData(); fd.append('file', it.file); fd.append('dir', st.dir); fd.append('name', st.name);
        const up = await callApi(ctx, '/upload', { form: fd });
        f.link = up.link;
      }
      $('addMsg').textContent = 'создаю запись…';
      const portal = ctx.portal();
      const id = await portal.createItem(cfg.list.id, itemValues(f, cfg, await portal.me()));
      it.state = 'done'; it.msg = `${title(f)} (запись ${id})`;
      $('addCard').hidden = true; cur = null;
      await ctx.reload();
      next();
    } catch (e) {
      $('addMsg').textContent = `Не сохранилось: ${e.message}`;
      $('btnAddSave').disabled = false;
    }
  }

  async function next() {
    renderQueue();
    if (cur) return;
    const it = queue.find(x => x.state === 'wait');
    if (!it) return;
    it.state = 'work'; it.msg = ''; renderQueue();
    try { await read(it); it.state = 'review'; it.msg = ''; showCard(it); }
    catch (e) { it.state = 'error'; it.msg = e.message; renderQueue(); next(); }
  }

  function add(files) {
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name)) { queue.push({ file, state: 'error', msg: 'пока принимаются только PDF' }); continue; }
      queue.push({ file, state: 'wait' });
    }
    next();
  }

  $('addInput').addEventListener('change', (e) => { add([...e.target.files]); e.target.value = ''; });
  const dz = $('addDrop');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); add([...e.dataTransfer.files]); });
  $('btnAddSave').addEventListener('click', save);
  $('btnAddSkip').addEventListener('click', () => { if (!cur) return; cur.state = 'skip'; $('addCard').hidden = true; cur = null; next(); });
  $('addQueue').addEventListener('click', (e) => {
    const it = queue[e.target.closest('[data-i]')?.dataset.i];
    if (it && it.state === 'review' && it !== cur) { if (cur) cur.state = 'review'; showCard(it); }
  });
  // при выборе контрагента подтягиваем его ИНН, проект и направление из реестра
  $('a_cp').addEventListener('change', (e) => {
    const d = ctx.docs().find(x => x.cp === e.target.value); if (!d) return;
    if (!$('a_inn').value) $('a_inn').value = d.inn;
    if (!$('a_project').value && d.project) $('a_project').value = d.project;
    if (!$('a_direction').value && d.direction) $('a_direction').value = d.direction;
  });
  renderQueue();
}

async function callApi(ctx, path, { json, form }) {
  const cfg = ctx.cfg();
  const token = await ctx.portal().token();
  if (!token) throw new Error('нет токена портала: откройте приложение из меню Аспро');
  const r = await fetch(cfg.intake.api.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : form,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `сервис ответил ${r.status}`);
  return d;
}
