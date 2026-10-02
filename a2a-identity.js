'use strict';
/**
 * 身份解析与校验（单一真相源）· 2026-10-02
 *
 * [明澈原则 P2「身份不许有默认值」]
 *   身份名必须显式给出，不得静默兜底。
 *
 * 来源优先级（2026-10-02 一澜定案 · 方案 a）：
 *   1. A2A_AGENT_NAME    （新标准名，推荐）
 *   2. CDP_NAME          （历史兼容名，命中时打印 deprecation 提示）
 *   3. identity 文件里的 name —— 仅当上面两者都没有（兼容未改造的老部署）
 *      ⚠️ 若三者全无 → 抛错，拒绝以匿名身份启动。
 *
 * 校验（resolveIdentity）：
 *   - 身份文件路径：A2A_IDENTITY_PATH（env）→ 默认 __dirname/identity.json
 *   - 实际生效的 name = A2A_AGENT_NAME ?? CDP_NAME ?? file.name
 *   - 若 env 给了名字，且与 file.name 都存在且不一致 → 抛错（双写不一致=身份漂移）
 *
 * 注：identity.json 里保留 name 字段（历史原因），但其值应与 env 一致。
 */

const fs = require('fs');
const path = require('path');

let _warnedCdpName = false;

/**
 * 解析环境变量里的身份名（不做文件 IO）。
 * @returns {{ name: string|null, source: 'A2A_AGENT_NAME'|'CDP_NAME'|null }}
 */
function resolveEnvName() {
  const a2a = (process.env.A2A_AGENT_NAME || '').trim();
  if (a2a) return { name: a2a, source: 'A2A_AGENT_NAME' };

  const cdp = (process.env.CDP_NAME || '').trim();
  if (cdp) {
    if (!_warnedCdpName) {
      _warnedCdpName = true;
      console.warn('[identity] ⚠️ 使用了历史变量 CDP_NAME —— 请迁移到 A2A_AGENT_NAME（后者优先；CDP_NAME 将在未来版本移除）');
    }
    return { name: cdp, source: 'CDP_NAME' };
  }
  return { name: null, source: null };
}

/**
 * 解析身份文件路径。
 * @returns {string}
 */
function resolveIdentityPath() {
  return process.env.A2A_IDENTITY_PATH || path.join(__dirname, 'identity.json');
}

/**
 * 完整解析 + 校验身份。
 * @param {{ identityPath?: string, baseDir?: string, requireName?: boolean }} [opts]
 * @returns {{ name: string, emoji: string, file: object, path: string, nameSource: string }}
 * @throws {Error} 文件缺失 / JSON 非法 / 身份名缺失 / env 与文件 name 不一致
 */
function resolveIdentity(opts = {}) {
  const identityPath = opts.identityPath
    || process.env.A2A_IDENTITY_PATH
    || (opts.baseDir ? path.join(opts.baseDir, 'identity.json') : path.join(__dirname, 'identity.json'));

  let file;
  try {
    if (!fs.existsSync(identityPath)) {
      throw new Error(`身份文件不存在（${identityPath}）`);
    }
    file = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  } catch (e) {
    throw new Error(`[identity] 加载身份文件失败（${identityPath}）: ${e.message}`);
  }
  if (!file || typeof file !== 'object') {
    throw new Error(`[identity] 身份文件内容非法（${identityPath}）`);
  }

  const envName = resolveEnvName();
  const requireName = opts.requireName !== false;

  // 一致性校验：env 与 file.name 都在且不等 → 拒绝（防身份漂移）
  if (envName.name && file.name && envName.name !== file.name) {
    throw new Error(
      `[identity] 身份名不一致：A2A_AGENT_NAME/CDP_NAME="${envName.name}" 但 ${identityPath} 的 name="${file.name}"。`
      + ' 存在两个真相源即视为身份漂移，请对齐后重启（identity 不许有默认值/歧义）。'
    );
  }

  const name = envName.name || file.name;
  if (!name) {
    if (requireName) {
      throw new Error(
        '[identity] 身份名缺失：请设置 A2A_AGENT_NAME（推荐）或 CDP_NAME，或在身份文件写 name。'
        + ' 拒绝以匿名身份启动。'
      );
    }
    return { name: null, emoji: file.emoji || '', file, path: identityPath, nameSource: 'none' };
  }

  return {
    name,
    emoji: file.emoji || '',
    file,
    path: identityPath,
    nameSource: envName.source || 'file.name',
  };
}

/**
 * 跨库一致性校验（2026-10-02 一澜补充）
 *
 * 同一实例若安装了多个 csb-* 库（如 csb-a2a-aip + csb-security），
 * 它们的 `.env` 中 A2A_AGENT_NAME 必须一致；否则各库会以不同身份工作
 * （如 A2A 以“若兰”注册、security 以“ruolan”签 AID）→ 信任链撕裂。
 *
 * 用法：在启动装配层调用，传入本库解析出的名字 + 其他库的“解析器”或名字。
 * 本函数只做纯比较，不做 IO，便于各方自行传入。
 *
 * @param {string} selfName 本库解析出的身份名
 * @param {Array<{name:string, source:string}>} others 其他库身份名及来源
 * @returns {{ ok: boolean, mismatches: Array<{name:string, source:string}> }}
 * @throws {Error} 当 selfName 为空时（身份不许有默认值）
 */
function checkCrossRepoConsistency(selfName, others = []) {
  if (!selfName) {
    throw new Error('[identity] checkCrossRepoConsistency: selfName 不能为空（身份不许有默认值）');
  }
  const mismatches = (others || []).filter((o) => o && o.name && o.name !== selfName);
  return { ok: mismatches.length === 0, mismatches };
}

module.exports = { resolveIdentity, resolveEnvName, resolveIdentityPath, checkCrossRepoConsistency };
