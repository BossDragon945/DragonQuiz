/**
 * 胖胖龍家族測驗 —— 出題與計分端
 *
 * 這段程式要貼到 Google Apps Script,並以「網頁應用程式」部署。
 * 完整步驟見專案根目錄的 README.md。
 *
 * 部署後拿到的網址,填進 config.js 的 appsScriptUrl。
 *
 * 題目與正確答案放在試算表的「題庫」工作表,只存在 Google 這邊。
 * 題目一次只發一題,每題的作答時間由這裡計時,
 * 網頁端改時間、按 F12 都看不到答案,也延長不了時間。
 */

// 作答結果會寫進這個工作表,不存在時會自動建立
var SHEET_NAME = '作答紀錄';

// 題庫工作表,不存在時會自動建立標題列
var QUESTION_SHEET_NAME = '題庫';

// 每題預設限時(秒);題庫「限時秒數」欄有填的題目以該欄為準
var DEFAULT_TIME_LIMIT = 15;

// 網路延遲的寬限時間(秒),超過「限時 + 寬限」才算逾時
var GRACE_SECONDS = 5;

// 每個人的題目順序、選項順序都打亂,避免互傳「第 3 題選 B」
var SHUFFLE = true;

// 交卷後是否顯示每一題的正確答案與解說
// 開著的話,先亂答一次就能看到全部答案,所以預設關閉
var SHOW_ANSWERS = false;

var LETTERS = 'ABCDEF';
var QUESTION_HEADER = ['題目', '選項A', '選項B', '選項C', '選項D', '選項E', '選項F', '正解', '解說', '限時秒數'];
var RECORD_HEADER = ['開始時間', '作答編號', '姓名', '狀態', '得分', '總題數', '答對率', '離開畫面', '逾時'];
var MARKS = { ok: '○', wrong: '✕', timeout: '逾時', left: '離開' };


/**
 * 網頁載入時呼叫:只回傳題數與限時,不含任何題目。
 * 用瀏覽器直接開部署網址也會看到這個,方便確認部署成功。
 */
function doGet() {
  try {
    var questions = loadQuestions_();
    var limits = questions.map(function (q) { return q.limit; });
    var same = limits.every(function (s) { return s === limits[0]; });
    return jsonOut_({
      ok: true,
      type: 'info',
      message: '測驗接收端運作中',
      total: questions.length,
      timeLimit: same ? limits[0] : null
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: errMsg_(err) });
  }
}


/**
 * 作答流程:
 *   { action: 'start', name }                        → 開始,回傳第一題
 *   { action: 'answer', session, step, pick, left }  → 交這一題,回傳下一題或最終成績
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok: false, error: '沒有收到資料' });
    }
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'begin') return jsonOut_(begin_(data));
    if (data.action === 'claim') return jsonOut_(claim_(data));
    if (data.action === 'submit') return jsonOut_(submit_(data));
    if (data.action === 'start') return jsonOut_(start_(data));
    if (data.action === 'answer') return jsonOut_(answer_(data));
    return jsonOut_({ ok: false, error: '不明的操作' });
  } catch (err) {
    return jsonOut_({ ok: false, error: errMsg_(err) });
  }
}


/* ---------------- 一次發題流程(目前前端使用)---------------- */

/**
 * 開始作答:一次回傳全部題目,但**不含正解**。
 *
 * 作答過程全部在瀏覽器本機進行,中途不再跟伺服器往返,所以換題是瞬間的。
 * 代價是計時改由前端回報(可被篡改),而且題目會一次全部出現在瀏覽器裡。
 * 正解仍然只存在伺服器端的 session 裡,批改也在伺服器做。
 */
function begin_(data) {
  var sess = newSession_(data);

  return {
    ok: true,
    type: 'begin',
    session: sess.id,
    total: sess.order.length,
    questions: sess.order.map(function (qi) {
      var q = sess.questions[qi];
      return {
        q: q.q,
        options: q.perm.map(function (i) { return q.options[i]; }),
        limit: q.limit
      };
    })
  };
}


/**
 * 認領:使用者真的按下「開始作答」時呼叫,把名字補上。
 *
 * 題目是在頁面載入時就先抓好的(為了讓開始作答沒有等待),那時還不知道
 * 名字,所以試算表那列先記成「(未開始)」。只開了頁面就離開的人會停在
 * 那個狀態,跟真的開始作答後放棄的人區分得開。
 *
 * 前端不等這個呼叫的結果,失敗也沒關係 —— 交卷時會再帶一次名字。
 */
function claim_(data) {
  var sess = loadSession_(data.session);
  if (!sess) return { ok: false, code: 'EXPIRED', error: '這次作答已失效,請重新開始' };

  sess.name = cleanName_(data.name);
  saveSession_(sess);

  withLock_(function () {
    var sheet = getSheet_();
    var row = findRow_(sheet, sess);
    if (row) sheet.getRange(row, 3, 1, 2).setValues([[sess.name, '作答中']]);
  });

  return { ok: true, type: 'claim' };
}


/**
 * 交卷:picks[i] 對應 begin_ 發出去的第 i 題(也就是 sess.order[i])。
 *   picks[i] = { pick: 選項索引(前端看到的順序), secs: 作答秒數, left: 是否離開過畫面 }
 */
function submit_(data) {
  var sess = loadSession_(data.session);
  if (!sess) return { ok: false, code: 'EXPIRED', error: '這次作答已失效,請重新開始' };
  if (sess.final) return sess.final;   // 重送交卷:直接回傳先前的成績,不重複計分

  // claim 可能失敗或根本沒送到,交卷時的名字才是最終依據
  if (data.name) sess.name = cleanName_(data.name);

  var picks = data.picks || [];
  sess.results = [];

  sess.order.forEach(function (qi, i) {
    var q = sess.questions[qi];
    var p = picks[i] || {};
    var cap = q.limit + GRACE_SECONDS;

    // 先用原始回報值判斷有沒有超時,再夾進上限 —— 順序反過來的話,
    // 夾完永遠不會大於上限,超時就再也判不出來了。
    var raw = Number(p.secs);
    if (!(raw >= 0)) raw = cap + 1;        // 沒回報秒數:當成超時
    var overtime = raw > cap;
    var secs = Math.min(raw, cap);

    var valid = typeof p.pick === 'number' && p.pick % 1 === 0 &&
                p.pick >= 0 && p.pick < q.options.length;

    var status, pick = null;
    if (p.left) {
      status = 'left';
    } else if (!valid || overtime) {
      status = 'timeout';
    } else {
      pick = q.perm[p.pick];               // 還原成題庫原本的選項索引
      status = pick === q.answer ? 'ok' : 'wrong';
    }

    sess.results[qi] = { pick: pick, status: status, secs: Math.round(secs * 10) / 10 };
  });

  sess.step = sess.order.length;
  return finish_(sess);
}


/* ---------------- 逐題發題流程(舊版前端用,保留相容)---------------- */

function start_(data) {
  return issue_(newSession_(data));
}


/**
 * 建立一次作答的 session,並在試算表寫下「作答中」那一列。
 * 開始時就把題庫整份存進 session,中途改題庫不影響正在作答的人。
 */
function newSession_(data) {
  var questions = loadQuestions_();
  // 預先載入時還不知道名字,先記成「(未開始)」,按下開始作答後由 claim_ 補上
  var name = data.name ? cleanName_(data.name) : '(未開始)';
  var id = Utilities.getUuid();

  var order = range_(questions.length);
  if (SHUFFLE) shuffle_(order);

  var sess = {
    id: id,
    code: 'T' + id.replace(/-/g, '').slice(0, 7),
    name: name,
    startedAt: Date.now(),
    order: order,
    step: 0,
    sentAt: 0,
    results: [],
    questions: questions.map(function (q) {
      var perm = range_(q.options.length);
      if (SHUFFLE) shuffle_(perm);
      return { q: q.q, options: q.options, answer: q.answer, explain: q.explain, limit: q.limit, perm: perm };
    })
  };

  // 一開始就寫一列「作答中」,中途放棄(例如先偷看題目)也會留下紀錄
  withLock_(function () {
    var sheet = getSheet_();
    ensureHeader_(sheet, questions.length);
    sheet.appendRow([new Date(sess.startedAt), sess.code, name, '作答中', '', questions.length, '', '', '']);
    sess.row = sheet.getLastRow();   // 記住列號,之後就不必在整張表裡搜尋
  });

  saveSession_(sess);
  return sess;
}


function cleanName_(v) {
  return String(v || '').trim().slice(0, 20) || '(未具名)';
}


/**
 * 找出這次作答在試算表的列號。優先用 session 記住的列號,
 * 只在對不上時(例如有人手動插入或刪除列)才退回搜尋作答編號。
 */
function findRow_(sheet, sess) {
  if (sess.row && sheet.getRange(sess.row, 2).getDisplayValue() === sess.code) return sess.row;

  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var found = sheet.getRange(2, 2, last - 1, 1)
                   .createTextFinder(sess.code).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}


function answer_(data) {
  var sess = loadSession_(data.session);
  if (!sess) return { ok: false, code: 'EXPIRED', error: '這次作答已失效,請重新開始' };
  if (sess.final) return sess.final;

  // 重送(例如網路斷掉後按重試):這題已經收過了,直接回傳目前狀態
  if (data.step !== sess.step) return issue_(sess);

  var qi = sess.order[sess.step];
  var q = sess.questions[qi];
  var elapsed = Date.now() - sess.sentAt;
  var p = data.pick;
  var valid = typeof p === 'number' && p % 1 === 0 && p >= 0 && p < q.options.length;

  var status, pick = null;
  if (data.left) {
    status = 'left';
  } else if (!valid || elapsed > (q.limit + GRACE_SECONDS) * 1000) {
    status = 'timeout';
  } else {
    pick = q.perm[p];
    status = pick === q.answer ? 'ok' : 'wrong';
  }

  sess.results[qi] = {
    pick: pick,
    status: status,
    secs: Math.round(Math.min(elapsed, (q.limit + GRACE_SECONDS) * 1000) / 100) / 10
  };
  sess.step++;
  sess.sentAt = 0;
  return issue_(sess);
}


/**
 * 發出目前這一題。重新要同一題時,剩餘時間照伺服器的時鐘算,
 * 所以重新整理或重送都不會讓時間重來。
 */
function issue_(sess) {
  if (sess.step >= sess.order.length) return finish_(sess);

  if (!sess.sentAt) sess.sentAt = Date.now();
  saveSession_(sess);

  var q = sess.questions[sess.order[sess.step]];
  var remaining = Math.max(0, q.limit * 1000 - (Date.now() - sess.sentAt));
  return {
    ok: true,
    type: 'question',
    session: sess.id,
    total: sess.order.length,
    step: sess.step,
    question: {
      q: q.q,
      options: q.perm.map(function (i) { return q.options[i]; }),
      limit: q.limit,
      remaining: remaining / 1000
    }
  };
}


function finish_(sess) {
  var total = sess.questions.length;
  var score = 0, leaves = 0, timeouts = 0;
  var cells = [];
  var review = [];

  sess.questions.forEach(function (q, i) {
    var r = sess.results[i] || { pick: null, status: 'timeout', secs: '' };
    if (r.status === 'ok') score++;
    if (r.status === 'left') leaves++;
    if (r.status === 'timeout') timeouts++;
    var yours = r.pick === null ? '' : q.options[r.pick];
    cells.push(yours, MARKS[r.status], r.secs);
    review.push({ q: q.q, yours: yours, status: r.status, correct: q.options[q.answer], explain: q.explain });
  });

  var percent = Math.round(score / total * 100);
  var row = [new Date(sess.startedAt), sess.code, sess.name, '完成', score, total, percent / 100, leaves, timeouts]
    .concat(cells);

  withLock_(function () {
    var sheet = getSheet_();
    ensureHeader_(sheet, total);
    var at = findRow_(sheet, sess);
    if (at) sheet.getRange(at, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
  });

  var res = { ok: true, type: 'result', done: true, score: score, total: total, percent: percent, leaves: leaves, timeouts: timeouts };
  if (SHOW_ANSWERS) res.review = review;

  sess.final = res;
  saveSession_(sess);
  return res;
}


/* ---------------- 內部函式 ---------------- */

function loadSession_(id) {
  if (typeof id !== 'string' || !id) return null;
  var raw = CacheService.getScriptCache().get('s:' + id);
  return raw ? JSON.parse(raw) : null;
}


function saveSession_(sess) {
  // 快取最長保存 6 小時,足夠作答一輪
  CacheService.getScriptCache().put('s:' + sess.id, JSON.stringify(sess), 21600);
}


function withLock_(fn) {
  // 多人同時作答時避免寫入互相覆蓋,最多等 20 秒
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}


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
  }
  if (sheet.getRange(1, QUESTION_HEADER.length).getDisplayValue() !== QUESTION_HEADER[QUESTION_HEADER.length - 1]) {
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
 * 題目 | 選項A~F(至少兩個,中間不能空格)| 正解(填字母 A~F)| 解說(可留空)| 限時秒數(可留空)
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

    var limitText = String(r[9]).trim();
    var limit = limitText ? Number(limitText) : DEFAULT_TIME_LIMIT;
    if (!(limit >= 3 && limit <= 600)) throw new Error('題庫第 ' + rowNo + ' 列:限時秒數請填 3~600 的數字');

    list.push({ q: q, options: options, answer: answer, explain: String(r[8]).trim(), limit: limit });
  });

  if (list.length === 0) throw new Error('題庫是空的,請在「' + QUESTION_SHEET_NAME + '」工作表填入題目');
  return list;
}


/**
 * 建立作答紀錄的標題列。題數改變時會重建標題,
 * 但不會動到既有資料列。
 */
function ensureHeader_(sheet, questionCount) {
  var expected = RECORD_HEADER.length + questionCount * 3;
  if (sheet.getLastRow() > 0 && sheet.getRange(1, 1).getDisplayValue() === RECORD_HEADER[0] &&
      sheet.getLastColumn() >= expected) return;

  var header = RECORD_HEADER.slice();
  for (var i = 1; i <= questionCount; i++) {
    header.push('第' + i + '題作答', '第' + i + '題', '第' + i + '題秒數');
  }

  // 新工作表預設只有 26 欄,6 題以上就會超出,先把欄位補足
  var maxCols = sheet.getMaxColumns();
  if (maxCols < header.length) {
    sheet.insertColumnsAfter(maxCols, header.length - maxCols);
  }

  sheet.getRange(1, 1, 1, header.length).setValues([header])
       .setFontWeight('bold')
       .setBackground('#1C1612')
       .setFontColor('#E8B547');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  sheet.getRange('G:G').setNumberFormat('0%');
}


function range_(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(i);
  return a;
}


function shuffle_(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}


function errMsg_(err) {
  return String(err && err.message ? err.message : err);
}


function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
