#!/usr/bin/env node
/**
 * feishu-creds.js — 飞书应用凭据统一解析（2026-09-16）
 *
 * 背景：2026-09-15 的安全提交（e67da9e）把 App ID/Secret 从脚本内联移除，
 * 改为只读 process.env。但 gateway 的 cron/isolated 执行环境里这两个变量为空，
 * 导致圆桌/推送脚本「静默失败」（错误被 catch 吞掉，仍打印"已推送 ✅"）。
 *
 * 解析顺序（与 roundtable 的 resolveApiKey 保持一致）：
 *   1) 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（非空才算）
 *   2) ~/.openclaw/openclaw.json → channels.feishu（含 accounts.default）
 *   3) workspace/.env（已 gitignore）
 *
 * 本文件不内联任何密钥，仅做本地读取。
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.OPENCLAW_CONFIG || '/home/node/.openclaw/openclaw.json';
const ENV_PATH = process.env.WORKSPACE_ENV || path.join(__dirname, '..', '.env');

function _readEnvFile(key) {
  try {
    if (!fs.existsSync(ENV_PATH)) return '';
    const m = fs.readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

function _readOpenclawFeishu() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const f = cfg?.channels?.feishu || {};
    const acct = f?.accounts?.[f.defaultAccount || 'default'] || {};
    return {
      appId: f.appId || acct.appId || '',
      appSecret: f.appSecret || acct.appSecret || '',
    };
  } catch { return {}; }
}

function resolveFeishuCreds() {
  const cfg = _readOpenclawFeishu();
  const appId = (process.env.FEISHU_APP_ID || '').trim()
    || cfg.appId
    || _readEnvFile('FEISHU_APP_ID');
  const appSecret = (process.env.FEISHU_APP_SECRET || '').trim()
    || cfg.appSecret
    || _readEnvFile('FEISHU_APP_SECRET');
  return { appId, appSecret };
}

module.exports = { resolveFeishuCreds };
