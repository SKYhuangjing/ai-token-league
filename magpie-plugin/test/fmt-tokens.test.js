// fmtTokens must stay a faithful port of Magpie's own fmtN
// (internal/gui/assets app.js), including its chineseUnits setting gate:
// the host setting defaults to OFF, so zh users see the B/M/K ladder —
// the user reported exactly that ("我这应该用的是英文的 KBM"). 万/亿 shows
// only when the bridged setting is on. Unary + strips trailing zeros the
// same way ("7.8 亿").
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const viewSrc = readFileSync(path.join(import.meta.dir, "../page/view.js"), "utf8");

function loadView() {
  const listeners = {};
  const win = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    __ATL_LISTENERS: listeners
  };
  const fn = new Function("window", `${viewSrc}\nreturn window.ATLView;`);
  return fn(win);
}

test("fmtTokens default (chineseUnits off) mirrors Magpie's B/M/K ladder for zh and en", () => {
  const ATLView = loadView();
  expect(ATLView.chineseUnits).toBe(false);
  for (const locale of ["zh-CN", "en"]) {
    expect(ATLView.fmtTokens(1523456789, locale)).toBe("1.52B");
    expect(ATLView.fmtTokens(782895048, locale)).toBe("783M"); // >=1e7 rounds to whole M
    expect(ATLView.fmtTokens(1234567, locale)).toBe("1.2M");
    expect(ATLView.fmtTokens(123456, locale)).toBe("123K"); // >=1e5 rounds to whole K
    expect(ATLView.fmtTokens(9412, locale)).toBe("9.4K");
    expect(ATLView.fmtTokens(999, locale)).toBe("999");
  }
});

test("fmtTokens chineseUnits on mirrors Magpie's 万/亿 ladder for zh only", () => {
  const ATLView = loadView();
  ATLView.chineseUnits = true;
  expect(ATLView.fmtTokens(782895048, "zh-CN")).toBe("7.83 亿");
  expect(ATLView.fmtTokens(780000000, "zh-CN")).toBe("7.8 亿"); // trailing zero stripped
  expect(ATLView.fmtTokens(39005992230, "zh-CN")).toBe("390.06 亿");
  expect(ATLView.fmtTokens(52235000, "zh-CN")).toBe("5223.5 万");
  expect(ATLView.fmtTokens(9412, "zh-CN")).toBe("9412"); // below 万 stays raw
  // the setting is zh-only in Magpie: en keeps the B/M/K ladder
  expect(ATLView.fmtTokens(782895048, "en")).toBe("783M");
});

test("fmtTokens rejects non-numbers as the panel's unknown marker", () => {
  const ATLView = loadView();
  expect(ATLView.fmtTokens(undefined, "zh-CN")).toBe("—");
  expect(ATLView.fmtTokens(NaN, "en")).toBe("—");
  expect(ATLView.fmtTokens("123", "zh-CN")).toBe("—");
});
