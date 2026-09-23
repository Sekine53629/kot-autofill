// kot-autofill.js — KING OF TIME スケジュール申請 補助（イベント駆動版）
// 使い方: 申請画面を開く → DevToolsのConsoleに全文貼り付けてEnter
//   以降、各日の「申請スケジュール」を選ぶと、同じ日の関連項目が自動で入る
//   ページを再読込したら再実行（Tampermonkeyに入れれば不要）

// ▼ スケジュールパターン表示名 → 自動入力の内容
//   leave: null のシフトは 勤務日種別・休暇種別・休暇モード に触らない
const RULES = {
  "通常勤務(10-19時)": { memo: "早番", leave: null },
  "10:30-19:30":       { memo: "遅半", leave: null },   // 要確認: 「中番(10:30〜19:30)」なら書き換え
  "通常勤務(11-20時)": { memo: "遅番", leave: null },
  "公休":              { memo: "公休", leave: { type: "公休", mode: "全日休" } }, // 勤務日種別はKOTが自動設定
};

(() => {
  const norm = s => (s || "").normalize("NFKC").replace(/\s/g, "");
  const rules = Object.fromEntries(Object.entries(RULES).map(([k, v]) => [norm(k), v]));
  const ourMemos = new Set(Object.values(RULES).map(r => r.memo));
  const fire = el => ["input", "change"].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 表示名でoptionを選ぶ（完全一致→部分一致の順）。休暇モードの選択肢が後から生成される場合に備えて少し待つ
  const selectByText = async (sel, label, tries = 10) => {
    for (let i = 0; i < tries; i++) {
      const opts = [...sel.options];
      const opt = opts.find(o => norm(o.text) === norm(label)) || opts.find(o => norm(o.text).includes(norm(label)));
      if (opt) {
        if (sel.value !== opt.value) { sel.value = opt.value; fire(sel); }
        return true;
      }
      await sleep(100);
    }
    return false;
  };
  const resetSelect = sel => { if (sel && sel.selectedIndex !== 0) { sel.selectedIndex = 0; fire(sel); } };

  const findMessageInput = sel => {
    const row = sel.closest("tr");
    if (!row) return null;
    let input = row.nextElementSibling?.querySelector("input.htBlock-textS");
    if (!input) {
      [...row.querySelectorAll("button")].find(b => b.textContent.includes("入力"))?.click();
      input = row.nextElementSibling?.querySelector("input.htBlock-textS");
    }
    return input;
  };

  const onChange = async e => {
    const sel = e.target;
    if (!(sel instanceof HTMLSelectElement) || !sel.id.startsWith("requestedSchedulePatternList_")) return;

    const date = sel.id.split("_").pop();
    const rule = rules[norm(sel.options[sel.selectedIndex]?.text)];
    const typeSel = document.getElementById(`leave_type_code1${date}`);
    const modeSel = document.getElementById(`leave_type_mode1${date}`);

    // 1) 休暇種別・休暇モード
    if (rule?.leave) {
      if (!typeSel || !(await selectByText(typeSel, rule.leave.type))) console.warn(`[kot] ${date} 休暇種別「${rule.leave.type}」を設定できず`);
      else if (!modeSel || !(await selectByText(modeSel, rule.leave.mode))) console.warn(`[kot] ${date} 休暇モード「${rule.leave.mode}」を設定できず`);
    } else if (typeSel && norm(typeSel.options[typeSel.selectedIndex]?.text) === "公休") {
      // 公休から出勤シフトに選び直した場合は、スクリプトが入れた休暇を解除
      resetSelect(modeSel);
      resetSelect(typeSel);
    }

    // 2) 申請メッセージ（手入力の内容は上書きしない）
    const input = findMessageInput(sel);
    if (!input) { console.warn(`[kot] ${date} メッセージ欄が見つからない`); return; }
    const memo = rule?.memo ?? "";
    if (input.value && !ourMemos.has(input.value)) return;
    if (input.value !== memo) { input.value = memo; fire(input); }
  };

  if (window.__kotAutofill) document.removeEventListener("change", window.__kotAutofill, true);
  window.__kotAutofill = onChange;
  document.addEventListener("change", onChange, true);
  console.log("[kot] 自動入力を有効化しました。");
})();
