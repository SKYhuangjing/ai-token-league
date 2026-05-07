# AI Token League Roadmap

本文件记录产品级路线图。已进入版本基线或开发任务的能力，不再放在散列 TODO 中。

## 0.3.0 已落地

目标：让客户端、服务端和发布资源形成统一版本闭环，支持后续强制兼容窗口和可控升级。

| 能力 | 状态 | 产品结果 |
| --- | --- | --- |
| API 上报兼容校验 | DONE | 注册、usage 上报、health 都携带或返回版本/协议信息；服务端可以在入库前拒绝不兼容客户端，客户端保留上传队列。 |
| 客户端版本信息 | DONE | Desktop 和 CLI 可以展示本地版本、平台、服务端版本、最新版本和兼容状态。 |
| Desktop 自升级链路 | DONE | 客户端通过 app-server 获取 release config，再读取 manifest、选择当前平台 artifact、下载并校验 checksum。 |
| OSS 发布资源托管 | DONE | 三平台安装包、checksums 和 latest manifest 由发布脚本上传到 OSS；endpoint、bucket、prefix、AK/SK 全部通过 env 注入，不写死进代码。 |
| app-server 统一 release 数据源 | DONE | Check update 只依赖 Cloud Connection 的 app-server，不允许客户端内置 manifest URL 或读取本机 release env。 |
| 设置产品信息架构 | DONE | Settings 按 Account、Sources、Cloud、Sync、App 分域；Cloud 负责 API base URL、health、兼容和 release manifest 状态。 |
| Cursor 首装检测状态 | DONE | Sources 能区分手动 token、本机检测到 Cursor 账号、未检测到账号，不改变 Cursor On/Off 扫描语义。 |
| macOS Intel 打包 | DONE | macOS arm64、macOS Intel x64、Windows x64 三平台 zip artifact 均进入发布 manifest；zip 继续作为自升级资源，原生 dmg/exe installer 作为后续分发补强单独规划。 |

参考：

- `doc/0.3-baseline.md`
- `doc/0.3-development-tasks.md`
- `doc/packaging.md`

## 0.4.0 已落地

目标：将首次启动体验从静默初始化改为知情同意的引导流程，让用户在数据采集前理解产品用途和隐私模型。

| 能力 | 状态 | 产品结果 |
| --- | --- | --- |
| Desktop 初始化向导 | DONE | 5 步向导替代 onboarding card：Welcome（隐私声明）→ Identity → Sources → Cloud → Ready。 |
| 隐私披露 | DONE | 将 FORBIDDEN_UPLOAD_FIELDS 转化为人类可读声明，集成到向导 Welcome 步骤和 CLI init。 |
| 源自动检测 | DONE | 向导 Sources 步骤展示本机检测到的 AI 工具，预启用已检测源，支持自定义位置添加。 |
| CLI 交互式 init | DONE | 无 config 且无 `--nickname` 标志时，`init` 进入交互模式，提示昵称、展示检测结果、提示 API URL。 |
| 原生安装包制作与发布 | DONE | 三平台 DMG/NSIS 安装包构建到 `dist-installer/`；发布脚本上传安装包到 OSS；manifest 每个平台含 `installer` 子对象；Web 下载面板优先展示安装包链接。 |

参考：

- `doc/0.4-baseline.md`
- `doc/0.4-development-tasks.md`

## 0.5.0 空白基线

目标：只建立下一版本的空白 baseline/task 入口。0.5.0 当前尚未开启任何产品或工程任务。

| 能力 | 状态 | 产品结果 |
| --- | --- | --- |
| 0.5 空白基线 | DONE | `doc/0.5-baseline.md` 明确 0.5.0 尚未开启任务。 |
| 0.5 空白任务文档 | DONE | `doc/0.5-development-tasks.md` 只记录版本迭代流程，不提前承诺 roadmap 候选项。 |
| 临时功能入账规则 | DONE | 后续临时加入代码功能时，必须同步记录到 baseline 与 development tasks。 |

参考：

- `doc/0.5-baseline.md`
- `doc/0.5-development-tasks.md`

## 0.3.x 发布后补强

| 能力 | 优先级 | 产品目标 |
| --- | --- | --- |
| 安装包发布验证闭环 | P0 | 固化一次 release publish 后的人工验收：manifest 公开读、app-server release config、客户端 Check update、三平台下载 URL 和 checksum 全部一致。 |
| 原生安装包分发 | DONE | 在自升级 zip 之外，补齐 macOS arm64 dmg、macOS Intel x64 dmg、Windows x64 NSIS exe；installer 面向首次安装和手动下载，updater 仍使用 zip，避免两套升级语义混用。已随 0.4.0 落地。 |
| Windows 主机覆盖 | P0 | Windows 版本已在真实 Windows 本地初验可用，后续补齐持续化 smoke、安装、更新、路径权限和防病毒误报验证。 |
| 更新失败可诊断性 | P1 | Check update、download、checksum、apply 四类失败给出用户可执行原因，避免暴露工程配置名。 |
| Release 回滚策略 | P1 | 当 latest manifest 发布错误时，可以回滚到上一个可用版本，并保证客户端不会读到半发布状态。 |
| 发布凭据操作手册 | P1 | 明确本地 env、CI Secret、OSS 公开读权限、AK/SK 最小权限和轮换方式。 |

## 后续候选能力

| 能力 | 阶段 | 产品目标 |
| --- | --- | --- |
| 最低支持客户端版本策略 | Candidate | 基于 0.3 已上报的 `clientAppVersion` / `clientProtocolVersion`，在服务端配置最低支持版本、推荐升级版本和强制升级窗口；客户端收到策略后明确提示升级、阻断不兼容上传并保留本地队列。 |
| 客户端诊断数据上报 | Candidate | 面向不同环境的数据问题排查，允许用户主动上报脱敏诊断数据包；开发者可拿到客户端版本、平台、配置摘要、来源检测结果、聚合 usage cache、upload queue 摘要和运行事件，用于复现与修复问题，但不得包含 prompt、回答、源码、真实路径、Cursor token、身份私钥或原始会话内容。 |
| 自动备份 | Candidate | 备份 identity、config、tokens、aliases、usage cache 和 upload queue，降低换机或升级失败风险。 |
| 菜单栏程序 | Candidate | 支持隐藏 Dock，仅在菜单栏展示 Today token 简要信息、同步状态和快捷入口。 |
| 多语言 | Candidate | 优先支持中英文 UI 文案切换，后续再扩展文档和发布说明。 |

## 暂不纳入

| 能力 | 原因 |
| --- | --- |
| 客户端内置 manifest URL | 与 0.3.0 的单一数据源原则冲突；release 地址必须由 app-server 控制。 |
| manifest 非对称签名 | 开源阶段收益有限，当前以 OSS 写权限边界和 artifact sha256 校验控制风险；更强分发安全需求出现后再恢复。 |
| Hook-based live collection | 当前产品仍以本地扫描和手动/定时同步为主，实时采集会扩大权限和稳定性风险。 |
