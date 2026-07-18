#!/usr/bin/env node
/**
 * memory.js — CSB-Memory v0.2 本地 API 实现
 * 
 * 符合 §5.1 规范，提供5个标准方法：
 *   - memory.add(entry)
 *   - memory.get(agentName)
 *   - memory.query(filter)
 *   - memory.summary(agent, count)
 *   - memory.delete(id)
 */

const fs = require('fs');
const path = require('path');
const audit = require('./audit-log');
const MEMORY_DIR = path.join(__dirname, '..', 'memory', 'a2a-memories');

function safeFilename(name) {
  return name.replace(/[^\w\u4e00-\u9fff]/g, '_') + '.md';
}

function getFilePath(agentName) {
  return path.join(MEMORY_DIR, safeFilename(agentName));
}

function generateId() {
  return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function formatTimestamp(iso) {
  if (iso) return iso;
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().replace('Z', '+08:00');
}

// 解析纯YAML行（不带外层的 ---）
function parseYamlLines(text) {
  const meta = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) {
      let val = m[2].trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/"/g, ''));
      } else {
        val = val.replace(/^"|"$/g, '');
      }
      meta[m[1]] = val;
    }
  }
  return meta;
}

// 生成 YAML front matter 文本
// 自动判断置信度
function autoConfidence(text) {
  const keywords = ["确认","决定","同意","完成","发布","定稿","通过","正式","已","✅","announced","finalized","completed","confirmed"];
  const lowWords = ["可能","也许","大概","猜测","听说","maybe","perhaps","guess","heard"];
  const t = text.slice(0, 200);
  const hasHigh = keywords.some(k => t.includes(k));
  const hasLow = lowWords.some(k => t.includes(k));
  if (hasHigh) return "high";
  if (hasLow) return "low";
  return "medium";
}

function toFrontMatter(entry) {
  // 未指定置信度时自动判断
  if (!entry.confidence && entry.content) {
    entry.confidence = autoConfidence(entry.content);
  }
  const fields = [
    `id: "${entry.id || generateId()}"`,
    `type: ${entry.type || 'conversation'}`,
    `timestamp: "${entry.timestamp || formatTimestamp()}"`,
    `source: ${entry.source || 'unknown'}`,
    `confidence: ${entry.confidence || 'medium'}`,
    `tags: [${(entry.tags || []).join(', ')}]`,
    `visibility: ${entry.visibility || 'public'}`,
  ];
  if (entry.ttl) fields.push(`ttl: ${entry.ttl}`);
  return `---\n${fields.join('\n')}\n---\n\n${entry.content || ''}\n`;
}

// ===== 核心 API =====

/**
 * 添加一条记忆
 */
function add(entry) {
  if (!entry.agent || !entry.content) {
    throw new Error('缺少必填字段: agent, content');
  }

  const filePath = getFilePath(entry.agent);
  const block = toFrontMatter({
    id: entry.id,
    type: entry.type || 'conversation',
    timestamp: entry.timestamp,
    source: entry.source || '若兰',
    confidence: entry.confidence,
    tags: entry.tags || [],
    visibility: entry.visibility || 'public',
    content: entry.content,
    ttl: entry.ttl,
  });

  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf-8').trimEnd();
  } else {
    existing = `# ${entry.agent} 记忆档案\n\n**首次对话**: ${new Date().toLocaleString('zh-CN')}\n`;
  }

  fs.writeFileSync(filePath, existing + '\n\n' + block);
  audit.log('memory.add', { agent: entry.agent, type: entry.type, confidence: entry.confidence }, entry.source || '若兰', entry.agent, 'success');
  return { id: entry.id || generateId(), success: true };
}

/**
 * 获取对某 Agent 的全部记忆
 * 文件格式：split 后偶数index(>0)=YAML, 奇数index=内容
 */
function get(agentName) {
  const filePath = getFilePath(agentName);
  if (!fs.existsSync(filePath)) return [];

  const text = fs.readFileSync(filePath, 'utf-8');
  const parts = text.split('\n---\n'); // blocks[0]=header, [1]=YAML1, [2]=content1, [3]=YAML2...

  const entries = [];
  for (let i = 1; i < parts.length; i += 2) {
    const yamlText = parts[i];            // YAML 字段（偶数index）
    const contentText = (parts[i + 1] || '').trim(); // 内容（奇数index）
    if (!yamlText || !yamlText.includes('id:')) continue;

    const meta = parseYamlLines(yamlText);
    if (meta.id) {
      entries.push({ ...meta, content: contentText });
    }
  }

  // 按时间倒序
  entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  audit.log('memory.get', { agent: agentName, count: entries.length }, '若兰', agentName, 'success');
  return entries;
}

/**
 * 按条件检索
 */
function query(filter = {}) {
  const allEntries = [];
  if (filter.agent) {
    allEntries.push(...get(filter.agent));
  } else {
    if (!fs.existsSync(MEMORY_DIR)) return [];
    const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md') && !f.endsWith('.bak'));
    for (const file of files) {
      allEntries.push(...get(file.replace('.md', '')));
    }
  }

  let results = allEntries;

  if (filter.tags && filter.tags.length > 0) {
    results = results.filter(e => {
      const tags = Array.isArray(e.tags) ? e.tags : (typeof e.tags === 'string' ? [e.tags] : []);
      return filter.tags.some(t => tags.includes(t));
    });
  }

  if (filter.type) {
    results = results.filter(e => e.type === filter.type);
  }

  if (filter.confidence) {
    const levels = ['low', 'medium', 'high'];
    const minIdx = levels.indexOf(filter.confidence);
    if (minIdx >= 0) {
      results = results.filter(e => levels.indexOf(e.confidence || 'low') >= minIdx);
    }
  }

  if (filter.since) {
    results = results.filter(e => (e.timestamp || '') >= filter.since);
  }

  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase();
    results = results.filter(e => (e.content || '').toLowerCase().includes(kw));
  }

  results.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  if (filter.limit) {
    results = results.slice(0, filter.limit);
  }

  audit.log('memory.query', { agent: filter.agent, tags: filter.tags, confidence: filter.confidence, count: results.length }, '若兰', filter.agent || '', 'success');
  return results;
}

/**
 * 获取记忆摘要
 */
function summary(agentName, count = 5) {
  const entries = get(agentName);
  if (entries.length === 0) return `与 ${agentName} 暂无记忆记录。`;

  const recent = entries.slice(0, Math.min(count, entries.length));
  const lines = [`与 ${agentName} 的最后 ${recent.length} 次记忆：`];
  for (const e of recent) {
    const date = (e.timestamp || '').slice(0, 10);
    const snippet = (e.content || '').replace(/\n/g, ' ').slice(0, 100);
    lines.push(`  [${date}][${e.confidence || '?'}] ${snippet}`);
  }
  lines.push(`（共 ${entries.length} 条记忆）`);
  return lines.join('\n');
}

/**
 * 删除一条记忆
 */
function deleteById(id) {
  if (!fs.existsSync(MEMORY_DIR)) return { success: false, message: '记忆目录不存在' };

  const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md') && !f.endsWith('.bak'));
  for (const file of files) {
    const filePath = path.join(MEMORY_DIR, file);
    const text = fs.readFileSync(filePath, 'utf-8');
    const parts = text.split('\n---\n');
    const newParts = [parts[0]]; // 保留 header

    let deleted = false;
    // 从 i=1 开始，步进2：YAML在奇数parts，内容在偶数parts
    for (let i = 1; i < parts.length; i += 2) {
      const yamlText = parts[i];
      const contentText = parts[i + 1] || '';
      if (!yamlText) continue;

      const meta = parseYamlLines(yamlText);
      if (meta.id === id) {
        deleted = true;
        continue; // 跳过这条
      }
      // 重新拼回
      newParts.push(yamlText);
      newParts.push(contentText);
    }

    if (deleted) {
      fs.writeFileSync(filePath, newParts.join('\n---\n'));
      audit.log('memory.delete', { id }, '若兰', '', 'success');
      return { success: true, message: `已删除记忆 ${id}` };
    }
  }

  return { success: false, message: `未找到记忆 ${id}` };
}

// ===== CLI =====

function help() {
  console.log(`
用法: node memory.js <命令> [参数]

命令:
  add <agent> <内容>        添加记忆
  get <agent>               获取全部记忆
  query [--tag T] [--type T] 按条件检索
  summary <agent> [条数]    获取摘要
  delete <id>               删除记忆

示例:
  node memory.js add 明德 "讨论了CSB-Memory v0.2"
  node memory.js get 思源
  node memory.js query --tag CSB --confidence high --limit 3
  node memory.js summary 思源 3
`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help') { help(); return; }

  switch (cmd) {
    case 'add': {
      const agent = args[1];
      const content = args.slice(2).join(' ');
      if (!agent || !content) { console.log('用法: memory.js add <agent> <content>'); return; }
      const r = add({ agent, content, source: '若兰', confidence: 'medium' });
      console.log(JSON.stringify(r)); break;
    }
    case 'get': {
      const agent = args[1];
      if (!agent) { console.log('用法: memory.js get <agent>'); return; }
      const entries = get(agent);
      console.log(JSON.stringify(entries.slice(0, 3), null, 2));
      if (entries.length > 3) console.log(`...还有 ${entries.length - 3} 条`); break;
    }
    case 'query': {
      const filter = {};
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--tag' && args[i+1]) filter.tags = [args[++i]];
        else if (args[i] === '--type') filter.type = args[++i];
        else if (args[i] === '--confidence') filter.confidence = args[++i];
        else if (args[i] === '--since') filter.since = args[++i];
        else if (args[i] === '--keyword') filter.keyword = args[++i];
        else if (args[i] === '--limit') filter.limit = parseInt(args[++i]);
      }
      const results = query(filter);
      console.log(`找到 ${results.length} 条:`);
      console.log(JSON.stringify(results.slice(0, 3), null, 2));
      if (results.length > 3) console.log(`...还有 ${results.length - 3} 条`); break;
    }
    case 'summary': {
      const agent = args[1];
      const cnt = parseInt(args[2]) || 5;
      if (!agent) { console.log('用法: memory.js summary <agent> [count]'); return; }
      console.log(summary(agent, cnt)); break;
    }
    case 'delete': {
      const id = args[1];
      if (!id) { console.log('用法: memory.js delete <id>'); return; }
      console.log(JSON.stringify(deleteById(id))); break;
    }
    default: help();
  }
}

module.exports = { add, get, query, summary, delete: deleteById };

if (require.main === module) main().catch(console.error);
