#!/usr/bin/env node
/**
 * CSB v1.1 Demo — Agent 信任评分查询与 Agent Card 互访
 * 
 * 演示 CSB-Trust + CSB-AgentCard 在实际 Agent 间的运作
 * 
 * 使用方式：
 *   node trust/demo.js              # 查询注册表里所有Agent的信任评分
 *   node trust/demo.js --by-name 若兰  # 查询指定Agent
 */

const http = require('http');
const path = require('path');

const REGISTRY_URL = 'http://172.28.0.4:3099';
const trust = require('./score');
const card = require('../agent-card/schema');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get(u, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const byName = args.includes('--by-name') ? args[args.indexOf('--by-name') + 1] : null;

  console.log('\n══════════════════════════════════════');
  console.log('  CSB v1.1 · 信任评分网络');
  console.log('  CSB-Trust × CSB-AgentCard');
  console.log('══════════════════════════════════════\n');

  // 1. 获取注册表所有 Agent
  const registry = await httpGet(REGISTRY_URL + '/agents');
  const agents = registry.agents || registry.data || [];

  if (agents.length === 0) {
    console.log('⚠️ 注册表无数据\n');
    return;
  }

  // 2. 过滤
  const filtered = byName
    ? agents.filter(a => a.name && a.name.includes(byName))
    : agents.filter(a => a.status === 'online');

  if (filtered.length === 0) {
    console.log(`⚠️ 未找到${byName ? '包含 "' + byName + '" 的' : '在线'}Agent\n`);
    return;
  }

  // 3. 对每个 Agent 计算信任评分
  const results = filtered.map(a => {
    const t = a.trust || {};
    const dims = {
      identity:  t.identity_score ?? (a.status === 'online' ? 0.7 : 0.3),
      history:   t.task_success_rate ?? 0.5,
      audit:     t.audit_score ?? 0.5,
      community: t.community_score ?? 0.5,
    };
    const scoreResult = trust.calc(dims);

    // 模拟信任衰减
    let decayInfo = null;
    if (a.lastHeartbeat) {
      const daysSinceActive = (Date.now() - new Date(a.lastHeartbeat).getTime()) / 86400000;
      if (daysSinceActive > 1) {
        decayInfo = trust.decay(scoreResult.score, daysSinceActive);
      }
    }

    return {
      name: a.name,
      status: a.status,
      type: a.sandbox?.type || (a.capabilities?.http_server ? 'persistent' : 'unknown'),
      trust: scoreResult,
      decay: decayInfo,
      url: a.url,
      caps: a.capabilities,
    };
  });

  // 4. 排序（信任评分从高到低）
  results.sort((a, b) => b.trust.score - a.trust.score);

  // 5. 输出
  console.log(`📊 ${results.length} 个 Agent\n`);

  for (const r of results) {
    const icon = r.status === 'online' ? '🟢' : '🔴';
    const decayStr = r.decay?.decayed ? ` (⬇️ ${r.decay.effective})` : '';
    const typeIcon = r.type === 'ephemeral' ? '📄' : r.type === 'hybrid' ? '🔀' : '💻';
    
    console.log(`  ${icon} ${r.name}`);
    console.log(`     ${typeIcon} ${r.type} | ${r.trust.label} (${r.trust.score})${decayStr}`);
    
    // 显示能力
    if (r.caps) {
      if (Array.isArray(r.caps) && r.caps.length > 0) {
        const capStr = r.caps.slice(0, 3).map(c => typeof c === 'string' ? c : c.name).join(', ');
        console.log(`     🎯 ${capStr}${r.caps.length > 3 ? '...' : ''}`);
      } else if (typeof r.caps === 'object' && Object.keys(r.caps).length > 0) {
        const caps = Object.keys(r.caps).slice(0, 3).join(', ');
        console.log(`     🎯 ${caps}...`);
      }
    }
    console.log();
  }

  // 6. 统计
  const online = results.filter(r => r.status === 'online').length;
  const highTrust = results.filter(r => r.trust.level === 'high' || r.trust.level === 'complete').length;
  const decayed = results.filter(r => r.decay?.decayed).length;

  console.log('─── 统计 ───');
  console.log(`  🟢 在线: ${online}`);
  console.log(`  🔵 高信任: ${highTrust}`);
  console.log(`  ⬇️ 信任衰减: ${decayed}`);
  console.log(`  📊 总数: ${results.length}`);
  console.log('');
}

main().catch(e => console.error('❌', e.message));
