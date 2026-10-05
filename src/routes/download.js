'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { stmts, db } = require('../db');
const config = require('../config');
const { ok, fail } = require('../utils/response');

async function downloadRoutes(fastify, { queue, eventBus }) {
  fastify.post('/api/download/enqueue', async (req, reply) => {
    const body = req.body || {};
    if (!body.sourceId) return reply.code(400).send(fail('sourceId required'));
    if (!body.songs || !Array.isArray(body.songs) || body.songs.length === 0) {
      return reply.code(400).send(fail('songs array required'));
    }
    if (!body.playlistId) body.playlistId = null;

    // fallbackSourceIds 是失败时的备用音源列表（不含主音源）
    const fallbackSourceIds = Array.isArray(body.fallbackSourceIds) ? body.fallbackSourceIds : [];

    const results = [];
    for (const song of body.songs) {
      try {
        const r = queue.enqueue({
          sourceId: body.sourceId,
          song,
          quality: body.quality || config.downloadQuality,
          playlistId: body.playlistId,
          fallbackSourceIds,
        });
        results.push(r);
      } catch (err) {
        results.push({ error: err.message, song: song.name });
      }
    }
    return ok({ enqueued: results });
  });

  fastify.get('/api/download/list', async (req) => {
    const status = req.query.status || '';
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const rows = stmts.listTasks.all(limit, offset);
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    const total = stmts.countTasks.get(status, status).c;
    return ok({ total, list: filtered });
  });

  fastify.get('/api/download/stats', async () => ok({ ...queue.stats(), session: queue.session() }));

  // 单任务查询：SSE 实时更新时前端用此接口拉取完整最新状态
  fastify.get('/api/download/task/:id', async (req, reply) => {
    const t = stmts.getTask.get(parseInt(req.params.id, 10));
    if (!t) return reply.code(404).send(fail('task not found'));
    return ok(t);
  });

  fastify.get('/api/download/stream', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const send = (event, data) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('hello', { now: Date.now(), stats: queue.stats() });
    const onProgress = (payload) => {
      send('progress', payload);
      send('stats', queue.stats());
    };
    eventBus.on('queue:progress', onProgress);
    const heartbeat = setInterval(() => send('heartbeat', { at: Date.now() }), 30000);

    req.raw.on('close', () => {
      eventBus.off('queue:progress', onProgress);
      clearInterval(heartbeat);
    });
  });

  fastify.post('/api/download/retry/:id', async (req, reply) => {
    const t = stmts.getTask.get(parseInt(req.params.id, 10));
    if (!t) return reply.code(404).send(fail('task not found'));
    // body.sourceId 可选：手动指定另一音源（用于下载管理面板的下拉控制）
    if (req.body && req.body.sourceId) {
      const newSrc = sourceManager.get(req.body.sourceId);
      if (!newSrc) return reply.code(400).send(fail('source not found'));
      if (!newSrc.enabled) return reply.code(400).send(fail('source is disabled'));
      stmts.updateTask.run({
        id: t.id, status: 'pending', progress: 0, size: 0,
        targetRelpath: t.target_relpath, error: '',
        sourceId: newSrc.id, sourceLabel: (newSrc.info && newSrc.info.name) || newSrc.fileName,
        fallbackIndex: 0, quality: t.quality,
        retryCount: 0, errorKind: null, triedSources: null,
        updatedAt: Date.now(),
      });
      // 重读行后再 retryOne
    }
    const r = queue.retryOne(stmts.getTask.get(t.id));
    return ok(r);
  });

fastify.post('/api/download/retry-all', async (req, reply) => {
    // 只取 error_kind != permanent 的失败任务（其它过 queue.retryOne 仍会再次跳过）
    const rows = db.prepare(`SELECT * FROM download_tasks WHERE status = 'failed' AND (error_kind IS NULL OR error_kind != 'permanent')`).all();
    let retried = 0;
    let skipped = 0;
    let errors = 0;
    const skippedReasons = {};
    const errorReasons = {};
    // 关键：每个 task 独立 try/catch——任何单个 task 出错不影响其余 task
    // 也不包 db.transaction 整个批次，因为：
    //   1) retryOne 内部已有原子写
    //   2) 包外层事务会让 worker 长时间等待（拿不到行）
    //   3) 一个 task 异常全部回滚 = 一一一添加失败 → 违反「跳过继续下一个」要求
    for (const t of rows) {
      try {
        const r = queue.retryOne(t);
        if (r.skipped) {
          skipped++;
          const reasonKey = r.reason || 'unknown';
          skippedReasons[reasonKey] = (skippedReasons[reasonKey] || 0) + 1;
        } else {
          retried++;
        }
      } catch (err) {
        errors++;
        errorReasons[t.id] = err.message || String(err);
        logger.warn(`[retry-all] task#${t.id} retry failed: ${err.message || err}`);
      }
    }
    // 把永久失败单独计一下（在 SELECT 阶段被过滤掉了）
    const permCount = db.prepare(`SELECT COUNT(*) AS c FROM download_tasks WHERE status = 'failed' AND error_kind = 'permanent'`).get().c;
    if (permCount) skipped += permCount;
    return ok({ retried, skipped, errors, skippedReasons, permanentSkipped: permCount, errorReasons });
  });

  fastify.delete('/api/download/:id', async (req) => {
    stmts.deleteTask.run(parseInt(req.params.id, 10));
    return ok({ removed: req.params.id });
  });
}

module.exports = downloadRoutes;
