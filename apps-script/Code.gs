/**
 * 胖胖龍家族測驗 —— 作答結果接收端
 *
 * 這段程式要貼到 Google Apps Script,並以「網頁應用程式」部署。
 * 完整步驟見專案根目錄的 README.md。
 *
 * 部署後拿到的網址,填進 config.js 的 appsScriptUrl。
 */

// 資料會寫進這個工作表,不存在時會自動建立
var SHEET_NAME = '作答紀錄';


/**
 * 接收測驗網站送來的作答結果。
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // 多人同時作答時避免寫入互相覆蓋,最多等 20 秒
    lock.waitLock(20000);

    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok: false, error: '沒有收到資料' });
    }

    var data = JSON.parse(e.postData.contents);
    var answers = data.answers || [];
    var sheet = getSheet_();

    ensureHeader_(sheet, answers.length);

    var row = [
      new Date(),
      data.name || '(未具名)',
      data.score,
      data.total,
      (data.percent != null ? data.percent / 100 : '')
    ];
    answers.forEach(function (a) {
      row.push(a.picked || '(未作答)');
      row.push(a.isCorrect ? '○' : '✕');
    });

    sheet.appendRow(row);

    return jsonOut_({ ok: true, row: sheet.getLastRow() });

  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}


/**
 * 用瀏覽器直接開部署網址時會看到這個,方便確認部署成功。
 */
function doGet() {
  var sheet = getSheet_();
  var count = Math.max(0, sheet.getLastRow() - 1);
  return jsonOut_({
    ok: true,
    message: '測驗接收端運作中',
    records: count
  });
}


/* ---------------- 內部函式 ---------------- */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  return sheet;
}


/**
 * 第一次寫入時建立標題列。題數改變時會重建標題,
 * 但不會動到既有資料列。
 */
function ensureHeader_(sheet, questionCount) {
  var expected = 5 + questionCount * 2;
  if (sheet.getLastRow() > 0 && sheet.getLastColumn() >= expected) return;

  var header = ['時間', '姓名', '得分', '總題數', '答對率'];
  for (var i = 1; i <= questionCount; i++) {
    header.push('第' + i + '題作答');
    header.push('第' + i + '題');
  }

  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.getRange(1, 1, 1, header.length)
       .setFontWeight('bold')
       .setBackground('#1C1612')
       .setFontColor('#E8B547');
  sheet.setFrozenRows(1);
  sheet.getRange('E:E').setNumberFormat('0%');
  sheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
}


function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
