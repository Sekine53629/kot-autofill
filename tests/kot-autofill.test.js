// kot-autofill.test.js — jsdom 上に KING OF TIME の申請画面を模したDOMを組んで挙動を検証する
//   実行: npm test
//   注意: セレクタ（requestedSchedulePatternList_* など）が実画面と一致するかは
//         ここでは検証できない。実画面での確認が別途必要。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SCRIPT_PATH = path.join(__dirname, "..", "kot-autofill.js");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8");

const PAGE_URL = "https://s2.kingtime.jp/admin/";
const PANEL_ID = "kot-autofill-panel";
const STORAGE_KEY = "kot-autofill:enabled";
const TEST_DATE = "20260923";
const TEST_DAY_LABEL = "09/23";
const MESSAGE_SELECTOR = "input.htBlock-textS";
const SETTLE_MS = 50; // selectByText の待ちループが落ち着くまでの猶予

// 申請スケジュール・休暇種別・休暇モード・メッセージ欄だけを持つ最小構成のページ
const PAGE_HTML = `<!DOCTYPE html><html><body><table><tbody>
  <tr>
    <td>
      <select id="requestedSchedulePatternList_${TEST_DATE}">
        <option value=""></option>
        <option value="1">通常勤務(10-19時)</option>
        <option value="2">公休</option>
      </select>
      <select id="leave_type_code1${TEST_DATE}">
        <option value=""></option>
        <option value="k">公休</option>
      </select>
      <select id="leave_type_mode1${TEST_DATE}">
        <option value=""></option>
        <option value="z">全日休</option>
      </select>
      <button type="button">入力</button>
    </td>
  </tr>
  <tr><td><input class="htBlock-textS" value=""></td></tr>
</tbody></table></body></html>`;

/**
 * ページを1つ作り、スクリプトを実行した状態で操作用のヘルパーごと返す。
 * @param {{ savedState?: string | null }} options savedState は localStorage の初期値（"1" | "0"）
 */
const createPage = ({ savedState = null } = {}) => {
  const dom = new JSDOM(PAGE_HTML, { runScripts: "outside-only", url: PAGE_URL });
  const { window } = dom;
  const { document } = window;

  const logs = [];
  for (const level of ["log", "warn", "error"]) {
    window.console[level] = (...args) => logs.push({ level, text: args.join(" ") });
  }

  if (savedState !== null) window.localStorage.setItem(STORAGE_KEY, savedState);
  window.eval(SCRIPT);

  const shadow = () => document.getElementById(PANEL_ID)?.shadowRoot ?? null;
  const messageInput = () => document.querySelector(MESSAGE_SELECTOR);

  return {
    window,
    document,
    logs,
    /** スクリプトをもう一度実行する（Console への貼り直し相当） */
    rerun: () => window.eval(SCRIPT),
    /** 非同期の自動入力が終わるのを待つ */
    settle: () => new Promise(resolve => window.setTimeout(resolve, SETTLE_MS)),
    panelCount: () => document.querySelectorAll(`#${PANEL_ID}`).length,
    host: () => document.getElementById(PANEL_ID),
    panel: () => {
      const root = shadow();
      if (!root) return null;
      return {
        state: root.querySelector(".panel").dataset.state,
        label: root.querySelector(".label").textContent,
        hint: root.querySelector(".hint").textContent,
        status: root.querySelector(".status").textContent,
        level: root.querySelector(".status").dataset.level,
      };
    },
    clickToggle: () => shadow().querySelector(".toggle").click(),
    /** 申請スケジュールを表示名で選び、change を発火させる */
    selectSchedule: label => {
      const sel = document.getElementById(`requestedSchedulePatternList_${TEST_DATE}`);
      sel.value = [...sel.options].find(o => o.text === label).value;
      sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    selectedTextOf: id => {
      const sel = document.getElementById(`${id}${TEST_DATE}`);
      return sel.options[sel.selectedIndex].text;
    },
    isCleared: id => document.getElementById(`${id}${TEST_DATE}`).selectedIndex === 0,
    message: () => messageInput().value,
    setMessage: value => { messageInput().value = value; },
    /** メッセージ欄の change 発火回数を数える（リスナー二重登録の検出用） */
    countMessageChanges: () => {
      const input = messageInput();
      const counter = { value: 0 };
      const original = input.dispatchEvent.bind(input);
      input.dispatchEvent = event => {
        if (event.type === "change") counter.value++;
        return original(event);
      };
      return counter;
    },
    storedState: () => window.localStorage.getItem(STORAGE_KEY),
    savedStorageKey: STORAGE_KEY,
  };
};

test.describe("操作パネル", () => {
  test("ブラウザ左下に固定表示される", () => {
    const page = createPage();
    const { style } = page.host();
    assert.equal(style.position, "fixed");
    assert.equal(style.left, "16px");
    assert.equal(style.bottom, "16px");
  });

  test("Shadow DOM でページのCSSから隔離される", () => {
    const page = createPage();
    assert.notEqual(page.host().shadowRoot, null);
  });

  test("初回起動時は ON で、停止方法を表示する", () => {
    const page = createPage();
    const panel = page.panel();
    assert.equal(panel.state, "on");
    assert.equal(panel.label, "自動入力 ON");
    assert.equal(panel.hint, "クリックで停止");
  });

  test("前回 OFF にしていたら OFF で復元する", () => {
    const page = createPage({ savedState: "0" });
    const panel = page.panel();
    assert.equal(panel.state, "off");
    assert.equal(panel.label, "自動入力 OFF");
    assert.equal(panel.hint, "クリックで再開");
  });
});

test.describe("自動入力（ON のとき）", () => {
  test("申請メッセージが入り、結果が状態表示に出る", async () => {
    const page = createPage();
    page.selectSchedule("通常勤務(10-19時)");
    await page.settle();

    assert.equal(page.message(), "早番");
    const panel = page.panel();
    assert.match(panel.status, new RegExp(`${TEST_DAY_LABEL}.*早番`));
    assert.equal(panel.level, "info");
  });

  test("公休を選ぶと休暇種別と休暇モードが入る", async () => {
    const page = createPage();
    page.selectSchedule("公休");
    await page.settle();

    assert.equal(page.message(), "公休");
    assert.equal(page.selectedTextOf("leave_type_code1"), "公休");
    assert.equal(page.selectedTextOf("leave_type_mode1"), "全日休");
  });

  test("公休から出勤シフトに選び直すと休暇の設定が解除される", async () => {
    const page = createPage();
    page.selectSchedule("公休");
    await page.settle();
    page.selectSchedule("通常勤務(10-19時)");
    await page.settle();

    assert.ok(page.isCleared("leave_type_code1"), "休暇種別が未選択に戻っていない");
    assert.ok(page.isCleared("leave_type_mode1"), "休暇モードが未選択に戻っていない");
  });

  test("手入力済みのメッセージは上書きしない", async () => {
    const page = createPage();
    page.setMessage("私用のため");
    page.selectSchedule("公休");
    await page.settle();

    assert.equal(page.message(), "私用のため");
  });
});

test.describe("ON / OFF の切替", () => {
  test("クリックで OFF になり、状態が保存される", async () => {
    const page = createPage();
    page.clickToggle();
    await page.settle();

    const panel = page.panel();
    assert.equal(panel.state, "off");
    assert.equal(panel.hint, "クリックで再開");
    assert.equal(page.storedState(), "0");
  });

  test("OFF の間は自動入力しない", async () => {
    const page = createPage();
    page.clickToggle();
    await page.settle();
    page.selectSchedule("公休");
    await page.settle();

    assert.equal(page.message(), "");
    assert.ok(page.isCleared("leave_type_code1"), "OFF なのに休暇種別が変更された");
  });

  test("もう一度クリックすると自動入力が復活する", async () => {
    const page = createPage();
    page.clickToggle();
    page.clickToggle();
    await page.settle();
    page.selectSchedule("通常勤務(10-19時)");
    await page.settle();

    assert.equal(page.panel().state, "on");
    assert.equal(page.message(), "早番");
    assert.equal(page.storedState(), "1");
  });
});

test.describe("スクリプトの再実行", () => {
  test("パネルが増えない", () => {
    const page = createPage();
    page.rerun();
    assert.equal(page.panelCount(), 1);
  });

  test("change リスナーが二重登録されない", async () => {
    const page = createPage();
    page.rerun();
    const changes = page.countMessageChanges();
    page.selectSchedule("通常勤務(10-19時)");
    await page.settle();

    assert.equal(changes.value, 1, "メッセージ欄の change が複数回発火している");
  });

  test("連続実行してもエラーを出さない", async () => {
    const page = createPage();
    page.rerun();
    page.rerun();
    await page.settle();

    const errors = page.logs.filter(entry => entry.level === "error");
    assert.deepEqual(errors, [], `エラーログ: ${errors.map(e => e.text).join(" / ")}`);
  });
});
