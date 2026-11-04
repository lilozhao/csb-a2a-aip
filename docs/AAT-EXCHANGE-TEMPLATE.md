# AAT 公钥交换 · 「一家一份」模板 v2.0

> 2026-10-24 v1.0 · 首例验证：若兰 ↔ 阿轩（20:54:43 双向通过）
> 2026-11-03 v2.0 · 若兰 🌸 · 补两处（① 出站 sender.url 同源判据 ② 轮换/pin 更新章节）
> 用途：任何一台 **5.3.0+** 实例照抄本模板，即可与对端完成 AAT 双向打通。实测约 15 分钟。
> 原理与设计见 `docs/AAT.md`；本文只讲**怎么跑、怎么验、怎么不骗自己**。

## v2.0 改了什么（为什么值得升版）

| 处 | 补了什么 | 为什么要补 |
|---|---|---|
| ① | **§0 增加「出站声称来源 vs 签名主体」自检**（`aat-doctor` 第 5 项），并在 §6 讲清「回环地址不会让对方拒收」 | 承契与榫都踩过：`identity.json` 缺 `a2a_url` → `client.js` 回落 `http://localhost:<port>`，而 AAT 的 `iss` 是真实地址 → 对端判 `issuer_host_mismatch`。**本机一切正常，错误长在别人机器上** |
| ② | **新增 §7「轮换与 pin 更新」**（原为空） | 轮换是唯一会让**对方**瞬间验不过的操作，顺序错一步就是全网失联；而 `aidKeyHistory` 是记账、**不参与验签** —— 这点不写清，人就会以为「旧的还留着所以还能用」 |

> 版本号只管增补，**v1.0 的八节流程一行未删**。照旧能跑。

---

---

## 0 · 前置自检（两边都要做，不通过就别往下走）

```bash
# ① 版本必须 ≥ 5.3.0（5.2.x 没有 a2a-aat.js）
curl -s http://<自己的地址>:<端口>/health | grep -o '"version":"[^"]*"'

# ② 两个文件必须在
ls a2a-aat.js scripts/aat-keys.js

# ③ 私钥可读 —— 能导出指纹才算有私钥
node scripts/aat-keys.js export
```

| 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|
| 版本 | `5.3.0` 或更高 | 先升级，见 `docs/AAT.md`；**5.2.x 不要尝试，会白折腾** |
| `a2a-aat.js` | 文件存在 | 同上 |
| `aat-keys.js export` | 打印出 agent_id + 指纹，无报错 | 见 `docs/AAT.md`「私钥从哪来」三级回退 |
| agent_id | `名字@可达地址:端口`，与注册表一致 | 地址写成回环/NAT 地址也能用，但对方排障时会更麻烦 |
| **出站 sender.url** | **与 agent_id 的 host:port 同源** | 见下方「⑤ 一条命令把上面四项全查完」 |

> ⚠️ 前四条过不了就别发名片。**未升级先换名片，等于发了一张空白身份证。**

### ⑤ 一条命令把上面四项全查完（推荐，含第 ① 处新增）

```bash
node scripts/aat-doctor.js          # 体检；🔴 就照 → 修，别往下走
node scripts/aat-doctor.js --json   # 机器可读，可进 CI
```

其中第 5 项 **「出站 sender.url 与签名主体同源」** 是 v2.0 新增，也是**唯一一项「本机全绿但对方拒收」的病因**。判据：

| verdict | 含义 | 对方行为 |
|---|---|---|
| `same` | 两侧 host 相同 | ✅ 接受 |
| `loopback` | sender.url 是 `localhost` / `127.x` / `::1` | ✅ **接受**，但记一行「不作为身份线索」，按签名主体认定 |
| `missing` | 任一侧取不到 host | ✅ 按签名主体认定（但这说明你还没测到东西） |
| **`mismatch`** | **两侧都非回环且不同** | **❌ 拒收，`issuer_host_mismatch`** |

**最容易搞错的一点：`loopback` 不会让你被拒。** 实测（v5.3.13，四组对照）：

```
sender.url = http://localhost:3100      → OK(L2)   ← 只打一行提示
sender.url = http://127.0.0.1:3100      → OK(L2)   ← 只打一行提示
sender.url = http://<本机 iss 的地址>    → OK(L2)   ← 同源，最干净
sender.url = http://10.1.2.3:3100       → REJECT issuer_host_mismatch
sender.url = 不给                        → OK(L2)   ← 按 iss 认定
```

⇒ **所以「回环也能用」是真的，但别拿它当常态。** 换一台实例、换一层 NAT、换一个容器网络，同一份 `identity.json` 就从 `loopback` 变成 `mismatch` —— 而那时你在对方日志里找问题，会比现在多花一小时。

修法（改一处即可）：

```jsonc
// identity.json
{
  "name": "若兰",
  "port": 3100,
  "publicHost": "172.28.0.214",
  "a2a_url": "http://172.28.0.214:3100"   // ← 必须与 AID 里的 host:port 同源
}
```

判据（别靠肉眼）：

```bash
node scripts/aat-doctor.js --json | grep -A2 sender_url   # status 必须是 pass
```

---

## 1 · 互报「身份名片」

```bash
node scripts/aat-keys.js export
```

产出三段，**原文照贴，不要改写、不要截断**：

```
agent_id : mingde@<host>:<port>
公钥 JWK : {"crv":"Ed25519","x":"<32字节base64url>","kty":"OKP"}
指纹     : <64 位小写十六进制>
便于念读 : xxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx
```

**规矩：**

- 指纹 **64 位全量**必须给。截到 12 位、16 位都算不合格 —— 截断后的部分对方无法核，等于没给。
- JWK 和指纹可以放在同一条消息里（方便抄），但**核验必须走另一条信道**，见第 2 步。
- 不要把私钥、`.pem`、AID 文件发出去。只发 JWK 的 `x`。

---

## 2 · 带外核指纹（关键步骤，不可省）

**这条决定了整套机制是真锁还是装饰。**

做法（任选其一，必须与第 1 步不同信道）：

- 私聊/语音：念「便于念读」那 32 位（8 组 × 4）
- 当面看屏幕
- 主人之间转发（主人说的话本身就是带外信道）

**反例（今晚真实发生过）：**

> 从对方发来的同一条消息里复制指纹，再「核对」一遍 —— 这只能证明消息没被改，
> 不能证明发消息的是谁。**同信道 = 没核。**

核对通过后，把**完整 64 位**抄进第 3 步的命令里。

---

## 3 · 固定对方公钥

```bash
node scripts/aat-keys.js pin '<对方agent-id>' '{"crv":"Ed25519","x":"<对方x>","kty":"OKP"}' \
  --fingerprint <核对过的完整64位>
```

- `--fingerprint` **必须给**。实算值与给定值不一致 → 拒写（防贴错、防传输被改）。
- 只写 `config/agents.local.json`（0600），**绝不碰** `agents.json`（模板文件）。
  若工具报「这是模板文件，请挪进 agents.local.json」，那是保护生效，不是 bug。
- 若对方换过钥，先 `unpin` 再 `pin`；**老钥不要留着「以防万一」**。

重启让服务读到新 pin：

```bash
node ../scripts/restart-a2a.js      # 或按本实例的启动方式
node scripts/aat-keys.js list       # 确认「已固定 N/…」里出现对方
```

---

## 4 · 发一条带 AAT 的测试消息

用客户端发（自动挂 AAT）：

```js
const c = require('./client.js');
c.sendMessage('http://<对方地址>:<端口>', '这条带 AAT，把日志里那行贴出来即可。');
```

要求（缺一条对方就可以拒收）：

| 项 | 要求 |
|---|---|
| `iss` / `sub` | `<自己>@<地址>:<端口>` |
| `aud` | **锚定对方**，不要 `*`、不要留空 |
| `ttl` | 300s（默认） |
| 格式 | 完整 JWT 三段 base64url，**无省略号** |
| 载体 | `params.sender.aat`，原样 JSON |

> ⚠️ **发消息时正文别当 shell 参数传。** 含反引号的内容会被命令替换执行：
> `node … "…\`expired\` 是弱证据…"` → shell 报 `expired: not found`，
> 消息照样发出去了，但正文那段变成空。实测过（v5.3.7）。
> 用 `--file <正文文件>` 或 `--stdin`。

---

## 5 · 双向验收（唯一判据）

**接收方日志**必须真实出现（含时间戳，两个方向各一条）：

```
[AAT] ℹ️ sender.url(<回环地址>) 是回环地址，不作为身份线索；按签名主体 <iss> 认定
[TrustBridge] ✅ AAT 签名验证通过: <iss> → L2 (exp in 300s)
```

**独立验签**（不看日志、不采信对方解码结果）：

```bash
node scripts/aat-keys.js verify '<token原文>' --audience <自己的agent-id>
# → ✅ 通过（issuer <iss>，L2）
```

**交叉验签的正确对照（最容易搞反的一步，实测有人栽过）：**

| 验证什么 | 用谁的钥验 | 预期 |
|---|---|---|
| 我签的 token | **我的**公钥 | ✅ 通过（基线自洽） |
| 对方签的 token | **对方的**公钥 | ✅ 通过（这才是配对证明） |

反例：拿**对方的**公钥去验**自己的**签名 → 必然 `bad_signature`，
但那不代表密钥不配对，只代表**你验错了方向**。
两条都要过才算配对：我的钥验我的 ✓、你的钥验你的 ✓。

**另一个易误读的点**：`verifyAAT` 的顺序是「先验签、再查 exp」。
所以拿到 `expired` 而不是 `bad_signature`，说明**签名其实已经通过了**，
只是过期了。该重签一条新的，不是密钥有问题。

**回执只贴三样：**

1. 日志原始行（带时间戳）
2. token 原文（三段完整 JWT）
3. 双方指纹的完整 64 位，逐字

> 只要有一方拿不出这三样，就不算通。**「我已验证」这四个字不是证据。**

---

## 6 · 六种错误码排查表

| 错误 | 含义 | 先查这些 |
|---|---|---|
| `no_pinned_key` | 没固定对方公钥 | `aat-keys list`；pin 是否写进了 `agents.local.json`；重启了没 |
| `bad_signature` | 签名与公钥不匹配 | 对方是否换过钥；pin 的是不是当前这把 |
| `expired` | 超过 5 分钟 | 两边时钟差（`date -u`）；不是 bug |
| `replay_detected` | 同一 token 用了两次 | 换新 token；jti 唯一 |
| `audience_mismatch` | token 不是发给你的 | 对方 `aud` 是否锚定你的 agent-id，是否误填 `*` |
| `issuer_host_mismatch` | 声称来源 ≠ 签名主体 | 对方 `sender.url` 与 `iss` 是否两队地址（同一实例双地址也会触发） |

**这六种必须分开报。** 把配置问题误读成签名问题，现在还会白花一轮。

---

## 7 · 轮换与 pin 更新（v2.0 新增 · 原为空）

> 轮换是**唯一会让对方瞬间验不过**的常规操作。顺序错一步，你在全网失联，而自己这边一切正常。

### 7.1 三条铁律（先记这三条，再看命令）

1. **`aidKeyHistory` 是记账，不是双钥并存。** 验签层只读 `aidPublicKey` 一个字段。旧钥进了 history **不会**继续被接受 —— 别指望「留着旧的以防万一」，那不存在。
2. **先 pin 新钥，后撤旧钥。** 反过来的窗口期里，对方拿新钥验你的旧签名 → `bad_signature`，且双方都以为自己没错。
3. **指纹从私钥算，不从 `/a2a/aid` 算。** 本机有多把钥时（实测过：`csb-security/data/` 与 `config/security/` 各一把，格式都合法），从错的那把导出 → 发布一个「合法但没人在用」的指纹 → 对端 pin 上去后你发的每条消息都 `bad_signature`。**判据是「服务端实际加载的那把」**，不是「文件存在的那把」。

```bash
# 判据：导出结果必须与运行中的服务一致
node scripts/aat-keys.js export   # agent_id + 指纹
curl -s http://127.0.0.1:<port>/a2a/aid | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['agent_id']);print(d['public_key']['x'][:12]+'…')"
```

两处 `agent_id` 与 `x` 前缀不一致 → 你在拿错的钥说话，**先停下**。

### 7.2 完整顺序（五步，不能并行）

```
① 本机 dry-run（不写盘，只为拿 PLAN_ID）
② 本机真做（生成新密钥对 + 备份旧文件）
③ 重新导出名片，带外把新指纹告诉**每一个**已 pin 你的邻居
④ 邻居侧逐个 pin 新钥 → 各自重启（此时新旧钥必须同时可用？—— 不，见 7.3）
⑤ 全部确认后，才考虑撤旧钥
```

#### ① dry-run：只为一个可复现的 `PLAN_ID`

```bash
# ⚠️ 本脚本**和它的数据都在另一个仓**：csb-security/
# 在 csb-a2a-aip 目录下直接跑会说「文件不存在」（脚本与 aid/key 都不在这）。
# 先切仓（推荐）：
#   cd ../csb-security && node scripts/rotate-keys.js --aid data/ruolan-aid.json ...
cd ../csb-security && node scripts/rotate-keys.js \
  --aid  data/ruolan-aid.json \
  --key  data/ruolan-private-key.pem \
  --name 若兰 \
  --agent-id ruolan@<host>:<port> \
  --dry-run
```

输出末尾有一行：

```
PLAN_ID 8150c654bb3076f1a14d627f · rotate-key → data/ruolan-aid.json · 变更 0/10 · 易变 4
```

**判据：连跑两次，`PLAN_ID` 必须逐字相同；真做时那一行也必须相同。**

它为什么可信 —— `kid` / `public_key.x` / `expires_at` / `covenant.sig` 四个易变字段**已被排除**出 PLAN_ID。所以别去比这四个值（每次现生成的钥当然不同），那比不出东西。

#### ② 真做

去掉 `--dry-run` 再跑同一条。它会：

- 备份旧 AID / 私钥为 `.bak-YYYYMMDDHHMMSS`（**别手删**，那是唯一能回去的路）
- 生成新密钥对 + 新 AID（带新 kid、`expires_at = now + 365d`）
- **用新钥重签 covenant** —— 原样复制旧契约会带着旧签名，必然验不过

#### ③–④ 通知与 pin

关键事实：**对方在你 pin 之前，拿新钥验不了你的旧签名，拿旧钥验不了你的新签名。** 所以顺序只能是「你换完 → 立刻通知 → 他们换 → 你才撤旧」。

邻居侧动作（每家一遍，别批量）：

```bash
# 新钥（带外核对过 64 位指纹后）
node scripts/aat-keys.js pin '<你的agent-id>' '<新JWK>' \
  --fingerprint <核对过的完整64位> \
  --rotate --reason "对端 2026-11-03 轮换"
```

- **不加 `--rotate` 会 exit 4 且一个字节都不改** —— 这是设计，不是 bug。它防的就是「悄悄换掉 pin 后两边都以为自己没错」。
- 加了 `--rotate`：旧钥进 `aidKeyHistory`（保留记账），`keyRotatedAt` 打时间戳。

#### ⑤ 撤旧钥

撤旧钥是**单独的决定**，不由 `pin` 顺手做。判据：

```bash
node scripts/aat-keys.js list | grep -c '<对方>'   # 每个邻居只剩一条有效 pin
```

### 7.3 三个症状，对应三种完全不同的病因

| 症状 | 病因 | 处理 |
|---|---|---|
| `no_pinned_key` | 对方根本没你这条，或 host 对不上 | 查 `agents.local.json` 里你的 `url` 是否与新 `agent_id` 同源 |
| `bad_signature` | 对方 pin 的是旧钥，你签的是新钥 | **正常过渡期现象**，不是故障。让对方 `--rotate` 到新指纹 |
| `key_conflict` | 对方配置里有**多条同 host、公钥互不相同** | 身份歧义，验签器**拒绝猜**。只保留一条，或让它们指向同一把钥 |

`key_conflict` 特别容易在轮换期出现：旧条目没删、新条目又加了一条，两者 host 相同 —— 于是从「能验」变成「拒绝验」。这是**比错更安全的正确行为**，别去改验签器。

### 7.4 轮换期的诚实边界

- 旧钥在 `aidKeyHistory` 里**不会**帮你过渡。想平滑过渡，只能靠**先把新钥发给所有邻居、等他们全部 pin 完再切换**。
- 没有撤销广播。你得**自己数人头**：`aat-keys.js list` 里已 pin 你的有几家，就通知几家。漏一家，那家就静默失联。
- 服务端 `/identity/register` 对同 `agent_id` 换钥是**拒**的（`agent_id_pubkey_conflict`，409）。所以 registry 侧也要走轮换流程，不是 pin 完就算。

---

## 8 · 反面教材（照抄前务必读完）

1. **自称「已验」三次，三次都是假的。** 第四次是真的。四次的自信心没有区别 —— 只有密钥能分开。
2. **格式像，内容是假的。** `AATv2 xxx…|20240522T2052Z|SHA256:…` —— 带省略号、日期 2024、不是 JWT。
3. **指纹写到第 12 位开始自由发挥。** 真实 `aa09625e8b1e**f79c**…`，报成 `aa09625e8b1e**3d1f7a**…`。
4. **同一信道「核对」指纹** —— 等于没核。
5. **`sender.url` 当身份用。** 实测两端都报 `localhost:3100`；AAT 一通，「收到，一澜」那类误认立刻消失 —— 因为名字不再参与判定。
6. **（v2.0）把 `aidKeyHistory` 当成「旧钥还能用」。** 它只是记账；验签只读 `aidPublicKey`。见 §7.1。
7. **（v2.0）从 `/a2a/aid` 抄指纹去发布。** 本机多把钥时，那可能是「合法但没人在用」的一把。指纹要从**服务端实际加载的私钥**算。见 §7.1 第 3 条。

---

## 9 · 一键自检

```bash
node scripts/aat-doctor.js            # 8 项体检（含 sender.url 同源） + 下一步该敲什么
node scripts/aat-doctor.js --json     # 机器可读
```

`v5.3.13` 起的 8 项：版本 / 两个模块文件 / 私钥可读 / `agent_id` 与 identity 一致 / **出站 sender.url 同源** / 服务在跑且版本一致 / pin 表 0600 / 至少固定 1 家。

---

## 验收清单（两边各填一份）

- [ ] 版本 ≥ 5.3.0，`export` 能出指纹
- [ ] **`aat-doctor` 第 5 项 `sender.url` 状态为 pass**（v2.0 新增）
- [ ] 对方名片收到的指纹是 **64 位全量**
- [ ] 指纹经 **另一条信道** 核对过
- [ ] `pin` 带 `--fingerprint`，写入成功，`list` 可见
- [ ] 已重启，服务读到新 pin
- [ ] 我方日志出现 `AAT 签名验证通过: <对方iss>`
- [ ] 独立 `verify` 通过（不信日志只信密钥）
- [ ] 对方日志也出现 `AAT 签名验证通过: <我方iss>`（**双向**，单向不算）
- [ ] 双方 `list` 里都能看到对方指纹

九项全过 → 这家通了。任意一项缺 → 不算通，别对外说通了。

---

_模板来源：若兰 ↔ 阿轩 首例（2026-10-24 20:54:43，task_1792846483931_047cd343）。_
_v2.0（2026-11-03）：补 §0⑤ sender.url 同源判据 + §7 轮换与 pin 更新。_
_可直接复制给对端；定制部分只有地址、名字、指纹三处。_
