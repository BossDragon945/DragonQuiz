/**
 * 胖胖龍家族測驗 —— 出題與計分端
 *
 * 這段程式要貼到 Google Apps Script,並以「網頁應用程式」部署。
 * 完整步驟見專案根目錄的 README.md。
 *
 * 部署後拿到的網址,填進 config.js 的 appsScriptUrl。
 *
 * 題目與正確答案放在試算表的「題庫」工作表,只存在 Google 這邊:
 * 網頁只會拿到題目和選項,作答送回來後才在這裡計分,
 * 所以在瀏覽器按 F12 也看不到答案。
 */

// 作答結果會寫進這個工作表,不存在時會自動建立
var SHEET_NAME = '作答紀錄';

// 題庫工作表,不存在時會自動建立標題列
var QUESTION_SHEET_NAME = '題庫';

// 交卷後是否回傳每一題的正確答案與解說給作答者看
var SHOW_ANSWERS = true;

var LETTERS = 'ABCDEF';
var QUESTION_HEADER = ['題目', '選項A', '選項B', '選項C', '選項D', '選項E', '選項F', '正解', '解說'];


/**
 * 網頁載入時呼叫:回傳題目與選項(不含答案)。
 * 用瀏覽器直接開部署網址也會看到這個,方便確認部署成功。
 */
function doGet() {
  try {
    var questions = loadQuestions_();
    return jsonOut_({
      ok: true,
      message: '測驗接收端運作中',
      questions: questions.map(function (q) {
        return { q: q.q, options: q.options };
      })
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: errMsg_(err) });
  }
}


/**
 * 接收作答、計分、寫入試算表,並回傳分數。
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok: false, error: '沒有收到資料' });
    }

    var data = JSON.parse(e.postData.contents);
    var picks = Array.isArray(data.picks) ? data.picks : [];
    var asked = Array.isArray(data.questions) ? data.questions : [];
    var questions = loadQuestions_();

    // 作答期間題庫被改過,題號會對不上,請對方重新整理
    var stale = picks.length !== questions.length || asked.length !== questions.length ||
      questions.some(function (q, i) { return asked[i] !== q.q; });
    if (stale) {
      return jsonOut_({ ok: false, code: 'STALE', error: '題目已經更新,請重新整理頁面再作答' });
    }

    var name = String(data.name || '').trim().slice(0, 20) || '(未具名)';
    var score = 0;
    var cells = [];
    var review = [];

    questions.forEach(function (q, i) {
      var p = picks[i];
      var valid = typeof p === 'number' && p % 1 === 0 && p >= 0 && p < q.options.length;
      var ok = valid && p === q.answer;
      if (ok) score++;
      cells.push(valid ? q.options[p] : '(未作答)');
      cells.push(ok ? '○' : '✕');
      review.push({ isCorrect: ok, correct: q.options[q.answer], explain: q.explain });
    });

    var percent = Math.round(score / questions.length * 100);
    var row = [new Date(), name, score, questions.length, percent / 100].concat(cells);

    // 多人同時作答時避免寫入互相覆蓋,最多等 20 秒
    lock.waitLock(20000);
    var sheet = getSheet_();
    ensureHeader_(sheet, questions.length);
    sheet.appendRow(row);

    var res = { ok: true, score: score, total: questions.length, percent: percent };
    if (SHOW_ANSWERS) res.review = review;
    return jsonOut_(res);

  } catch (err) {
    return jsonOut_({ ok: false, error: errMsg_(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
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


function getQuestionSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(QUESTION_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(QUESTION_SHEET_NAME);
    sheet.getRange(1, 1, 1, QUESTION_HEADER.length).setValues([QUESTION_HEADER])
         .setFontWeight('bold')
         .setBackground('#1C1612')
         .setFontColor('#E8B547');
    sheet.setFrozenRows(1);
  }
  return sheet;
}


/**
 * 讀取「題庫」工作表。每列一題:
 * 題目 | 選項A~F(至少兩個,中間不能空格)| 正解(填字母 A~F)| 解說(可留空)
 * 題目欄空白的列會被略過。
 */
function loadQuestions_() {
  var sheet = getQuestionSheet_();
  var last = sheet.getLastRow();
  if (last < 2) throw new Error('題庫是空的,請在「' + QUESTION_SHEET_NAME + '」工作表填入題目');

  var values = sheet.getRange(2, 1, last - 1, QUESTION_HEADER.length).getDisplayValues();
  var list = [];

  values.forEach(function (r, idx) {
    var rowNo = idx + 2;
    var q = String(r[0]).trim();
    if (!q) return;

    var raw = r.slice(1, 7).map(function (s) { return String(s).trim(); });
    var count = 0;
    raw.forEach(function (s, i) { if (s) count = i + 1; });
    var options = raw.slice(0, count);
    if (options.length < 2) throw new Error('題庫第 ' + rowNo + ' 列:至少要有兩個選項');
    if (options.indexOf('') !== -1) throw new Error('題庫第 ' + rowNo + ' 列:選項中間不能有空格');

    var answer = LETTERS.indexOf(String(r[7]).trim().toUpperCase());
    if (answer === -1 || answer >= options.length) {
      throw new Error('題庫第 ' + rowNo + ' 列:正解請填 A~' + LETTERS.charAt(options.length - 1));
    }

    list.push({ q: q, options: options, answer: answer, explain: String(r[8]).trim() });
  });

  if (list.length === 0) throw new Error('題庫是空的,請在「' + QUESTION_SHEET_NAME + '」工作表填入題目');
  return list;
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


function errMsg_(err) {
  return String(err && err.message ? err.message : err);
}


function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
