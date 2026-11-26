#!/usr/bin/env node
'use strict';
/**
 * inbox-cursor.js —— Q7 游标的命令行入口（2026-11-26）
 *
 * 用法：
 *   node scripts/inbox-cursor.js status            # 游标状态（total/position/lag/unread）
 *   node scripts/inbox-cursor.js verify            # §5.4 ③ 自检：seq 无重号+游标不跳号
 *   node scripts/inbox-cursor.js from [pos]        # 从 pos+1 续读（缺省=当前游标）
 *   node scripts/inbox-cursor.js ack <id|taskId...># 标记已读并推进游标
 *   node scripts/inbox-cursor.js advance <pos>     # 手工推进（只增不减）
 *
 * 退出码：0 正常 / 1 自检失败 / 2 参数错
 */
const path = require('path');
const inbox = require(path.join(__dirname, '..', 'a2a-inbox.js'));

const [cmd, ...args] = process.argv.slice(2);

function pad(n, w = 4) { return String(n).padStart(w, ' '); }

switch (cmd) {
  case 'status': {
    const s = inbox.status();
    console.log(`📥 收件箱游标  semantics=${s.semantics}`);
    console.log(`──────────────────────────────`);
    console.log(`  total     ${pad(s.total)}`);
    console.log(`  lastSeq   ${pad(s.lastSeq)}`);
    console.log(`  position  ${pad(s.position)}  (已消费) ${s.acked_at || '—'}`);
    console.log(`  lag       ${pad(s.lag)}  条未消费`);
    console.log(`  unread    ${pad(s.unread)}  条 seen=false`);
    if (s.rotation_detected) console.log(`  ⚠️  rotation_detected：position 越界，收件箱被轮转过，需人工确认重置`);
    break;
  }
  case 'verify': {
    const v = inbox.verify();
    console.log(`🔍 Q7 自检  ${v.ok ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`──────────────────────────────`);
    for (const [k, ok] of Object.entries(v.checks)) console.log(`  ${ok ? '✅' : '❌'} ${k}`);
    console.log(`  total=${v.total} lastSeq=${v.lastSeq} position=${v.position} contiguousSeen=${v.contiguousSeen} bad_lines=${v.bad_lines}`);
    if (v.dups.length) console.log(`  重号: ${JSON.stringify(v.dups.slice(0, 5))}`);
    if (v.gaps.length) console.log(`  缺口: ${JSON.stringify(v.gaps.slice(0, 5))}`);
    process.exit(v.ok ? 0 : 1);
  }
  case 'from': {
    const pos = args.length ? Number(args[0]) : inbox.getCursor().position;
    const rows = inbox.readFrom(pos);
    console.log(`▶️  seq > ${pos} 共 ${rows.length} 条`);
    for (const r of rows.slice(0, 20)) {
      console.log(`  #${pad(r.seq)} ${r.ts} ${r.kind} ${r.from && r.from.name} ${r.seen ? '✓' : '·'} ${String(r.text || '').slice(0, 40).replace(/\n/g, ' ')}`);
    }
    if (rows.length > 20) console.log(`  … 另有 ${rows.length - 20} 条`);
    break;
  }
  case 'ack': {
    if (!args.length) { console.error('用法: ack <id|taskId...>'); process.exit(2); }
    const r = inbox.ack(args);
    console.log(`✅ 标记 ${r.marked} 条 · position=${r.position}${r.advanced ? '（已推进）' : '（未推进：不连续）'}`);
    break;
  }
  case 'advance': {
    if (!args.length) { console.error('用法: advance <pos>'); process.exit(2); }
    const c = inbox.setCursor(Number(args[0]));
    if (c.rejected) { console.error(`❌ 拒绝倒退：${JSON.stringify(c)}`); process.exit(1); }
    console.log(`✅ position=${c.position} @ ${c.acked_at}`);
    break;
  }
  default:
    console.error('用法: status | verify | from [pos] | ack <ids...> | advance <pos>');
    process.exit(2);
}
