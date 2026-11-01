// Programmatic UI audit (contrast / overflow / i18n completeness) — the
// substitute evidence for a visual-model pass in environments without image
// input. Run: node magpie-plugin/test/ui-audit.mjs
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8933;

const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "page/index.html";
  const path = join(PLUGIN_DIR, rel);
  if (!existsSync(path)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const type = path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html; charset=utf-8";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const auditInPage = async (tab) => {
  // Everything this function uses must be defined INSIDE it: page.evaluate
  // serializes the function body and does not carry outer-scope bindings.
  const parseColor = (color) => {
    const m = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  };
  const mix = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a)
  });
  const luminance = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (fg, bg) => {
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  if (tab === "settings") document.querySelector('#views button[data-view="settings"]').click();
  await new Promise((r) => setTimeout(r, 400));
  // let layout settle: a measurement taken mid-layout reports the heatmap's
  // pre-clip extents as document overflow (a flake we kept chasing)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const issues = [];

  // --- 1. contrast on real text elements ---
  const textEls = [...document.querySelectorAll("body *")].filter((el) => {
    const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const style = getComputedStyle(el);
    return text && style.visibility !== "hidden" && el.offsetParent !== null;
  });
  const cache = new Map();
  const effectiveBg = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0.9) return bg;
      node = node.parentElement;
    }
    const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor);
    return bodyBg && bodyBg.a > 0.9 ? bodyBg : { r: 255, g: 255, b: 255, a: 1 };
  };
  for (const el of textEls) {
    const style = getComputedStyle(el);
    let fg = parseColor(style.color);
    if (!fg) continue;
    const bg = effectiveBg(el);
    if (fg.a < 1) fg = mix(fg, bg);
    const ratio = contrast(fg, bg);
    const size = parseFloat(style.fontSize);
    const bold = parseInt(style.fontWeight, 10) >= 600;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      issues.push(`contrast ${ratio.toFixed(2)} < ${need} on "${el.textContent.trim().slice(0, 26)}" (fs=${size}px)`);
    }
  }

  // --- 2. overflow ---
  // a reading taken mid-layout (heatmap pre-clip, chart re-measure) reports
  // phantom 2px overflows: confirm a real one with a second reading
  let docOverflows = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  if (docOverflows) {
    await new Promise((r) => setTimeout(r, 250));
    docOverflows = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  }
  if (docOverflows) issues.push(`document horizontal overflow: ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
  for (const el of document.querySelectorAll(".kpi b, .kpi small, ol .who, ol .num, .btn, .segs .opt, h1, .since, .vv")) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== "hidden" && !el.className.includes("who")) {
      issues.push(`element overflow: ${el.tagName}.${el.className} "${el.textContent.trim().slice(0, 20)}" ${el.scrollWidth}>${el.clientWidth}`);
    }
  }

  // --- 3. i18n / raw-key leaks ---
  const allText = document.body.innerText;
  for (const leak of [/(^|\s)(desktop|source|tab|kpi|range|cfg|sync|hint|comp|models|sources)\.[a-zA-Z]/, /data-t/, /data-i18n/, /undefined/, /NaN/]) {
    const m = allText.match(leak);
    if (m) issues.push(`text leak ${leak}: "${String(m[0]).slice(0, 30)}"`);
  }

  // --- 4. chart / heatmap / legend sanity ---
  if (tab === "usage") {
    const bars = document.querySelectorAll("#chart rect").length;
    if (!bars) issues.push("usage chart has no bars (data bridge empty?)");
    const cells = document.querySelectorAll("#heat i").length;
    if (!cells) issues.push("heatmap has no cells");
    else if (cells < 300) issues.push(`heatmap suspiciously sparse: ${cells} cells (expect ~53 weeks)`);
    const ranks = document.querySelectorAll("#chart-legend .rk").length;
    if (!ranks) issues.push("chart legend is empty");

    // regression (user report): the hover highlight must sit BEHIND the
    // bars — on top it paints the hovered column away
    const svgChildren = [...document.querySelectorAll("#chart svg > rect")];
    const hitIdx = svgChildren.findIndex((r) => r.getAttribute("fill") === "transparent");
    if (hitIdx >= 0) {
      hitIdx && svgChildren[hitIdx].dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      const barIdx = svgChildren.findIndex((r) => r.getAttribute("fill") === "var(--c1)");
      const hotIdx = svgChildren.findIndex((r) => r.getAttribute("fill") === "var(--pill)" && r.style.display !== "none");
      if (barIdx >= 0 && hotIdx >= 0 && hotIdx > barIdx) issues.push("hover highlight renders above the bars (column disappears on hover)");
    }
    // regression (user report): an empty heatmap day must read as a grey
    // cell, not the card's own colour
    const emptyCell = document.querySelector("#heat i:not([class])");
    const card = document.querySelector(".heat-wrap");
    if (emptyCell && card) {
      const cellBg = getComputedStyle(emptyCell).backgroundColor;
      const cardBg = getComputedStyle(card).backgroundColor;
      if (cellBg === cardBg || cellBg === "rgba(0, 0, 0, 0)") issues.push("empty heatmap cell is invisible (same colour as the card)");
    }
  }

  const kpi = document.getElementById("k-total");
  return { issues, kpiTotal: kpi ? kpi.textContent : null, barCount: document.querySelectorAll("#chart rect").length };
};

const scenarios = [
  { name: "usage-zh-light", locale: "zh-CN", scheme: "light", tab: "usage" },
  { name: "usage-en-light", locale: "en-US", scheme: "light", tab: "usage" },
  { name: "usage-zh-dark", locale: "zh-CN", scheme: "dark", tab: "usage" },
  { name: "settings-en-dark", locale: "en-US", scheme: "dark", tab: "settings" }
];

const browser = await chromium.launch();
const report = {};
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({ locale: scenario.locale, colorScheme: scenario.scheme, viewport: { width: 460, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/page/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    report[scenario.name] = await page.evaluate(auditInPage, scenario.tab);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(report, null, 2));
const totalIssues = Object.values(report).flatMap((r) => r.issues);
console.log(`\nTOTAL ISSUES: ${totalIssues.length}`);
for (const issue of totalIssues) console.log(`  - ${issue}`);
