# Repo 熵治理报告 — 2026-09-23

- Repo：`/Users/sky/develop/source/token-mac-windows-ai-codex-claude`（branch `develop`）
- 扫描开始时 `git status --short`：干净（0 条目）
- 自动扫描：`scan_repo_entropy.py`（原始 finding 127 条），人工复核后有效 finding 收敛为本报告所列
- 本轮模式：用户明确要求清理 → P0 运行态垃圾 + 最小 P1 切片已执行，其余只报告

## 扫描覆盖范围

- 文档熵：自动扫描文档入口/链接/摆放/绝对路径；人工核对 `doc/README.md`、`AGENTS.md`、`README.md`、`CLAUDE.md` 四个入口对 `doc/` 全部 60+ 文件的索引覆盖（逐文件 grep 文件名）。
- 代码熵：TODO/FIXME 密度浅扫 + 人工判定归属（vendored 库 / 任务文档有意标记）。
- 运行熵：`find` 全仓 `.DS_Store`；根目录与 `doc/` 下 `*.log`/`*.pid`；全部 `.tmp*` 目录逐一开箱检查内容、大小、日期；pid 文件逐一 `ps` 验证进程已死；`tests/output/` 逐目录 `du` 并核对文档引用。
- 结构熵：`AGENTS.md` 业务地图与 scripts 表核对 `scripts/` 全部 23 个脚本的实际归属（`package.json`、`.github/workflows/release.yml`、`tests/run-tests.js`、doc 引用逐个 grep）。
- 排除（按策略不属于垃圾候选）：`node_modules/`、`src-tauri/target/`、`dist/`、`tests/output/coverage/`、`tests/output/playwright/` 等构建产物与依赖缓存。

### 判定为噪音的自动 finding（不进入候选）

- 78 条 "legacy doc/ 活跃候选"：本仓库 `AGENTS.md` Documentation Rules 明确 `doc/` 就是活跃文档根目录，非 legacy 摆放错误。
- 根目录 `CHANGELOG*.md`、`README.en.md`：发布流程与 README 规则明确要求根目录维护。
- 根目录 `playwright.config.js`、`playwright.mock.config.js`、`vitest.config.js`：Playwright/Vitest 工具标准位置，npm scripts 直接引用。
- `scripts/` 目录下已被 AGENTS.md 表格收录的脚本。

## 本轮已执行清理

### 1. P0 运行态垃圾删除（全部为 gitignored 未跟踪文件）

删除前已验证：pid 文件指向的进程全部不存在；`doc/`、`scripts/`、`AGENTS.md`、tests 对这些路径零引用。

| 路径 | 证据 | 判定 |
| --- | --- | --- |
| 7 × `.DS_Store`（根、`src/`、`doc/`、`collector-core/`、`.git/`、`dist/`、`.tmp-full-reconcile/`） | Finder 系统产物 | 垃圾 |
| `server.log` | 9 月 16 日本地后端运行日志，2KB | 垃圾 |
| `doc/runtime.2026-06-22.log` | 放错位置的桌面运行日志（6 月） | 垃圾 |
| 6 × `.tmp-server-env-test*.{log,pid}` | 5 月 25 日 env 加载测试残留，pid 已死 | 垃圾 |
| `.tmp/`（release 日志，5 月）、`.tmp-codex-logs/`（构建日志，5 月）、`.tmp-full-reconcile/`（隔离测试环境，5 月）、`.tmp-scratch/`（SVG 草稿，5 月）、`.tmp-web-ui/`（测试环境，9 月 10 日）、`.tmp-perf/`（8.2MB 主题 walkthrough 截图，9 月 13 日）、`.tmp-release-check/`（空目录，5 月） | 合计约 8.4MB，全部为 `.tmp*` gitignore 约定下的临时产物 | 垃圾 |

### 2. 孤儿脚本移除（P1，git 可恢复）

- `scripts/capture_cards.js`：`git rm`。全仓（package.json / CI / tests / docs / scripts）零引用的一次性分享卡截图脚本（snake_case 命名，产出物写 `artifacts/share-cards`）。已通过全仓 grep 验证无任何引用。

### 3. 索引与表格补录（P1 小补丁）

- `AGENTS.md` Scripts Directory 表补录 6 个在役但未登记的脚本：`build-release-body.js`、`build-github-tauri-update-json.js`（CI 引用）、`generate-tray-icons.js`（`npm run icons:tray`）、`query-usage-daily.js`（operations.md 引用）、`verify-ccusage.mjs`、`verify-dsh.mjs`（npm scripts 引用）。AGENTS.md 自身要求 "Reflect new scripts here when adding operational entrypoints"，此为还账。
- `doc/README.md` 新增 Designs 与 Handoffs and Historical Records 两节，补录 25 个此前无任何入口引用的文档（含 3 个 provider 设计、4 个 handoff 事故/修复记录、2 个历史重构方案等）。消除断链入口。

## 报告项（本轮未动）

### 运行熵

- **`tests/output/` 337MB 本地证据堆积** [P1，需用户决策]
  - 证据：`du -sh tests/output` = 337M；gitignored（`.gitignore:57`），tracked count = 0。
  - 构成：compute-sharing 系列验收/盲评/r3 评审证据（`compute-sharing-review-r3/` 约 90M，含 prior-dist 39M、打包 artifacts 29M、UI traces 21M、fixes.patch），被 `doc/compute-sharing-acceptance-*.md` 等在册文档引用，且属当前活跃特性（最新提交均为此特性）——**必须保留**；Aug 25 批次 UI 评审截图约 40 张（`ui-deep-*`、`design-*`、`role-*`、`reuse-*` 等）；May–Jun share-card 截图 3 张；两个 acceptance zip 与一个 evidence tar.gz。
  - 建议：活跃特性证据原样保留；`prior-dist/`（39M 旧版本打包产物）与打包 zip/tar 可删（可由 git tag 重新构建）；历史批次截图按对应版本归档或删除。因部分文件被 `doc/ui-test-plan.md` 引用且属质量红线证据，未获确认前不删。
  - 文档摆放建议：`doc/` 中 compute-sharing 系列验收/评审文档已是事实上的"任务包 + evidence"，若后续整理可迁入 `doc/task-pack/`，需同步更新 `doc/README.md` 与互相链接，属独立小任务。

### 文档熵

- `doc/windows-network-check-report.md` [P1]：2 处 `/Users/sky/...` 本机绝对路径（指向 `atl-collector/src/sidecar.rs:1976`、`src/desktop/renderer.js:2705`）。该文档是在册的现场回传模板（活跃），建议改为仓库相对路径；小补丁，待下轮。
- `AGENTS.md` 524 行 [P1]：已从索引膨胀为手册。建议把 Release Flow / Verification Baseline 抽到 `doc/`（如 `doc/engineering.md`）并在 AGENTS.md 留链接；涉及多处交叉引用，需单独任务处理。
- `tests/output/compute-sharing-review-r3/report.md` 相对链接失效 [P2]：本地证据文件，按"不改写证据"原则只报告。
- `doc/refatcor_sync_status.md` 文件名拼写错误（refactor）[P2]：重命名收益低于链接更新成本，保持原样。

### 代码熵

- `src/desktop/vendor/html2canvas.js` TODO 密度 [噪音]：vendored 第三方库，不属于本仓技术债。
- `doc/0.6/0.7-development-tasks.md`、`doc/roadmap.md` 中的 TODO [P2]：任务文档中的有意状态标记，随版本迭代消化。

### 结构熵

- `AGENTS.md` 无独立"公共基建边界"章节 [P2]：`src/shared/` 已在 Repository Layout 覆盖，当前规模下影响低。
- api-test 关联：不适用（本仓非 control 多仓工作区）。

## 本期不动清单（P2）

- `tests/output/` 内任何证据文件（含可重建的打包产物，见上）
- `doc/` 历史基线、handoff、事故记录文档的移动/重命名
- vendor 库与任务文档内的 TODO
- `doc/compute-sharing*.md` 系列的历史层级关系（以 usability design 为准的口径已在 `doc/README.md` 标注）

## 追加：构建产物清理（同日，用户指定查看 target）

构建产物默认不在垃圾候选范围（可再生），本轮应用户明确要求单独处理。

### 构成分析（清理前）

- `target/` = 15GB，全部为 debug 开发缓存：`incremental/` 约 9.7G（245 个编译代际，均为近 30 天内产生）+ `deps/` 约 5-7G + `build/` 267M。**无任何 release 产物**（`src-tauri/target/` 不存在，AGENTS.md 中的 bundle 路径当前为空）。
- `dist/` = 50M：**当天构建的 0.7.18 RC 发布产物**（zip/app/dmg/updater tar+sig），保留不动。
- 磁盘余量 95Gi，无空间压力；缓存当天仍在活跃使用（有并发构建）。

### 已执行

- 删除 `target/debug/incremental/` 中 78 个 **超过 7 天未动** 的陈旧编译代际（约 3GB，多为 compute-sharing 验收轮次的历史 session 缓存，每个 200M+）。保留近 7 天的 167 个代际和全部 `deps/`。
- 结果：`target/` 15G → 13G，磁盘可用 94Gi → 97Gi。
- 验证：`cargo check -p atl-collector` 8.7s 通过（exit 0），热缓存完好，当前开发零影响。
- 事故记录：首次删除因相对路径基准错误实际未生效（空操作，无副作用），发现后改用绝对路径重新执行成功；执行中发现仓库存在并发构建（cargo 同时回收了 deps 旧产物），已确认无进程后再执行。

### 未动与建议

- `deps/`（约 6G）与近 7 天增量缓存（约 6.7G）保留：当前日常 `cargo test`/`cargo run` 依赖热缓存，删除将触发全量重编（预计 10 分钟以上）。
- 若需一次性回收全部 13G（例如发版前）：`cargo clean`，代价是下一次构建全量重编。建议在无进行中工作的窗口执行。
- `dist/` 中 0.7.18 RC 产物在发布/上传完成后即成为可再生垃圾，可在下轮发版后清理。

## 验证（汇总）

已执行：

- 清理前：`git status --short`（干净）；pid 存活检查（全部已死）；scratch 目录引用 grep（零依赖）；`capture_cards.js` 全仓引用 grep（零引用）
- 清理后：`git status --short`（仅 `AGENTS.md`、`doc/README.md` 修改 + `scripts/capture_cards.js` 删除 + 本报告新增）；`git diff --check`；`npm test`

待验证：无。被删的未跟踪临时文件不可恢复，但均为零价值运行态产物（清单见上表）。

## 追加：老版本编译/安装产物清理（2026-09-24，用户指定"清理安装编译的老版本"）

按上轮建议执行。删除前逐项核对了在册文档引用：验收文档链接的是 `artifacts/` 内的 zip + `SHA256SUMS` + dylib + 卡片源码，不链接任何解压后的 `.app` 目录；`prior-dist/` 三份即文档自述的"旧 `dist`"，无独立证据价值，可由 git tag 重建。

### 已删除（均为 gitignored 未跟踪文件，合计约 436MB）

| 路径 | 判定依据 |
| --- | --- |
| 3 × `tests/output/compute-sharing-{review-r3,r3-rollout-20260921,same-env-20260922}/prior-dist/`（各 39M） | Sep 21 旧版本打包产物（app/tar.gz/sig/dmg），r3 构建前的旧 dist |
| 3 × 上述目录 `artifacts/` 内解压 `.app`（合计约 50M） | zip 内同字节副本仍在且被文档链接（含 SHA256SUMS），解压副本零引用 |
| `target/debug/incremental/` 中 5 个 2026-09-15 代际（269M） | 延续上轮">7 天即陈旧"策略，本轮新越线部分 |

### 保留（核对结论）

- `dist/`：0.7.18 RC 当前版发布产物（Sep 23 构建），按上轮口径待发版后再清。
- `/Applications/AI Token League.app`：已装版本 0.7.18 = 当前 package.json 版本，非老版本。
- `artifacts/` 内 zip/SHA256SUMS/dylib/卡片源码、两个 acceptance zip 与 r3 evidence tar.gz：`doc/compute-sharing-*.md` 链接的交付与验收证据。
- `target/debug` 其余缓存（deps + 近 7 天增量）：日常 `cargo test`/`cargo run` 热缓存。
- 历史验收文档中"旧 dist 移入 prior-dist 保留"等表述为当时过程记录，按"不改写证据"原则未改动。

### 验证

- 删除前 `pgrep` 确认无 cargo/rustc/tauri 构建进程（仅一个无关 Node dev server）。
- `find tests/output -name prior-dist` = 0；三个 `artifacts/` 内交付文件清单完好。
- `tests/output` 337M → 170M；`target` 释放约 269M。
- `cargo check -p atl-collector` 0.52s 通过（exit 0），热缓存完好。
- `git status --short` 与清理前一致（仅上轮遗留的 4 条记录）。

### 同日追加：target 全量清理（用户指定清理 target 与 cpa-plugin/target）

- 删除前实测：`target/` 13G + `cpa-plugin/target` 1.2G ≈ 14.2G（全仓仅此两个 target 目录）。删除前 `pgrep` 确认无构建进程、前述 Node dev server 已退出。
- 执行：绝对路径 `rm -rf` 两个 target 目录（上轮报告同日构建产物清理建议的 `cargo clean` 等价操作）。
- 结果：仓库 15G → 560M；`df /System/Volumes/Data` 可用 172Gi → 188Gi。`~/.cargo` 全局缓存仅 397M，未动。
- 验证：`cargo --version` 正常；`git status --short` 与清理前一致。**未验证项**：清理后的全量重编未执行，属预期成本（下次 `cargo check`/`cargo test`/构建将全量重编，预计 10 分钟以上，cpa-plugin 同理）。
