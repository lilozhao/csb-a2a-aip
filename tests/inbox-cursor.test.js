#!/usr/bin/env node
'use strict';
/**
 * tests/inbox-cursor.test.js —— Q7 游标验收（2026-11-26）
 *
 * 对应 docs/RUNTIME-SEVEN-QUESTIONS.md §5.4 ③「跨重启断裂」：
 *   重启前后 seq 连续性、无重号、游标不跳号 —— 三条都必须真跑。
 *
 * 用法: node tests/inbox-cursor.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-cursor-test-'));
process.env.A2A_INBOX_PATH = path.join(TMP, 'a2a-inbox.jsonl');
process.env.A2A_INBOX_CURSOR_PATH = path.join(TMP, 'a2a-inbox-cursor.json');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function reload() {
  delete require.cache[require.resolve('../a2a-inbox.js')];
  return require('../a2a-inbox.js');
}
const msg = (t) => ({ messageId: `m-${t}`, parts: [{ kind: 'text', text: t }] });

console.log('\n=== Q7 游标验收（at-least-once） ===\n');

let inbox = reload();

// ── 1. seq 赋值 ──
console.log('[1] seq 单调赋号');
const r1 = inbox.record({ taskId: 't1', msg: msg('一'), metadata: {} });
const r2 = inbox.record({ taskId: 't2', msg: msg('二'), metadata: {} });
const r3 = inbox.record({ taskId: 't3', msg: msg('三'), metadata: {} });
ok('三条记录成功', r1 && r2 && r3);
let items = inbox.read({ limit: 0 });
ok('seq = 1,2,3', JSON.stringify(items.map((x) => x.seq)) === '[1,2,3]', JSON.stringify(items.map((x) => x.seq)));

// ── 2. 重启后 seq 不复用（§5.4 ③ 前半）──
console.log('\n[2] 重启后续号（不复用）');
inbox = reload();
inbox.record({ taskId: 't4', msg: msg('四'), metadata: {} });
items = inbox.read({ limit: 0 });
ok('重启后新记录 seq=4', items[3].seq === 4, `实际 ${items[3].seq}`);

// ── 3. 老记录（无 seq 字段）派生序号 ──
console.log('\n[3] 老记录派生 seq（不重写历史）');
fs.appendFileSync(process.env.A2A_INBOX_PATH,
  JSON.stringify({ ts: '2026-01-01T00:00:00Z', taskId: 'legacy', messageId: 'm-legacy', seen: false }) + '\n');
inbox = reload();
items = inbox.read({ limit: 0 });
ok('老记录拿到派生 seq=5', items[4].seq === 5, `实际 ${items[4].seq}`);
const rawLast = fs.readFileSync(process.env.A2A_INBOX_PATH, 'utf8').trim().split('\n').pop();
ok('历史文件未被改写（仍无 seq 字段）', !JSON.parse(rawLast).seq);

// ── 4. 游标默认值与写盘 ──
console.log('\n[4] 游标默认 / 落盘');
ok('默认 position=0', inbox.getCursor().position === 0);
ok('semantics 显式=at-least-once', inbox.getCursor().semantics === 'at-least-once');
inbox.setCursor(0);
ok('游标文件已生成', fs.existsSync(process.env.A2A_INBOX_CURSOR_PATH));

// ── 5. 乱序 ack 不推进（不跳号）──
console.log('\n[5] 乱序 ack 不得跳过未读');
let a = inbox.ack(['t4']);
ok('先标 seq4（t4）→ position 仍为 0', a.position === 0, `实际 ${a.position}`);
ok('advanced=false', a.advanced === false);

// ── 6. 顺序 ack 推进 ──
console.log('\n[6] 连续已读才推进');
a = inbox.ack(['t1']);
ok('标 t1 → position=1', a.position === 1, `实际 ${a.position}`);
a = inbox.ack(['t2']);
ok('标 t2 → position=2', a.position === 2, `实际 ${a.position}`);
a = inbox.ack(['t3']);
ok('标 t3 → 连续段贯通到 4（t4 先前已读）', a.position === 4, `实际 ${a.position}`);

// ── 7. 重启后从 position+1 续跑，无重复无跳过（§5.4 ③ 后半）──
console.log('\n[7] 重启续跑');
inbox = reload();
ok('重启后 position 保持 4', inbox.getCursor().position === 4, `实际 ${inbox.getCursor().position}`);
const rest = inbox.readFrom(undefined);
ok('续读只剩 1 条（seq 5 老记录）', rest.length === 1 && rest[0].seq === 5,
  JSON.stringify(rest.map((x) => x.seq)));
ok('续读不含已消费的 seq<=4', rest.every((x) => x.seq > 4));

// ── 8. 游标倒退被拒 ──
console.log('\n[8] 游标只增不减');
const back = inbox.setCursor(1);
ok('倒退被拒', back.rejected === 'backwards');
ok('position 仍是 4', inbox.getCursor().position === 4);

// ── 9. verify 自检 ──
console.log('\n[9] verify 机器判据');
inbox.ack(['legacy']);
const v = inbox.verify();
ok('verify PASS', v.ok, JSON.stringify(v.checks));
ok('无重号', v.dups.length === 0);
ok('游标=5（吃完全部）', v.position === 5, `实际 ${v.position}`);

// ── 10. 轮转检测 ──
console.log('\n[10] 收件箱轮转 → 不静默');
fs.writeFileSync(process.env.A2A_INBOX_PATH, '');
ok('轮转后 rotation_detected=true', inbox.status().rotation_detected === true);
ok('轮转后 verify 报越界', inbox.verify().checks.cursor_in_range === false);

console.log('\n================================');
console.log(`通过 ${pass} / ${pass + fail}`);
console.log('================================');
if (fail) process.exit(1);
