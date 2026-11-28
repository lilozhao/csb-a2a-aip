#!/usr/bin/env node
/**
 * aip-warmth.js — 人类余温 API 的入参守卫（纯函数，可单测）
 * ------------------------------------------------------------------
 * 为什么单独抽出来（2026-11-28）：
 *   余温分是「信任度量」的输入。原来 POST /aip/human-warmth 无鉴权且
 *   `contribution` 不设界，谁都能给任意 userId 刷任意数（含负数、1e9、NaN、字符串）。
 *   可被外部任意改写的度量不是度量。
 *
 *   抽成纯函数是为了让「路由里跑的逻辑」和「测试里验的逻辑」是同一份代码——
 *   否则测试验的是一个副本，改坏了照样全绿（本仓 11-28 刚踩过同类）。
 *
 * 维护：若兰 · 2026-11-28
 */
'use strict';

const DEFAULT_CONTRIBUTION = 10;

/** 从 env 读上限；非法值回落到 100 */
function maxFromEnv(env = process.env) {
  const n = Number(env.AIP_WARMTH_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

/**
 * 校验并归一化余温入参。
 * @param {object} body 请求体
 * @param {{max?:number}} [opts]
 * @returns {{ok:true, userId:string, userName:string, contribution:number}
 *          |{ok:false, status:number, error:string, got?:any, max?:number}}
 */
function parseWarmthBody(body, opts = {}) {
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 100;
  const b = body && typeof body === 'object' ? body : {};

  const userId = b.userId;
  if (!userId || typeof userId !== 'string') {
    return { ok: false, status: 400, error: 'userId required' };
  }
  const userName = typeof b.userName === 'string' ? b.userName : '';

  const raw = b.contribution;
  if (raw === undefined || raw === null) {
    return { ok: true, userId, userName, contribution: DEFAULT_CONTRIBUTION };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, status: 400, error: 'contribution must be an integer', got: typeof raw, max };
  }
  if (raw < 1 || raw > max) {
    return { ok: false, status: 400, error: `contribution out of range [1, ${max}]`, got: raw, max };
  }
  return { ok: true, userId, userName, contribution: raw };
}

module.exports = { parseWarmthBody, maxFromEnv, DEFAULT_CONTRIBUTION };
