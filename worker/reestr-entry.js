// Вход в мини-приложение для Аспро.Cloud (как contracts-entry у «Реестра договоров»).
// Аспро открывает iframe POST-запросом, GitHub Pages на POST отвечает 405.
// 303 заставляет браузер повторить запрос как GET; window.name, через который SDK получает контекст, сохраняется.
export default {
  fetch() {
    return Response.redirect('https://root010qwe.github.io/reestr_aspro/index.html', 303);
  },
};
