/**
 * A2A Introspect 端点 - 可热加载到任何 A2A Server
 * 
 * 使用方式：
 *   const { attachIntrospect } = require('./a2a-introspect-middleware');
 *   attachIntrospect(app, { workspace: '/path/to/workspace' });
 */

const { A2AIntrospect } = require('./a2a-introspect.js');
const { warmReject, CODES } = require('./warm-reject.js');

/**
 * attachIntrospect — 挂 /a2a/introspect
 *
 * [2026-11-09 W-51 事故] 苏念实测：`/a2a/introspect` 完全无鉴权，
 *   经公网隧道可读，且自报 hasSoul/hasMemory/hasUser/hasSelfState/hasHeartbeat 全 false。
 *
 * 两处修：
 *   ① **鉴权**：与 /tasks 同口径（外部须 Bearer），
 *      并且同样**不信任「环回 + 转发头」**（隧道会把来源伪装成 127.0.0.1）。
 *      checkAuth 由调用方注入，本模块不自造第二套鉴权口径。
 *   ② **workspace 默认值**：原来调用方传 `process.cwd()`，而服务 cwd 是子目录
 *      (`csb-a2a-aip/`)，SOUL.md / MEMORY.md 都在上一级 → 全部探测失败。
 *      改为「从 cwd 逐级向上找，找到同时有 SOUL.md 或 MEMORY.md 的那一级」。
 *
 * @param {object} app
 * @param {{workspace?:string, checkAuth?:(req)=>boolean, auditFile?:string}} options
 */
function attachIntrospect(app, options = {}) {
  const introspect = new A2AIntrospect(options);
  const checkAuth = typeof options.checkAuth === 'function' ? options.checkAuth : null;

  app.get('/a2a/introspect', (req, res) => {
    if (checkAuth && !checkAuth(req)) {
      // 走 K-1 的唯一出口，不自己拼字段（同 why-endpoint 的做法）：
      //   拒绝的形状必须**一处**定义。两处各写一份，一定会漂移，
      //   而漂移的表现是「内网拒绝五字段齐全、公网拒绝只有一句 error」——最难查的那种不一致。
      //   2026-11-09 守门自检抓到本文件就是漏点（就地 401，没走 warm-reject 出口）。
      try {
        const body = warmReject({
          code: CODES.AUTH_REQUIRED,
          // [2026-11-09] 口径已变：不再"内网免令牌"（隧道把所有人伪装成环回）。
          //   文案必须与实现一致 —— 明德 18:50 就是照旧文案读出了误导性的"内网免令牌"。
          reason: 'introspect 与 /tasks 同口径：一律需 Bearer 令牌（2026-11-09 起取消内网豁免），本请求未携带有效令牌（401）',
          next_step: '在请求头加 Authorization: Bearer <A2A_TASKS_TOKEN>（向本实例主人私下索取）后重试',
          agent: req.headers['x-agent-id'] || 'unknown',
          action: `GET ${req.baseUrl || ''}${req.path || '/a2a/introspect'}`,
          request_id: req.headers['x-request-id'] || null,
          // 审计落点可覆盖：单测/临时实例不该把拒绝写进生产日志。
          auditFile: options.auditFile,
        });
        return res.status(401).json(body);
      } catch (e) {
        // 契约不满足 → 退到最小响应，但把异常记下来，不把「我们的形状错误」算成对方的错。
        // `_warm: false` 是**诚实的自报**：这条不是温暖拒绝出口造的，别让它冒充合格件。
        // 仍然保留 next_step —— 即便是兜底，也不许给对方一句「不行」就完事。
        try { console.warn('[a2a/introspect] 温暖拒绝构造失败，退到简式 401:', e.message); } catch { /* noop */ }
        return res.status(401).json({
          error: 'auth_required', _warm: false,
          reason: 'introspect 鉴权未通过，且本次温暖拒绝构造异常（属本实例内部问题，不是你的请求有问题）',
          next_step: '在请求头加 Authorization: Bearer <A2A_TASKS_TOKEN> 后重试；仍失败请告知本实例主人',
        });
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(introspect.generate());
  });

  console.log('[A2A] ✅ introspect endpoint: /a2a/introspect' + (checkAuth ? '（已挂鉴权）' : '（⚠️ 未挂鉴权）'));
  return introspect;
}

module.exports = { attachIntrospect, A2AIntrospect };
