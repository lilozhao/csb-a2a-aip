#!/usr/bin/env node
/**
 * test-core.js — 身份层阶段二 模块级自测（不碰服务）
 * 覆盖：D1 英文名策略 / 保留字 / F1 AID 验签 + 防重放 / F3 covenant / F3 breach 状态机 + 不可删
 * 运行：node identity/test/test-core.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const S = require('../core.js');
const csb = require('../../../csb-security/lib/index.js');

const TMP = path.join(require('os').tmpdir(), 'csb-test-breach-' + Date.now() + '.jsonl');
if (fs.existsSync(TMP)) fs.unlinkSync(TMP);

let pass = 0, fail = 0;
function t(cond, label) { console.log((cond ? '  ✅ ' : '  ❌ ') + label); cond ? pass++ : fail++; }
function sec(s) { console.log('\n' + '─'.repeat(64) + '\n' + s); }

// ---- 明德的密钥对（测试用，不入库）----
const { publicJwk, privateKey, publicKey } = csb.generateKeyPair('mingde-aid-20261008');

sec('D1 · agent_id 英文名策略');
t(S.assertAgentId('mingde@47.121.28.125:3100').ok, '英文名 → 通过');
const cjk = S.assertAgentId('明德@47.121.28.125:3100');
t(!cjk.ok && cjk.error === 'agent_id_must_be_ascii', '中文名 → 拒（agent_id_must_be_ascii）');
t(!!cjk.hint && cjk.hint.includes('英文名'), '中文名 → 带「请用英文名」提示：' + cjk.hint);
t(!S.assertAgentId('mingde').ok, '缺 @host:port → 拒');
t(!S.assertAgentId('').ok, '空 → 拒');

sec('保留字校验（读 reserved-names.json）');
t(S.reserved().size > 100, '保留键加载：' + S.reserved().size + ' 个');
t(!S.checkReserved('明德🎋', 'name').ok, '「明德🎋」→ 拒（emoji 归一化命中「明德」）');
t(!S.checkReserved(' 明 德 ', 'name').ok, '「 明 德 」→ 拒（空白归一化）');
t(!S.checkReserved('csb-official', 'name').ok, '「csb-official」→ 拒（前缀保留）');
t(S.checkReserved('mingde-new', 'name').ok, '新名「mingde-new」→ 通过');

sec('passport_uri  csb://<owner>/<name>');
const gp = S.buildPassport('example-owner', 'mingde-demo');
t(gp.ok && gp.uri === 'csb://example-owner/mingde-demo', '生成：' + (gp.uri || gp.error));
t(!S.buildPassport('硅隐', 'mingde-demo').ok, 'owner 用中文 → 拒');
t(!S.parsePassport('csb://lilozhao/mingde').ok, 'owner 命中 B 类保留（lilozhao）→ 拒');
t(!S.parsePassport('csb://lilozhao/明德').ok, 'name 用中文 → 拒');
t(!S.parsePassport('http://x/y').ok, '非 csb:// → 拒');

sec('保留名认领（R2：本人可认领，他人不可复用）');
const now = new Date().toISOString();
t(S.claimReservedName('明德', publicJwk).ok, '本人凭公钥认领「明德」→ ok');
const other = csb.generateKeyPair('fake-' + Date.now());
const fakeAid = csb.generateAID({
  agentId: 'fake@1.2.3.4:3100', name: '明德',
  endpoint: 'http://1.2.3.4:3100/a2a/json-rpc', publicJwk: other.publicJwk
}, other.privateKey);
const rfake = S.verifyIdentitySubmission(fakeAid, { nonce: crypto.randomBytes(6).toString('hex'), timestamp: now });
t(!rfake.valid && rfake.error === 'name_reserved', '他人用「明德」名 → 拒（未认领，' + rfake.error + '）');

sec('F1 · AID 验签 + 防重放（复用 csb-security）');
const aid = csb.generateAID({
  agentId: 'mingde@47.121.28.125:3100', name: '明德', emoji: '🎋',
  endpoint: 'http://47.121.28.125:3100/a2a/json-rpc',
  capabilities: ['forum.post'], trustLevel: 'L2', publicJwk
}, privateKey);
const r1 = S.verifyIdentitySubmission(aid, { nonce: 'n-' + crypto.randomBytes(6).toString('hex'), timestamp: now }, { owner: 'example-owner' });
t(r1.valid, '正提交 → 通过（passport=' + r1.passport_uri + '）');

const tampered = JSON.parse(JSON.stringify(aid)); tampered.name = '冒名者';
const rt = S.verifyIdentitySubmission(tampered, { nonce: crypto.randomBytes(6).toString('hex'), timestamp: now });
t(!rt.valid && /aid_bad_signature|name_reserved/.test(JSON.stringify(rt)), '改 name → 拒（' + rt.error + '）');

const cnAid = JSON.parse(JSON.stringify(aid)); cnAid.agent_id = '明德@47.121.28.125:3100';
// 重签以隔离"策略"与"验签"两件事
const cnSigned = csb.aid.signAID({ ...cnAid, signature: undefined }, privateKey);
const rc = S.verifyIdentitySubmission(cnSigned, { nonce: crypto.randomBytes(6).toString('hex'), timestamp: now });
t(!rc.valid && rc.error === 'agent_id_must_be_ascii', '中文 agent_id（签名有效）→ 仍被策略拒');

const nonce = 'replay-' + crypto.randomBytes(4).toString('hex');
t(S.verifyIdentitySubmission(aid, { nonce, timestamp: now }).valid, '同 nonce 首次 → 通过');
const r2 = S.verifyIdentitySubmission(aid, { nonce, timestamp: now });
t(!r2.valid && r2.error === 'nonce_nonce_replay', '同 nonce 第二次 → 拒（' + r2.error + '）');
const oldTs = new Date(Date.now() - 3600e3).toISOString();
const r3 = S.verifyIdentitySubmission(aid, { nonce: crypto.randomBytes(6).toString('hex'), timestamp: oldTs });
t(!r3.valid && r3.error === 'ts_time_drift', '1 小时前 ts → 拒（' + r3.error + '）');

sec('F3-a · covenant（独立文件 + 只把 hash 进 AID）');
t(S.loadCovenant().length > 100, '契约文本加载：' + S.loadCovenant().length + ' 字符');
const cov = S.signCovenant(aid.agent_id, privateKey);
t(!!cov.covenant_hash, 'covenant_hash = ' + cov.covenant_hash.slice(0, 16) + '…');
t(S.verifyCovenant(cov, publicKey).valid, '契约验签 → 通过');
const covBad = { ...cov, covenant_hash: cov.covenant_hash.slice(0, -4) + 'AAAA' };
t(!S.verifyCovenant(covBad, publicKey).valid, '改 hash → 验签失败');
const aid2 = S.attachCovenantToAID(aid, cov, privateKey);
t(csb.verifyAID(aid2).valid, '挂 covenant 后重签 AID → 仍验签通过（csb-security verifyAID）');
t(!!aid2.covenant && aid2.covenant.hash === cov.covenant_hash, 'AID 里只挂 hash 元组（无全文）：' + JSON.stringify(aid2.covenant).slice(0, 80) + '…');
t(!('covenant_text' in aid2), 'AID 不含契约全文');

sec('F3-b · breach 状态机 + 不可删 + 哈希链');
const br = new S.BreachRegistry({ logPath: TMP, privateKey, publicKey });
const p1 = br.propose({ agentId: 'fake-agent@x:1', reason: '冒充他人身份', evidence: 'thread/123', reporter: aid.agent_id });
t(p1.ok && p1.state === 'proposed', '发起 → proposed (' + p1.breach_id + ')');
t(br.isBlocked('fake-agent@x:1') === false, 'proposed 状态下不 block 认领');
t(!br.transition(p1.breach_id, 'cleared').ok === false, 'proposed → cleared 允许');
// 重新走一条到 effective
const p2 = br.propose({ agentId: 'bad@x:2', reason: '盗用凭证', reporter: aid.agent_id });
t(br.transition(p2.breach_id, 'effective', { actor: '治理复核' }).ok, 'proposed → effective 允许');
t(br.isBlocked('bad@x:2') === true, 'effective → 认领被 block');
t(!br.transition(p2.breach_id, 'proposed', {}).ok, 'effective → proposed 非法（拒）');
t(br.transition(p2.breach_id, 'cleared', { actor: '申诉成立' }).ok, 'effective → cleared 允许');
t(!br.isBlocked('bad@x:2'), 'cleared → 不再 block');
t(typeof br.delete === 'undefined', '🔒 无 delete 方法（记录不可删）');
const v = br.verify();
t(v.valid, '哈希链校验通过（' + v.count + ' 条）');

// 篡改检测：直接改文件里一条
const raw = fs.readFileSync(TMP, 'utf8').split('\n').filter(Boolean);
const obj = JSON.parse(raw[0]); obj.details.reason = '（被改过）';
raw[0] = JSON.stringify(obj);
fs.writeFileSync(TMP, raw.join('\n') + '\n');
const br2 = new S.BreachRegistry({ logPath: TMP, privateKey, publicKey });
const v2 = br2.verify();
t(!v2.valid && v2.reason === 'entry_tampered', '🔒 篡改第 1 条 → 链校验检出（' + v2.reason + ' @' + v2.brokenAt + '）');

fs.unlinkSync(TMP);
sec(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
