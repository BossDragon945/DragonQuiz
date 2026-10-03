/**
 * 壓力測試:模擬 N 個人同時作答(begin → check → claim → 隨機作答 → submit)。
 *
 * 用法(Node 18+):
 *   node tools/stress-test.mjs <複本部署網址> [人數=20] [參數]
 *
 * 參數:
 *   --stagger=ms   每個人的起跑時間在 0~ms 內隨機錯開(預設 0 = 全部同時開始)
 *   --think=ms     begin 之後「看題」的等待時間(預設 0)
 *   --prefix=XXX   假名字前綴(預設 TEST_),測完好在試算表裡篩選刪除
 *
 * ⚠️ 只能對「複本」的部署網址測,因為會在作答紀錄寫入 N 列假資料。
 *    腳本會拒絕 config.js 裡的正式網址。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('http'));
const n = Number(args.find(a => /^\d+$/.test(a)) || 20);
const opt = (k, d) => {
  const a = args.find(x => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const stagger = Number(opt('stagger', 0));
const think = Number(opt('think', 0));
const prefix = opt('prefix', 'TEST_');

if (!url) {
  console.error('用法: node tools/stress-test.mjs <複本部署網址> [人數] [--stagger=ms] [--think=ms] [--prefix=TEST_]');
  process.exit(1);
}

// 防呆:不准打正式網址
try {
  const cfg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.js'), 'utf8');
  const prod = cfg.match(/appsScriptUrl:\s*"([^"]+)"/)?.[1];
  if (prod && url.replace(/\/$/, '') === prod.replace(/\/$/, '')) {
    console.error('✋ 這是 config.js 裡的正式網址,拒絕執行。請改用複本的部署網址。');
    process.exit(1);
  }
} catch { /* 讀不到 config.js 就略過檢查 */ }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const runId = Date.now().toString(36).slice(-4);

async function call(body) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { ok: false, error: `非 JSON 回應 (HTTP ${res.status}): ${text.slice(0, 80)}` }; }
    return { ms: performance.now() - t0, json };
  } catch (e) {
    return { ms: performance.now() - t0, json: { ok: false, error: String(e.message || e) } };
  }
}

const lat = { begin: [], check: [], claim: [], submit: [] };
const errors = [];
const results = [];

async function user(i) {
  const name = `${prefix}${runId}_${String(i).padStart(3, '0')}`;
  if (stagger) await sleep(Math.random() * stagger);
  const t0 = performance.now();
  const fail = (step, r) => {
    errors.push({ name, step, error: r.json.error || JSON.stringify(r.json).slice(0, 100) });
    results.push({ name, ok: false });
  };

  const b = await call({ action: 'begin' });
  lat.begin.push(b.ms);
  if (!b.json.ok) return fail('begin', b);

  const session = b.json.session;
  if (think) await sleep(think);

  const c = await call({ action: 'check', name, session });
  lat.check.push(c.ms);
  if (!c.json.ok) return fail('check', c);

  const cl = await call({ action: 'claim', session, name });
  lat.claim.push(cl.ms);
  if (!cl.json.ok) return fail('claim', cl);

  const picks = b.json.questions.map(q => ({
    pick: Math.floor(Math.random() * q.options.length),
    secs: 1 + Math.random() * 3,
    left: false,
  }));
  const s = await call({ action: 'submit', session, name, picks });
  lat.submit.push(s.ms);
  if (!s.json.ok) return fail('submit', s);

  results.push({ name, ok: true, total: (performance.now() - t0) / 1000 });
}

const pct = (a, p) => {
  if (!a.length) return '-';
  const s = [...a].sort((x, y) => x - y);
  return (s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] / 1000).toFixed(2) + 's';
};

console.log(`目標: ${url}`);
console.log(`人數: ${n}  錯開: ${stagger}ms  看題: ${think}ms  名字: ${prefix}${runId}_xxx\n`);

const t0 = performance.now();
await Promise.all(Array.from({ length: n }, (_, i) => user(i + 1)));
const wall = ((performance.now() - t0) / 1000).toFixed(1);

const okN = results.filter(r => r.ok).length;
console.log(`完成: ${okN}/${n} 成功,${n - okN} 失敗,總耗時 ${wall}s\n`);
console.log('步驟      次數   p50      p95      max');
for (const [k, a] of Object.entries(lat)) {
  console.log(`${k.padEnd(8)} ${String(a.length).padStart(4)}   ${pct(a, 0.5).padEnd(8)} ${pct(a, 0.95).padEnd(8)} ${pct(a, 1)}`);
}

if (errors.length) {
  const by = {};
  for (const e of errors) by[`${e.step}: ${e.error}`] = (by[`${e.step}: ${e.error}`] || 0) + 1;
  console.log('\n失敗原因:');
  for (const [k, v] of Object.entries(by)) console.log(`  ${v}×  ${k}`);
}

console.log(`\n接著請到複本試算表「作答紀錄」檢查:`);
console.log(`  1. 姓名以 ${prefix}${runId}_ 開頭的列應該剛好 ${okN} 列(沒漏、沒重複)`);
console.log(`  2. 這些列的狀態都應該是「已完成」之類,不該有卡在「作答中」`);
console.log(`  3. 驗完把 ${prefix} 開頭的列全部刪除`);
process.exit(errors.length ? 2 : 0);
