// Renders the plugin page in multiple locales/themes with headless Chromium
// and captures full-page PNGs for the visual acceptance pass.
//
//   node magpie-plugin/test/visual-capture.mjs --out .tmp-smoke/visual
//
// Self-contained: serves magpie-plugin/ itself (page + bridge files).
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = outArg >= 0 ? args[outArg + 1] : ".tmp-smoke/visual";
const PORT = 8931;

const server = createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "") || "page/index.html";
  const path = join(PLUGIN_DIR, rel);
  if (!existsSync(path)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": path.endsWith(".js")
      ? "application/javascript"
      : path.endsWith(".css")
        ? "text/css"
        : "text/html; charset=utf-8"
  });
  res.end(readFileSync(path));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${PORT}/page/index.html`;

const scenarios = [
  { name: "usage-zh-light", locale: "zh-CN", colorScheme: "light", tab: "usage" },
  { name: "usage-en-light", locale: "en-US", colorScheme: "light", tab: "usage" },
  { name: "usage-zh-dark", locale: "zh-CN", colorScheme: "dark", tab: "usage" },
  { name: "settings-zh-light", locale: "zh-CN", colorScheme: "light", tab: "settings" },
  { name: "settings-en-dark", locale: "en-US", colorScheme: "dark", tab: "settings" },
  { name: "usage-today-zh", locale: "zh-CN", colorScheme: "light", tab: "usage-today" }
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const shotPath = (name) => join(process.cwd(), OUT, `${name}.png`);
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      locale: scenario.locale,
      colorScheme: scenario.colorScheme,
      viewport: { width: 460, height: 900 }
    });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: "domcontentloaded" });
    if (scenario.tab === "settings") {
      await page.click('#views button[data-view="settings"]');
    } else if (scenario.tab === "usage-today") {
      await page.click('#periods button[data-range="1"]');
    }
    // wait until the KPI cells are painted from the bridge data (usage tabs)
    if (scenario.tab.startsWith("usage")) {
      await page.waitForFunction(
        () => window.__ATL_USAGE_DATA__ && window.__ATL_USAGE_DATA__.days && window.__ATL_USAGE_DATA__.days.length > 0,
        null,
        { timeout: 8000, polling: 250 }
      ).catch(() => {});
    }
    // the page repaints on a 1.5s interval; wait past one tick after the data lands
    await page.waitForTimeout(1700);
    const diag = await page.evaluate(() => ({
      hasUsage: typeof window.__ATL_USAGE_DATA__ !== "undefined",
      days: window.__ATL_USAGE_DATA__ ? window.__ATL_USAGE_DATA__.days.length : -1,
      kpi: document.getElementById("k-total").textContent,
      errors: window.__ATL_ERRORS || []
    }));
    await page.screenshot({ path: shotPath(scenario.name), fullPage: true });
    console.log(`captured ${scenario.name} ${JSON.stringify(diag)}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`done -> ${join(process.cwd(), OUT)}`);
