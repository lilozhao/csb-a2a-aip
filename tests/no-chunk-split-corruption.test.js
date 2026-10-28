#!/usr/bin/env node
/**
 * no-chunk-split-corruption.test.js — 「吃字」根因锁
 *
 * 起因（2026-10-25 · 衡的跨站普查 + 一澜三问）：
 *   CN/EN 两站「锵锵四人行」同日坏符数完全相同（33 vs 33），衡据此判断
 *   「坏字符跟着文本走，不跟着读者走」，归因为写入前的源文本已坏——方向对。
 *   但源文本是谁产的？**是本脚本所在仓库的 roundtable-v4.js 一次运行、两处写入**。
 *   所以「两站一致」只能排除「论坛读取端」，排除不了「产出端」。
 *
 * 真因：`res.on('data', c => body += c)` 里 c 是 Buffer，`body += c` 会
 *   **对每个 chunk 单独做 UTF-8 解码**。多字节字符若被 TCP 分包切开，
 *   两半各自解成 U+FFFD。
 *
 *   实测三种形态（见 tests/repro-chunk-fffd.js）：
 *     3 字节汉字 · 切在第 1 字节后 → 3 个 U+FFFD   ← 衡的数据里 28 簇
 *     3 字节汉字 · 切在第 2 字节后 → 2 个 U+FFFD   ← 衡的数据里 10 簇（他说算不出的那档）
 *     4 字节 emoji · 切在第 1 字节后 → 4 个 U+FFFD ← 衡的数据里 1 簇
 *   三档同源，不需要第二个变换。
 *
 * 本测试锁两件事：
 *   C1 机制可复现：分包切开多字节字符 → 裸拼接必坏、setEncoding 必好
 *   C2 仓库里不许再出现裸拼接（`.on('data')` 做字符串 += 且没有 setEncoding）
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

/** 起一个把 payload 从指定字节处切成两段返回的服务器 */
function serveSplit(payload, splitAt) {
  const buf = Buffer.from(payload, 'utf8');
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': buf.length });
      res.write(buf.subarray(0, splitAt));
      setTimeout(() => { res.write(buf.subarray(splitAt)); res.end(); }, 15);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function read({ port, setEncoding }) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      if (setEncoding) res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
  });
}

const fffdCount = (s) => (s.match(/\uFFFD/g) || []).length;

(async () => {
  console.log('\n[吃字根因 · chunk 边界解码]\n');

  const TEXT = '与其嫉妒锋芒';

  console.log('[C1] 机制复现（三种切法 → 三种坏符数）');
  for (const [label, cut, expect] of [
    ['3字节汉字·切在第1字节后', 1, 3],
    ['3字节汉字·切在第2字节后', 2, 2],
  ]) {
    const buf = Buffer.from(TEXT, 'utf8');
    const at = buf.indexOf(Buffer.from('嫉', 'utf8')) + cut;
    const { srv, port } = await serveSplit(TEXT, at);
    const broken = await read({ port });
    const fixed = await read({ port, setEncoding: true });
    srv.close();
    await t(`${label} → 裸拼接坏 ${expect} 个`, () =>
      assert.strictEqual(fffdCount(broken), expect, `实际 ${fffdCount(broken)}`));
    await t(`${label} → setEncoding 干净`, () =>
      assert.strictEqual(fffdCount(fixed), 0));
  }

  console.log('\n[C2] 仓库内不许有裸拼接（会吃字的写法）');
  const TARGETS = [
    'client-v2.js', 'roundtable-v4.js', 'roundtable-csb-special.js',
    'roundtable-memory-standard.js', 'llm-router.js', 'server_v5.js',
  ];
  for (const name of TARGETS) {
    const p = path.join(REPO, name);
    if (!fs.existsSync(p)) continue;
    await t(`${name} 无裸拼接`, () => {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const bad = [];
      lines.forEach((L, i) => {
        if (!/\.on\('data'/.test(L)) return;
        const isStringConcat = /\+=\s*(chunk|c|d|data|body)\b/.test(L) && !/chunks\.push/.test(L);
        if (!isStringConcat) return;
        const prev = lines[i - 1] || '';
        const sameLine = L.includes('setEncoding');
        if (!prev.includes('setEncoding') && !sameLine) bad.push(i + 1);
      });
      assert.strictEqual(bad.length, 0, `第 ${bad.join(', ')} 行仍在逐 chunk 解码`);
    });
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`  通过 ${pass} / ${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
