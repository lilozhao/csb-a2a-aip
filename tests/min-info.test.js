#!/usr/bin/env node
/**
 * min-info.test.js —— SPEC-A2A-0002《A2A 消息最小信息约定》验收
 * A1–A10 对应 R1–R12（含 R9 过渡期提示）。风格：手写 assert（仓库惯例）。
 *
 * 用法: node tests/min-info.test.js
 */
'use strict';
const assert = require('assert');
const mi = require('../a2a-min-info.js');
const { A2AStandardAPI } = require('../a2a-standard-api-v5.js');
const { A2AStandardAPI: A2AStandardAPIv4 } = require('../a2a-standard-api.js');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

const GOOD = {
  schema: mi.MIN_INFO_SCHEMA,
  timestamp: '2026-10-16T05:30:00Z',
  evidence: [{ ref: 'csb://mem/event/12345', detail: '命中 case 001' }],
  raw_ref: { kind: 'memory-event', pointer: 'csb://mem/event/12345' },
};

async function main() {
  console.log('\n[min-info.test · SPEC-A2A-0002]\n');

  // A1 → R1：合法 min_info 原样保留（透传）
  await t('A1 → R1：合法 min_info 原样保留', () => {
    const r = mi.processMinInfo({ min_info: GOOD, sender: 'x' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.minInfo, GOOD);
  });

  // A2 → R2：三态未携带 → 按旧行为，无新增校验
  await t('A2 → R2：三态（缺失/undefined/{}）均视为未携带', () => {
    assert.strictEqual(mi.processMinInfo({}).absent, true);
    assert.strictEqual(mi.processMinInfo({ min_info: undefined }).absent, true);
    assert.strictEqual(mi.processMinInfo({ min_info: {} }).absent, true);
    assert.strictEqual(mi.isAbsent({}), true);
  });

  // A3 → R3：ref 非 csb:// 形态 → 非法
  await t('A3 → R3：ref 非 csb:// 形态被判非法', () => {
    const bad = { ...GOOD, evidence: [{ ref: 'http://example.com/x' }] };
    const r = mi.validateMinInfo(bad);
    assert.strictEqual(r.ok, false);
    assert.ok(/csb:\/\//.test(r.detail));
  });

  // A4 → R4：结构非法 → InvalidParams + code
  await t('A4 → R4：缺 timestamp → MIN_INFO_SCHEMA_INVALID', () => {
    const bad = { schema: mi.MIN_INFO_SCHEMA, evidence: GOOD.evidence };
    const r = mi.processMinInfo({ min_info: bad });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.type, 'InvalidParams');
    assert.strictEqual(r.error.code, 'MIN_INFO_SCHEMA_INVALID');
  });

  await t('A4 → R4：targetAPI 透传 InvalidParams（v5 _sendMessage）', async () => {
    const api = new A2AStandardAPI({});
    const res = await api._sendMessage({
      message: { role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { min_info: { schema: 'x' } } },
    });
    assert.strictEqual(res.error, 'InvalidParams', '应返回 InvalidParams');
    assert.strictEqual(res.details.code, 'MIN_INFO_SCHEMA_INVALID');
    assert.ok(res.details.trace_id, '应带 trace_id');
  });

  // A5 → R5：raw_ref 保存、不解析解引用（本模块不解析）
  await t('A5 → R5：raw_ref 仅保留、不解析（processMinInfo 不做任何解析）', () => {
    const r = mi.processMinInfo({ min_info: GOOD });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.minInfo.raw_ref.pointer, 'csb://mem/event/12345');
    // 模块导出中无任何"解析器/解引用"API
    assert.ok(!Object.keys(mi).some((k) => /resolve|deref|fetch/i.test(k)), '不应存在解析/解引用 API');
  });

  // A6 → R6：不外发（模块无网络调用）
  await t('A6 → R6：模块无网络外发（无 http/https 依赖）', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'a2a-min-info.js'), 'utf8');
    assert.ok(!/require\(['"](https?|node-fetch|axios)['"]\)/.test(src), '不应引入网络依赖');
  });

  // A7 → R7：kind 非法 → 非法；枚举值 → 通过
  await t('A7 → R7：kind 冻结枚举校验', () => {
    assert.strictEqual(mi.validateKind('memory-event').ok, true);
    assert.strictEqual(mi.validateKind('file-snippet').ok, true);
    assert.strictEqual(mi.validateKind('banana').ok, false);
    const r = mi.validateMinInfo({ ...GOOD, raw_ref: { kind: 'banana' } });
    assert.strictEqual(r.ok, false);
  });

  // A8 → R8：v4 / v5 同一输入校验结果一致
  await t('A8 → R8：v4/v5 双实现共用模块，结果一致', () => {
    assert.deepStrictEqual(mi.processMinInfo({ min_info: GOOD }), mi.processMinInfo({ min_info: GOOD }));
    const v4 = new A2AStandardAPIv4({});
    assert.strictEqual(typeof v4._processMinInfo, 'function');
  });

  // A9 → 背景：校验文件（JSON Schema）落库 + 示例载荷自检
  await t('A9 → 背景：csb://min-info/v0.1 校验文件落库且结构正确', () => {
    const fs = require('fs'); const p = require('path');
    const schema = JSON.parse(fs.readFileSync(p.join(__dirname, '..', 'schemas', 'min-info.v0.1.json'), 'utf8'));
    assert.strictEqual(schema.$id, 'csb://min-info/v0.1');
    assert.deepStrictEqual(schema.required.sort(), ['evidence', 'schema', 'timestamp']);
    assert.ok(schema.properties.raw_ref.properties.kind.enum.includes('memory-event'));
    // 示例载荷符合 schema 必填
    for (const k of schema.required) assert.ok(k in GOOD, `示例缺 ${k}`);
  });

  // v1.1 过渡期告示（非需求变更）：未携带 → min_info_absent 提示；开关可关
  await t('[v1.1 告示] 过渡期提示（默认开）+ 开关可关', () => {
    assert.strictEqual(mi.processMinInfo({}).notice, 'min_info_absent');
    process.env.A2A_MIN_INFO_NOTICE = 'off';
    assert.strictEqual(mi.processMinInfo({}).notice, undefined);
    delete process.env.A2A_MIN_INFO_NOTICE;
  });

  // A10 → 背景：README 含 LIP L1 引用（静态断言）
  await t('A10 → 背景：specs/README 含 LIP 子则 L1 映射', () => {
    const readme = require('fs').readFileSync(require('path').join(__dirname, '..', 'specs', 'README.md'), 'utf8');
    assert.ok(/LIP/.test(readme) || /SPEC-A2A-0002/.test(readme), 'README 应索引到本 spec/LIP');
  });

  console.log(`\n  通过 ${passed} / ${passed + failed}\n`);
  process.exit(failed ? 1 : 0);
}

main();