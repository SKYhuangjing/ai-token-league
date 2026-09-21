// 算力共享插件（compute-sharing 0.1.0 可用性重构版）。
// 借用优先布局：默认「共享资源」目录 + 我的认领（工具配置生成/模型发现/协议测试）；
// 未注册者见一行「我要分享」准备入口。owner 控制台：车道（暂停/恢复/终止）、
// 单 Key 撤销、策略回显与节点同步状态、停止/重新开启。
// 文案走插件自带双语字典（STRINGS，repin 即生效）；借用/owner 动作统一经 sidecar
// Rust flow（与 CLI 同一路径，跨进程存储加锁）。
// 车道绑定认领 Key（CPA 拦截点无 model 字段的 ABI 约束下按 key→lane 硬执行时段/预算）。
// 平台能力经 ctx（t / invoke(守门) / escapeHtml / apiBase / notify）。

const STYLE = `
.cs-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 2px 0 6px; }
.cs-head .modules-section-title { margin: 0; }
.cs-row { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--border-subtle, #e3e3e0); border-radius: 10px; background: transparent; margin-bottom: 6px; }
.cs-kv { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; }
.cs-kv .num { font-family: var(--mono-font, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
.cs-meter { height: 4px; border-radius: 999px; background: var(--subtle-bg, #eee); overflow: hidden; }
.cs-meter i { display: block; height: 100%; width: 0; border-radius: 999px; background: var(--green, #2f9e79); }
.cs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-actions .cs-grow { flex: 1; }
.cs-config { display: grid; gap: 4px; margin-top: 2px; }
.cs-config-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cs-config-row code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 11px; font-family: var(--mono-font, ui-monospace, monospace); }
.cs-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted, #999); }
.cs-dot-on { background: var(--green, #2f9e79); }
.cs-dot-paused { background: var(--gold, #c90); }
.cs-dot-off { background: var(--muted, #999); opacity: 0.6; }
.cs-fields { display: flex; gap: 8px; flex-wrap: wrap; }
.cs-fields label { display: inline-flex; flex-direction: column; gap: 2px; font-size: 12px; }
.cs-fields input, .cs-fields select { width: 110px; }
.cs-fields label.grow { flex: 1 1 240px; }
.cs-fields label.grow input { width: 100%; }
.cs-muted { color: var(--muted, #888); font-size: 12.5px; line-height: 1.4; }
.cs-state { color: var(--red, #c0392b); font-weight: 600; }
.cs-status { min-height: 16px; font-size: 12.5px; }
.cs-board { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 1fr); gap: 8px 28px; align-items: start; }
.cs-board .cs-section { margin-top: 0; }
@media (max-width: 1000px) { .cs-board { grid-template-columns: 1fr; } .cs-board .cs-section { margin-top: 10px; } }
.cs-board.cs-stacked { grid-template-columns: 1fr; }
.cs-lane { display: grid; gap: 4px; padding: 7px 10px; border: 1px dashed var(--border-subtle, #e3e3e0); border-radius: 10px; margin-bottom: 6px; }
.cs-lane .cs-kv { align-items: baseline; }
.cs-tabs-row { display: flex; align-items: center; gap: 8px; margin: 2px 0 8px; }
.cs-tabs-row .cs-grow { flex: 1; }
/* tab 外观复用宿主 .segmented 分段控件（含深色主题）；这里只收窄到卡片内尺寸，
   参数与宿主紧凑变体 .segmented.modules-online-filter 一致 */
.cs-tabs { flex: 0 1 auto; }
.cs-tabs button { padding: 5px 12px; font-size: 12px; font-weight: 650; }
.cs-lane-tag { font-size: 11px; color: var(--muted, #888); border: 1px solid var(--border-subtle, #e3e3e0); border-radius: 999px; padding: 1px 8px; }
.cs-wall { display: flex; gap: 8px; align-items: baseline; padding: 7px 10px; border: 1px solid var(--gold, #c90); border-radius: 10px; margin-bottom: 6px; font-size: 12.5px; }
.cs-templates { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
/* 认领卡（我的认领）：标签/值/操作网格，值不折行 */
.cs-claim-config { display: flex; flex-direction: column; gap: 5px; }
.cs-claim-row { display: flex; align-items: center; gap: 8px; }
.cs-claim-label { flex: 0 0 96px; font-size: 11px; color: var(--muted, #888); white-space: nowrap; }
.cs-claim-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.cs-claim-mini { padding: 2px 8px; font-size: 11px; white-space: nowrap; }
.cs-claim-row .outline-button { white-space: nowrap; }
.cs-claim-section { margin: 10px 0 4px; font-size: 11px; letter-spacing: .06em; color: var(--muted, #888); border-bottom: 1px solid var(--border-subtle, #e3e3e0); padding-bottom: 2px; }
.cs-claim-config-head { display: flex; align-items: center; justify-content: space-between; }
.cs-claim-meta { line-height: 1.5; }
.cs-test-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cs-test-row .grow { flex: 1 1 160px; min-width: 0; }
.cs-claim-footer { justify-content: flex-end; border-top: 1px dashed var(--border-subtle, #e3e3e0); padding-top: 6px; }
.cs-dir-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.cs-chips { display: flex; gap: 4px; flex-wrap: wrap; }
.cs-chip { border: 1px solid var(--border-subtle, #e3e3e0); border-radius: 999px; background: transparent; padding: 2px 10px; font-size: 11.5px; cursor: pointer; color: var(--muted, #888); white-space: nowrap; }
.cs-chip.active { background: var(--subtle-bg, #eee); color: inherit; font-weight: 600; }
.cs-check { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--muted, #888); white-space: nowrap; }
.cs-dir-card { margin-bottom: 6px; }
.cs-lane-more { font-size: 11.5px; color: var(--muted, #888); cursor: pointer; background: transparent; border: 0; padding: 2px 0; }
.cs-t3 { margin-top: 6px; border-top: 1px dashed var(--border-subtle, #e3e3e0); padding-top: 6px; }
.cs-t3-row { padding: 2px 0; opacity: .7; }
.cs-hidden-note { margin-top: 6px; opacity: .8; }
.cs-suggest-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
.cs-reserve { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted, #888); }
.cs-reserve input { width: 52px; text-align: right; }
.cs-tpl-chip { display: inline-flex; align-items: center; gap: 2px; }
.cs-tpl-del { border: 0; background: transparent; color: var(--muted, #888); cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 4px; }
.cs-tpl-del:hover { color: var(--red, #c0392b); }
.cs-suggest [data-cs-family] { margin-left: 6px; padding: 2px 10px; font-size: 12px; }
.cs-dimstrip { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 6px; }
.cs-dim { font-size: 11.5px; border: 1px solid var(--border-subtle, #e3e3e0); border-radius: 999px; padding: 2px 10px; color: var(--muted, #888); }
.cs-dim.ok { color: var(--green, #2f9e79); border-color: var(--green, #2f9e79); }
.cs-dim.warn { color: var(--gold, #c90); border-color: var(--gold, #c90); }
.cs-trust { font-size: 11.5px; color: var(--muted, #888); line-height: 1.5; margin: 0 0 8px; padding: 6px 10px; border: 1px dashed var(--border-subtle, #e3e3e0); border-radius: 10px; }
.cs-entry strong { font-size: 12.5px; }
.cs-receipt { font-size: 11.5px; color: var(--muted, #888); margin: 4px 0; }
.cs-quota { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted, #888); margin: 4px 0; }
.cs-quota b { color: inherit; font-weight: 650; }
.cs-tool-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
.cs-tool-bar label { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--muted, #888); }
.cs-tool-bar select { max-width: 180px; }
.cs-pending { font-size: 11.5px; color: var(--gold, #c90); }
.cs-flash { outline: 2px solid var(--gold, #c90); outline-offset: 2px; transition: outline .2s; }
.cs-entry-items { display: grid; gap: 3px; margin-top: 4px; }
.cs-entry-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.cs-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--gold, #c90); border-radius: 10px; margin: 0 0 6px; font-size: 12.5px; }
.cs-confirm-text { flex: 1 1 240px; min-width: 0; }
.cs-confirm .cs-grow { flex: 0 0 auto; }
`;

function compact(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  const zh = (document.documentElement.lang || "").startsWith("zh");
  if (zh) {
    if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
    if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
    return String(n);
  }
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function fmtDateTime(ms) {
  const zh = (document.documentElement.lang || "").startsWith("zh");
  return new Date(ms).toLocaleString(zh ? "zh-CN" : "en-US");
}

function clockText(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Lane creation entrypoints are derived, not hardcoded (R49): the suggest
// block turns the owner's own usage families into pre-filled editors, and
// personal templates (module config laneTemplates) are user-saved presets.
// Every prefilled number stays adjustable before saving.

// ── 插件自治 i18n（0.1.0）───────────────────────────────────────────────
// 文案变更不再依赖宿主 App 重编：插件字典优先，宿主 t() 兜底，最后回退 key
// 本身（缺键可见，不静默）。所有 0.1.0 新增/改写的文案只住在这里——远端
// repin 即生效。旧键继续走宿主（已在 App 内），需要改写时把它搬进来。
const STRINGS = {
  "zh-CN": {
    "cs.entry.share": "我要分享",
    "cs.entry.shareHint": "准备你的 CPA 节点并配置共享资源",
    "cs.entry.steps": "准备步骤：① 本机安装并运行 CLIProxyAPI（CPA）；② 安装 atl-share 执行插件（scripts/install-cpa-plugin.sh）；③ 在 CPA 配置好 api 地址后本卡会自动检测并显示「我的分享」控制台。",
    "cs.entry.check": "检查",
    "cs.entry.item.identity": "共享节点身份",
    "cs.entry.item.ownerConfig": "CPA 共享配置",
    "cs.entry.item.apiBase": "后端地址",
    "cs.entry.item.node": "节点心跳",
    "cs.entry.missingIdentity": "尚未注册共享节点，请在 CPA 安装并启用 atl-share。",
    "cs.entry.missingConfig": "缺少 CPA 共享配置，请配置后端地址并启动节点。",
    "cs.entry.missingApi": "App 尚未配置后端地址。",
    "cs.entry.apiMismatch": "CPA 后端 {cpaApi} 与 App 后端 {appApi} 不一致，请将两者配置到同一后端。",
    "cs.entry.apiUnknown": "无法确认运行中 CPA 的后端地址，请等待节点心跳或检查 CPA 配置。",
    "cs.entry.nodeAge": "上次成功心跳：{ageSeconds} 秒前",
    "cs.entry.node.online": "在线",
    "cs.entry.node.stale": "心跳陈旧",
    "cs.entry.node.unknown": "状态未知",
    "cs.entry.nodeStale": "最近成功心跳已过期，请检查 CPA 是否运行及后端是否可达。",
    "cs.entry.nodeUnknown": "尚无有效心跳记录，请启动 CPA 并检查后端连接。",
    "cs.claim.testPaused": "测试已暂停：卡片当前不可见，返回后可重新测试。",
    "cs.claim.syncing": "等待节点同步（新 Key 随下一次心跳生效，约 8 秒）…",
    "cs.status.controlPlane": "控制面",
    "cs.status.heartbeat": "节点心跳",
    "cs.status.resource": "资源状态",
    "cs.status.myKey": "我的 Key",
    "cs.status.fresh": "刚刚更新",
    "cs.status.stale": "暂时无法更新",
    "cs.sync.pending": "策略待节点同步",
    "cs.sync.synced": "节点已应用",
    "cs.owner.stale": "暂时无法更新（{error}）· 已保留上次视图",
    "cs.owner.retry": "重试",
    "cs.owner.pendingSync": "有策略变更尚未被节点应用，最长 10 分钟内生效",
    "cs.lane.pause": "暂停",
    "cs.lane.resume": "恢复",
    "cs.lane.terminate": "终止",
    "cs.lane.pausedBadge": "已暂停（Key 保留）",
    "cs.lane.pauseConfirm": "暂停期间该车道拒绝新请求与新认领，已发 Key 保留且有效期继续。确定暂停？",
    "cs.lane.pauseSaved": "车道已暂停（Key 保留，随时可恢复）",
    "cs.lane.resumed": "车道已恢复",
    "cs.lane.terminateConfirm": "终止将级联撤销该车道 {count} 个有效认领且不可恢复（与暂停不同）。确定终止？",
    "cs.lane.terminated": "车道已终止",
    "cs.claim.revoke": "撤销",
    "cs.claim.revokeConfirm": "仅撤销这一个 Key，其他人不受影响。确定？",
    "cs.claim.revokedOk": "已撤销该 Key",
    "cs.policy.auto": "自动（车道内均分）",
    "cs.suggest.reference": "参考比例",
    "cs.suggest.referenceHint": "建议预算 = 近 7 天用量 × 参考比例，仅用于创建草稿，不保证自用额度，也不代表供应商剩余额度；创建后每个数都可改。",
    "cs.error.lanePaused": "车道已暂停（Key 保留，等待恢复）",
    "cs.claim.existing": "本机已有该资源有效 Key",
    "cs.claim.viewConfig": "查看配置",
    "cs.claim.claiming": "认领中…",
    "cs.trust.note": "模型请求会经过分享者的 CPA 服务，分享者可能接触请求和响应内容；ATL 平台只接收共享管理与用量元数据。请只使用你信任的分享者。",
    "cs.dim.fresh": "控制面刚刚更新",
    "cs.dim.stale": "控制面暂时无法更新",
    "cs.dim.nodesUnknown": "节点状态未知",
    "cs.dim.claimableUnknown": "可认领资源待更新",
    "cs.dim.nodes": "节点 {n} 在线 / {total}",
    "cs.dim.claimable": "{n} 条车道可认领",
    "cs.dim.keys": "我的 Key {n} 个有效",
    "cs.receipt.removed": "已清理 {n} 条失效认领：{list}",
    "cs.models.loading": "正在获取模型目录…",
    "cs.models.unavailable": "模型目录不可用（{error}）——请手动填写模型名",
    "cs.models.empty": "该车道范围在目录中无具体模型——请手动填写",
    "cs.models.pick": "模型",
    "cs.models.manual": "手动输入…",
    "cs.tool.title": "接入配置",
    "cs.tool.select": "目标工具",
    "cs.tool.claude": "Claude Code",
    "cs.tool.codex": "Codex CLI",
    "cs.tool.openai": "通用 OpenAI 兼容",
    "cs.tool.anthropic": "通用 Anthropic 兼容",
    "cs.tool.shell": "Shell",
    "cs.tool.copyAll": "复制全部",
    "cs.tool.copied": "已复制",
    "cs.tool.note": "以上变量仅当前终端会话生效（重启工具后失效）；不会写入你的配置文件。",
    "cs.tool.codexToml": "Codex 持久配置（粘贴到 ~/.codex/config.toml 后重启 Codex）",
    "cs.tool.codexNote": "Codex 0.14x 仅靠环境变量不会离开 ChatGPT 账号路径——需要下面的 provider 配置才会走共享端点；上面的环境变量仍供其他 OpenAI 兼容工具使用。粘贴后重启 Codex 生效。",
    "cs.quota.title": "额度",
    "cs.quota.keyCap": "单 Key 上限",
    "cs.quota.charged": "本窗口已计费",
    "cs.quota.raw": "累计原始用量",
    "cs.quota.laneAvail": "车道剩余",
    "cs.quota.auto": "自动均分",
    "cs.confirm.ok": "确认",
    "cs.confirm.cancel": "取消",
    cs_placeholder: null,
  },
  en: {
    "cs.entry.share": "I want to share",
    "cs.entry.shareHint": "Prepare your CPA node and configure shared resources",
    "cs.entry.steps": "Steps: ① install and run CLIProxyAPI (CPA) on this machine; ② install the atl-share execution plugin (scripts/install-cpa-plugin.sh); ③ once the api address is configured in CPA, this card detects it and shows the My Shares console.",
    "cs.entry.check": "Check",
    "cs.entry.item.identity": "Share node identity",
    "cs.entry.item.ownerConfig": "CPA share config",
    "cs.entry.item.apiBase": "Backend address",
    "cs.entry.item.node": "Node heartbeat",
    "cs.entry.missingIdentity": "No share node is registered. Install and enable atl-share in CPA.",
    "cs.entry.missingConfig": "CPA share config is missing. Configure the backend address and start the node.",
    "cs.entry.missingApi": "The app has no backend address configured.",
    "cs.entry.apiMismatch": "CPA uses {cpaApi}, but the app uses {appApi}. Configure both to use the same backend.",
    "cs.entry.apiUnknown": "The running CPA backend address is unknown. Wait for a heartbeat or check CPA configuration.",
    "cs.entry.nodeAge": "Last successful heartbeat: {ageSeconds}s ago",
    "cs.entry.node.online": "Online",
    "cs.entry.node.stale": "Stale heartbeat",
    "cs.entry.node.unknown": "Unknown status",
    "cs.entry.nodeStale": "The last successful heartbeat is stale. Check that CPA is running and the backend is reachable.",
    "cs.entry.nodeUnknown": "No valid heartbeat is available. Start CPA and check its backend connection.",
    "cs.claim.testPaused": "Test paused because this card is hidden. Run Test again when you return.",
    "cs.claim.syncing": "Waiting for node sync (the new key activates with the next heartbeat, ~8s)…",
    "cs.confirm.ok": "Confirm",
    "cs.confirm.cancel": "Cancel",
    "cs.status.controlPlane": "Control plane",
    "cs.status.heartbeat": "Node heartbeat",
    "cs.status.resource": "Resource",
    "cs.status.myKey": "My key",
    "cs.status.fresh": "just updated",
    "cs.status.stale": "update failed",
    "cs.sync.pending": "policy pending node sync",
    "cs.sync.synced": "node applied",
    "cs.owner.stale": "Temporarily unable to update ({error}) · last view kept",
    "cs.owner.retry": "Retry",
    "cs.owner.pendingSync": "Policy changes not applied by the node yet; effective within ~10 minutes",
    "cs.lane.pause": "Pause",
    "cs.lane.resume": "Resume",
    "cs.lane.terminate": "Terminate",
    "cs.lane.pausedBadge": "Paused (keys kept)",
    "cs.lane.pauseConfirm": "While paused the lane rejects requests and new claims; issued keys are kept with TTL running. Pause?",
    "cs.lane.pauseSaved": "Lane paused (keys kept, resumable anytime)",
    "cs.lane.resumed": "Lane resumed",
    "cs.lane.terminateConfirm": "Terminating cascade-revokes {count} valid claim(s) on this lane and cannot be undone (unlike pause). Terminate?",
    "cs.lane.terminated": "Lane terminated",
    "cs.claim.revoke": "Revoke",
    "cs.claim.revokeConfirm": "Revokes only this key; other borrowers are unaffected. Continue?",
    "cs.claim.revokedOk": "Key revoked",
    "cs.policy.auto": "Auto (fair split inside the lane)",
    "cs.suggest.reference": "Reference ratio",
    "cs.suggest.referenceHint": "Suggested budget = last 7 days of usage × reference ratio. Draft-only: it does not reserve your own quota and does not reflect provider balance; every number is editable after creation.",
    "cs.error.lanePaused": "Lane paused (keys kept, waiting for resume)",
    "cs.claim.existing": "You already hold a valid key for this resource",
    "cs.claim.viewConfig": "View config",
    "cs.claim.claiming": "Claiming…",
    "cs.trust.note": "Model requests pass through the sharer's CPA service; the sharer may see request and response content. The ATL platform only receives sharing-management and usage metadata. Use sharers you trust.",
    "cs.dim.fresh": "control plane just updated",
    "cs.dim.stale": "control plane update failed",
    "cs.dim.nodesUnknown": "node status unknown",
    "cs.dim.claimableUnknown": "claimable resources unknown",
    "cs.dim.nodes": "{n}/{total} nodes online",
    "cs.dim.claimable": "{n} lanes claimable",
    "cs.dim.keys": "{n} valid keys of mine",
    "cs.receipt.removed": "Removed {n} dead claims: {list}",
    "cs.models.loading": "Loading model catalog…",
    "cs.models.unavailable": "Model catalog unavailable ({error}) — enter the model name manually",
    "cs.models.empty": "No concrete model in this lane's scope — enter the model name manually",
    "cs.models.pick": "Model",
    "cs.models.manual": "Manual entry…",
    "cs.tool.title": "Connect a tool",
    "cs.tool.select": "Target tool",
    "cs.tool.claude": "Claude Code",
    "cs.tool.codex": "Codex CLI",
    "cs.tool.openai": "Generic OpenAI-compatible",
    "cs.tool.anthropic": "Generic Anthropic-compatible",
    "cs.tool.shell": "Shell",
    "cs.tool.copyAll": "Copy all",
    "cs.tool.copied": "Copied",
    "cs.tool.note": "These variables apply to the current terminal session only (gone after restarting the tool); nothing is written to your config files.",
    "cs.tool.codexToml": "Persistent Codex config (paste into ~/.codex/config.toml, then restart Codex)",
    "cs.tool.codexNote": "Codex 0.14x ignores bare env vars and stays on its ChatGPT account path — the provider config below is what routes it to the shared endpoint; the env vars above still serve other OpenAI-compatible tools. Restart Codex after pasting.",
    "cs.quota.title": "Quota",
    "cs.quota.keyCap": "Per-key cap",
    "cs.quota.charged": "Charged this window",
    "cs.quota.raw": "Raw lifetime usage",
    "cs.quota.laneAvail": "Lane remaining",
    "cs.quota.auto": "auto fair split",
    cs_placeholder: null,
  },
};

export default {
  async mount(el, ctx) {
    const esc = ctx.escapeHtml;
    // 语言来自宿主通用能力 lang()（旧宿主退回 <html lang>/浏览器语言）。
    // tt 查找顺序：插件字典 → 宿主 t() → key 本身。
    const langOf = () => {
      const raw = (ctx.lang ? ctx.lang() : "") || document.documentElement.lang || navigator.language || "";
      return String(raw).toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    };
    const interpolate = (text, params) => String(text).replace(/\{(\w+)\}/g, (_, name) => (params && name in params ? String(params[name]) : `{${name}}`));
    const t = (key, params) => {
      const dict = STRINGS[langOf()] || STRINGS["zh-CN"];
      if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return interpolate(dict[key], params);
      if (typeof ctx.t === "function") return ctx.t(key, params);
      return key;
    };

    let style = document.getElementById("compute-sharing-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "compute-sharing-style";
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    el.innerHTML = `
      <div class="cs-tabs-row">
        <div class="cs-tabs segmented" data-cs="tabs" hidden>
          <button class="cs-tab" type="button" data-cs-tab="owner">${esc(t("desktop.sharing.tab.owner"))}</button>
          <button class="cs-tab" type="button" data-cs-tab="borrow">${esc(t("desktop.sharing.tab.borrow"))}</button>
        </div>
        <span class="cs-grow"></span>
        <button class="outline-button" type="button" data-cs="refresh">${esc(t("desktop.sharing.borrow.refresh"))}</button>
      </div>
      <div data-cs="owner" hidden>
        <div data-cs="owner-body" aria-live="polite"></div>
      </div>
      <div class="cs-board" data-cs="board" hidden>
        <section>
          <div class="modules-section-title" style="margin:2px 0 6px">${esc(t("desktop.sharing.borrow.section"))}</div>
          <div class="cs-dimstrip" data-cs="dimstrip"></div>
          <div class="cs-trust" data-cs="trust">${esc(t("cs.trust.note"))}</div>
          <div data-cs="entry" hidden></div>
          <div data-cs="directory" aria-live="polite"></div>
        </section>
        <section>
          <div class="cs-head cs-section">
            <div class="modules-section-title">${esc(t("desktop.sharing.borrow.myClaims"))}</div>
          </div>
          <div data-cs="mine" aria-live="polite"></div>
        </section>
      </div>
      <span class="cs-status action-message" data-cs="status" aria-live="polite"></span>`;

    const els = {
      tabs: el.querySelector('[data-cs="tabs"]'),
      board: el.querySelector('[data-cs="board"]'),
      owner: el.querySelector('[data-cs="owner"]'),
      ownerBody: el.querySelector('[data-cs="owner-body"]'),
      dimstrip: el.querySelector('[data-cs="dimstrip"]'),
      trust: el.querySelector('[data-cs="trust"]'),
      entry: el.querySelector('[data-cs="entry"]'),
      directory: el.querySelector('[data-cs="directory"]'),
      mine: el.querySelector('[data-cs="mine"]'),
      status: el.querySelector('[data-cs="status"]'),
    };

    // wry（Tauri webview）不渲染 JS 对话框：window.confirm 静默返回 false，
    // 所有确认门控动作在真机上都是无声 no-op（2026-09-20 真机复验发现）。
    // 统一改为卡内确认条：消息 + 确认/取消，返回 Promise<boolean>。
    let confirmBar = null;
    const askConfirm = (text) => new Promise((resolve) => {
      if (confirmBar) confirmBar.remove();
      confirmBar = document.createElement("div");
      confirmBar.className = "cs-confirm";
      confirmBar.innerHTML = `<span class="cs-confirm-text"></span>
        <span class="cs-grow"></span>
        <button class="outline-button" type="button" data-cs-confirm-no></button>
        <button class="primary-pill" type="button" data-cs-confirm-yes></button>`;
      confirmBar.querySelector(".cs-confirm-text").textContent = text;
      const no = confirmBar.querySelector("[data-cs-confirm-no]");
      const yes = confirmBar.querySelector("[data-cs-confirm-yes]");
      no.textContent = t("cs.confirm.cancel");
      yes.textContent = t("cs.confirm.ok");
      const done = (answer) => { confirmBar.remove(); confirmBar = null; resolve(answer); };
      no.addEventListener("click", () => done(false));
      yes.addEventListener("click", () => done(true));
      (els.owner.hidden ? els.board : els.owner).prepend(confirmBar);
    });

    const busy = (on) => {
      const button = el.querySelector('[data-cs="refresh"]');
      if (button) button.disabled = on;
    };
    const message = (text) => { els.status.textContent = text || ""; };
    // Receipts ride the host toast (ctx.notify) with an in-card fallback for
    // older hosts; errors keep the persistent in-card status line.
    const notify = (text) => (ctx.notify ? ctx.notify(text, { duration: 4000 }) : message(text));
    const guard = async (fn) => {
      const focused = document.activeElement;
      busy(true);
      try { await fn(); } catch (error) { message(String(error.message || error)); } finally {
        busy(false);
        // Disabling the initiating button blurs it in Chromium/WebKit. Restore
        // only if nothing else gained focus while the operation was running.
        if (document.activeElement === document.body && focused?.isConnected && focused.offsetParent !== null) {
          focused.focus({ preventScroll: true });
        }
      }
    };


    // ── 我的分享（owner 控制台；未注册整区隐藏） ─────────────────────────
    // Share-level knobs kept after lanes moved budget/maxClaims into lanes.
    const ownerFieldDefs = [
      ["keyMaxTokens", "desktop.sharing.owner.f.keyMax"],
      ["keyConcurrency", "desktop.sharing.owner.f.keyConc"],
      ["ttlHours", "desktop.sharing.owner.f.ttl"],
    ];

    // window spec label (R50): {hour|day|week, n} → 每天 / 每 5 小时 / 每 2 周…
    const windowLabel = (window) => {
      const unit = window && window.unit ? String(window.unit) : "day";
      const n = Math.max(1, Math.round(Number(window && window.n) || 1));
      if (n === 1) return t(`desktop.sharing.lane.window.${unit}One`);
      return t(`desktop.sharing.lane.window.${unit}`, { n: String(n) });
    };
    const scheduleText = (lane) => (lane.schedule && lane.schedule.length
      ? lane.schedule.map((w) => `${w.start}–${w.end}`).join(", ")
      : t("desktop.sharing.lane.scheduleAllDay"));

    // lane edit state: null = closed; {isNew, index, draft fields}
    let laneEditor = null;
    // R2-06A: focused lane-editor field across refresh rebuilds
    let laneFocus = null;
    // Tab categorization: owners get 我的分享/算力借用; pure borrowers keep a
    // single-column card (no tab bar). Selection survives refreshes.
    // §4.1: borrow is the default surface — sharing is opt-in, and a pure
    // borrower should never land inside an owner console first.
    let activeTab = "borrow";
    // "pending" until the first owner-status settles — the tab bar's
    // data-owner attribute is the test/UX contract that removes the
    // board-temporarily-visible race for pure borrowers
    let ownerSettled = false;
    const hasOwnerConsole = () => Boolean(lastOwnerData && lastOwnerData.share && lastOwnerData.share.shareId);
    function applyTabs() {
      const hasOwner = hasOwnerConsole();
      els.tabs.dataset.owner = ownerSettled ? (hasOwner ? "yes" : "no") : "pending";
      els.tabs.hidden = !hasOwner;
      els.owner.hidden = !hasOwner || activeTab !== "owner";
      els.board.hidden = hasOwner && activeTab !== "borrow";
      // Stacking is measured, not a viewport media query (R52 review): the
    // card sits inside the app layout, so 1120px viewport can still mean a
    // ~830px board — the borrow pane needs the full row there.
    const stackBoard = () => {
      const width = els.board.clientWidth || 0;
      els.board.classList.toggle("cs-stacked", width > 0 && width < 980);
    };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(stackBoard).observe(els.board);
    stackBoard();

    for (const button of els.tabs.querySelectorAll("[data-cs-tab]")) {
        button.classList.toggle("active", button.dataset.csTab === (hasOwner ? activeTab : "borrow"));
      }
    }
    for (const button of Array.from(el.querySelectorAll("[data-cs-tab]"))) {
      button.addEventListener("click", () => {
        activeTab = button.dataset.csTab;
        applyTabs();
      });
    }

    // Peak multiplier chip + owner-tz label: borrowers must see the billing
    // rule and whose clock the schedule follows (review B12 / B10).
    const laneTags = (lane) => {
      const tags = [];
      if (lane.peak && lane.peak.multiplier > 1 && lane.peak.windows && lane.peak.windows.length) {
        const wins = lane.peak.windows.map((w) => `${w.start}–${w.end}`).join(", ");
        tags.push(`<span class="cs-lane-tag">${esc(t("desktop.sharing.lane.peakTag", { n: String(lane.peak.multiplier) }))} ${esc(wins)}</span>`);
      }
      if (lane.tzLabel) tags.push(`<span class="cs-lane-tag">${esc(lane.tzLabel)}</span>`);
      return tags.join(" ");
    };

    function laneDot(lane) {
      if (lane.state === "suspended" || lane.state === "paused") return "paused";
      if (!lane.open) return "off";
      if (lane.exhausted) return "paused";
      return "on";
    }
    const laneStatusText = (lane) => {
      if (lane.state === "suspended") return `<span class="cs-state">${esc(t("desktop.sharing.lane.paused"))}</span>`;
      if (lane.state === "paused") return `<span class="cs-state">${esc(t("cs.lane.pausedBadge"))}</span>`;
      if (!lane.open) return `${esc(t("desktop.sharing.lane.closedUntil"))} · ${esc(clockText(Date.now() + (lane.retryAfterMs || 0)))}`;
      if (lane.exhausted) return `<span class="cs-state">${esc(t("desktop.sharing.lane.exhausted"))}</span> ${esc(t("desktop.sharing.lane.resetAt", { time: clockText(lane.windowEndsAtMs || Date.now()) }))}`;
      return esc(t("web.sharing.online"));
    };

    // claim.state i18n map (review B1: no bare enums on a zh card)
    const claimStateText = (state) => ({
      valid: t("desktop.sharing.owner.claimValid"),
      revoked: t("desktop.sharing.borrow.stateRevoked"),
      expired: t("desktop.sharing.borrow.stateExpired"),
    }[state] || state);

    function renderLaneRow(lane, index) {
      const total = lane.budgetTokens || 0;
      const used = lane.settledTokens || 0;
      const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
      return `
        <div class="cs-lane" data-cs-lane="${esc(lane.id)}">
          <div class="cs-kv">
            <span><span class="cs-dot cs-dot-${laneDot(lane)}"></span> <strong>${esc(lane.title)}</strong>
              <span class="cs-lane-tag">${esc(lane.models.join(", "))}</span></span>
            <span>${laneStatusText(lane)}</span>
          </div>
          <div class="cs-kv"><span class="cs-muted">${esc(windowLabel(lane.window))} · ${esc(scheduleText(lane))} ${laneTags(lane)}</span>
            <span class="num">${esc(compact(used))} / ${esc(compact(total))}</span></div>
          <div class="cs-meter"><i style="width:${pct}%"></i></div>
          <div class="cs-actions">
            <span class="cs-muted">${esc(t("desktop.sharing.lane.slots"))}: ${esc(String(lane.slotsLeft))}/${esc(String(lane.maxClaims))}</span>
            <span class="cs-grow"></span>
            <button class="outline-button" type="button" data-cs-lane-edit="${index}">${esc(t("desktop.sharing.lane.edit"))}</button>
            ${lane.state === "paused"
              ? `<button class="outline-button" type="button" data-cs-lane-resume2="${index}">${esc(t("cs.lane.resume"))}</button>`
              : lane.state === "suspended"
                ? `<span class="cs-state">${esc(t("desktop.sharing.lane.paused"))}</span>`
                : `<button class="outline-button" type="button" data-cs-lane-pause="${index}">${esc(t("cs.lane.pause"))}</button>`}
            ${lane.state !== "suspended" ? `<button class="cs-tpl-del" type="button" data-cs-lane-terminate="${index}" title="${esc(t("cs.lane.terminate"))}">${esc(t("cs.lane.terminate"))}</button>` : ""}
          </div>
        </div>`;
    }

    function renderLaneEditor(lanes) {
      const editing = laneEditor;
      if (!editing) return "";
      const draft = editing.draft;
      return `
        <div class="cs-row" data-cs="lane-form">
          <div class="cs-muted">${esc(t(editing.isNew ? "desktop.sharing.lane.addTitle" : "desktop.sharing.lane.editTitle"))}</div>
          <div class="cs-fields">
            <label class="grow">${esc(t("desktop.sharing.lane.f.title"))}<input data-cs-f="title" type="text" value="${esc(draft.title)}" /></label>
            <label class="grow">${esc(t("desktop.sharing.lane.f.models"))}<input data-cs-f="models" type="text" placeholder="*" value="${esc(draft.models)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.period"))}<select data-cs-f="windowUnit">
              ${["day", "week", "hour"].map((u) => `<option value="${u}"${draft.windowUnit === u ? " selected" : ""}>${esc(windowLabel({ unit: u, n: 1 }))}</option>`).join("")}
            </select></label>
            <label>${esc(t("desktop.sharing.lane.f.windowN"))}<input data-cs-f="windowN" type="number" min="1" max="48" step="1" value="${esc(String(draft.windowN || 1))}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.budget"))}<input data-cs-f="budget" type="number" step="1000" min="1000" value="${esc(String(draft.budget))}" /><span class="cs-muted" data-cs="budgetHint">${esc(t("desktop.sharing.lane.budgetHint", { text: compact(draft.budget) }))}</span></label>
            <label>${esc(t("desktop.sharing.lane.f.maxClaims"))}<input data-cs-f="maxClaims" type="number" step="1" min="1" value="${esc(String(draft.maxClaims))}" /></label>
          </div>
          <div class="cs-fields">
            <label>${esc(t("desktop.sharing.lane.f.winStart"))}<input data-cs-f="winStart" type="time" value="${esc(draft.winStart)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.winEnd"))}<input data-cs-f="winEnd" type="time" value="${esc(draft.winEnd)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.peakStart"))}<input data-cs-f="peakStart" type="time" value="${esc(draft.peakStart)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.peakEnd"))}<input data-cs-f="peakEnd" type="time" value="${esc(draft.peakEnd)}" /></label>
            <label>${esc(t("desktop.sharing.lane.f.peakMultiplier"))}<input data-cs-f="peakMultiplier" type="number" step="1" min="1" max="10" value="${esc(String(draft.peakMultiplier))}" /></label>
          </div>
          <div class="cs-muted">${esc(t("desktop.sharing.lane.formHint"))}</div>
          ${editing.multiWindow ? `<div class="cs-state">${esc(t("desktop.sharing.lane.multiWindowHint"))}</div>` : ""}
          <div class="cs-actions">
            <span class="cs-grow"></span>
            <button class="outline-button" type="button" data-cs="laneSaveTpl">${esc(t("desktop.sharing.lane.saveTemplate"))}</button>
            <button class="outline-button" type="button" data-cs="laneCancel">${esc(t("desktop.sharing.lane.cancel"))}</button>
            ${editing.isNew ? "" : `<button class="outline-button" type="button" data-cs="laneDelete">${esc(t("desktop.sharing.lane.delete"))}</button>`}
            <button class="primary-pill" type="button" data-cs="laneSave">${esc(t("desktop.sharing.lane.save"))}</button>
          </div>
        </div>`;
    }

    // owner lanes come from owner-status share.lanes (full lane views)
    // Editing a different lane/template must not inherit the old form's
    // unsaved values: those handlers raise skipFormReadback for one render.
    let skipFormReadback = false;
    function renderOwner(data) {
      const share = (data && data.share) || {};
      const claims = (data && data.claims) || [];
      // Preserve in-progress editor input across refresh re-renders: the DOM
      // still holds the live values at this point (review A1 fix).
      if (laneEditor && !skipFormReadback) {
        const live = readLaneForm();
        if (live) Object.assign(laneEditor.draft, live);
      }
      skipFormReadback = false;
      // QA-06/R2-06: keep unsaved policy edits + focus across the rebuild,
      // and the lane editor's focused field + selection too (values already
      // ride via readLaneForm → draft)
      capturePolicyEdits(els.ownerBody);
      laneFocus = null;
      const focusedLaneField = els.ownerBody.querySelector('[data-cs="lane-form"] [data-cs-f]:focus');
      if (focusedLaneField) {
        laneFocus = {
          name: focusedLaneField.dataset.csF,
          selStart: focusedLaneField.selectionStart,
          selEnd: focusedLaneField.selectionEnd,
        };
      }
      applyTabs();
      if (!share.shareId) {
        els.ownerBody.innerHTML = "";
        return;
      }
      if (share.state === "stopped") {
        els.ownerBody.innerHTML = `
          <div class="cs-row">
            <div class="cs-kv"><strong>${esc(share.title || share.shareId)}</strong>
              <span class="cs-state">${esc(t("desktop.sharing.owner.stoppedState"))}</span></div>
            <div class="cs-muted">${esc(t("desktop.sharing.owner.stoppedHint"))}</div>
            <div class="cs-actions">
              <span class="cs-muted">${esc(t("desktop.sharing.owner.lifetime"))}: ${esc(compact(share.lifetimeSettled))}</span>
              <span class="cs-grow"></span>
              <button class="primary-pill" type="button" data-cs="resume">${esc(t("desktop.sharing.owner.resume"))}</button>
            </div>
          </div>`;
        els.ownerBody.querySelector('[data-cs="resume"]').addEventListener("click", () => guard(async () => {
          await ctx.invoke("compute-sharing:owner-resume", {});
          notify(t("desktop.sharing.owner.resumed"));
          await refresh({ forceShares: true });
        }));
        return;
      }
      const lanes = share.lanes || [];
      const wall = share.wallSignal;
      // §5.3: transient owner-status failures keep the view and say so; the
      // definitive not_registered already collapsed the section upstream
      const staleBanner = ownerStaleError
        ? `<div class="cs-wall"><span>⚠️</span><span>${esc(t("cs.owner.stale", { error: ownerStaleError }))}</span>
            <button class="outline-button" type="button" data-cs="retryOwner">${esc(t("cs.owner.retry"))}</button></div>`
        : "";
      // §8: accepted vs applied — the backend bumped policyRev but the node
      // hasn't acked yet (fail-closed staleness bounds this at ~10 minutes)
      const pendingSync = (share.policyRev || 1) > (share.policyAckedRev || 0)
        ? `<div class="cs-pending">${esc(t("cs.owner.pendingSync"))} (${share.policyAckedRev || 0}/${share.policyRev || 1})</div>`
        : "";
      // R53-1: advisory endpoint misconfiguration (LAN baseURL + loopback
      // CPA bind) — loud from day one, right where the owner looks
      const endpointWarn = data.pluginStatus && data.pluginStatus.endpointWarning
        ? `<div class="cs-wall"><span>⚠️</span><span>${esc(t("desktop.sharing.owner.endpointWarn"))}: ${esc(data.pluginStatus.endpointWarning)}</span></div>`
        : "";
      const wallBanner = wall && wall.ownerFailed
        ? `<div class="cs-wall"><span>⚠️</span><span>${esc(t("desktop.sharing.owner.wall", { count: String(wall.ownerFailed) }))}</span></div>`
        : "";
      const shortId = (id) => (id && id.length > 10 ? `${id.slice(0, 8)}…` : id || "");
      const laneLabelOf = (laneId) => (laneId === "default" ? t("desktop.sharing.lane.defaultTitle") : laneTitleOf(lanes, laneId));
      const claimRow = (c) => `
        <div class="cs-kv" style="${c.state !== "valid" ? "opacity:.55" : ""}">
          <span>${esc(c.borrower || c.keyId)}${c.displayId ? ` <span class="cs-muted" title="${esc(c.displayId)}">${esc(shortId(c.displayId))}</span>` : ""}${c.laneId ? ` <span class="cs-lane-tag">${esc(laneLabelOf(c.laneId))}</span>` : ""} · <span class="num">${esc(String(c.keyId).slice(0, 11))}…</span></span>
          <span class="cs-actions">
            <span class="num">${esc(compact(c.usedTokens))} · ${esc(claimStateText(c.state))}</span>
            ${c.state === "valid" ? `<button class="cs-tpl-del" type="button" data-cs-claim-revoke="${esc(c.keyId)}" title="${esc(t("cs.claim.revoke"))}">${esc(t("cs.claim.revoke"))}</button>` : ""}
          </span>
        </div>`;
      // dead claims carry no console value (user decision): only valid,
      // unexpired claims are listed — the backend and admin view keep the
      // full audit trail
      const rows = claims
        .filter((c) => c.state === "valid" && c.expiresAt > Date.now())
        .map(claimRow)
        .join("");
      els.ownerBody.innerHTML = `
        ${staleBanner}${endpointWarn}${wallBanner}${pendingSync}
        <div class="cs-row">
          <div class="cs-kv"><strong>${esc(share.title || share.shareId)}</strong>
            <span>${esc(t("web.sharing.online"))}${share.plugin && share.plugin.online ? "" : ` · ${esc(t("desktop.sharing.owner.pluginOffline"))}${pluginOfflineReason(data)}`}</span></div>
          <div class="cs-kv"><span class="cs-muted">${esc(t("desktop.sharing.owner.lifetime"))}</span><span class="num">${esc(compact(share.lifetimeSettled))}</span></div>
          ${lanes.map(renderLaneRow).join("")}
          ${renderLaneEditor(lanes)}
          ${laneEditor ? "" : templateBlock()}
          ${suggestBlock()}
          ${rows ? `<div class="cs-muted">${esc(t("desktop.sharing.owner.claims"))}</div>${rows}` : `<div class="cs-muted">${esc(t("desktop.sharing.owner.noClaims"))}</div>`}
          <div class="cs-actions">
            <span class="cs-grow"></span>
            <button class="outline-button" type="button" data-cs="stop">${esc(t("desktop.sharing.owner.stop"))}</button>
          </div>
        </div>
        <div class="cs-row">
          <div class="cs-muted">${esc(t("desktop.sharing.owner.advanced"))}</div>
          <div class="cs-fields">${ownerFieldDefs.map(([key, labelKey]) => `
            <label>${esc(t(labelKey))}<input data-cs-policy="${key}" type="number" step="1" value="${esc(String((share.policy && share.policy[key]) ?? ""))}" /></label>`).join("")}
          </div>
          <div class="cs-actions">
            <span class="cs-grow"></span>
            <button class="outline-button" type="button" data-cs="savePolicy">${esc(t("desktop.sharing.owner.savePolicy"))}</button>
          </div>
        </div>`;
      applyPolicyEdits(els.ownerBody);
      if (laneFocus) {
        const field = els.ownerBody.querySelector(`[data-cs="lane-form"] [data-cs-f="${laneFocus.name}"]`);
        if (field) {
          field.focus();
          try { field.setSelectionRange(laneFocus.selStart, laneFocus.selEnd); } catch { /* selects have no ranges */ }
        }
      }
      applyTabs();
      wireOwnerEvents(lanes);
    }

    // R51-4: the plugin writes status.json beside its identity; owner-status
    // merges it — surface WHY it is offline, not just that it is. Raw reason
    // text is diagnostic (transport/status strings), not localized UI copy.
    const pluginOfflineReason = (data) => {
      const status = data && data.pluginStatus;
      return status && status.lastError ? ` · ${esc(status.lastError)}` : "";
    };

    const laneTitleOf = (lanes, laneId) => {
      const lane = (lanes || []).find((l) => l.id === laneId);
      return lane ? lane.title : laneId;
    };

    const laneSlotsUsedOf = (lanes, laneId) => {
      const claims = (lastOwnerData && lastOwnerData.claims) || [];
      return claims.filter((c) => (c.laneId || "default") === laneId && c.state === "valid").length;
    };

    function readLaneForm() {
      const form = els.ownerBody.querySelector('[data-cs="lane-form"]');
      if (!form) return null;
      const val = (name) => form.querySelector(`[data-cs-f="${name}"]`)?.value ?? "";
      return {
        title: val("title").trim(),
        models: val("models").trim(),
        windowUnit: val("windowUnit") || "day",
        windowN: Number(val("windowN")) || 1,
        budget: Number(val("budget")),
        maxClaims: Number(val("maxClaims")),
        winStart: val("winStart"),
        winEnd: val("winEnd"),
        peakStart: val("peakStart"),
        peakEnd: val("peakEnd"),
        peakMultiplier: Number(val("peakMultiplier")) || 1,
      };
    }

    async function saveLanes(lanes, { successKey = "desktop.sharing.lane.saved" } = {}) {
      await ctx.invoke("compute-sharing:owner-policy", { lanes });
      notify(t(successKey));
      laneEditor = null;
      // lane/policy writes change what the borrower directory shows — force
      // the shares refetch or the directory keeps stale lanes until a manual
      // refresh
      await refresh({ forceShares: true });
    }

    // lanes wire format: budget/schedule/peak nests; id/title/models flat.
    // Accepts view-shaped lanes (models array, schedule/peak view) — the only
    // shape owner-status and the editor produce.
    function toWireLane(lane) {
      // Draft lanes carry windowUnit/windowN; pass-through lanes (untouched
      // owner-status views) carry window:{unit,n}. Read both or every save
      // silently degrades the unedited lanes' budget window to day/1.
      const windowUnit = lane.windowUnit || (lane.window && lane.window.unit) || "day";
      const windowN = lane.windowN != null ? lane.windowN : (lane.window && lane.window.n);
      const wire = {
        id: lane.id,
        title: lane.title,
        models: Array.isArray(lane.models) ? lane.models : String(lane.models).split(",").map((m) => m.trim()).filter(Boolean),
        budget: { tokens: lane.budgetTokens },
        window: { unit: windowUnit, n: Math.max(1, Math.round(Number(windowN) || 1)) },
        maxClaims: lane.maxClaims,
        state: lane.state,
      };
      if (lane.schedule && lane.schedule.length) {
        wire.schedule = { windows: lane.schedule.map((w) => ({ start: w.start, end: w.end })) };
      }
      if (lane.peak && lane.peak.windows && lane.peak.windows.length && lane.peak.multiplier > 1) {
        wire.peak = { windows: lane.peak.windows.map((w) => ({ start: w.start, end: w.end })), multiplier: lane.peak.multiplier };
      }
      return wire;
    }

    function wireOwnerEvents(lanes) {
      for (const input of els.ownerBody.querySelectorAll("[data-cs-policy]")) {
        input.addEventListener("input", () => policyDirty.add(input.dataset.csPolicy));
      }
      const savePolicy = els.ownerBody.querySelector('[data-cs="savePolicy"]');
      if (savePolicy) savePolicy.addEventListener("click", () => guard(async () => {
        const policy = {};
        for (const [key] of ownerFieldDefs) {
          const raw = els.ownerBody.querySelector(`[data-cs-policy="${key}"]`)?.value;
          if (raw === undefined || String(raw).trim() === "") continue;
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0) throw new Error(t("desktop.sharing.owner.policyInvalid"));
          policy[key] = Math.round(value);
        }
        if (!Object.keys(policy).length) throw new Error(t("desktop.sharing.owner.policyEmpty"));
        await ctx.invoke("compute-sharing:owner-policy", { policy });
        for (const key of Object.keys(policy)) {
          policyDraft.delete(key);
          policyDirty.delete(key);
        }
        policyFocus = null;
        notify(t("desktop.sharing.owner.policySaved"));
        await refresh({ forceShares: true });
      }));
      const stop = els.ownerBody.querySelector('[data-cs="stop"]');
      if (stop) stop.addEventListener("click", () => guard(async () => {
        if (!(await askConfirm(t("desktop.sharing.owner.stopConfirm")))) return;
        await ctx.invoke("compute-sharing:owner-unregister", {});
        notify(t("desktop.sharing.owner.stopped"));
        await refresh({ forceShares: true });
      }));

      for (const button of els.ownerBody.querySelectorAll("[data-cs-lane-edit]")) {
        button.addEventListener("click", () => {
          const lane = lanes[Number(button.dataset.csLaneEdit)];
          // switching edit targets: the old form's unsaved values must NOT
          // bleed into the new draft (review B-1 regression guard)
          skipFormReadback = true;
          laneEditor = {
            isNew: false,
            // multi-window lanes (built via admin/API) collapse to their first
            // window on save — surface that instead of dropping it silently
            multiWindow: (lane.schedule?.length || 0) > 1 || (lane.peak?.windows?.length || 0) > 1,
            draft: {
              id: lane.id, title: lane.title, models: lane.models.join(", "),
              windowUnit: (lane.window && lane.window.unit) || "day", windowN: (lane.window && lane.window.n) || 1,
              budget: lane.budgetTokens, maxClaims: lane.maxClaims,
              winStart: lane.schedule?.[0]?.start || "", winEnd: lane.schedule?.[0]?.end || "",
              peakStart: lane.peak?.windows?.[0]?.start || "", peakEnd: lane.peak?.windows?.[0]?.end || "",
              peakMultiplier: lane.peak?.multiplier || 1, state: lane.state,
            },
          };
          renderOwnerLast();
        });
      }
      // derived suggestion → pre-filled editor: family wildcard, complement of
      // the owner's busy window, budget = own use × (1 − reserve). All editable.
      for (const button of els.ownerBody.querySelectorAll("[data-cs-family]")) {
        button.addEventListener("click", () => {
          const fam = ((suggestData && suggestData.families) || [])[Number(button.dataset.csFamily)];
          if (!fam) return;
          skipFormReadback = true;
          const open = fam.busy ? { start: fam.busy.end, end: fam.busy.start } : null;
          laneEditor = {
            isNew: true,
            draft: {
              id: "", title: fam.family, models: fam.family, windowUnit: "week", windowN: 1,
              budget: suggestedBudget(fam.weeklyTokens), maxClaims: 2,
              winStart: open?.start || "", winEnd: open?.end || "",
              peakStart: "", peakEnd: "", peakMultiplier: 1, state: "active",
            },
          };
          renderOwnerLast();
        });
      }
      for (const button of els.ownerBody.querySelectorAll("[data-cs-tpl]")) {
        button.addEventListener("click", () => {
          const key = button.dataset.csTpl;
          skipFormReadback = true;
          const tpl = key === "blank" ? null : cardConfig.laneTemplates[Number(key)];
          if (key !== "blank" && !tpl) return;
          laneEditor = {
            isNew: true,
            draft: tpl ? {
              id: "", title: tpl.title || tpl.models, models: tpl.models, windowUnit: tpl.windowUnit || "week", windowN: Number(tpl.windowN) || 1,
              budget: Number(tpl.budget) || 10_000_000, maxClaims: Number(tpl.maxClaims) || 1,
              winStart: tpl.winStart || "", winEnd: tpl.winEnd || "",
              peakStart: "", peakEnd: "", peakMultiplier: 1, state: "active",
            } : {
              id: "", title: "", models: "*", windowUnit: "day", windowN: 1, budget: 10_000_000, maxClaims: 1,
              winStart: "", winEnd: "", peakStart: "", peakEnd: "", peakMultiplier: 1, state: "active",
            },
          };
          renderOwnerLast();
        });
      }
      for (const button of els.ownerBody.querySelectorAll("[data-cs-tpl-del]")) {
        button.addEventListener("click", () => guard(async () => {
          const index = Number(button.dataset.csTplDel);
          const list = cardConfig.laneTemplates.filter((_, i) => i !== index);
          cardConfig.laneTemplates = list;
          await saveCardConfig({ laneTemplates: list });
          renderOwnerLast();
        }));
      }
      const reserveInput = els.ownerBody.querySelector('[data-cs="reserve"]');
      if (reserveInput) reserveInput.addEventListener("change", () => guard(async () => {
        const value = Math.min(95, Math.max(5, Math.round(Number(reserveInput.value) || 75)));
        reserveInput.value = String(value);
        cardConfig.referencePct = value;
        await saveCardConfig({ referencePct: value });
        renderOwnerLast();
      }));
      const laneSaveTpl = els.ownerBody.querySelector('[data-cs="laneSaveTpl"]');
      if (laneSaveTpl) laneSaveTpl.addEventListener("click", () => guard(async () => {
        const form = readLaneForm();
        if (!form || !form.models.trim() || !Number.isFinite(form.budget) || form.budget < 1000) {
          throw new Error(t("desktop.sharing.lane.templateInvalid"));
        }
        if (cardConfig.laneTemplates.length >= 6) throw new Error(t("desktop.sharing.lane.templatesFull"));
        const tpl = {
          title: form.title.trim() || form.models.trim(), models: form.models.trim(), windowUnit: form.windowUnit, windowN: form.windowN,
          budget: Math.round(form.budget), maxClaims: Math.round(form.maxClaims) || 1,
          winStart: form.winStart, winEnd: form.winEnd,
        };
        const list = [...cardConfig.laneTemplates.filter((x) => x.title !== tpl.title), tpl].slice(-6);
        cardConfig.laneTemplates = list;
        await saveCardConfig({ laneTemplates: list });
        notify(t("desktop.sharing.lane.templateSaved"));
      }));
      // CS-07/D2: per-lane lifecycle over the dedicated lane-action API —
      // pause keeps keys (TTL running), resume brings the same keys back,
      // terminate cascades and is confirmed like 停止分享.
      for (const button of els.ownerBody.querySelectorAll("[data-cs-lane-pause]")) {
        button.addEventListener("click", () => guard(async () => {
          const lane = lanes[Number(button.dataset.csLanePause)];
          if (!(await askConfirm(t("cs.lane.pauseConfirm")))) return;
          await ctx.invoke("compute-sharing:owner-lane-action", { laneId: lane.id, action: "pause" });
          notify(t("cs.lane.pauseSaved"));
          await refresh({ forceShares: true });
        }));
      }
      for (const button of els.ownerBody.querySelectorAll("[data-cs-lane-resume2]")) {
        button.addEventListener("click", () => guard(async () => {
          const lane = lanes[Number(button.dataset.csLaneResume2)];
          await ctx.invoke("compute-sharing:owner-lane-action", { laneId: lane.id, action: "resume" });
          notify(t("cs.lane.resumed"));
          await refresh({ forceShares: true });
        }));
      }
      for (const button of els.ownerBody.querySelectorAll("[data-cs-lane-terminate]")) {
        button.addEventListener("click", () => guard(async () => {
          const lane = lanes[Number(button.dataset.csLaneTerminate)];
          if (!(await askConfirm(t("cs.lane.terminateConfirm", { count: String(laneSlotsUsedOf(lanes, lane.id)) })))) return;
          await ctx.invoke("compute-sharing:owner-lane-action", { laneId: lane.id, action: "terminate" });
          notify(t("cs.lane.terminated"));
          await refresh({ forceShares: true });
        }));
      }
      // CS-07: single-key revoke from the owner console — scoped to this
      // share, idempotent, other borrowers untouched
      for (const button of els.ownerBody.querySelectorAll("[data-cs-claim-revoke]")) {
        button.addEventListener("click", () => guard(async () => {
          const keyId = button.dataset.csClaimRevoke;
          if (!(await askConfirm(t("cs.claim.revokeConfirm")))) return;
          await ctx.invoke("compute-sharing:owner-revoke-claim", { keyId, reason: "owner_console" });
          notify(t("cs.claim.revokedOk"));
          await refresh({ forceShares: true });
        }));
      }
      const retryOwner = els.ownerBody.querySelector('[data-cs="retryOwner"]');
      if (retryOwner) retryOwner.addEventListener("click", () => guard(() => refresh({ forceShares: true })));
      const laneCancel = els.ownerBody.querySelector('[data-cs="laneCancel"]');
      if (laneCancel) laneCancel.addEventListener("click", () => { laneEditor = null; renderOwnerLast(); });
      const laneDelete = els.ownerBody.querySelector('[data-cs="laneDelete"]');
      if (laneDelete) laneDelete.addEventListener("click", () => guard(async () => {
        if (!(await askConfirm(t("desktop.sharing.lane.deleteConfirm")))) return;
        const id = laneEditor.draft.id;
        await saveLanes(lanes.filter((l) => l.id !== id).map(toWireLane), { successKey: "desktop.sharing.lane.deleted" });
      }));
      const laneSave = els.ownerBody.querySelector('[data-cs="laneSave"]');
      if (laneSave) laneSave.addEventListener("click", () => guard(async () => {
        const form = readLaneForm();
        if (!form) return;
        if (!form.title) throw new Error(t("desktop.sharing.lane.titleRequired"));
        const titleTaken = lanes.some((l) => l.id !== laneEditor.draft.id && l.title === form.title);
        if (titleTaken) throw new Error(t("desktop.sharing.lane.titleDuplicate"));
        if (!Number.isFinite(form.budget) || form.budget < 1000) throw new Error(t("desktop.sharing.lane.budgetInvalid"));
        if (!Number.isFinite(form.maxClaims) || form.maxClaims < 1) throw new Error(t("desktop.sharing.lane.maxClaimsInvalid"));
        // Half-filled windows must never degrade into "open all day" silently
        // (review B4): both bounds or neither; equal bounds are rejected too
        // instead of silently collapsing to all-day (review B2).
        const winComplete = (form.winStart && form.winEnd) || (!form.winStart && !form.winEnd);
        if (!winComplete) throw new Error(t("desktop.sharing.lane.windowIncomplete"));
        if (form.winStart && form.winStart === form.winEnd) throw new Error(t("desktop.sharing.lane.windowEqual"));
        const peakComplete = (form.peakStart && form.peakEnd) || (!form.peakStart && !form.peakEnd);
        if (!peakComplete) throw new Error(t("desktop.sharing.lane.peakIncomplete"));
        if (form.peakStart && form.peakStart === form.peakEnd) throw new Error(t("desktop.sharing.lane.windowEqual"));
        const halfWin = (start, end) => (start && end && start !== end) ? [{ start, end }] : [];
        const schedule = halfWin(form.winStart, form.winEnd);
        const peak = halfWin(form.peakStart, form.peakEnd);
        const draft = {
          id: laneEditor.draft.id || form.title,
          title: form.title,
          models: form.models.split(",").map((m) => m.trim()).filter(Boolean),
          budgetTokens: Math.round(form.budget),
          windowUnit: form.windowUnit,
          windowN: Math.max(1, Math.min(48, Math.round(form.windowN) || 1)),
          maxClaims: Math.round(form.maxClaims),
          state: laneEditor.draft.state || "active",
          schedule,
          peak: { windows: peak, multiplier: Math.round(form.peakMultiplier) },
        };
        const next = laneEditor.isNew
          ? [...lanes, draft]
          : lanes.map((l) => (l.id === laneEditor.draft.id ? draft : l));
        await saveLanes(next.map(toWireLane));
      }));

      // Live budget conversion hint (review B2): raw tokens <-> compact display
      const budgetInput = els.ownerBody.querySelector('[data-cs-f="budget"]');
      const budgetHint = els.ownerBody.querySelector('[data-cs="budgetHint"]');
      if (budgetInput && budgetHint) {
        budgetInput.addEventListener("input", () => {
          budgetHint.textContent = t("desktop.sharing.lane.budgetHint", { text: compact(Number(budgetInput.value) || 0) });
        });
      }
    }

    let lastOwnerData = {};
    const renderOwnerLast = () => renderOwner(lastOwnerData);
    // QA-06: 未保存的策略草稿与服务端快照分离——15s 合并刷新重建 owner 区时，
    // 已输入未保存的值、焦点和选区都必须原样保留；保存成功或用户清空才回落
    const policyDraft = new Map(); // key -> string (ONLY user-dirty fields)
    const policyDirty = new Set(); // keys the user actually typed into
    let policyFocus = null; // { key, selStart, selEnd }
    const capturePolicyEdits = (root) => {
      // Focus belongs only to this render's active element, never a past edit.
      policyFocus = null;
      for (const input of root.querySelectorAll("[data-cs-policy]")) {
        const key = input.dataset.csPolicy;
        // R2-06B: only USER-MODIFIED fields persist as drafts — untouched
        // fields follow the authoritative server snapshot on refresh
        if (policyDirty.has(key)) policyDraft.set(key, String(input.value ?? ""));
        if (input === document.activeElement) {
          policyFocus = { key, selStart: input.selectionStart, selEnd: input.selectionEnd };
        }
      }
    };
    const applyPolicyEdits = (root) => {
      for (const input of root.querySelectorAll("[data-cs-policy]")) {
        const key = input.dataset.csPolicy;
        if (policyDirty.has(key) && policyDraft.has(key)) input.value = policyDraft.get(key);
        if (policyFocus && policyFocus.key === key && document.activeElement !== input) {
          input.focus();
          try {
            input.setSelectionRange(policyFocus.selStart, policyFocus.selEnd);
          } catch { /* number inputs may not support ranges */ }
        }
      }
    };

    // Lane budget suggestions (R49 productized): the sidecar derives usage
    // families + busy windows from the owner's own CPA usage; the card turns
    // them into per-family pre-fills. The reserve ratio is a user knob —
    // suggested budget = own use × (1 − reserve), recomputed live.
    let suggestData = null;
    ctx.invoke("compute-sharing:owner-suggest", {}).then((data) => {
      if (!data || (!data.families && !data.zhipu)) return;
      suggestData = data;
      renderOwnerLast();
    }).catch(() => { /* advisory: stay silent when unavailable */ });

    // card-side config: reserve ratio + personal lane templates, persisted in
    // the module config store (same channel the zhipu-plan card uses)
    let cardConfig = { referencePct: 75, laneTemplates: [] };
    ctx.invoke("modules:get", {}).then((state) => {
      const entry = ((state || {}).modules || {})["compute-sharing"] || {};
      const config = entry.config || {};
      // F03 migration: 旧「自留率」(reservePct, 建议预算 = 用量 × (1 − 自留))
      // 是对不存在的额度预留的承诺；改为「参考比例」(referencePct, 建议
      // 预算 = 用量 × 参考比例)。一次迁移：reference = 100 − reserve，
      // 写新字段，不改已发布车道的预算。
      const reference = Number(config.referencePct);
      const reserve = Number(config.reservePct);
      if (Number.isFinite(reference)) {
        cardConfig.referencePct = Math.min(95, Math.max(5, Math.round(reference)));
      } else if (Number.isFinite(reserve)) {
        cardConfig.referencePct = Math.min(95, Math.max(5, Math.round(100 - reserve)));
        saveCardConfig({ referencePct: cardConfig.referencePct });
      }
      if (Array.isArray(config.laneTemplates)) {
        cardConfig.laneTemplates = config.laneTemplates.filter((tpl) => tpl && tpl.models && Number.isFinite(Number(tpl.budget))).slice(0, 6);
      }
      renderOwnerLast();
    }).catch(() => { /* defaults hold when the store is unreadable */ });
    const saveCardConfig = (patch) => ctx.invoke("modules:set", { id: "compute-sharing", config: patch })
      .catch(() => { /* keep UI state even if persistence fails */ });

    const suggestedBudget = (weeklyTokens) => Math.max(1000, Math.round(weeklyTokens * (cardConfig.referencePct / 100)));

    function suggestBlock() {
      const families = (suggestData && suggestData.families) || [];
      const zhipuKeys = (suggestData && suggestData.zhipu && suggestData.zhipu.results) || [];
      if (!families.length && !zhipuKeys.length) return "";
      const zhipuParts = zhipuKeys
        .map((result) => {
          const window = result.quota && result.quota.windows && result.quota.windows[0];
          return window ? `${result.label} ${window.pct ?? "?"}%` : null;
        })
        .filter(Boolean);
      const familyLines = families.map((fam, i) => {
        const sched = fam.busy
          ? t("desktop.sharing.suggest.schedOffpeak", { busy: `${fam.busy.start}–${fam.busy.end}`, open: `${fam.busy.end}–${fam.busy.start}` })
          : t("desktop.sharing.suggest.schedAllDay");
        return `<div class="cs-muted">· ${esc(fam.family)} · ${esc(t("desktop.sharing.suggest.famUsed", { used: compact(fam.weeklyTokens) }))} · ${esc(sched)} · ${esc(t("desktop.sharing.suggest.famBudget", { budget: compact(suggestedBudget(fam.weeklyTokens)) }))} <button class="outline-button" type="button" data-cs-family="${i}">${esc(t("desktop.sharing.suggest.createLane"))}</button></div>`;
      });
      return `<div class="cs-suggest">
        <div class="cs-suggest-head">
          <strong>${esc(t("desktop.sharing.suggest.title"))}</strong>
          <label class="cs-reserve">${esc(t("cs.suggest.reference"))} <input data-cs="reserve" type="number" min="5" max="95" step="1" value="${esc(String(cardConfig.referencePct))}" />%</label>
        </div>
        ${familyLines.map((line) => `<div>${line}</div>`).join("")}
        ${zhipuParts.length ? `<div class="cs-muted">· ${esc(t("desktop.sharing.suggest.zhipu", { list: zhipuParts.join(" · ") }))}</div>` : ""}
        <div class="cs-muted">${esc(t("cs.suggest.referenceHint"))}</div>
      </div>`;
    }

    // personal templates + the blank entry: chips fill the editor as drafts
    function templateBlock() {
      const chips = cardConfig.laneTemplates.map((tpl, i) => `
        <span class="cs-tpl-chip">
          <button class="outline-button" type="button" data-cs-tpl="${i}">${esc(tpl.title || tpl.models)}</button>
          <button class="cs-tpl-del" type="button" data-cs-tpl-del="${i}" title="${esc(t("desktop.sharing.lane.templateRemove"))}">×</button>
        </span>`).join("");
      return `<div class="cs-templates">
        <span class="cs-muted">${esc(t("desktop.sharing.lane.add"))}:</span>
        ${chips}
        <button class="outline-button" type="button" data-cs-tpl="blank">${esc(t("desktop.sharing.lane.template.blank"))}</button>
      </div>`;
    }

    // ── 算力借用（车道目录 + 我的认领） ────────────────────────────────────
    // 认领卡「接入配置」(0.1.0 / CS-03)：目标工具 × 具体模型 × shell 方言
    // 生成可复制命令。模型来自借用 Key 经 sidecar 请求的 CPA 模型目录并与
    // 车道白名单求交；目录不可用时降级为带说明的手动输入，绝不猜测模型名。
    const TOOLS = [
      { id: "claude", labelKey: "cs.tool.claude", protocol: "anthropic", env: (c, model) => [
        ["ANTHROPIC_BASE_URL", String(c.baseURL || "").replace(/\/+$/, "")],
        ["ANTHROPIC_AUTH_TOKEN", c.token],
        ...(model ? [["ANTHROPIC_MODEL", model]] : []),
      ] },
      { id: "codex", labelKey: "cs.tool.codex", protocol: "responses", env: (c, model) => [
        ["OPENAI_BASE_URL", `${String(c.baseURL || "").replace(/\/+$/, "")}/v1`],
        ["OPENAI_API_KEY", c.token],
        ...(model ? [["OPENAI_MODEL", model]] : []),
      ] },
      { id: "openai", labelKey: "cs.tool.openai", protocol: "chat", env: (c) => [
        ["OPENAI_BASE_URL", `${String(c.baseURL || "").replace(/\/+$/, "")}/v1`],
        ["OPENAI_API_KEY", c.token],
      ] },
      { id: "anthropic", labelKey: "cs.tool.anthropic", protocol: "anthropic", env: (c) => [
        ["ANTHROPIC_BASE_URL", String(c.baseURL || "").replace(/\/+$/, "")],
        ["ANTHROPIC_AUTH_TOKEN", c.token],
      ] },
    ];
    const isWindowsShell = () => /win/i.test(navigator.platform || navigator.userAgent || "");
    // 认领卡 UI 状态（keyId → {tool, model, manualModel, models, modelsError, shell}）
    const toolState = new Map();
    // 最近一次连通测试结果（keyId → {text, ok}）：15s 合并刷新会整列重渲染，
    // 结果必须住进状态而不是只写 DOM 节点，否则轮询一跳就把它抹掉（§7.1
    // 自动刷新不打断用户正在看的内容）
    const testResults = new Map();
    const toolStateOf = (claim) => {
      const previous = toolState.get(claim.keyId);
      const endpoint = JSON.stringify([claim.baseURL, claim.token]);
      if (!previous || previous.endpoint !== endpoint) {
        if (previous) {
          cancelClaimTest(claim.keyId);
          testResults.delete(claim.keyId);
          syncWait.delete(claim.keyId);
        }
        const exact = (claim.models || []).find((m) => m && !m.includes("*"));
        toolState.set(claim.keyId, {
          endpoint,
          loading: false,
          tool: previous ? previous.tool : "claude",
          model: exact || "",
          manualModel: "",
          models: null, // null = 目录未加载; [] = 已加载但为空; [...] = 列表
          modelsError: "",
          shell: previous ? previous.shell : (isWindowsShell() ? "powershell" : "posix"),
        });
      }
      return toolState.get(claim.keyId);
    };
    const envLine = (shell, name, value) => (shell === "powershell"
      ? `$env:${name} = "${String(value).replace(/"/g, "`\"")}"`
      : `export ${name}=${value}`);
    const secretNames = new Set(["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

    // 模型发现：借用 Key 请求 CPA 模型目录（sidecar 中转，无 CORS 问题），
    // 结果与车道范围求交——通配符永远不会被当作可发送的模型 ID。
    async function loadModels(claim) {
      const state = toolStateOf(claim);
      if (state.models || state.loading) return;
      state.loading = true;
      try {
        const data = await ctx.invoke("compute-sharing:models", { keyId: claim.keyId });
        if (toolState.get(claim.keyId) !== state || !el.isConnected) return;
        state.models = (data && Array.isArray(data.models)) ? data.models : [];
        state.modelsError = "";
        // default-select the first concrete model once the catalog lands:
        // the select visibly shows it, so state must agree or the test input
        // and the generated env block silently miss the model
        if (!state.model && state.models.length) state.model = state.models[0];
      } catch (error) {
        if (toolState.get(claim.keyId) !== state || !el.isConnected) return;
        state.models = [];
        state.modelsError = String((error && error.message) || error).slice(0, 120);
      }
      state.loading = false;
      renderMineLast();
    }

    function quotaLine(claim, live) {
      const cap = (live && live.keyMaxTokens) || claim.keyMaxTokens || 0;
      const charged = (live && live.keyChargedTokens) || 0;
      const raw = (live && live.usedTokens) || 0;
      const laneAvail = live && live.laneAvailableTokens != null ? live.laneAvailableTokens : 0;
      const item = (labelKey, value, hint) => `<span title="${esc(hint || "")}">${esc(t(labelKey))}: <b class="num">${esc(value)}</b></span>`;
      return `<div class="cs-quota">
        ${item("cs.quota.keyCap", cap > 0 ? compact(cap) : t("cs.quota.auto"), cap > 0 ? "" : t("cs.policy.auto"))}
        ${item("cs.quota.charged", compact(charged))}
        ${item("cs.quota.raw", compact(raw))}
        ${item("cs.quota.laneAvail", compact(laneAvail))}
      </div>`;
    }

    function toolConfigSection(claim) {
      const state = toolStateOf(claim);
      const tool = TOOLS.find((x) => x.id === state.tool) || TOOLS[0];
      const model = state.model === "__manual" ? state.manualModel : state.model;
      const rows = tool.env(claim, model);
      const section = document.createElement("div");
      section.className = "cs-claim-config";

      const bar = document.createElement("div");
      bar.className = "cs-tool-bar";
      const toolSelect = document.createElement("select");
      toolSelect.dataset.csTool = claim.keyId;
      for (const entry of TOOLS) {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = t(entry.labelKey);
        option.selected = entry.id === state.tool;
        toolSelect.appendChild(option);
      }
      const modelSelect = document.createElement("select");
      modelSelect.dataset.csModel = claim.keyId;
      const modelLabel = document.createElement("label");
      if (Array.isArray(state.models) && state.models.length) {
        for (const name of state.models) {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          option.selected = name === state.model;
          modelSelect.appendChild(option);
        }
        const manual = document.createElement("option");
        manual.value = "__manual";
        manual.textContent = t("cs.models.manual");
        manual.selected = state.model === "__manual";
        modelSelect.appendChild(manual);
        modelLabel.append(`${t("cs.models.pick")} `, modelSelect);
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = t("cs.models.pick");
        input.value = state.model === "__manual" ? state.manualModel : state.model;
        input.dataset.csModelInput = claim.keyId;
        modelLabel.append(`${t("cs.models.pick")} `, input);
        if (state.modelsError) {
          const err = document.createElement("span");
          err.className = "cs-state";
          err.textContent = t("cs.models.unavailable", { error: state.modelsError });
          modelLabel.appendChild(err);
        } else if (Array.isArray(state.models) && !state.models.length) {
          const empty = document.createElement("span");
          empty.className = "cs-state";
          empty.textContent = t("cs.models.empty");
          modelLabel.appendChild(empty);
        }
      }
      const shellSelect = document.createElement("select");
      shellSelect.dataset.csShell = claim.keyId;
      for (const [value, label] of [["posix", "Bash / Zsh"], ["powershell", "PowerShell"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === state.shell;
        shellSelect.appendChild(option);
      }
      const copyAll = document.createElement("button");
      copyAll.className = "outline-button cs-claim-mini";
      copyAll.type = "button";
      copyAll.textContent = t("cs.tool.copyAll");
      const lines = rows.map(([name, value]) => envLine(state.shell, name, value)).join("\n");
      copyAll.addEventListener("click", () => {
        navigator.clipboard?.writeText(lines).then(() => {
          copyAll.textContent = t("cs.tool.copied");
          setTimeout(() => { copyAll.textContent = t("cs.tool.copyAll"); }, 1200);
        });
      });
      bar.append(
        Object.assign(document.createElement("label"), { textContent: t("cs.tool.select") }),
        toolSelect,
        modelLabel,
        Object.assign(document.createElement("label"), { textContent: t("cs.tool.shell") }),
        shellSelect,
        copyAll,
      );
      section.appendChild(bar);

      for (const [name, value] of rows) {
        const row = document.createElement("div");
        row.className = "cs-claim-row";
        const label = document.createElement("span");
        label.className = "cs-claim-label";
        label.textContent = name;
        const code = document.createElement("code");
        code.className = "cs-claim-value";
        if (secretNames.has(name)) {
          const maskOf = (v) => (String(v).length > 12 ? `${String(v).slice(0, 8)}…${String(v).slice(-4)}` : "…");
          let revealed = false;
          const render = () => { code.textContent = revealed ? value : maskOf(value); };
          render();
          const reveal = document.createElement("button");
          reveal.className = "outline-button cs-claim-mini";
          reveal.type = "button";
          reveal.textContent = t("desktop.sharing.borrow.reveal");
          reveal.addEventListener("click", () => {
            revealed = !revealed;
            render();
            reveal.textContent = t(revealed ? "desktop.sharing.borrow.hide" : "desktop.sharing.borrow.reveal");
          });
          row.append(label, code, reveal);
        } else {
          code.textContent = value;
          code.title = value;
          row.append(label, code);
        }
        section.appendChild(row);
      }

      const note = document.createElement("div");
      note.className = "cs-muted";
      note.textContent = t(tool.id === "codex" ? "cs.tool.codexNote" : "cs.tool.note");
      section.appendChild(note);

      if (tool.id === "codex") {
        // Codex 0.14x ignores bare env vars (falls back to its ChatGPT
        // account path) — the provider snippet is the working entry, so it
        // renders inline, not folded away (verified live 2026-09-20)
        const pre = document.createElement("pre");
        const base = String(claim.baseURL || "").replace(/\/+$/, "");
        pre.textContent = `# ~/.codex/config.toml\nmodel = "${model || "glm-5.3"}"\nmodel_provider = "atl-share"\n\n[model_providers.atl-share]\nname = "ATL Share"\nbase_url = "${base}/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"`;
        section.appendChild(pre);
      }
      return section;
    }

    // 工具/模型/shell 变更时重渲染当前认领卡（只重画这一张，避免整列闪动）
    function bindToolEvents(row, claim) {
      const state = toolStateOf(claim);
      row.querySelector(`[data-cs-tool="${CSS.escape(claim.keyId)}"]`)?.addEventListener("change", (event) => {
        state.tool = event.target.value;
        renderMineLast();
      });
      row.querySelector(`[data-cs-model="${CSS.escape(claim.keyId)}"]`)?.addEventListener("change", (event) => {
        state.model = event.target.value;
        renderMineLast();
      });
      row.querySelector(`[data-cs-model-input="${CSS.escape(claim.keyId)}"]`)?.addEventListener("change", (event) => {
        state.manualModel = event.target.value.trim();
        state.model = "__manual";
      });
      row.querySelector(`[data-cs-shell="${CSS.escape(claim.keyId)}"]`)?.addEventListener("change", (event) => {
        state.shell = event.target.value;
        renderMineLast();
      });
    }

    function laneClaimRow(share, lane) {
      const total = lane.budgetTokens || 0;
      const used = lane.settledTokens || 0;
      const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
      const claimable = lane.state === "active" && lane.open && !lane.exhausted && lane.slotsLeft > 0;
      const status = lane.state === "suspended"
        ? `<span class="cs-state">${esc(t("desktop.sharing.lane.paused"))}</span>`
        : lane.state === "paused"
          ? `<span class="cs-state">${esc(t("cs.lane.pausedBadge"))}</span>`
          : lane.open
            ? (lane.exhausted
              ? `<span class="cs-state">${esc(t("desktop.sharing.lane.exhausted"))}</span> ${esc(t("desktop.sharing.lane.resetAt", { time: clockText(lane.windowEndsAtMs || Date.now()) }))}`
              : esc(t("web.sharing.online")))
            : `${esc(t("desktop.sharing.lane.closedUntil"))} · ${esc(clockText(Date.now() + (lane.retryAfterMs || 0)))}`;
      // §4.3: an owned valid key for THIS share+lane replaces the claim CTA
      // with 查看配置 — repeated claiming only burns slots
      const owned = ownedKeysByShareLane.has(ownedLaneKey(share.shareId, lane.id));
      const busy = claimInFlight;
      const action = owned
        ? `<button class="outline-button" data-cs-view-config type="button">${esc(t("cs.claim.viewConfig"))}</button>`
        : `<button class="primary-pill" data-cs-claim="${esc(share.shareId)}" data-cs-claim-lane="${esc(lane.id)}" type="button"${claimable && !busy ? "" : " disabled"}>${esc(busy ? t("cs.claim.claiming") : t("desktop.sharing.borrow.claim"))}</button>`;
      return `<div class="cs-lane">
        <div class="cs-kv">
          <span><span class="cs-dot cs-dot-${laneDot(lane)}"></span> <strong>${esc(lane.title)}</strong>
            <span class="cs-lane-tag">${esc(lane.models.join(", "))}</span></span>
          <span>${status}</span>
        </div>
        <div class="cs-kv"><span class="cs-muted">${esc(windowLabel(lane.window))} · ${esc(scheduleText(lane))} ${laneTags(lane)}</span>
          <span class="num">${esc(compact(used))} / ${esc(compact(total))}</span></div>
        <div class="cs-meter"><i style="width:${pct}%"></i></div>
        <div class="cs-actions">
          <span class="cs-muted">${esc(t("web.sharing.slots"))}: ${lane.slotsLeft > 0 ? lane.slotsLeft : esc(t("web.sharing.claimFull"))}</span>
          <span class="cs-grow"></span>
          ${owned ? `<span class="cs-lane-tag">${esc(t("cs.claim.existing"))}</span>` : ""}
          ${action}
        </div>
      </div>`;
    }

    const hbAgeOf = (share) => Date.now() - (((share.plugin || {}).lastHeartbeatAt) || 0);

    function borrowStatusView(share) {
      if (!share.online) return { cls: "off", label: t("web.sharing.offline") };
      if (share.state && share.state !== "active") return { cls: "paused", label: t("web.sharing.paused") };
      return { cls: "on", label: t("web.sharing.online") };
    }

    // ── 目录规模化（M1-M3/M5）：分层 → 排序 → 过滤 → 折叠，先算后渲染 ──
    const laneClaimable = (lane) => lane.state !== "suspended" && lane.open && !lane.exhausted
      && (lane.slotsLeft ?? 0) > 0 && (lane.availableTokens ?? lane.budgetTokens ?? 1) > 0;
    // T1 可认领 / T2 等待开放（时段未开但有名额有量）/ T3 其余（耗尽·满员·暂停）
    const shareRemainingRatio = (share) => {
      const lanes = share.lanes || [];
      const ratio = (budget, available) => (budget > 0 ? Math.min(1, (available ?? budget) / budget) : 0);
      return lanes.length
        ? Math.max(...lanes.map((l) => ratio(l.budgetTokens, l.availableTokens)))
        : ratio(share.budgetTokens, share.availableTokens);
    };
    const familyOfModel = (model) => (model.includes("*") ? model : `${model.split("-")[0]}-*`);
    const laneMatchesFamily = (lane, family) => (lane.models || []).some((m) => {
      if (m === family) return true;
      const lanePrefix = m.endsWith("*") ? m.slice(0, -1) : null;
      const famPrefix = family.endsWith("*") ? family.slice(0, -1) : null;
      return (lanePrefix !== null && family.startsWith(lanePrefix)) || (famPrefix !== null && m.startsWith(famPrefix));
    });
    // 会话内过滤态：目录是低频操作面，不持久化（方案 §5.2）
    let borrowFilterFamily = null;
    let borrowOnlyAvailable = true;
    const borrowExpandedLanes = new Set();
    let borrowT3Open = false;
    // 最近一次目录数据（shareId → share）：回填旧认领的车道身份用——
    // 认领响应带 lane 字段之前的存量认领，靠 live laneId + 目录车道表还原
    let sharesById = new Map();
    // 同资源防重复认领（§4.3）：最近一次 alive 认领列表 + 请求中标志。
    // 认领按钮显示「查看配置」而不是再发一次认领；请求期间全目录认领
    // 按钮禁用（双击只占一个名额）。
    let ownedKeysCache = [];
    let claimInFlight = false;
    const ownedLaneKey = (shareId, laneId) => `${shareId}:${laneId || "default"}`;
    let ownedKeysByShareLane = new Set();
    const rebuildOwnedKeys = () => {
      ownedKeysByShareLane = new Set((ownedKeysCache || [])
        .filter((c) => !c.expiresAt || c.expiresAt > Date.now())
        .map((c) => ownedLaneKey(c.shareId, c.laneId)));
    };

    function renderDirectory(shares, noBase) {
      if (noBase) {
        els.directory.innerHTML = `<div class="cs-muted">${esc(t("desktop.modules.onlineNoCloud"))}</div>`;
        return;
      }
      const online = (shares || []).filter((s) => s.online);
      if (!online.length) {
        els.directory.innerHTML = `<div class="cs-muted">${esc(t("web.sharing.empty"))}</div>`;
        return;
      }
      // §7.1 计算顺序：模型过滤 → 在匹配车道上计算可认领状态 → 可用性
      // 过滤 → 排序 → 折叠。层级必须基于筛选后的车道集合——否则「筛 GPT +
      // 只看可用」会被同节点的 Gemini 活车道带活（F07）。
      const filteredTierOf = (share) => {
        const lanes = borrowFilterFamily ? (share.lanes || []).filter((l) => laneMatchesFamily(l, borrowFilterFamily)) : (share.lanes || []);
        if (lanes.length) {
          if (lanes.some(laneClaimable)) return 1;
          if (lanes.some((l) => l.state !== "suspended" && !l.open && (l.slotsLeft ?? 0) > 0 && !l.exhausted)) return 2;
          return 3;
        }
        if (share.state === "active" && (share.slotsLeft ?? 0) > 0 && !share.exhausted) return 1;
        return share.state === "active" ? 2 : 3;
      };
      const ranked = online
        .map((share) => ({ share, tier: filteredTierOf(share) }))
        .sort((a, b) => (a.tier - b.tier)
          || (shareRemainingRatio(b.share) - shareRemainingRatio(a.share))
          || (hbAgeOf(a.share) - hbAgeOf(b.share))
          || String(a.share.title).localeCompare(String(b.share.title)));
      const families = [...new Set(online.flatMap((s) => (s.lanes || []).flatMap((l) => (l.models || []).map(familyOfModel))))].sort();
      const filterLanes = (lanes) => (borrowFilterFamily ? lanes.filter((l) => laneMatchesFamily(l, borrowFilterFamily)) : lanes);
      // T3 never renders as a card — it lives in the collapsed tail group;
      // the claimable-only toggle additionally hides waiting (T2) nodes
      const visible = ranked.filter(({ share, tier }) => {
        if (tier === 3) return false;
        if (borrowOnlyAvailable && tier !== 1) return false;
        if (borrowFilterFamily && !(share.lanes || []).some((l) => laneMatchesFamily(l, borrowFilterFamily))) return false;
        return true;
      });
      const hiddenCount = ranked.length - visible.length;

      const chips = [`<button class="cs-chip${borrowFilterFamily === null ? " active" : ""}" type="button" data-cs-family="">${esc(t("desktop.sharing.borrow.filterAll"))}</button>`,
        ...families.map((f) => `<button class="cs-chip${borrowFilterFamily === f ? " active" : ""}" type="button" data-cs-family="${esc(f)}">${esc(f)}</button>`)].join("");
      const toolbar = `<div class="cs-dir-tools">
        <span class="cs-chips">${chips}</span>
        <label class="cs-check"><input type="checkbox" data-cs="onlyAvailable"${borrowOnlyAvailable ? " checked" : ""} /><span>${esc(t("desktop.sharing.borrow.onlyAvailable"))}</span></label>
      </div>`;

      const LANES_SHOWN = 3;
      const cardOf = ({ share }) => {
        const status = borrowStatusView(share);
        const lanes = filterLanes(share.lanes || []);
        const expanded = borrowExpandedLanes.has(share.shareId);
        const shown = expanded ? lanes : lanes.slice(0, LANES_SHOWN);
        const more = lanes.length - shown.length;
        const header = `<div class="cs-row">
          <div class="cs-kv"><strong>${esc(share.title)}</strong>
            <span class="cs-dot cs-dot-${status.cls}" title="${esc(status.label)}"></span></div>
          ${lanes.length ? "" : `<div class="cs-actions">
            <span class="cs-muted">${esc(t("web.sharing.slots"))}: ${share.slotsLeft > 0 ? share.slotsLeft : esc(t("web.sharing.claimFull"))}</span>
            <span class="cs-grow"></span>
            <button class="primary-pill" data-cs-claim="${esc(share.shareId)}" type="button"${share.state === "active" && share.slotsLeft > 0 && !share.exhausted ? "" : " disabled"}>${esc(t("desktop.sharing.borrow.claim"))}</button>
          </div>`}
        </div>`;
        const expander = more > 0
          ? `<button class="cs-tpl-del cs-lane-more" type="button" data-cs-lanes-more="${esc(share.shareId)}">${esc(t("desktop.sharing.borrow.expandLanes", { n: String(more) }))}</button>`
          : (expanded && lanes.length > LANES_SHOWN
            ? `<button class="cs-tpl-del cs-lane-more" type="button" data-cs-lanes-more="${esc(share.shareId)}">${esc(t("desktop.sharing.borrow.collapseLanes"))}</button>`
            : "");
        return `<div class="cs-dir-card">${header}${shown.map((lane) => laneClaimRow(share, lane)).join("")}${expander}</div>`;
      };

      const t3Group = (!borrowOnlyAvailable || hiddenCount > 0) && !borrowOnlyAvailable
        ? "" : ""; // placeholder, replaced below
      const t3 = ranked.filter((x) => x.tier === 3);
      const t3Section = t3.length && !borrowOnlyAvailable
        ? `<div class="cs-t3">
            <button class="cs-lane-more" type="button" data-cs="t3Toggle">${esc(t("desktop.sharing.borrow.hiddenGroup", { n: String(t3.length) }))}${borrowT3Open ? " ▴" : " ▾"}</button>
            ${borrowT3Open ? t3.map(({ share }) => `<div class="cs-kv cs-t3-row"><span>${esc(share.title)}</span><span class="cs-muted">${esc(borrowStatusView(share).label)} · ${esc(t("web.sharing.slots"))}: ${share.slotsLeft > 0 ? share.slotsLeft : esc(t("web.sharing.claimFull"))}</span></div>`).join("") : ""}
          </div>`
        : "";

      const body = visible.length
        ? visible.map(cardOf).join("")
        : `<div class="cs-muted">${esc(t("desktop.sharing.borrow.emptyFiltered"))} <button class="cs-tpl-del" type="button" data-cs="clearFilter">${esc(t("desktop.sharing.borrow.clearFilter"))}</button></div>`;
      const hiddenNote = borrowOnlyAvailable && hiddenCount > 0
        ? `<div class="cs-muted cs-hidden-note">${esc(t("desktop.sharing.borrow.hiddenNote", { n: String(hiddenCount) }))}</div>`
        : "";
      els.directory.innerHTML = toolbar + body + hiddenNote + t3Section;

      for (const chip of els.directory.querySelectorAll("[data-cs-family]")) {
        chip.addEventListener("click", () => {
          borrowFilterFamily = chip.dataset.csFamily || null;
          renderDirectory(shares, noBase);
        });
      }
      const onlyBox = els.directory.querySelector('[data-cs="onlyAvailable"]');
      if (onlyBox) onlyBox.addEventListener("change", () => {
        borrowOnlyAvailable = onlyBox.checked;
        renderDirectory(shares, noBase);
      });
      for (const btn of els.directory.querySelectorAll("[data-cs-lanes-more]")) {
        btn.addEventListener("click", () => {
          const id = btn.dataset.csLanesMore;
          if (borrowExpandedLanes.has(id)) borrowExpandedLanes.delete(id); else borrowExpandedLanes.add(id);
          renderDirectory(shares, noBase);
        });
      }
      const t3Btn = els.directory.querySelector('[data-cs="t3Toggle"]');
      if (t3Btn) t3Btn.addEventListener("click", () => { borrowT3Open = !borrowT3Open; renderDirectory(shares, noBase); });
      const clearBtn = els.directory.querySelector('[data-cs="clearFilter"]');
      if (clearBtn) clearBtn.addEventListener("click", () => { borrowFilterFamily = null; borrowOnlyAvailable = true; renderDirectory(shares, noBase); });
      for (const button of els.directory.querySelectorAll("[data-cs-claim]")) {
        button.addEventListener("click", () => guard(() => claimShare(button.dataset.csClaim, button.dataset.csClaimLane || null)));
      }
      for (const button of els.directory.querySelectorAll("[data-cs-view-config]")) {
        button.addEventListener("click", () => {
          // jump to my claims and flash the matching row
          if (els.mine.scrollIntoView) els.mine.scrollIntoView({ behavior: "smooth", block: "center" });
          const rows = els.mine.querySelectorAll(".cs-row");
          for (const row of rows) row.classList.remove("cs-flash");
          if (rows.length) { rows[0].classList.add("cs-flash"); setTimeout(() => rows[0].classList.remove("cs-flash"), 1600); }
        });
      }
    }

    let renderMineArgs = null;
    const renderMineLast = () => {
      if (renderMineArgs) renderMine(renderMineArgs[0], renderMineArgs[1]);
    };

    function cancelClaimTest(keyId) {
      const run = syncRetries.get(keyId);
      if (run?.timer) clearTimeout(run.timer);
      syncRetries.delete(keyId);
    }

    function rememberClaimTest(keyId, text, ok) {
      testResults.set(keyId, { text, ok });
      // Refresh can replace the row while the sidecar request is in flight.
      const result = el.querySelector(`[data-cs-test-result="${CSS.escape(keyId)}"]`);
      if (result) {
        result.textContent = text;
        result.className = `cs-status${ok ? "" : " cs-state"}`;
        if (!syncWait.has(keyId)) result.closest(".cs-row")?.querySelector(".cs-pending")?.remove();
      }
    }

    async function runClaimTest(claim, model, protocol, run) {
      const keyId = claim.keyId;
      if (syncRetries.get(keyId) !== run) return;
      if (!el.isConnected || !cardVisible() || document.visibilityState !== "visible") {
        cancelClaimTest(keyId);
        syncWait.delete(keyId);
        rememberClaimTest(keyId, t("cs.claim.testPaused"), false);
        return;
      }
      rememberClaimTest(keyId, t("desktop.sharing.borrow.testing"), true);
      let result;
      try {
        result = await ctx.invoke("compute-sharing:borrow-test", {
          token: claim.token, baseURL: claim.baseURL, model, protocol,
        });
      } catch (error) {
        result = { ok: false, status: 0, error: String((error && error.message) || error).slice(0, 120) };
      }
      // A later manual test, revoked claim, or destroyed card supersedes this result.
      if (syncRetries.get(keyId) !== run || !el.isConnected) return;
      if (!result.ok && (syncWait.get(keyId) || 0) > Date.now() && run.attempts < 3) {
        run.attempts += 1;
        rememberClaimTest(keyId, t("cs.claim.syncing"), true);
        run.timer = setTimeout(() => {
          run.timer = null;
          // Invoke the saved request directly: clicking a disabled or rebuilt
          // button can silently drop a retry or select a different protocol.
          guard(() => runClaimTest(claim, model, protocol, run));
        }, 5_000);
        return;
      }
      cancelClaimTest(keyId);
      syncWait.delete(keyId);
      rememberClaimTest(keyId, result.ok
        ? t("desktop.sharing.borrow.testOk", { model })
        : t("desktop.sharing.borrow.testFail", { status: String(result.status), reason: result.error || "" }), Boolean(result.ok));
    }

    function renderMine(claims, liveById) {
      renderMineArgs = [claims, liveById];
      els.mine.innerHTML = "";
      // 清理回执（§5.3）：失效认领从本机删除时留一条不含凭证的原因说明，
      // 每条只显示一次（存最近 5 条，刷新后自然消失）
      if (lastRemovedReceipts.length) {
        const receipt = document.createElement("div");
        receipt.className = "cs-receipt";
        const list = lastRemovedReceipts
          .map((r) => `${r.shareTitle || r.keyId}${r.laneTitle ? `/${r.laneTitle}` : ""}(${r.reason})`)
          .join(" · ");
        receipt.textContent = t("cs.receipt.removed", { n: String(lastRemovedReceipts.length), list });
        els.mine.appendChild(receipt);
        lastRemovedReceipts = [];
      }
      if (!claims.length) {
        const empty = document.createElement("div");
        empty.className = "cs-muted";
        empty.textContent = t("desktop.sharing.borrow.myClaimsEmpty");
        els.mine.appendChild(empty);
        return;
      }
      for (const claim of claims) {
        const live = liveById && liveById.get(claim.keyId);
        const state = live && live.state
          ? live.state
          : (claim.expiresAt && claim.expiresAt <= Date.now() ? "expired" : "valid");
        // 车道身份三级回填：存量认领（无 lane 字段）靠 live laneId + 目录车道表
        // 还原——认领卡必须始终说明「谁的车道」
        const dirShare = sharesById.get(claim.shareId);
        const dirLane = dirShare
          ? (dirShare.lanes || []).find((l) => l.id === ((live && live.laneId) || claim.laneId || "default"))
          : null;
        const laneTitle = claim.laneTitle || (live && live.laneTitle) || (dirLane && dirLane.title) || "";
        const models = (claim.models && claim.models.length)
          ? claim.models
          : ((live && live.models && live.models.length) ? live.models : (dirLane ? dirLane.models || [] : []));
        const tzLabel = claim.tzLabel || (live && live.tzLabel) || "";
        const tags = [
          laneTitle ? `<span class="cs-lane-tag">${esc(laneTitle)}</span>` : "",
          models.length ? `<span class="cs-lane-tag">${esc(models.join(", "))}</span>` : "",
          tzLabel ? `<span class="cs-lane-tag">${esc(tzLabel)}</span>` : "",
        ].filter(Boolean).join(" ");
        const row = document.createElement("div");
        row.className = "cs-row";
        row.innerHTML = `
          <div class="cs-kv">
            <strong>${esc(claim.shareTitle || claim.shareId)}</strong>
            <span class="cs-muted">${esc(String(claim.keyId).slice(0, 11))}…</span>
          </div>
          ${tags ? `<div class="cs-muted cs-claim-meta">${tags}</div>` : ""}
          <div class="cs-muted cs-claim-meta">${esc(t("desktop.sharing.borrow.expires"))}: ${esc(fmtDateTime(claim.expiresAt))}${state !== "valid" ? ` · <span class="cs-state">${esc(t(state === "revoked" ? "desktop.sharing.borrow.stateRevoked" : "desktop.sharing.borrow.stateExpired"))}</span>` : ""}</div>`;
        const syncing = (syncWait.get(claim.keyId) || 0) > Date.now();
        if (state === "valid") {
          if (syncing) {
            row.insertAdjacentHTML("beforeend", `<div class="cs-pending">${esc(t("cs.claim.syncing"))}</div>`);
          }
          row.insertAdjacentHTML("beforeend", quotaLine(claim, live));
          const configHead = document.createElement("div");
          configHead.className = "cs-claim-section";
          configHead.textContent = t("cs.tool.title");
          row.appendChild(configHead);
          row.appendChild(toolConfigSection(claim));
          bindToolEvents(row, claim);
          loadModels(claim);
          const testHead = document.createElement("div");
          testHead.className = "cs-claim-section";
          testHead.textContent = t("desktop.sharing.borrow.sectionTest");
          row.appendChild(testHead);
          // §4.3 按协议测试：工具决定协议（Claude Code→Messages、Codex→Responses、
          // OpenAI 兼容→Chat Completions）；某一种协议通过不代表其他协议通过。
          const toolState = toolStateOf(claim);
          const tool = TOOLS.find((x) => x.id === toolState.tool) || TOOLS[0];
          const exactModel = (claim.models || []).find((m) => m && !m.includes("*"));
          const test = document.createElement("div");
          test.className = "cs-fields cs-test-row";
          test.innerHTML = `
            <span class="cs-lane-tag">${esc(tool.labelKey ? t(tool.labelKey) : "")} · ${esc(tool.protocol)}</span>
            <input class="grow" data-cs-test-model="${esc(claim.keyId)}" type="text" placeholder="${esc(t("desktop.sharing.borrow.testModel"))}: ${esc(exactModel || "")}" value="${esc(toolState.model === "__manual" ? toolState.manualModel : toolState.model)}" />
            <button class="outline-button" type="button" data-cs-test="${esc(claim.keyId)}">${esc(t("desktop.sharing.borrow.test"))}</button>
            <span class="cs-status${(testResults.get(claim.keyId) || {}).ok === false ? " cs-state" : ""}" data-cs-test-result="${esc(claim.keyId)}">${esc((testResults.get(claim.keyId) || {}).text || "")}</span>`;
          row.appendChild(test);
          row.querySelector(`[data-cs-test="${CSS.escape(claim.keyId)}"]`).addEventListener("click", () => guard(async () => {
            const model = String(row.querySelector(`[data-cs-test-model="${CSS.escape(claim.keyId)}"]`).value || exactModel || "").trim();
            cancelClaimTest(claim.keyId);
            if (!model) {
              rememberClaimTest(claim.keyId, t("desktop.sharing.borrow.testModelRequired"), false);
              return;
            }
            const run = { attempts: 0, timer: null };
            syncRetries.set(claim.keyId, run);
            await runClaimTest(claim, model, tool.protocol, run);
          }));
          const actions = document.createElement("div");
          actions.className = "cs-actions cs-claim-footer";
          const revoke = document.createElement("button");
          revoke.className = "link-button";
          revoke.type = "button";
          revoke.textContent = t("desktop.sharing.borrow.revoke");
          revoke.addEventListener("click", () => guard(() => revokeClaim(claim)));
          actions.appendChild(revoke);
          // renewal keeps the same key (G3): offered when under a day is left,
          // the extended expiry reaches the owner plugin on its next heartbeat
          const dayLeft = claim.expiresAt - Date.now() < 24 * 3_600_000;
          if (dayLeft) {
            const renew = document.createElement("button");
            renew.className = "outline-button";
            renew.type = "button";
            renew.textContent = t("desktop.sharing.borrow.renew");
            renew.addEventListener("click", () => guard(() => renewClaim(claim)));
            actions.appendChild(renew);
          }
          row.appendChild(actions);
        }
        els.mine.appendChild(row);
      }
    }

    // §8 借用动作统一走 Rust flow：签名、POST、本机存储合并和跨进程锁
    // 全在 sidecar 一条命令里完成（与 CLI 同一路径），webview 不再自行
    // fetch 认领/续期/撤销。错误码沿用后端原样，上方 errorKey 表负责文案。
    // 后端错误码 → 文案（与旧 apiPost 表一致 + lane_paused）；未知码原样显示
    const claimErrorText = (error) => {
      const code = String((error && error.message) || error);
      const key = {
        share_offline: "web.sharing.offline",
        budget_exhausted: "web.sharing.exhausted",
        lane_exhausted: "desktop.sharing.borrow.laneExhausted",
        lane_closed: "desktop.sharing.borrow.laneClosed",
        lane_suspended: "desktop.sharing.borrow.laneSuspended",
        lane_paused: "cs.error.lanePaused",
        lane_required: "desktop.sharing.borrow.laneRequired",
        lane_not_found: "desktop.sharing.borrow.laneRequired",
        no_claim_slots: "web.sharing.claimFull",
        rate_limited: "desktop.sharing.borrow.rateLimited",
        identity_required: "desktop.sharing.borrow.identityFailed",
        participant_not_registered: "desktop.sharing.borrow.identityFailed",
        invalid_signature: "desktop.sharing.borrow.identityFailed",
        claim_not_found: "desktop.sharing.borrow.claimGone",
        share_not_active: "web.sharing.paused",
        too_many_active_claims: "desktop.sharing.borrow.tooManyClaims",
      }[code.split(":")[0]];
      if (code.startsWith("too_many_active_claims")) return t("desktop.sharing.borrow.tooManyClaims", { active: "?", max: "?" });
      return key ? t(key) : code;
    };
    async function claimShare(shareId, laneId) {
      if (claimInFlight) return;
      claimInFlight = true;
      try {
        notify(t("cs.claim.claiming"));
        const data = await ctx.invoke("compute-sharing:claim", { shareId, laneId: laneId || undefined });
        if (data && data.keyId) syncWait.set(data.keyId, Date.now() + SYNC_WAIT_MS);
        notify(t("desktop.sharing.borrow.claimed"));
        await refresh({ forceShares: true });
      } catch (error) {
        throw new Error(claimErrorText(error));
      } finally {
        claimInFlight = false;
      }
    }

    async function renewClaim(claim) {
      await ctx.invoke("compute-sharing:renew", { keyId: claim.keyId });
      notify(t("desktop.sharing.borrow.renewed"));
      await refresh({ forceShares: true });
    }

    async function revokeClaim(claim) {
      await ctx.invoke("compute-sharing:revoke", { keyId: claim.keyId });
      notify(t("desktop.sharing.borrow.revoked"));
      await refresh({ forceShares: true });
    }

    // ── 统一刷新 ──────────────────────────────────────────────────────────
    // 世代守卫：并发的旧 refresh（如认领前启动、目录拉取慢的那次）不得
    // 在新 refresh 之后落地渲染——否则会拿过期数据抹掉认领结果
    let refreshSeq = 0;
    // §5.3: owner 状态失败时保留已有视图并标记"暂时无法更新"，只有
    // 确定性的 not_registered（从未注册/已注销）才收起控制台。
    let ownerStaleError = "";
    let controlPlaneFreshAt = 0;
    let lastRemovedReceipts = [];
    async function refresh({ forceShares = false } = {}) {
      const seq = ++refreshSeq;
      try {
        lastOwnerData = await ctx.invoke("compute-sharing:owner-status", {});
        ownerStaleError = "";
      } catch (error) {
        const code = String((error && error.message) || error);
        if (code.includes("not_registered")) {
          lastOwnerData = {};
          ownerStaleError = "";
        } else {
          ownerStaleError = code.slice(0, 80);
          // keep the last good owner view — a transient backend failure must
          // not tear down the owner console (F05)
          if (!lastOwnerData || !lastOwnerData.share) lastOwnerData = {};
        }
      }
      ownerSettled = true;
      if (seq === refreshSeq) renderOwner(lastOwnerData);
      // borrow: local claims + live usage; borrow-get reports dead-claim
      // removals (CS-04) so the cleanup has a receipt, not a silent drop
      const store = await ctx.invoke("compute-sharing:borrow-get");
      const claims = Array.isArray(store && store.claims) ? store.claims : [];
      const removed = Array.isArray(store && store.removed) ? store.removed : [];
      if (removed.length) {
        const seen = new Map(lastRemovedReceipts.map((r) => [r.keyId + ":" + r.reason, r]));
        for (const r of removed) seen.set(r.keyId + ":" + r.reason, r);
        lastRemovedReceipts = [...seen.values()].slice(-5);
      }
      let liveById = null;
      if (claims.length) {
        try {
          const data = await ctx.invoke("compute-sharing:live", {});
          if (data && Array.isArray(data.claims)) {
            liveById = new Map(data.claims.map((c) => [c.keyId, c]));
          }
        } catch { /* keep last known usage */ }
      }
      if (seq !== refreshSeq) return;
      for (const claim of claims) {
        const live = liveById && liveById.get(claim.keyId);
        if (live && live.token === claim.token && live.shareId === claim.shareId && live.baseURL) {
          claim.baseURL = live.baseURL;
        }
        const state = toolStateOf(claim);
        // A refresh retries a failed catalog once; rendering alone never
        // loops requests. Replacing the state invalidates old async results.
        if (state.modelsError) toolState.set(claim.keyId, { ...state, models: null, modelsError: "", loading: false });
      }
      // dead claims are deleted locally (user decision): revoked (confirmed
      // by the live view) and expired claims carry no value — rewrite the
      // store without them instead of rendering zombie rows; revocations get
      // a receipt too so the disappearance is explainable (CS-04)
      const nowMs = Date.now();
      let alive = claims.filter((c) => {
        const live = liveById && liveById.get(c.keyId);
        if (live && live.state === "revoked") return false;
        return !(c.expiresAt && c.expiresAt <= nowMs);
      });
      if (alive.length !== claims.length) {
        for (const gone of claims.filter((c) => !alive.includes(c))) {
          const live = liveById && liveById.get(gone.keyId);
          lastRemovedReceipts.push({
            keyId: gone.keyId,
            shareTitle: gone.shareTitle || (live && live.shareTitle) || "",
            laneTitle: gone.laneTitle || (live && live.laneTitle) || "",
            reason: live && live.state === "revoked" ? "revoked" : "expired",
          });
        }
        lastRemovedReceipts = lastRemovedReceipts.slice(-5);
        // QA-05: pass only the confirmed-dead KEY IDs — the sidecar re-reads
        // the store inside its lock, so a key another process claimed while
        // this snapshot was in flight always survives the cleanup
        try {
          const deadIds = claims.filter((c) => !alive.includes(c)).map((c) => c.keyId);
          const pruned = await ctx.invoke("compute-sharing:borrow-prune", { revoke: deadIds });
          if (pruned && Array.isArray(pruned.claims)) alive = pruned.claims;
        } catch { /* keep rendering what we have */ }
      }
      // §4.3: the same-resource guard must see the fresh claim set BEFORE the
      // directory re-renders, or the just-claimed lane keeps its claim CTA
      for (const [keyId, until] of syncWait) {
        if (Date.now() >= until) syncWait.delete(keyId); // the wait window is purely time-based: the backend knows the key at mint time, the CPA node learns it on its next heartbeat
      }
      const aliveIds = new Set(alive.map((claim) => claim.keyId));
      for (const keyId of syncRetries.keys()) {
        if (!aliveIds.has(keyId)) cancelClaimTest(keyId);
      }
      ownedKeysCache = alive;
      rebuildOwnedKeys();
      // directory first: the lane map backfills claim identities below, so a
      // claim row must not paint before the freshest shares data lands; the
      // fetch rides the sidecar directory flow (same path as the CLI, §8)
      if (forceShares || !els.directory.childElementCount) {
        try {
          const base = ctx.apiBase && ctx.apiBase();
          if (!base) {
            if (seq === refreshSeq) {
              controlPlaneFreshAt = 0;
              renderDirectory([], true);
            }
          } else {
            const data = await ctx.invoke("compute-sharing:directory", {});
            const shares = (data && data.shares) || [];
            if (seq === refreshSeq) {
              sharesById = new Map(shares.map((s) => [s.shareId, s]));
              controlPlaneFreshAt = Date.now();
              renderDirectory(shares);
            }
          }
        } catch (error) {
          if (seq === refreshSeq) {
            controlPlaneFreshAt = 0;
            els.directory.innerHTML = `<div class="cs-muted">${esc(t("desktop.sharing.borrow.directoryFailed", { error: String(error.message || error) }))}</div>`;
          }
        }
      }
      if (seq !== refreshSeq) return;
      renderDimStrip(Array.from(sharesById.values()), alive, liveById);
      renderEntryRow();
      renderMine(alive, liveById);
    }

    // §5.3 四维状态条：控制面连接、节点心跳（目录在线数）、资源可认领、
    // 自己的 Key——不用一个绿点代替全部事实。数据新鲜度用文字表达。
    function renderDimStrip(shares, aliveClaims, liveById) {
      if (!els.dimstrip) return;
      const fresh = controlPlaneFreshAt && Date.now() - controlPlaneFreshAt < 60_000;
      const online = (shares || []).filter((s) => s.online);
      let claimable = 0;
      for (const share of online) {
        for (const lane of share.lanes || []) {
          if (lane.state === "active" && lane.open && !lane.exhausted && (lane.slotsLeft ?? 0) > 0) claimable += 1;
        }
      }
      const validKeys = (aliveClaims || []).filter((c) => {
        const live = liveById && liveById.get(c.keyId);
        const state = live && live.state ? live.state : "valid";
        return state === "valid";
      }).length;
      const chip = (cls, text, title) => `<span class="cs-dim ${cls}" title="${esc(title || "")}">${esc(text)}</span>`;
      els.dimstrip.innerHTML = [
        chip(fresh ? "ok" : "warn", t(fresh ? "cs.dim.fresh" : "cs.dim.stale")),
        chip(fresh && online.length ? "ok" : "warn", fresh ? t("cs.dim.nodes", { n: String(online.length), total: String((shares || []).length) }) : t("cs.dim.nodesUnknown")),
        chip(fresh && claimable ? "ok" : "warn", fresh ? t("cs.dim.claimable", { n: String(claimable) }) : t("cs.dim.claimableUnknown")),
        chip(validKeys ? "ok" : "", t("cs.dim.keys", { n: String(validKeys) })),
      ].join("");
    }

    // §4.1 未注册分享者的一行入口：纯借用者不必看到整个 owner 控制台，
    // 但「我要分享」的准备工作必须始终可达
    // V02: 分项检测结果（身份 / CPA 配置 / 后端地址 / 节点心跳）——不再把
    // 所有缺项折叠成一句「未注册」
    let doctorItems = null;
    let doctorError = "";
    async function runDoctor() {
      doctorError = "";
      try {
        const data = await ctx.invoke("compute-sharing:doctor", {});
        doctorItems = (data && data.items) || [];
      } catch (error) {
        doctorItems = [];
        doctorError = String((error && error.message) || error).slice(0, 120);
      }
      renderEntryRow();
    }
    const doctorHintKey = (id) => ({
      identity: "cs.entry.item.identity",
      ownerConfig: "cs.entry.item.ownerConfig",
      apiBase: "cs.entry.item.apiBase",
      node: "cs.entry.item.node",
    }[id] || id);
    const doctorItemHint = (item) => {
      if (item.ok) return "";
      const key = {
        identity_missing: "cs.entry.missingIdentity",
        config_missing: "cs.entry.missingConfig",
        api_missing: "cs.entry.missingApi",
        api_unknown: "cs.entry.apiUnknown",
        api_mismatch: "cs.entry.apiMismatch",
        node_stale: "cs.entry.nodeStale",
        node_unknown: "cs.entry.nodeUnknown",
      }[item.code] || {
        identity: "cs.entry.missingIdentity",
        ownerConfig: "cs.entry.missingConfig",
        apiBase: item.value ? "cs.entry.apiMismatch" : "cs.entry.missingApi",
        node: item.value === "stale" ? "cs.entry.nodeStale" : "cs.entry.nodeUnknown",
      }[item.id];
      const params = { cpaApi: "?", appApi: item.value || "?", ...item.params };
      const hint = key ? t(key, params) : (item.hint || "");
      return item.id === "node" && Number.isFinite(params.ageSeconds)
        ? `${hint} ${t("cs.entry.nodeAge", { ageSeconds: String(params.ageSeconds) })}`
        : hint;
    };
    const doctorItemValue = (item) => item.id === "node"
      ? t(`cs.entry.node.${["online", "stale"].includes(item.value) ? item.value : "unknown"}`)
      : String(item.value || "");
    function renderEntryRow() {
      if (!els.entry) return;
      const hasOwner = hasOwnerConsole();
      els.entry.hidden = hasOwner;
      if (hasOwner) return;
      let itemsHtml = "";
      if (doctorItems) {
        itemsHtml = `<div class="cs-entry-items">${doctorItems.map((item) => `
          <div class="cs-entry-item">
            <span class="cs-dot cs-dot-${item.ok ? "on" : "off"}"></span>
            <span>${esc(t(doctorHintKey(item.id)))}</span>
            ${item.value ? `<span class="cs-lane-tag">${esc(doctorItemValue(item))}</span>` : ""}
            ${item.ok ? "" : `<span class="cs-state">${esc(doctorItemHint(item))}</span>`}
          </div>`).join("")}
        ${doctorError ? `<div class="cs-state">${esc(doctorError)}</div>` : ""}
        </div>`;
      }
      els.entry.innerHTML = `<div class="cs-row cs-entry">
        <div class="cs-actions">
          <strong>${esc(t("cs.entry.share"))}</strong>
          <span class="cs-muted">${esc(t("cs.entry.shareHint"))}</span>
          <span class="cs-grow"></span>
          <button class="outline-button" type="button" data-cs-doctor>${esc(t("cs.entry.check"))}</button>
        </div>
        <div class="cs-muted">${esc(t("cs.entry.steps"))}</div>
        ${itemsHtml}
      </div>`;
      els.entry.querySelector("[data-cs-doctor]")?.addEventListener("click", () => guard(() => runDoctor()));
    }

    el.querySelector('[data-cs="refresh"]').addEventListener("click", () => guard(() => refresh({ forceShares: true })));

    // §5.3 轮询：页面可见时最多每 15 秒一轮合并刷新，隐藏即停；回到页面
    // 立即刷。计时器在卡片脱离 DOM 后自清，不泄漏（20 次切页不增长）。
    // QA-07: 轮询只在本卡可见时运行——文档可见 + 卡片仍在 DOM + 面板未被
    // 隐藏（offsetParent 为 null 说明整页或插件开关把它藏了）。全部句柄在
    // 卡片脱离 DOM 时自清：timer 停、监听解绑、observer disconnect，销毁
    // 后的 visibility 事件不再触发任何 invoke。
    // V10: 新 Key 在 owner CPA 的下一次心跳（8s）之前不可用——认领后进入
    // 「等待节点同步」窗口；期间测试请求不做永久性失败判定
    const syncWait = new Map(); // keyId -> untilMs
    const syncRetries = new Map(); // keyId -> current probe chain { attempts, timer }
    const SYNC_WAIT_MS = 14_000;
    let lastFetchMs = Date.now();
    const cardVisible = () => el.isConnected && el.offsetParent !== null;
    let pollTimer = null;
    let visibilityHandler = null;
    let intersectionObserver = null;
    const stopLifecycle = () => {
      for (const keyId of syncRetries.keys()) cancelClaimTest(keyId);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (visibilityHandler) { document.removeEventListener("visibilitychange", visibilityHandler); visibilityHandler = null; }
      if (intersectionObserver) { intersectionObserver.disconnect(); intersectionObserver = null; }
    };
    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        if (!cardVisible()) {
          if (!el.isConnected) stopLifecycle();
          return;
        }
        if (document.visibilityState !== "visible") return;
        guard(() => refresh({ forceShares: true }));
      }, 15_000);
    };
    visibilityHandler = () => {
      if (!el.isConnected) { stopLifecycle(); return; }
      if (document.visibilityState === "visible" && cardVisible()) guard(() => refresh({ forceShares: true }));
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    startPolling();

    // Re-entering view re-fetches (throttled) so an early network failure
    // doesn't freeze the error message until a manual refresh.
    if (typeof IntersectionObserver === "function") {
      intersectionObserver = new IntersectionObserver((entries) => {
        if (!el.isConnected) { stopLifecycle(); return; }
        if (entries.some((entry) => entry.isIntersecting) && Date.now() - lastFetchMs > 15_000) {
          lastFetchMs = Date.now();
          guard(() => refresh({ forceShares: true }));
        }
      }, { threshold: 0.2 });
      intersectionObserver.observe(el);
    }

    await guard(() => refresh({ forceShares: true }));
  },
};
