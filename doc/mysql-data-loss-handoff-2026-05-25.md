# MySQL 数据丢失修复 Handoff (2026-05-25)

## 背景

生产环境出现 MySQL `usage_daily` / `usage_hourly` / `usage_sync_buckets*` 历史数据被意外删除的现象。根因是 `MySqlStore` 的两条写入路径共用 `this.db.usageDaily/usageHourly/usageSyncBuckets*` 作为「请求级工作区」，并且 legacy 上传走的是「整表 DELETE + INSERT ALL」流程：

- `loadWriteScope()` / `loadUsageMirrorForMaintenance()` 把这些字段从全量镜像缩成当前请求的子集；
- 并发请求会互相覆盖对方的内存 scope；
- legacy 路径以为自己持有「全量镜像」，实际上拿到的是别人写入剩下的局部 scope，于是把数据库其他部分整张表擦掉。

修复分两个阶段：

1. commit `931f0752`（已合入 `develop`）：进程内 Promise 串行写锁、legacy 路径改为「按 key 精准删除 + upsert」、workdir 别名变更失效本地缓存、客户端 batch 上传严格按 `results` 标记成功 bucket。
2. 本次 handoff 涵盖的本地修改（在 commit `931f0752` 之上叠加，**尚未提交**）：MySQL 命名锁跨进程串行 + 写入完成后强制重置内存工作镜像 + 删除残留的全表 DELETE 工具。

## 本次改动文件

| File | Change |
| --- | --- |
| `src/backend/mysql-store.js` | 加 `MYSQL_WRITE_LOCK_NAME` / `MYSQL_WRITE_LOCK_TIMEOUT_SECONDS` 跨进程命名锁；`withWriteLock` 在释放锁前调用 `resetUsageWorkingState()`；删除 `syncAllTables` / `syncUsageDaily` 以及只被它们使用的 `replaceUsageSyncBuckets` / `replaceUsageSyncBucketsHourly`；构造函数使用 `??` 解析 `writeLockTimeoutSeconds`（避免显式 `0` 被默认值吞掉），并在命名锁启用时把 `connectionLimit` 下限 floor 到 `2`（避免锁连接和写事务在同一池里自死锁）；`refreshOpenRouterPrices` **在锁外发起 OpenRouter HTTP 请求**，仅把 fetch 结果应用到 cache 的步骤放进 `withWriteLock`，避免外部网络抖动阻塞跨进程命名锁 |
| `src/backend/store.js` | `refreshOpenRouterPrices` 拆成 fetch + apply 两段；新增 `applyOpenRouterPriceFetch(prefetched, prefetchError, opts)` 同步执行 cache 替换、价格表失效、可选 recalculate 与 save，使子类（`MySqlStore`）能在锁外预 fetch、锁内仅 apply |
| `src/backend/server.js` | `export { store }`，让端到端测试在停 HTTP server 之后能拿到模块级 store 调用 `store.close()`，关闭 mysql2 连接池，避免测试进程长期挂住；`mysqlWriteMode` 把原有的误导性 `"fullSync"` 标签改名为 `"legacyMirrorSync"`（legacy 现在不再做整表 flush，仅按 day 维度走 `loadUsageMirrorForMaintenance` + `syncLegacyUsageMirror`），同时把对应的成功日志级别从 `warn` 降为 `info`（保留 `shouldLogUsageUploadSuccess` 仍始终输出，作为 ops 对 legacy 客户端流量的观测点）|
| `tests/run-tests.js` | 移除对 `syncAllTables` 的死 mock，改为断言这两个全表函数已不存在；新增 `testMysqlUsageWritesUseDistributedLock` / `testMysqlWriteLockTimeoutFailsClosed` / `testMysqlConnectionLimitFloorsWhenLockEnabled` / `testMysqlWriteLockResetsUsageWorkingState` / `testMysqlWriteLockResetsUsageWorkingStateOnError` 五个回归用例；`testMysqlWriteLockTimeoutFailsClosed` 现在同时断言 `config.writeLockTimeoutSeconds === 0` 不会被默认值吞掉，并捕获 `GET_LOCK(?, ?)` 第二参数验证它原样传入；新增 `testOpenRouterRefreshFetchOutsideLockSplit` 覆盖 `refreshOpenRouterPrices` 的拆分路径：6 个 case 分别验证锁外 fetch + 锁内 apply 的 happy path、fetch 失败但有旧价时回退 `stale`、fetch 失败且无旧价时回退 `failed`、wrapper 不抛 fetch 错误、`recalculate=true` 触发 `usageDaily` 行重算（updated=1，pricingSource 切到 `openrouter`）|
| `tests/mysql-dual-backend-e2e.js` | 双 backend 实例并发上传 e2e：覆盖 hourly snapshot + daily snapshot + **legacy（无 snapshot）**三条写路径，使用 `claude_code_local` 作为 legacy 的 providerId 与 `codex_local` 的 snapshot 隔离，保证 legacy 行不会被 snapshot daily bucket-scoped DELETE 误删；测试退出时同时 `server.close()` + `store.close()`，进程能干净退出 |
| `doc/0.7-baseline.md`, `doc/0.7-development-tasks.md`, `doc/operations.md`, `env.example`, `env.host.example` | 文档与 env 示例补上 MySQL 命名锁配置；`doc/operations.md` 把"显式留空 lock 名可禁用"的旧措辞改为"命名锁始终启用，连接池下限始终 floor 到 2"，与代码实现对齐；`env.example` 同步更新 `MYSQL_CONNECTION_LIMIT` / `MYSQL_WRITE_LOCK_NAME` / `USAGE_UPLOAD_SUCCESS_LOG` 三处注释，删除"留空可禁用命名锁、可继续 connectionLimit=1"和"只记录 fullSync"的旧表述 |

## 修复后的关键不变量

1. **同一 backend 进程内**，所有写入路径都通过 `MySqlStore.withWriteLock()` 串行：
   - `upsertUsageBatch` (hourly snapshot / daily snapshot / legacy)
   - `registerDevice`
   - `recalculateCosts` / `refreshOpenRouterPrices` / `recalculateUsageCostsInBatches`
   - `upsertModelPrice` / `deleteModelPrice` / `upsertModelPriceAlias` / `deleteModelPriceAlias`
   - `deleteParticipantData` / `deleteDeviceData`
2. **多 backend 实例**连接同一 MySQL 时，通过 `GET_LOCK(?, ?)` 命名锁再串行一次；拿不到锁会 **fail-closed** 抛 `Timed out acquiring MySQL write lock`，**不会**继续进入 `loadWriteScope`。
3. **每次 `withWriteLock` 退出前**（不论正常返回还是抛错），`resetUsageWorkingState()` 会把以下字段清回 `load()` 后的基线 `{}`：
   - `db.usageDaily` / `db.usageHourly`
   - `db.usageSyncBuckets` / `db.usageSyncBucketsHourly`
   - `db.uploadBatches`
   - `aggregateCache`
4. legacy 上传不再触发整表 DELETE。`upsertUsageBatch` 的 legacy 分支：
   - 通过 `loadUsageMirrorForMaintenance()` 拉全量到内存（仍在锁内）；
   - 抓 `previousUsageKeys`；
   - 跑父类 `super.upsertUsageBatch()`（upsert-only，理论上不会减少 key）；
   - 通过 `syncLegacyUsageMirror()` 只 DELETE `previousUsageKeys - currentUsageKeys` 的差集 + `upsertUsageRows` 当前 entries。
5. snapshot 路径继续走 `incrementalBucketSync` / `incrementalHourlyBucketSync`，事务内按 (participantId, deviceId, day, [hour], providerId) bucket-scoped 删除 + upsert。
6. workdir 别名变更后，sidecar 会同时清掉 `usage-cache.json`、JSON source index 和 `local_usage_store` 的 `source_cache`，避免下一次扫描复用旧 display name 重新上传脏 fingerprint。
7. 客户端 `apply_batch_upload_response` (`collector-core/src/sync.rs:422`) 严格按 `results` 数组判定每个 bucket：只有 `duplicate || noOp || (rejected==0 && accepted==row_count)` 才 `mark_upload_success`；否则 `mark_upload_failure` 不写 manifest。
8. **连接池容量下限**：`MySqlStore` 的 MySQL 命名锁**始终启用**（不设 `MYSQL_WRITE_LOCK_NAME` 时按 `MYSQL_DATABASE` 自动派生默认锁名，构造函数无 env 层关闭开关），所以 `MySqlStore.config.connectionLimit` 始终被 floor 到至少 `2`。命名锁会把一条 pool connection 钉在临界区内整段时间（直到 `RELEASE_LOCK`），而紧随其后的写事务又会从同一个 pool 申请第二条 connection；如果 `MYSQL_CONNECTION_LIMIT=1` 不强行抬高，第二次 `getConnection()` 会和锁持有者死锁，从而把「防数据丢失」变成「写请求卡死」。
9. **`writeLockTimeoutSeconds=0` 必须原样生效**：构造函数用 `??` 区分「未配置」与「显式设为 0」，因此 ops 可以显式给一个 fail-fast lock（`GET_LOCK(?, 0)`）用于压测或熔断，不再被旧的 `|| 30` 默认值吞掉。

## 新增 env 开关

| Key | Default | 用途 |
| --- | --- | --- |
| `MYSQL_WRITE_LOCK_NAME` | `ai-token-league:<database>:write`（自动派生） | 多 backend 实例必须使用**同一字符串**才能互相串行 |
| `MYSQL_WRITE_LOCK_TIMEOUT_SECONDS` | `30` | `GET_LOCK` 等待秒数；`??` 解析，**显式 `0` 表示 fail-fast** 不会被默认值吞掉 |
| `MYSQL_CONNECTION_LIMIT` | `8` | 连接池上限。**启用命名锁时实际下限为 `2`**——构造函数会自动 floor，部署侧可以放心设较小的值，但不要再依赖 `1`；只有不启用命名锁的纯单实例才能继续用 `1` |

对单实例部署无需改任何 env，默认值会自动派生 lock 名并向后兼容。

## 验证

执行的回归：

```bash
npm test                     # 全部通过（含 5 个新增 MySQL 测试）
cargo test --workspace       # 通过（sidecar workdir alias cache 失效测试已在 931f0752 合入）

# 真实 MySQL 行为冒烟（已在 env.local 指向的 mysql.dev.1datatm.info:3306/ai_token_league_dev 跑过一次）
set -a && . ./env.local && set +a && node tests/mysql-live-lock.js
# 期望输出末尾: [live] ALL LIVE MYSQL CHECKS PASSED

# 双 backend 进程并发上传 usage 业务表端到端（已在同一 dev MySQL 跑过一次）
set -a && . ./env.local && set +a && node tests/mysql-dual-backend-e2e.js
# 期望输出末尾: [dual] ALL DUAL-BACKEND CONCURRENT UPLOAD CHECKS PASSED
```

`tests/mysql-live-lock.js` 覆盖 5 项行为：(1) GET_LOCK 获取/释放；(2) `writeLockTimeoutSeconds=0` 在持锁时 ~24ms fail-fast；(3) 两个 MySqlStore 实例并发临界区严格串行（每个 enter ≥ 上一个 exit）；(4) `connectionLimit=2` + 命名锁连续 4 轮无自死锁；(5) `withWriteLock` 正常 + 异常路径都重置 `db.usage*` 工作镜像。脚本使用 `ai-token-league:livetest:<pid>:<rand>` 测试锁，不动 usage 业务表，可安全在共享 dev 库上反复跑。

`tests/mysql-dual-backend-e2e.js` 在同一 Node 进程内通过 dynamic-import cache busting (`import("../src/backend/server.js?dual=<nonce>")`) 起两份独立的 backend 实例，**共享同一个 `MYSQL_WRITE_LOCK_NAME`**，绑随机端口，注册一个隔离的 `p_e2etest_<pid>_<rand>` participant + 2 个 device，然后并发发 120 笔（80 hourly snapshot + 20 daily snapshot + 20 **legacy 无 snapshot**，每条 bucket 都同时打到 A 和 B）`POST /api/usage/daily-batch`。最后**直接连 MySQL 用 SQL 校验** `usage_daily` / `usage_hourly` 行数和 (deviceId, day, [hour], providerId) key 集合**与发起的唯一 bucket 完全一致**，并对同一组 bucket 再发一轮，断言两份 backend 全部返回 `duplicate=true / noOp=true`、计数不变。Legacy 路径用 `claude_code_local` 作为 providerId（snapshot daily 用 `codex_local`），确保 snapshot daily 的 bucket-scoped DELETE 不会误删 legacy 行；测试还专门断言 `legacy usage_daily` 行集与预期完全一致——这是原 P0 全表 DELETE 缺陷的直接回归用例。脚本退出前同时关闭 HTTP server 和 `MySqlStore.close()`（mysql2 pool），Node 进程可干净退出，可用于自动化接收证据。最近一次本地结果：`ok=120 dup=60 bad=0, daily=20/20 (snapshot=10 legacy=10), hourly=40/40, run≈12.2s`，并能在日志里观察到新的 `mysqlWriteMode:"legacyMirrorSync"` info 级别字段（取代旧的 `fullSync` warn 标签）。

未跑（无可用环境/工具）：

- `npm run verify:ccusage` —— 本地未安装 `ccusage` / `ccusage-codex`，发布前需补；
- `npm run test:ui` / `npm run test:e2e` —— 本次未触及桌面渲染层，跳过。

### 推荐的接收方验证步骤

1. 起一份 docker MySQL（参考 `doc/test-deployment.md`），用同一 `MYSQL_*` 连两份 backend 进程（`PORT=8787` 和 `PORT=8788`）；env 里**显式**设 `MYSQL_WRITE_LOCK_NAME=ai-token-league:concurrency-test:write`，`MYSQL_CONNECTION_LIMIT=2`（验证下限 floor 生效，且不会自死锁）。
2. 用任意脚本对两个端口**并发**发若干 legacy 上传 + snapshot 上传 + admin 价格更新；
3. 写入完成后查 `SELECT COUNT(*) FROM usage_daily`，应**只增不减**；
4. 用 `SHOW PROCESSLIST` 观察 `GET_LOCK` 序列化是否符合预期；某个连接持锁时另一进程的写入应该等待，而不是误删；
5. 任意端口的进程拉空 `db.usageDaily` 应在每次请求结束后稳定为 `{}`（可在 `withWriteLock` 出口加临时 log 验证）；
6. **死锁回归**：临时把 `MYSQL_CONNECTION_LIMIT` 改回 `1` 重启，观察启动日志/`store.config.connectionLimit` 是否被自动 floor 到 `2`；
7. **fail-fast 回归**：临时 `MYSQL_WRITE_LOCK_TIMEOUT_SECONDS=0` 启一份 backend，并人为在 MySQL 端持有同名 lock（另一个 session 跑 `SELECT GET_LOCK('ai-token-league:concurrency-test:write', -1)`），此时 backend 第一笔写应**立即**返回 `Timed out acquiring MySQL write lock`，而不是回退到 30s 默认等待。

## 上线步骤

1. 合并 commit `931f0752` 之后的本地修改到 `develop`。
2. **多实例部署**：在所有 backend 节点的 env 里显式设置同一个 `MYSQL_WRITE_LOCK_NAME`（不显式设也能工作，但显式更可控）。
3. 单实例部署：直接发版，无需新 env。
4. 发版后必须做一次「**历史数据回填**」：

   ```bash
   # 在每台受影响的客户端机器上执行
   npm run collector -- sync --full-resync
   ```

   或在桌面端触发等价的「全量重传」入口。理由：客户端本地 `manifest.json` 仍认为 35 天以前的 bucket 已同步成功，服务端这部分数据被删除后不会被自动重传。**本次代码修复不会自动补回历史数据。**

## 已知遗留

1. **`this.db` 仍被当成请求工作区**。当前安全完全依赖「写锁串行 + 写完即清」。任何后续新增写路径如果漏写 `withWriteLock`，或新增 read 路径直接读 `this.db.usageDaily` 且跨 `await`，都会重新打开 race window。**强烈建议**作为 0.7 后续技术债，把写入改成请求局部 map 或纯 SQL（无需依赖共享内存镜像）。
2. **`loadUsageMirrorForMaintenance` 会把整张 `usage_daily` 拉进内存**。生产 DB 数据量大时会 OOM 风险，并放大写锁持有时间。后续可以把 legacy 路径也改成「按本次 payload 涉及的 day / device 加载子集」。
3. **没有服务端自动 reconcile**。建议下一版补一个「服务端检测到某 device 的 bucket 缺口超过阈值时主动让客户端重置 manifest」的机制，避免再次出现数据丢失时只能靠人肉 `--full-resync`。
4. **`writeLock` 是单实例 Promise 链**，进程崩溃后无影响；但 MySQL 命名锁 `GET_LOCK` 在客户端断连时会自动释放，**长事务期间网络抖动可能导致两侧都以为持锁**。当前事务很短（毫秒级），影响可忽略；如果未来出现长事务，需要在事务内显式 `SELECT IS_USED_LOCK(?)` 心跳验证。

## 联系人 / 上下文

- 触发本次修复的故障报告来源：内部用户反馈生产数据被删，配套同事的根因分析见 git history 上下文（保留在本次会话中）。
- 上一手修复：commit `931f07526c1e789db57914e6ecbe18063a986962`（`fix: prevent MySQL usage data loss`）。
- 本次叠加修复：尚未 commit，diff 范围见 `git diff src/backend/mysql-store.js tests/run-tests.js`。
- 相关基线 / 任务卡：`doc/0.7-baseline.md`、`doc/0.7-development-tasks.md`（已存在 0.7-T41 / 0.7-T41A 两张卡，描述与本次修复完全对齐）。
