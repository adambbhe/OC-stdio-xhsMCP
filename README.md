# OC-stdio-xhsMCP

一个把 **OpenClaw（stdio MCP）** 接入 **[xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)（HTTP + SSE MCP）** 的轻量协议桥。

OpenClaw 的 MCP 配置只支持 stdio 传输（`command` + `args`），而 xiaohongshu-mcp 只提供 HTTP（Streamable HTTP + SSE）。本桥用 Node.js 原生 `fetch` 在两者之间做协议转换，并解决了一系列实际部署中的坑。

```
OpenClaw ──stdio(JSON-RPC)──► xhs-stdio-bridge.js ──HTTP+SSE──► xiaohongshu-mcp :18060
```

## 特性

- **协议桥接**：stdio JSON-RPC ↔ HTTP，自动解析 SSE（`text/event-stream`）响应。
- **绕开 SSRF 护栏**：OpenClaw 内置 fetch 的 SSRF guard 会拦截 `127.0.0.1`，本桥让 OpenClaw 只走 stdio、由桥发起本机 HTTP，从架构上规避。
- **分级超时**：`tools/call` 300s（发视频/全量评论较慢），其余 30s。
- **会话自愈**：`Mcp-Session-Id` 失效（HTTP 404/400）时自动重新 `initialize` 并重试一次。
- **通知转发**：转发无 `id` 的通知（如 `notifications/initialized`），保证握手完整。
- **发布幂等去重**：对 `publish_content` / `publish_with_video` 按内容指纹去重，挡住「在途重试 / 超时后重试 / 桥重启后重试」三类重复发帖。

## 前置条件

- Node.js **18+**（使用原生 `fetch` / `AbortSignal.timeout`）。
- 已部署并运行 [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)，监听 `http://127.0.0.1:18060/mcp`（建议用 systemd 独立守护，见 `examples/xhs-mcp.service`）。
- OpenClaw。

## 安装

```bash
git clone https://github.com/adambbhe/OC-stdio-xhsMCP.git
cd OC-stdio-xhsMCP
# 无第三方依赖，直接可用
cp xhs-stdio-bridge.js /home/it/xhs-stdio-bridge.js
```

## 配置 OpenClaw

把本桥配成 OpenClaw 的 stdio MCP（command 型）：

```bash
openclaw config set mcp.servers.xhs-mcp.command node
openclaw config set mcp.servers.xhs-mcp.args '["/home/it/xhs-stdio-bridge.js"]'
openclaw gateway restart
```

等价 JSON：

```json
{
  "mcp": {
    "servers": {
      "xhs-mcp": {
        "command": "node",
        "args": ["/home/it/xhs-stdio-bridge.js"]
      }
    }
  }
}
```

## 验证

```bash
mcporter list                              # 应显示 xhs-mcp (13 tools)
mcporter call xhs-mcp check_login_status   # 返回登录状态（未登录会提示扫码）
```

## 配置项（脚本顶部常量）

| 常量 | 默认 | 说明 |
|------|------|------|
| `XHS_URL` | `http://127.0.0.1:18060/mcp` | xiaohongshu-mcp 地址 |
| `TOOL_TIMEOUT` | `300000` | `tools/call` 超时（毫秒） |
| `DEFAULT_TIMEOUT` | `30000` | 其他请求超时（毫秒） |
| `DEDUP_FILE` | `/home/it/.xhs-publish-dedup.json` | 发布去重指纹落盘路径（目录需可写） |
| `DEDUP_TTL` | 6h | 已成功发布的去重窗口 |
| `UNCERTAIN_COOLDOWN` | 15min | 超时/结果未知后抑制重试的冷却期 |

## 关于发布幂等

发布走浏览器自动化、耗时较长。若响应超时，调用方常会误判失败而重试，但后端其实已发布，导致重复发帖。本桥按 `title + content + images/video + tags` 计算指纹去重：

- **done**：TTL 内同指纹直接返回，不再发布。
- **inflight**：同指纹的第二次调用复用同一在途请求，绝不二次发送。
- **uncertain**：上次超时/出错，冷却期内抑制重试并提示用 `list_feeds` 核实。

> 建议同时在 OpenClaw 的 skill/系统提示里写明：**发布超时不要盲目重试，先核实再决定**，与桥的去重形成双保险。

## 致谢

- 上游 MCP：[xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)

## License

[MIT](./LICENSE)
