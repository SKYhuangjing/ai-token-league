# AI Token League v0.1 - Mermaid ER 图

Version: `0.1`
Frozen at: `2026-04-30`

本文档是 v0.1 的本地/远端数据模型图谱。后续版本如果调整存储颗粒度、主键、价格表、上传 payload 或隐私边界，应新建版本段落，不直接覆盖本图。

基于 `product-design.md` 第 12 节存储数据模型生成。

## 远端存储 ER 图

```mermaid
erDiagram
    Participant ||--o{ Device : "1 has many"
    Participant ||--o{ Workdir : "1 has many"
    Participant ||--o{ UsageDaily : "1 has many"
    Participant ||--o{ UploadBatch : "1 has many"
    Device ||--o{ UsageDaily : "1 has many"
    Device ||--o{ UploadBatch : "1 has many"
    Workdir ||--o{ UsageDaily : "1 has many"
    UploadBatch ||--o{ UsageDaily : "audits writes into"
    ModelPrice ||--o{ UsageDaily : "recalculates estimate for"

    Participant {
        string id PK
        string nickname
        string avatarColor
        string identityPublicKey
        datetime createdAt
        datetime updatedAt
        datetime lastSeenAt
    }

    Device {
        string id PK
        string participantId FK
        enum os "macos | windows"
        string appVersion
        datetime createdAt
        datetime lastSeenAt
        datetime revokedAt
    }

    Workdir {
        string id PK
        string participantId FK
        string workdirHash
        string alias
        string detectedName
        string displayName
        string sourceProvider
        datetime createdAt
        datetime updatedAt
        datetime lastSeenAt
    }

    UsageDaily {
        date day "PK part"
        string participantId "PK part FK"
        string deviceId "PK part FK"
        string toolCode "PK part"
        string providerId "PK part"
        string workdirId "PK part FK"
        string model "PK part"
        bigint inputTokens
        bigint outputTokens
        bigint cacheReadTokens
        bigint cacheWriteTokens
        bigint reasoningTokens
        bigint totalTokens
        float estimatedCostUsd
        enum costQuality "exact_price | estimated_price | unknown_price"
        string pricingVersion
        string pricingModel
        enum sourceQuality "exact | partial | estimated | imported | unknown"
        datetime collectedAt
        datetime uploadedAt
    }

    ModelPrice {
        string model PK
        float inputCostPerMTok
        float outputCostPerMTok
        float cacheReadCostPerMTok
        float cacheWriteCostPerMTok
        float reasoningCostPerMTok
        enum source "litellm | ccusage | admin | custom"
        string notes
        datetime updatedAt
    }

    UploadBatch {
        string id PK
        string participantId FK
        string deviceId FK
        string payloadHash "unique"
        string signature
        datetime clientGeneratedAt
        datetime receivedAt
        int accepted
        int rejected
        enum status "pending | accepted | rejected | partial"
        string errorReason
    }
```

## 本地存储 ER 图

```mermaid
erDiagram
    LocalIdentityConfig ||--o{ LocalProviderRoot : "1 owns many"
    LocalIdentityConfig ||--o{ LocalWorkdirAlias : "1 owns many"
    LocalUsageCache ||--o{ LocalUsageRow : "contains many"
    LocalUploadQueue ||--o{ UploadPayloadItem : "contains many"

    LocalIdentityConfig {
        string participantId PK
        string identityPublicKey
        string identityPrivateKey
        string deviceId
        string nickname
        string apiBaseUrl
        boolean autoRefreshEnabled
        int refreshIntervalMinutes
        datetime createdAt
        datetime updatedAt
    }

    LocalProviderRoot {
        string providerId "PK part"
        string rootPath "PK part"
        datetime addedAt
    }

    LocalWorkdirAlias {
        string workdirHash PK
        string alias
        datetime updatedAt
    }

    LocalProviderConfig {
        string providerId PK
        boolean enabled
        string secretRef
        string localOnlySecret
        datetime updatedAt
    }

    LocalUsageCache {
        datetime scannedAt PK
        string cacheVersion
        string sourceFingerprint
        json rows
    }

    LocalUsageRow {
        date day "PK part"
        string toolCode "PK part"
        string providerId "PK part"
        string workdirHash "PK part"
        string model "PK part"
        string workdirDisplayName
        bigint inputTokens
        bigint outputTokens
        bigint cacheReadTokens
        bigint cacheWriteTokens
        bigint reasoningTokens
        bigint totalTokens
        enum sourceQuality "exact | partial | estimated | imported | unknown"
        string rawSourceRef
        datetime collectedAt
    }

    LocalUploadQueue {
        string batchId PK
        string payloadHash
        datetime clientGeneratedAt
        enum status "pending | uploading | done | failed"
        int retryCount
        string lastError
    }

    UploadPayloadItem {
        date day "PK part"
        string toolCode "PK part"
        string providerId "PK part"
        string workdirHash "PK part"
        string model "PK part"
        string workdirDisplayName
        bigint inputTokens
        bigint outputTokens
        bigint cacheReadTokens
        bigint cacheWriteTokens
        bigint reasoningTokens
        bigint totalTokens
        enum sourceQuality "exact | partial | estimated | imported | unknown"
    }
```

## 总体数据流

```mermaid
flowchart TD
    subgraph Local["本地 AI 工具数据"]
        A1["Codex session JSONL"]
        A2["Claude Code session log"]
        A3["Cursor dashboard usage API"]
    end

    subgraph Scanner["Provider Scanner"]
        B1["detect source"]
        B2["parse raw usage"]
        B3["resolve local workdir"]
        B4["normalize token fields"]
    end

    subgraph LocalStore["本地存储"]
        C1["LocalUsageCache"]
        C2["LocalUsageRow"]
    end

    subgraph Upload["上传"]
        D1["UploadPayloadItem"]
        D2["UploadBatch"]
    end

    subgraph Remote["远端存储"]
        E1["UsageDaily"]
        E2["Query Aggregates"]
    end

    A1 & A2 & A3 --> Scanner
    Scanner --> C2
    C2 --> C1
    C2 --> D1
    D1 --> D2
    D2 -->|"signed by identityKey"| E1
    E1 --> E2

    E2 --> F1["公开榜"]
    E2 --> F2["用户趋势"]
    E2 --> F3["管理员聚合"]
```

## 上云最小颗粒度

UsageDaily 上云字段（不上传的字段明确列出）：

```mermaid
block-beta
    block:upload["上传字段"]
        columns 2
        day["day"]
        participantId["participantId"]
        deviceId["deviceId"]
        toolCode["toolCode"]
        providerId["providerId"]
        workdirHash["workdirHash"]
        workdirDisplayName["workdirDisplayName"]
        model["model"]
        inputTokens["inputTokens"]
        outputTokens["outputTokens"]
        cacheReadTokens["cacheReadTokens"]
        cacheWriteTokens["cacheWriteTokens"]
        reasoningTokens["reasoningTokens"]
        totalTokens["totalTokens"]
        sourceQuality["sourceQuality"]
    end

    block:noUpload["不上传字段"]
        columns 1
        N1["localPath / absolutePath"]
        N2["prompt / assistantResponse"]
        N3["sourceFileContent / fullTranscript"]
        N4["Cursor session token"]
        N5["identityPrivateKey"]
        N6["provider raw secret"]
    end

    block:trace["可选追溯字段"]
        columns 1
        T1["rawSourceRef"]
        T2["providerVersion"]
        T3["parserVersion"]
        T4["sourceFingerprint"]
    end
```

## 表关系说明

| 表 | 主键 | 关系 |
| --- | --- | --- |
| Participant | `id` | 拥有多个 Device、Workdir、UsageDaily、UploadBatch |
| Device | `id` | 属于一个 Participant；产生多条 UsageDaily |
| Workdir | `id` | 属于一个 Participant；关联多条 UsageDaily |
| UsageDaily | `day + participantId + deviceId + toolCode + providerId + workdirId + model` | 核心事实表，所有榜单从该表聚合 |
| ModelPrice | `model` | 价格表变更后重新计算 UsageDaily.estimatedCostUsd |
| UploadBatch | `id` | payloadHash 去重，审计每次上传写入的 UsageDaily 行 |

## 存储文件映射（本地）

| 逻辑实体 | 物理文件 |
| --- | --- |
| LocalIdentityConfig | `~/.ai-token-league/config.json` |
| LocalProviderRoot | `~/.ai-token-league/config.json` |
| LocalWorkdirAlias | `~/.ai-token-league/config.json` |
| LocalProviderConfig | `~/.ai-token-league/config.json`（Cursor token 等敏感配置） |
| LocalUsageCache | Electron `userData/usage-cache.json` |
| LocalUploadQueue | `~/.ai-token-league/upload-queue.json` |
| 远端全表 | `data/db.json`（MVP JSON 存储，生产化时迁移到 PostgreSQL） |
