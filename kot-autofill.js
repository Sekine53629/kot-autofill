// kot-autofill.js — KING OF TIME スケジュール申請 補助（イベント駆動版）
// 使い方: 申請画面を開く → DevToolsのConsoleに全文貼り付けてEnter
//   画面左下にパネルが出る。ONの間、各日の「申請スケジュール」を選ぶと関連項目が自動で入る
//   パネルのボタンでいつでもON/OFF切替（状態はブラウザに保存され、次回もその状態で始まる）
//   ページを再読込したら再実行（Tampermonkeyに入れれば不要）

(() => {
  "use strict";

  // ▼ スケジュールパターン表示名 → 自動入力の内容
  //   leave: null のシフトは 勤務日種別・休暇種別・休暇モード に触らない
  const RULES = {
    "通常勤務(10-19時)": { memo: "早番", leave: null },
    "10:30-19:30":       { memo: "遅半", leave: null },   // 要確認: 「中番(10:30〜19:30)」なら書き換え
    "通常勤務(11-20時)": { memo: "遅番", leave: null },
    "公休":              { memo: "公休", leave: { type: "公休", mode: "全日休" } }, // 勤務日種別はKOTが自動設定
  };

  const PANEL_ID = "kot-autofill-panel";
  const STORAGE_KEY = "kot-autofill:enabled";
  const PANEL_OFFSET_PX = 16;
  const PANEL_Z_INDEX = 2147483647;
  const SELECT_ID_PREFIX = "requestedSchedulePatternList_";
  const OPTION_WAIT_TRIES = 10;
  const OPTION_WAIT_MS = 100;
  const MESSAGE_INPUT_SELECTOR = "input.htBlock-textS";
  const MESSAGE_INPUT_FALLBACK_SELECTOR = "input[type='text'], textarea";
  const MESSAGE_OPEN_LABEL = "入力";
  const MESSAGE_OPEN_TRIES = 15;
  const MESSAGE_OPEN_WAIT_MS = 100;

  const norm = s => (s || "").normalize("NFKC").replace(/\s/g, "");
  const rules = Object.fromEntries(Object.entries(RULES).map(([k, v]) => [norm(k), v]));
  const ourMemos = new Set(Object.values(RULES).map(r => r.memo));
  const fire = el => ["input", "change"].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 「20260923」形式なら 09/23 に縮める（パネル表示用）
  const formatDate = raw => (/^\d{8}$/.test(raw) ? `${raw.slice(4, 6)}/${raw.slice(6, 8)}` : raw);

  // ---- 状態パネル（左下） ----------------------------------------------------

  const PANEL_HTML = `
    <style>
      :host { all: initial; }
      .panel {
        font: 12px/1.4 -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif;
        background: #1f2430; color: #e6e8ee;
        border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, .28);
        padding: 8px; min-width: 168px; max-width: 280px; user-select: none;
      }
      .toggle {
        display: flex; align-items: center; gap: 8px; width: 100%;
        background: transparent; border: 0; border-radius: 6px; padding: 4px 6px;
        color: inherit; font: inherit; text-align: left; cursor: pointer;
      }
      .toggle:hover { background: rgba(255, 255, 255, .08); }
      .toggle:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 1px; }
      .lamp { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #6b7280; }
      .panel[data-state="on"] .lamp { background: #34d399; box-shadow: 0 0 6px #34d399; }
      .label { font-weight: 600; }
      .hint { margin-left: auto; font-size: 11px; opacity: .6; }
      .status {
        margin-top: 6px; padding: 0 6px; font-size: 11px; opacity: .75;
        min-height: 1.4em; overflow-wrap: anywhere;
      }
      .status[data-level="warn"] { color: #fbbf24; opacity: 1; }
    </style>
    <div class="panel" data-state="off">
      <button class="toggle" type="button">
        <span class="lamp"></span>
        <span class="label"></span>
        <span class="hint"></span>
      </button>
      <div class="status" data-level="info"></div>
    </div>`;

  const buildPanel = onToggle => {
    document.getElementById(PANEL_ID)?.remove();

    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.style.cssText = `position:fixed;left:${PANEL_OFFSET_PX}px;bottom:${PANEL_OFFSET_PX}px;z-index:${PANEL_Z_INDEX};`;

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = PANEL_HTML;
    shadow.querySelector(".toggle").addEventListener("click", onToggle);

    if (document.body) document.body.appendChild(host);
    else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(host), { once: true });

    const panelEl = shadow.querySelector(".panel");
    const statusEl = shadow.querySelector(".status");
    return {
      render: enabledState => {
        panelEl.dataset.state = enabledState ? "on" : "off";
        shadow.querySelector(".label").textContent = `自動入力 ${enabledState ? "ON" : "OFF"}`;
        shadow.querySelector(".hint").textContent = enabledState ? "クリックで停止" : "クリックで再開";
      },
      setStatus: (text, level = "info") => {
        statusEl.textContent = text;
        statusEl.dataset.level = level;
      },
      remove: () => host.remove(),
    };
  };

  const panel = buildPanel(() => setEnabled(!enabled));

  // パネルとConsoleの両方に出す（Consoleのログは残す）
  const notify = (text, level = "info") => {
    panel.setStatus(text, level);
    if (level === "warn") console.warn(`[kot] ${text}`);
    else console.log(`[kot] ${text}`);
  };

  // ---- 自動入力 --------------------------------------------------------------

  // 表示名でoptionを選ぶ（完全一致→部分一致の順）。休暇モードの選択肢が後から生成される場合に備えて少し待つ
  const selectByText = async (sel, label, tries = OPTION_WAIT_TRIES) => {
    for (let i = 0; i < tries; i++) {
      const opts = [...sel.options];
      const opt = opts.find(o => norm(o.text) === norm(label)) || opts.find(o => norm(o.text).includes(norm(label)));
      if (opt) {
        if (sel.value !== opt.value) { sel.value = opt.value; fire(sel); }
        return true;
      }
      await sleep(OPTION_WAIT_MS);
    }
    return false;
  };
  const resetSelect = sel => { if (sel && sel.selectedIndex !== 0) { sel.selectedIndex = 0; fire(sel); } };

  // 申請スケジュールの行から、次の日付の行に当たるまでを「この日のブロック」とみなす
  const rowsBelow = row => {
    const rows = [];
    for (let next = row.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.querySelector(`select[id^="${SELECT_ID_PREFIX}"]`)) break;
      rows.push(next);
    }
    return rows;
  };

  const queryMessageInput = row => {
    const below = rowsBelow(row);
    // まずクラス指定で厳密に探す（行自身も見る）
    for (const scope of [row, ...below]) {
      const strict = scope.querySelector(MESSAGE_INPUT_SELECTOR);
      if (strict) return strict;
    }
    // 見つからなければ後続の行に限って緩く探す。行自身の時刻欄などを拾わないよう対象を絞る
    for (const scope of below) {
      const loose = scope.querySelector(MESSAGE_INPUT_FALLBACK_SELECTOR);
      if (loose) return loose;
    }
    return null;
  };

  const findMessageInput = async sel => {
    const row = sel.closest("tr");
    if (!row) return null;

    const opened = queryMessageInput(row);
    if (opened) return opened;

    // 「入力」ボタンで欄を開く。KOT側が非同期に差し込むため、出てくるまで待つ
    const opener = [...row.querySelectorAll("button, a, input[type='button'], input[type='submit']")]
      .find(el => (el.textContent || el.value || "").includes(MESSAGE_OPEN_LABEL));
    if (!opener) return null;
    opener.click();

    for (let i = 0; i < MESSAGE_OPEN_TRIES; i++) {
      await sleep(MESSAGE_OPEN_WAIT_MS);
      const input = queryMessageInput(row);
      if (input) return input;
    }
    return null;
  };

  const onChange = async e => {
    const sel = e.target;
    if (!(sel instanceof HTMLSelectElement) || !sel.id.startsWith(SELECT_ID_PREFIX)) return;

    const date = sel.id.split("_").pop();
    const day = formatDate(date);
    const rule = rules[norm(sel.options[sel.selectedIndex]?.text)];
    const typeSel = document.getElementById(`leave_type_code1${date}`);
    const modeSel = document.getElementById(`leave_type_mode1${date}`);

    try {
      // 1) 休暇種別・休暇モード
      if (rule?.leave) {
        if (!typeSel || !(await selectByText(typeSel, rule.leave.type))) {
          notify(`${day} 休暇種別「${rule.leave.type}」を設定できず`, "warn");
        } else if (!modeSel || !(await selectByText(modeSel, rule.leave.mode))) {
          notify(`${day} 休暇モード「${rule.leave.mode}」を設定できず`, "warn");
        }
      } else if (typeSel && norm(typeSel.options[typeSel.selectedIndex]?.text) === "公休") {
        // 公休から出勤シフトに選び直した場合は、スクリプトが入れた休暇を解除
        resetSelect(modeSel);
        resetSelect(typeSel);
      }

      // 2) 申請メッセージ（手入力の内容は上書きしない）
      const input = await findMessageInput(sel);
      if (!input) {
        notify(`${day} メッセージ欄が見つからない`, "warn");
        console.warn("[kot] 対象の行:", sel.closest("tr")); // 調査用にDOMを出す
        return;
      }
      const memo = rule?.memo ?? "";
      if (input.value && !ourMemos.has(input.value)) { notify(`${day} 手入力のメッセージを尊重（変更なし）`); return; }
      if (input.value !== memo) { input.value = memo; fire(input); }
      notify(memo ? `${day} 「${memo}」を入力` : `${day} メッセージを消去`);
    } catch (error) {
      notify(`${day} 自動入力に失敗: ${error.message}`, "warn");
      console.error(`[onChange] ${sel.id}`, error);
    }
  };

  // ---- 有効/無効の切替と保存 --------------------------------------------------

  const loadEnabled = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === null ? true : saved === "1";
    } catch (error) {
      console.warn("[loadEnabled] 状態を読めないため初期値ONで続行:", error.message);
      return true;
    }
  };

  const saveEnabled = value => {
    try {
      localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch (error) {
      console.warn("[saveEnabled] 状態を保存できず（このページ限りで動作）:", error.message);
    }
  };

  let enabled = false;

  function setEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    if (enabled) document.addEventListener("change", onChange, true);
    else document.removeEventListener("change", onChange, true);
    saveEnabled(enabled);
    panel.render(enabled);
    notify(enabled ? "待機中（申請スケジュールを選んでください）" : "停止中");
  }

  // ---- 起動 ------------------------------------------------------------------

  const prev = window.__kotAutofill;
  if (prev?.destroy) prev.destroy();
  else if (typeof prev === "function") document.removeEventListener("change", prev, true); // 旧版が動いている場合

  window.__kotAutofill = {
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    isEnabled: () => enabled,
    destroy: () => {
      document.removeEventListener("change", onChange, true);
      panel.remove();
      delete window.__kotAutofill;
    },
  };

  panel.render(enabled);
  setEnabled(loadEnabled());
  if (!enabled) notify("停止中（左下のボタンで再開）");
})();
