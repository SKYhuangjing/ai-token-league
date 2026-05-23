# UI 测试开发计划

> 版本: 0.7.0 | 最后更新: 2026-05-23

## 目录

1. [测试架构总览](#1-测试架构总览)
2. [Layer 1: E2E 测试 (Playwright)](#2-layer-1-e2e-测试-playwright)
3. [Layer 2: Renderer 逻辑测试 (jsdom)](#3-layer-2-renderer-逻辑测试-jsdom)
4. [性能测试](#4-性能测试)
5. [工具链与依赖](#5-工具链与依赖)
6. [CI 集成](#6-ci-集成)
7. [测试用例清单](#7-测试用例清单)

---

## 1. 测试架构总览

### 现状

| 层级 | 覆盖情况 |
|---|---|
| Rust 后端 (collector-core) | 186 个测试全部通过 (单元 + 集成) |
| Node.js 共享模块 (src/shared/) | `tests/run-tests.js` 覆盖 + **Vitest 152 测试** (8 共享模块) |
| Desktop UI (renderer.js) | **341 单元测试** (152 共享模块 + 117 helpers + 46 data + 28 components - 19 DOM removed + 20 pattern) + **52 E2E 测试** (11 场景 + 4 zh-CN + 3 empty + 3 error + 3 large + 2 async + 5 perf + 6 workflows + 2 scan-view) + **11 性能基准** |
| 性能基准 | **11 基准全部通过** (formatTokenCompact, formatUsd, composition, pricing 等) |

### 实施进度

- [x] **Phase 1**: Vitest 配置 + 共享模块测试 (109 tests)
- [x] **Phase 2**: Playwright E2E 场景 (8 specs: onboarding, scan, range, navigation, settings, sync, workdir, i18n)
- [x] **Phase 3**: Renderer 提取测试 (renderer-helpers: 117 tests, renderer-data: 46 tests, renderer-components: 28 tests) + DOM 测试 (19) + 通用逻辑测试 (state/empty-data/loading) + 性能基准 (11 benchmarks) + 性能 E2E (5 metrics)
- [ ] **Phase 4**: CI 集成 + 覆盖率报告 + 性能基线

### 目标架构

```
┌─────────────────────────────────────────────────────┐
│                   CI Pipeline                        │
├──────────┬──────────┬──────────┬────────────────────┤
│ Rust     │ Node.js  │ E2E      │ Renderer           │
│ 后端测试 │ 共享模块 │ (Playwright)│ 逻辑测试 (jsdom) │
│ 186 tests│ ~existing│ 8 场景   │ 362 tests          │
└──────────┴──────────┴──────────┴────────────────────┘
```

### 设计原则

- **E2E 少而精**: 覆盖关键用户路径 (首次安装→扫描→看数据→同步), 数量少但价值高
- **Renderer 逻辑测试多而快**: 补充 UI 逻辑的边界 case (状态切换、空数据、加载态), 跑得快可以多写
- **性能测试独立**: 界面响应速度、渲染帧率、内存占用等性能指标单独度量

---

## 2. Layer 1: E2E 测试 (Playwright)

### 2.1 技术选型

| 选项 | 选择 | 理由 |
|---|---|---|
| 框架 | **Playwright** | 原生支持 Tauri (Chromium WebView), 跨平台, 自动等待 |
| 运行方式 | `npx tauri dev` 启动后连接 | 利用 Tauri 开发模式, 侧载 sidecar |
| 断言 | Playwright 自带 `expect` | 与 Playwright API 无缝集成 |

### 2.2 环境配置

```js
// playwright.config.js
export default {
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 1,
  use: {
    // Tauri dev 模式的 WebView 端口 (通过 TAURI_DEV_HOST 配置)
    baseURL: 'http://localhost:1420',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop'] } },
  ],
  webServer: {
    command: 'npx tauri dev --no-watch',
    port: 1420,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
};
```

### 2.3 关键用户路径 (E2E 场景)

#### 场景 1: 首次安装 → 向导完成

```
1. 启动应用 (无 config)
2. 验证向导弹出 (wizard-overlay 可见)
3. 点击 "创建新身份" (wizard-create-identity)
4. 输入昵称 (wizard-nickname)
5. 点击 "下一步" (wizard-next-0)
6. 验证数据源页面 (wizard-source-list 有内容)
7. 点击 "下一步" (wizard-next-1)
8. 验证摘要页面 (wizard-summary-nickname 显示昵称)
9. 点击 "开始使用" (wizard-start)
10. 验证向导关闭, 主界面显示
```

**验证点:**
- `#wizard-overlay` 在步骤 9 后隐藏
- `#overview` screen 变为 active
- `#my-identity-name` 显示设置的昵称

#### 场景 2: 扫描 → 查看用量数据

```
1. 完成向导 (或已有 config)
2. 等待扫描完成 (scanRunning === false)
3. 验证 #today-total 显示非零 token 数
4. 验证 #overview-input-tokens 有值
5. 验证 #overview-output-tokens 有值
6. 验证 #provider-list 有内容
7. 验证 #model-list 有内容
8. 验证 #workdir-list 有内容
```

**验证点:**
- token 数字格式正确 (非 NaN, 非负)
- provider/model/workdir 列表至少有一项
- 趋势图 (overview-trend) 有 bar 元素

#### 场景 3: 范围切换 (Today/7d/30d/ALL)

```
1. 在 overview 页面
2. 点击 "7d" range 按钮
3. 验证 #today-total 数值变化 (或保持)
4. 点击 "30d" range 按钮
5. 验证数据刷新
6. 点击 "ALL" range 按钮
7. 验证数据刷新
8. 点击 "Today" 回到初始状态
```

**验证点:**
- range 按钮 `.active` class 正确切换
- 数据在切换后更新 (textContent 变化或保持合理值)

#### 场景 4: 导航切换

```
1. 点击侧栏 "Workdirs" 导航
2. 验证 workdirs screen 为 active
3. 验证 workdirs 列表有内容
4. 点击侧栏 "Sources" 导航
5. 验证 sources screen 为 active
6. 验证 provider health 信息显示
7. 点击侧栏 "Settings" 导航
8. 验证 settings screen 为 active
9. 验证 nickname 输入框有值
10. 点击侧栏 "Overview" 回到首页
```

**验证点:**
- `data-section` 导航按钮 `.active` 状态正确
- 各 screen 的 `.active` class 正确切换
- 每个 screen 有预期的 DOM 元素

#### 场景 5: 设置编辑与保存

```
1. 导航到 Settings
2. 修改 nickname 输入框
3. 验证 save 按钮变为 .has-unsaved 状态
4. 点击保存
5. 验证 toast 显示成功消息
6. 验证 save 按钮恢复非 dirty 状态
```

**验证点:**
- dirty tracking 正确触发
- 保存后 config 更新
- toast 通知出现

#### 场景 6: 同步流程

```
1. 配置 apiBaseUrl (如有测试服务器)
2. 点击 "立即同步" 按钮
3. 验证同步状态文本更新
4. 等待同步完成
5. 验证 last-sync-at 显示时间
```

**验证点:**
- 同步按钮在进行中 disabled
- 状态文本从 "同步中..." 变为完成时间
- 无 JS 错误

#### 场景 7: Workdir 别名编辑

```
1. 导航到 Workdirs 页面
2. 点击某个 workdir 卡片打开详情 drawer
3. 在别名输入框输入新别名
4. 失焦触发保存
5. 重新打开同一 workdir
6. 验证别名已持久化
```

**验证点:**
- drawer 正确打开 (`.is-open`)
- 别名输入框显示保存后的值
- 关闭动画正常

#### 场景 8: 语言切换

```
1. 在 Settings 页面
2. 切换语言选择器到 English
3. 验证页面文本变为英文
4. 切换回 中文
5. 验证页面文本恢复中文
```

**验证点:**
- `data-i18n` 元素文本正确更新
- `document.documentElement.lang` 属性变化
- 刷新后语言保持

### 2.4 E2E 辅助工具

```js
// tests/e2e/helpers.js

// 等待扫描完成
export async function waitForScanComplete(page, timeout = 30_000) {
  await page.waitForFunction(() => {
    const total = document.querySelector('#today-total');
    return total && total.textContent.trim() !== '0' && total.textContent.trim() !== '-';
  }, { timeout });
}

// 等待向导出现
export async function waitForWizard(page) {
  await page.waitForSelector('#wizard-overlay:not([hidden])', { timeout: 10_000 });
}

// 导航到指定页面
export async function navigateTo(page, section) {
  await page.click(`[data-section="${section}"]`);
  await page.waitForSelector(`#${section}.screen.active`);
}

// 读取 token 数值
export async function getTokenValue(page, selector) {
  const text = await page.textContent(selector);
  return parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
}
```

---

## 3. Layer 2: Renderer 逻辑测试 (jsdom)

### 3.1 技术选型

| 选项 | 选择 | 理由 |
|---|---|---|
| 框架 | **Vitest** | 快速, 原生 ESM, jsdom 内置, 与现有 c8 兼容 |
| 环境 | **jsdom** | 轻量, 无需浏览器, 适合 DOM 逻辑测试 |
| Mock | **vi.fn() / vi.mock()** | 内置 mock, 替换 `window.tokenLeague` |

### 3.2 环境配置

```js
// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/renderer/**/*.test.js'],
    globals: true,
    setupFiles: ['tests/renderer/setup.js'],
    coverage: {
      provider: 'v8',
      include: ['src/desktop/renderer.js', 'src/shared/**/*.js'],
    },
  },
});
```

```js
// tests/renderer/setup.js
// Mock window.tokenLeague (Tauri bridge)
const mockApi = {
  getConfig: vi.fn().mockResolvedValue({}),
  updateConfig: vi.fn().mockResolvedValue({}),
  initConfig: vi.fn().mockResolvedValue({}),
  startUsageScan: vi.fn().mockResolvedValue({ status: 'idle' }),
  usageScanStatus: vi.fn().mockResolvedValue({ status: 'idle' }),
  usageSummary: vi.fn().mockResolvedValue({ totals: { totalTokens: 0 } }),
  usageTrend: vi.fn().mockResolvedValue({ items: [] }),
  usageWorkdirs: vi.fn().mockResolvedValue({ items: [] }),
  providerHealth: vi.fn().mockResolvedValue([]),
  backgroundStatus: vi.fn().mockResolvedValue({}),
  getMyIdentity: vi.fn().mockResolvedValue({ participantId: 'p_test' }),
  appVersion: vi.fn().mockResolvedValue({ clientAppVersion: '0.7.0', clientPlatform: 'darwin-arm64', runtime: 'rust-tauri' }),
  checkUpdate: vi.fn().mockResolvedValue(null),
  logEvent: vi.fn(),
  onNavigateSection: vi.fn(),
  onTrayRefreshStart: vi.fn(),
  onTrayRefreshDone: vi.fn(),
  onTrayRefreshFailed: vi.fn(),
  onUpdateProgress: vi.fn(),
  onInstallerProgress: vi.fn(),
};

globalThis.window.tokenLeague = mockApi;
```

### 3.3 测试用例分组

> **实现**: `renderer-dom.test.js` 通过完整 DOM fixture (复制 index.html 结构) + `makeMockApi()` 工厂函数, 测试 renderer.js 的真实 DOM 行为: selectSection、renderConfig、renderToday、renderWorkdirs、toast、wizard、range 切换、dirty state、provider toggle、drawer 开关。

#### A. 状态切换测试

| 用例 | 描述 | 验证点 |
|---|---|---|
| `scan state toggle` | `setScanState(true)` → `setScanState(false)` | `scanRunning` 值, refresh 按钮 disabled 状态 |
| `overview range switch` | 切换 overviewRange | `overviewRange` 值变化, render 触发 |
| `sources tab switch` | 切换 sourcesProviderTab | tab 按钮 active 状态, 列表内容变化 |
| `settings tab switch` | 切换 settings tab | tab 面板显示/隐藏 |
| `wizard step navigation` | wizardGo(0→1→2→0) | `.wizard-step` active 状态, `.wizard-step-dot` 状态 |
| `trend mode toggle` | 切换 chart/table 模式 | trendMode 值, 对应 UI 元素显示 |

#### B. 空数据/边界测试

| 用例 | 描述 | 验证点 |
|---|---|---|
| `empty usage render` | latestUsage = [] | #today-total 显示 "0" 或 "-", 列表为空 |
| `zero token items` | 所有 item totalTokens=0 | 不显示 NaN, 百分比不为 NaN |
| `null config fields` | config 字段为 null/undefined | 不 crash, 显示默认值 |
| `missing price map` | serverPriceMap = null | cost 显示 "-", 不 crash |
| `single item list` | 只有 1 个 provider/model | 正常渲染, 不显示 "top 0" |
| `large dataset (5000)` | allUsage 有 5000 项 | 不卡顿, 虚拟滚动启用 |
| `unknown command response` | api 返回 {ok:false} | error toast 显示, UI 不 crash |

#### C. 加载态测试

| 用例 | 描述 | 验证点 |
|---|---|---|
| `initial boot loading` | boot() 执行中 | loading 状态正确显示 |
| `scan in progress` | startUsageScan 返回 running | scan 动画/状态显示 |
| `scan poll completion` | poll 返回 complete | 数据渲染, toast 显示 |
| `sync in progress` | startUsageSync 执行中 | sync 按钮 disabled, 状态文本 |
| `update downloading` | downloadUpdate 执行中 | 进度条显示, 按钮 disabled |
| `background status loading` | backgroundStatus 延迟返回 | 不阻塞 UI, 去重生效 |

#### D. 数据渲染正确性测试

| 用例 | 描述 | 验证点 |
|---|---|---|
| `token formatting` | formatTokenCompact(1234567) | 中文 "123.5万", 英文 "1.2M" |
| `cost formatting` | formatUsd(0.05) | "$0.05" |
| `cost null` | formatUsd(null) | "-" |
| `composition percentages` | 3 项 composition | 百分比总和 ≈ 100% |
| `trend grouping by day` | groupByGrain(items, 'day') | 每天一行, token 累加正确 |
| `trend grouping by week` | groupByGrain(items, 'week') | 周起始日正确 (周一) |
| `workdir hash stability` | 相同路径相同 participantId | hash 一致 |
| `provider name mapping` | providerId → 显示名 | codex_local → "Codex" |

#### E. 事件处理测试

| 用例 | 描述 | 验证点 |
|---|---|---|
| `nav click handler` | 点击 data-section 按钮 | 正确 screen 切换 |
| `escape key closes modal` | 按 Escape | 打开的 modal/drawer 关闭 |
| `alias input blur saves` | 别名输入失焦 | api.setWorkdirAlias 被调用 |
| `source toggle optimistic` | 点击 source 开关 | UI 立即更新, API 调用 |
| `source toggle revert on error` | API 返回错误 | UI 回滚到之前状态 |
| `dirty state tracking` | 修改 nickname | .has-unsaved class 出现 |
| `save clears dirty` | 保存成功 | .has-unsaved class 移除 |

#### F. 去重/防抖逻辑测试

| 用例 | 描述 | 验证点 |
|---|---|---|
| `scan poll dedup` | 连续调用 pollUsageScan() | 只有一个 in-flight 请求 |
| `background status dedup` | 连续调用 loadBackgroundStatus() | 后续调用排队, 不重复请求 |
| `usage query generation` | 快速切换 range | 旧 generation 结果被丢弃 |
| `tray cost key dedup` | 相同 cost 数据 | api.updateTrayCost 不重复调用 |
| `pricing refresh dedup` | 连续调用 refreshPricing() | 只执行一次 |

### 3.4 共享模块测试 (补充现有 run-tests.js)

Vitest 可直接测试 `src/shared/` 的纯函数, 比 run-tests.js 更快且支持 watch 模式:

| 模块 | 补充测试 |
|---|---|
| `pricing.js` | `estimateUsageCost` 边界: 零 token, 负值, null priceMap |
| `schema.js` | `assertUsageItem` 缺失字段, `publicUsageItem` forbidden field 剥离 |
| `composition.js` | `dominantComposition` 全零, 单项 100%, `compositionRatio` 除零 |
| `display.js` | `formatTokenCompact` 极大值 (>1亿), 零值, 负值 |
| `date.js` | `daysBetween` 跨月, 跨年, 同一天 |
| `crypto.js` | `generateIdentity` 格式, `signPayload`/`verifyPayload` 交叉验证 |
| `update.js` | `validateInstallerMetadata` 缺失字段, `updateStateFromManifest` 各种状态 |

---

## 4. 性能测试

### 4.1 性能指标定义

| 指标 | 目标值 | 测量方式 |
|---|---|---|
| **首次渲染时间 (FCP)** | < 1.5s | Performance Observer `first-contentful-paint` |
| **扫描完成→数据渲染** | < 500ms | `performance.now()` 打点 |
| **范围切换响应** | < 100ms | click → DOM 更新完成 |
| **趋势图渲染 (1000 项)** | < 200ms | `performance.now()` 打点 |
| **虚拟滚动帧率** | > 30fps | `requestAnimationFrame` 计数 |
| **内存占用 (稳态)** | < 150MB | `performance.memory.usedJSHeapSize` |
| **innerHTM 更新 (50 项列表)** | < 50ms | `performance.now()` 打点 |
| **启动→可交互** | < 3s | Tauri window ready → boot() 完成 |

### 4.2 性能测试方法

#### 方法 1: Vitest 性能基准 (自动化)

```js
// tests/renderer/perf/rendering.bench.js
import { bench, describe } from 'vitest';

describe('renderToday performance', () => {
  // 准备: 1000 项 usage 数据
  const items = generateMockUsageItems(1000);

  bench('renderToday with 1000 items', () => {
    // 设置全局状态
    latestUsage = items;
    allUsage = items;
    // 调用渲染
    renderToday();
  });

  bench('renderOverviewTrend with 30 bars', () => {
    const trendItems = generateTrendItems(30);
    renderOverviewTrend(trendItems);
  });
});

describe('data grouping performance', () => {
  const items = generateMockUsageItems(5000);

  bench('groupByGrain day (5000 items)', () => {
    groupByGrain(items, 'day');
  });

  bench('groupByGrain week (5000 items)', () => {
    groupByGrain(items, 'week');
  });

  bench('groupTrend (5000 items)', () => {
    groupTrend(items);
  });

  bench('groupWorkdirDetails (5000 items)', () => {
    groupWorkdirDetails(items);
  });
});

describe('formatting performance', () => {
  bench('formatTokenCompact x10000', () => {
    for (let i = 0; i < 10000; i++) {
      formatTokenCompact(i * 1234);
    }
  });

  bench('formatUsd x10000', () => {
    for (let i = 0; i < 10000; i++) {
      formatUsd(i * 0.001);
    }
  });
});
```

#### 方法 2: Playwright 性能度量 (E2E)

```js
// tests/e2e/perf/responsiveness.spec.js
import { test, expect } from '@playwright/test';

test('range switch response time < 100ms', async ({ page }) => {
  // 等待初始加载完成
  await waitForScanComplete(page);

  const start = await page.evaluate(() => performance.now());
  await page.click('[data-range="7d"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('#today-total');
    return el && el.textContent.trim() !== '0';
  });
  const elapsed = await page.evaluate(() => performance.now()) - start;

  expect(elapsed).toBeLessThan(100);
  console.log(`Range switch: ${elapsed.toFixed(1)}ms`);
});

test('boot to interactive < 3s', async ({ page }) => {
  const start = Date.now();
  await page.waitForSelector('#overview.screen.active');
  const elapsed = Date.now() - start;

  expect(elapsed).toBeLessThan(3000);
  console.log(`Boot to interactive: ${elapsed}ms`);
});

test('scan complete to render < 500ms', async ({ page }) => {
  // 触发扫描
  await page.click('#brand-refresh');

  // 测量从扫描完成到数据渲染的时间
  const renderTime = await page.evaluate(() => {
    return new Promise(resolve => {
      const observer = new MutationObserver((mutations, obs) => {
        const total = document.querySelector('#today-total');
        if (total && total.textContent.trim() !== '0') {
          obs.disconnect();
          resolve(performance.now());
        }
      });
      observer.observe(document.querySelector('#today-total'), { childList: true });
    });
  });

  console.log(`Scan→render: ${renderTime.toFixed(1)}ms`);
  expect(renderTime).toBeLessThan(500);
});

test('virtual scroll maintains > 30fps', async ({ page }) => {
  // 导航到有大量 model detail 的趋势详情
  // ... 触发虚拟滚动 ...

  const fps = await page.evaluate(async () => {
    let frames = 0;
    const start = performance.now();

    return new Promise(resolve => {
      function count() {
        frames++;
        if (performance.now() - start < 1000) {
          requestAnimationFrame(count);
        } else {
          resolve(frames);
        }
      }
      requestAnimationFrame(count);
    });
  });

  expect(fps).toBeGreaterThan(30);
  console.log(`Virtual scroll FPS: ${fps}`);
});
```

#### 方法 3: 内存监控 (E2E)

```js
test('memory stays under 150MB after extended use', async ({ page }) => {
  await waitForScanComplete(page);

  // 模拟用户操作: 切换范围、打开 drawer、切换页面
  for (let i = 0; i < 10; i++) {
    await page.click('[data-range="7d"]');
    await page.waitForTimeout(200);
    await page.click('[data-range="30d"]');
    await page.waitForTimeout(200);
    await page.click('[data-range="all"]');
    await page.waitForTimeout(200);
    await page.click('[data-range="today"]');
    await page.waitForTimeout(200);
  }

  const memory = await page.evaluate(() => {
    return performance.memory?.usedJSHeapSize || 0;
  });

  if (memory > 0) {
    const mb = memory / 1024 / 1024;
    console.log(`Memory: ${mb.toFixed(1)}MB`);
    expect(mb).toBeLessThan(150);
  }
});
```

### 4.3 性能测试运行

```bash
# Vitest 性能基准 (本地)
npx vitest bench --config vitest.config.js

# Playwright 性能测试 (本地)
npx playwright test tests/e2e/perf/ --reporter=list

# CI 中: 性能测试结果写入 JSON, 与基线比较
npx vitest bench --reporter=json > perf-results.json
```

---

## 5. 工具链与依赖

### 5.1 新增依赖

```json
{
  "devDependencies": {
    "@playwright/test": "^1.60.0",   // ✅ 已安装
    "vitest": "^4.1.7",              // ✅ 已安装
    "@vitest/coverage-v8": "^4.1.7", // ✅ 已安装
    "jsdom": "^29.1.1"               // ✅ 已安装
  }
}
```

### 5.2 npm scripts

```json
{
  "scripts": {
    "test:ui": "vitest run --config vitest.config.js",
    "test:ui:watch": "vitest --config vitest.config.js",
    "test:ui:coverage": "vitest run --config vitest.config.js --coverage",
    "test:ui:bench": "vitest bench --config vitest.config.js",
    "test:e2e": "playwright test --config=playwright.mock.config.js",
    "test:e2e:mock": "playwright test --config=playwright.mock.config.js",
    "test:e2e:mock:headed": "playwright test --config=playwright.mock.config.js --headed",
    "test:e2e:tauri": "playwright test"
  }
}
```

### 5.3 目录结构

```
tests/
├── run-tests.js                    # 现有 Node.js 后端测试
├── renderer/                       # Layer 2: jsdom 逻辑测试
│   ├── setup.js                    # Vitest setup (mock bridge + custom matchers)
│   ├── renderer-dom.test.js        # renderer.js DOM 行为测试 (19 tests)
│   ├── renderer-helpers.test.js    # **核心** 纯函数测试 (117 tests)
│   ├── renderer-data.test.js       # 数据变换测试 (46 tests)
│   ├── renderer-components.test.js # HTML 组件测试 (28 tests)
│   ├── state.test.js               # 状态切换测试
│   ├── empty-data.test.js          # 空数据/边界测试
│   ├── loading.test.js             # 加载态测试
│   ├── shared/                     # 共享模块测试
│   │   ├── pricing.test.js
│   │   ├── composition.test.js
│   │   ├── display.test.js
│   │   ├── date.test.js
│   │   ├── schema.test.js
│   │   ├── crypto.test.js
│   │   ├── i18n.test.js
│   │   └── version.test.js
│   └── perf/
│       └── rendering.bench.js      # Vitest 性能基准 (11 benchmarks)
├── e2e/                            # Layer 1: Playwright E2E
│   ├── helpers.js                  # 共享辅助函数
│   ├── onboarding.spec.js          # 场景 1: 首次安装
│   ├── scan-and-view.spec.js       # 场景 2: 扫描→看数据
│   ├── range-switch.spec.js        # 场景 3: 范围切换
│   ├── navigation.spec.js          # 场景 4: 导航切换
│   ├── settings.spec.js            # 场景 5: 设置编辑
│   ├── sync.spec.js                # 场景 6: 同步流程
│   ├── workdir-alias.spec.js       # 场景 7: 别名编辑
│   ├── i18n.spec.js                # 场景 8: 语言切换 (en)
│   ├── i18n-zh.spec.js             # 场景 8b: 中文渲染
│   ├── scan-async.spec.js          # 异步扫描 running→done
│   ├── empty-data.spec.js          # 空数据场景
│   ├── error-states.spec.js        # API 错误场景
│   ├── large-dataset.spec.js       # 大数据集 (1000 rows)
│   ├── workflows.spec.js           # 产品工作流 (toggle/reset/backup/update)
│   └── perf/
│       └── responsiveness.spec.js  # 性能度量 + 性能预算
└── output/                         # 测试产物 (gitignore)
    ├── coverage/                   # Vitest 覆盖率
    └── playwright/                 # Playwright traces/screenshots
```

---

## 6. CI 集成

### 6.1 GitHub Actions 工作流

```yaml
# .github/workflows/ui-tests.yml
name: UI Tests

on: [push, pull_request]

jobs:
  renderer-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run test:ui
      - run: npm run test:ui:coverage
      - uses: codecov/codecov-action@v4
        with:
          files: tests/output/coverage/coverage-final.json
          flags: renderer

  e2e-tests:
    runs-on: macos-latest  # Tauri 需要 macOS
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable
      - name: Install Playwright browsers
        run: npx playwright install chromium
      - name: Build Tauri (dev)
        run: npx tauri build --debug
      - name: Run E2E tests
        run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/

  perf-tests:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run test:ui:bench -- --reporter=json > bench-results.json
      - name: Upload benchmark results
        uses: actions/upload-artifact@v4
        with:
          name: bench-results
          path: bench-results.json
```

### 6.2 性能基线比较

```js
// scripts/compare-bench.js
// 比较当前 benchmark 结果与基线, 超过 20% 回归则失败
const current = JSON.parse(fs.readFileSync('bench-results.json'));
const baseline = JSON.parse(fs.readFileSync('bench-baseline.json'));

for (const suite of current.testResults) {
  const base = baseline.testResults.find(b => b.name === suite.name);
  if (!base) continue;

  const regression = (suite.mean - base.mean) / base.mean;
  if (regression > 0.20) {
    console.error(`REGRESSION: ${suite.name} +${(regression * 100).toFixed(1)}%`);
    process.exit(1);
  }
}
```

---

## 7. 测试用例清单

### E2E (Playwright) — 8 场景

| # | 场景 | 优先级 | 预计耗时 |
|---|---|---|---|
| 1 | 首次安装→向导完成 | P0 | 15s |
| 2 | 扫描→查看用量数据 | P0 | 20s |
| 3 | 范围切换 (Today/7d/30d/ALL) | P1 | 10s |
| 4 | 导航切换 (4 个页面) | P1 | 10s |
| 5 | 设置编辑与保存 | P1 | 10s |
| 6 | 同步流程 | P2 | 15s |
| 7 | Workdir 别名编辑 | P2 | 10s |
| 8 | 语言切换 | P2 | 8s |

### Renderer 逻辑 (Vitest) — ~30 用例

| 分组 | 用例数 | 优先级 |
|---|---|---|
| 状态切换 | 6 | P0 |
| 空数据/边界 | 7 | P0 |
| 加载态 | 6 | P1 |
| 数据渲染正确性 | 8 | P0 |
| 事件处理 | 7 | P1 |
| 去重/防抖 | 5 | P1 |

### 性能基准 (Vitest bench) — ~6 基准

| 基准 | 目标 |
|---|---|
| renderToday (1000 项) | < 200ms |
| renderOverviewTrend (30 bars) | < 50ms |
| groupByGrain day (5000 项) | < 100ms |
| groupTrend (5000 项) | < 150ms |
| formatTokenCompact x10000 | < 50ms |
| formatUsd x10000 | < 50ms |

### 性能 E2E (Playwright) — ~5 度量

| 度量 | 目标 |
|---|---|
| 启动→可交互 | < 3s |
| 范围切换响应 | < 100ms |
| 扫描→数据渲染 | < 500ms |
| 虚拟滚动帧率 | > 30fps |
| 内存占用 (稳态) | < 150MB |

---

## 实施顺序

1. **Phase 1**: 安装 Vitest + 配置 → 编写 Renderer 逻辑测试 (状态切换 + 空数据 + 渲染正确性)
2. **Phase 2**: 安装 Playwright + 配置 → 编写 E2E 场景 1-4 (核心路径)
3. **Phase 3**: 补充 E2E 场景 5-8 + 性能基准 + 性能 E2E
4. **Phase 4**: CI 集成 + 覆盖率报告 + 性能基线
