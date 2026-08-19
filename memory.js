/**
 * memory.js — CSB-Memory 兼容入口（薄包装）
 *
 * ⚠️ CSB-Memory v1.0（2026-08-19）起，实现已迁移至独立仓库 **csb-memory**（lib/core/）。
 * 本文件仅为兼容旧引用保留，所有能力转发到 csb-memory 的 core 模块。
 *
 * 依赖解析顺序：
 *   1. require('csb-memory')          — npm 安装场景
 *   2. workspace 兄弟目录相对路径     — 本地开发场景（csb-a2a-aip 与 csb-memory 平级）
 *
 * 若直接以 CLI 方式调用（node memory.js ...），会转发到 csb-memory 的 CLI 实现。
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function resolveCorePath() {
  // 场景1: npm 安装的 csb-memory
  try {
    return require.resolve('csb-memory');
  } catch (e) {
    // 忽略，尝试场景2
  }
  // 场景2: workspace 兄弟目录
  const local = path.join(__dirname, '..', 'csb-memory', 'lib', 'core', 'memory.js');
  if (fs.existsSync(local)) {
    return local;
  }
  return null;
}

function loadCore() {
  const corePath = resolveCorePath();
  if (!corePath) {
    throw new Error(
      'CSB-Memory 未找到：请安装 csb-memory 包，或确保 workspace 下存在 csb-memory 仓库（与 csb-a2a-aip 平级）'
    );
  }
  // require.resolve 返回包入口（lib/index.js），需要 .core；直接路径返回 core/memory.js
  if (corePath.endsWith('csb-memory/lib/core/memory.js')) {
    return require(corePath);
  }
  return require(corePath).core;
}

// CLI 兼容：node memory.js <args> → 转发到 csb-memory
if (require.main === module) {
  const corePath = path.join(__dirname, '..', 'csb-memory', 'lib', 'core', 'memory.js');
  if (fs.existsSync(corePath)) {
    const r = spawnSync(process.execPath, [corePath, ...process.argv.slice(2)], {
      stdio: 'inherit',
    });
    process.exit(r.status === null ? 1 : r.status);
  } else {
    console.error('CSB-Memory CLI 未找到：' + corePath);
    process.exit(1);
  }
}

module.exports = loadCore();
