/**
 * AAT 回环自测（美硅本地）：给本机发一条带 AAT 签名的消息，
 * 验证 TrustBridge 是否给出 L2（source: aat）。
 * 用法：node scripts/aat-loopback-test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const aat = require(path.join(ROOT, 'a2a-aat.js'));
const http = require('http');

const self = aat.getSelf();
if (!self.ok) { console.error('❌ 本机身份不可用:', self.reason); process.exit(1); }

const sender = aat.attach(
  { name: '美硅', url: 'http://localhost:3100', id: self.agentId },
  self.agentId,
  { capabilities: ['a2a:send'] }
);
if (!sender.aat) { console.error('❌ 签名失败:', sender._aatError); process.exit(1); }

const payload = JSON.stringify({
  jsonrpc: '2.0', method: 'message/send', id: 'aat-loopback-1',
  params: {
    // 注意：服务端从 params.sender 取发送方（不是 params.message.sender）
    sender,
    message: { role: 'user', parts: [{ type: 'text', text: 'AAT 回环自测：这条消息带密码学签名' }], messageId: 'msg-aat-loopback' },
  },
});

const req = http.request({
  hostname: '127.0.0.1', port: 3100, path: '/a2a/json-rpc', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
}, (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => {
    try {
      const j = JSON.parse(body);
      const task = j.result?.task || {};
      const hist = task.history || [];
      const last = hist[hist.length - 1];
      console.log('HTTP', res.statusCode, '| 任务状态:', task.status?.state);
      console.log('回复:', String(last?.parts?.[0]?.text || '').slice(0, 120).replace(/\n/g, ' '));
      console.log('判据：日志里应出现 [TrustBridge] ✅ AAT 签名验证通过 → L2');
    } catch (e) {
      console.log('原始响应:', body.slice(0, 300));
    }
  });
});
req.on('error', (e) => console.error('请求失败:', e.message));
req.write(payload);
req.end();
