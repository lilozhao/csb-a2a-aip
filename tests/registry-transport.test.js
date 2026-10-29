#!/usr/bin/env node
/**
 * registry-transport.test.js —— 注册表传输层两处「看起来正常」的回归
 *
 * 起因（2026-10-29 · 清漪换域名时撞出，若兰复核后在本仓落地）：
 *   ① a2a-dht-coldstart.js 只 require('http')，硬编码 http.get。
 *      注册表换 https://域名 后 → 探测全失败 → DHT 降级 CACHE / onlineAgents=0。
 *      最坑的是：进程在、/health 仍返回 200，只有 registryReachable:false 能看出来。
 *   ② Agent Card 路径同一份数据三处生成、两种写法：
 *      :304/:421 写 agent-card.json（本站是 301 跳转），:866 写 agent.json（200）。
 *      只认 200 的客户端（严格 healthcheck）会把在线邻居判成离线。
 *
 * 判据（可机械核对，不靠「应该没问题」）：
 *   - https URL 必须走 https 客户端（旧代码会同步抛 ERR_INVALID_PROTOCOL）
 *   - registry 生成的 agentCard URL 必须指向返回 200 的路径（无 301）
 *   - healthcheck.sh 不得用「curl 退出码」判活（curl 对 404 也 exit 0）
 *
 * 用法：node tests/registry-transport.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');

// ---------- ① DHT 传输层 ----------
console.log('\n① a2a-dht-coldstart.js · 协议自适应');

const dhtSrc = fs.readFileSync(path.join(ROOT, 'a2a-dht-coldstart.js'), 'utf8');

t('require 了 https', () => {
  assert(/require\(['"]https['"]\)/.test(dhtSrc), '缺 const https = require("https")');
});

t('_httpGet 按 url.protocol 选客户端（不再硬编码 http.get）', () => {
  const m = dhtSrc.match(/_httpGet\(url\)\s*\{[\s\S]*?\n  \}/);
  assert(m, '没找到 _httpGet 方法体');
  assert(/protocol\s*===\s*['"]https:['"]\s*\?\s*https\s*:\s*http/.test(m[0]),
    '未见到 protocol === "https:" ? https : http 的选择分支');
  assert(!/^\s*const req = http\.get\(/m.test(m[0]),
    '仍是硬编码 http.get（https URL 会同步抛 ERR_INVALID_PROTOCOL）');
});

t('响应体 setEncoding("utf8")（防逐 chunk 拼串吃字）', () => {
  assert(/res\.setEncoding\(['"]utf8['"]\)/.test(dhtSrc), '缺 setEncoding("utf8")');
});

t('非法 URL 走 reject，不抛同步异常炸进程', () => {
  assert(/bad_registry_url/.test(dhtSrc), '未见 bad_registry_url 兜底');
});

// 行为验证：实例方法确实能选对客户端（不依赖网络：用一个必错的 https 目标）
(async () => {
  const M = require(path.join(ROOT, 'a2a-dht-coldstart.js'));
  const Mgr = M.DHTColdStartManager || M.default || M;
  const m = new Mgr({ registries: ['https://127.0.0.1:1'], registryTimeout: 1500 });
  let err = null;
  try { await m._httpGet('https://127.0.0.1:1/health'); } catch (e) { err = e; }
  t('https 目标不再抛 ERR_INVALID_PROTOCOL（走 https 客户端，只报连接错）', () => {
    assert(err, '应当 reject');
    assert(!/ERR_INVALID_PROTOCOL/.test(String(err && err.code)),
      '仍是 ERR_INVALID_PROTOCOL → 还在用 http 客户端打 https');
  });

  // ---------- ② Agent Card 路径 ----------
  console.log('\n② registry.js · Agent Card 路径一致');

  const regSrc = fs.readFileSync(path.join(ROOT, 'registry.js'), 'utf8');
  const cardUrls = [...regSrc.matchAll(/\/\.well-known\/(agent-card|agent)\.json/g)]
    .map(x => x[1]);

  t('所有 agentCard URL 统一指向 agent.json（返回 200，不是 301）', () => {
    assert(cardUrls.length > 0, '没找到 agentCard URL 生成处');
    assert(!cardUrls.includes('agent-card'),
      `仍有 ${cardUrls.filter(x => x === 'agent-card').length} 处写 agent-card.json（301 → 会被严格客户端判离线）`);
  });

  t('ARD catalog(:866) 与注册卡片(:304/:421) 指向同一路径', () => {
    const uniq = new Set(cardUrls);
    assert(uniq.size === 1, '同一份数据出现了多种路径写法: ' + [...uniq].join(' / '));
  });

  // ---------- ③ healthcheck.sh ----------
  console.log('\n③ healthcheck.sh · 判活不许只用退出码');

  const hc = fs.readFileSync(path.join(ROOT, 'healthcheck.sh'), 'utf8');
  t('判活统一走 http_ok（-w http_code + -L + 比 200）', () => {
    const m = hc.match(/http_ok\(\)\s*\{[\s\S]*?\n\}/);
    assert(m, '没找到 http_ok() 助手');
    assert(/%\{http_code\}/.test(m[0]), '没用 -w http_code，无法区分 200 与 404');
    assert(/\s-L\s/.test(m[0]), '没加 -L（agent-card.json 301 会跟丢）');
    assert(/\[\s*"\$code"\s*=\s*/.test(m[0]), '没有把取到的 code 跟期望码比（判活仍不看状态码）');
    assert(/200/.test(m[0]), '期望码里没有 200');
  });

  t('check_registry / check_server 都改成 http_ok', () => {
    for (const fn of ['check_registry', 'check_server']) {
      const m = hc.match(new RegExp(fn + '\\(\\)\\s*\\{[\\s\\S]*?\\n\\}'));
      assert(m, `没找到 ${fn}()`);
      assert(/http_ok/.test(m[0]), `${fn} 未走 http_ok`);
    }
  });

  t('不再出现「if curl -s <url>」这种恒真判活', () => {
    const body = hc.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    assert(!/if\s+curl\s+-s\s+\S+\s+--connect-timeout/.test(body),
      '仍有 if curl -s ... 形式：curl 对 404 也 exit 0 → 这条检查永远不会失败');
  });

  console.log(`\n${failed === 0 ? '🎉' : '🔴'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
