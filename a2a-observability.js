/**
 * A2A-020: 可观测性 (Observability) v1.0
 *
 * 实现:
 *   - 请求追踪 (trace-id 传递)
 *   - Prometheus 指标导出
 *   - 结构化日志
 *   - 健康检查增强
 *   - 审计日志 (A2A-022 合并)
 *
 * 协议: A2A v0.5 §A2A-020
 * 版本: 1.0.0 | 2026-05-10
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================
// 指标收集器 (Prometheus 兼容)
// ============================================
class MetricsCollector {
  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
  }

  // Counter: 累积计数
  inc(name, labels = {}, value = 1) {
    const key = this._key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  // Histogram: 分布统计 (近似)
  observe(name, value, labels = {}) {
    const key = this._key(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, { count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Map() });
    }
    const h = this.histograms.get(key);
    h.count++;
    h.sum += value;
    if (value < h.min) h.min = value;
    if (value > h.max) h.max = value;
    // 动态分桶
    const bucket = Math.pow(2, Math.floor(Math.log2(Math.max(value, 1))));
    h.buckets.set(bucket, (h.buckets.get(bucket) || 0) + 1);
  }

  // Gauge: 瞬时值
  setGauge(name, value, labels = {}) {
    this.gauges.set(this._key(name, labels), value);
  }

  /**
   * 导出 Prometheus 格式
   */
  exportPrometheus() {
    const lines = [];
    const PREFIX = 'a2a_';

    for (const [key, val] of this.counters) {
      lines.push(`${PREFIX}${key} ${val}`);
    }
    for (const [key, val] of this.gauges) {
      lines.push(`${PREFIX}${key} ${val}`);
    }
    for (const [key, h] of this.histograms) {
      lines.push(`${PREFIX}${key}_count ${h.count}`);
      lines.push(`${PREFIX}${key}_sum ${h.sum}`);
      if (h.count > 0) lines.push(`${PREFIX}${key}_min ${h.min}`);
      if (h.count > 0) lines.push(`${PREFIX}${key}_max ${h.max}`);
    }

    return lines.join('\n') + '\n';
  }

  _key(name, labels) {
    const parts = [name];
    const sorted = Object.entries(labels || {}).sort();
    for (const [k, v] of sorted) parts.push(`${k}=${v}`);
    return parts.filter(Boolean).join('{').replace(/[^a-zA-Z0-9_{}=]/g, '_') + (sorted.length ? '}' : '');
  }
}

// ============================================
// 审计日志 (A2A-022)
// ============================================
class AuditLogger {
  constructor(options = {}) {
    // [2026-11-02 P0-0] 不再默认落 /tmp：容器重启即丢账，而它是对外承诺「可审计」的唯一凭据。
    //   解析顺序：显式 logPath → A2A_DATA_DIR → <repo>/data（持久回退）
    //   ⚠️ 不用 fail-fast：生产未设 A2A_DATA_DIR，fail-fast 会让服务起不来。
    //   改为「持久回退 + 路径来源可见」，由 /health 暴露，不静默。
    const repoData = path.join(__dirname, 'data');
    if (options.logPath) {
      this.logPath = options.logPath;
      this.pathSource = 'option';
    } else if (process.env.A2A_DATA_DIR) {
      this.logPath = path.join(process.env.A2A_DATA_DIR, 'a2a-audit.log');
      this.pathSource = 'env';
    } else {
      this.logPath = path.join(repoData, 'a2a-audit.log');
      this.pathSource = 'repo-fallback';
    }
    this.buffer  = [];
    this.maxBuffer = options.maxBuffer || 100;
    this.flushInterval = options.flushInterval || 5000;
    this.writeFailures = 0;
    this.lastWriteError = null;
    this.lastFlushAt = null;
    this._timer = setInterval(() => this.flush(), this.flushInterval);
  }

  record(event) {
    const entry = {
      timestamp: new Date().toISOString(),
      traceId: event.traceId || 'unknown',
      event: event.event || 'unknown',
      agent: event.agent || 'unknown',
      method: event.method || '',
      status: event.status || '',
      durationMs: event.durationMs || 0,
      details: event.details || '',
    };
    this.buffer.push(JSON.stringify(entry));
    if (this.buffer.length >= this.maxBuffer) this.flush();
  }

  flush() {
    if (this.buffer.length === 0) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, this.buffer.join('\n') + '\n');
      // [P0-0] 强制落盘：缓冲 + 无 fsync = 崩溃丢 5s 账
      try {
        const fd = fs.openSync(this.logPath, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch { /* fsync 不受支持时不阻断写入 */ }
      this.buffer = [];
      this.lastFlushAt = Date.now();
    } catch (e) {
      // [P0-0] 写失败必须可见：「降级不该是静默的」
      this.writeFailures += 1;
      this.lastWriteError = e.message;
      console.error('[Audit] 写入失败:', e.message, `(累计 ${this.writeFailures} 次)`);
    }
  }

  /** 审计自身状态（供 /health 消费，不猜） */
  stats() {
    return {
      logPath: this.logPath,
      pathSource: this.pathSource,
      chainCapable: false,
      writeFailures: this.writeFailures,
      lastWriteError: this.lastWriteError,
      lastFlushAt: this.lastFlushAt,
      buffered: this.buffer.length,
    };
  }

  shutdown() {
    clearInterval(this._timer);
    this.flush();
  }
}

// ============================================
// 请求追踪中间件
// ============================================

function traceMiddleware(options = {}) {
  return (req, res, next) => {
    const traceId = req.headers['x-trace-id'] || generateTraceId();
    req.traceId = traceId;
    req.startTime = Date.now();

    res.setHeader('X-Trace-Id', traceId);

    res.on('finish', () => {
      const duration = Date.now() - (req.startTime || Date.now());
      const method = req.body?.method || req.method;
      const status = res.statusCode < 400 ? 'OK' : 'error';

      if (options.metrics) {
        options.metrics.inc('requests_total', { method, status });
        options.metrics.observe('request_duration_ms', duration, { method });
      }

      if (options.auditLogger) {
        // [2026-11-02 P0-0] 必须把发送者带进去：GDI 按 caller_id 算通过率，
        //   不带则全记 'unknown'（现有 233 条历史账全是 unknown 的原因）。
        const body = req.body || {};
        const senderRaw = body?.params?.metadata?.sender
          ?? body?.params?.message?.sender
          ?? body?.envelope?.sender
          ?? null;
        const agentName = (senderRaw && typeof senderRaw === 'object' ? senderRaw.name : senderRaw) || 'unknown';
        options.auditLogger.record({
          traceId, event: 'request',
          agent: String(agentName),
          method: method.toString(),
          status: status,
          // [2026-11-05 K-3] 必须把真实 HTTP 状态码带下去。
          //   过去只传 'OK'/'error'，落盘后 "拒绝(401)" 与 "服务器崩了(500)" 无法区分，
          //   Kindness Score 的分母（总拒绝）因此数不出来 —— 那时算出的 W 恒等于 1.0，是假绿。
          httpStatus: res.statusCode,
          path: req.originalUrl || req.url || '',
          durationMs: duration,
          ip: req.ip || req.socket?.remoteAddress || null,
          details: body?.params?.message?.parts?.[0]?.text?.substring(0, 50) || '',
        });
      }
    });

    next();
  };
}

// ============================================
// 系统收集
// ============================================

function collectSystemMetrics(metrics, taskStore) {
  setInterval(() => {
    const mem = process.memoryUsage();
    metrics.setGauge('process_memory_rss_bytes', mem.rss);
    metrics.setGauge('process_memory_heap_bytes', mem.heapUsed);
    metrics.setGauge('process_uptime_seconds', Math.floor(process.uptime()));

    if (taskStore) {
      const stats = taskStore.getStats();
      metrics.setGauge('tasks_total', stats.total);
      metrics.setGauge('tasks_terminal', stats.terminalTasks);
    }
  }, 30000); // 每 30s
}

// ============================================
// 辅助
// ============================================

function generateTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  MetricsCollector,
  AuditLogger,
  traceMiddleware,
  collectSystemMetrics,
  generateTraceId,
};
