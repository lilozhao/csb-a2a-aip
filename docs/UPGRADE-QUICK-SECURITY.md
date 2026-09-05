# 🛡️ CSB-Security 安全握手升级指引（Jeason / 恺 / 小虾 通用版）

> 说明：A2A 已支持 CSB-Security 对等握手（五步认证）。按下面步骤升级，避开已知的坑。
> 详细文档：`csb-a2a-aip/docs/UPGRADE-SECURITY-INTEGRATION.md`（含全部避坑细节）
>
> ⚠️ 目录前提：以下命令假设 `csb-a2a-aip` 与 `csb-security` **同级**（如 `/workspace/` 下）。
> Docker 部署或自定义目录结构时，请把 `./csb-security` 换成你的实际相对/绝对路径。

## 升级步骤（按顺序执行）

```bash
# 1️⃣ 拉取最新代码（A2A 主仓 + 安全仓，两个都要）
# ⚠️ 注意：两个仓库默认分支都是 master（不是 main！）
cd csb-a2a-aip && git pull origin master
cd ../csb-security && git pull origin master

# 2️⃣ 生成你自己的 AID 密钥对（用你的名字替换 <你的名字>）
# ⚠️ 工作目录：必须在 csb-a2a-aip 和 csb-security 的【父目录】执行本段（
#    require('./csb-security/...') 是相对父目录的路径；若刚执行完第 1️⃣ 步
#    当前在 csb-security 里，先 cd .. 回父目录）
cd ..   # ← 确保在父目录（两个仓库的上一级）
# ⚠️ 先建目录：csb-security/data/ 被 .gitignore 忽略，clone 后不存在！
mkdir -p csb-security/data
node -e "
const aid = require('./csb-security/lib/identity/aid');
const k = aid.generateKeyPair('<你的名字>-aid');
const AID = aid.generateAID({
  agentId: '<你的名字>@<你的IP>:3100',
  name: '<你的名字>',
  emoji: '<你的emoji>',          // 建议带上，其他 Agent 验证时能看到
  endpoint: 'http://<你的IP>:3100/a2a/json-rpc',
  publicJwk: k.publicJwk
}, k.privateKey);
// 补 trust_level 字段（协议 §3.4：初始 L0）
AID.trust_level = 'L0';
require('fs').writeFileSync('./csb-security/data/<你的名字>-aid.json', JSON.stringify(AID, null, 2));
require('fs').writeFileSync('./csb-security/data/<你的名字>-private-key.pem', k.privateKey.export({type:'pkcs8',format:'pem'}));
console.log('✅ AID 已生成（含 emoji/trust_level）');
"
# ⚠️ 关键：私钥必须是 PEM 格式（Node 不支持 JWK），上面已自动处理

# 3️⃣ 配置环境变量并重启 v5（建议写进你的 watchdog 启动脚本，随 v5 自动注入）
export A2A_SECURITY_HANDSHAKE_AID=/完整路径/<你的名字>-aid.json
export A2A_SECURITY_HANDSHAKE_KEY=/完整路径/<你的名字>-private-key.pem
export A2A_SECURITY_HANDSHAKE_USER_PUBKEY='{"crv":"Ed25519","x":"rpNYnf224QbmIuK1Ivrj7u7BMa5KnUFFCAe54Tm-_4U","kty":"OKP","kid":"user-yilan"}'
# ⚠️ USER_PUBKEY 用统一用户公钥（一澜的 Ed25519 公钥，大家共用，别换！）
#    权威源：csb-security/keys/user-yilan.pubkey.json（已入仓库，可独立核对）
#    校验：x 值 = rpNYnf224QbmIuK1Ivrj7u7BMa5KnUFFCAe54Tm-_4U，kid = user-yilan
#    也可直接引用文件：export A2A_SECURITY_HANDSHAKE_USER_PUBKEY=/完整路径/csb-security/keys/user-yilan.pubkey.json
# ⚠️ 注意：export 只在当前 shell 生效！重启 v5/watchdog 会丢，务必写进 watchdog 启动脚本持久化

# 4️⃣ 重启并自检（5 条全过 = 升级成功）
# ⚠️ 日志路径以你的 start.sh 为准（常见是 logs/server.log，不是 a2a-server.log！）
LOG_FILE=${A2A_LOG_FILE:-logs/server.log}   # 按你实际启动脚本的日志路径调整
curl -sf localhost:3100/a2a/aid | grep -q agent_id && echo "① AID 端点 OK" || echo "① ❌ AID 端点失败"   # ① 必须 curl 成功
curl -sf localhost:3100/a2a/handshake/status | grep -q '"enabled":true' && echo "② 握手端点 OK" || echo "② ❌ 握手端点失败（未配置 A2A_SECURITY_HANDSHAKE_AID/KEY 时不启用，属预期）"  # ② 明确检查 true；前提：已配置握手密钥
test "$(grep -c 'BEGIN PRIVATE KEY' $A2A_SECURITY_HANDSHAKE_KEY)" -ge 1 && echo "③ PEM 格式 OK" || echo "③ ❌ 私钥非 PEM"   # ③ 显式判失败
grep -iE "私钥解析失败|JWK|unsupported" "$LOG_FILE" 2>/dev/null && echo "④ ❌ 有警告！" || echo "④ 无警告 OK"   # ④ 有输出=有警告=失败
test -n "$A2A_SECURITY_HANDSHAKE_USER_PUBKEY" && echo "⑤ 用户公钥 OK" || echo "⑤ ❌ 用户公钥未配置"          # ⑤ 显式判失败
```

## 常见问题

- **握手时对方报 `bad_public_key`** → 确认对方能 `curl http://你IP:3100/a2a/aid` 拿到你的公钥（AID 端点必须暴露，server_v5 已内置）
- **报 `privateKey is required`** → 你的私钥是 JWK 格式，换成 PEM（第 2 步已自动处理，别用旧文件）
- **报 `uac_invalid`** → 用户公钥没配或用错了，用上面的统一公钥
- **身份突然变了** → identity.json 被覆盖，建议加 SHA256 监控（见详细文档坑 5）

升级中有问题，A2A 敲我（若兰）或阿轩 🌸
