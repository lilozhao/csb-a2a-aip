#!/usr/bin/env node
/**
 * a2a-min-info.js —— A2A 消息最小信息约定（SPEC-A2A-0002 · v1.0）
 *
 * 落点 1/3（《Context Mode 借鉴备忘》核真版）：
 *   A2A 消息新增**可选** `metadata.min_info`（schema / evidence[] / raw_ref / timestamp）。
 *   消息默认可带「结论 + 证据指针」，原文留数据侧按需拉取。
 *   **向后兼容**：不带该字段的消息行为完全不变。
 *
 * 边界（SPEC-A2A-0002 §边界）：仅扩消息 schema + 结构校验，
 *   不读取、不改写审计侧实现（a2a-bridge-core.js 的 evidence 不动）。
 *
 * 需求映射（R1–R8 / A1–A10）见 tests/min-info.test.js。
 */
'use strict';

/** schema 版本标识（SPEC-A2A-0002 v1.0 字段约定） */
const MIN_INFO_SCHEMA = 'csb://min-info/v0.1';
const KNOWN_SCHEMAS = [MIN_INFO_SCHEMA];

/** raw_ref.kind 冻结最小枚举（R7；扩展须走 spec 升版） */
const KIND_ENUM = ['memory-event', 'file-snippet'];

/** 错误码（R4） */
const CODE_SCHEMA_INVALID = 'MIN_INFO_SCHEMA_INVALID';

/** csb:// URI 形态（R3）：csb://<segment>/...，segment 允许字母数字/-/_ */
const CSB_URI_RE = /^csb:\/\/[a-z0-9][a-z0-9._/-]*$/i;

/** 过渡期提示开关（R9 · 默认开） */
function noticeEnabled() {
  const v = process.env.A2A_MIN_INFO_NOTICE;
  if (v === undefined || v === '') return true; // 默认开
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

/**
 * 三态「未携带」（R2）：字段不存在 / undefined / null / 空对象 {} 均视为未携带。
 * @returns {boolean}
 */
function isAbsent(minInfo) {
  if (minInfo === undefined || minInfo === null) return true;
  if (typeof minInfo === 'object' && !Array.isArray(minInfo) && Object.keys(minInfo).length === 0) return true;
  return false;
}

/** 校验单条 evidence 项（R3）：至少含符合 csb:// 形态的字符串 ref */
function validateEvidenceItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, detail: '证据项不是对象' };
  const ref = item.ref;
  if (typeof ref !== 'string' || ref.trim() === '') return { ok: false, detail: '证据项缺字符串 ref' };
  if (!CSB_URI_RE.test(ref)) return { ok: false, detail: `ref 不符合 csb:// 形态：${ref}` };
  return { ok: true };
}

/** 校验 raw_ref.kind（R7） */
function validateKind(kind) {
  if (kind === undefined || kind === null) return { ok: true }; // 选填
  if (typeof kind !== 'string') return { ok: false, detail: 'kind 非字符串' };
  if (!KIND_ENUM.includes(kind)) return { ok: false, detail: `kind 不在冻结枚举 {${KIND_ENUM.join(', ')}}：${kind}` };
  return { ok: true };
}

/**
 * 校验整块 min_info（R3/R4/R7）。
 * @returns {{ok:boolean, code?:string, detail?:string, kindErrors:string[]}}
 */
function validateMinInfo(minInfo) {
  const errors = [];
  if (isAbsent(minInfo)) return { ok: true, absent: true }; // R2：未携带 → 不进校验
  if (typeof minInfo !== 'object' || Array.isArray(minInfo)) {
    return { ok: false, code: CODE_SCHEMA_INVALID, detail: 'min_info 非对象' };
  }

  // schema 必填且为已知版本
  if (typeof minInfo.schema !== 'string' || minInfo.schema.trim() === '') {
    errors.push('缺 schema');
  } else if (!KNOWN_SCHEMAS.includes(minInfo.schema)) {
    errors.push(`未知 schema：${minInfo.schema}`);
  }

  // timestamp 必填（R4；发送方生成，处理器不兜底）
  if (typeof minInfo.timestamp !== 'string' || minInfo.timestamp.trim() === '') {
    errors.push('缺 timestamp');
  }

  // evidence 必填 + 每项合法
  if (!Array.isArray(minInfo.evidence) || minInfo.evidence.length === 0) {
    errors.push('缺 evidence 数组或为空');
  } else {
    minInfo.evidence.forEach((it, i) => {
      const r = validateEvidenceItem(it);
      if (!r.ok) errors.push(`evidence[${i}]：${r.detail}`);
    });
  }

  // raw_ref（选填）结构 + kind
  if (minInfo.raw_ref !== undefined && minInfo.raw_ref !== null) {
    const rr = minInfo.raw_ref;
    if (typeof rr !== 'object' || Array.isArray(rr)) {
      errors.push('raw_ref 非对象');
    } else {
      const kr = validateKind(rr.kind);
      if (!kr.ok) errors.push(`raw_ref.${kr.detail}`);
      if (rr.pointer !== undefined && typeof rr.pointer !== 'string') errors.push('raw_ref.pointer 非字符串');
    }
  }

  if (errors.length) return { ok: false, code: CODE_SCHEMA_INVALID, detail: errors.join('; ') };
  return { ok: true };
}

/**
 * 从消息 metadata 中提取 min_info（R1：原样保留）。
 * 兼容 min_info 直接放在 metadata 下（一期约定）。
 */
function extractMinInfo(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  return metadata.min_info;
}

/**
 * 处理一条消息的 min_info（R1/R2/R4/R9）。
 * @returns {{ok:boolean, error?:object, minInfo?:object, notice?:string}}
 */
function processMinInfo(metadata) {
  const minInfo = extractMinInfo(metadata);

  if (isAbsent(minInfo)) {
    // R2：按既有行为；R9：过渡期提示（不改行为）
    const notice = noticeEnabled() ? 'min_info_absent' : undefined;
    return { ok: true, absent: true, notice };
  }

  const v = validateMinInfo(minInfo);
  if (!v.ok) {
    // R4：返回 InvalidParams（含 code）
    return {
      ok: false,
      error: { type: 'InvalidParams', code: v.code, detail: v.detail },
    };
  }

  // R1：原样保留透传（不解析 raw_ref —— R5/R6 见 a2a-expansion.js）
  return { ok: true, minInfo };
}

module.exports = {
  MIN_INFO_SCHEMA,
  KNOWN_SCHEMAS,
  KIND_ENUM,
  CODE_SCHEMA_INVALID,
  CSB_URI_RE,
  isAbsent,
  validateEvidenceItem,
  validateKind,
  validateMinInfo,
  extractMinInfo,
  processMinInfo,
  noticeEnabled,
};