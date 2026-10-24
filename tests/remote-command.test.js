const config = require('../config/loader');
/**
 * A2A 远程命令执行 - 单元测试
 */

const { Signer } = require('../remote-command/signer.js');
const { Validator } = require('../remote-command/validator.js');
const { RateLimiter } = require('../remote-command/ratelimit.js');
const { CommandQueue } = require('../remote-command/queue.js');

// 测试签名模块
async function testSigner() {
  console.log('\n[Test] Signer Module');
  
  const signer = new Signer('test-secret-for-unit-tests-only-64chars-placeholder-abcdef0123456789'); // P0-1：密钥需 ≥16 字符
  
  const request = {
    command: { type: 'system.status', params: {} },
    sender: { name: '若兰', url: 'http://test:3100' },
    timestamp: Date.now(),
    nonce: signer.generateNonce()
  };
  
  // 签名
  const signature = signer.signRequest(request);
  console.log('  ✓ Sign request');
  
  // 验证
  const valid = signer.verifyRequest(request, signature);
  console.assert(valid, 'Signature should be valid');
  console.log('  ✓ Verify request signature');
  
  // 响应签名
  const response = {
    command_id: 'cmd_001',
    status: 'success',
    timestamp: Date.now()
  };
  const respSig = signer.signResponse(response);
  console.log('  ✓ Sign response');
  
  const respValid = signer.verifyResponse(response, respSig);
  console.assert(respValid, 'Response signature should be valid');
  console.log('  ✓ Verify response signature');
}

// 测试验证器
async function testValidator() {
  console.log('\n[Test] Validator Module');
  
  const validator = new Validator();
  
  // 测试白名单
  const isWhitelisted = validator.isWhitelisted('若兰', config.getAgentUrl('ruolan'));
  console.assert(isWhitelisted, '若兰 should be whitelisted');
  console.log('  ✓ Whitelist check');
  
  // 测试命令白名单
  const isAllowed = validator.isCommandAllowed('system.status');
  console.assert(isAllowed, 'system.status should be allowed');
  console.log('  ✓ Command whitelist');
  
  // 测试不允许的命令
  const isNotAllowed = validator.isCommandAllowed('exec.shell');
  console.assert(!isNotAllowed, 'exec.shell should not be allowed');
  console.log('  ✓ Blocked command check');
  
  // 测试完整验证
  const request = {
    sender: { name: '若兰', url: config.getAgentUrl('ruolan') },
    command: { type: 'system.status' }
  };
  const result = validator.validate(request);
  console.assert(result.valid, 'Valid request should pass validation');
  console.log('  ✓ Full validation');
}

// 测试频率限制
async function testRateLimiter() {
  console.log('\n[Test] Rate Limiter Module');
  
  const limiter = new RateLimiter({ maxPerMinute: 3 });
  const sender = '测试发送者';
  
  // 前3次应该通过
  for (let i = 0; i < 3; i++) {
    const result = limiter.checkLimit(sender, 'system.status');
    console.assert(result.allowed, `Request ${i + 1} should be allowed`);
  }
  console.log('  ✓ Requests within limit');
  
  // 第4次应该被限制
  const blocked = limiter.checkLimit(sender, 'system.status');
  console.assert(!blocked.allowed, 'Request 4 should be blocked');
  console.log('  ✓ Rate limit enforced');
  console.log(`    Block reason: ${blocked.reason}`);
}

// 测试命令队列
async function testCommandQueue() {
  console.log('\n[Test] Command Queue Module');
  
  const queue = new CommandQueue({ maxConcurrent: 1 });
  const sender = '测试发送者';
  
  let executionOrder = [];
  
  // 添加3个命令到队列
  const promises = [];
  for (let i = 0; i < 3; i++) {
    const cmd = { id: `cmd_${i}`, type: 'test' };
    const promise = queue.enqueue(cmd, sender, async (c, s) => {
      executionOrder.push(c.id);
      await new Promise(r => setTimeout(r, 100)); // 模拟执行时间
      return { result: c.id };
    });
    promises.push(promise);
  }
  
  console.log('  ✓ Commands enqueued');
  
  // 等待所有完成
  await Promise.all(promises);
  
  console.assert(executionOrder.length === 3, 'All commands should execute');
  console.log('  ✓ All commands executed');
  console.log(`    Execution order: ${executionOrder.join(', ')}`);
}

// 运行所有测试
async function runTests() {
  console.log('================================');
  console.log('A2A Remote Command Unit Tests');
  console.log('================================');
  
  try {
    await testSigner();
    await testSignerFailClosed();
    await testValidator();
    await testRateLimiter();
    await testCommandQueue();
    
    console.log('\n================================');
    console.log('All tests passed! ✅');
    console.log('================================');
  } catch (e) {
    console.error('\n❌ Test failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}


// P0-1 回归（2026-10-24 · 明鉴评审）：弱默认密钥 → fail-closed
async function testSignerFailClosed() {
  console.log('\n[Test] Signer fail-closed (P0-1)');

  const saved = { secret: process.env.A2A_SHARED_SECRET, allow: process.env.A2A_ALLOW_INSECURE_SIGNER };
  try {
    // 1. 无 secret 且无 dev 开关 → 必须 throw（旧行为是 warn 后用公开常量继续）
    delete process.env.A2A_SHARED_SECRET;
    delete process.env.A2A_ALLOW_INSECURE_SIGNER;
    let threw = null;
    try { new Signer(); } catch (e) { threw = e; }
    console.assert(threw && threw.code === 'A2A_SECRET_MISSING', '无密钥必须拒绝构造');
    console.log('  ✓ 无 A2A_SHARED_SECRET → 拒绝启动');

    // 2. 公开常量不再被使用（旧版会落到 'dev-mode-insecure-key-...'）
    console.assert(!threw || !String(threw.message).includes('dev-mode-insecure-key'), '错误信息不应回落到公开常量');
    console.log('  ✓ 不再回落到公开常量');

    // 3. 显式 dev 开关 → 放行，但密钥必须是随机的（两个实例不同 → 不是人人可伪造）
    process.env.A2A_ALLOW_INSECURE_SIGNER = '1';
    const d1 = new Signer();
    const d2 = new Signer();
    console.assert(d1.insecure === true, 'dev 模式应标记 insecure');
    console.assert(d1.secret !== d2.secret, 'dev 模式密钥应随机（非固定公开值）');
    console.log('  ✓ dev 开关放行且密钥随机');

    // 4. 过短密钥拒绝
    // 注意：signer.js 的 SHARED_SECRET 是**模块加载时**捕获的默认参数，
    // 运行期改 process.env 不会生效 —— 这里显式传参，避免测了个假象。
    delete process.env.A2A_ALLOW_INSECURE_SIGNER;
    let weak = null;
    try { new Signer({ secret: 'short' }); } catch (e) { weak = e; }
    console.assert(weak && weak.code === 'A2A_SECRET_WEAK', '过短密钥必须拒绝');
    console.log('  ✓ 过短密钥拒绝');

    // 5. 正常密钥 → 可签可验，且带指纹
    const ok = new Signer({ secret: 'a'.repeat(64) });
    console.assert(/^[0-9a-f]{8}$/.test(ok.fingerprint), '应输出 8 位密钥指纹');
    const req = { command: { type: 'x' }, sender: { name: 'n' }, timestamp: 1, nonce: 'abc' };
    console.assert(ok.verifyRequest(req, ok.signRequest(req)), '正常密钥签名可自验');
    console.log('  ✓ 正常密钥可签可验 + 指纹');
  } finally {
    if (saved.secret === undefined) delete process.env.A2A_SHARED_SECRET; else process.env.A2A_SHARED_SECRET = saved.secret;
    if (saved.allow === undefined) delete process.env.A2A_ALLOW_INSECURE_SIGNER; else process.env.A2A_ALLOW_INSECURE_SIGNER = saved.allow;
  }
}

runTests();
