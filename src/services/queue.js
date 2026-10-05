'use strict';

const axios = require('axios');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const config = require('../config');
const { stmts, db } = require('../db');
const sourceManager = require('../sources/sourceManager');
const downloader = require('../services/downloader');
const logger = require('../utils/logger');

// 错误分类 / Retry-After / 降级：从纯函数模块导入（便于单测）
const { classifyError, parseRetryAfter, downgradeQuality } = require('./quality-utils');

// 按源的平台挑 UA / Referer
function headersForTask(task) {
  const platform = downloader.detectPlatform(task.source_label, task.source_id);
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const refMap = {
    wy: 'https://music.163.com/',
    kg: 'https://www.kugou.com/',
    kw: 'http://www.kuwo.cn/',
    tx: 'https://y.qq.com/',
    mg: 'https://music.migu.cn/',
    netease: 'https://music.163.com/',
  };
  return { 'User-Agent': ua, Accept: '*/*', Referer: refMap[platform] || refMap.wy };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 反封号：每首成功后随机 sleep 一段（启动瞬间也睡一次防突发）
async function jitterDelay() {
  const { downloadJitterMinMs, downloadJitterMaxMs } = config;
  if (downloadJitterMaxMs <= 0) return;
  const ms = downloadJitterMinMs + Math.floor(Math.random() * Math.max(1, downloadJitterMaxMs - downloadJitterMinMs));
  await sleep(ms);
}

// 缓存当前「启用且有 musicUrl」的音源列表，TTL 30s，避免每次失败都全量扫描 registry
let _liveSourcesCache = null;
let _liveSourcesCacheAt = 0;
function getLiveSources(ttlMs = 30000) {
  const now = Date.now();
  if (_liveSourcesCache && now - _liveSourcesCacheAt < ttlMs) return _liveSourcesCache;
  const live = sourceManager.list().filter((s) => s.enabled && (s.methods || []).includes('musicUrl'));
  _liveSourcesCache = live;
  _liveSourcesCacheAt = now;
  return live;
}
// 源变更（enable/disable/增删）时自动失效
try { sourceManager.onChange(() => { _liveSourcesCache = null; _liveSourcesCacheAt = 0; }); } catch (_) { /* noop */ }

// 每源并发限流：多 worker 同时对同一音源发请求会触发源端的限流/封禁。
// 用「每源一个信号量」把同一源上的并发请求压到 max 个，其余排队。
const _sourceSemaphores = new Map();
function acquireSource(sourceId, max = 2) {
  if (!_sourceSemaphores.has(sourceId)) {
    let queue = [];
    let active = 0;
    const s = {
      async acquire() {
        if (active < max) { active++; return () => { active--; drain(); }; }
        return new Promise((resolve) => {
          queue.push(resolve);
        });
        function drain() {
          while (active < max && queue.length > 0) {
            const r = queue.shift();
            active++;
            r(() => { active--; drain(); });
          }
        }
      },
    };
    _sourceSemaphores.set(sourceId, s);
  }
  return _sourceSemaphores.get(sourceId).acquire();
}
async function withSourceSlot(sourceId, max, fn) {
  const release = await acquireSource(sourceId, max);
  try { return await fn(); } finally { release(); }
}

class DownloadQueue extends EventEmitter {
  constructor({ concurrency = 3 } = {}) {
    super();
    this.concurrency = concurrency;
    this.active = 0;
    this.stopped = false;
    // 累计统计（进程内）
    this.counters = {
      enqueued: 0,
      musicUrlOk: 0,
      musicUrlFail: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      fallback: 0,
      bytesDownloaded: 0,
    };
    this.statsTimer = null;
  }

  // 重试一个已存在的 failed 任务（task 行）：先经过 dedup + file-exists 检查，再决定
  // 入队（更新为 pending）或标记为 skipped。结果保留原 task id，便于 UI 跟踪。
retryOne(taskRow) {
    // 不再因 error_kind=permanent 跳过——让用户主动重试（数据可能已变）
    // 只在必要检查：song_key dedup + 文件已存在
    // 1) song_key 去重：其它任务已成功/已下载过 → 当前任务标 skipped（链接到现存的）
    const songKey = this.computeSongKey({
      songId: taskRow.song_id, songmid: taskRow.song_id, id: taskRow.song_id, song_id: taskRow.song_id,
      name: taskRow.song_name, artists: taskRow.artists,
    });
    const dup = songKey ? stmts.existingTaskBySongKey.get(songKey) : null;
    if (dup && dup.id !== taskRow.id) {
      stmts.updateTask.run({
        id: taskRow.id, status: 'skipped', progress: 0, size: 0,
        targetRelpath: taskRow.target_relpath, error: `与 task#${dup.id} 重复，跳过`,
        sourceId: taskRow.source_id, sourceLabel: taskRow.source_label,
        fallbackIndex: taskRow.fallback_index, quality: taskRow.quality,
        retryCount: taskRow.retry_count || 0, errorKind: null, triedSources: taskRow.tried_sources || null,
        updatedAt: Date.now(),
      });
      return { id: taskRow.id, targetRel: taskRow.target_relpath, skipped: true, reason: `与 task#${dup.id} 重复` };
    }
    // 3) 文件已存在 → 标 skipped（不下载）
    let existingSize = 0;
    try {
      const st = fs.statSync(path.join(config.musicDir, taskRow.target_relpath));
      if (st.isFile() && st.size > 0) existingSize = st.size;
    } catch (_) { /* not exists */ }
    if (existingSize > 0) {
      stmts.updateTask.run({
        id: taskRow.id, status: 'skipped', progress: 100, size: existingSize,
        targetRelpath: taskRow.target_relpath, error: '文件已存在，跳过下载',
        sourceId: taskRow.source_id, sourceLabel: taskRow.source_label,
        fallbackIndex: taskRow.fallback_index, quality: taskRow.quality,
        retryCount: taskRow.retry_count || 0, errorKind: null, triedSources: taskRow.tried_sources || null,
        updatedAt: Date.now(),
      });
      return { id: taskRow.id, targetRel: taskRow.target_relpath, skipped: true, reason: '文件已存在', size: existingSize };
    }
    // 4) 通过所有检查 → 真正入队（更新为 pending，保留原 id）
    stmts.updateTask.run({
      id: taskRow.id, status: 'pending', progress: 0, size: 0, error: '',
      targetRelpath: taskRow.target_relpath,
      sourceId: taskRow.source_id, sourceLabel: taskRow.source_label,
      fallbackIndex: taskRow.fallback_index, quality: taskRow.quality,
      retryCount: 0, errorKind: null, triedSources: null,
      updatedAt: Date.now(),
    });
    return { id: taskRow.id, targetRel: taskRow.target_relpath, skipped: false };
  }

  async resumePending() {
    // 启动时把上次未完成的 running 任务标记为 interrupted，回退到 pending
    const rows = db.prepare(`SELECT * FROM download_tasks WHERE status = 'running'`).all();
    rows.forEach((row) => {
      if (row.status === 'running') {
        stmts.updateTask.run({
          id: row.id, status: 'pending', progress: 0, size: 0,
          targetRelpath: row.target_relpath, error: 'interrupted (restart)',
          sourceId: row.source_id, sourceLabel: row.source_label,
          fallbackIndex: row.fallback_index, quality: row.quality,
          retryCount: row.retry_count || 0, errorKind: row.error_kind || null, triedSources: row.tried_sources || null,
          updatedAt: Date.now(),
        });
      }
    });
    logger.info(`[queue] resumed ${rows.length} pending/running task(s)`);
  }

  // 稳定去重键：优先用源内原生 ID（netease 歌单的 song_id），否则 名称+艺人
  computeSongKey(song) {
    const songId = song.songId || song.songmid || song.id || song.song_id || '';
    if (songId) return `netease:${songId}`;
    const name = String(song.name || '').trim().toLowerCase();
    const artists = downloader.joinArtists(song.artists || []).toLowerCase();
    return `fuzzy:${name}|${artists}`;
  }

  enqueue({ sourceId, song, quality, playlistId = null, fallbackSourceIds = [] }) {
    const songKey = this.computeSongKey(song);
    const dup = songKey ? stmts.existingTaskBySongKey.get(songKey) : null;
    if (dup) {
      logger.info(`[queue] skip task「${song.name}」by ${downloader.joinArtists(song.artists)} (dup song_key=${songKey}, existing#${dup.id} ${dup.status})`);
      return { id: null, targetRel: '', skipped: true, reason: `已在队列/完成 (task#${dup.id})` };
    }
    const targetRel = downloader.buildTargetFile({
      artist: downloader.joinArtists(song.artists),
      album: song.album || 'Singles',
      name: song.name,
    });
    // 反封号 / 体验优化：目标文件已经存在且非空，直接记为 skipped，不再排队下载
    let existingSize = 0;
    try {
      const st = fs.statSync(path.join(config.musicDir, targetRel));
      if (st.isFile() && st.size > 0) existingSize = st.size;
    } catch (_) { /* not exists */ }
    if (existingSize > 0) {
      const sourceLabel = sourceManager.get(sourceId)?.info?.name || sourceId;
      const info = stmts.insertTask.run({
        sourceId,
        sourceLabel,
        songName: song.name,
        artists: downloader.joinArtists(song.artists),
        album: song.album || '',
        duration: song.duration || 0,
        picUrl: song.picUrl || song.pic || '',
        sourceUrl: '',
        quality: quality || config.downloadQuality,
        status: 'skipped', progress: 100, size: existingSize,
        errorKind: null, triedSources: null,
        targetRelpath: targetRel,
        error: '',
        fallbackSourceIds: JSON.stringify(fallbackSourceIds || []),
        fallbackIndex: 0,
        retryCount: 0,
        songId: String(song.songId || song.songmid || song.id || song.song_id || ''),
        songKey,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        playlistId,
      });
      logger.info(`[queue] skip task「${song.name}」 file exists (${existingSize}B) → task#${info.lastInsertRowid} marked skipped`);
      return { id: info.lastInsertRowid, targetRel, skipped: true, reason: '文件已存在', size: existingSize };
    }
    const sourceLabel = sourceManager.get(sourceId)?.info?.name || sourceId;
    const info = stmts.insertTask.run({
      sourceId,
      sourceLabel,
      songName: song.name,
      artists: downloader.joinArtists(song.artists),
      album: song.album || '',
      duration: song.duration || 0,
      picUrl: song.picUrl || song.pic || '',
      sourceUrl: '',
      quality: quality || config.downloadQuality,
      status: 'pending', progress: 0, size: 0,
      targetRelpath: targetRel,
      error: '',
      fallbackSourceIds: JSON.stringify(fallbackSourceIds || []),
      fallbackIndex: 0,
      retryCount: 0,
      errorKind: null, triedSources: null,
      songId: String(song.songId || song.songmid || song.id || song.song_id || ''),
      songKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      playlistId,
    });
    this.counters.enqueued++;
    logger.info(`[queue] enqueued task#${info.lastInsertRowid}「${song.name}」by ${downloader.joinArtists(song.artists)} via ${sourceLabel}` +
      ` (fallback × ${fallbackSourceIds.length}, quality=${quality || config.downloadQuality}, song_id=${song.songId || song.songmid || ''})`);
    return { id: info.lastInsertRowid, targetRel };
  }

  async start() {
    this.stopped = false;
    for (let i = 0; i < this.concurrency; i++) this.#workerLoop();
    // 启动后每30 秒输出一条汇总统计
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => this.#logStats(), 30000);
    logger.info(`[queue] started with concurrency=${this.concurrency}`);
  }

  async stop() {
    this.stopped = true;
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    this.#logStats('final');
  }

  #logStats(label = 'periodic') {
    try {
      const s = this.stats();
      const c = this.counters;
      const successRate = s.success + s.failed > 0
        ? ((s.success / (s.success + s.failed)) * 100).toFixed(1) + '%'
        : 'N/A';
      logger.info(
        `[queue] ${label} stats: ` +
        `total=${s.total} (pending=${s.pending} running=${s.running} success=${s.success} skipped=${s.skipped} failed=${s.failed} active=${s.active}) | ` +
        `success-rate=${successRate} | ` +
        `session: enqueued=${c.enqueued} musicUrl-ok=${c.musicUrlOk} musicUrl-fail=${c.musicUrlFail} ` +
        `downloaded=${c.downloaded} skipped=${c.skipped} failed=${c.failed} fallback=${c.fallback} bytes=${downloader.fmtSize(c.bytesDownloaded)}`,
      );
    } catch (err) {
      logger.error('[queue] stats log error:', err);
    }
  }

  async #workerLoop() {
    while (!this.stopped) {
      const next = await this.#nextPending();
      if (!next) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      this.active += 1;
      try { await this.#process(next); } catch (err) {
        logger.error('[queue] worker loop error:', err && err.stack ? err.stack : err);
      }
      this.active = Math.max(0, this.active - 1);
    }
  }

  async #nextPending() {
    // 原子认领下一个 pending task：避免多 worker 并发抢同一行
    return db.transaction(() => {
      const row = stmts.pendingOnly.get();
      if (!row) return null;
      stmts.updateTask.run({
        id: row.id, status: 'running', progress: 0, size: 0,
        targetRelpath: row.target_relpath, error: '',
        sourceId: row.source_id, sourceLabel: row.source_label,
        fallbackIndex: row.fallback_index, quality: row.quality,
        retryCount: row.retry_count || 0, errorKind: row.error_kind || null, triedSources: row.tried_sources || null,
        updatedAt: Date.now(),
      });
      return row;
    })();
  }

  async #process(task) {
    const updatedAt = Date.now();
    stmts.updateTask.run({
      id: task.id, status: 'running', progress: 0, size: 0,
      targetRelpath: task.target_relpath, error: '',
      sourceId: task.source_id, sourceLabel: task.source_label,
      fallbackIndex: task.fallback_index, quality: task.quality,
      retryCount: task.retry_count || 0, errorKind: task.error_kind || null, triedSources: task.tried_sources || null,
      updatedAt,
    });
    this.emit('progress', { id: task.id, status: 'running', progress: 0 });
    logger.info(`[queue] task#${task.id} start:「${task.song_name}」via ${task.source_label} q=${task.quality}`);

    // 防御深度：进入下载前检查目标文件是否已存在；存在则直接记 skipped，不再走网络
    try {
      const targetAbs = path.join(config.musicDir, task.target_relpath);
      const st = fs.statSync(targetAbs);
      if (st.isFile() && st.size > 0) {
        logger.info(`[queue] task#${task.id} file already exists (${st.size}B), marking skipped`);
        stmts.updateTask.run({
          id: task.id, status: 'skipped', progress: 100, size: st.size,
          targetRelpath: task.target_relpath, error: '文件已存在，跳过下载',
          sourceId: task.source_id, sourceLabel: task.source_label,
          fallbackIndex: task.fallback_index, quality: task.quality,
          retryCount: task.retry_count || 0, errorKind: null, triedSources: task.tried_sources || null,
          updatedAt: Date.now(),
        });
        this.emit('progress', { id: task.id, status: 'skipped', progress: 100, size: st.size });
        this.counters.skipped++;
        return;
      }
    } catch (_) { /* not exists, normal path */ }

    // 反封号：每首开始/结束时随机 sleep 一段（启动瞬间也睡一次防突发）
    await jitterDelay();

    // 同源内部重试：transient 错误退避重试；用尽重试后在本源内降一档音质
    let supportedQualitys = [];
    try {
      const info = sourceManager.get(task.source_id);
      if (info && info.info && Array.isArray(info.info.qualitys)) supportedQualitys = info.info.qualitys;
    } catch (_) { /* noop */ }

    const maxAttempts = config.maxAttemptsPerSource;
    const maxRetries = config.maxRetriesPerSource;
    let attempt = 0;
    let retryCount = task.retry_count || 0;
    let lastErr = null;
    let lastErrorKind = null;
    let effectiveQuality = task.quality;
    let urlInfo = null;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const songInfo = {
          songmid: task.song_id,
          id: task.song_id || task.song_name,
          songId: task.song_id,
          name: task.song_name,
          singer: task.artists,
          artists: (task.artists || '').split(/[,&、\/]/).filter(Boolean),
          album: task.album,
          source: task.source_label,
        };
        if (task.source_url) {
          urlInfo = { url: task.source_url, source: 'preset' };
        } else {
          // 品质自动降级阶梯：requested → 192k → 128k（仅当源返回空 URL + fee/VIP 标记时）
          const QUALITY_LADDER = ['320', '192', '128', 'flac'];
          const startIdx = QUALITY_LADDER.indexOf(String(task.quality));
          const trialOrder = startIdx >= 0 ? QUALITY_LADDER.slice(startIdx) : ['128'];
          let lastQualityResult = null;
          for (const qTry of trialOrder) {
            const t0 = Date.now();
            // 每源并发限流：同一音源的 musicUrl 请求最多同时 2 个，避免触发源端限流/封禁
            const result = await withSourceSlot(task.source_id, 2, () =>
              sourceManager.callMethod(task.source_id, 'musicUrl', songInfo, qTry));
            const dt = Date.now() - t0;
            this.counters.musicUrlOk++;
            const hasUrl = result && typeof result === 'object' && result.url;
            const isVip = result && typeof result === 'object' && (result.fee > 0 || result.payed === 0);
            // 拿到 URL → 跳出；空 URL + 非 VIP → 也跳出（歌真不存在）
            if (hasUrl) {
              urlInfo = result;
              effectiveQuality = qTry;
              logger.info(`[queue] task#${task.id} musicUrl ok in ${dt}ms via ${task.source_label} q=${qTry}` +
                (qTry !== task.quality ? ` (requested=${task.quality})` : ''));
              break;
            }
            if (qTry === '128') {
              // 已经试到最低，无法再降
              urlInfo = result || null;
              lastQualityResult = result;
              logger.info(`[queue] task#${task.id} musicUrl lowest-quality returned no url (fee=${result && result.fee} code=${result && result.code})`);
              break;
            }
            // 空 url + 是 VIP/付费 → 试更低品质
            if (isVip) {
              logger.info(`[queue] task#${task.id} musicUrl q=${qTry} → empty (VIP/fee=${result.fee}) → 试下一档`);
              lastQualityResult = result;
              continue;
            }
            // 空 url + 不是 VIP（code -110 / 不存在）→ 直接放弃降级
            urlInfo = result || null;
            lastQualityResult = result;
            logger.info(`[queue] task#${task.id} musicUrl q=${qTry} → empty (code=${result && result.code}) → 不可降级`);
            break;
          }
          if (lastQualityResult && effectiveQuality !== task.quality) {
            stmts.updateTask.run({
              id: task.id, quality: effectiveQuality,
              status: 'running', progress: 0, size: 0,
              targetRelpath: task.target_relpath, error: '',
              sourceId: task.source_id, sourceLabel: task.source_label,
              fallbackIndex: task.fallback_index,
              retryCount: task.retry_count || 0, errorKind: task.error_kind || null, triedSources: task.tried_sources || null,
              updatedAt: Date.now(),
            });
          }
        }

        // 试听流检测（.m3u8 / freeTrialInfo / 含 'trial'）→ 永久失败不走 fallback
        const isTrial = urlInfo && typeof urlInfo === 'object' && (
          urlInfo.freeTrialInfo ||
          (urlInfo.url && /\.m3u8(\?|$)/i.test(urlInfo.url)) ||
          /试听|trial/i.test(urlInfo.url || '')
        );
        if (isTrial) {
          lastErrorKind = 'permanent';
          const e = new Error('网易云试听版不可下载（所有源都一样）');
          e.trialOnly = true;
          throw e;
        }
        let url;
        if (typeof urlInfo === 'string') url = urlInfo;
        else if (urlInfo && urlInfo.url) url = urlInfo.url;
        if (!url) throw new Error('source returned empty url');

        const targetAbs = path.join(config.musicDir, task.target_relpath);
        await fsp.mkdir(path.dirname(targetAbs), { recursive: true });

        logger.info(`[queue] task#${task.id} downloading: ${downloader.fmtShortUrl(url)} → ${task.target_relpath}`);
        const tDl = Date.now();
        const res = await axios.get(url, {
          responseType: 'stream',
          timeout: config.downloadTimeout,
          headers: headersForTask(task),
          maxRedirects: 5,
          maxContentLength: 200 * 1024 * 1024,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        let lastTick = Date.now();
        let lastBytes = 0;
        let speed = 0;
        let eta = 0;
        const out = fs.createWriteStream(targetAbs);
        await new Promise((resolve, reject) => {
          res.data.on('data', (chunk) => {
            received += chunk.length;
            const now = Date.now();
            const dt = now - lastTick;
            if (dt >= 1000) {
              speed = (received - lastBytes) / (dt / 1000);
              lastTick = now;
              lastBytes = received;
              if (speed > 0 && total > received) eta = Math.round((total - received) / speed);
              else eta = 0;
            }
            if (total > 0) {
              const p = Math.min(99, Math.floor((received / total) * 100));
              if (!this._lastEmit || now - this._lastEmit > 600) {
                this.emit('progress', { id: task.id, status: 'running', progress: p, received, total, speed, eta });
                this._lastEmit = now;
              }
            }
          });
          res.data.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          res.data.pipe(out);
        });

        const finalSize = total || received;
        const dt = Date.now() - tDl;
stmts.updateTask.run({
        id: task.id, status: 'success', progress: 100, size: finalSize,
        targetRelpath: task.target_relpath, error: '',
        sourceId: task.source_id, sourceLabel: task.source_label,
        fallbackIndex: task.fallback_index, quality: effectiveQuality,
        retryCount: task.retry_count || 0, errorKind: null, triedSources: task.tried_sources || null,
        updatedAt: Date.now(),
      });
        this.emit('progress', { id: task.id, status: 'success', progress: 100, size: finalSize });
        this.counters.downloaded++;
        this.counters.bytesDownloaded += finalSize;
        logger.info(`[queue] task#${task.id} ✓ success: ${downloader.fmtSize(finalSize)} in ${dt}ms (${(finalSize / (dt / 1000) / 1024).toFixed(1)} KB/s) [attempt ${attempt}/${maxAttempts}]`);

        await downloader.writeId3v2(targetAbs, {
          title: task.song_name,
          artist: task.artists,
          artists: (task.artists || '').split(/[,&、\/]/).filter(Boolean),
          album: task.album,
          albumArtist: task.artists,
        });

        if (task.song_id || task.song_key) {
          try {
            stmts.upsertSongCache.run({
              key: task.song_key,
              source: task.source_id,
              sourceId: task.song_id,
              name: task.song_name,
              artists: task.artists,
              album: task.album,
              duration: task.duration || 0,
              meta: JSON.stringify({ targetRel: task.target_relpath, size: finalSize }),
              updatedAt: Date.now(),
            });
          } catch (_) { /* noop */ }
        }
        return; // 成功，退出 #process
} catch (err) {
          lastErr = err;
          const kind = classifyError(err);
          lastErrorKind = kind;
          // 试听版特判：直接永久失败，跳过所有重试、降级、跨源 fallback
          if (err && err.trialOnly) {
            logger.warn(`[queue] task#${task.id} trial-only song, skipping all retries/fallbacks`);
            break;
          }
          // 音源被禁用/已删除：直接跳出，不浪费重试时间
          if (err && /source (is disabled|not found)/i.test(err.message || '')) {
            logger.warn(`[queue] task#${task.id} source ${task.source_id} unavailable (${err.message}), jumping to next`);
            break;
          }
          const code = err && err.code ? ` [${err.code}]` : '';
          const status = err && err.response && err.response.status ? ` (HTTP ${err.response.status})` : '';
          logger.warn(`[queue] task#${task.id} attempt ${attempt}/${maxAttempts} failed (${kind}): ${err && err.message ? err.message : err}${code}${status}`);
        this.counters.musicUrlFail++;

        // 反封号：transient / rate_limited 错误先退避再重试；permanent 错误跳过（直接走 fallback）
        if ((kind === 'transient' || kind === 'rate_limited') && attempt < maxAttempts) {
          // 限流：切到下一音源比耗在本源上退避更高效（其它源未必限流）
          if (kind === 'rate_limited' && attempt === 1) {
            // 第一次就 429 → 跳出 inner 循环，走 fallback
            break;
          }
          if (retryCount < maxRetries) {
            retryCount++;
            // 限流（429）需要长退避：60s→120s→240s（公网源要分钟级恢复）
            // 其他 transient：800→1600→3200ms（指数退避 + jitter）
            let backoff;
            if (kind === 'rate_limited') {
              const retryAfterMs = parseRetryAfter(err.response && err.response.headers && err.response.headers['retry-after']);
              const base = retryAfterMs || (60000 * Math.pow(2, retryCount - 1));
              backoff = Math.min(10 * 60 * 1000, base) + Math.floor(Math.random() * 5000);
              logger.warn(`[queue] task#${task.id} rate-limited, waiting ${(backoff/1000).toFixed(1)}s before retry ${retryCount}/${maxRetries}`);
            } else {
              backoff = Math.min(8000, 800 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400);
              logger.info(`[queue] task#${task.id} retry ${retryCount}/${maxRetries} after ${backoff}ms backoff`);
            }
            stmts.updateTask.run({
              id: task.id, status: 'running', error: `retry ${retryCount}/${maxRetries}: ${err.message}`,
              retryCount, updatedAt: Date.now(),
              sourceId: task.source_id, sourceLabel: task.source_label,
              fallbackIndex: task.fallback_index, quality: task.quality,
              progress: 0, size: 0, targetRelpath: task.target_relpath,
              errorKind: kind,
            });
            await sleep(backoff);
            continue;
          }
          // 重试用完 → 在本源内降一档音质再试
          const lower = downgradeQuality(task.quality, supportedQualitys);
          if (lower && lower !== task.quality) {
            logger.info(`[queue] task#${task.id} downgrading quality ${task.quality} → ${lower} within source`);
            task.quality = lower;
            stmts.updateTask.run({
              id: task.id, quality: lower, status: 'running', error: `quality downgraded to ${lower}: ${err.message}`,
              retryCount: 0, triedSources: null, updatedAt: Date.now(),
              sourceId: task.source_id, sourceLabel: task.source_label,
              fallbackIndex: task.fallback_index,
              progress: 0, size: 0, targetRelpath: task.target_relpath,
              errorKind: kind,
            });
            await sleep(500 + Math.floor(Math.random() * 400));
            retryCount = 0;
            continue;
          }
        }
        break;
      }
    }

    // inner 循环失败 → 进入跨音源 fallback 逻辑
    // 已尝试过的音源列表（防循环），读取后 append 当前 source
    // 必须在 err 判断之前先声明，TDZ 否则 ReferenceError
    let triedSources = new Set();
    try { triedSources = new Set(JSON.parse(task.tried_sources || '[]')); } catch (_) {}
    triedSources.add(task.source_id);
    const err = lastErr || new Error('unknown error after retries');
    // 试听版 / trial-only：跳过整个 fallback 链，直接走永久失败（→ 走 prune）
    if (err && err.trialOnly) {
      logger.warn(`[queue] task#${task.id} trial-only song, skipping fallback chain, going straight to prune`);
    }
    // 把刚才已尝试且「死掉」的源（disabled / not found）加入 triedSources，下一轮 fallback 自动跳过
    if (err && /source (is disabled|not found)/i.test(err.message || '')) {
      triedSources.add(task.source_id);
    }
    const message = err && err.message ? err.message : String(err);
    const code = err && err.code ? ` [${err.code}]` : '';
    const status = err && err.response && err.response.status ? ` (HTTP ${err.response.status})` : '';
    const detail = `task#${task.id}「${task.song_name}」by ${task.artists} failed: ${message}${code}${status}`;
    logger.warn(`[queue] ${detail}`);
    if (err && err.stack) logger.warn(`[queue] stack: ${err.stack.split('\n').slice(0, 4).join(' | ')}`);

// 自动 fallback：失败时如果还有备选音源，切到下一个
    let fallbacks = [];
    try { fallbacks = JSON.parse(task.fallback_source_ids || '[]'); } catch (_) { fallbacks = []; }
    // 关键：enqueue 时快照的 fallback_source_ids 可能已过时（用户中途禁用了某些源）
    // 这里重新过滤：只保留当前还 enabled + 仍在 registry + 有 musicUrl 方法的源（用缓存）
    {
      const live = new Map(getLiveSources().map((s) => [s.id, s]));
      fallbacks = fallbacks.filter((id) => {
        const cur = live.get(id);
        return cur && cur.enabled && (cur.methods || []).includes('musicUrl');
      });
    }
    // 用户没显式 fallback 时 → 自动从「其他启用且有 musicUrl，且未尝试过」的音源补全
    if (fallbacks.length === 0) {
      const others = getLiveSources()
        .filter((s) => s.enabled && (s.methods || []).includes('musicUrl') && s.id !== task.source_id && !triedSources.has(s.id))
        .map((s) => s.id);
      if (others.length > 0) {
        fallbacks = others;
        logger.info(`[queue] task#${task.id} no explicit fallback, auto-falling back to ${others.length} other sources (tried=${triedSources.size})`);
      }
    }
    const nextIdx = (task.fallback_index || 0) + 1;
    if (!err.trialOnly && nextIdx < fallbacks.length) {
      const nextSource = fallbacks[nextIdx];
      const nextLabel = sourceManager.get(nextSource)?.info?.name || nextSource;
      logger.warn(`[queue] task#${task.id} → fallback ${nextIdx + 1}/${fallbacks.length}: ${nextLabel} (原因: ${message})`);
      stmts.updateTask.run({
          id: task.id,
          status: 'pending',
          sourceId: nextSource,
          sourceLabel: nextLabel,
          fallbackIndex: nextIdx,
          progress: 0,
          size: 0,
          targetRelpath: task.target_relpath,
          error: `${message} → 已切到备用音源 ${nextLabel}`,
          quality: task.quality,
          retryCount: 0, errorKind: null,
          triedSources: JSON.stringify([...triedSources]),
          updatedAt: Date.now(),
        });
      this.counters.fallback++;
      this.emit('progress', { id: task.id, status: 'fallback', sourceId: nextSource, sourceLabel: nextLabel, error: message });
      return;
    }

// 永久失败（歌在所有源上都不存在）→ 自动清理掉任务行，避免堆积「永远失败」的状态
    // 用户可重新选歌入队（数据可能已变），不阻塞 UI
    if (lastErrorKind === 'permanent') {
      logger.warn(`[queue] task#${task.id} pruned (permanent failure across all ${triedSources.size} sources): ${message}`);
      db.prepare('DELETE FROM download_tasks WHERE id = ?').run(task.id);
      this.counters.failed++;
      this.emit('progress', { id: task.id, status: 'pruned', error: message, detail });
      return;
    }
    stmts.updateTask.run({
      id: task.id, status: 'failed', progress: 0, size: 0,
      targetRelpath: task.target_relpath, error: message || 'unknown error',
      sourceId: task.source_id, sourceLabel: task.source_label,
      fallbackIndex: task.fallback_index, quality: task.quality,
      retryCount: task.retry_count || 0, errorKind: lastErrorKind || null, triedSources: task.tried_sources || null,
      updatedAt: Date.now(),
    });
    this.counters.failed++;
    this.emit('progress', { id: task.id, status: 'failed', error: message, detail });
    logger.error(`[queue] task#${task.id} ✗ final-failed after trying all sources: ${message}`);
  }

stats() {
    const rows = stmts.statTasks.all();
    const out = { pending: 0, running: 0, success: 0, skipped: 0, failed: 0, total: 0 };
    rows.forEach((r) => { out[r.status] = (out[r.status] || 0) + r.c; out.total += r.c; });
    out.active = this.active;
    return out;
  }

  session() {
    const c = this.counters;
    return {
      enqueued: c.enqueued,
      musicUrlOk: c.musicUrlOk,
      musicUrlFail: c.musicUrlFail,
      downloaded: c.downloaded,
      skipped: c.skipped,
      failed: c.failed,
      fallback: c.fallback,
      bytes: c.bytesDownloaded,
    };
  }
}

module.exports = DownloadQueue;
