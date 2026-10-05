'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const MAX_INMEM = 1000;
const MAX_FILE = 5000;
const LOG_FILE = path.join(config.dataDir, 'logs', 'lx-music.log');

try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) { /* noop */ }

// 内存环形缓冲（最新 MAX_INMEM 条）
const buffer = [];
const writeStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
writeStream.on('error', () => { /* 文件写失败不影响 stdout */ });

/**
 * 格式化为北京时间（基于容器 TZ=Asia/Shanghai，Node 进程的本地时区）
 * 例： 2026-08-18 23:14:05.123
 */
function fmtTs(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function push(level, args) {
  const line = {
    ts: Date.now(),
    level,
    text: args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()))
      .join(' '),
  };
  buffer.push(line);
  if (buffer.length > MAX_INMEM) buffer.shift();
  // 异步写文件（出错就吞了）
  writeStream.write(`[${fmtTs(line.ts)}] ${level.toUpperCase().padEnd(5)} ${line.text}\n`);
}

function makeLogger() {
  const order = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const idxOf = (x) => order.indexOf(x);

  function make(levelName) {
    return (...args) => {
      if (idxOf(levelName) < idxOf(level)) return;
      push(levelName, args);
      // 终端输出（保留原行为，但用本地时区）
      const out = process.stdout;
      const line = args
        .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()))
        .join(' ');
      out.write(`[${levelName.toUpperCase().padEnd(5)} ${fmtTs(Date.now())}] ${line}\n`);
    };
  }

  const logger = {
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
  };

  logger.getRecent = (limit = 100, level = null) => {
    const n = Math.max(1, Math.min(MAX_INMEM, limit));
    const list = buffer.slice(-n);
    return level ? list.filter((l) => l.level === level) : list;
  };
  logger.getBufferSize = () => buffer.length;
  logger.logFile = LOG_FILE;
  logger.fmtTs = fmtTs;

  return logger;
}

module.exports = makeLogger();