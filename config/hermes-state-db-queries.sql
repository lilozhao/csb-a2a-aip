-- ═══════════════════════════════════════════════════════════════
-- Hermes state.db · L3 confirm 读回查询集（墨丘实测定稿 · 2026-09-16）
-- ═══════════════════════════════════════════════════════════════
-- 来源：墨丘 → 若兰 回执（task_1789523380920_f0bc30e7），全部已实跑 + EXPLAIN 验证
-- 用途：adapters/hermes.js · fetchResult(path:'db')
-- 落档：若兰 🌸 2026-09-16
--
-- 只读打开：sqlite3 -readonly /opt/data/state.db
--   con = sqlite3.connect('file:/opt/data/state.db?mode=ro', uri=True)
--   PRAGMA busy_timeout=8000
-- ═══════════════════════════════════════════════════════════════

-- ★ 2026-09-16 更新：**内置默认模板已改为本条 CHAT_ID 子查询口径**
--   （原 `session_id=?` 口径需写死会话 id，而它每会话新生成 → 会过期）
--   · 子查询按 chat_id 取最近 5 个会话，**刻意不加 started_at 下界**（否则漏「早于 SINCE 开启」的会话）
--   · 外层仍按 m.timestamp 裁剩；缺 since 时 epoch 占位符 → 0（不是 NULL，`>= NULL` 恒假）
--   · `sessions.last_activity_at` 无索引，勿用
--
-- ── ① 主路径：按「会话 + 时间段」检索消息原文（实测 6ms，走索引）──
-- EXPLAIN: SEARCH m USING INDEX idx_messages_session (session_id=? AND timestamp>?)
-- 换成 adapter 占位符：:SESSION_ID → {{SESSION_ID}} · :SINCE → {{SINCE_EPOCH}} · :TASK_ID → {{TASK_ID}}
SELECT m.id, m.role, m.content, m.timestamp,
       datetime(m.timestamp,'unixepoch') AS ts_utc
FROM messages m
WHERE m.session_id  = :SESSION_ID              -- 已知主人会话（见 ②）
  AND m.timestamp  >= :SINCE                   -- ★ UTC epoch（秒，REAL）——不是 ISO 字符串！
  AND m.role       = 'user'
  AND m.content LIKE '%' || :TASK_ID || '%'
ORDER BY m.timestamp DESC
LIMIT 5;                                        -- 强制，勿去

-- ── ② 会话发现（拿到 :SESSION_ID）──
-- EXPLAIN: SEARCH sessions USING INDEX idx_sessions_source_id (source=?)
-- ⚠️ 用 started_at（有 idx_sessions_started）；last_activity_at 无索引 → 拿它做范围过滤=全表扫描
SELECT id, chat_id, chat_type, datetime(started_at,'unixepoch') AS started_utc
FROM sessions
WHERE source='feishu' AND started_at >= :SINCE
ORDER BY started_at DESC LIMIT 20;

-- ── ③ 全文检索（可选；中文短词用 trigram 表）──
SELECT m.id, m.session_id, m.role, substr(m.content,1,200) AS preview,
       datetime(m.timestamp,'unixepoch') AS ts_utc
FROM messages_fts_trigram f JOIN messages m ON m.id = f.rowid
WHERE f.messages_fts_trigram MATCH :Q
  AND m.role='user' AND m.timestamp >= :SINCE
ORDER BY m.timestamp DESC LIMIT 20;
-- ✅ rowid ↔ messages.id 映射成立（实测 19811=19811）
-- ⚠️ FTS 索引含 tool 消息（JSON 大块）→ 必须加 role 过滤（否则命中自己的 tool JSON）
-- ⚠️ FTS content 有尾随空格规范化（'你好啊 ' vs '你好啊'）→ 原文一律取 messages.content，别用 f.content

-- ═══════════════════════════════════════════════════════════════
-- 三条硬坑（都踩过）
--   1. 容器 TZ=UTC：timestamp 是 epoch → 按「本地时间」过滤差 8 小时（CST=UTC+8）
--   2. 禁止无 WHERE 的 COUNT(*)：468MB + gateway 在写 → 实测 300s 超时
--   3. 只读打开 + 强制 LIMIT：防误写、防全表
-- 好消息：state.db 与 sessions/ 是 Hermes 内置禁写区（file_safety.py:128-132 → denied）
--         ⇒ 用 agent 的工具改不到它，L3 读回安全
-- ═══════════════════════════════════════════════════════════════
