// Распознавание сканов в браузере: pdf.js рисует страницу, tesseract.js читает (rus+eng).
// Библиотека и языковые данные грузятся с jsDelivr только когда встретился скан.

let workerPromise = null;

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => fail(new Error(`не загрузился ${src}`));
    document.head.appendChild(s);
  });
}

async function worker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
      return window.Tesseract.createWorker('rus+eng');
    })();
  }
  return workerPromise;
}

export function makeOcr(pdfjs) {
  return async function ocr(bytes, _doc, onPage = () => {}) {
    const w = await worker();
    const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const full = [], columns = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      onPage(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      full.push((await w.recognize(canvas)).data.text);
      const half = (x0) => {
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width / 2); c.height = vp.height;
        c.getContext('2d').drawImage(canvas, x0, 0, c.width, c.height, 0, 0, c.width, c.height);
        return c;
      };
      columns.push((await w.recognize(half(0))).data.text);
      columns.push((await w.recognize(half(Math.floor(vp.width / 2)))).data.text);
    }
    return { full: full.join('\n'), columns, pages: pdf.numPages, scan: false, ocr: true };
  };
}
