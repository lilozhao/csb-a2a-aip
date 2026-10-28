#!/usr/bin/env node
/**
 * repro-chunk-fffd.js — 证明「坏符」的确切成因
 *
 * 假设：`res.on('data', c => body += c)` 里 c 是 Buffer，
 *       `body += c` 会**对每个 chunk 单独做 utf8 解码**。
 *       一个 3 字节汉字若被 TCP chunk 边界切开，两半各自解成 U+FFFD。
 *
 * 复现目标：让「嫉」（U+5AC9 = E5 AB 89）在第 1 字节后被切开，
 *          看读到的是不是字符串 "与其妒���锋芒"（3 个 U+FFFD）。
 */

const http = require('http');

const TARGET = '与其嫉妒锋芒';       // 嫉 = E5 AB 89
const buf = Buffer.from(TARGET, 'utf8');
const jidu = Buffer.from('嫉', 'utf8');          // 3 字节
const cutAt = buf.indexOf(jidu);                  // 「嫉」的起始字节偏移

// 在「嫉」的第 1 字节之后切开，模拟最坏情况的分包
const splitPoint = cutAt + 1;

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
      // 故意分两段发，且切在汉字中间
      res.write(buf.subarray(0, splitPoint));
      setTimeout(() => { res.write(buf.subarray(splitPoint)); res.end(); }, 30);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function readBroken(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });      // ← 病根：逐 chunk 解码
      res.on('end', () => resolve(body));
    });
  });
}

function readFixed(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.setEncoding('utf8');                    // ← 修法 A：交给 StringDecoder 处理跨界
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
  });
}

function readFixed2(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      const chunks = [];                           // ← 修法 B：收 Buffer 再整体解码
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

(async () => {
  const { srv, port } = await serve();
  const broken = await readBroken(port);
  const fixedA = await readFixed(port);
  const fixedB = await readFixed2(port);
  srv.close();

  const shown = (s) => s.replace(/\uFFFD/g, '⟪FFFD⟫');
  const count = (s) => (s.match(/\uFFFD/g) || []).length;

  console.log('原文本          :', TARGET);
  console.log('切开点          : 字节', cutAt, '→', splitPoint, '（「嫉」第 1 字节之后）');
  console.log();
  console.log('① 现状 body+=chunk :', shown(broken), '| FFFD', count(broken));
  console.log('② setEncoding      :', shown(fixedA), '| FFFD', count(fixedA));
  console.log('③ Buffer.concat    :', shown(fixedB), '| FFFD', count(fixedB));
  console.log();

  const ok = count(broken) === 3 && count(fixedA) === 0 && count(fixedB) === 0;
  console.log(ok
    ? '✅ 复现成功：现状坏 3 个 FFFD（与论坛上「与其妒���锋芒」逐字吻合），两种修法都干净'
    : '❌ 未复现到预期形态，需再查');
  process.exit(ok ? 0 : 1);
})();
