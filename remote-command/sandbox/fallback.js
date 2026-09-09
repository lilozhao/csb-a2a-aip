/**
 * A2A 远程命令执行 - Fallback 沙箱
 * 纯代码级限制，适用于所有平台
 */

const { spawn } = require('child_process');
const { SandboxProvider } = require('./index.js');

class FallbackSandbox extends SandboxProvider {
  constructor(config = {}) {
    super();
    this.config = {
      timeout: config.timeout || 30000,
      memoryLimit: config.memoryLimit || 128 * 1024 * 1024, // 128MB
      maxOutputSize: config.maxOutputSize || 1024 * 1024, // 1MB
      ...config
    };
  }

  /**
   * 执行命令
   * @param {string} commandType - 命令类型
   * @param {Object} params - 命令参数
   * @returns {Promise<Object>}
   */
  async execute(commandType, params) {
    console.log(`[A2A-CMD] Fallback sandbox executing: ${commandType}`);
    
    const script = this.buildCommandScript(commandType, params);
    
    return new Promise((resolve, reject) => {
      const child = spawn('node', ['-e', script], {
        timeout: this.config.timeout,
        detached: false,
        env: {
          ...process.env,
          // 限制内存
          NODE_OPTIONS: `--max-old-space-size=${Math.floor(this.config.memoryLimit / 1024 / 1024)}`
        }
      });

      let stdout = '';
      let stderr = '';
      let outputSize = 0;

      child.stdout.on('data', (data) => {
        outputSize += data.length;
        if (outputSize > this.config.maxOutputSize) {
          child.kill('SIGTERM');
          reject(new Error('Output size limit exceeded'));
          return;
        }
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          reject(new Error(`Invalid output format: ${stdout}`));
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Process error: ${err.message}`));
      });
    });
  }

  /**
   * 构建命令脚本
   */
  _repoRoot() {
    // 仓库根 = remote-command/sandbox/ → 上两级（csb-a2a-aip 或 shared-a2a-skill 历史目录均可）
    return require('path').join(__dirname, '..', '..');
  }

  buildCommandScript(commandType, params) {
    const safeParams = JSON.stringify(params || {});
    // [2026-09-09] 动态仓库根（替代硬编码 shared-a2a-skill）：env A2A_SKILL_DIR 优先，否则推导
    const repoRoot = JSON.stringify(process.env.A2A_SKILL_DIR || this._repoRoot());
    const backupRoot = JSON.stringify(require('path').join(process.env.A2A_SKILL_DIR || this._repoRoot(), '..', '.a2a-update-backups'));
    const PRELUDE = `const A2A_DIR = ${repoRoot};\nconst BACKUP_ROOT = ${backupRoot};`;

    
    const commandImplementations = {
      'system.status': `
        (() => {
          const os = require('os');
          return {
            success: true,
            data: {
              platform: os.platform(),
              arch: os.arch(),
              uptime: os.uptime(),
              loadavg: os.loadavg(),
              memory: {
                total: os.totalmem(),
                free: os.freemem()
              },
              cpus: os.cpus().length
            }
          };
        })()
      `,
      'skill.list': `
        (() => {
          const fs = require('fs');
          const path = '/home/node/.openclaw/workspace/skills';
          try {
            const items = fs.readdirSync(path, { withFileTypes: true });
            const skills = items
              .filter(item => item.isDirectory())
              .map(item => ({ name: item.name }));
            return { success: true, data: skills };
          } catch (e) {
            return { success: false, error: 'Cannot read skills directory: ' + e.message };
          }
        })()
      `,
      'skill.info': `
        (() => {
          const fs = require('fs');
          const path = '/home/node/.openclaw/workspace/skills/' + ${safeParams}.skill + '/SKILL.md';
          try {
            const content = fs.readFileSync(path, 'utf8');
            return { success: true, data: { name: ${safeParams}.skill, readme: content.substring(0, 500) } };
          } catch (e) {
            return { success: false, error: 'Skill not found: ' + e.message };
          }
        })()
      `,
      'agent.health': `
        ({
          success: true,
          data: {
            status: 'healthy',
            timestamp: Date.now()
          }
        })
      `,
      'agent.configure': `
        (() => {
          const fs = require('fs');
          const path = require('path');
          
          const params = ${safeParams};
          const action = params.action || 'set';
          const configPath = params.configPath;
          const value = params.value;
          
          // 允许修改的配置项白名单
          const ALLOWED_CONFIGS = ['capabilities', 'personality', 'llm.model'];
          
          if (!ALLOWED_CONFIGS.includes(configPath)) {
            return { success: false, error: 'Config path not allowed: ' + configPath };
          }
          
          // 读取 identity.json
          const identityPath = process.env.IDENTITY_PATH || (A2A_DIR + '/identity.json');
          
          try {
            // 备份
            const backupDir = path.dirname(identityPath) + '/.config-backups';
            if (!fs.existsSync(backupDir)) {
              fs.mkdirSync(backupDir, { recursive: true });
            }
            
            let identity = {};
            if (fs.existsSync(identityPath)) {
              identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
              // 备份当前配置
              const backupPath = backupDir + '/identity_' + Date.now() + '.json';
              fs.writeFileSync(backupPath, JSON.stringify(identity, null, 2));
            }
            
            // 获取旧值
            const keys = configPath.split('.');
            let current = identity;
            for (let i = 0; i < keys.length - 1; i++) {
              current = current[keys[i]] || {};
            }
            const oldValue = current[keys[keys.length - 1]];
            
            // 设置新值
            if (action === 'set') {
              current[keys[keys.length - 1]] = value;
            } else if (action === 'merge' && typeof value === 'object') {
              current[keys[keys.length - 1]] = { ...oldValue, ...value };
            }
            
            // 写回文件
            fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2));
            
            return {
              success: true,
              data: {
                configPath,
                action,
                oldValue,
                newValue: value,
                needsRestart: true
              }
            };
          } catch (e) {
            return { success: false, error: 'Config update failed: ' + e.message };
          }
        })()
      `,
      'agent.restart': `
        (() => {
          const { execSync } = require('child_process');
          const fs = require('fs');
          
          try {
            // 备份当前 PID
            const pidFile = (A2A_DIR + '/server.pid');
            let oldPid = null;
            if (fs.existsSync(pidFile)) {
              oldPid = fs.readFileSync(pidFile, 'utf8').trim();
            }
            
            // 执行重启脚本
            const startScript = (A2A_DIR + '/start.sh');
            execSync('bash ' + startScript, { timeout: 30000 });
            
            return {
              success: true,
              message: 'A2A service restart initiated',
              oldPid,
              note: 'Service is restarting, please check health after 3 seconds'
            };
          } catch (e) {
            return { success: false, error: 'Restart failed: ' + e.message };
          }
        })()
      `,
      'agent.update': `
        (() => {
          const { execSync } = require('child_process');
          const fs = require('fs');
          const path = require('path');
          
          const params = ${safeParams};
          const source = params.source || 'github';
          const branch = params.branch || 'main';
          
          try {
            const a2aDir = A2A_DIR;
            const backupDir = BACKUP_ROOT;
            const timestamp = Date.now();
            
            // 创建备份目录（源外，防 cp into itself）
            if (!fs.existsSync(backupDir)) {
              fs.mkdirSync(backupDir, { recursive: true });
            }
            
            const backupPath = backupDir + '/update-' + timestamp + '.tgz';
            
            // 备份当前版本（tar 排除大目录/运行时数据；失败则报错保留现场）
            const base = require('path').dirname(a2aDir);
            const name = require('path').basename(a2aDir);
            try {
              execSync('tar --exclude=node_modules --exclude=logs --exclude=data --exclude=.git -czf ' + backupPath + ' -C ' + base + ' ' + name, { timeout: 60000 });
            } catch (e) {
              return { success: false, error: 'Backup failed: ' + e.message, canRollback: false };
            }
            
            // 执行 git pull
            let pullOutput = '';
            try {
              pullOutput = execSync('git pull ' + source + ' ' + branch, {
                cwd: a2aDir,
                timeout: 60000,
                encoding: 'utf8'
              });
            } catch (gitError) {
              return {
                success: false,
                error: 'Git pull failed: ' + gitError.message,
                backupPath: backupPath,
                canRollback: true
              };
            }
            
            // 检查是否有更新
            if (pullOutput.includes('Already up to date')) {
              return {
                success: true,
                message: 'Already up to date, no changes needed',
                backupPath: backupPath
              };
            }
            
            // 停止旧服务
            const pidFile = a2aDir + '/server.pid';
            if (fs.existsSync(pidFile)) {
              const oldPid = fs.readFileSync(pidFile, 'utf8').trim();
              try {
                execSync('kill ' + oldPid, { timeout: 5000 });
              } catch (e) {
                // 忽略停止错误
              }
            }
            
            // 等待进程停止
            const sleep = (ms) => { const start = Date.now(); while (Date.now() - start < ms) {} };
            sleep(2000);
            
            // 启动新服务
            const startScript = a2aDir + '/start.sh';
            execSync('bash ' + startScript, { timeout: 30000 });
            
            return {
              success: true,
              message: 'A2A service updated and restarted',
              backupPath: backupPath,
              pullOutput: pullOutput.substring(0, 500),
              updated: true,
              note: 'Service is restarting, please check health after 3 seconds'
            };
          } catch (e) {
            return { success: false, error: 'Update failed: ' + e.message };
          }
        })()
      `
    };

    const implementation = commandImplementations[commandType];
    if (!implementation) {
      return `({ success: false, error: 'Unknown command: ${commandType}' })`;
    }

    return `"use strict";\n${PRELUDE}\nconsole.log(JSON.stringify(${implementation}));`;
  }

  getPlatform() {
    return 'fallback';
  }

  async health() {
    return true; // Fallback 总是可用
  }
}

module.exports = { FallbackSandbox };
