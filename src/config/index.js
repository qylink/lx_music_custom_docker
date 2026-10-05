'use strict';

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..', '..');

const config = {
  root,
  port: Number(process.env.PORT) || 3210,
  host: process.env.HOST || '0.0.0.0',

  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  sourcesDir: path.join(process.env.DATA_DIR || path.join(root, 'data'), process.env.SOURCES_DIR_NAME || 'sources'),
  musicDir: path.join(process.env.DATA_DIR || path.join(root, 'data'), process.env.MUSIC_DIR_NAME || 'music'),
  configFile: path.join(process.env.DATA_DIR || path.join(root, 'data'), 'config.json'),
  dbFile: path.join(process.env.DATA_DIR || path.join(root, 'data'), 'db.sqlite'),

  neteaseUserAgent: process.env.NETEASE_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  neteaseMusicU: process.env.NETEASE_MUSIC_U || '',

  downloadConcurrency: Math.max(1, Number(process.env.DOWNLOAD_CONCURRENCY) || 3),
  downloadTimeout: Math.max(10000, Number(process.env.DOWNLOAD_TIMEOUT) || 90000),
  downloadQuality: process.env.DOWNLOAD_QUALITY || '320',

  // 反封号策略：每个 task 下载成功后随机 sleep 一段，避免突发被反作弊识别
  downloadJitterMinMs: Math.max(0, Number(process.env.DOWNLOAD_JITTER_MIN_MS) || 200),
  downloadJitterMaxMs: Math.max(
    Number(process.env.DOWNLOAD_JITTER_MIN_MS) || 200,
    Number(process.env.DOWNLOAD_JITTER_MAX_MS) || 800,
  ),
  // 同一源同 task 内最多重试次数（transient 错误退避重试）
  maxRetriesPerSource: Math.max(0, Number(process.env.MAX_RETRIES_PER_SOURCE) || 2),
  // 跨 fallback 之前，单源最大总尝试次数（含质量降级）
  maxAttemptsPerSource: Math.max(1, Number(process.env.MAX_ATTEMPTS_PER_SOURCE) || 4),
  // 调用音源脚本方法的超时（毫秒）
  sourceCallTimeout: Math.max(3000, Number(process.env.SOURCE_CALL_TIMEOUT) || 15000),
};

[
  config.dataDir,
  config.sourcesDir,
  config.musicDir,
  path.dirname(config.dbFile),
].forEach((dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* noop */ }
});

module.exports = config;
