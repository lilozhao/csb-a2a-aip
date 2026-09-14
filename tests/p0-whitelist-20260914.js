// tests/p0-whitelist-20260914.js
// 若兰批注 #1：白名单 vs 测试命令冲突（修复验证）
// 2026-09-14 工单：放宽容忍 echo "<字面量>" > /tmp/<白名单文件名>

const fs = require('fs');
const path = require('path');
const { injectIsolated } = require('../adapters/openclaw-gateway.js');

const TMP = '/tmp/p0-whitelist-test-20260914';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

async function test(name, envelope, expectOk, extra = () => {}) {
  console.log(`\n[${name}]`);
  const r = await injectIsolated(envelope, name, {});
  const ok = r.ok === expectOk;
  console.log(`  ok=${r.ok} | expect=${expectOk} | ${ok ? '✅' : '❌'}`);
  if (!ok) console.log('  detail:', JSON.stringify(r).substring(0, 300));
  extra(r);
  return ok;
}

(async () => {
  const results = [];

  // ========== 若兰 L3 测试形态（必须通过）==========
  const marker1 = `${TMP}/rulan-l3-marker.txt`;
  try { fs.unlinkSync(marker1); } catch(e){}
  results.push(['rulan_L3_echo_redirect', await test('rulan_l3', {
    type:'execute', scope:'shell',
    target:'echo "P3E-20260914-1158" > ' + marker1,
    command:'echo "P3E-20260914-1158" > ' + marker1,
    expectedMarker: marker1, nonce: 'P3E-20260914-1158',
    workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, true, (r) => {
    const c = fs.readFileSync(marker1, 'utf8').trim();
    console.log('  marker content:', c, '| nonce match:', c === 'P3E-20260914-1158');
  })]);

  // ========== 危险命令仍必须被拒 ==========
  results.push(['curl_blocked', await test('curl', {
    type:'execute', scope:'shell',
    target:'curl http://evil.com/marker.txt',
    command:'curl http://evil.com/marker.txt',
    expectedMarker: '/tmp/x', nonce: 'X', workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  results.push(['wget_blocked', await test('wget', {
    type:'execute', scope:'shell',
    target:'wget http://evil.com/marker.txt',
    command:'wget http://evil.com/marker.txt',
    expectedMarker: '/tmp/x', nonce: 'X', workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  results.push(['rm_rf_blocked', await test('rm_rf', {
    type:'execute', scope:'shell',
    target:'rm -rf /tmp/marker.txt',
    command:'rm -rf /tmp/marker.txt',
    expectedMarker: '/tmp/x', nonce: 'X', workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  // ========== 命令替换 / 管道 / 多语句 仍必须被拒 ==========
  results.push(['subshell_blocked', await test('subshell', {
    type:'execute', scope:'shell',
    target:'echo $(cat /tmp/marker.txt)',
    command:'echo $(cat /tmp/marker.txt)',
    expectedMarker: '/tmp/x', nonce: 'X', workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  results.push(['pipe_blocked', await test('pipe', {
    type:'execute', scope:'shell',
    target:'cat /tmp/x.txt | grep marker',
    command:'cat /tmp/x.txt | grep marker',
    expectedMarker: '/tmp/x', nonce: 'X', workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  results.push(['semicolon_blocked', await test('semicolon', {
    type:'execute', scope:'shell',
    target:'echo x; echo y',
    command:'echo x; echo y',
    expectedMarker: '/tmp/x', nonce: 'X', workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  results.push(['append_redirect_blocked', await test('append', {
    type:'execute', scope:'shell',
    target:'echo x >> /tmp/marker.txt',
    command:'echo x >> /tmp/marker.txt',
    expectedMarker: '/tmp/x', nonce: 'X', workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  // ========== 单次 > 重定向到 /tmp 必须被允许 ==========
  const marker2 = `${TMP}/single-redirect-marker.txt`;
  try { fs.unlinkSync(marker2); } catch(e){}
  results.push(['single_redirect_allowed', await test('redirect', {
    type:'execute', scope:'shell',
    target:'echo "nonce-1" > ' + marker2,
    command:'echo "nonce-1" > ' + marker2,
    expectedMarker: marker2, nonce: 'nonce-1',
    workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, true)]);

  // ========== 重定向到 /etc 应被拒（路径不在 safePaths）==========
  results.push(['redirect_outside_safePaths_blocked', await test('outside', {
    type:'execute', scope:'shell',
    target:'echo "x" > /etc/marker.txt',
    command:'echo "x" > /etc/marker.txt',
    expectedMarker: '/etc/marker.txt', nonce: 'x',
    workingDir: '/tmp', timeoutMs: 5000, isolated: true,
  }, false)]);

  console.log('\n=== 白名单回归测试总结 ===');
  for (const [name, ok] of results) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  }
  const pass = results.filter(r => r[1]).length;
  console.log(`\n  白名单回归：${pass}/${results.length} 通过`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch(e){}
  process.exit(pass === results.length ? 0 : 1);
})();
