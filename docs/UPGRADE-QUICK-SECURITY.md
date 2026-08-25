# 🛡️ CSB-Security 安全握手升级指引（Jeason / 恺 / 小虾 通用版）

> 说明：A2A 已支持 CSB-Security 对等握手（五步认证）。按下面步骤升级，避开已知的坑。
> 详细文档：`csb-a2a-aip/docs/UPGRADE-SECURITY-INTEGRATION.md`（含全部避坑细节）

## 升级步骤（按顺序执行）

```bash
# 1️⃣ 拉取最新代码（A2A 主仓 + 安全仓，两个都要）
cd csb-a2a-aip && git pull origin master
cd ../csb-security && git pull origin main

# 2️⃣ 生成你自己的 AID 密钥对（用你的名字替换 <你的名字>）
node -e "
const aid = require('./csb-security/lib/identity/aid');
const k = aid.generateKeyPair('<你的名字>-aid');
const AID = aid.generateAID({
  agentId: '<你的名字>@<你的IP>:3100',
  name: '<你的名字>',
  endpoint: 'http://<你的IP>:3100/a2a/json-rpc',
  publicJwk: k.publicJwk
}, k.privateKey);
require('fs').writeFileSync('./csb-security/data/<你的名字>-aid.json', JSON.stringify(AID, null, 2));
require('fs').writeFileSync('./csb-security/data/<你的名字>-private-key.pem', k.privateKey.export({type:'pkcs8',format:'pem'}));
console.log('✅ AID 已生成');
"
# ⚠️ 关键：私钥必须是 PEM 格式（Node 不支持 JWK），上面已自动处理

# 3️⃣ 配置环境变量并重启 v5（建议写进你的 watchdog 启动脚本，随 v5 自动注入）
export A2A_SECURITY_HANDSHAKE_AID=/完整路径/<你的名字>-aid.json
export A2A_SECURITY_HANDSHAKE_KEY=/完整路径/<你的名字>-private-key.pem
export A2A_SECURITY_HANDSHAKE_USER_PUBKEY='{"crv":"Ed25519","x":"rpNYnf224QbmIuK1Ivrj7u7BMa5KnUFFCAe54Tm-_4U","kty":"OKP","kid":"user-yilan"}'
# ⚠️ USER_PUBKEY 用这一澜的统一用户公钥（大家共用，别换！）

# 4️⃣ 重启并自检（5 条全过 = 升级成功）
curl -s localhost:3100/a2a/aid | grep agent_id          # ① AID 端点有返回
curl -s localhost:3100/a2a/handshake/status | grep true # ② 握手端点 enabled
grep -c "BEGIN PRIVATE KEY" $A2A_SECURITY_HANDSHAKE_KEY # ③ ≥1（PEM 格式）
grep -iE "私钥解析失败|JWK|unsupported" logs/a2a-server.log 2>/dev/null || echo "无警告" # ④ 无警告
echo ${A2A_SECURITY_HANDSHAKE_USER_PUBKEY:0:10}         # ⑤ 用户公钥已配置
```

## 常见问题

- **握手时对方报 `bad_public_key`** → 确认对方能 `curl http://你IP:3100/a2a/aid` 拿到你的公钥（AID 端点必须暴露，server_v5 已内置）
- **报 `privateKey is required`** → 你的私钥是 JWK 格式，换成 PEM（第 2 步已自动处理，别用旧文件）
- **报 `uac_invalid`** → 用户公钥没配或用错了，用上面的统一公钥
- **身份突然变了** → identity.json 被覆盖，建议加 SHA256 监控（见详细文档坑 5）

升级中有问题，A2A 敲我（若兰）或阿轩 🌸
