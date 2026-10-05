'use strict';

const sourceManager = require('../sources/sourceManager');
const { ok, fail } = require('../utils/response');
const config = require('../config');
const fs = require('fs');
const path = require('path');

async function sourcesRoutes(fastify) {
  // 默认只返回父音源（隐藏桥接子音源 — 内部仍可用，只是不在 UI 列表里）
  // ?all=1 显示全部
  fastify.get('/api/sources', async (req) => {
    const all = req.query && req.query.all === '1';
    const list = sourceManager.list();
    return ok(all ? list : list.filter((s) => !s.parentId));
  });

  const childIds = (record) => {
    if (!record) return [];
    const base = path.basename(record.fileName, '.js');
    return sourceManager.list()
      .filter((s) => s.id !== record.id && s.fileName.startsWith(base + '__'))
      .map((s) => s.id);
  };

  fastify.post('/api/sources/add', async (req, reply) => {
    const body = req.body || {};
    try {
      const record = await sourceManager.addFromContent({
        fileName: body.fileName,
        content: body.content,
        overwrite: !!body.overwrite,
      });
      if (record.error) {
        return reply.code(400).send(fail(`script loaded but failed to init: ${record.error}`));
      }
      return ok({ id: record.id, fileName: record.fileName, info: record.info, sources: childIds(record) });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });

  fastify.post('/api/sources/add-url', async (req, reply) => {
    const body = req.body || {};
    if (!body.url) return reply.code(400).send(fail('url is required'));
    try {
      const record = await sourceManager.addFromUrl({ url: body.url, fileName: body.fileName });
      if (record.error) {
        return reply.code(400).send(fail(`script loaded but failed to init: ${record.error}`));
      }
      return ok({ id: record.id, fileName: record.fileName, info: record.info, sources: childIds(record) });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });

  fastify.post('/api/sources/:id/reload', async (req, reply) => {
    const r = await sourceManager.reload(req.params.id).catch((e) => {
      return reply.code(400).send(fail(e.message));
    });
    if (!r) return reply.code(404).send(fail('source not found'));
    return ok({ reloaded: !r.error, error: r.error || null, info: r.info });
  });

  fastify.post('/api/sources/:id/toggle', async (req, reply) => {
    const body = req.body || {};
    try {
      // 支持单条或脚本级联携（body.scope: 'this' | 'script'）
      if (body.scope === 'script') {
        const rec = sourceManager.get(req.params.id);
        if (!rec) return reply.code(404).send(fail('source not found'));
        const r = await sourceManager.setScriptEnabled(rec.file, !!body.enabled);
        return ok({ count: r.count, enabled: !!body.enabled });
      }
      const r = await sourceManager.setEnabled(req.params.id, !!body.enabled);
      return ok({ enabled: r.enabled });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });

  fastify.post('/api/sources/toggle-all', async (req, reply) => {
    const body = req.body || {};
    try {
      const r = await sourceManager.setAllEnabled(!!body.enabled);
      return ok({ count: r.count, enabled: !!body.enabled });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });

  fastify.post('/api/sources/:id/refresh', async (req, reply) => {
    try {
      const r = await sourceManager.refreshFromUrl(req.params.id);
      return ok({
        id: r.id,
        fileName: r.fileName,
        info: r.info,
        sources: childIds(r),
      });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });

  fastify.delete('/api/sources/:id', async (req, reply) => {
    try {
      await sourceManager.remove(req.params.id);
      return ok({ removed: req.params.id });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });

  fastify.get('/api/sources/dir', async () => {
    return ok({
      dir: config.sourcesDir,
      files: fs.existsSync(config.sourcesDir)
        ? fs.readdirSync(config.sourcesDir).filter((n) => n.endsWith('.js'))
        : [],
    });
  });

  fastify.get('/api/sources/:id/file', async (req, reply) => {
    const record = sourceManager.get(req.params.id);
    if (!record) return reply.code(404).send(fail('source not found'));
    try {
      const code = fs.readFileSync(record.file, 'utf8');
      return ok({ id: record.id, file: record.fileName, code });
    } catch (err) {
      return reply.code(500).send(fail(err.message));
    }
  });
}

module.exports = sourcesRoutes;
