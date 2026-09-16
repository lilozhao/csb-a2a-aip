#!/usr/bin/env node
/**
 * hermes-adapter.test.js —— Hermes 注入适配器（C4-H）单元测试 · P0-C
 * 覆盖：默认关 / 双契约 / 禁词 / 三重判据（rc+非空+哨兵）/ 环境白名单清洗 /
 *       工具锁 / 无 shell 拼接 / 超时 / 拒绝识别 / state.db 读回护栏 / TZ / extractReply
 * 依赖：无网络、无外部二进制（runner 全部注入假实现）
 * 用法: node tests/hermes-adapter.test.js
 * 更新 2026-09-16：并入墨丘实测四条（rc靠不住 / 环境清洗 / 工具锁 / state.db 两个坑）
 * 更新 2026-09-16b：修复 operator .env 污染导致的 4 个假红（#19/#30/#31/#34）
 */
'use strict';
const assert = require('assert');

// ── 隔离 operator 的 .env ─────────────────────────────────────────────
// Hermes 会把 /opt/data/.env 载入 session 环境；测试进程若继承了它（A2A_*/HERMES_*），
// 「配置缺省」类用例会假红（#19/#30/#31/#34：干净环境 35/35，带 operator .env 32/35）。
// ⚠️ 必须在 require 适配器之前清理——adapters/hermes.js 模块级读取 A2A_HERMES_TIMEOUT_MS
//    （DEFAULT_TIMEOUT_MS），require 后再清已来不及。
const ENV_PATTERN = /^(A2A_|HERMES_)/;
function scrubEnv() { for (const k of Object.keys(process.env)) if (ENV_PATTERN.test(k)) delete process.env[k]; }
scrubEnv();

const H = require('../adapters/hermes');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

// 每个用例回到干净起点（清掉上一条用例 / operator 注入的 A2A_*·HERMES_*）
function resetEnv() { scrubEnv(); }
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
    assert.strictEqual(cfg.timeoutMs, 15 * 60 * 1000, '14天/超大值应封顶 15min');
    // bin 会自动探测（本机若存在 /opt/hermes/.venv/bin/hermes 则返回绝对路径）→ 只断言非空
    assert.ok(typeof cfg.bin === 'string' && cfg.bin.length > 0, 'bin 应非空');
    assert.strictEqual(cfg.home, '/opt/data');
    assert.strictEqual(cfg.tools, '');
  });

  await t('19. state.db 读回 · 未配置路径/模板 → 明确报错（不静默）', async () => {
    resetEnv();
    const r1 = await H.fetchResult(TID, { path: 'db' });
    assert.strictEqual(r1.ok, false);
    assert.match(r1.error, /A2A_HERMES_DB_PATH/);
    process.env.A2A_HERMES_DB_PATH = '/opt/data/state.db';
    const r2 = await H.fetchResult(TID, { path: 'db' });   // 默认模板已内置（CHAT_ID 口径），但缺 CHAT_ID
    assert.match(r2.error, /CHAT_ID/);
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

  await t('30. 默认 SQL（CHAT_ID 口径）：子查询限会话+外层裁时间；含 LIMIT + role；SINCE 用 epoch', async () => {
    resetEnv();
    assert.match(H.DEFAULT_CONFIRM_SQL, /LIMIT/);
    assert.match(H.DEFAULT_CONFIRM_SQL, /role\s*=\s*'user'/);
    assert.match(H.DEFAULT_CONFIRM_SQL, /chat_id\s*=\s*'\{\{CHAT_ID\}\}'/, '默认应为 CHAT_ID 子查询口径（SESSION_ID 会过期）');
    assert.match(H.DEFAULT_CONFIRM_SQL, /sessions/);
    assert.match(H.DEFAULT_CONFIRM_SQL, /ORDER BY started_at DESC/, '按有索引的 started_at 排序');
    assert.ok(!/last_activity_at/.test(H.DEFAULT_CONFIRM_SQL), '不得用无索引的 last_activity_at');
    process.env.A2A_HERMES_DB_PATH = '/opt/data/state.db';
    process.env.A2A_HERMES_CHAT_ID = 'oc-1';
    H._setDbRunner(async (call) => {
      assert.ok(call.sql.includes("'oc-1'"), '应注入 CHAT_ID');
      assert.ok(call.sql.includes(`m.timestamp >= ${H.toEpochSeconds('2026-09-16T09:00:00+08:00')}`), 'SINCE 必须是 epoch 秒');
      assert.ok(!/T\d\d:\d\d/.test(call.sql), 'SQL 不得含 ISO 字符串时间');
      // 子查询里不得加时间下界（否则会漏掉「早于 SINCE 开启」的会话）
      const sub = call.sql.slice(call.sql.indexOf('SELECT id FROM sessions'), call.sql.indexOf('AND m.timestamp'));
      assert.ok(!/started_at\s*>=/.test(sub), '子查询不应加 started_at 下界');
      return { code: 0, stdout: '', stderr: '' };
    });
    const r = await H.fetchResult(TID, { path: 'db', since: '2026-09-16T09:00:00+08:00' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.matched, false);
    // 无 since 时 epoch 占位符必须为 0（不是 NULL：`>= NULL` 恒假）
    H._setDbRunner(async (call) => {
      assert.ok(call.sql.includes('m.timestamp >= 0'), '缺 since 时应为 0，不能是 NULL');
      assert.ok(!/NULL/.test(call.sql), 'SQL 不得出现 NULL');
      return { code: 0, stdout: '', stderr: '' };
    });
    const r2 = await H.fetchResult(TID, { path: 'db' });
    assert.strictEqual(r2.ok, true);
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

  await t('35. 超时跟随信封声明（信封 30min → 封顶 15min；无声明→用默认 5min）', async () => {
    resetEnv();
    on();
    const calls = [];
    H._setRunner(async (call) => { calls.push(call.timeoutMs); return { code: 0, stdout: `ok\n${sentinelOf(call.args[call.args.length - 1])}`, stderr: '' }; });
    // 信封声明 30min → 封顶 15min
    await H.inject({ task: 'ls', scope: 'read', timeoutMs: 30 * 60 * 1000 }, TID);
    assert.strictEqual(calls[0], 15 * 60 * 1000, '应封顶 15min');
    // 无声明 → 默认 5min
    await H.inject({ task: 'ls', scope: 'read' }, TID);
    assert.strictEqual(calls[1], 5 * 60 * 1000, '默认应为 5min（原 120s 实测不够）');
    // 显式 opts 优先
    await H.inject({ task: 'ls', scope: 'read' }, TID, { timeoutMs: 420000 });
    assert.strictEqual(calls[2], 420000);
    resetEnv();
  });

  await t('33. node:sqlite 端到端：真建库 + 默 runner 读回（不依赖 sqlite3 CLI）', async () => {
    const ns = H.loadNodeSqlite();
    if (!ns || typeof ns.DatabaseSync !== 'function') { console.log('     （跳过：本机无 node:sqlite）'); return; }
    const os = require('os');
    const p = require('path').join(os.tmpdir(), `csb-hermes-db-${Date.now()}.sqlite`);
    try { require('fs').unlinkSync(p); } catch (_) {}
    const db = new ns.DatabaseSync(p);
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT, role TEXT)");
    db.exec("INSERT INTO messages (content, role) VALUES ('确认 #" + TID + "', 'user')");
    db.close();
    const r = await H._internals.defaultDbRunner({ dbPath: p, sql: "SELECT content FROM messages WHERE role='user' LIMIT 5" });
    assert.strictEqual(r.code, 0, '查询应成功: ' + r.stderr);
    assert.ok(r.stdout.includes(TID), '应读回正文');
    try { require('fs').unlinkSync(p); } catch (_) {}
  });

  await t('34. {{CHAT_ID}} 占位符：可替换；未配置时报错；不会过期（优于 SESSION_ID）', async () => {
    resetEnv();
    process.env.A2A_HERMES_DB_PATH = '/opt/data/state.db';
    process.env.A2A_HERMES_CONFIRM_SQL_TEMPLATE = "SELECT content FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE chat_id='{{CHAT_ID}}' ORDER BY started_at DESC LIMIT 1) AND content LIKE '%{{TASK_ID}}%' LIMIT 5";
    const miss = await H.fetchResult(TID, { path: 'db' });
    assert.match(miss.error, /CHAT_ID/);
    process.env.A2A_HERMES_CHAT_ID = 'oc_test_chat';
    H._setDbRunner(async (call) => { assert.ok(call.sql.includes("'oc_test_chat'")); return { code: 0, stdout: '', stderr: '' }; });
    const r = await H.fetchResult(TID, { path: 'db' });
    assert.strictEqual(r.ok, true);
    resetEnv();
  });

  await t('36. 确认投递腿：默认关（A2A_HERMES_SEND=off）→ 诚实失败', async () => {
    resetEnv();
    const r = await H.invokeTool('x', 'tok', { args: { to: 'oc_x', message: '确认 #t1' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /A2A_HERMES_SEND/);
  });

  await t('37. 确认投递腿：开启后 argv = [send,--to,<to>,--text,<text>]（整 token 替换）', async () => {
    resetEnv();
    process.env.A2A_HERMES_SEND = 'on';
    H._setRunner(async (call) => { lastCall = call; return { code: 0, stdout: 'msg_id=om_1', stderr: '' }; });
    const r = await H.invokeTool('x', 'tok', { args: { to: 'oc_x', message: '确认 #t1' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.via, 'hermes-cli-send');
    assert.deepStrictEqual(lastCall.args, ['send', '--to', 'oc_x', '--text', '确认 #t1']);
    assert.ok(!lastCall.args.some((a) => a.includes('{')), '占位符应全部被替换');
  });

  await t('38. 确认投递腿：自定义 A2A_HERMES_SEND_ARGS 生效（适配宿主真实语法）', async () => {
    resetEnv();
    process.env.A2A_HERMES_SEND = 'on';
    process.env.A2A_HERMES_SEND_ARGS = 'send,--chat,{to},--body,{text},--plain';
    H._setRunner(async (call) => { lastCall = call; return { code: 0, stdout: '', stderr: '' }; });
    await H.invokeTool('x', 'tok', { args: { to: 'oc_y', message: 'hi' } });
    assert.deepStrictEqual(lastCall.args, ['send', '--chat', 'oc_y', '--body', 'hi', '--plain']);
  });

  await t('39. 确认投递腿：恶意文本只作为一个 argv token（不做 shell 拼接/拆分）', async () => {
    resetEnv();
    process.env.A2A_HERMES_SEND = 'on';
    const evil = '确认 #t1 ; rm -rf /tmp/pwned-send && $(id)';
    H._setRunner(async (call) => { lastCall = call; return { code: 0, stdout: '', stderr: '' }; });
    await H.invokeTool('x', 'tok', { args: { to: 'oc_z', message: evil } });
    assert.strictEqual(lastCall.args[4], evil, '文本应原样作为单个 token');
    assert.strictEqual(lastCall.args.length, 5, '不得被拆分出额外 token');
    assert.strictEqual(require('fs').existsSync('/tmp/pwned-send'), false);
  });

  await t('40. 确认投递腿：失败路径（非零退出 / 缺目标 / 空文本）→ ok:false', async () => {
    resetEnv();
    process.env.A2A_HERMES_SEND = 'on';
    H._setRunner(async () => ({ code: 3, stdout: '', stderr: 'unknown command: send' }));
    const r1 = await H.invokeTool('x', 'tok', { args: { to: 'oc_x', message: 'hi' } });
    assert.strictEqual(r1.ok, false);
    assert.match(r1.error, /code=3.*unknown command/s);
    const r2 = await H.invokeTool('x', 'tok', { args: { message: 'hi' } });
    assert.strictEqual(r2.ok, false);
    const r3 = await H.invokeTool('x', 'tok', { args: { to: 'oc_x', message: '' } });
    assert.strictEqual(r3.ok, false);
    assert.match(r3.error, /空确认文本/);
  });

  H._setRunner(null); H._setDbRunner(null); resetEnv();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）\n`);
  if (failed > 0) process.exit(1);
})();
