/* ============================================================
   設定檔 —— 平常只需要改這個檔案
   ============================================================ */

const QUIZ_CONFIG = {

  // 測驗標題(顯示在最上方)
  title: "胖胖龍家族知識大考驗",

  // 副標題,可留空字串
  subtitle: "答完立刻知道分數,結果會記錄下來",

  // ------------------------------------------------------------
  // Apps Script 網頁應用程式網址
  //
  // 部署完 apps-script/Code.gs 之後,把拿到的網址貼在這裡。
  // 格式長得像:https://script.google.com/macros/s/AKfy..../exec
  //
  // 題目、答案與計分都在 Apps Script 那邊,沒填網址就無法作答。
  // 詳細步驟見 README.md
  // ------------------------------------------------------------
  appsScriptUrl: "https://script.google.com/macros/s/AKfycbyjvZrdB8cCULE4jIGom62n8uVJS3E0c0UbXfZr4Yz2_de-4MR4_lB-wf_ZqMpWmdTs/exec",

  // 作答前是否要求輸入姓名
  requireName: true,

  // (結果頁是否顯示正解,改在 apps-script/Code.gs 的 SHOW_ANSWERS 設定)
};
