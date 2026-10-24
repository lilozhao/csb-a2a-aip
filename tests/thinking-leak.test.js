#!/usr/bin/env node
/**
 * thinking-leak.test.js — 思维链泄漏回归测试
 *
 * 起因：明德 2026-10-24 升级 5.1.0 后实测，自动应答正文里带回
 *   `<think>We need answer in Chinese 50-200 chars, likely acknowledge self-check...`
 * 根因：llm-router.js 的 `content || reasoning_content` 降级 + 未剥离 think 标签。
 *
 * 本文件锁死两条不变量：
 *   I1 任何对外正文，think 块必须被剥离（含未闭合残尾）
 *   I2 reasoning_content 永不作为对外正文（正文为空 → null，走上层兜底）
 *
 * 跑法：node --test tests/thinking-leak.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { stripThinking, pickReply } = require(path.join(__dirname, '..', 'llm-router.js'));

test('I1: 成对 think 标签被剥离', () => {
  assert.strictEqual(
    stripThinking('<think>We need answer in Chinese 50-200 chars</think>收到，已记录。'),
    '收到，已记录。'
  );
});

test('I1: 未闭合的 think 残尾被截断（明德实测形态：推理被 max_tokens 截断）', () => {
  assert.strictEqual(stripThinking('<think>We need answer in Chinese 50-200 c'), '');
});

test('I1: 思维链在正文之前，正文保留', () => {
  assert.strictEqual(
    stripThinking('<thinking>先想想</thinking>\n\n这是正文。'),
    '这是正文。'
  );
});

test('I1: thinking / reasoning / analysis 标签同样剥离', () => {
  assert.strictEqual(stripThinking('<reasoning>x</reasoning>正文'), '正文');
  assert.strictEqual(stripThinking('<analysis>x</analysis>正文'), '正文');
});

test('I1: 大小写混合也要剥离', () => {
  assert.strictEqual(stripThinking('<THINK>abc</THINK>结果'), '结果');
});

test('I1: 无标签的正常正文一字不改', () => {
  assert.strictEqual(stripThinking('正常回复内容。'), '正常回复内容。');
});

test('I1: 正文里出现 thought 字样不能被误伤', () => {
  assert.strictEqual(stripThinking('这个 thought 很重要'), '这个 thought 很重要');
});

test('I2: content 为空 + reasoning 有值 → 返回 null（绝不泄漏）', () => {
  const data = { choices: [{ message: { content: '', reasoning_content: '<think>内部推理</think>' } }] };
  assert.strictEqual(pickReply(data, 'Test'), null);
});

test('I2: content 为空 + 纯 reasoning（无标签）→ 仍返回 null', () => {
  const data = { choices: [{ message: { content: '', reasoning_content: '纯推理内容' } }] };
  assert.strictEqual(pickReply(data, 'Test'), null);
});

test('II: content 带 think → 剥离后返回', () => {
  const data = { choices: [{ message: { content: '<think>x</think>正文' } }] };
  assert.strictEqual(pickReply(data, 'Test'), '正文');
});

test('兼容非 OpenAI 响应格式（response / text / content 字段）', () => {
  assert.strictEqual(pickReply({ response: '来自 response 字段' }, 'Test'), '来自 response 字段');
  assert.strictEqual(pickReply({ text: '<think>y</think>来自 text' }, 'Test'), '来自 text');
});

test('异常输入不崩', () => {
  assert.strictEqual(pickReply(null, 'Test'), null);
  assert.strictEqual(pickReply({}, 'Test'), null);
  assert.strictEqual(stripThinking(null), '');
  assert.strictEqual(stripThinking(undefined), '');
});
