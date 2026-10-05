'use strict';

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const Fastify = require('fastify');
const fastifyCors = require('@fastify/cors');
const fastifyMultipart = require('@fastify/multipart');

const config = require('./config');
const logger = require('./utils/logger');
const { ok } = require('./utils/response');
const sourceManager = require('./sources/sourceManager');
const { db } = require('./db');

const sourcesRoutes = require('./routes/sources');
const playlistRoutes = require('./routes/playlist');
const musicRoutes = require('./routes/music');
const downloadRoutes = require('./routes/download');
const filesRoutes = require('./routes/files');
const logsRoutes = require('./routes/logs');

const DownloadQueue = require('./services/queue');

// 把镜像内置 script/ 目录下的音源脚本拷贝到运行时音源目录 data/sources/。
// 这些音源会以"用户音源"身份出现（可启用/禁用/删除；删除后重启会重新拷回）。
// 已存在的同名文件会被覆盖（保证 script/ 是最新的音源头）；不存在则新建。
function seedScriptSources() {
  const scriptDir = path.join(config.root, 'script');
  const names = [];
  let files = [];
  try { files = fs.readdirSync(scriptDir); } catch (_) { return names; }
  fs.mkdirSync(config.sourcesDir, { recursive: true });
  for (const name of files) {
    if (!/\.js$/i.test(name)) continue;
    try {
      fs.copyFileSync(path.join(scriptDir, name), path.join(config.sourcesDir, name));
      logger.info(`[script] seeded source → ${name}`);
      names.push(name);
    } catch (err) {
      logger.warn(`[script] seed failed ${name}: ${err.message}`);
    }
  }
  return names;
}

// 全局兜底：必须在 loadAll() 之前注册，否则官方脚本 init 时异步检查更新
// DNS 失败的 unhandledRejection 没人接，Node 默认直接退出整个进程。
process.on('unhandledRejection', (reason) => {
  logger.warn(`unhandledRejection: ${reason && reason.message ? reason.message : reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`uncaughtException: ${err && err.message ? err.message : err}`);
});

async function main() {
  seedScriptSources();
  await sourceManager.loadAll();

  const eventBus = new EventEmitter();
  const queue = new DownloadQueue({ concurrency: config.downloadConcurrency });
  queue.on('progress', (payload) => eventBus.emit('queue:progress', payload));

  const fastify = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
  });

  await fastify.register(fastifyCors, { origin: '*' });
  await fastify.register(fastifyMultipart);
  await fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  fastify.get('/api/health', async () => ok({ uptime: process.uptime(), version: '1.0.0', now: Date.now() }));
  fastify.get('/api/info', async () => {
    let pkgVersion = 'unknown';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
      pkgVersion = pkg.version || pkgVersion;
    } catch (_) { /* ignore */ }
    return ok({
      name: 'lx-music-docker',
      version: pkgVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime: process.uptime(),
      sources: sourceManager.list().length,
      dataDir: config.dataDir,
      musicDir: config.musicDir,
      sourcesDir: config.sourcesDir,
      neteaseConfigured: !!config.neteaseMusicU,
      neteaseCookieCount: config.neteaseMusicU ? config.neteaseMusicU.split(/[||,]/).filter((s) => s.trim()).length : 0,
    });
  });

  await fastify.register(async (f) => sourcesRoutes(f));
  await fastify.register(async (f) => playlistRoutes(f));
  await fastify.register(async (f) => musicRoutes(f));
  await fastify.register(async (f) => downloadRoutes(f, { queue, eventBus }));
  await fastify.register(async (f) => filesRoutes(f));
  await fastify.register(async (f) => logsRoutes(f));

  fastify.setErrorHandler((err, req, reply) => {
    logger.warn(`[${req.method} ${req.url}] ${err.message}`);
    reply.code(err.statusCode || 500).send({ code: 1, message: err.message });
  });

  try {
    await fastify.listen({ port: config.port, host: config.host });
  } catch (err) {
    logger.error('failed to start:', err);
    process.exit(1);
  }

  await queue.resumePending();
  await queue.start();

  const shutdown = async () => {
    logger.info('shutting down...');
    await queue.stop();
    await fastify.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
