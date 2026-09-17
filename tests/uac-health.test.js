/**
 * tests/uac-health.test.js —— UAC 自检视图单测（2026-09-17 · 若兰）
 *
 * 覆盖 /health 的 `uac` 段与 /health/uac-probe 的**判定语义**（不启服务，纯函数）。
 * 红底两条：
 *   ① 无 UAC 信封 → 必须 fail-safe（hit:false），**绝不假阳性**
 *   ② env 未开 → 必须显式 hook_not_assembled（不装成"已装配"）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../a2a-uac-health');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✅ ' + name); }
  catch (e) { fail += 1; console.log('  ❌ ' + name + ' → ' + e.message); }
}

const TMP = path.join(__dirname, '.tmp-uac-health');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const P_ENABLED = path.join(TMP, 'policy-enabled.json');
const P_DISABLED = path.join(TMP, 'policy-disabled.json');
const P_MISSING = path.join(TMP, 'nope.json');

fs.writeFileSync(P_ENABLED, JSON.stringify({
  version: 1, enabled: true,
  peers: [{ id: 'ruolan', name: '若兰', capabilities: ['pull', 'test'], rate: { max: 3, windowSeconds: 86400 } }],
}, null, 2));
fs.writeFileSync(P_DISABLED, JSON.stringify({ version: 1, enabled: false, peers: [] }, null, 2));

console.log('\nUAC 自检视图（a2a-uac-health）');

// ── envFlagOn ──
t('1. envFlagOn: 未设 → false', () => assert.strictEqual(H.envFlagOn({}), false));
t('2. envFlagOn: on → true（大小写不敏感）', () => {
  assert.strictEqual(H.envFlagOn({ A2A_BRIDGE_UAC: 'on' }), true);
  assert.strictEqual(H.envFlagOn({ A2A_BRIDGE_UAC: 'ON' }), true);
  assert.strictEqual(H.envFlagOn({ A2A_BRIDGE_UAC: 'off' }), false);
});

// ── uacProbe fail-safe ──
t('3. probe: env 未开 → hook_not_assembled（不假装配）', () => {
  const r = H.uacProbe({ A2A_BRIDGE_UAC_POLICY: P_ENABLED });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'hook_not_assembled');
  assert.strictEqual(r.envFlag, false);
});

t('4. probe: 已开 + 策略启用 + 无信封 → {hit:false, reason:no_uac}', () => {
  const r = H.uacProbe({ A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_ENABLED });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'no_uac');
  assert.strictEqual(r.envFlag, true);
  assert.strictEqual(r.policyEnabled, true);
  assert.strictEqual(r.peersCount, 1);
});

t('5. probe: 已开 + 策略未启用 → policy_disabled', () => {
  const r = H.uacProbe({ A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_DISABLED });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'policy_disabled');
});

t('6. probe: 策略文件不存在 → policy_unreadable（不抛）', () => {
  const r = H.uacProbe({ A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_MISSING });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'policy_unreadable');
});

// ── uacHealthSnapshot ──
t('7. snapshot: 读策略文件 + 运行态（不依赖请求）', () => {
  const s = H.uacHealthSnapshot(
    { A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_ENABLED },
    { assembled: true, error: null, guardWarned: false }
  );
  assert.strictEqual(s.envFlag, true);
  assert.strictEqual(s.policyEnabled, true);
  assert.strictEqual(s.peersCount, 1);
  assert.deepStrictEqual(s.peerIds, ['ruolan']);
  assert.strictEqual(s.hookAssembled, true);
  assert.strictEqual(s.policyError, null);
  assert.strictEqual(s.probeEndpoint, '/health/uac-probe');
});

t('8. snapshot: 缺策略文件 → policyError 明示，不假装正常', () => {
  const s = H.uacHealthSnapshot({ A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_MISSING }, { assembled: false });
  assert.strictEqual(s.policyEnabled, false);
  assert.strictEqual(s.peersCount, 0);
  assert.ok(s.policyError && /ENOENT|no such file/i.test(s.policyError), 'policyError 应报告原因');
});

t('9. snapshot: 装配失败 → assemblyError 透出（诊断不撒谎）', () => {
  const s = H.uacHealthSnapshot(
    { A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_ENABLED },
    { assembled: false, error: 'boom', guardWarned: true }
  );
  assert.strictEqual(s.hookAssembled, false);
  assert.strictEqual(s.assemblyError, 'boom');
  assert.strictEqual(s.guardWarned, true);
});

t('10. 红线：任何非命中场景 hit 必须为 false', () => {
  const cases = [
    H.uacProbe({}),
    H.uacProbe({ A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_ENABLED }),
    H.uacProbe({ A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_DISABLED }),
    H.uacProbe({ A2A_BRIDGE_UAC: 'on', A2A_BRIDGE_UAC_POLICY: P_MISSING }),
  ];
  for (const r of cases) assert.strictEqual(r.hit, false, JSON.stringify(r));
});

// ── 清理 ──
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail}）`);
process.exit(fail === 0 ? 0 : 1);
