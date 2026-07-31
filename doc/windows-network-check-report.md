# Windows 网络检查报告：客户端显示“云端不可达”

## 1. 报告信息

| 项目 | 内容 |
| --- | --- |
| 适用客户端 | AI Token League Windows x64 |
| 当前客户端版本 | `0.7.9` |
| 检查目标 | `http://ai-token-league.dev.1datatm.info` |
| 检查日期 | 2026-07-31 |
| 适用场景 | 浏览器可以打开云端地址，但客户端左下角显示“云端不可达” |

## 2. 先给结论

浏览器能打开首页，并不能直接证明客户端的云端检查成功。两者当前访问路径不同：

```text
浏览器：GET /
客户端：GET /api/health
```

客户端由 Rust sidecar 直接请求 `/api/health`，请求超时为 5 秒。只有同时满足以下条件，客户端才会记录为 `reachable`：

1. HTTP 状态码为 2xx；
2. 响应体是 JSON；
3. JSON 中存在 `"ok": true`。

如果 `/api/health` 返回 HTML、登录页、重定向结果、代理错误页或其他 JSON，即使浏览器首页正常，客户端也可能显示“云端不可达”。客户端当前将连接失败、健康检查协议不匹配和非成功 HTTP 响应统一显示为不可达。

客户端真实检查逻辑见：

- [atl-collector/src/sidecar.rs:1976](/Users/sky/develop/source/token-mac-windows-ai-codex-claude/atl-collector/src/sidecar.rs:1976)
- [src/desktop/renderer.js:2705](/Users/sky/develop/source/token-mac-windows-ai-codex-claude/src/desktop/renderer.js:2705)

## 3. Windows 用户现场检查步骤

以下命令在受影响电脑的 PowerShell 中执行。建议使用普通用户权限，不需要管理员权限。

### 3.1 记录检查目标和时间

```powershell
$TargetHost = "ai-token-league.dev.1datatm.info"
$HealthUrl = "http://$TargetHost/api/health"

Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"
([System.Environment]::OSVersion).Version
[System.Environment]::Is64BitOperatingSystem
```

同时记录客户端版本：打开客户端“设置 → 关于”，记录本地版本。

### 3.2 检查 DNS 解析

```powershell
Resolve-DnsName $TargetHost
nslookup $TargetHost
```

记录以下字段：

- `IPAddress` / `Address`
- 使用的 DNS Server
- 是否出现超时、找不到域名或返回多个不同地址

判定：

- 解析失败：优先检查内网 DNS、VPN DNS 或 Windows 网络适配器顺序；
- 浏览器能打开但 PowerShell 解析到不同 IP：浏览器可能使用了 Secure DNS、缓存或独立网络配置；
- 解析成功但地址不是公司内网期望地址：检查 DNS 分流配置。

### 3.3 检查 TCP 端口

当前地址使用 HTTP，默认检查 TCP 80 端口：

```powershell
Test-NetConnection `
  -ComputerName $TargetHost `
  -Port 80 `
  -InformationLevel Detailed
```

重点记录：

- `NameResolutionSucceeded`
- `RemoteAddress`
- `TcpTestSucceeded`
- `InterfaceAlias`

判定：

- `NameResolutionSucceeded=False`：DNS 问题；
- DNS 成功但 `TcpTestSucceeded=False`：路由、VPN、网关或防火墙问题；
- TCP 成功：继续执行 `/api/health` 检查，不要据此直接判定客户端一定正常。

### 3.4 检查客户端实际使用的健康接口

```powershell
curl.exe -v `
  --connect-timeout 5 `
  --max-time 10 `
  $HealthUrl
```

期望结果：

```text
HTTP/1.1 200 OK
```

响应体应为 JSON，并包含：

```json
{"ok":true}
```

不要求响应体只有这两个字符，包含 `serverVersion`、`compatibility` 等其他字段是正常的。

判定：

| 结果 | 结论 |
| --- | --- |
| 连接超时或无法建立连接 | Windows 客户端进程也可能无法到达服务端，继续查路由/VPN/防火墙 |
| HTTP 3xx | 检查反向代理是否把 `/api/health` 重定向到其他地址 |
| HTTP 4xx/5xx | 检查服务端路由、鉴权或反向代理配置 |
| HTTP 200 但返回 HTML | 可能命中了首页、登录页、网关错误页或错误的代理 location |
| HTTP 200 且 JSON 没有 `ok:true` | 客户端与服务端健康检查协议不一致 |
| HTTP 200 且 JSON 有 `ok:true` | 网络和健康接口基本正常，继续查客户端进程路径、Windows 安全软件和客户端日志 |

### 3.5 在浏览器中检查同一个 URL

不要只打开首页，直接打开：

```text
http://ai-token-league.dev.1datatm.info/api/health
```

比较浏览器和 PowerShell 的结果：

| 浏览器 `/api/health` | PowerShell `/api/health` | 说明 |
| --- | --- | --- |
| 正常 | 正常 | 网络基本一致，继续查客户端 sidecar 或 Windows 进程策略 |
| 正常 | 失败 | 浏览器与系统进程使用了不同 DNS、代理、缓存或 VPN 路径 |
| 失败 | 失败 | 不是客户端专属问题，优先查内网/VPN/反向代理 |
| 首页正常 | `/api/health` 失败 | 不能证明 API 正常，重点检查 `/api/health` 路由 |

## 4. 检查代理和 VPN 路径

用户没有主动配置代理，并不代表浏览器和桌面进程的网络路径完全相同。检查 Windows WinHTTP 配置：

```powershell
netsh winhttp show proxy
```

检查网络适配器和当前连接：

```powershell
Get-NetConnectionProfile |
  Select-Object Name, InterfaceAlias, NetworkCategory, IPv4Connectivity, IPv6Connectivity

Get-NetIPConfiguration |
  Select-Object InterfaceAlias, IPv4Address, IPv4DefaultGateway, DNSServer
```

如现场使用 VPN，记录：

- VPN 客户端名称和版本；
- VPN 是否为系统级全局隧道；
- 是否只代理浏览器或指定进程；
- `Test-NetConnection` 输出中的 `InterfaceAlias`；
- 连接 VPN 前后 `Resolve-DnsName` 的结果是否变化。

浏览器插件型 VPN、浏览器 Secure DNS 或浏览器缓存，都不能作为桌面客户端网络可达的证明。

## 5. 检查 Windows 防火墙和安全软件

查看当前防火墙配置：

```powershell
Get-NetFirewallProfile |
  Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction
```

如果满足以下条件，需要让 IT 或安全软件管理员检查进程策略：

- 浏览器访问 `/api/health` 正常；
- PowerShell `curl.exe` 访问 `/api/health` 正常；
- 客户端仍显示不可达；
- 电脑安装了企业安全软件、应用联网控制、EDR 或按进程分流的 VPN。

重点检查客户端主程序和 Rust sidecar 是否被单独阻止。不要为了排障长期关闭防火墙或安全软件；如需临时放行，应使用最小范围的进程和目标地址规则。

## 6. 收集客户端日志

客户端运行日志目录为：

```text
%USERPROFILE%\.ai-token-league\log\
```

PowerShell 查看最近日志：

```powershell
$LogDir = Join-Path $env:USERPROFILE ".ai-token-league\log"

Get-ChildItem $LogDir -Filter "runtime.*.log" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 FullName, Length, LastWriteTime
```

搜索网络相关记录：

```powershell
Get-ChildItem $LogDir -Filter "runtime.*.log" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 |
  Select-String -Pattern "api:check|health|unreachable|timeout|dns|connection|refused|reset"
```

也可以在客户端“设置 → 云端”查看“同步详情”，记录：

- API URL；
- 连接状态；
- 最后尝试时间；
- 最近错误。

## 7. 现场回传模板

请只回传以下信息，不要回传 `config.json`、身份私钥、Cursor token 或完整本地使用数据。

```text
检查时间：
Windows 版本：
客户端版本：
网络环境：公司内网 / VPN / 家庭网络 / 其他
VPN 名称和版本：

DNS 结果：
DNS Server：
解析 IP：

Test-NetConnection：
NameResolutionSucceeded：
RemoteAddress：
TcpTestSucceeded：
InterfaceAlias：

PowerShell curl /api/health：
HTTP 状态码：
响应是否为 JSON：是 / 否
响应是否包含 ok:true：是 / 否
错误摘要：

浏览器直接打开 /api/health：正常 / 异常
netsh winhttp show proxy：DIRECT / PROXY / 未知
客户端同步详情中的连接状态：
客户端日志中的错误摘要：
```

## 8. 定责规则

### A. DNS 或 TCP 失败

责任边界在 Windows 网络、内网 DNS、VPN 路由、网关或防火墙。客户端不需要先改代码。

### B. TCP 成功，但 `/api/health` 不是 200 且 `ok:true`

责任边界在反向代理、服务端路由、访问控制或网关响应。首页正常不代表 API 正常。

### C. 浏览器和 PowerShell 的 `/api/health` 都正常，但客户端失败

优先检查：

1. Windows 安全软件是否按进程拦截客户端 sidecar；
2. 客户端日志中的实际错误；
3. 客户端是否访问了相同的 API URL；
4. 客户端是否收到非 JSON、重定向或代理错误页。

此时才应进入客户端代码级修复，例如增加网络错误分类、展示 `apiConnection.message`，或补充 Windows 网络诊断。

## 9. 当前环境的对照验证

2026-07-31 在当前可访问内网/VPN 的环境中验证：

- `GET /` 返回 HTTP 200；
- `GET /api/health` 返回 HTTP 200；
- `/api/health` 响应包含 `"ok":true`；
- 域名解析到 `198.18.27.196`；
- 当前路由经过 VPN 网卡。

该结果只能证明服务端接口在该网络路径上正常，不能替代受影响 Windows 电脑上的现场检查。

另发现当前健康接口返回的服务端版本为 `0.7.8`，而项目当前客户端版本为 `0.7.9`。这不是“云端不可达”的直接证据，但部署版本应另行核对。
