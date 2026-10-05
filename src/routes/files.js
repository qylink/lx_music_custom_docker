'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');
const { ok, fail } = require('../utils/response');

async function filesRoutes(fastify) {
  fastify.get('/api/files/query', async (req) => {
    const search = (req.query.search || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const all = [];
    await walkFiles(config.musicDir, '', all);
    const items = search
      ? all.filter((f) => f.name.toLowerCase().includes(search) || f.relpath.toLowerCase().includes(search))
      : all;
    items.sort((a, b) => b.mtime - a.mtime);
    const total = items.length;
    const start = (page - 1) * pageSize;
    return ok({ total, page, pageSize, items: items.slice(start, start + pageSize) });
  });

  fastify.delete('/api/files', async (req, reply) => {
    const rel = (req.query.path || '').replace(/^[\\/]+/, '');
    if (!rel) return reply.code(400).send(fail('path required'));
    const target = path.join(config.musicDir, rel);
    if (!target.startsWith(config.musicDir)) return reply.code(400).send(fail('invalid path'));
    try {
      await fsp.rm(target, { recursive: true, force: true });
      // 删除音频时一并清理配套元数据文件（.meta.json / .meta.error.txt）
      await fsp.rm(target + '.meta.json', { force: true }).catch(() => {});
      await fsp.rm(target + '.meta.error.txt', { force: true }).catch(() => {});
      return ok({ removed: target });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });
}

// 配套元数据文件（写 ID3 时生成的 .meta.json / .meta.error.txt）不在文件列表/统计里展示
function isMetaCompanion(name) {
  return /\.meta\.(json|error\.txt)$/i.test(name) || /\.meta\.json$/i.test(name);
}

async function walkFiles(dir, rel, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walkFiles(p, r, out);
    } else {
      if (isMetaCompanion(e.name)) continue; // 跳过 .mp3.meta.json 等配套文件
      const stat = await fsp.stat(p).catch(() => null);
      out.push({ name: e.name, relpath: r, size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 });
    }
  }
}

module.exports = filesRoutes;
