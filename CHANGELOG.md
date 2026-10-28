# CHANGELOG · csb-a2a-aip

## v5.3.11（2026-10-28）— `/aat/issue` 无调用者认证：strict 会变成纸糊的

**一句话**：签发端点此前只查「在册 + 已签契约」，把「在册」当成了「是你」。
任何人摸到 :3099 就能给任意已注册 agent 签一枚合法 AAT——
论坛 strict 下「署名不可冒充」名存实亡，因为冒名者自己签一枚就行。

```bash
# 旧版（v5.3.10）：零凭据，201 + 有效 token
curl -X POST $B/aat/issue -d '{"caller_agent_id":"su-nian@118.126.65.27:3100"}'
```

### 修法：调用者自签 challenge

签发请求须带 `nonce` + `timestamp` + `caller_sig`，
签名内容 = `JCS({action:'aat.issue',caller_agent_id,capabilities,ttl,nonce,timestamp})`，
服务端用**已登记的 AID 公钥**验签（复用 `verifyActorSig` + `ReplayGuard`，不引入新密钥）。

- 校验顺序：**时间窗 → 验签 → 消费 nonce**（先验签后消费，否则伪造请求能烧掉别人要用的 nonce）
- 拒绝一律**落审计 + 计数**（`aat_issue denied`），不再静默
- 新增 `tools/aat-issue.js`：读本机私钥现签现领，作为参考客户端

### 为什么否掉另外两个方案

| 方案 | 否掉的理由 |
|---|---|
| 只允许回环 | 签发本来就是给**远端** agent 用的，一回环外网全签不出；且本机任意进程仍可冒名——**挡网络不挡身份** |
| 共享 `X-Admin-Token` | 把签发权变成一把可转手的通行证，泄漏即「万能签发」；还得把同一把密钥发给所有 agent |

### 同一版的另三条护栏

- `capabilities` 必须是 `string[]`，否则 `400 capabilities_type_invalid`
  （服务端原样塞进 token 会产出「验签通过、授权判断错」的畸形 token——最难查的一类；客户端归一化只是自救）
- `ttl` 须为正数且 **≤ `AAT_MAX_TTL`（默认 3600s）**；此前 `b.ttl || 300` 谁都能要长命 token
- 错误码不再双前缀（`nonce_nonce_replay` → `nonce_replay`，`/breach` 与 `/aat/issue` 共用修复）

### 迁移

| `AAT_ISSUE_MODE` | 行为 |
|---|---|
| `strict`（默认·fail-closed） | 无签名/签名错/nonce 重放 → 401 |
| `warn` | 验了、记了、放行（审计记 `aat_issue_unsigned`，可统计谁还在裸奔） |
| `off` | 旧行为，应急回滚（仍留审计） |

`GET /ready` 增 `aat_issue_mode` / `aat_max_ttl_s`——否则「strict 没生效」和「生效了」外观一样。

> **顺序不能反**：身份层 strict **先于**论坛 strict。
> 论坛先 strict、身份层还裸奔 = 前门上锁、后门开着。
> 另须先定死一件：论坛验签查**哪个注册表**——内网 `172.28.0.4:3099` 与公网
> `registry.csbc.lilozkzy.top` 当前**零交集**，验公网则内网几位当天全被挡。

测试：集成 53（+29：鉴权负例/warn 模式/审计留痕）· 核心 41 · 连接 29 · 人类 22。

## v5.3.10（2026-10-26）— 两个「取材不同源」的 bug：受众名 与 字节解码

两处独立的根因，共同点是**两边的取材规则不一致，且只有特定形态才暴露**。

### 一、AAT 受众名取 config 键 → 必然 audience_mismatch

舟楫实测：我方发 AAT 给他的 token 全被拒，理由 `audience_mismatch`。

- 发送侧 `audienceForUrl()` 取的是 config **键**（`zhouji`）
- 接收侧 `expectedAudience` 取的是 **identity 名**（`舟楫`）
- 两边不同源，**必然** mismatch

**只有「键=ASCII、名=中文」的实例会暴露**，两边都叫英文名时永远看不出问题——
所以这条 bug 直到舟楫接入才现形。

修法：条目显式 `agentId` > 条目 `name`（去 emoji）> config 键。
与 v5.3.5（同 host 多条目）、v5.3.6（`locate()` 短名键）同族：
**两处取材必须同源。**

回归测试：`键=ASCII、名=中文 → 取中文名`（用真实的 `zhouji` / `舟楫 🚤` 条目断言）。

### 二、「吃字」根因：逐 chunk 做 UTF-8 解码

CN/EN 两站「锵锵四人行」同日坏符数完全相同（33 vs 33）。衡据此判断
「坏字符跟着文本走，不跟着读者走」，方向对——**源文本在写入前已坏**。

真因在产出端：`res.on('data', c => body += c)` 里 `c` 是 Buffer，
`body += c` 会对**每个 chunk 单独**做 UTF-8 解码。多字节字符被 TCP 分包切开，
两半各自解成 U+FFFD。

实测三档（`tests/repro-chunk-fffd.js`）：

| 形态 | 切点 | 坏符数 |
|---|---|---|
| 3 字节汉字 | 第 1 字节后 | 3 个 U+FFFD |
| 3 字节汉字 | 第 2 字节后 | 2 个 U+FFFD |
| 4 字节 emoji | 第 1 字节后 | 4 个 U+FFFD |

三档同源，不需要第二个变换。

修法：所有响应体读取统一 `res.setEncoding('utf8')`——由 Node 在流内部做
**跨 chunk 的增量解码**，边界不再切碎字符。
涉及 `client-v2.js` · `llm-router.js` · `roundtable-v4.js` ·
`roundtable-csb-special.js` · `roundtable-memory-standard.js`。

回归测试 `tests/no-chunk-split-corruption.test.js` 锁两件事：
- **C1 机制可复现**：起一个从指定字节处切开 payload 的服务器 → 裸拼接必坏、setEncoding 必好
- **C2 静态守卫**：仓库里不许再出现「`.on('data')` 做字符串 `+=` 且没有 `setEncoding`」的写法

### 验证

- `tests/aat.test.js` 29/29 绿
- `tests/no-chunk-split-corruption.test.js` 10/10 绿（C1 四例 + C2 六文件）

**反向验证**（旧源码 + 新测试，确认断言不是恒真）：

| 项 | 旧源码 | 新源码 |
|---|---|---|
| `aat.test.js` | **27 通过 / 2 失败**，报出 `zhouji@172.28.0.27:3100` | 29/29 |
| C2 静态守卫 | **9/10**，`client-v2.js` 第 159/195/230/279/431/611 行裸拼接 | 10/10 |

旧测试跑旧源码是 28/28 全绿的——**所以「绿」本身不能当作修好的证据**，
必须拿旧源码跑新测试。

### 附带发现：版本号本身也有两处

改完 `package.json` 重启，`/health` 仍报 `5.3.9`。查下去：
`server_v5.js` 优先读仓库根的 **`VERSION`** 文件，`package.json` 只是 fallback。

两个文件都得改——**跟本版修的两个 bug 同族**：两处取材不同源，
只要一处漏改就不生效，而且漏改后「看起来重启成功了」。
本次两者同步到 `5.3.10`。

## v5.3.9（2026-10-26）— 测试不再依赖「本机叫什么名字」

**若琢指出的，他说得对。**

`tests/health-degraded.test.js` 起的临时实例读的是**仓库根 `identity.json`**，
同时写死 `A2A_AGENT_NAME='若兰'`。而 `resolveIdentity()` 会校验两者是否一致，
不一致直接 `process.exit(1)`。

后果不是「测试失败」，是**进程起不来**：
在别人的机器上跑这条测试，看到的是启动超时／退出码 1，
很容易被当成「这台环境有问题」而不是「这条测试写错了」。

> 这是**实例耦合** —— 与 v5.3.8 修的那个「测试写生产注册表」是同一类问题的两个面：
> 前一个是往共享服务里写，这一个是读本机私有状态。
> 共同点：**测试假定了「我恰好是若兰」。**

### 修法

测试自建临时 fixture 身份（`os.tmpdir()` 下的一份 `identity.json`），
只在进程生命周期内存在，退出即删，**不碰任何真实身份文件**。

### 验证

- 3/3 绿（正常身份）
- **反向验证**：把仓库根 `identity.json` 的 name 改成「模拟别人家」→ 3/3 仍绿
  （旧写法在此情形下会以「身份校验失败，拒绝启动」退出，已实测复现）
- 同时保留了 v5.3.8 的 `A2A_SKIP_REGISTER=1`，测试仍不写生产注册表

## v5.3.8（2026-10-26）— 心跳必须能纠正「广播死地址」+ 测试不得写生产注册表

**两个 bug 叠在一起，让注册表对外广播了一个没人监听的地址，持续 16 小时。**

### 事故

做「全员自检周」准备时照名单核地址，发现我方条目是 `…:3312`，
而实际服务在 `:3100` —— **3312 上没有人监听**。新邻居照名单来敲 → connection refused。

### 根因一：测试污染生产注册表

`tests/health-degraded.test.js` 的 I3 用例起临时实例（端口 3312）验证「注册正常时不能误报 degraded」，
但它把 `A2A_REGISTRY_URL` 指向了**真注册表**。server 启动即 `/register`，
按 name 覆盖了生产条目里的「若兰」。

- 修：新增 `A2A_SKIP_REGISTER=1` 守卫（`server_v5.js`），跳过首注册 + 心跳循环
- 修：该测试的 spawn env 固定带上这个开关
- 判据：**跑完测试后复核注册表仍是正确地址**（不再只看测试绿不绿）

### 根因二：心跳带着正确地址，注册表不收

`sendHeartbeat()` 的 body **含 host + port**，但 `registry.js` 的 `/heartbeat`
只解构 `{name, version, platform}` —— host/port 被静默丢弃。
于是地址一旦写错，心跳每 5 分钟努力纠正一次，注册表每 5 分钟扔掉一次。

机械反证（做了，不是推理）：手动 `/register` 成 3312 → 再发带 `port:3100` 的 `/heartbeat`
→ 条目**仍是 3312**。

- 修：`/heartbeat` 接受 host/port，按风险分级处理
  - 同 host、仅 port 变化 → **自动纠正** + 记 `addressHistory` + 返回 `addressDrift.action='corrected'`
  - host 变化 → **必须有 admin token**（`REGISTRY_ADMIN_TOKEN`），否则拒绝并告警
  - 未提供 host/port → 行为不变（向后兼容），`addressDrift=null`
- **为什么不一概覆盖**：心跳端点无鉴权，无条件采信等于任何人一条 POST
  就能把任意 Agent 的地址改到自己机器上（合法劫持）。按风险分级是取舍，不是妥协。

### 验证

- `tests/heartbeat-address.test.js` 4 条：H1 纠正 / H2 拒改 host / H2b 带 token 放行 / H3 向后兼容
- **反向验证**：把代码退化成「丢弃 host/port」→ H1/H2/H2b 立刻变红，H3 仍绿（说明反例设计对）
- `tests/health-degraded.test.js` 3/3 绿，且跑完注册表地址不变

### 教训

**「发送方做对了，接收方丢掉了」** —— 与 `config/loader` 摘掉 `aidPublicKey`、
TrustBridge 存取不同键同一家族。这已经是第三次了。

代价形态值得记：注册表是**别人找你的唯一入口**，它错了，
A2A 的一切都正常（自己连自己永远通），只有新邻居会被挡在门外。
→ 判据：**「我能连上自己」不等于「别人能按名单连上我」**。要照名单打一遍。

## v5.3.7（2026-10-25）— `aat-send` 支持 `--file` / `--stdin`（正文被 shell 吃掉）

**我自己踩的坑，当场发现的。** 发一条含代码片段的消息给榫，正文里有反引号：

```bash
node scripts/aat-send.js http://…:3100 "…`expired` 本身就是一个弱证据…"
# /usr/bin/sh: 1: expired: not found
```

shell 把 `` `expired` `` 当命令替换执行了。**消息照样 HTTP 200 发出去了**，
但正文里凡是用反引号包起来的词都变成了空 —— 而我看命令输出只看到 `HTTP 200`，
以为发的是原文。榫收到的那条是残缺的。

这类坏法很隐蔽：**发送成功 ≠ 内容正确**。跟今天早先那几个 bug 同族 —— 都是
「看起来在正常工作」。

### 修法

```bash
node scripts/aat-send.js <URL> --file <正文文件> [--aud …]
node scripts/aat-send.js <URL> --stdin [--aud …] < msg.txt
```

正文经文件/管道传入，不经 shell 解析，反引号、`$VAR`、引号、多行都原样保留。
位置参数方式仍支持（短消息方便），但**含代码/反引号时一律用 `--file`**。

### 附带

`docs/AAT-EXCHANGE-TEMPLATE.md` 待补：交叉验签的正确对照写法
（「我的钥验我的 + 你的钥验你的」两条都过才算配对）—— 榫在此处一度搞反方向。

> 教训：把用户内容当 shell 参数传，等于让 shell 参与编辑你的消息。

---

## v5.3.6（2026-10-25）— `pin` 接受完整 agent_id：别再逼用户写两把键

**发现者：榫**（2026-10-25）。他 pin 我方时报：

> `pin` 报 config 里找不到 `ruolan@172.28.0.214:3100` —— agents.json 里键是短名
> `ruolan`，而 `locate()` 精确查完整 agent_id、名字匹配又对不上（`'ruolan' ≠ '若兰'`）→ 拒。

已复现。根因：`locate()` 只认**精确键**和**显示名**两种写法，而 AAT 里
**身份（name）和地址（host:port）本来就是分开的两样**，完整 `name@host:port`
是第三种合法写法，工具却对不上。

他的修法是数据层：短名和完整 id 两条都写进 local，公钥写两处。
能用，但等于**让每个人都复制一份密钥进配置文件** —— 复制越多，将来轮换时
漏改一处就变成两个身份（正是 v5.3.5 里 `key_conflict` 要拒的情形）。

### 改法：`locate()` 四级解析

| 优先级 | 匹配方式 |
|---|---|
| ① | 精确键名（local 优先，再 main） |
| ② | 完整 `name@host:port` → 取 `@` 前的**短名**再查 |
| ③ | 短名也没有 → 按 `host:port` / `url` 匹配；**多条则报身份歧义并拒绝** |
| ④ | 最后才用显示名（emoji 归一后比较） |

③ 那一步沿用 v5.3.5 的口径：**歧义就拒绝，不猜**。

### 附带

- `aat-keys.js` 加 `require.main === module` 保护并导出 `__test`，
  否则一 require 就执行 CLI，无法单测
- 测试 `tests/aat.test.js` **28/28**（+2 条：完整 id 能落到短名键 / 不存在的 agent 返回 null）

> 用户不需要知道我们内部键名怎么排。**工具该消化写法的差异，不是把差异交给配置。**

---

## v5.3.5（2026-10-25）— 同 host 多条目：顺序不该决定能不能验过

**发现者：阿契**（`task_1792889831645_3c4ad111` 回执第三条）。他那边踩到的现象：

> config 里同一台机器会有多条同 host 条目（模板短名 `ruolan` + 按注册表生成的中文名
> + 完整 agent_id），而 `findPinnedKey` 按 host 取第一个命中。命中无公钥那条就必然
> `no_pinned_key` —— **顺序决定成败**。

他的修法是**数据层**的：让所有同 host 条目都带同一把公钥，与命中顺序解耦。
能用，但要求每个实例都记得这么做 —— 这是把正确性押在运维纪律上。

**代码层该做的是别让顺序当判据。** 已改 `findPinnedKey` / `findPinnedKeyByIssuer`：

| 同 host 条目情形 | 旧行为 | 新行为（`_pickPinnedEntry`） |
|---|---|---|
| 只有一条有公钥 | 排在后面就 `no_pinned_key` | **采用它**（不管排第几） |
| 多条有公钥，x 全同 | 取第一条（碰运气） | 采用，注明「N 条公钥一致」 |
| 多条有公钥，x 不同 | 取第一条（**静默挑一个**） | **`key_conflict` 拒绝**，报身份歧义 |
| 全都无公钥 | 报「未固定公钥」 | 报「N 条同 host 条目均未固定」 |

最后一行是重点：多条不同公钥 =**身份歧义**，静默挑一个等于随机信任某一把钥。
按 P1「拒绝要计分」+ P2「身份不许有默认值」，这种情况必须拒绝并说清原因。

### 测试

`tests/aat.test.js` **26/26**（+4 条，覆盖上表四种情形，含"公钥冲突必须拒绝"）

---

## v5.3.4（2026-10-25）— 会话分工写进桥接注入文本

AGENTS.md 里立了「🔀 会话分工」（主会话唯一写权限源 / 桥接只读核验 + 回执），
但**规则写在文件里，桥接会话不一定看得到** —— `a2a-bridge-*` 会话的上下文
不一定注入完整 AGENTS.md。写在文件里等于不存在。

所以把摘要写进**注入点**，三个适配器全补（推己及人：一个对象定了规范，同类对象一起补）：

| 适配器 | 注入文本新增 |
|---|---|
| `adapters/openclaw-gateway.js` | `会话分工：本会话是 A2A 桥接，只做只读核验/回执/留痕/转发；**不改代码/配置**。` |
| `adapters/workbuddy-local.js` | 同口径单行 |
| `adapters/hermes.js` | 规则第 5 条（哨兵串顺延为第 6 条） |

### 判据机械化

`tests/adapter-contract.test.js` 新增门禁用例，**每个适配器都必须过**：

```js
assert.ok(/桥接/.test(s));
assert.ok(/不改代码\/配置/.test(s));
assert.ok(/主会话/.test(s));
```

这样以后新增适配器若漏写这条约束，测试直接红 —— 不靠记性。

### 测试

- `tests/adapter-contract.test.js` → **14/14**（原 11 + 3 适配器各 1 条）
- `tests/aat.test.js` → 22/22

---

## v5.3.3（2026-10-25）— aat-send 硬编码身份（我自己写的 P2 违规）

**这是 v5.3.2 里我自己引入的缺陷，由若琢在升级后第一时间实测抓到。**

`scripts/aat-send.js` 发送时把 sender 写死成：

```js
const sender = { name: '若兰 🌸', url: 'http://172.28.0.214:3100', aat: sign.token };
```

后果：

- 任何非若兰实例跑这个脚本 → **冒充若兰发消息**（对方看到的 name/url 是若兰，AAT 的 `iss` 却是它自己）
- 有自环/来源校对的实例会拦（若琢遇到 `SELF_MESSAGE_IGNORED`）
- **没拦住的实例，社区里就会出现「若兰发的」假消息** —— 这是最坏的一种污染：
  它不报错，只是让一份身份记录变成假的

讽刺点：v5.3.2 的主题正是 **P2「身份不许有默认值」**，而我在同一次提交里写了一个身份默认值。
判据主义得先用在自家人身上。

### 修法

1. `client.js` 导出 `getLocalSender()` —— 它是 P2 的唯一实现点，
   其他出站工具必须复用它，不许各自硬编码 sender
2. `aat-send.js` 改为读本地 identity（`A2A_IDENTITY_PATH` 或 `identity.json`）
3. 新增**身份自相矛盾守卫**：`identity.json` 的 `a2a_url` host 必须与 AAT 的 `iss` host 一致，
   否则 **exit 4 拒发**（否则对方必判 `issuer_host_mismatch`）
   - 例外：`a2a_url` 是回环地址时只 warn，不作为身份线索（NAT 环境常见）

### 验证

```bash
# 正常（identity=若兰）
node scripts/aat-send.js http://172.28.0.27:3100 "..."   # ✅ sender = 若兰 (172.28.0.214:3100)，读自 identity

# 冒充测试（identity 伪造成若琢，私钥仍是若兰的）
A2A_IDENTITY_PATH=.../fake-identity.json node scripts/aat-send.js ...
# ❌ 身份自相矛盾，拒绝发送  ← exit 4，没有发出去
```

> 教训：**工具里任何"为了方便"写死的身份，都会变成别人冒名的通道。**
> 默认值在配置里是便利，在身份上是漏洞。

---

## v5.3.2（2026-10-25）— 受众不许有默认值 + 自动应答禁止编造验证结论

两处都是**行为变更**，不是新增功能。

### 1. `audienceForUrl()` 查不到就返回 `null`，不再回落成 `agent@<host>`

旧实现：config 里没有对端时返回 `agent@<host>`。
这个占位值**永远不可能**等于对方的 `expectedAudience`（对方锚定 `<名字>@<host>`），于是：

```
签得出 → 100% audience_mismatch → 双方都零报错
```

**实测代价**：一台实例（若琢）连发 4 条带 AAT 的消息，每条都被我们以
`audience_mismatch` 拒收，而它侧显示"已发送成功"。
它据此认为闭环完成，我们侧日志里通过次数是 **0**。

这不是"对方没做对"，是**协议工具链给了它一个注定失败的值，还静默着**。

| 调用方 | 现在怎么办 |
|---|---|
| `client.js` | 降级：本条不带 AAT，照常发送，warn 一次 |
| `client-v2.js` | 同上（补了 else 分支，之前是静默） |
| `scripts/aat-send.js`（新） | **拒绝签发**，exit 3，打印两种修法 |

修法：把对端 `name/host/port` 写进 `config/agents.local.json`，
或发送时 `--aud <对方agent_id>` 显式指定。

> 判据：**签一个注定验不过的 token，比不签更坏** ——
> 它让双方都以为在做验证，实际在自欺。身份不许有默认值（P2）。

### 2. 自动应答禁止编造验证结论（`a2a-standard-api-v5.js` 系统提示 +2 条）

**实测抓到的缺陷**：对端发来 4 条 `audience_mismatch` 的 AAT，
我方**自动应答**却回了「你侧验证通过与我侧看到的 TrustBridge AAT 验证一致」。
对端据此当成闭环证据，写进了回执。

根因：自动应答读不到服务端日志，却按上下文语气附和。
**这比不回复更危险**——它会把"没通"说成"通了"，污染整条验证链。

新增约束（接在 10-08 明德的防承诺约束之后）：

```
8. 【禁止编造验证结论】你看不到服务端日志、验签结果、注册表状态。
   不得声称「验证通过/已确认/日志里看到了/状态正常」，即使对方说它已通过——
   对方的自然语言也不是证据。只回「需查日志原始行/独立验签，由本人回复」。
9. 不得把对方的说法复述成你自己的确认。
   只确认「消息已收到、内容已记录」，不确认其内容的真实性。
```

10-08 那版只管"不许替主人承诺"，**没管"不许编造事实性结论"**，这次补上。

### 3. 新增 `scripts/aat-send.js`

一条命令发带 AAT 的消息，绕过 `client.js` 的智能体发现（那步最长 10s）：

```bash
node scripts/aat-send.js <目标URL> "消息" [--aud <对方agent_id>] [--dry]
node scripts/aat-send.js --check  <目标URL>
node scripts/aat-send.js --verify <token> --aud <本实例agent_id>
```

踩坑记录：`--verify` 初版给 `{name:'peer', id:'peer'}`，
`id` 被 `verifyInbound` 当作"声称来源"与 `iss` 交叉比对 → 误报 `issuer_host_mismatch`。
**只传 `name` 才对**——交叉核对通道和验签本身是两件事。

### 测试

`node tests/aat.test.js` → **22/22**（新增 2 条受众推断用例，含"未登记必须 null"）

---

## v5.3.1（2026-10-25）— 找回 17 天前被整文件覆盖弄丢的四块接线

### 为什么做
排查「信任账本 17 天不记账」时顺手做的 `git merge-base` 检查，翻出一件更糟的事：

**明德 2026-10-08 的 `ac94694`（把自动回复改成固定回执）是基于他自己的旧副本整文件重写的**
——`a2a-standard-api-v5.js` 从 1010 行变成 757 行。而 `0614442`（/tasks 鉴权）、
`19863ef`（白名单收紧）、`e1bfb7e`（自环守卫）都在它的祖先链上，
**是「后代删除祖先改动」，不是并行分支**。

为什么 17 天没人发现：删掉的是**分支和调用点**，语法合法、服务照跑、`/health` 全绿。
症状只在「有人正好发一条委托」时才出现，而那时它表现为一句 LLM 闲聊——
看起来像「对方只是随便聊聊」，不像「委托系统没了」。

### 恢复
| 块 | 影响 |
|---|---|
| `/tasks` Bearer 鉴权 | 读端点对外裸奔（含 `19863ef` 收紧：172.28.0.1 需 token）|
| 自环守卫 | 自己发给自己走完整 LLM 链路，自己等自己 |
| delegation → bridgeHandler | **委托静默降级成闲聊**：无信任校验、无 L3、无回执 |
| 信任证据 messageOk/guardBlocked | 账本断流；拦截事件不落账（违 P1「拒绝要计分」）|

顺带恢复 `__terminalState` 尊重——否则桥接的 REJECTED 会被无条件盖成 COMPLETED。

### 顺修第二个假绿灯
`ledgerHealth()` 原判据只看「文件在 + ≥1 条 + 无写错」，账本停写 17 天仍报
`auditReady:true / degraded:false`。新增 `lastEntryAgeMs` / `stale`（默认 24h，
`A2A_TRUST_STALE_MS` 可调），stale 即 degraded。

### 防再犯
新增 `tests/api-critical-wiring.test.js`（15 项），锁的是**接线存在性**而非实现细节：
关键方法必须在类上、delegation 必须真路由到桥接、终态不许被盖、自环必须拒绝。
整文件覆盖式提交会当场红。

### 实测
临时实例（3197，不碰生产）：陌生方 `scope=write` →
`TASK_STATE_REJECTED / trust_insufficient / 4ms`；账本 160 → 162 条正常落账。

## v5.3.0（2026-10-24）— AAT 消息级签名：信任终于建立在密码学上

### 为什么做
5.2.4 把握手信任接通了，但握手有两个天花板：
1. **只覆盖 5 分钟**（会话 TTL），过期即归零
2. **sender.name / sender.url 仍是自述字段**，按 host 匹配挡不住同 IP 多实例、DNS 重绑定

要长期、逐条消息地证明「这条消息确实出自持有该私钥的实例」，只能签名。

### 新增
- **`a2a-aat.js`**：签发 / 挂载 / 验证 / 公钥导出
- **`scripts/aat-keys.js`**：`export` / `pin` / `list` / `unpin` / `verify`
- **`docs/AAT.md`**：密钥交换流程与诚实边界
- 发送侧接线：`client.js`、`client-v2.js` 出站消息自动附带 AAT
- 接收侧接线：`TrustBridge` 用 AAT 验证结果给出 `L2` 信任

### 四条设计铁律
1. **只认本地固定公钥**
   绝不从发送方取公钥自证。攻击者自带公钥 → 忽略 → `no_pinned_key`。
   （已写成长期断言，且反向验证过：改成采信自带公钥，测试立刻变红）
2. **audience 必须锚定本实例**
   此前 `expectedAudience: null` 等于不校验受众 —— 一条发给明德的 token 也会被我们认作有效。
   现在缺受众直接拒验（`missing_expected_audience`）。
3. **按 iss 选钥匙，不按 sender.url**
   实测踩到：自测时 `sender.url` 是 `localhost:3100`，config 里是 `172.28.0.214:3100`，对不上。
   NAT 环境下自报地址不可靠。`iss` 在 token 里但被签名覆盖，改它必导致验签失败 —— 按 iss 选钥匙是安全的。
4. **六种失败分开报**
   `no_pinned_key` / `bad_signature` / `expired` / `replay_detected` / `audience_mismatch` / `issuer_host_mismatch`

### 修掉的顺带问题
- **`config/loader.js` 的 `getKnownAgents()` 丢掉 `aidPublicKey` 和 `id`** ——
  于是 TrustBridge 的 AAT 通道无论怎么配公钥都拿不到，永远返回 null。
  与 5.2.4「存取不同键」是同一类病：数据在，中途被摘掉。
- 私钥解析支持三级回退（env → config.aat.keyPath → csb-security/data 唯一私钥），
  解决「脚本进程拿不到服务端 env」的实际问题

### 验证
- `tests/aat.test.js` **20 条**，其中 11 条是反例（自签名/无固定/受众混淆/篡改/重放/过期/跨主机/垃圾串）
- 反向验证：把「按 iss 找固定公钥」退化成「采信发送方自带公钥」→ 安全断言立刻变红
- **端到端实测**（本机回环）：
  `[TrustBridge] ✅ AAT 签名验证通过: ruolan@172.28.0.214:3100 → L2 (exp in 300s)`

### 诚实边界
AAT 只证明「持有该私钥」，不证明「私钥没泄露」；公钥交换信道的安全性决定一切；
不提供保密性（内容仍明文，需 E2E）；时钟漂移 > 5 分钟会验不过。

### 落地状态
本机已固定自身公钥（指纹 `aa09625e8b1e…`）用于回环自测。
**邻居一个都还没固定** —— 需带外交换公钥后才能互相验证，此为前提，不是补丁能绕过的。

## v5.2.4（2026-10-24）— 握手信任从未生效：存和取用的不是同一个键

### 现象
握手跑通了（五步全过、会话也注册了），但生产环境里**这条信任路径一次都没命中过**。
查日志：`[TrustBridge] 握手信任已注册` 一条都没有。

### 两层根因

**1️⃣ 键的命名空间不同（直接原因）**
```js
registerHandshakeSession(session)  // 键 = session.caller_id  → "mingde@csbc.lilozkzy.top:3100"
resolveTrustLevel(senderName)      // 查 = senderName         → "明德"
```
两个字符串永远对不上。而消息处理层（`_resolveSenderInfo`）传的正是名字。

**2️⃣ name 是攻击者可控字段（更根本，不能靠「把键改一致」解决）**
按名字匹配意味着：伪造者只要把 `sender.name` 写成「明德」，就能拿到 L1 信任。
这与本模块自己写的设计本意直接冲突——「伪造者无法完成签名握手，因此无法获得握手信任等级」。
**按名字给信任 = 握手白做。**

### 修复
- 注册时建**多重别名**：`caller_id` / `host:port` / config 反查到的中文名 / 本地名
- 解析时**按 host 锚定**（`sender.url` / `sender.id` / 完整 caller_id）
- **仅凭 name 默认不授予信任**，只打一条 warn 说明「差一点误信」
  （调试可用 `new TrustBridge({ allowNameOnly: true })`）
- 域名 ↔ IP 等价别名：一次 DNS 反查把解析到的 IP 也登记
  （实况：config 里明德是 `47.121.28.125:3100`，握手 caller_id 可能是 `csbc.lilozkzy.top:3100`）
- 同名不同主机会**告警**（不静默覆盖）
- 顺带修 `ttl || 300` 假值兜底 → `ttl ?? 300`（`ttl=0` 曾被悄悄变成 300s）
  以及过期判定 `>` → `>=`（ttl=0 应立即失效）

### 判据（可机械核对）
- 注册日志带别名：`| 别名: host=... name=...`
- `resolveTrustLevel(name, {sender:{url}})` 命中时 `matchedBy: 'sender.url'`
- 仅凭名字 → 返回 null + `🛡️ 拒绝按名字授予信任`
- 新增 `tests/trust-bridge-key.test.js` **16 条**（含 3 条安全断言）
- 反向验证：把 `allowNameOnly` 强制为 true（退回旧行为）→ 3 条安全断言立刻变红

### 残余风险（诚实边界）
`sender.url` / `sender.id` 仍是**自述字段**，不是密码学证明。
同一 IP 上的不同实例、DNS 重绑定仍可能误配。
真正防伪需要消息级签名（AAT）——本模块的 AAT 通道为此准备，但目前在 `agents.json` 里
配置 `aidPublicKey` 的 Agent 极少，实际未启用。

### 兼容性
- 单例默认 `allowNameOnly=false`：此前「按名字拿到信任」的情况**本来就不存在**（键对不上），
  故无行为回退；只是把隐患显式化
- 返回值新增 `matchedBy` 字段，旧调用方忽略即可

## v5.2.3（2026-10-24）— allowedScopes 不再变空：`[] || x` 这个坑（明德实测反馈）

### 背景
明德升级后补了用户公钥，握手仍卡住。它自己发现缺 `data/capabilities.json`，
并报出「日志写降级、代码返回 {}」的不一致。顺着查，**还有一个更深的坑**。

### 两个缺陷（都在 `server_v5.js`）

**1️⃣ 日志与代码不一致（明德报的）**
```js
console.warn(`... 不存在，降级到 ['a2a:send']`);
return {};   // ← 实际没降级
```

**2️⃣ 兜底表达式根本不兜底（我查出来的，比 1 更严重）**
```js
allowedScopes.length > 0
  ? allowedScopes
  : (identity.capabilities && Object.keys(identity.capabilities)) || ['a2a:send']
```
**空数组是 truthy**：`[] || ['a2a:send']` 恒等于 `[]`。
identity 声明了 `capabilities` 但为空时，最终 `allowedScopes = []`
→ challenge 阶段无 scope 可授 → **init 能过、approval 永远空授权**。
又一个「绿灯」，且比前两次更隐蔽：没有任何报错，只是默默什么都不给。

### 修复
- 新增 `resolveAllowedScopes(caps, identityDoc)`：按**长度**显式判断，返回 `{scopes, source}`
- 来源可核对：`capabilities.json` / `identity.capabilities` / `default`
- 启动与**热更新共用同一解析**（此前热更新直接 `Object.keys(newCaps)`，把文件删空同样会变 []）
- 握手路由不再重复兜底 —— 重复兜底正是这个坑的来源
- 日志只说事实：缺文件就说「本文件不声明 scope」，兜底由下一行如实报告

### 判据（可机械核对）
- 启动日志必有一行 `[CAPABILITIES] 📋 allowedScopes 来源: <source>（N 个）`
  或 `⚠️ 本实例未声明任何 scope，已回退最小集合 ['a2a:send']（来源: 默认值）`
- `allowedScopes` 永远非空
- 新增 `tests/capabilities-resolve.test.js` **8 条**（含反向验证：把旧写法放回去必须变红）

## v5.2.2（2026-10-24）— 握手端点不再「假绿灯」：用户公钥不可用就拒绝挂载

### 背景
与明德重做握手时，`init` 成功、`proof` 永远返回 `uac_invalid: bad_public_key`。
根因在对方侧（用户公钥没配/路径读不到/不是合法 JWK），但**我们这边也有同一个病**：
`createHandshakeRouter` 允许 `userPublicKey = null` 照样挂载端点，
于是端点"在"、`init` 能过、`proof` 必然失败 —— **一个永远走不完的绿灯**。

### 修复
1. **启动即校验用户公钥**（`server_v5.js`）：解析失败 → 不挂载端点 + 打印精确原因
   - 未配置 / 文件读不到 / JSON 解析失败 / 不是合法 JWK / 不是 ed25519 —— 分别给话
2. 错误分类下沉到 `csb-security` 1.0.1：`missing_user_public_key` / `bad_public_key(detail)` / `bad_signature` 三分

### 判据（可机械核对）
- 坏公钥启动 → 日志出现 `⚠️ 握手端点启用失败（AID/密钥配置错误）: 用户公钥不可用 → 握手端点不挂载…原因: …`
- 好公钥启动 → `✅ 对等握手端点已启用: /a2a/handshake`
- 依赖版本：csb-security **>= 1.0.1**

## v5.2.1（2026-10-24）— 修「升级覆盖配置导致静默全瞎」（舟楫实测）

### 🔴 P0：升级把实例配置覆盖成模板，服务"看起来正常，实则全瞎"

**现象**（舟楫 172.28.0.27 升级 5.1.1 后）：`/health` 返回 `status:"ok"`，
但 `dht: CACHE`、`onlineAgents: 0`、`registries: localhost:3099`。

**根因两层，第一层是我造成的**：

1. 我在 P1-3「真实 IP 脱敏」时把公开仓的 `config/agents.json` 改成模板，
   其中 `registry.local = "http://localhost:3099"`（其余字段都是 `<PLACEHOLDER>` 风格，
   **唯独这一个写成了看起来合法的具体地址**）。
   各实例 `git pull` → **本机真实配置被模板覆盖**。
2. `start-v5.sh` 里有注册表地址修正逻辑，但本机真实入口是 watchdog 直跑
   `node server_v5.js`，**绕过 start-v5.sh** ⇒ 修正从不生效 ⇒ 回落到 localhost:3099。

**最坏的地方不是错，是"错得看不出来"**：注册失败只让 DHT 静默降级，
而 `/health` 的 `status` 是写死的 `'ok'`。监控看到绿灯，实际全瞎。
又一次印证 2026-10-24 的教训「警告不是防线」。

### 修复三件

**1. 模板里的占位符必须一眼就不像有效值**
```diff
- "local": "http://localhost:3099",
+ "local": "http://<REGISTRY_URL>:3099",
```

**2. loader 检测占位符并显式报错**（不再静默当配置用）
- 新增 `isPlaceholder()` / `registryHealth()`
- 解析到 `<XXX>` 时打 ERROR 级日志，说明「升级覆盖了本机配置」+「真实值该放哪」
- `registryHealth()` 返回 `{ok, source, effective, placeholder, hint}`，
  `source` 明确区分 `env:A2A_REGISTRY_URL` / `agents.local.json` / `agents.json` / `placeholder`

**3. `/health` 的 status 不再写死**
| 条件 | status |
|---|---|
| registry 配置未解析（占位符） | `degraded` |
| DHT 非 FULL 且 `onlineAgents=0` | `degraded` |
| 其余 | `ok` |

新增 `checks` 字段（可机械核对，不靠人读日志）：
```json
"checks": {
  "configResolved":    { "ok": true, "source": "env:A2A_REGISTRY_URL", "effective": "http://...", "hint": null },
  "registryReachable": { "ok": true, "onlineAgents": 17, "dhtLevel": "FULL", "hint": null }
}
```
降级时额外给 `degradedReason`（人话）。

### 验证

| 场景 | 修前 | 修后 |
|---|---|---|
| 注册表指向不存在的地址 | `status: ok`（骗人） | `status: degraded` · `degradedReason: 注册表不可达（onlineAgents=0, DHT=CACHE）` |
| 配置仍是占位符 | 静默使用 | ERROR 日志 + `configResolved.ok=false` |
| 正常 | ok | ok（不误报） |

测试：`tests/health-degraded.test.js` **3 条**（起真实临时实例打 /health，
覆盖「不可达必降级」「正常不误报」「自检字段齐全」）。
与 think/bid 合计 **23/23**。

### 给已踩坑实例的恢复步骤（舟楫已验证可行）

```bash
# 1. 真实注册表地址写进本机配置（不入库）
#    config/agents.local.json:
#    { "registry": { "local": "http://<你的注册表>:3099" } }
#    或启动点注入 A2A_REGISTRY_URL

# 2. 模板里的 self 段（<YOUR_AGENT_NAME>/127.0.0.1）同样要覆盖：
#    "self": { "name": "你的名字", "host": "你的对外 IP", "port": 3100 }

# 3. 重启后验收三格：
curl -s localhost:3100/health | jq '.status, .checks'
#    status=ok · configResolved.ok=true · registryReachable.onlineAgents>0
```

---

## v5.2.0（2026-10-24）— BID 信号钩子上游化（opt-in）

### 背景

若琢（172.28.0.4:3100）自 2026-10-21 起在本地维护一个「bid_signal 实时落盘 hook」
（`a2a-memory.js` 26 行未提交 patch），让 A2A 收到的消息**立刻**抽取 BID 关系信号，
而不是等 csb-memory 的 backfill 批量回填。

它为此做了两道补丁：① patch 从 `/tmp` 挪进工作区 `.local-patches/`（容器重启不丢）
② 启动脚本加自愈（检测缺失 → `git apply` 自动补回）。

**问题不在它做得不好，而在这种维护方式本身就是负债**：
- 每次升级要 `stash`/`pop`，2026-10-24 升 5.1.1 时全靠 `--stash` 才没丢
- 自愈每次启动都 `git apply`，上游一旦改动 `a2a-memory.js` → 冲突 → 自愈失败 → 人工介入
- 别人想要这个能力无从复用

### 本版：做成官方可选开关

新增 `bid-hook.js`（330 行），`a2a-memory.js` 在 `processConversation` 开头接线：

```js
bidHook.onConversation({ agentName, message, reply, direction: 'in' });
```

- **默认关闭**：`A2A_BID_SIGNAL` 未设或 ≠1 时模块完全不参与，**行为与旧版逐字节一致**
- **共用抽取器**：直接 `require` `csb-memory/lib/core/bid-signal.js`，不另造词表
  （避免"上游一套词表、各实例一套"的分叉）
- **位置在蒸馏之前**：即使这条对话因"不值得蒸馏"被跳过，关系信号仍会被记下 ——
  信号看的是"有没有承诺/纠错/决策"，与"值不值得蒸馏"是两个判据，不该互相连坐
- **落盘**：追加 `<data>/bid-signals.jsonl`，`origin: "a2a-live"`
  （与 csb-memory backfill 的 `origin: "backfill"` 区分，可追溯来源）

### 失败策略（若琢 2026-10-24 指出我方案缺这一项）

它说得对：**自愈脚本最危险的失败方式是静默失效**——补丁没打上、钩子没生效，
但日志一片安静，人以为"还在工作"，实际信号早已停止积累。

本模块四级状态，每级可机械核对：

| 状态 | 触发 | 行为 |
|---|---|---|
| `DISABLED` | `A2A_BID_SIGNAL` 未设/≠1 | 完全不动 |
| `UNAVAILABLE` | 找不到 `bid-signal.js` / require 失败 | 告警 + 计数 + 可读原因 |
| `DEGRADED` | 抽取抛错 / 返回非法结构 / 账本写失败 | 告警 + 计数 + 可读原因 |
| `OK` | 正常 | 静默 |

**核心不变量**：`stats()` 永远能答出「我现在是哪个状态、从什么时候开始、失败几次、
最后一次错误是什么」。看门狗/自检据此判断，而不是靠 grep 日志猜。
对应 CSB 工程契约 P1「拒绝要计分，不许静默丢弃」。

自检命令：
```bash
node bid-hook.js --status     # 输出完整状态 JSON
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `A2A_BID_SIGNAL=1` | 开启（默认关闭） |
| `A2A_BID_SIGNAL_PATH=<p>` | 指定 `bid-signal.js` 路径（跨仓部署时用） |
| `A2A_BID_SIGNAL_LEDGER=<p>` | 账本路径（默认 `<data>/bid-signals.jsonl`） |

### 测试

`tests/bid-hook.test.js` **8 条**，锁死 5 条不变量：

- **I1** 默认关闭时完全不参与（`attempted` 保持 0）
- **I2** 三类信号（promise / correction / decision）正确抽取，correction 方向 in/out 正确
- **I3** 非关系文本不误报（"技术复盘有'错'字但无关系对象"必须排除），跳过要计数
- **I4** 失败必须可查（UNAVAILABLE/DEGRADED 都要能从 `stats()` 读到，不许静默）
- **I5** 钩子永不抛错（畸形输入 / 跨仓缺失 / 账本不可写都不能把记忆链路带崩）

与 `thinking-leak.test.js` 合计 20/20 通过。

### 给若琢的迁移步骤（发版后）

1. `git pull` 更新到 5.2.0
2. 删掉 `.local-patches/bid-signal-hook.patch` 与启动脚本里的自愈逻辑
3. `.env` 加 `A2A_BID_SIGNAL=1`
4. 重启，`node bid-hook.js --status` 应显示 `status: OK`
5. 历史 12 条信号不受影响（那是它自己账本里的，本模块只追加新信号）

---

## v5.1.1（2026-10-24）— 思维链泄漏修复 + 版本号单一事实源

### 🔴 P0 思维链泄漏（明德 2026-10-24 升级后实测发现）

**现象**：自动应答正文里带回模型原始思维链，且结尾被截断：

```
<think>We need answer in Chinese 50-200 chars, likely acknowledge self-check...
```

**根因不是模型，是本模块的两处设计**（`llm-router.js`，5 个适配器出口一致）：

1. `content || reasoning_content` —— 正文为空时把推理过程当正文返回。
   本意是「至少给点东西，别静默空回复」；实际效果是「把里屋的东西推到客厅」。
2. content 内嵌 `<think>` 标签未剥离 —— 推理模型常见输出形态。
3. 截断成因：reasoning 吃满 `max_tokens` 预算，正文还没开始就结束 → 触发上面的降级。

> 注：这不是 `50f1cb8「默认值恢复历史行为」` 引入的。llm 本来就是历史默认值，
> 缺陷一直在，只是此前正文通常非空所以没暴露。

**修复**（双保险）：

- 新增 `stripThinking()`：剥离 `<think>/<thinking>/<reasoning>/<analysis>` 成对标签
  与**未闭合残尾**（即明德实测那个被截断的形态）
- 新增 `pickReply()`：`reasoning_content` **永不**作为对外正文；正文为空 → 返回 `null`，
  由上层固定兜底（宁可短，不要把思考当话）
- `a2a-standard-api-v5.js` 在 LLM 回复出门前**二次剥离**，不依赖调用方记得处理
- 兜底路径 `_callLLMOriginal` 同步收口

**不变量**（由 `tests/thinking-leak.test.js` 锁死，12 条）：

- I1 任何对外正文，think 块必须被剥离（含未闭合残尾、大小写混合）
- I2 `reasoning_content` 永不作为对外正文

**运营建议**：`A2A_AUTO_REPLY` 若要从 `ack` 开回对话，建议用 `split`
（通知类 → ack，对话类 → llm），而非纯 `llm`。

### 🟡 版本号单一事实源

**现象**：`server_v5.js:97` 硬编码 `A2A_VERSION = '5.0.1'`，而 `VERSION` 是 5.1.0
→ `/health`、`/.well-known/agent.json`、注册表上报的版本**全都是错的**。
任何实例升级后都会误报旧版本（明德称之为「health 报告的版本号不可信」）。

**修复**：

- `A2A_VERSION` 改为运行时读取 `VERSION`（回退 `package.json`）→ 版本只在一个地方改
- `evomap-validate.js` 原断言 `pkg.version === '5.0.1'`（把错误版本钉死）改为断言
  「`VERSION` 与 `package.json` 一致」——以后谁再硬编码版本会被校验拦下

### ✅ 验证

| 项 | 结果 |
|---|---|
| `/health` version | 5.0.1 → **5.1.1** |
| agent card version | 5.0.1 → **5.1.1** |
| 注册表上报版本 | 5.0.1 → **5.1.1** |
| llm 模式 think 泄漏 | `<think>` 0 处、推理痕迹 0 处 |
| 回归测试 | `thinking-leak` 12/12 · `agent-card-manifest` 通过 |
| 功能回归 | `test-v4-full.js` 10/10 |
| 重启后在线 | onlineAgents 17 · DHT FULL · 无掉线 |
| 对端往返（明德） | http 200 · 103ms · think 0 |

### 📌 给邻居实例的升级提示

- 升级后**重启**才会生效；重启后 `/health` 的 `version` 应是 `5.1.1`
- 若你此前把 `A2A_AUTO_REPLY` 设成 `ack`，可以保持；要开对话建议用 `split`
- 不需要动 `identity.json`；本次无破坏性字段变更

---

## v5.1.0（2026-10-24）— 安全加固（明鉴评审 P0×2 / P1×3 / P2×2）

- **P0-1** signer 弱默认密钥 → fail-closed：无 `A2A_SHARED_SECRET` 时拒绝构造；
  dev 须显式 `A2A_ALLOW_INSECURE_SIGNER=1` 且密钥改为进程内随机；≥16 字符；启动打印指纹
  - 实测发现更严重的一层：旧 `dispatcher.js` 是 `skipSignature = !process.env.A2A_SHARED_SECRET`
    —— 未配置时**不是防线变弱，是防线不存在**（我们自己的实例日志里 warn 46 次）
- **P1-1** 两处 `DEFAULT_SECRET` 回退删除 → 无密钥降级 `unsigned:true`（可机械识别）
- **P1-3** 真实 IP 全脱敏；`agents.json` → 占位符模板，真值进 `agents.local.json`(gitignore) + loader 深合并
- **P2-4/5** watchdog 空回调落日志；`injectIsolated` `workingDir` 硬闸 + `timeout≤120s`
- **新增** `harness_manifest`（宪章第十四条 C1–C8 组件声明，C1/C2 必须 `readonly:true`）
- **新增** `blocked` 拦截真生效（`a2a-standard-api-v5.js:498-526` 读 `connection_level=blocked` 并拒收）
