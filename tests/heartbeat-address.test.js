#!/usr/bin/env node
/**
 * heartbeat-address.test.js — 心跳必须能纠正「广播死地址」
 *
 * 起因（2026-10-26 真事故）：
 *   某实例被测试脚本以错误端口注册进生产注册表（真实两端口不一致），
 *   客户端心跳**一直带着正确的 host+port**，但 /heartbeat 只解构
 *   {name, version, platform} → host/port 被静默丢弃，
 *   于是错误地址在注册表里广播了 16 小时。
 *   症状：新邻居照名单来敲 → connection refused，双方都以为对方不理人。
 *
 * 锁死三个不变量：
 *   H1 同 host 仅 port 变化 → 自动纠正，并返回 addressDrift.action='corrected'
 *   H2 host 变化且无 admin token → 拒绝纠正（防合法劫持），返回 'rejected'
 *   H3 不带 host/port 的老客户端 → 行为不变，addressDrift=null
 *
 * 跑法：node --test tests/heartbeat-address.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3999;

function post(portNum, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: portNum, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(headers || {}) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function get(portNum, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: portNum, path: p }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

function startRegistry(dataDir, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['registry.js'], {
      cwd: ROOT,
      env: { ...process.env, REGISTRY_PORT: String(PORT), A2A_DATA_DIR: dataDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    const deadline = Date.now() + 12000;
    const poll = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, res => {
        res.resume();
        resolve({ proc, log: () => out });
      }).on('error', () => {
        if (Date.now() > deadline) { try { proc.kill('SIGKILL'); } catch {} reject(new Error('registry 启动超时: ' + out.slice(-300))); }
        else setTimeout(poll, 250);
      });
    };
    poll();
  });
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-hb-'));
  const inst = await startRegistry(dir, {});
  // 种子：一个 agent，地址 host=10.0.0.1 port=1111
  await post(PORT, '/register', { name: '测试员', host: '10.0.0.1', port: 1111, version: '1.0.0' });
  return { dir, inst };
}

test('H1: 同 host 仅端口变化 → 自动纠正', async () => {
  const { dir, inst } = await setup();
  try {
    const r = await post(PORT, '/heartbeat', { name: '测试员', host: '10.0.0.1', port: 2222 });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.addressDrift, '必须返回 addressDrift（调用方不必猜）');
    assert.strictEqual(r.body.addressDrift.action, 'corrected');
    const a = (await get(PORT, '/agents')).agents.find(x => x.name === '测试员');
    assert.strictEqual(a.port, 2222, '心跳带了正确端口，注册表必须采纳');
    assert.strictEqual(a.url, 'http://10.0.0.1:2222', 'url 必须跟着重建');
    assert.ok(a.addressHistory && a.addressHistory.length === 1, '纠正要记账');
  } finally { inst.proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('H2: host 变化且无 admin token → 拒绝纠正（防劫持）', async () => {
  const { dir, inst } = await setup();
  try {
    const r = await post(PORT, '/heartbeat', { name: '测试员', host: '6.6.6.6', port: 1111 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.addressDrift.action, 'rejected');
    const a = (await get(PORT, '/agents')).agents.find(x => x.name === '测试员');
    assert.strictEqual(a.host, '10.0.0.1', '无 token 不许改 host');
  } finally { inst.proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('H2b: host 变化 + 正确 admin token → 允许', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-hb2-'));
  const inst = await startRegistry(dir, { REGISTRY_ADMIN_TOKEN: 'tok-abc' });
  try {
    await post(PORT, '/register', { name: '测试员', host: '10.0.0.1', port: 1111 });
    const r = await post(PORT, '/heartbeat',
      { name: '测试员', host: '10.0.0.9', port: 1111 },
      { 'X-Admin-Token': 'tok-abc' });
    assert.strictEqual(r.body.addressDrift.action, 'corrected');
    const a = (await get(PORT, '/agents')).agents.find(x => x.name === '测试员');
    assert.strictEqual(a.host, '10.0.0.9');
  } finally { inst.proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('H3: 老客户端不带 host/port → 行为不变', async () => {
  const { dir, inst } = await setup();
  try {
    const r = await post(PORT, '/heartbeat', { name: '测试员', version: '1.0.1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.addressDrift, null);
    const a = (await get(PORT, '/agents')).agents.find(x => x.name === '测试员');
    assert.strictEqual(a.host, '10.0.0.1');
    assert.strictEqual(a.port, 1111);
    assert.strictEqual(a.version, '1.0.1', 'version 仍要更新');
  } finally { inst.proc.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});
