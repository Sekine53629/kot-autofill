// kot-autofill.test.js — jsdom 上に KING OF TIME の申請画面を模したDOMを組んで挙動を検証する
//   実行: npm test
//   DOMの構造は実画面のDevTools出力に合わせている（dummyRow / foldableRow / name="remark_list"）。
//   ただし模造品であることに変わりはないため、実画面での確認は別途必要。
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
const FIRST_DATE = "20260923";
const SECOND_DATE = "20260924";
const FIRST_DAY_LABEL = "09/23";
const MESSAGE_ROW_ID_PREFIX = "message-row-"; // テストから欄を引くための目印
const SETTLE_MS = 50; // 自動入力の非同期処理が落ち着くまでの猶予
const DEFERRED_OPEN_MS = 250; // 「入力」ボタン押下から欄が現れるまでの遅延
const DEFERRED_SETTLE_MS = 800;

const MESSAGE_INPUT_HTML =
  '<p><label>申請メッセージ:</label>' +
  '<input type="text" class="htBlock-textS htBlock-rowExpandTable_foldableRow_showInButton"' +
  ' name="remark_list" value="" maxlength="400"></p>';

const DUMMY_ROW = '<tr class="htBlock-rowExpandTable_dummyRow"></tr>';

/**
 * 1日分の行を組み立てる。実画面同様、申請行とメッセージ行の間に空の dummyRow が入る。
 * この dummyRow のせいで nextElementSibling だけを見ると欄が見つからない。
 */
const buildDay = (date, { foldableId = null, messageRowFirst = false, withInput = true } = {}) => {
  const foldableAttr = foldableId === null ? "" : ` data-ht-foldable-row-id="${foldableId}"`;
  const mainRow = `
    <tr>
      <td>
        <select id="requestedSchedulePatternList_${date}">
          <option value=""></option>
          <option value="1">通常勤務(10-19時)</option>
          <option value="2">公休</option>
        </select>
        <select id="leave_type_code1${date}">
          <option value=""></option>
          <option value="k">公休</option>
        </select>
        <select id="leave_type_mode1${date}">
          <option value=""></option>
          <option value="z">全日休</option>
        </select>
        <button type="button"${foldableAttr}>入力</button>
      </td>
    </tr>`;
  const messageRow = `
    <tr>
      <td colspan="9" class="htBlock-rowExpandTable_foldableRow"${foldableAttr}
          id="${MESSAGE_ROW_ID_PREFIX}${date}">${withInput ? MESSAGE_INPUT_HTML : ""}</td>
    </tr>`;
  return messageRowFirst
    ? messageRow + DUMMY_ROW + mainRow
    : mainRow + DUMMY_ROW + messageRow;
};

const buildPage = (options = {}) => `<!DOCTYPE html><html><body><table><tbody>
  ${buildDay(FIRST_DATE, { foldableId: options.foldableIds ? "htblock-uniqid1" : null, ...options })}
  ${buildDay(SECOND_DATE, { foldableId: options.foldableIds ? "htblock-uniqid2" : null, ...options })}
  ${DUMMY_ROW}
</tbody></table></body></html>`;

/**
 * ページを1つ作り、スクリプトを実行した状態で操作用のヘルパーごと返す。
 * @param {object} options
 * @param {string | null} options.savedState localStorage の初期値（"1" | "0"）
 * @param {boolean} options.foldableIds 折りたたみ行のidを付けるか（実画面では付いている）
 * @param {boolean} options.messageRowFirst メッセージ行を申請行より前に置くか
 * @param {boolean} options.withInput 最初からメッセージ欄がDOMにあるか
 * @param {number | null} options.deferredOpenMs 「入力」押下から欄が現れるまでの遅延（ms）
 */
const createPage = ({
  savedState = null,
  foldableIds = true,
  messageRowFirst = false,
  withInput = true,
  deferredOpenMs = null,
} = {}) => {
  const dom = new JSDOM(buildPage({ foldableIds, messageRowFirst, withInput }), {
    runScripts: "outside-only",
    url: PAGE_URL,
  });
  const { window } = dom;
  const { document } = window;

  const logs = [];
  for (const level of ["log", "warn", "error"]) {
    window.console[level] = (...args) => logs.push({ level, text: args.join(" ") });
  }

  // 「入力」ボタンで KOT 側が後から欄を差し込む挙動を再現する
  if (deferredOpenMs !== null) {
    for (const date of [FIRST_DATE, SECOND_DATE]) {
      const row = document.getElementById(`${MESSAGE_ROW_ID_PREFIX}${date}`);
      const opener = document.getElementById(`requestedSchedulePatternList_${date}`)
        .closest("tr").querySelector("button");
      opener.addEventListener("click", () => {
        window.setTimeout(() => { row.innerHTML = MESSAGE_INPUT_HTML; }, deferredOpenMs);
      });
    }
  }

  if (savedState !== null) window.localStorage.setItem(STORAGE_KEY, savedState);
  window.eval(SCRIPT);

  const shadow = () => document.getElementById(PANEL_ID)?.shadowRoot ?? null;
  const messageInput = (date = FIRST_DATE) =>
    document.querySelector(`#${MESSAGE_ROW_ID_PREFIX}${date} input`);

  return {
    window,
    document,
    logs,
    rerun: () => window.eval(SCRIPT),
    settle: (ms = SETTLE_MS) => new Promise(resolve => window.setTimeout(resolve, ms)),
    warnings: () => logs.filter(entry => entry.level === "warn").map(entry => entry.text),
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
    selectSchedule: (label, date = FIRST_DATE) => {
      const sel = document.getElementById(`requestedSchedulePatternList_${date}`);
      sel.value = [...sel.options].find(o => o.text === label).value;
      sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    selectedTextOf: (id, date = FIRST_DATE) => {
      const sel = document.getElementById(`${id}${date}`);
      return sel.options[sel.selectedIndex].text;
    },
    isCleared: (id, date = FIRST_DATE) =>
      document.getElementById(`${id}${date}`).selectedIndex === 0,
    message: (date = FIRST_DATE) => messageInput(date)?.value ?? null,
    setMessage: (value, date = FIRST_DATE) => { messageInput(date).value = value; },
    countMessageChanges: (date = FIRST_DATE) => {
      const input = messageInput(date);
      const counter = { value: 0 };
      const original = input.dispatchEvent.bind(input);
      input.dispatchEvent = event => {
        if (event.type === "change") counter.value++;
        return original(event);
      };
      return counter;
    },
    storedState: () => window.localStorage.getItem(STORAGE_KEY),
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

// 申請メッセージ欄は別の <tr> にあり、間に空の dummyRow が挟まる。
// 隣の行だけを見ていると見つからない（実画面で発生した不具合の回帰防止）。
test.describe("メッセージ欄の特定", () => {
  test("dummyRow を挟んだ別の行にある欄を見つけられる", async () => {
    const page = createPage();
    page.selectSchedule("通常勤務(10-19時)");
    await page.settle();

    assert.equal(page.message(), "早番");
    assert.deepEqual(
      page.warnings().filter(text => text.includes("メッセージ欄が見つからない")),
      []
    );
  });

  test("別の日のメッセージ欄を書き換えない", async () => {
    const page = createPage();
    page.selectSchedule("通常勤務(10-19時)", FIRST_DATE);
    await page.settle();

    assert.equal(page.message(FIRST_DATE), "早番");
    assert.equal(page.message(SECOND_DATE), "", "別の日の欄が書き換えられた");
  });

  test("2日目を選んでも正しい日の欄に入る", async () => {
    const page = createPage();
    page.selectSchedule("公休", SECOND_DATE);
    await page.settle();

    assert.equal(page.message(SECOND_DATE), "公休");
    assert.equal(page.message(FIRST_DATE), "");
  });

  test("折りたたみ行のidが無くても出現順で対応付けられる", async () => {
    const page = createPage({ foldableIds: false });
    page.selectSchedule("通常勤務(10-19時)", SECOND_DATE);
    await page.settle();

    assert.equal(page.message(SECOND_DATE), "早番");
    assert.equal(page.message(FIRST_DATE), "");
  });

  test("メッセージ行が申請行より前にあっても正しく引ける", async () => {
    const page = createPage({ foldableIds: false, messageRowFirst: true });
    page.selectSchedule("通常勤務(10-19時)", SECOND_DATE);
    await page.settle();

    assert.equal(page.message(SECOND_DATE), "早番");
    assert.equal(page.message(FIRST_DATE), "");
  });

  test("「入力」ボタンで後から開く欄にも入力できる", async () => {
    const page = createPage({ withInput: false, deferredOpenMs: DEFERRED_OPEN_MS });
    page.selectSchedule("通常勤務(10-19時)");
    await page.settle(DEFERRED_SETTLE_MS);

    assert.equal(page.message(), "早番");
    assert.deepEqual(
      page.warnings().filter(text => text.includes("メッセージ欄が見つからない")),
      []
    );
  });
});

test.describe("自動入力（ON のとき）", () => {
  test("申請メッセージが入り、結果が状態表示に出る", async () => {
    const page = createPage();
    page.selectSchedule("通常勤務(10-19時)");
    await page.settle();

    assert.equal(page.message(), "早番");
    const panel = page.panel();
    assert.match(panel.status, new RegExp(`${FIRST_DAY_LABEL}.*早番`));
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
