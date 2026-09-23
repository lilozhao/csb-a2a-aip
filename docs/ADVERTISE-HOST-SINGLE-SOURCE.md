# 对外地址单一真相源（a2a-advertise-host）

> [2026-09-22 · T-5] 修 `ai-catalog.json` 硬编码地址（全社区通病）时顺手把「对外地址」收敛到一处。

## 问题

同一类病，犯过两次：

| 时间 | 位置 | 症状 |
|------|------|------|
| 2026-07-27（`6bc057c`） | `server_v4.js` / `server_v5.js` 的 `GET /.well-known/ai-catalog.json` | 硬编码 `http://<intranet-ip>:3100`（抄模板残留）→ **每个 v5 实例的 ARD 目录都广告成阿轩的地址**（社区通病；且内网地址对外不可达） |
| 2026-09-13 | `AgentCard`（`/.well-known/agent.json`） | 硬编码 `http://localhost:${port}` → 远程 peer 拿到 localhost，谁都连不上（当时在 v5 内联了一个 IIFE 修掉） |

第 2 次修完只覆盖了 AgentCard，ai-catalog 漏了；且修法内联在 `server_v5.js` 里，v4 没有 → **两处各自的真相源**。

## 解法

抽出 `a2a-advertise-host.js`，作为 **AgentCard / ai-catalog / 握手 共用的对外地址单一真相源**，v4/v5 都 `require` 它。

优先级：

```
env A2A_HOST  >  identity.publicHost  >  identity.host  >  config.getSelf?.()?.host  >  'localhost'
```

```js
const A2A_ADVERTISE_HOST = require('./a2a-advertise-host')(identity, config);
// server_v5.js 与 server_v4.js 均如此
```

`/.well-known/ai-catalog.json` 的 `endpoints.a2a` / `endpoints.agentCard` 改用 `${A2A_ADVERTISE_HOST}:${port}`。

## 影响面

- **消费者只有外部**（ARD 生态的互发现目录/爬虫）；**没有任何内部逻辑读这个端点** → 改动风险低。
- 改动后行为：从「一律指向 `<intranet-ip>`」→「指向各实例真实地址」。
- 各实例需 **pull 上游** 才全网生效（社区性收口）。

## 验证

- 单测：`node tests/advertise-host.test.js`（8 用例：优先级 6 + v4/v5 代码无残留 2）
- 真机：本机重启后 `curl 127.0.0.1:3100/.well-known/ai-catalog.json` → `"a2a":"http://<intranet-ip>:3100"`（此前是 `<intranet-ip>`）

## 待办（社区收口）

- [ ] 阿轩 / 恺 等实例 pull 上游后，各自 catalog 指向自己
- [ ] `server_v4.js` 的 `AgentCard` 仍用 `http://localhost:${port}`（**同类的第三处**，属 legacy；未在本单处理，留待 W-4/后续）
