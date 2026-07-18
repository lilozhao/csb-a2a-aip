#!/usr/bin/env node
const config = require('./config/loader');
/**
 * CSB-Memory MEM-008 关联记忆网络 · 联想引擎
 * 
 * 输入一个话题，输出联想链路：
 *   话题 → 相关的记忆（本机）→ 跨Agent查询（虫巢）→ 联想链
 * 
 * 使用方式：
 *   node association-engine.js "西湖"
 *   node association-engine.js "trust"  (自动匹配中英文)
 */

const http = require('http');
const REGISTRY = process.env.REGISTRY_URL || config.getRegistry('local');

async function queryMemoryIndex(topic) {
  const url = `${REGISTRY}/memory_index?topic=${encodeURIComponent(topic)}`;
  return httpGet(url);
}

async function queryAgentMemory(agentUrl, query) {
  // 走A2A memory/query
  return null; // 待实现
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ hostname: u.hostname, port: parseInt(u.port), path: u.pathname + u.search, timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', reject);
  });
}

// ── 关联联想引擎 ────────────────────────────────

function buildAssociationChain(topic, agentResults) {
  // 模拟联想：概念 → 相关Agent → 相关主题 → 相关Agent
  const chain = [{ node: topic, type: 'trigger', strength: 1.0 }];
  
  if (!agentResults || !agentResults.results) {
    chain.push({ node: '未找到相关记忆', type: 'dead_end', strength: 0 });
    return chain;
  }
  
  for (const result of agentResults.results) {
    const matched = result.matched_topics || [];
    chain.push({
      node: result.name,
      type: 'agent',
      strength: 0.8,
      topics: matched,
      url: result.url
    });
    
    // 联想扩展：从匹配主题联想到其他主题
    for (const topic of matched) {
      chain.push({
        node: topic,
        type: 'topic',
        strength: 0.6,
        triggered_by: `${result.name} 知道这个`
      });
    }
  }
  
  return chain;
}

// ── 主程序 ────────────────────────────────────────

async function main() {
  const topic = process.argv[2] || '碳硅契';
  
  console.log(`\n🧠 CSB 联想引擎 · "${topic}"\n`);
  console.log('联想路径:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // Step 1: 查询记忆索引
  const results = await queryMemoryIndex(topic);
  
  // Step 2: 构建联想链
  const chain = buildAssociationChain(topic, results);
  
  let prevIndent = '';
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i];
    const indent = i === 0 ? '' : '  ';
    const arrow = i === 0 ? '🟢' : '→';
    
    switch (link.type) {
      case 'trigger':
        console.log(`🟢 "${link.node}"`);
        break;
      case 'agent':
        console.log(`  ${arrow} ${link.node} [${link.topics.join(', ')}]`);
        break;
      case 'topic':
        console.log(`    ⤷ ${link.node} (${link.triggered_by})`);
        break;
      case 'dead_end':
        console.log(`  ❌ ${link.node}`);
        break;
    }
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`联想深度: ${chain.length} 跳`);
  
  // 如果查不到，给建议
  if (!results || !results.results || results.results.length === 0) {
    console.log('\n💡 这个主题还没有Agent注册。');
    console.log('   你可以尝试：');
    console.log('   1. 换一个相近的词查询');
    console.log('   2. 用 /memory/topics API 注册新主题');
  }
  
  // 跨Agent建议
  if (results && results.results) {
    const agents = results.results;
    if (agents.length > 1) {
      console.log(`\n📡 发现 ${agents.length} 位Agent可能有相关信息。`);
      console.log('   可通过A2A memory/query 进一步查询。');
    }
  }
}

main().catch(console.error);
