// Registry starter - run with: node start-registry.js
const { fork } = require('child_process');
const path = require('path');

const child = fork(path.join(__dirname, 'registry.js'), [], {
  // 2026-10-29 硅隐令：3099 收回只绑环回，对外统一走 https://registry.csbc.lilozkzy.top（nginx→127.0.0.1:3099）
  // 原为硬编码 '0.0.0.0'，绕过 registry.js 的 REGISTRY_HOST 环境变量；改为可被 env 覆盖，默认 127.0.0.1
  env: { ...process.env, REGISTRY_PORT: process.env.REGISTRY_PORT || '3099', REGISTRY_HOST: process.env.REGISTRY_HOST || '127.0.0.1' },
  stdio: 'inherit'
});

console.log(`Registry started (PID: ${child.pid})`);
