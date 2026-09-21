/**
 * A2A 远程命令客户端（HMAC 签名版）
 * 用法: node remote-command/client.js <目标URL> <命令JSON> [senderName]
 *
 * 示例:
 *   node remote-command/client.js http://172.28.0.144:3100 '{"type":"system.status"}'
 *   node remote-command/client.js http://172.28.0.144:3100 '{"type":"skill.list"}' '若琢'
 */

'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const SECRET = process.env.A2A_SHARED_SECRET;
if (!SECRET) {
  console.error('❌ A2A_SHARED_SECRET 未设置');
  process.exit(1);
}

const [,, targetUrl, cmdJson, senderName = '若琢'] = process.argv;
if (!targetUrl || !cmdJson) {
  console.error('用法: node client.js <目标URL> <命令JSON> [senderName]');
  process.exit(1);
}

function randomNonce() { return crypto.randomBytes(16).toString('hex'); }

function signRequest(command, sender, timestamp, nonce) {
  const payload = JSON.stringify({ command, sender, timestamp, nonce });
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function send(targetUrl, command, senderName) {
  const timestamp = Date.now();
  const nonce = randomNonce();
  const sender = { name: senderName };
  const signature = signRequest(command, sender, timestamp, nonce);

  // 把 sig/ts/nonce 嵌入 CMD JSON
  const cmdWithSig = { ...command, sig: signature, ts: timestamp, nonce };
  const text = `CMD: ${JSON.stringify(cmdWithSig)}`;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'SendMessage',
    id: `cmd-${timestamp}`,
    params: {
      sender: { name: senderName, url: `http://self:3100` },
      message: {
        role: 'user',
        messageId: `msg-${timestamp}`,
        parts: [{ type: 'text', text }]
      }
    }
  });

  const transport = targetUrl.startsWith('https') ? https : http;
  const parsed = new URL(targetUrl);
  const reqOpts = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: '/a2a/json-rpc',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };

  console.log(`📤 发送命令 ${command.type} → ${targetUrl}`);
  const t0 = Date.now();

  const req = transport.request(reqOpts, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      try {
        const j = JSON.parse(data);
        const h = j.result?.task?.history || [];
        const agentReply = h.filter(x => x.role !== 'user').pop();
        const text = agentReply?.parts?.[0]?.text || '';
        if (text.startsWith('CMD_RESULT:')) {
          const result = JSON.parse(text.slice(10));
          console.log(`✅ 命令完成 (${elapsed}s):`);
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`⚠️  收到非命令回复 (${elapsed}s):`);
          console.log(text.slice(0, 300));
        }
      } catch (e) {
        console.log(`⚠️  原始回复 (${elapsed}s):`);
        console.log(data.slice(0, 400));
      }
    });
  });
  req.on('error', e => console.error('❌ 请求失败:', e.message));
  req.write(body);
  req.end();
}

send(targetUrl, JSON.parse(cmdJson), senderName);
