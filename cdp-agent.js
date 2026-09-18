#!/usr/bin/env node
/**
 * cdp-agent.js — CDP v0.1 参考实现（CSB Discovery Protocol）
 * ============================================================
 * 场景：一台 CSB-A2A 智能体进入「陌生局域网」，零配置自助入网。
 *
 * 四步（见 docs/cdp-发现协议-v0.1.md）：
 *   ① 出场广播（自定义 UDP :3098，零依赖）
 *   ② 应答发现（csb.here → 拿到注册表地址）
 *   ③ 兜底扫描（:3099 找注册表；无注册表则扫 :3100–3199 找对端）
 *   ④ 注册 + 握手
 *
 * 约定端口：
 *   3098/udp  CDP 广播探询口
 *   3099      注册表（一网一个）
 *   3100      Agent 默认口（回退 3101–3199）
 *
 * 子命令：
 *   discover            探询 + 扫描，只读地列出网内的注册表与 Agent
 *   probe               只做 UDP 广播探询
 *   scan                只做端口扫描（--ports 3099,3100-3199）
 *   port                在本机找一个空闲的 Agent 口（回退规则）
 *   join                完整入网：发现注册表 → 查重 → 注册 → 握手
 *   serve               跑 UDP :3098 应答器（让本机可被他人发现）
 *
 * 常用参数：
 *   --name <名> --port <口> --host <IP> --subnet <CIDR> --registry <url>
 *   --timeout <ms>       UDP 应答等待（默认 1000）
 *   --scan-timeout <ms>  TCP 探测超时（默认 250）
 *   --dry                只演练，不发注册
 *   --json               机器可读输出
 *   --full-handshake     尝试 CSB-Security 五步握手（需 csb-security + 密钥）
 *
 * 维护：若兰 🌸 ｜ 2026-09-19 ｜ 归属 csb-a2a-aip
 */
'use strict';

const os = require('os');
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================
// 常量（CDP v0.1）
// ============================================================
const CDP_VERSION = '1.0';
const UDP_PORT = 3098;            // 广播探询口
const REGISTRY_PORT = 3099;       // 注册表
const AGENT_PORT_DEFAULT = 3100;  // Agent 默认口
const AGENT_PORT_END = 3199;      // 回退上限
const SCAN_CONCURRENCY = 256;

const C = {
  r: s => `\x1b[31m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  c: s => `\x1b[36m${s}\x1b[0m`,
  d: s => `\x1b[2m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const ok = s => log(`   ${C.g('✅')} ${s}`);
const warn = s => log(`   ${C.y('⚠️')} ${s}`);
const err = s => log(`   ${C.r('❌')} ${s}`);

// ============================================================
// 工具
// ============================================================
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function httpGetJson(url, timeout = 3000) {
  return new Promise(resolve => {
    let req;
    try { req = http.get(url, { timeout }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(b); } catch { body = null; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body, raw: b });
      });
    }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function httpPostJson(url, body, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    let req;
    try { req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch { /* keep null */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: j, raw: b });
      });
    }); } catch (e) { return reject(e); }
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function tcpProbe(host, port, timeout = 250) {
  return new Promise(resolve => {
    let done = false;
    const sock = net.connect({ host, port });
    const fin = v => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeout);
    sock.on('connect', () => fin(true));
    sock.on('timeout', () => fin(false));
    sock.on('error', () => fin(false));
  });
}

function canBind(port, host = '0.0.0.0') {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      ret[idx] = await fn(items[idx], idx);
    }
  }));
  return ret;
}

// ---- IP 工具 ----
const ipToInt = ip => ip.split('.').reduce((s, o) => ((s << 8) + parseInt(o, 10)) >>> 0, 0);
const intToIp = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const calcBroadcast = (ip, mask) => intToIp(((ipToInt(ip) | (~ipToInt(mask) >>> 0)) >>> 0));
const same24 = (a, b) => a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');

function localInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({ name, address: a.address, netmask: a.netmask, broadcast: calcBroadcast(a.address, a.netmask) });
      }
    }
  }
  return out;
}

function firstLocalIPv4() {
  const i = localInterfaces();
  return i.length ? i[0].address : '127.0.0.1';
}

// 枚举 /24 内除自己以外的 host（默认策略：扫本网段）
function hosts24(selfIp) {
  const base = selfIp.split('.').slice(0, 3).join('.');
  const hosts = [];
  for (let n = 1; n <= 254; n++) {
    const ip = `${base}.${n}`;
    if (ip !== selfIp) hosts.push(ip);
  }
  return hosts;
}

function parseCidr(cidr) {
  // 支持 172.28.0.0/24（> /24 一律按 /24 处理，避免全段扫）
  const [base, bitsStr] = cidr.split('/');
  if (!base) return [];
  const bits = parseInt(bitsStr || '24', 10);
  const size = bits <= 24 ? 256 : Math.pow(2, 32 - bits);
  if (size > 256) { // 收窄到 /24
    return hosts24(base);
  }
  const start = ipToInt(base);
  const hosts = [];
  for (let n = 0; n < size; n++) hosts.push(intToIp(start + n));
  return hosts.filter(h => h !== firstLocalIPv4());
}

// ============================================================
// 身份 / 配置
// ============================================================
function loadIdentity() {
  const id = readJsonSafe(path.join(__dirname, 'identity.json')) || {};
  const cfg = readJsonSafe(path.join(__dirname, 'config', 'agents.json')) || {};
  const self = cfg.self || {};
  const name = process.env.CDP_NAME || id.name || self.name || 'unnamed';
  const host = process.env.CDP_HOST || id.publicHost || self.host || firstLocalIPv4();
  const port = parseInt(process.env.CDP_PORT || id.port || self.port || AGENT_PORT_DEFAULT, 10);
  const registrySeed = process.env.CDP_REGISTRY
    || (cfg.registry && (cfg.registry.local || cfg.registry.public)) || null;
  return {
    name,
    emoji: id.emoji || self.emoji || '🤖',
    description: id.description || '',
    version: id.version || '1.0.0',
    platform: id.platform || 'openclaw',
    capabilities: id.capabilities || {},
    host,
    port,
    agentId: `${name}@${host}:${port}`,
    registrySeed,
  };
}

// ============================================================
// ① 出场广播 + 应答器
// ============================================================
function cdpProbe({ self, interfaces, timeoutMs = 1000, tries = 3, intervalMs = 300, targets: customTargets = null }) {
  return new Promise(resolve => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString());
        if (j && (j.type === 'csb.here')) {
          const key = (j.registry && j.registry.host) ? `${j.registry.host}:${j.registry.port}` : rinfo.address;
          found.set(key, { ...j, from: rinfo.address });
        }
      } catch { /* 忽略非 CDP 报文 */ }
    });
    sock.on('error', () => {});
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      const payload = Buffer.from(JSON.stringify({
        cdp: CDP_VERSION, type: 'csb.probe',
        from: { name: self.name, host: self.host, port: self.port, version: self.version, agentId: self.agentId },
      }));
      const useCustom = Array.isArray(customTargets) && customTargets.length > 0;
      const targets = new Set(useCustom ? customTargets : ['255.255.255.255']);
      if (!useCustom) interfaces.forEach(i => i.broadcast && targets.add(i.broadcast));

      let sent = 0;
      const send = () => {
        let remaining = targets.size;
        for (const t of targets) {
          sock.send(payload, 0, payload.length, UDP_PORT, t, () => {
            if (--remaining === 0 && ++sent < tries) setTimeout(send, intervalMs);
          });
        }
      };
      send();
      setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, tries * intervalMs + timeoutMs);
    });
  });
}

// 跑一个 UDP :3098 应答器（让别的 Agent 能发现本机）
function serveResponder({ self, registry, onProbe }) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let j = null; try { j = JSON.parse(msg.toString()); } catch {}
    if (!j || j.type !== 'csb.probe') return;
    onProbe && onProbe(j, rinfo);
    const reply = Buffer.from(JSON.stringify({
      cdp: CDP_VERSION, type: 'csb.here',
      registry: registry ? { host: registry.host, port: registry.port } : null,
      self: { name: self.name, host: self.host, port: self.port, version: self.version, agentId: self.agentId },
    }));
    sock.send(reply, 0, reply.length, rinfo.port, rinfo.address, () => {});
  });
  sock.on('error', e => err(`应答器错误: ${e.message}`));
  return new Promise(resolve => {
    sock.bind(UDP_PORT, () => {
      ok(`CDP 应答器已就绪：UDP ${UDP_PORT}（我等别人来问）`);
      resolve(sock);
    });
  });
}

// ============================================================
// ③ 扫描
// ============================================================
async function scanRegistry(hosts, timeout) {
  const res = await mapLimit(hosts, SCAN_CONCURRENCY, h => tcpProbe(h, REGISTRY_PORT, timeout));
  return hosts.filter((_, i) => res[i]);
}

async function scanAgentPorts(hosts, ports, timeout) {
  const tasks = [];
  for (const h of hosts) for (const p of ports) tasks.push([h, p]);
  const res = await mapLimit(tasks, SCAN_CONCURRENCY, ([h, p]) => tcpProbe(h, p, timeout));
  return tasks.filter((_, i) => res[i]).map(([host, port]) => ({ host, port }));
}

function expandPorts(spec) {
  // "3099,3100-3199" → [3099,3100,...,3199]
  const out = [];
  for (const seg of String(spec).split(',')) {
    const m = seg.trim().match(/^(\d+)-(\d+)$/);
    if (m) { for (let p = +m[1]; p <= +m[2]; p++) out.push(p); }
    else if (/^\d+$/.test(seg.trim())) out.push(+seg.trim());
  }
  return out;
}

// ============================================================
// ④ 注册表交互
// ============================================================
async function listAgents(registryUrl) {
  const r = await httpGetJson(registryUrl.replace(/\/$/, '') + '/agents', 4000);
  if (!r.ok || !r.body || !Array.isArray(r.body.agents)) return null;
  return r.body.agents;
}

async function checkConflict(registryUrl, self) {
  const agents = await listAgents(registryUrl);
  if (!agents) return { ok: false, error: '注册表不可读' };
  const dupName = agents.find(a => a.name === self.name);
  const dupAddr = agents.find(a => a.host === self.host && Number(a.port) === Number(self.port));
  // 同名但不同地址 → 拒绝（fail loud）
  if (dupName && !(dupName.host === self.host && Number(dupName.port) === Number(self.port))) {
    return { ok: false, error: `重名：'${self.name}' 已被 ${dupName.host}:${dupName.port} 占用` };
  }
  // 同地址但不同名 → 拒绝
  if (dupAddr && dupAddr.name !== self.name) {
    return { ok: false, error: `地址冲突：${self.host}:${self.port} 已被 '${dupAddr.name}' 占用` };
  }
  return { ok: true, idempotent: !!(dupName && dupAddr) };
}

async function registerTo(registryUrl, self) {
  const body = {
    name: self.name, host: self.host, port: self.port,
    version: self.version, platform: self.platform,
    description: self.description, capabilities: self.capabilities,
  };
  return httpPostJson(registryUrl.replace(/\/$/, '') + '/register', body, 5000);
}

// ============================================================
// 握手（发现 ≠ 信任）
// ============================================================
async function aidExchange(agentBaseUrl) {
  const base = agentBaseUrl.replace(/\/$/, '');
  const r = await httpGetJson(base + '/a2a/aid', 4000);
  if (r.ok && r.body) {
    return { ok: true, agentId: r.body.agent_id || r.body.agentId || null, idOnly: true };
  }
  const h = await httpGetJson(base + '/health', 4000);
  if (h.ok) return { ok: true, viaHealth: true, idOnly: true };
  return { ok: false, error: r.error || '不可达' };
}

async function fullHandshake() {
  // 完整五步握手需 csb-security + 本机密钥；缺失时由调用方降级到 AID 交换。
  try {
    const csb = require('../csb-security/lib/index.js');
    if (!csb || !csb.HandshakeManager) throw new Error('csb-security 不可用');
    return { ok: false, supported: true, error: '需配置 A2A_SECURITY_HANDSHAKE_AID/KEY 与 UAC；v0.1 暂降级 AID 交换' };
  } catch (e) {
    return { ok: false, supported: false, error: e.message };
  }
}

// ============================================================
// 子命令
// ============================================================
function resolveHosts(args, self) {
  if (args.subnet) return parseCidr(String(args.subnet));
  if (args.hosts) return String(args.hosts).split(',').map(s => s.trim()).filter(Boolean);
  return hosts24(self.host);
}

async function cmdProbe(args) {
  const self = loadIdentity();
  const ifaces = localInterfaces();
  log(`${C.c('① UDP 广播探询')} → :${UDP_PORT}（广播在 Docker 网桥内通常无人应答，属预期）`);
  const found = await cdpProbe({
    self, interfaces: ifaces, timeoutMs: +args.timeout || 1000,
    targets: args.targets ? String(args.targets).split(',').map(s => s.trim()) : null,
  });
  if (!found.length) { warn('无应答'); return found; }
  found.forEach(f => ok(`应答来自 ${f.from} → 注册表 ${f.registry ? `${f.registry.host}:${f.registry.port}` : '未声明'}`));
  return found;
}

async function cmdScan(args) {
  const self = loadIdentity();
  const hosts = resolveHosts(args, self);
  const ports = args.ports ? expandPorts(args.ports) : [REGISTRY_PORT];
  const to = +args['scan-timeout'] || 250;
  log(`${C.c('③ 端口扫描')} ${hosts.length} 台 × ${ports.length} 口（超时 ${to}ms）`);
  const hits = args.ports && !ports.includes(REGISTRY_PORT)
    ? await scanAgentPorts(hosts, ports, to)
    : (await scanRegistry(hosts, to)).map(h => ({ host: h, port: REGISTRY_PORT }));
  if (!hits.length) warn('无命中');
  hits.forEach(h => ok(`${h.host}:${h.port}`));
  return hits;
}

async function cmdPort(args) {
  const host = args.host || loadIdentity().host;
  const start = +args.start || AGENT_PORT_DEFAULT;
  const end = +args.end || AGENT_PORT_END;
  log(`${C.c('端口回退')}：在 ${host} 找空闲 Agent 口（${start}–${end}）`);
  for (let p = start; p <= end; p++) {
    if (await canBind(p)) { ok(`可用口：${p}`); return p; }
  }
  err(`区间内无空闲口（${start}–${end}）→ fail loud，请显式指定端口`);
  return null;
}

async function cmdDiscover(args) {
  const self = loadIdentity();
  const to = +args['scan-timeout'] || 250;
  const ifaces = localInterfaces();
  const hosts = resolveHosts(args, self);
  log(`${C.c('CDP discover')} — 本机 ${self.host}（${self.name}）｜ 网段候选 ${hosts.length} 台\n`);

  // ① 广播
  log(`${C.c('① 出场广播')} UDP :${UDP_PORT}`);
  const replies = await cdpProbe({ self, interfaces: ifaces, timeoutMs: +args.timeout || 1000 });
  replies.length ? replies.forEach(r => ok(`广播应答 ← ${r.from}`)) : warn('广播无应答（Docker 网桥内预期如此，转扫描）');

  // ② 扫描注册表
  log(`\n${C.c('② 扫描注册表')} :${REGISTRY_PORT}`);
  const regs = await scanRegistry(hosts, to);
  regs.length ? regs.forEach(r => ok(`注册表候选 http://${r}:${REGISTRY_PORT}`)) : warn('未发现注册表');

  // ③ 若有注册表 → 直接读全量；否则扫 Agent 口
  let agents = [];
  if (regs.length) {
    log(`\n${C.c('③ 读注册表')} GET /agents`);
    for (const r of regs) {
      const list = await listAgents(`http://${r}:${REGISTRY_PORT}`);
      if (list) { agents = list; ok(`http://${r}:${REGISTRY_PORT} → ${list.length} 个 Agent`); break; }
    }
  } else {
    log(`\n${C.c('③ 兜底扫描')} :${AGENT_PORT_DEFAULT}–${AGENT_PORT_END}`);
    const hits = await scanAgentPorts(hosts, [...Array(AGENT_PORT_END - AGENT_PORT_DEFAULT + 1)].map((_, i) => AGENT_PORT_DEFAULT + i), to);
    agents = hits.map(h => ({ name: '(未登记)', host: h.host, port: h.port }));
    hits.forEach(h => ok(`${h.host}:${h.port}`));
  }

  // 输出
  log(`\n${C.c('发现结果')}`);
  if (args.json) {
    log(JSON.stringify({ cdp: CDP_VERSION, self: self.agentId, registries: regs.map(r => `http://${r}:${REGISTRY_PORT}`), agents }, null, 2));
  } else if (agents.length) {
    log(`   ${'名称'.padEnd(12)} ${'地址'.padEnd(24)} 状态`);
    for (const a of agents) {
      const url = `http://${a.host}:${a.port}`;
      log(`   ${String(a.name).padEnd(12)} ${`${a.host}:${a.port}`.padEnd(24)} ${C.g('在线')}`);
    }
  } else {
    warn('网内未发现任何 Agent');
  }
  return { registries: regs, agents };
}

async function cmdJoin(args) {
  const self = loadIdentity();
  if (args.port) self.port = +args.port;
  if (args.name) self.name = String(args.name);
  if (args.host) self.host = String(args.host);
  self.agentId = `${self.name}@${self.host}:${self.port}`;

  log(`${C.c('CDP join')} — ${self.agentId}\n`);
  const ifaces = localInterfaces();
  const hosts = resolveHosts(args, self);

  // ① 广播找注册表
  log(`${C.c('① 出场广播')}`);
  const replies = await cdpProbe({ self, interfaces: ifaces, timeoutMs: +args.timeout || 1000 });
  let registryUrl = null;
  for (const r of replies) if (r.registry && r.registry.host) { registryUrl = `http://${r.registry.host}:${r.registry.port}`; break; }
  if (registryUrl) ok(`广播发现注册表：${registryUrl}`);

  // ② 扫描兜底
  if (!registryUrl) {
    log(`${C.c('② 扫描注册表')}`);
    const regs = await scanRegistry(hosts, +args['scan-timeout'] || 250);
    if (regs.length) { registryUrl = `http://${regs[0]}:${REGISTRY_PORT}`; ok(`扫描发现注册表：${registryUrl}`); }
  }
  // ③ 回退到配置种子
  if (!registryUrl && self.registrySeed) { registryUrl = self.registrySeed; warn(`回退到配置种子：${registryUrl}`); }

  if (!registryUrl) {
    // 无注册表 → 点对点模式
    warn('未发现注册表 → 进入点对点直连模式（扫 :3100–3199）');
    const hits = await scanAgentPorts(hosts, [...Array(100)].map((_, i) => AGENT_PORT_DEFAULT + i), +args['scan-timeout'] || 250);
    log(`\n${C.c('对端')}：${hits.length} 个`);
    for (const h of hits.slice(0, 20)) {
      const hs = await aidExchange(`http://${h.host}:${h.port}`);
      ok(`${h.host}:${h.port} → ${hs.ok ? '握手(AID) OK' : C.y('不可达')}`);
    }
    return { mode: 'p2p', peers: hits };
  }

  // ④ 查重
  log(`${C.c('④ 查重')}`);
  const cc = await checkConflict(registryUrl, self);
  if (!cc.ok) { err(cc.error); process.exitCode = 2; return { ok: false, error: cc.error }; }
  cc.idempotent ? ok('同名同址 → 幂等更新（允许）') : ok('无冲突');

  // ⑤ 注册
  if (args.dry) { warn('--dry：跳过实际注册'); }
  else {
    log(`${C.c('⑤ 注册')} POST ${registryUrl}/register`);
    const r = await registerTo(registryUrl, self);
    if (!r.ok) { err(`注册失败 HTTP ${r.status}: ${r.raw && r.raw.slice(0, 160)}`); process.exitCode = 3; return { ok: false }; }
    ok(`已注册（注册表共 ${r.body.totalAgents} 个 Agent，待投递消息 ${r.body.pendingMessages}）`);
  }

  // ⑥ 与对端握手（证明「发现 ≠ 信任」）
  log(`${C.c('⑥ 握手')}`);
  const agents = (await listAgents(registryUrl)) || [];
  const peer = agents.find(a => !(a.host === self.host && Number(a.port) === Number(self.port)));
  if (args['full-handshake']) {
    const fh = await fullHandshake();
    fh.supported ? warn(`完整握手：${fh.error}`) : warn(`完整握手不可用（${fh.error}）→ 降级 AID 交换`);
  }
  if (peer) {
    const hs = await aidExchange(`http://${peer.host}:${peer.port}`);
    hs.ok ? ok(`AID 交换 OK ← ${peer.name} (${hs.agentId || 'health'})`) : warn(`对端 ${peer.name} 握手失败：${hs.error}`);
  } else warn('网内暂无其他对端可握手');

  log(`\n${C.g('入网完成')} 🌸 ${self.agentId} → ${registryUrl}`);
  return { ok: true, registry: registryUrl, self: self.agentId };
}

// ============================================================
// CLI
// ============================================================
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const USAGE = `
CDP v0.1 — CSB Discovery Protocol（新局域网自助入网）🌐

用法: node cdp-agent.js <命令> [参数]

命令:
  discover   探询 + 扫描（只读），列出网内注册表与 Agent
  probe      只做 UDP 广播探询
  scan       只做端口扫描        [--ports 3099,3100-3199] [--subnet CIDR]
  port       找一个空闲 Agent 口  [--start 3100] [--end 3199]
  join       完整入网: 发现→查重→注册→握手  [--dry] [--full-handshake]
  serve      跑 UDP :3098 应答器（本机可被他人发现）

通用: --name --port --host --subnet <CIDR> --registry <url>
      --timeout <ms> --scan-timeout <ms> --json
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] || 'discover';
  switch (cmd) {
    case 'discover': await cmdDiscover(args); break;
    case 'probe': await cmdProbe(args); break;
    case 'scan': await cmdScan(args); break;
    case 'port': await cmdPort(args); break;
    case 'join': await cmdJoin(args); break;
    case 'serve': {
      const self = loadIdentity();
      const reg = self.registrySeed ? new URL(self.registrySeed) : null;
      await serveResponder({
        self,
        registry: reg ? { host: reg.hostname, port: +reg.port || REGISTRY_PORT } : null,
        onProbe: (j, ri) => log(`   ${C.d('←')} 探询来自 ${ri.address} (${j.from && j.from.name})`),
      });
      // 常驻
      break;
    }
    case 'help': case '-h': case '--help': log(USAGE); break;
    default: log(USAGE); process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(e => { err(e.stack || e.message); process.exitCode = 1; });
}

module.exports = {
  cdpProbe, serveResponder, scanRegistry, scanAgentPorts, listAgents,
  checkConflict, registerTo, aidExchange, loadIdentity, localInterfaces,
};
