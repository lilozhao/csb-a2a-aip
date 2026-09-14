// tests/p0-confirm-channel-20260914.js
// P0 验证（v2：真 HTTP mock gateway）：归一化匹配 + 时间窗 + 通道一致
// 用例：模拟墨白在飞书回"确认 #<taskId>"，confirm 读取能命中

const http = require('http');
const { confirmL3, resolveConfirmWindow } = require('../a2a-bridge-confirm.js');

let mockPort = null;
let mockServer = null;
let mockSessions = []; // 模拟的会话历史
let lastSentMessage = null;
let sentCount = 0;
let readCount = 0;

function startMockGateway() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (req.url === '/tools/invoke' && parsed.tool === 'message' && parsed.action === 'send') {
            sentCount++;
            lastSentMessage = parsed.args && parsed.args.message;
            console.log(`  [mock-gateway] SEND to=${parsed.args.to} preview=${(parsed.args.message || '').substring(0, 60).replace(/\n/g, ' ')}...`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, result: { sent: true, messageId: 'mock-send-' + sentCount } }));
            return;
          }
          if (req.url === '/tools/invoke' && parsed.tool === 'sessions_history') {
            readCount++;
            const limit = parsed.args && parsed.args.limit || 40;
            const sinceMs = parsed.args && parsed.args.sinceMs;
            // 过滤：时间戳 >= sinceMs 的消息
            const filtered = mockSessions.filter(m => {
              if (sinceMs == null) return true;
              const mts = m.timestamp || 0;
              return mts >= sinceMs;
            }).slice(-limit);
            console.log(`  [mock-gateway] READ #${readCount} sinceMs=${sinceMs} → 返回 ${filtered.length} 条（总 ${mockSessions.length}）`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, result: { messages: filtered } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not mock: ' + req.url + ' ' + JSON.stringify(parsed) }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      console.log(`  [mock-gateway] listening on 127.0.0.1:${mockPort}`);
      resolve();
    });
  });
}

function stopMockGateway() {
  return new Promise((resolve) => mockServer && mockServer.close(resolve));
}

function resetMock(sessions = []) {
  mockSessions = sessions.map(s => ({ timestamp: s.timestamp || Date.now(), role: s.role, content: s.content }));
  lastSentMessage = null;
  sentCount = 0;
  readCount = 0;
}

async function test1_normalize_match() {
  console.log('\n[test1_normalize_match] 墨白回"我 确 认 #tid"（带空格+标点）→ 归一化后应命中');
  resetMock([
    { timestamp: Date.now() + 100, role: 'user', content: '我 确 认 # test-task-123' },
  ]);

  const envelope = { scope: 'shell', timeoutMs: 200, body: 'echo test' };
  const result = await confirmL3(envelope,
    { taskId: 'test-task-123', sender: { name: '若兰', url: 'http://172.28.0.214:3100' } },
    { to: 'ou_test', pollIntervalMs: 50 });

  console.log('  result:', JSON.stringify(result, null, 2));
  return result.ok === true && result.by === '宿主用户';
}

async function test2_exact_match() {
  console.log('\n[test2_exact_match] 墨白回"确认 #tid"（无空格）→ 直接命中');
  resetMock([
    { timestamp: Date.now() + 100, role: 'user', content: '确认 #test-task-456' },
  ]);
  const envelope = { scope: 'shell', timeoutMs: 200, body: 'echo test' };
  const result = await confirmL3(envelope, { taskId: 'test-task-456', sender: { name: '若兰' } }, { to: 'ou_test', pollIntervalMs: 50 });
  console.log('  result:', JSON.stringify(result, null, 2));
  return result.ok === true;
}

async function test3_window_filter() {
  console.log('\n[test3_window_filter] 旧消息（10 分钟前，timestamp < sinceMs）→ 应被过滤');
  // 不放任何"近"的消息 → confirm 找不到 → 应超时/拒绝
  resetMock([
    { timestamp: Date.now() - 600000, role: 'user', content: '确认 #test-task-789' },
  ]);
  const envelope = { scope: 'shell', timeoutMs: 200, body: 'echo test' };
  const result = await confirmL3(envelope, { taskId: 'test-task-789', sender: { name: '若兰' } }, { to: 'ou_test', pollIntervalMs: 50 });
  console.log('  result:', JSON.stringify(result, null, 2));
  return result.ok === false;
}

async function test4_no_match_should_decline() {
  console.log('\n[test4_no_match_should_decline] 墨白回"我不确认" → 不应匹配');
  resetMock([
    { timestamp: Date.now() + 100, role: 'user', content: '我不确认，等下再说' },
  ]);
  const envelope = { scope: 'shell', timeoutMs: 200, body: 'echo test' };
  const result = await confirmL3(envelope, { taskId: 'test-task-decline', sender: { name: '若兰' } }, { to: 'ou_test', pollIntervalMs: 50 });
  console.log('  result:', JSON.stringify(result, null, 2));
  return result.ok === false;
}

(async () => {
  await startMockGateway();
  process.env.OPENCLAW_GATEWAY_URL = `http://127.0.0.1:${mockPort}`;
  process.env.A2A_GATEWAY_URL = `http://127.0.0.1:${mockPort}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
  process.env.A2A_GATEWAY_TOKEN = 'test-token';
  process.env.A2A_BRIDGE_MAIN_TO = 'ou_test';

  const results = [];
  try {
    results.push(['test1_normalize_match', await test1_normalize_match()]);
    results.push(['test2_exact_match', await test2_exact_match()]);
    results.push(['test3_window_filter', await test3_window_filter()]);
    results.push(['test4_no_match_should_decline', await test4_no_match_should_decline()]);
  } catch (e) {
    console.log('TEST ERROR:', e.message);
  }
  
  console.log('\n=== 总结 ===');
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  }
  const pass = results.filter(r => r[1]).length;
  console.log(`\n  P0 总计：${pass}/${results.length} 通过`);
  
  await stopMockGateway();
  process.exit(pass === results.length ? 0 : 1);
})();
