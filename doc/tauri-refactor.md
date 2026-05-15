**目标**
将 AI Token League 桌面端完整迁移到 Tauri，并在迁移完成后以 Tauri 作为唯一桌面客户端运行时、打包系统和更新系统。Electron 相关运行入口、依赖、打包脚本、更新逻辑、安装器链路和文档全部退出主线。

> **Status: COMPLETE** — Migration finished 2026-05-14. Electron removed, Tauri is sole desktop runtime.

**成功标准**
迁移完成后，Tauri 客户端必须完整承接现有 Electron 客户端能力：

- 桌面 UI、配置向导、Overview、Workdirs、Sources、Settings、语言切换全部可用。
- 本地身份、配置导入导出、诊断导出、重置本地数据、重置云端关联逻辑保持一致。
- Codex、Claude Code、Cursor 数据扫描结果与迁移前 Electron 版本一致。
- token total、cache read/write、estimated cost、provider/model/workdir 统计口径不变。
- 手动扫描、后台刷新、手动同步、上传队列、失败重试、离线队列行为不变。
- 托盘菜单、窗口关闭常驻、退出、打开云端、立即刷新等桌面行为不降级。
- Tauri updater 完整替代 `electron-updater` 和自研 macOS zip updater。
- 发布脚本只生成 Tauri app、Tauri installer、Tauri updater metadata 和下载页 installer metadata。
- Web 下载页、`/api/release/config`、OSS 发布目录改为 Tauri 产物口径。
- Electron 依赖、`electron-builder`、`electron-packager`、`electron-updater`、Electron preload/IPC 入口从主线移除。
- 文档、README、AGENTS、packaging、operations、smoke checklist 全部改为 Tauri 口径。

**迁移边界**
本次迁移只替换桌面端运行时和发布体系，不改变后端业务 API、排行榜规则、上传签名协议、隐私边界、数据库结构和公开 Web 主流程。

采集核心可以阶段性保留现有 Node 实现，但最终桌面主入口必须是 Tauri。若使用 Node sidecar，必须明确它是桌面采集运行时的一部分，而不是继续保留 Electron。

**必须删除或替换的 Electron 资产**
迁移完成后，以下内容不能继续作为主线能力存在：

- `npm run desktop`
- `npm run desktop:smoke` 的 Electron 实现
- `src/desktop/main.cjs`
- `src/desktop/preload.cjs`
- Electron IPC contract
- `electron-updater`
- `electron-packager`
- `electron-builder`
- `electron-builder.yml`
- Electron DMG / NSIS 打包说明
- `latest.yml` / `latest-mac.yml` Electron updater 契约
- macOS custom zip updater 的 Electron 运行逻辑
- 文档中“Electron desktop app”的产品描述

**推荐实现路径**
1. 建立 Tauri app shell，复用现有 HTML/CSS/renderer UI。
2. 用 Tauri command 替代 Electron preload 暴露的 `window.tokenLeague` API。
3. 把配置、扫描、同步、诊断、更新、托盘、文件选择、打开外链等能力迁入 Tauri backend。
4. 接入 `tauri-plugin-updater`，生成签名更新包和 Tauri updater JSON。
5. 重写 `scripts/release.sh` 和 `scripts/publish-release.js`，只发布 Tauri 产物。
6. 更新 Web 下载页 installer metadata，使其只展示 Tauri 安装包。
7. 移除 Electron 依赖和打包配置。
8. 按迁移前 Electron 行为做全量对照验证。
9. 更新所有项目文档，将桌面运行时基线切到 Tauri。
10. 完成一次当前平台安装包构建和 updater dry run。

**验收验证**
必须至少完成：

- `npm test`
- Tauri dev 启动验证
- Tauri 当前平台 build 验证
- 当前平台安装包启动验证
- updater metadata dry run
- 下载页 installer metadata 验证
- 同一份本地数据下，Tauri 扫描结果与迁移前 Electron 基线一致
- 同一配置下，Tauri 同步请求和服务端入库结果一致
- 诊断导出敏感字段检查
- 托盘、后台刷新、手动同步、重置、导入导出、语言切换手测

**一句话版本**
将 AI Token League 桌面端从 Electron 完整替换为 Tauri，移除 Electron 运行时、打包和更新链路，在不改变采集统计、隐私模型和后端协议的前提下，由 Tauri 独立承接桌面 UI、系统能力、发布安装和热更新。