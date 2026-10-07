# minimax-code-proxy

把已登录的 **MiniMax Code** 账号变成一个本地 **Anthropic 兼容端点**,让 Claude Code、以及任何支持 Anthropic Messages 协议的客户端直接使用 MiniMax 模型(M3 / M2.7 系列)。

> Turns your logged-in MiniMax Code account into a local Anthropic-compatible endpoint (`/v1/messages`), so Claude Code and other Anthropic-protocol clients can use MiniMax models without an API key.

```
Claude Code ──►  http://127.0.0.1:15722  (本代理)
                   │ 1. 复用 ~/.minimax 里的登录态,自动刷新 access token(写回原文件,与 MiniMax Code 客户端共存)
                   │ 2. 把 claude-* 等模型名映射为 MiniMax-M*
                   ▼
                 https://agent.minimax.cn/mavis/api/v1/llm/v1/messages   (标准 Anthropic 协议 + SSE)
```

## 特性

- **免 API Key**:直接使用 MiniMax Code(桌面版 / `mcode login`)的 OAuth 登录态
- **自动续期**:access token 约 1 小时过期且 refresh token 每次轮换,代理自动刷新并写回凭据文件,与 MiniMax Code 客户端互不干扰
- **标准 Anthropic 协议**:`/v1/messages`、`/v1/messages/count_tokens`、`/v1/models`,流式为标准 Anthropic SSE 透传
- **模型映射**:客户端发 `claude-sonnet-5` 等名字也能路由到合适的 MiniMax 模型
- 单文件、零依赖,Node.js ≥ 18 即可运行;支持 `cn` / `global` 两个区

## 前提条件

1. 已安装并登录 MiniMax Code(桌面版,或 CLI `mcode login`);默认读取 `~/.minimax/auth/prod/cn/mcode-public/auth.json`
2. 账号有有效的 MiniMax 订阅/额度
3. Node.js ≥ 18

## 快速开始

```bash
node proxy.mjs
# 自检
curl http://127.0.0.1:15722/health
```

配置 Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:15722
export ANTHROPIC_AUTH_TOKEN=anything   # 代理不校验客户端凭据
```

任何支持自定义 Anthropic base URL 的工具(Claude Code、CC Switch、OpenCode 等)都可以按同样方式接入。

### 全局区账号

用 `mcode login --region global` 登录的账号,在 `config.json` 里设:

```json
{ "region": "global" }
```

## 模型映射

| 客户端请求 | 实际转发 |
|---|---|
| `MiniMax-*`(在 `models` 列表内) | 原样透传 |
| 名字含 `haiku` / `flash` / `highspeed` | `fastModel`(默认 `MiniMax-M3.1-Flash-Preview`) |
| 其余(`claude-sonnet-5`、`claude-opus-5`、未知) | `defaultModel`(默认 `MiniMax-M3`) |

## 配置

所有项均可省略;新建 `config.json`(参考 `config.example.json`)可覆盖:

| 键 | 默认 | 说明 |
|---|---|---|
| `port` / `host` | `15722` / `127.0.0.1` | 监听地址 |
| `region` | `cn` | `cn` 或 `global`,决定上游与凭据路径 |
| `upstream` | 按 region | 上游网关,一般不用改 |
| `oauthTokenEndpoint` | 按 region | OAuth 刷新端点,一般不用改 |
| `authFile` / `stateFile` | 按 region | MiniMax Code 凭据文件路径 |
| `models` | 4 个 M 系模型 | 可透传的模型白名单 |
| `defaultModel` / `fastModel` | `MiniMax-M3` / `...-Flash-Preview` | 映射目标 |
| `refreshSkewMs` | `120000` | 提前多少毫秒视为"将过期" |
| `logFile` | `./proxy.log` | 日志文件(超 5MB 自动轮转) |

## 认证与刷新机制

MiniMax Code 的登录态存在 `~/.minimax/auth/prod/<区>/mcode-public/auth.json`,其中 access token 约 1 小时过期,**每次刷新都会轮换 refresh token**。本代理:

- 每次请求前检查有效期,不够则刷新并**原子写回同一文件**(同时同步 `auth-state.json` 的 generation/expiresAtMs);
- 因此 MiniMax Code 桌面版与本代理共用同一份登录态,互不踢下线;
- 收到上游 401 时自动强制刷新并重试一次;
- 若持续 401(`invalid_grant`),说明登录已失效,请重新登录桌面版或执行 `mcode login`。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages(支持 `stream: true`) |
| POST | `/v1/messages/count_tokens` | token 计数透传 |
| GET | `/v1/models` | 模型列表 |
| GET | `/health` | 状态:token 剩余有效期、generation、最近一次模型映射 |

## 常见问题

- **401 / 提示重新登录**:登录态失效,重新登录 MiniMax Code 即可;`/health` 可查看当前凭据状态
- **端口被占用**:改 `config.json` 的 `port`
- **Claude Desktop 接入**:Desktop 的 3P 模式需要经 CC Switch 之类的网关做模型路由,把网关上游指向本代理即可
- **Windows 开机自启**:用 `wscript` 运行一个隐藏启动脚本即可,例如 `start-hidden.vbs`:
  ```vbs
  CreateObject("WScript.Shell").Run """node"" ""<本项目路径>\proxy.mjs""", 0, False
  ```

## 安全与免责声明

- 本项目与 MiniMax、Anthropic **均无关联**,仅供个人学习研究使用
- 请遵守 MiniMax 服务条款;额度即你自己的订阅额度,**共享、转售、多人拼车有封控/封号风险**,后果自负
- 服务只监听 `127.0.0.1`,但**本机任意进程都可以调用它**,请勿将端口暴露到局域网/公网
- 凭据仅用于与 MiniMax 官方端点通信,不会发送到任何第三方
- 如果你在 MiniMax 控制台能签发订阅 Key(`sk-cp-` 前缀),直接设置 `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic` 是更简单的官方路径,无需本项目

## 同类项目

[cc-switch](https://github.com/farion1231/cc-switch)、[claude-code-router](https://github.com/musistudio/claude-code-router)、[cc-router](https://github.com/finch-xu/cc-router) 等也支持把 MiniMax 官方端点接入各类客户端;本项目的差异点是免 Key 复用 MiniMax Code 登录态并处理其刷新生命周期。

## License

[MIT](LICENSE)
