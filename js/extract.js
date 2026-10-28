// Текст из PDF (pdf.js) и DOCX (JSZip). Библиотеки передаются снаружи, чтобы модуль работал и в браузере, и в Node.

export class UnsupportedFile extends Error {}

function linesFromItems(items) {
  // items: [{str, x, y, w}] -> строки сверху вниз, слева направо
  const rows = [];
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  for (const it of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - it.y) <= 2.5) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows.map(r => {
    r.items.sort((a, b) => a.x - b.x);
    let s = '', end = null;
    for (const it of r.items) {
      if (end !== null && it.x - end > 1.2 && !s.endsWith(' ') && !it.str.startsWith(' ')) s += ' ';
      s += it.str;
      end = it.x + it.w;
    }
    return s.replace(/\s+$/, '');
  }).filter(Boolean).join('\n');
}

export async function extractPdf(bytes, pdfjs, { minChars = 400 } = {}) {
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
  const full = [], columns = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter(t => t.str !== undefined && t.str !== '')
      .map(t => ({ str: t.str, x: t.transform[4], y: t.transform[5], w: t.width }));
    full.push(linesFromItems(items));
    const mid = vp.width / 2;
    columns.push(linesFromItems(items.filter(t => t.x < mid)));
    columns.push(linesFromItems(items.filter(t => t.x >= mid)));
  }
  const text = full.join('\n');
  return { full: text, columns, pages: pdf.numPages, scan: text.replace(/\s/g, '').length < minChars };
}

function xmlText(xml) {
  // абзацы <w:p>, табуляции и переносы; таблицы разбираем отдельно
  return xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export async function extractDocx(bytes, JSZip) {
  const zip = await JSZip.loadAsync(bytes);
  const f = zip.file('word/document.xml');
  if (!f) throw new UnsupportedFile('DOCX без word/document.xml');
  const xml = await f.async('string');
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    // таблица: строки через « | », а каждая колонка ещё и отдельным текстом (реквизиты сторон)
    return '\n' + [...tbl.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)]
      .map(r => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(c => xmlText(c[0]).trim().replace(/\n+/g, ' ')).join(' | '))
      .join('\n') + '\n';
  });
  const columns = [];
  for (const tbl of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
    const rows = [...tbl[0].matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map(r => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(c => xmlText(c[0]).trim()));
    const n = Math.max(0, ...rows.map(r => r.length));
    for (let c = 0; c < n; c++) columns.push(rows.map(r => r[c] || '').join('\n'));
  }
  return { full: xmlText(body).replace(/\n{3,}/g, '\n\n'), columns, pages: 0, scan: false };
}

export async function extract(bytes, filename, libs, opts = {}) {
  const name = (filename || '').toLowerCase();
  const u8 = (bytes && bytes.constructor === Uint8Array) ? bytes : new Uint8Array(bytes);
  const magic = String.fromCharCode(...u8.slice(0, 4));
  if (name.endsWith('.pdf') || magic === '%PDF') return extractPdf(u8, libs.pdfjs, opts);
  if (name.endsWith('.docx') || magic.startsWith('PK')) return extractDocx(u8, libs.JSZip);
  throw new UnsupportedFile('Поддерживаются PDF и DOCX. Старый .doc пересохраните в DOCX или PDF.');
}

export async function sha256(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
