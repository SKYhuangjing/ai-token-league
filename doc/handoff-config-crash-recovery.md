# Handoff: Config Crash Recovery — 防止 Windows 重启后引导页重现

**日期**: 2026-05-29
**分支**: develop
**改动文件**: `collector-core/src/config.rs` + `collector-core/src/local_backup.rs`
**状态**: ✅ 已实现 + 工作区测试通过，待提交

---

## 1. 问题背景

同事反馈：Windows 自动重启（Windows Update / 蓝屏等）后，再次打开软件会跳出引导页（onboarding wizard），好像从未配置过。

### 根因分析

引导页由 `config.json` 中的 `desktopAutoInitialized` 字段控制。旧的 `save_config` 使用非原子写入 + 忽略错误：

```rust
// 旧代码
let _ = fs::write(config_path(), json);  // 非原子，忽略错误
```

`fs::write` 在 Windows 上先截断文件再写入。如果中断，文件变空或半截 JSON。`load_config` 解析失败返回 `None`，等同于"从未配置"，触发全新初始化。

### 崩溃链

```
Windows 强制重启 → config.json 截断 → load_config()=None → 新 identity + 引导页重现
```

---

## 2. 修复方案

### 2.1 `ATL_HOME` 环境变量 — 测试隔离基础

`app_dir()` 新增 `ATL_HOME` 环境变量优先路径，让测试只在临时目录操作，不碰真实用户数据。

```rust
pub fn app_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("ATL_HOME") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".ai-token-league")
}
```

解决了 Windows 上 `dirs::home_dir()` 不读 `HOME` 环境变量导致测试操作真实用户目录的问题。

### 2.2 `save_config` — 原子写入 + 最新可恢复 .bak

每次保存时：

1. **原子写入主配置** → 先写 `config.json.tmp`，再 `fs::rename` 覆盖 `config.json`
2. **同步最新可恢复备份** → 主配置写入成功后，用同样的原子写入方式把当前内容写入 `config.json.bak`
3. **失败安全** → 如果 tmp 写入或 rename 失败，清理 tmp 并保留旧文件不动；**绝不退回非原子直接写入**

```rust
if atomic_write_file(&path, &content).is_ok() {
    let _ = atomic_write_file(&bak, &content);
}
```

关键语义：`.bak` 保存的是**最近一次成功保存的可恢复配置**，不是“上一版配置”。否则首次启动时 `desktopAutoInitialized=true`，用户完成引导保存为 `false` 后，`.bak` 仍可能停留在 `true`，主文件损坏时会再次弹引导页。

### 2.3 `load_config` — .bak 兜底恢复

```
config.json 有效（AppConfig 解析成功）？  → 直接使用
config.json 损坏/为空/不存在？           → 尝试 config.json.bak
两者都不可用？                           → 返回 None（走 ensure_desktop_config）
```

### 2.4 `reset_local_data` — 补充清理新文件

`reset_local_data()` 原来只删 `config.json`，遗漏了 `.bak` 和 `.tmp`。修复后一并清理：

```rust
let _ = fs::remove_file(config_path());
let _ = fs::remove_file(config_bak_path());      // 新增
if let Ok(path) = atomic_tmp_path(&config_path()) {
    let _ = fs::remove_file(path);
}
if let Ok(path) = atomic_tmp_path(&config_bak_path()) {
    let _ = fs::remove_file(path);
}
```

### 2.5 `default_backup_directory` — 统一走 `app_dir()`

`local_backup.rs` 中的 `default_backup_directory()` 原来直接调用 `dirs::home_dir()`，绕过了 `ATL_HOME` 覆盖。改为走 `config::app_dir()`：

```rust
// 旧：直接调 dirs，ATL_HOME 无效
let base = dirs::home_dir()
    .map(|home| home.join(".ai-token-league"))
    .or_else(dirs::document_dir)
    .or_else(dirs::home_dir)
    .unwrap_or_else(|| PathBuf::from("."));

// 新：统一走 app_dir()
config::app_dir().join("backup").to_string_lossy().to_string()
```

---

## 3. Review 反馈修复记录

| # | Review 问题 | 修复 |
|---|------------|------|
| 1 | `fs::rename` 在 Windows 不能覆盖已存在文件 | `std::fs::rename` 在 Rust 中使用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，实际支持覆盖。但代码注释中明确说明了 Windows 行为 |
| 2 | 测试 `clean_config_files()` 删除真实用户配置 | **已修复**：引入 `ATL_HOME` + `AtlHomeGuard` RAII，所有新测试使用临时目录，零接触真实数据 |
| 3 | tmp 写失败 fallback 到直接写，重新引入截断风险 | **已修复**：去掉 fallback。写入失败时清理 tmp 并 return，旧文件保留不动 |
| 4 | `.bak` 只校验 JSON 语法，不保证 AppConfig 可用 | **已修复**：`.bak` 由当前 `AppConfig` 序列化结果原子写入，确保备份是完整可用的配置 |
| 5 | `reset_local_data()` 遗漏清理 `.bak`/`.tmp` | **已修复**：补充删除 `config_bak_path()` 和 `.tmp` 文件 |
| 6 | `.bak` 保存上一版配置，真实首次引导 `true -> false` 后可能恢复出引导页 | **已修复**：`.bak` 改为最新可恢复配置，并新增真实 onboarding 完成路径测试 |

---

## 4. 测试迁移：Windows 测试隔离

### 根因

`dirs` crate 在 Windows 上优先读 `USERPROFILE` 而非 `HOME`，导致 `set_var("HOME", temp_dir)` 无效。所有使用该模式的测试实际在操作真实 `~/.ai-token-league/` 目录。

### 迁移范围

**`local_backup.rs`**（5 个测试）— 全部迁移到 `ATL_HOME` + `AtlHomeGuard` RAII：

| 测试 | 变更 |
|------|------|
| `backup_and_restore_client_files` | `HOME` → `ATL_HOME` |
| `backup_and_restore_strip_cursor_credentials` | `HOME` → `ATL_HOME` |
| `restore_rejects_hash_mismatch` | `HOME` → `ATL_HOME` |
| `backup_defaults_to_app_backup_dir_and_clears_files` | `HOME` → `ATL_HOME` + 断言改为 `config::app_dir()` |
| `backup_retention_removes_files_older_than_days` | `HOME` → `ATL_HOME` |

**`observability.rs`** 的 3 个测试之前因 `TEST_ENV_LOCK` 被 `local_backup` 失败污染而级联失败。根因修复后自然通过，无需单独改动。

### `AtlHomeGuard` 模式

两个测试模块各自定义了相同的 `AtlHomeGuard` RAII guard：

```rust
struct AtlHomeGuard { previous: Option<String>, home: PathBuf }

impl AtlHomeGuard {
    fn new(home: &PathBuf) -> Self {
        let previous = std::env::var("ATL_HOME").ok();
        std::env::set_var("ATL_HOME", home);
        Self { previous, home: home.clone() }
    }
}

impl Drop for AtlHomeGuard {
    fn drop(&mut self) {
        // 恢复环境变量 + 清理临时目录
    }
}
```

使用方式：
```rust
let _atl = AtlHomeGuard::new(&temp_home());
// 所有 config::xxx_path() 调用指向临时目录
// Drop 时自动清理
```

---

## 5. 新增测试（config.rs 7 个）

所有测试使用 `AtlHomeGuard`，完全隔离。

| 测试名 | 覆盖场景 |
|--------|----------|
| `save_config_creates_bak_with_latest_content` | .bak 保存最近一次成功保存的可恢复配置 |
| `save_config_atomic_write_replaces_existing_file` | 已有 config.json 时保存必须替换主文件，不留 .tmp |
| `completed_onboarding_state_recovers_from_bak` | **真实核心场景**：首次启动为引导态，完成引导保存后主文件损坏，恢复后不重现引导页 |
| `load_config_recovers_from_corrupted_main_file_via_bak` | 主文件 JSON 截断 → 自动恢复 identity |
| `load_config_recovers_from_empty_main_file_via_bak` | 主文件为空 → 自动恢复 identity + deviceId |
| `load_config_returns_none_when_both_corrupted` | 双文件损坏 → 正确降级为 None |
| `ensure_desktop_config_reuses_bak_instead_of_reinitializing` | 已完成引导配置损坏后恢复 identity，不弹引导页 |

---

## 6. 测试结果

```
$ cargo test --workspace

workspace result: ok
```

全绿。包括 `collector-core` 209 个 lib 测试、Tauri crate 测试、sidecar 测试和 integration 测试。

**测试安全性验证**：
- ✅ 新增/迁移测试均通过 `ATL_HOME` 指向临时目录
- ✅ config 写入成功后无 `.tmp` 残留
- ✅ `ATL_HOME` 环境变量由 RAII guard 恢复

---

## 7. 行为对比

| 场景 | 旧行为 | 新行为 |
|------|--------|--------|
| 正常启动 | 读 config.json ✅ | 读 config.json ✅ |
| config.json 被截断（重启崩溃） | None → 重建 identity → 引导页 ❌ | 读 .bak 恢复 → 正常进入 ✅ |
| config.json 为空 | 同上 ❌ | 同上 ✅ |
| 首次安装（无 config 无 .bak） | 创建 ✅ | 创建 ✅ |
| .bak 也损坏（极罕见） | 重建 ✅ | 重建 ✅ |
| 保存过程中断电 | 非原子写入，文件可能损坏 ❌ | tmp+rename 原子写入 ✅ |
| 保存失败 | 静默忽略，可能留下截断文件 ❌ | 保留旧文件不动，清理 tmp ✅ |
| 重置本地数据 | .bak/.tmp 残留（含旧 identity） ❌ | 一并清理 ✅ |

---

## 8. 改动文件清单

| 文件 | 改动 |
|------|------|
| `collector-core/src/config.rs` | `app_dir()` 加 `ATL_HOME` + 公开；`save_config` 原子写入 + 最新可恢复 .bak；`load_config` .bak 兜底；`reset_local_data` 补清理；7 个新测试 |
| `collector-core/src/local_backup.rs` | `default_backup_directory()` 改走 `config::app_dir()`；5 个测试迁移到 `ATL_HOME` |

---

## 9. 后续建议（不在本次范围）

1. **`save_config` 返回 `Result`**：当前错误被静默处理，应向上层汇报
2. **恢复日志**：`.bak` 恢复时写 runtime log，方便远程诊断
3. **`observability` 测试迁移**：`observability.rs` 的测试仍用 `HOME` 模式，可同样迁移到 `ATL_HOME`（当前已通过，因为根因已修）
4. **抽取 `AtlHomeGuard`**：`config.rs` 和 `local_backup.rs` 各自定义了相同的 guard，可考虑放到共享测试工具模块
