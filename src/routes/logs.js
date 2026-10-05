'use strict';

const fs = require('fs');
const path = require('path');
const { ok, fail } = require('../utils/response');
const logger = require('../utils/logger');

async function logsRoutes(fastify) {
  /**
   * 内存中的最近 N 条日志（默认 1000，上限 1000）
   */
  fastify.get('/api/logs', async (req) => {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 1000));
    const level = req.query.level || null;
    const lines = logger.getRecent(limit, level);
    return ok({
      lines: lines.map((l) => ({
        ts: l.ts,
        level: l.level,
        text: l.text,
      })),
      total: logger.getBufferSize(),
      logFile: logger.logFile,
    });
  });

  /**
   * 导出最近 N 行日志为纯文本（方便用户下载存档）
   */
  fastify.get('/api/logs/download', async (req, reply) => {
    const lines = logger.getRecent(parseInt(req.query.limit, 10) || 1000);
    const text = lines.map((l) => `[${logger.fmtTs(l.ts)}] ${l.level.toUpperCase().padEnd(5)} ${l.text}`).join('\n');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="lx-music-${Date.now()}.log"`);
    return text;
  });

  /**
   * 持久化日志文件的信息（容器重启后仍能查到历史）
   */
  fastify.get('/api/logs/file-info', async () => {
    const file = logger.logFile;
    try {
      const stat = fs.statSync(file);
      return ok({ file, size: stat.size, mtime: stat.mtimeMs });
    } catch (e) {
      return reply ? ok({ file, size: 0, mtime: 0, error: e.message }) : { code: 1, message: e.message };
    }
  });
}

module.exports = logsRoutes;