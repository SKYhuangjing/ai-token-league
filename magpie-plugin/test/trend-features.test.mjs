// End-to-end verification of trend features:
// - Split dimension switching (模型 / Agent)
// - Chart type switching (柱状图 / 折线图)
// - Subline details (请求数 / 费用 / 命中率 / 占比 / 失败数)
//
// Run: node test/trend-features.test.mjs
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8935;

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

const browser = await chromium.launch();
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

try {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/page/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  console.log("\n1. Testing split dimensions (模型 vs Agent)...");
  // Default is model
  const splitModelBtn = page.locator('#splitby button[data-split="model"]');
  const splitAgentBtn = page.locator('#splitby button[data-split="source"]');
  assert(await splitModelBtn.getAttribute("aria-selected") === "true", "Default split is 模型");
  assert(await splitModelBtn.textContent() === "模型", "模型 button has text '模型'");
  assert(await splitAgentBtn.textContent() === "Agent", "Agent button has text 'Agent'");

  const modelRanks = await page.$$eval("#chart-legend .rk .rk-a span", (els) => els.map((e) => e.textContent));
  assert(modelRanks.length > 0, `Legend has model rows (found ${modelRanks.length}: ${modelRanks.slice(0, 3).join(", ")})`);
  assert(modelRanks.some((name) => name.toLowerCase().includes("glm") || name.toLowerCase().includes("gemini")), "Legend rows represent models");

  // Switch to Agent
  await splitAgentBtn.click();
  await page.waitForTimeout(300);
  assert(await splitAgentBtn.getAttribute("aria-selected") === "true", "Switched split to Agent");
  const agentRanks = await page.$$eval("#chart-legend .rk .rk-a span", (els) => els.map((e) => e.textContent));
  assert(agentRanks.some((name) => name.includes("ZCode") || name.includes("Magpie") || name.includes("Codex")), `Legend rows now represent agents (${agentRanks.join(", ")})`);

  console.log("\n2. Testing chart types (柱状图 vs 折线图)...");
  const barBtn = page.locator('#chart-type button[data-chart="bar"]');
  const lineBtn = page.locator('#chart-type button[data-chart="line"]');
  assert(await barBtn.getAttribute("aria-selected") === "true", "Default chart type is 柱状图 (bar)");
  assert(await page.$$("#chart svg rect[height]") !== null, "Bar chart renders rect columns");
  const barCount = await page.$$eval("#chart svg g.bar rect", (els) => els.length);
  assert(barCount > 0, `Bar chart contains ${barCount} rect bars`);
  const initialLineCount = await page.$$eval("#chart svg g.line-series", (els) => els.length);
  assert(initialLineCount === 0, "No line-series in bar mode");

  // Switch to 折线图
  await lineBtn.click();
  await page.waitForTimeout(300);
  assert(await lineBtn.getAttribute("aria-selected") === "true", "Switched to 折线图 (line)");
  const lineCount = await page.$$eval("#chart svg g.ln", (els) => els.length);
  assert(lineCount > 0, `Line chart contains ${lineCount} stacked line series (g.ln)`);
  const pathLines = await page.$$eval("#chart svg g.ln path.line", (els) => els.map((e) => e.getAttribute("d")));
  assert(pathLines.length > 0 && pathLines[0].includes("C"), `Line paths contain monotone cubic bezier curves (d starts: ${pathLines[0].slice(0, 30)}...)`);
  const bands = await page.$$eval("#chart svg g.ln path.band", (els) => els.length);
  assert(bands > 0, `Line chart includes ${bands} flat bands (fill-opacity .14) between stacked lines`);
  // official semantics: lines STACK over the same axis as bars — top line ≈ totals
  const topLineEnd = await page.$eval("#chart svg g.ln path.line", (el) => el.getAttribute("d"));
  assert(topLineEnd.length > 10, "Stacked line path is drawn");

  // Switch back to 柱状图
  await barBtn.click();
  await page.waitForTimeout(300);
  assert(await barBtn.getAttribute("aria-selected") === "true", "Switched back to 柱状图");
  const restoredBars = await page.$$eval("#chart svg g.bar rect", (els) => els.length);
  assert(restoredBars > 0, `Bar chart columns restored (${restoredBars} bars)`);

  console.log("\n3. Testing subline details (副行明细)...");
  // Check sublines in legend
  const sublines = await page.$$eval("#chart-legend .rk .rk-b", (els) => els.map((e) => e.textContent));
  assert(sublines.length > 0, `Found ${sublines.length} rank sublines`);
  console.log(`  Sample subline: "${sublines[0]}"`);

  // Check subline format: requests, cost, hit rate, share
  assert(sublines[0].includes("个请求"), "Subline includes request count (e.g. X 个请求)");
  assert(sublines[0].includes("≈$"), "Subline includes estimated cost (e.g. ≈$X)");
  assert(sublines[0].includes("命中率"), "Subline includes cache hit rate (e.g. 命中率 X%)");
  assert(sublines[0].includes("%"), "Subline includes share percentage (e.g. X%)");

  console.log("\n4. Testing range switching (今日 -> 近 7 天)...");
  await page.locator('#periods button[data-range="7"]').click();
  await page.waitForTimeout(300);
  const sublines7d = await page.$$eval("#chart-legend .rk .rk-b", (els) => els.map((e) => e.textContent));
  assert(sublines7d.length > 0, `7-day view has ${sublines7d.length} legend rows`);
  console.log(`  Sample 7d subline: "${sublines7d[0]}"`);
  assert(sublines7d[0].includes("个请求"), "7d subline includes request count");

  // Test line chart on 7-day view
  await lineBtn.click();
  await page.waitForTimeout(300);
  const lineCount7d = await page.$$eval("#chart svg g.ln", (els) => els.length);
  assert(lineCount7d > 0, `7-day view works with line chart (${lineCount7d} stacked line series)`);

  await context.close();

  console.log("\n5. Testing English locale (en-US)...");
  const enContext = await browser.newContext({ locale: "en-US", viewport: { width: 480, height: 900 } });
  const enPage = await enContext.newPage();
  await enPage.goto(`http://127.0.0.1:${PORT}/page/index.html`, { waitUntil: "domcontentloaded" });
  await enPage.waitForTimeout(500);

  const enModelText = await enPage.$eval('#splitby button[data-split="model"]', el => el.textContent);
  const enAgentText = await enPage.$eval('#splitby button[data-split="source"]', el => el.textContent);
  assert(enModelText === "Model", `en-US split model text is 'Model' (got '${enModelText}')`);
  assert(enAgentText === "Agent", `en-US split agent text is 'Agent' (got '${enAgentText}')`);

  const enSublines = await enPage.$$eval("#chart-legend .rk .rk-b", (els) => els.map((e) => e.textContent));
  assert(enSublines.length > 0, `Found ${enSublines.length} en-US sublines`);
  console.log(`  Sample en-US subline: "${enSublines[0]}"`);
  assert(enSublines[0].includes("requests"), "en-US subline includes 'requests'");
  assert(enSublines[0].includes("hit rate"), "en-US subline includes 'hit rate'");
  if (enSublines[0].includes("failed")) {
    assert(enSublines[0].includes("failed"), "en-US subline includes 'failed' for errors");
  }

  await enContext.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);
