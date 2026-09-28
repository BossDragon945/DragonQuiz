# 胖胖龍家族知識大考驗

給群組成員作答的線上單選題測驗。作答完立刻顯示分數與逐題檢討,
結果自動寫進你自己的 Google 試算表。

- 純靜態網站,掛在 GitHub Pages,**完全免費**
- 作答紀錄存在**你自己的 Google 帳號**裡,沒有第三方服務
- 筆數沒有上限

## 🔗 線上網址

作答頁面:https://bossdragon945.github.io/DragonQuiz/

---

## 🚀 首次設定(只需做一次)

分成兩步:先在 Google 那邊建立接收端,再把網址填回這個專案。

### 步驟 1:建立試算表與 Apps Script

1. 到 [Google 試算表](https://sheets.google.com) 建立一個**新的空白試算表**,
   名字隨意(例如「家族測驗作答紀錄」)
2. 在該試算表上方選單點 **擴充功能 → Apps Script**
3. 把編輯器裡原有的內容**全部刪掉**,改貼上本專案
   [`apps-script/Code.gs`](apps-script/Code.gs) 的完整內容
4. 按 💾 儲存

### 步驟 2:部署成網頁應用程式

1. 在 Apps Script 編輯器右上角點 **部署 → 新增部署作業**
2. 齒輪圖示選 **網頁應用程式**
3. 設定如下:

   | 欄位 | 要選的值 |
   |---|---|
   | 執行身分 | **我** |
   | 具有應用程式存取權的使用者 | **任何人** |

   > ⚠️ 「任何人」是必要的 —— 家族成員不需要登入 Google 就能作答。
   > 這不會讓別人看到你的試算表,他們只能送出資料,讀不到內容。

4. 按 **部署**,第一次會要求授權,依畫面同意即可
   (中途若出現「Google 尚未驗證這個應用程式」,點
   **進階 → 前往「專案名稱」(不安全)** 繼續,那是你自己寫的程式)
5. 複製最後給你的**網頁應用程式網址**,格式像:
   ```
   https://script.google.com/macros/s/AKfycb.....輸入一長串..../exec
   ```

### 步驟 3:填回專案

打開 [`config.js`](config.js),把網址貼進 `appsScriptUrl`:

```js
appsScriptUrl: "https://script.google.com/macros/s/AKfycb..../exec",
```

commit 並 push,等 GitHub Pages 重新建置(約一分鐘)就完成了。

**確認是否成功**:用瀏覽器直接打開那個 Apps Script 網址,
應該會看到 `{"ok":true,"message":"測驗接收端運作中","records":0}`。

---

## ✏️ 修改題目

題目全部放在 [`questions.json`](questions.json),格式如下:

```json
{
  "q": "題目文字",
  "options": ["選項A", "選項B", "選項C", "選項D"],
  "answer": 1,
  "explain": "解說文字(可省略)"
}
```

- `answer` 是**正確選項的索引,從 0 開始算** —— 上例的 `1` 代表「選項B」
- `options` 數量不限,2 到 6 個都可以
- `explain` 會顯示在結果頁,不想寫可以整行刪掉

改完 push 上去即可,不需要重新部署 Apps Script。

> 題數改變後,試算表會自動補上新的標題欄位,舊資料不受影響。

---

## ⚙️ 其他設定

[`config.js`](config.js) 裡還有:

| 設定 | 說明 |
|---|---|
| `title` / `subtitle` | 頁面標題與副標題 |
| `requireName` | 設為 `false` 則不要求輸入名字 |
| `showAnswers` | 設為 `false` 則結果頁不顯示正解 |

---

## 🖥 本機預覽

因為題庫是用 `fetch` 讀取的,直接用瀏覽器開 `index.html` 會被
瀏覽器的安全限制擋下來。要起一個本機伺服器:

```bash
python -m http.server 8000
```

然後開 http://localhost:8000

---

## ⚠️ 重要提醒

**正確答案存在前端,懂技術的人看得到。**

`questions.json` 會完整傳到瀏覽器,任何人按 F12 或直接開
`網址/questions.json` 都能看到所有答案。這是純靜態網站無法避免的限制。

家族同樂的情境下通常無所謂,但**不要拿來做需要防弊的正式考試**。

---

## 📜 License

MIT
