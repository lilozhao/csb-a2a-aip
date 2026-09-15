#!/usr/bin/env node
/**
 * a2a-contexts-identity.test.js —— 身份串号护栏（2026-09-15）
 *
 * 背景：仓库 `a2a-contexts/01-core-identity.md`、`03-memory-summary.md` 曾把「阿轩」
 *   写死，随仓库分发后被其他实例（恺）注入 → A2A 回执**自称阿轩**（身份串号）。
 * 本测试确保：**分发的上下文模板里不得出现任何具体实例的名字**。
 *
 * 用法: node tests/a2a-contexts-identity.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CTX_DIR = path.join(__dirname, '..', 'a2a-contexts');
// 分发的模板文件（local/ 是实例专属，已 gitignore，不检查）
const SHIPPED = ['01-core-identity.md', '02-user-profile.md', '03-memory-summary.md', '04-agent-rules.md', '05-today-context.md'];
const BANNED = ['阿轩', '若兰', '明德', '小虾', '恺', '墨丘', '舟楫', '苏念', '清漪', '星尘', '言蹊', '若琢', '鲸歌', '川贝', '知砚', '若辰', '初白', 'Jeason'];

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\n[a2a-contexts · 身份串号护栏]\n');

t('模板文件里不含任何具体实例名（分发给全网的模板必须中性）', () => {
  for (const f of SHIPPED) {
    const p = path.join(CTX_DIR, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'utf8');
    for (const name of BANNED) {
      assert.ok(!s.includes(name), `${f} 含实例名「${name}」—— 会随仓库分发造成身份串号`);
    }
  }
});

t('构建出的 system prompt 不含任何具体实例名（用中性 identity）', () => {
  const builder = require('../a2a-layered-prompt.js');
  const p = builder.build({ name: '测试Agent', emoji: '🧪', description: 'd', personality: 'p' }, { layer: 2, senderName: '对方' });
  for (const name of BANNED) {
    assert.ok(!p.includes(name), `prompt 含实例名「${name}」`);
  }
  assert.ok(p.includes('测试Agent'), 'prompt 应含传入的 identity.name');
});

t('目录优先级：a2a-contexts/local/ 存在时优先（实例专属不被模板覆盖）', () => {
  const localDir = path.join(CTX_DIR, 'local');
  const existedLocal = fs.existsSync(localDir);
  const created = !existedLocal;
  if (created) fs.mkdirSync(localDir, { recursive: true });
  const marker = path.join(localDir, '05-today-context.md');
  const saved = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  try {
    fs.writeFileSync(marker, '# Layer 3: Today Context\n\n_local 覆盖生效标记_（本行需要超过 50 字符才会被 build 纳入，否则会被长度阈值过滤）');
    delete require.cache[require.resolve('../a2a-layered-prompt.js')];
    const builder = require('../a2a-layered-prompt.js');
    const p = builder.build({ name: '测试Agent', emoji: '🧪' }, { layer: 3, senderName: '对方' });
    assert.ok(p.includes('_local 覆盖生效标记_'), 'local/ 覆盖未生效');
  } finally {
    if (saved !== null) fs.writeFileSync(marker, saved); else fs.unlinkSync(marker);
    if (created) { try { fs.rmdirSync(localDir); } catch { /* 非空则留 */ } }
    delete require.cache[require.resolve('../a2a-layered-prompt.js')];
  }
});

console.log(`\n结果: ${passed} 通过 · ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
