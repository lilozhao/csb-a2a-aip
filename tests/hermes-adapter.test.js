#!/usr/bin/env node
/**
 * hermes-adapter.test.js —— Hermes 注入适配器（C4-H）单元测试 · P0-C
 * 覆盖：默认关 / 双契约 / 禁词 / 三重判据（rc+非空+哨兵）/ 环境白名单清洗 /
 *       工具锁 / 无 shell 拼接 / 超时 / 拒绝识别 / state.db 读回护栏 / TZ / extractReply
 * 依赖：无网络、无外部二进制（runner 全部注入假实现）
 * 用法: node tests/hermes-adapter.test.js
 * 更新 2026-09-16：并入墨丘实测四条（rc靠不住 / 环境清洗 / 工具锁 / state.db 两个坑）
 */
'use strict';
const assert = require('assert');
const H = require('../adapters/hermes');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

const ENV_KEYS = ['A2A_BRIDGE_HERMES', 'A2A_HERMES_BIN', 'A2A_HERMES_HOME', 'A2A_HERMES_TIMEOUT_MS',
  'A2A_HERMES_TOOLS', 'A2A_HERMES_EXTRA_ARGS', 'A2A_HERMES_ENV_EXTRA', 'A2A_HERMES_DB_PATH',
  'A2A_HERMES_CONFIRM_SQL_TEMPLATE', 'A2A_BRIDGE_MAIN_TO', 'A2A_BRIDGE_CHANNEL', 'A2A_BRIDGE_SESSION_KEY'];
const _saved = {};
for (const k of ENV_KEYS) _saved[k] = process.env[k];
function resetEnv() { for (const k of ENV_KEYS) { if (_saved[k] === undefined) delete process.env[k]; else process.env[k] = _saved[k]; } }
function on() { process.env.A2A_BRIDGE_HERMES = 'on'; }
function off() { process.env.A2A_BRIDGE_HERMES = 'off'; }

const ENV = { task: 'git pull --ff-only && npm test', scope: 'shell', delegator: '若兰' };
const TID = 'task_1789520000000_test';

let lastCall = null;
/** 从 prompt 里取哨兵并以「带哨兵的正确输出」应答（模拟真实 Hermes） */
function sentinelOf(prompt) { const m = String(prompt).match(/BRIDGE-OK-[\w-]+/); return m ? m[0] : null; }
function okRunner(text) {
  return async (call) => {
    lastCall = call;
    return { code: 0, stdout: `${text}\n${sentinelOf(call.args[call.args.length - 1])}`, stderr: '' };
  };
}
function rawRunner(fn) { return async (call) => { lastCall = call; return fn(call); }; }

(async () => {
  console.log('\n[hermes-adapter · P0-C]\n');

  await t('1. 默认关：isEnabled()=false', () => { delete process.env.A2A_BRIDGE_HERMES; assert.strictEqual(H.isEnabled(), false); });

  await t('2. 默认关：非 frame 抛错', async () => {
    off();
    await assert.rejects(() => H.inject(ENV, TID), /A2A_BRIDGE_HERMES=off/);
  });

  await t('3. 默认关：frame 返回 {ok:false} 不抛', async () => {
    off();
    const r = await H.inject({ taskId: TID, delegatorLabel: '若兰', envelope: ENV }, {});
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /off/);
  });

  await t('4. 成功注入（三重判据全中 → ok:true）', async () => {
    on();
    H._setRunner(okRunner('已执行：拉取完成，测试 17/17 通过'));
    const r = await H.inject({ taskId: TID, delegatorLabel: '若兰', envelope: ENV }, {});
    assert.strictEqual(r.ok, true);
    assert.match(r.summary, /17\/17/);
    assert.ok(!r.summary.includes('BRIDGE-OK-'), 'summary 应剥掉哨兵行');
    assert.strictEqual(r.result.via, 'hermes-cli');
    assert.strictEqual(r.refused, false);
  });

  await t('5. 成功注入（非 frame → {summary,artifact}）', async () => {
    on();
    H._setRunner(okRunner('OK'));
    const r = await H.inject(ENV, TID);
    assert.strictEqual(r.summary, 'OK');
    assert.strictEqual(r.artifact.via, 'hermes-cli');
  });

  await t('6. 调用参数：bin（绝对路径）+ [-z prompt] + 默认 --safe-mode', async () => {
    on();
    process.env.A2A_HERMES_BIN = '/opt/hermes/.venv/bin/hermes';
    H._setRunner(okRunner('ok'));
    await H.inject(ENV, TID);
    assert.strictEqual(lastCall.bin, '/opt/hermes/.venv/bin/hermes');
    const i = lastCall.args.indexOf('-z');
    assert.ok(i >= 0, '应有 -z');
    assert.ok(lastCall.args[i + 1].includes(TID), 'prompt 应为 -z 的下一个参数');
    assert.ok(lastCall.args.includes('--safe-mode'), '默认应开 safe-mode');
    assert.ok(!lastCall.args.includes('--ignore-rules'), '默认不得开 ignore-rules');
    delete process.env.A2A_HERMES_BIN;
  });

  await t('7. 无 shell 拼接：恶意串仅是 prompt 文本，不被执行', async () => {
    on();
    const evil = { task: 'echo hi ; touch /tmp/pwned-hermes-test && $(id)', scope: 'shell', delegator: 'X' };
    H._setRunner(okRunner('done'));
    await H.inject(evil, TID);
    const i = lastCall.args.indexOf('-z');
    const prompt = lastCall.args[i + 1];
    assert.ok(prompt.includes('touch /tmp/pwned-hermes-test'), '恶意串应原样留在 prompt 文本里');
    // 非 -z 后面那个参数一律是开关（短名），不得被当成命令拆分
    assert.ok(lastCall.args.slice(0, i).every((a) => a.startsWith('-')), 'z 之前必须全是开关');
    assert.strictEqual(require('fs').existsSync('/tmp/pwned-hermes-test'), false);
  });

  await t('8. 三重判据 · rc靠不住：rc=0 + 无哨兵（失败混进 stdout）→ 抛错', async () => {
    on();
    H._setRunner(rawRunner(() => ({ code: 0, stdout: 'Error: 读取 /no/such/file 失败', stderr: '' })));
    await assert.rejects(() => H.inject(ENV, TID), /未命中哨兵/);
  });

  await t('9. 三重判据 · 非零退出 / 空输出 → 抛错', async () => {
    on();
    H._setRunner(rawRunner(() => ({ code: 2, stdout: '', stderr: 'boom: config missing' })));
    await assert.rejects(() => H.inject(ENV, TID), /非零退出.*code=2/s);
    H._setRunner(rawRunner(() => ({ code: 0, stdout: '   \n  ', stderr: '' })));
    await assert.rejects(() => H.inject(ENV, TID), /无输出/);
  });

  await t('10. noSentinel 逃生门：显式关闭哨兵时只看 rc+非空', async () => {
    on();
    H._setRunner(rawRunner(() => ({ code: 0, stdout: 'plain ok', stderr: '' })));
    const r = await H.inject(ENV, TID, { noSentinel: true });
    assert.strictEqual(r.summary, 'plain ok');
  });

  await t('11. 环境白名单清洗：不透传 HERMES_S6_SUPERVISED_CHILD / S6_*', async () => {
    on();
    process.env.HERMES_S6_SUPERVISED_CHILD = '1';
    process.env.S6_SVC_NAME = 'hermes-gateway';
    process.env.A2A_HERMES_HOME = '/opt/data';
    H._setRunner(okRunner('ok'));
    await H.inject(ENV, TID);
    assert.strictEqual(lastCall.env.HERMES_S6_SUPERVISED_CHILD, undefined, 's6 变量必须被清掉');
    assert.strictEqual(lastCall.env.S6_SVC_NAME, undefined);
    assert.strictEqual(lastCall.env.HERMES_HOME, '/opt/data');
    const keys = Object.keys(lastCall.env);
    assert.ok(keys.every((k) => !/^(HERMES_S6_|S6_)/.test(k)), '不得有漏网 s6 变量');
    // 白名单外变量不应透传
    assert.strictEqual(lastCall.env.A2A_BRIDGE_HERMES, undefined);
    delete process.env.HERMES_S6_SUPERVISED_CHILD;
    delete process.env.S6_SVC_NAME;
  });

  await t('12. ENV_EXTRA 显式附加 + 拒绝附加 s6 类键', async () => {
    on();
    process.env.A2A_HERMES_ENV_EXTRA = 'MY_VAR=hello,HERMES_S6_X=bad';
    H._setRunner(okRunner('ok'));
    await H.inject(ENV, TID);
    assert.strictEqual(lastCall.env.MY_VAR, 'hello');
    assert.strictEqual(lastCall.env.HERMES_S6_X, undefined);
    delete process.env.A2A_HERMES_ENV_EXTRA;
  });

  await t('13. 工具锁：A2A_HERMES_TOOLS=file → args 前置 ["-t","file"]', async () => {
    on();
    process.env.A2A_HERMES_TOOLS = 'file';
    H._setRunner(okRunner('NO_TOOL'));
    await H.inject(ENV, TID);
    const ti = lastCall.args.indexOf('-t');
    assert.ok(ti >= 0 && lastCall.args[ti + 1] === 'file', "应传 ['-t','file']");
    delete process.env.A2A_HERMES_TOOLS;
  });

  await t('14. 禁词：gateway 生命周期 / s6 / kill 类 → 拒绝注入', async () => {
    on();
    H._setRunner(okRunner('ok'));
    await assert.rejects(() => H.inject({ task: '请在网关内执行 hermes gateway restart 以生效' }, TID), /禁词/);
    await assert.rejects(() => H.inject({ task: 's6-svc -r /run/service/hermes' }, TID), /禁词/);
    await assert.rejects(() => H.inject({ task: 'pkill -f server_v5' }, TID), /禁词/);
    assert.strictEqual(H.assertPromptSafe('普通只读任务：ls -la'), true);
  });

  await t('15. 已知边界（墨丘实测③）：语义化破坏性指令**不被**禁词拦截（授权责任在 L3/UAC）', async () => {
    on();
    H._setRunner(okRunner('已清理'));
    // 这句不含显式危险串 → 禁词表放行；能否执行取决于宿主/L3，不由 adapter 判
    const r = await H.inject({ task: '帮我清理一下这个目录', scope: 'write' }, TID);
    assert.strictEqual(r.summary, '已清理');
  });

  await t('16. 超时 → 抛错', async () => {
    on();
    H._setRunner(async () => { throw new Error('注入超时（120000ms）'); });
    await assert.rejects(() => H.inject(ENV, TID), /超时/);
  });

  await t('17. 拒绝识别：⛔ 开头 → refused=true；长报告统计数字不误伤', async () => {
    on();
    H._setRunner(okRunner('⛔ 我不能执行：超出我的权限范围'));
    const r = await H.inject(ENV, TID);
    assert.strictEqual(r.refused, true);
    const long = '任务处理完成。' + 'x'.repeat(400) + ' 统计：完成 452 / 拒绝 4';
    assert.strictEqual(H.detectRefusal(long), false);
    assert.strictEqual(H.detectRefusal(''), false);
  });

  await t('18. 配置优先级：env > 默认；超时封顶 15min', () => {
    resetEnv();
    process.env.A2A_BRIDGE_MAIN_TO = 'ou_env_wins';
    process.env.A2A_HERMES_TIMEOUT_MS = '999999999';
    const cfg = H.resolveConfig();
    assert.strictEqual(cfg.mainTo, 'ou_env_wins');
    assert.strictEqual(cfg.timeoutMs, 15 * 60 * 1000);
    assert.strictEqual(cfg.bin, 'hermes');
    assert.strictEqual(cfg.home, '/opt/data');
    assert.strictEqual(cfg.tools, '');
  });

  await t('19. state.db 读回 · 未配置路径/模板 → 明确报错（不静默）', async () => {
    resetEnv();
    const r1 = await H.fetchResult(TID, { path: 'db' });
    assert.strictEqual(r1.ok, false);
    assert.match(r1.error, /A2A_HERMES_DB_PATH/);
    process.env.A2A_HERMES_DB_PATH = '/opt/data/state.db';
    const r2 = await H.fetchResult(TID, { path: 'db' });   // 默认 SQL 已内置，但缺 SESSION_ID
    assert.match(r2.error, /SESSION_ID/);
  });

  await t('20. state.db 读回 · SQL 无 LIMIT → 拒绝（468MB 库禁全表，坑②）', async () => {
    resetEnv();
    process.env.A2A_HERMES_DB_PATH = '/opt/data/state.db';
    process.env.A2A_HERMES_CONFIRM_SQL_TEMPLATE = "SELECT content FROM messages WHERE content LIKE '%{{TASK_ID}}%'";
    const r = await H.fetchResult(TID, { path: 'db' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /LIMIT/);
  });

  await t('21. state.db 读回 · 命中 → extractReply=approve（mock sqlite3）', async () => {
    resetEnv();
    process.env.A2A_HERMES_DB_PATH = '/opt/data/state.db';
    process.env.A2A_HERMES_CONFIRM_SQL_TEMPLATE = "SELECT content FROM messages WHERE content LIKE '%{{TASK_ID}}%' LIMIT 5";
    H._setDbRunner(async (call) => {
      assert.ok(call.sql.includes('LIMIT'), 'SQL 应带 LIMIT');
      assert.strictEqual(call.bin, 'sqlite3');
      return { code: 0, stdout: `确认 #${TID}\n`, stderr: '' };
    });
    const r = await H.fetchResult(TID, { path: 'db', since: '2026-09-16T01:32:00+08:00' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.matched, true);
    assert.deepStrictEqual(r.reply, { action: 'approve' });
  });

  await t('22. TZ 坑（坑①）：since 一律转 UTC ISO', () => {
    assert.strictEqual(H.toUtcIso('2026-09-16T01:32:00+08:00'), '2026-09-15T17:32:00.000Z');
    assert.throws(() => H.toUtcIso('not-a-date'), /无效时间/);
  });

  await t('23. confirm 默认路径 C（保守不自动读）', async () => {
    resetEnv();
    const r = await H.fetchResult(TID);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /路径 C/);
    const r2 = await H.fetchResult(TID, { path: 'webhook' });
    assert.match(r2.error, /尚未实现/);
  });

  await t('30. 默认 SQL（墨丘定稿）：含 LIMIT + role 过滤；SINCE 用 UTC epoch 而非 ISO', async () => {
    resetEnv();
    assert.match(H.DEFAULT_CONFIRM_SQL, /LIMIT/);
    assert.match(H.DEFAULT_CONFIRM_SQL, /role\s*=\s*'user'/);
    process.env.A2A_HERMES_DB_PATH = '/opt/data/state.db';
    process.env.A2A_HERMES_SESSION_ID = 'sess-1';
    H._setDbRunner(async (call) => {
      assert.ok(call.sql.includes("'sess-1'"), '应注入 SESSION_ID');
      assert.ok(call.sql.includes(`m.timestamp >= ${H.toEpochSeconds('2026-09-16T09:00:00+08:00')}`), 'SINCE 必须是 epoch 秒');
      assert.ok(!/T\d\d:\d\d/.test(call.sql), 'SQL 不得含 ISO 字符串时间');
      return { code: 0, stdout: '', stderr: '' };
    });
    const r = await H.fetchResult(TID, { path: 'db', since: '2026-09-16T09:00:00+08:00' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.matched, false);
    resetEnv();
  });

  await t('31. 安全更正：HERMES_WRITE_SAFE_ROOT 必须保留（否则写入边界被打开）', async () => {
    on();
    process.env.HERMES_WRITE_SAFE_ROOT = '/opt/data';
    H._setRunner(okRunner('ok'));
    await H.inject(ENV, TID);
    assert.strictEqual(lastCall.env.HERMES_WRITE_SAFE_ROOT, '/opt/data', '父进程护栏值应保留');
    // 收窄：只允许写专用 scratch
    process.env.A2A_HERMES_WRITE_SAFE_ROOT = '/opt/data/bridge-scratch';
    await H.inject(ENV, TID);
    assert.strictEqual(lastCall.env.HERMES_WRITE_SAFE_ROOT, '/opt/data/bridge-scratch', '应可收窄');
    delete process.env.HERMES_WRITE_SAFE_ROOT;
    delete process.env.A2A_HERMES_WRITE_SAFE_ROOT;
  });

  await t('32. 只读档默认值保守：toolsRead 默认 "file,skills"；无 terminal/code_execution/memory', () => {
    resetEnv();
    const cfg = H.resolveConfig();
    assert.strictEqual(cfg.toolsRead, 'file,skills');
    for (const bad of ['terminal', 'code_execution', 'delegation', 'cronjob', 'memory']) {
      assert.ok(!cfg.toolsRead.split(',').includes(bad), `只读档不得含 ${bad}`);
    }
    assert.strictEqual(cfg.toolsWrite, '', '写档默认空（需宿主策略决定）');
  });

  await t('24. extractReply / stripSentinel / makeSentinel', () => {
    assert.deepStrictEqual(H.extractReply(`拒绝 #${TID}`, TID), { action: 'decline' });
    assert.deepStrictEqual(H.extractReply('随便说点什么', TID), { action: 'none' });
    const s = H.makeSentinel(TID);
    assert.match(s, /^BRIDGE-OK-/);
    assert.strictEqual(H.stripSentinel(`正文\n${s}`, s), '正文');
  });

  await t('25. injectIsolated 同构且禁词不可绕过', async () => {
    on();
    H._setRunner(okRunner('isolated ok'));
    const r = await H.injectIsolated(ENV, TID);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.summary, 'isolated ok');
    await assert.rejects(() => H.injectIsolated({ task: 'killall node' }, TID), /禁词/);
  });

  await t('26. Q1 实测：bin 解析优先绝对路径；显式 env 优先不猜', () => {
    resetEnv();
    process.env.A2A_HERMES_BIN = '/custom/hermes';
    assert.strictEqual(H.resolveHermesBin(), '/custom/hermes');
    delete process.env.A2A_HERMES_BIN;
    const b = H.resolveHermesBin();
    assert.ok(typeof b === 'string' && b.length > 0, '未显式时应回退候选/裸名');
  });

  await t('27. Q4-4：按 scope 选工具档（read→只读档；shell→写档；显式覆盖）', () => {
    resetEnv();
    process.env.A2A_HERMES_TOOLSETS_READ = 'file';
    process.env.A2A_HERMES_TOOLSETS_WRITE = 'file,terminal';
    const cfg = H.resolveConfig();
    assert.strictEqual(H.toolsForScope('read', cfg), 'file');
    assert.strictEqual(H.toolsForScope('notify', cfg), 'file');
    assert.strictEqual(H.toolsForScope('shell', cfg), 'file,terminal');
    assert.strictEqual(H.toolsForScope('write', cfg), 'file,terminal');
    assert.strictEqual(H.toolsForScope('weird', cfg), '');
    assert.strictEqual(H.toolsForScope('shell', { ...cfg, tools: 'explicit' }), 'explicit');
    resetEnv();
  });

  await t('28. Q4-4：三个闸门顺序与默认（safe-mode 开 / ignore-rules 关）', () => {
    resetEnv();
    const base = H.resolveConfig();
    assert.strictEqual(base.safeMode, true);
    assert.strictEqual(base.ignoreRules, false);
    const a1 = H.buildArgs({ prompt: 'P', tools: 'file', cfg: base });
    assert.deepStrictEqual(a1, ['-t', 'file', '--safe-mode', '-z', 'P']);
    process.env.A2A_HERMES_IGNORE_RULES = 'on';
    process.env.A2A_HERMES_SAFE_MODE = 'off';
    const cfg2 = H.resolveConfig();
    const a2 = H.buildArgs({ prompt: 'P', tools: '', cfg: cfg2 });
    assert.deepStrictEqual(a2, ['--ignore-rules', '-z', 'P']);
    resetEnv();
  });

  await t('29. scope=read 注入时自动带只读工具档（端到端）', async () => {
    resetEnv();
    on();
    process.env.A2A_HERMES_TOOLSETS_READ = 'file';
    H._setRunner(okRunner('read ok'));
    const r = await H.inject({ task: 'ls', scope: 'read', delegator: '若兰' }, TID);
    assert.strictEqual(r.summary, 'read ok');
    const ti = lastCall.args.indexOf('-t');
    assert.ok(ti >= 0 && lastCall.args[ti + 1] === 'file', 'read 应自动带只读档');
    assert.strictEqual(r.artifact.tools, 'file');
    resetEnv();
  });

  H._setRunner(null); H._setDbRunner(null); resetEnv();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）\n`);
  if (failed > 0) process.exit(1);
})();
