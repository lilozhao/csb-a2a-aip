#!/usr/bin/env node
/**
 * tests/capabilities-resolve.test.js —— allowedScopes 解析：不许再出现「空授权」
 *
 * 背景（2026-10-24 · 明德实测反馈）：
 *   1) loadCapabilities() 文件缺失时日志说「降级到 ['a2a:send']」，代码却 return {}
 *   2) 兜底表达式 `(identity.capabilities && Object.keys(...)) || ['a2a:send']`
 *      —— **空数组是 truthy**，`[] || [...]` 恒等于 `[]`
 *      结果 allowedScopes=[] → 握手 init 能过、approval 永远空授权
 *
 * 判据：allowedScopes 必须永远非空，且来源可核对。
 *
 * 用法: node tests/capabilities-resolve.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

// 直接从 server_v5.js 抽出纯函数做行为验证（不启动服务）
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server_v5.js'), 'utf8');
const m = SRC.match(/function resolveAllowedScopes\(caps, identityDoc\) \{[\s\S]*?\n\}/);
assert.ok(m, 'server_v5.js 中找不到 resolveAllowedScopes —— 重构时请同步本测试');
const resolveAllowedScopes = new Function(`${m[0]}; return resolveAllowedScopes;`)();

console.log('=== allowedScopes 解析测试 ===\n');

// 1. capabilities.json 有 scope → 用它
test('capabilities.json 非空 → 以它为唯一来源', () => {
  const r = resolveAllowedScopes({ 'a2a:send': {}, 'forum.post': {} }, { capabilities: { 'x': {} } });
  assert.deepStrictEqual(r.scopes.sort(), ['a2a:send', 'forum.post']);
  assert.strictEqual(r.source, 'capabilities.json');
});

// 2. 文件缺失（{}）但 identity 声明了 capabilities → 用 identity
test('capabilities.json 缺失 → 回退 identity.capabilities', () => {
  const r = resolveAllowedScopes({}, { capabilities: { 'a2a:send': {} } });
  assert.deepStrictEqual(r.scopes, ['a2a:send']);
  assert.strictEqual(r.source, 'identity.capabilities');
});

// 3. ★ 两者都空 → 默认值，绝不允许 []
test('两者都为空 → 默认 [a2a:send]，绝不为空数组', () => {
  const r = resolveAllowedScopes({}, { capabilities: {} });
  assert.deepStrictEqual(r.scopes, ['a2a:send'], '空数组会让握手 status=ok 但授权为空');
  assert.strictEqual(r.source, 'default');
});

// 4. identity 根本没有 capabilities 字段
test('identity 无 capabilities 字段 → 默认 [a2a:send]', () => {
  const r = resolveAllowedScopes({}, {});
  assert.deepStrictEqual(r.scopes, ['a2a:send']);
  assert.strictEqual(r.source, 'default');
});

// 5. identity 为 undefined（防御）
test('identity 为 undefined → 默认 [a2a:send]', () => {
  const r = resolveAllowedScopes({}, undefined);
  assert.deepStrictEqual(r.scopes, ['a2a:send']);
});

// 6. 老陷阱回归：[] || x 恒等于 []
test('回归：空数组是 truthy（证明旧写法的坑）', () => {
  assert.deepStrictEqual([] || ['a2a:send'], [], '[] || x 返回 []，不是 x');
});

/**
 * 去掉注释后的代码行（含行号）
 * ⚠️ 2026-10-24 教训：上一版直接全文正则，命中的是**注释里对旧写法的说明**，
 *    两条断言全部误报。检查代码的断言必须先剥注释，否则「检查器自己先要通过检查」。
 */
function codeLines(src) {
  const out = [];
  let inBlock = false;
  src.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    while (true) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end === -1) { line = line.slice(0, start); inBlock = true; break; }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const c = line.indexOf('//');
    if (c !== -1) line = line.slice(0, c);
    if (line.trim()) out.push({ line, n: i + 1 });
  });
  return out;
}

const CODE = codeLines(SRC);

// 7. 默认 scope 只能有一个出口（集中到 resolveAllowedScopes）
test('默认 [\'a2a:send\'] 只许出现在 resolveAllowedScopes 内', () => {
  // 日志里如实打印该值不算「出口」，只算代码赋值/返回
  const hits = CODE.filter(x => /\['a2a:send'\]/.test(x.line) && !/console\./.test(x.line));
  assert.strictEqual(hits.length, 1,
    `应只有一个出口，实际 ${hits.length} 处: ` +
    hits.map(h => `L${h.n}: ${h.line.trim()}`).join(' | '));
  // 且该行必须落在 resolveAllowedScopes 函数体内
  const fnStart = SRC.slice(0, SRC.indexOf('function resolveAllowedScopes'));
  const lineIdx = SRC.split('\n').findIndex(l => /return \{ scopes: \['a2a:send'\]/.test(l)) + 1;
  assert.ok(lineIdx > fnStart.split('\n').length - 1, '默认值出口必须位于 resolveAllowedScopes 内');
});

// 8. 日志不得再谎报降级（注释不算）
test('warn 日志不得再谎报「降级到」', () => {
  const hits = CODE.filter(x => /console\.(warn|log|error)/.test(x.line) && /降级到/.test(x.line));
  assert.strictEqual(hits.length, 0,
    '日志说降级、代码 return {} —— 正是明德报的那个 bug: ' +
    hits.map(h => `L${h.n}`).join(', '));
});

console.log(`\n通过: ${passed}\n失败: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
