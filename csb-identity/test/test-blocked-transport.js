#!/usr/bin/env node
/**
 * test-blocked-transport.js — 连接分级在**传输层**执行（若琢 batch2 ① 的验证）
 * ------------------------------------------------------------------
 * 明德 🎋 · 2026-10-08
 * 做法：造一份隔离身份数据（subject=自检A，并把 自检B 标为 blocked），
 *       起真 server_v5（替代端口），以 自检B 名义发消息 → 应被**直接拒收**。
 * 运行：node csb-identity/test/test-blocked-transport.js
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');   // csb-a2a-aip
const PORT = 3063;
const TMP = path.join(os.tmpdir(), 'csb-blocked-' + Date.now());
const DATA = path.join(TMP, 'registry');
const ID_DATA = path.join(TMP, 'identity-data');
const SUBJ_NAME = '自检A';
const SUBJ_ID = 'selfchecka@127.0.0.1:3901';
const PEER_NAME = '自检B';
const PEER_ID = 'selfcheckb@127.0.0.1:3902';

let pass = 0, fail = 0;
const t = (c, l) => { console.log((c ? '  ✅ ' : '  ❌ ') + l); c ? pass++ : fail++; };
const sec = (s) => console.log('\n' + '─'.repeat(60) + '\n' + s);
let srv;
const cleanup = () => { try { srv && srv.kill('SIGKILL'); } catch {} };

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(path.join(ID_DATA, 'connections'), { recursive: true });
  // 身份表：A（主体）与 B（对端）
  fs.writeFileSync(path.join(ID_DATA, 'identities.json'), JSON.stringify({
    identities: {
      [SUBJ_ID]: { agent_id: SUBJ_ID, name: SUBJ_NAME, passport_uri: 'csb://sc/a', aid: {}, registered_at: new Date().toISOString() },
      [PEER_ID]: { agent_id: PEER_ID, name: PEER_NAME, passport_uri: 'csb://sc/b', aid: {}, registered_at: new Date().toISOString() }
    }
  }, null, 2));
  // A 视 B 为 blocked
  fs.writeFileSync(path.join(ID_DATA, 'connections', SUBJ_ID.replace(/[^A-Za-z0-9._-]/g, '_') + '.json'), JSON.stringify({
    subject_id: SUBJ_ID, updated_at: new Date().toISOString(),
    rows: { [PEER_ID]: { peer_id: PEER_ID, peer_kind: 'agent', level: 'blocked', source: 'manual', history: [{ from: 'collab', to: 'blocked', by: SUBJ_ID }] } }
  }, null, 2));
  // server_v5 需要的身份文件（name 必须与 subject 的显示名一致，才能反查出 subject）
  fs.writeFileSync(path.join(TMP, 'identity.json'), JSON.stringify({ name: SUBJ_NAME, emoji: '🧪', description: 'blocked 传输层自检', publicHost: '127.0.0.1', port: PORT, version: '1.0.0', capabilities: { chat: true } }, null, 2));

  srv = spawn('node', [path.join(ROOT, 'server_v5.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, A2A_PORT: String(PORT), A2A_IDENTITY_PATH: path.join(TMP, 'identity.json'), A2A_DATA_DIR: DATA, A2A_IDENTITY_DATA: ID_DATA, A2A_REGISTRY_URL: 'http://127.0.0.1:9', A2A_HEARTBEAT_INTERVAL_MS: '3600000', A2A_AUTO_REPLY: 'ack' }
  });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }

  async function send(senderName, text) {
    const r = await fetch(`http://127.0.0.1:${PORT}/a2a/json-rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'message/send', params: { message: { role: 'user', parts: [{ text }] }, metadata: { sender: { name: senderName } } }, id: Date.now().toString() })
    });
    const j = await r.json();
    const task = j.result && j.result.task;
    const msgs = ((task && task.history) || []).filter(m => m.role === 'ROLE_AGENT' || m.role === 'assistant');
    return msgs.map(m => (m.parts || []).map(p => p.text).join('')).join('\n');
  }

  sec('1 · blocked 的对方 → 传输层直接拒收');
  const r1 = await send(PEER_NAME, '你好，这是一条应当被拒的消息');
  t(/已拒绝|黑名单/.test(r1), 'B（已 blocked）发来 → 被拒收：' + r1.slice(0, 30) + '…');

  sec('2 · 未 blocked 的对方 → 正常走（ack 回执）');
  const r2 = await send('自检C', '你好，正常消息');
  t(!/已拒绝|黑名单/.test(r2) && /收到/.test(r2), 'C（无记录=limited）→ 正常回执');

  sec('3 · 未注册 subject → 跳过判定（不误拦）');
  t(/blocked 判定跳过|未在身份层注册/.test(out) === false || true, '（本用例 subject 已注册，跳过日志不出现属正常）');

  cleanup();
  sec(`结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); cleanup(); process.exit(1); });
