// Настройки по умолчанию для портала aspro.it-nb.ru (список «Реестр документов», id 8).
// Любой ключ переопределяется без правки кода: настройки приложения → «Конфигурация (JSON)».

export const DEFAULTS = {
  list: {
    id: 8,
    fields: {
      name: 'cf_83', inn: 'cf_85', amount: 'cf_86', kpp: 'cf_87', number: 'cf_88', date: 'cf_89',
      subject: 'cf_90', vat_amount: 'cf_91', signed_date: 'cf_92', paid_date: 'cf_93', paid_amount: 'cf_94',
      file_link: 'cf_95', file_hash: 'cf_96', notes: 'cf_97', doc_type: 'cf_98', vat_rate: 'cf_99',
      sign_status: 'cf_100', direction: 'cf_101', project: 'cf_102', counterparty: 'cf_103',
      contract: 'cf_104', responsible: 'cf_105',
    },
    // id вариантов выпадающих списков (customfields/fieldoptions)
    options: {
      doc_type: { 6: 'Договор', 7: 'Доп. соглашение', 8: 'Приложение / спецификация', 9: 'Счёт', 10: 'Счёт-фактура / УПД',
        11: 'Акт выполненных работ', 12: 'Акт сдачи-приёмки', 13: 'Акт сверки', 14: 'Платёжное поручение', 15: 'Другое' },
      vat_rate: { 16: 'Без НДС', 17: '5%', 18: '7%', 19: '20%', 20: '22%' },
      sign_status: { 21: 'На проверке', 22: 'Ожидает подписи контрагента', 23: 'Подписан (ЭДО)', 24: 'Подписан (оригинал)', 25: 'Аннулирован' },
      direction: { 26: 'Доходный', 27: 'Расходный' },
    },
  },
  projects: { 46: 'КазГАУ', 54: 'КазГау | ФортДиалог' },
  company: { our_inns: ['1686032615'], our_names: ['Нью Бренд'] },
  // приём документов: Worker с загрузкой в Nextcloud и ИИ-разбором (worker/reestr-api.js); пусто — без загрузки файла
  intake: { api: 'https://reestr-api.trinos-881.workers.dev', ocr: true },
  rules: {
    stale_days: 14,          // документ «на проверке» или «ожидает подписи» дольше — тревога
    today: null,             // для тестов: 'YYYY-MM-DD'
  },
};

export function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') ? mergeConfig(base[k], v) : v;
  }
  return out;
}
