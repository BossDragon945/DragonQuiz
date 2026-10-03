/**
 * 胖胖龍家族測驗 —— 出題與計分端
 *
 * 這段程式要貼到 Google Apps Script,並以「網頁應用程式」部署。
 * 完整步驟見專案根目錄的 README.md。
 *
 * 部署後拿到的網址,填進 config.js 的 appsScriptUrl。
 *
 * 題目與正確答案放在試算表的「題庫」工作表,只存在 Google 這邊。
 * 開始作答時一次發出全部題目(不含正解),批改與計分都在這裡做,
 * 按 F12 看不到答案。作答秒數由網頁端回報,懂技術的人可以竄改。
 */

// 作答結果會寫進這個工作表,不存在時會自動建立
var SHEET_NAME = '作答紀錄';

// 即時排行榜工作表(用公式從作答紀錄算出來),不存在時會自動建立
var RANK_SHEET_NAME = '排行榜';

// 題庫工作表,不存在時會自動建立標題列
var QUESTION_SHEET_NAME = '題庫';

// 活動開放時間設在這個工作表,不存在時會自動建立
var SETTING_SHEET_NAME = '設定';

// 每題預設限時(秒);題庫「限時秒數」欄有填的題目以該欄為準
var DEFAULT_TIME_LIMIT = 15;

// 網路延遲的寬限時間(秒),超過「限時 + 寬限」才算逾時
var GRACE_SECONDS = 5;

// check_ 快取「已用過的名字」的秒數。管理者手動刪掉某列讓人重考時,
// 輸入名字階段最多會多顯示這麼久的「已作答過」提醒(claim_ 不受影響)
var NAME_CACHE_SECONDS = 120;

// 每個人的題目順序、選項順序都打亂,避免互傳「第 3 題選 B」
var SHUFFLE = true;

// 交卷後是否顯示每一題的正確答案與解說
// 開著的話,先亂答一次就能看到全部答案,所以預設關閉
var SHOW_ANSWERS = false;

var LETTERS = 'ABCDEF';
var QUESTION_HEADER = ['題目', '選項A', '選項B', '選項C', '選項D', '選項E', '選項F', '正解', '解說', '限時秒數', '題目日文', '題目越南文', '題目英文',
                       '選項日文', '選項越南文', '選項英文'];
var RECORD_HEADER = ['開始時間', '作答編號', '姓名', '狀態', '得分', '總題數', '答對率', '答對題數', '離開畫面', '逾時'];
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
    var w = windowState_();
    return jsonOut_({
      ok: true,
      type: 'info',
      message: '測驗接收端運作中',
      total: questions.length,
      timeLimit: same ? limits[0] : null,
      open: w.open,
      window: w.detail || '(未設定,隨時可作答)'
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: errMsg_(err) });
  }
}


/**
 * 作答流程:
 *   { action: 'begin' }                       → 建立 session,回傳全部題目(不含正解)
 *   { action: 'check', name, session }        → 查名字有沒有用過
 *   { action: 'claim', session, name }        → 按下開始作答,認領這個 session
 *   { action: 'submit', session, name, picks } → 交卷,回傳成績 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok: false, error: '沒有收到資料' });
    }
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'begin') return jsonOut_(begin_(data));
    if (data.action === 'check') return jsonOut_(check_(data));
    if (data.action === 'claim') return jsonOut_(claim_(data));
    if (data.action === 'submit') return jsonOut_(submit_(data));
    return jsonOut_({ ok: false, error: '不明的操作' });
  } catch (err) {
    return jsonOut_({ ok: false, error: errMsg_(err) });
  }
}


/* ---------------- 作答流程 ---------------- */

/**
 * 開始作答:一次回傳全部題目,但**不含正解**。
 *
 * 作答過程全部在瀏覽器本機進行,中途不再跟伺服器往返,所以換題是瞬間的。
 * 代價是計時改由前端回報(可被篡改),而且題目會一次全部出現在瀏覽器裡。
 * 正解仍然只存在伺服器端的 session 裡,批改也在伺服器做。
 */
function begin_(data) {
  var closed = requireOpen_();
  if (closed) return closed;          // 活動時間外,連題目都不發

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
        limit: q.limit,
        tr: q.tr,
        // 選項翻譯跟著打亂後的選項順序,第 i 個對應畫面上的第 i 個選項
        otr: q.perm.map(function (i) {
          return { ja: q.optTr.ja[i] || '', vi: q.optTr.vi[i] || '', en: q.optTr.en[i] || '' };
        })
      };
    })
  };
}


/**
 * 查名字有沒有用過。使用者在輸入名字時就會先問一次,
 * 所以按下「開始作答」的當下不必等網路。
 *
 * 這只是提早提醒,**不拿鎖**:真正擋重名的是 claim_ 與 finish_ 在鎖內的檢查,
 * 這裡讀到稍微過時的結果也不會讓人鑽漏洞。不拿鎖才不會在大家同時輸入名字時
 * 跟寫入搶同一把鎖。
 *
 * 已用過的名字會短暫記在快取裡(NAME_CACHE_SECONDS),重複查同一個名字就不必
 * 再讀整張表。只快取「已用過」;沒用過的每次都讀表確認。
 */
function check_(data) {
  var name = cleanName_(data.name);
  var own = data.session || '';
  var key = 'n:' + name;
  var cache = CacheService.getScriptCache();

  var holder = cache.get(key);
  if (holder) return { ok: true, type: 'check', name: name, taken: holder !== own };

  var taken = nameTaken_(getSheet_(), name, own);
  if (taken) cache.put(key, '1', NAME_CACHE_SECONDS);
  return { ok: true, type: 'check', name: name, taken: taken };
}


/**
 * 這個名字是否已經開始作答過(不論有沒有交卷)。
 *
 * 只要留下過紀錄就算用掉機會 —— 中途關掉頁面也一樣,否則看到難題
 * 就關掉重來會變成合法的規避手段。ownCode 是這次作答自己的編號,
 * 要排除掉,不然會擋到自己。
 */
function nameTaken_(sheet, name, ownCode) {
  var last = sheet.getLastRow();
  if (last < 2) return false;

  // B=作答編號, C=姓名, D=狀態
  var vals = sheet.getRange(2, 2, last - 1, 3).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][1] === name && vals[i][0] !== ownCode) return true;
  }
  return false;
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
  var closed = requireOpen_();
  if (closed) return closed;          // 預抓完才過期的情況,按下開始時仍要擋

  var sess = loadSession_(data.session);
  if (!sess) return { ok: false, code: 'EXPIRED', error: '這次作答已失效,請重新開始' };

  var name = cleanName_(data.name);

  // 查名字和寫入放在同一個鎖裡,兩個人同時按開始才不會都通過
  var taken = withLock_(function () {
    var sheet = getSheet_();
    if (nameTaken_(sheet, name, sess.code)) return true;
    var row = findRow_(sheet, sess);
    if (row) sheet.getRange(row, 3, 1, 2).setValues([[name, '作答中']]);
    return false;
  });

  if (taken) return { ok: false, code: 'TAKEN', error: '「' + name + '」已經作答過了' };

  sess.name = name;
  saveSession_(sess);
  CacheService.getScriptCache().put('n:' + name, sess.code, NAME_CACHE_SECONDS);
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

  // 姓名的權威檢查併進 finish_ 的那把鎖裡做,省下一次取鎖與一次開表
  return finish_(sess);
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
    results: [],
    questions: questions.map(function (q) {
      var perm = range_(q.options.length);
      if (SHUFFLE) shuffle_(perm);
      return { q: q.q, options: q.options, answer: q.answer, explain: q.explain, limit: q.limit, tr: q.tr, optTr: q.optTr, perm: perm };
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


/* ---------------- 活動開放時間 ---------------- */

/**
 * 「設定」工作表,不存在時建立並填好欄位說明。
 */
function getSettingSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTING_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(SETTING_SHEET_NAME);
  sheet.getRange(1, 1, 3, 3).setValues([
    ['項目', '值', '說明'],
    ['開始時間', '', '留空 = 不限制。填法:2026/11/15 20:00'],
    ['結束時間', '', '留空 = 不限制。到這個時間就不能再開始作答']
  ]);
  sheet.getRange(1, 1, 1, 3)
       .setFontWeight('bold').setBackground('#1C1612').setFontColor('#E8B547');
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 340);
  return sheet;
}


/**
 * 讀出開放時間。回傳 { open, close },沒填的是 null。
 * 用 getValues 拿 Date 物件,所以時區跟著試算表走,不必自己剖析字串。
 */
function loadWindow_() {
  var sheet = getSettingSheet_();
  var v = sheet.getRange(2, 2, 2, 1).getValues();
  return {
    open: v[0][0] instanceof Date ? v[0][0] : null,
    close: v[1][0] instanceof Date ? v[1][0] : null
  };
}


function fmtTime_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
}


/**
 * 現在能不能開始作答。不能的話回傳給前端顯示的訊息。
 * 只擋「開始」—— 在時間內開始的人,超時了仍然可以把題目答完並交卷。
 */
function windowState_() {
  var w = loadWindow_();
  var now = new Date();

  if (w.open && now < w.open) {
    return { open: false, reason: '活動尚未開始',
             detail: '開放時間:' + fmtTime_(w.open) +
                     (w.close ? ' ~ ' + fmtTime_(w.close) : ' 起') };
  }
  if (w.close && now > w.close) {
    return { open: false, reason: '活動已經結束',
             detail: '開放時間到 ' + fmtTime_(w.close) + ' 為止' };
  }
  return {
    open: true,
    detail: w.open || w.close
      ? '開放時間:' + (w.open ? fmtTime_(w.open) : '不限') +
        ' ~ ' + (w.close ? fmtTime_(w.close) : '不限')
      : ''
  };
}


function requireOpen_() {
  var s = windowState_();
  if (s.open) return null;
  return { ok: false, code: 'CLOSED', error: s.reason, detail: s.detail };
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
    cells.push(yours, q.options[q.answer], MARKS[r.status], r.secs);
    review.push({ q: q.q, yours: yours, status: r.status, correct: q.options[q.answer], explain: q.explain });
  });

  var percent = Math.round(score / total * 100);
  var row = [new Date(sess.startedAt), sess.code, sess.name, '完成', score, total, percent / 100, score + ' / ' + total, leaves, timeouts]
    .concat(cells);

  var dup = withLock_(function () {
    var sheet = getSheet_();

    // 權威的姓名檢查。跟寫入放在同一把鎖裡,省下獨立取鎖與再開一次表
    if (nameTaken_(sheet, sess.name, sess.code)) return true;

    // begin 已經依題數補好標題與欄位了,列號還在就不必再檢查一次
    if (!sess.row) ensureHeader_(sheet, total);

    var at = findRow_(sheet, sess);
    if (at) sheet.getRange(at, 1, 1, row.length).setValues([row]);
    else sheet.appendRow(row);
    return false;
  });

  if (dup) {
    return { ok: false, code: 'TAKEN',
             error: '「' + sess.name + '」已經作答過了,這次成績不列入' };
  }

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
 * | 題目日文 | 題目越南文 | 題目英文(都可留空,有填的會顯示在題目下方)
 * | 選項日文 | 選項越南文 | 選項英文(可留空;選項依序用「|」隔開,顯示在各選項下方)
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

    // 翻譯(可留空,沒填的語言不顯示):日文、越南文、英文
    var tr = [r[10], r[11], r[12]].map(function (t) { return String(t || '').trim(); });

    // 選項翻譯:每個語言一格,選項依 A、B、C… 的順序用「|」隔開,數量要跟選項一樣
    var optTr = { ja: [], vi: [], en: [] };
    ['ja', 'vi', 'en'].forEach(function (k, n) {
      var cell = String(r[13 + n] || '').trim();
      if (!cell) return;
      var parts = cell.split('|').map(function (t) { return t.trim(); });
      if (parts.length !== options.length) {
        throw new Error('題庫第 ' + rowNo + ' 列:' + ['選項日文', '選項越南文', '選項英文'][n] +
                        '有 ' + parts.length + ' 個,但選項有 ' + options.length + ' 個(用「|」隔開)');
      }
      optTr[k] = parts;
    });

    list.push({ q: q, options: options, answer: answer, explain: String(r[8]).trim(), limit: limit,
                tr: { ja: tr[0], vi: tr[1], en: tr[2] }, optTr: optTr });
  });

  if (list.length === 0) throw new Error('題庫是空的,請在「' + QUESTION_SHEET_NAME + '」工作表填入題目');
  return list;
}


/**
 * 建立作答紀錄的標題列。題數改變時會重建標題,
 * 但不會動到既有資料列。
 */
function ensureHeader_(sheet, questionCount) {
  // 舊版沒有「答對題數」欄:在答對率(G)後面插入一欄,舊資料才不會錯位
  var migrated = false;
  if (sheet.getLastRow() > 0 && sheet.getRange(1, 1).getDisplayValue() === RECORD_HEADER[0] &&
      sheet.getRange(1, 8).getDisplayValue() === '離開畫面') {
    sheet.insertColumnAfter(7);
    migrated = true;                  // 新欄的標題還是空的,要往下重寫標題列
  }

  var expected = RECORD_HEADER.length + questionCount * 4;
  if (!migrated && sheet.getLastRow() > 0 && sheet.getRange(1, 1).getDisplayValue() === RECORD_HEADER[0] &&
      sheet.getLastColumn() >= expected) return;

  var header = RECORD_HEADER.slice();
  for (var i = 1; i <= questionCount; i++) {
    header.push('第' + i + '題作答', '第' + i + '題正解', '第' + i + '題', '第' + i + '題秒數');
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

  ensureRanking_(sheet.getParent());
}


/**
 * 排行榜:只放公式,作答紀錄一有新的「完成」就即時更新,不用程式維護。
 * 依得分高到低,同分的開始時間早的排前面,同分同名次。
 * 已經存在就不動,所以你可以自己調整格式。
 */
function ensureRanking_(ss) {
  if (ss.getSheetByName(RANK_SHEET_NAME)) return;

  var sh = ss.insertSheet(RANK_SHEET_NAME);
  sh.getRange(1, 1, 1, 5).setValues([['名次', '姓名', '得分', '答對題數', '答對率']])
    .setFontWeight('bold')
    .setBackground('#1C1612')
    .setFontColor('#E8B547');
  sh.setFrozenRows(1);

  // 作答紀錄的欄位:A 開始時間, C 姓名, D 狀態, E 得分, G 答對率, H 答對題數
  sh.getRange('B2').setFormula(
    "=IFERROR(QUERY('" + SHEET_NAME + "'!A2:J, " +
    "\"select C, E, H, G where D = '完成' order by E desc, A asc\", 0), \"\")");
  // 得分由高到低排好,MATCH 找到同分的第一列,就是並列名次
  sh.getRange('A2').setFormula('=ARRAYFORMULA(IF(C2:C="","",MATCH(C2:C,C2:C,0)))');
  sh.getRange('E:E').setNumberFormat('0%');
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
