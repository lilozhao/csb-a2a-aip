// vantage 判定单元测试（与明德部署同口径）
// 2026-11-08 建立：两边各自部署同一份 csb-a2a-aip，口径必须同源可测。
function compute(req) {
  const h = req.headers['x-csb-vantage'];
  if (h) return { vantage: String(h), vantageSource: 'declared' };
  const bv = req.body && req.body.metadata && req.body.metadata.vantage;
  if (bv) return { vantage: String(bv), vantageSource: 'declared' };
  const raw = String((req.socket && req.socket.remoteAddress) || req.ip || '');
  const ip = raw.replace(/^::ffff:/i, '');
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || /^127\./.test(ip);
  return { vantage: isLoopback ? 'loopback' : 'direct', vantageSource: 'socket' };
}

const cases = [
  ['带头 frp:7102',      { headers: { 'x-csb-vantage': 'frp:7102' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }, 'frp:7102', 'declared'],
  ['body.metadata 自报', { headers: {}, body: { metadata: { vantage: 'frp:7102' } }, socket: { remoteAddress: '1.2.3.4' } }, 'frp:7102', 'declared'],
  ['无头、环回 v4',      { headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }, 'loopback', 'socket'],
  ['无头、::1',          { headers: {}, socket: { remoteAddress: '::1' } }, 'loopback', 'socket'],
  ['公网直连',           { headers: {}, socket: { remoteAddress: '::ffff:47.1.2.3' } }, 'direct', 'socket'],
];

let pass = 0;
for (const [name, req, expV, expS] of cases) {
  const r = compute(req);
  const ok = r.vantage === expV && r.vantageSource === expS;
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(16)} → vantage=${r.vantage} source=${r.vantageSource}  期望 ${expV}/${expS}`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
