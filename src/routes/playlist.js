'use strict';

const netease = require('../services/netease');
const downloader = require('../services/downloader');
const logger = require('../utils/logger');
const { stmts, db } = require('../db');
const { ok, fail } = require('../utils/response');

async function playlistRoutes(fastify) {
  fastify.post('/api/playlist/import', async (req, reply) => {
    const body = req.body || {};
    if (!body.id && !body.url) {
      return reply.code(400).send(fail('id or url is required'));
    }
    const id = netease.parseIdFromInput(body.id || body.url);
    if (!id || !/^[0-9]+$/.test(id)) {
      return reply.code(400).send(fail('invalid playlist id'));
    }
    try {
      const playlist = await netease.getPlaylist(id);
      stmts.upsertPlaylist.run({
        id: String(playlist.id),
        source: 'netease',
        name: playlist.name,
        cover: playlist.coverImgUrl,
        trackCount: playlist.trackCount || playlist.tracks.length,
        importedAt: Date.now(),
      });
      stmts.removeTracks.run(String(playlist.id));
      playlist.tracks.forEach((t, idx) => {
        stmts.insertTrack.run({
          playlistId: String(playlist.id),
          position: idx,
          songId: String(t.id),
          name: t.name,
          artists: downloader.joinArtists(t.artists),
          album: t.album || '',
          duration: t.duration || 0,
        });
      });
      return ok({
        summary: {
          id: playlist.id,
          name: playlist.name,
          trackCount: playlist.tracks.length,
          coverImgUrl: playlist.coverImgUrl,
          creator: playlist.creator,
        },
        tracks: playlist.tracks,
      });
    } catch (err) {
      return reply.code(500).send(fail(err.message));
    }
  });

  fastify.get('/api/playlist/list', async () => {
    const rows = stmts.listPlaylists.all();
    return ok(rows);
  });

  fastify.get('/api/playlist/:id', async (req, reply) => {
    const pl = stmts.getPlaylist.get(req.params.id);
    if (!pl) return reply.code(404).send(fail('playlist not found'));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const total = stmts.countPlaylistTracks.get(req.params.id).c;
    const tracks = stmts.getPlaylistTracksPage.all(req.params.id, limit, offset);
    return ok({
      playlist: pl,
      tracks,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  });

  fastify.delete('/api/playlist/:id', async (req, reply) => {
    stmts.removeTracks.run(req.params.id);
    db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
    return ok({ removed: req.params.id });
  });

  /**
   * SSE 流式导入：浏览器 fetch 后会持续接收 progress / done / error 事件
   */
  fastify.post('/api/playlist/import-stream', async (req, reply) => {
    const body = req.body || {};
    if (!body.id && !body.url) {
      return reply.code(400).send(fail('id or url is required'));
    }
    const id = netease.parseIdFromInput(body.id || body.url);
    if (!id || !/^\d{4,}$/.test(id)) {
      return reply.code(400).send(fail('invalid playlist id'));
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    // 明确接管响应控制权：否则 fastify 在 async handler resolve（getPlaylist 拉取完成后）
    // 会结束 raw 响应，导致只有第一个 progress 事件能到客户端，进度/完成事件全部丢失。
    reply.hijack();
    reply.raw.flushHeaders();

    const send = (event, data) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const close = () => {
      try { reply.raw.end(); } catch (_) { /* noop */ }
    };

    // 不要监听 req.raw 'close' 来 close 响应：POST body 流读完会触发 req close，
    // 导致在 getPlaylist 异步完成前就把 SSE 响应提前 end 掉（只留下第一个事件）。
    // 响应在 finally 里由 reply.raw.end() 显式关闭。

    try {
      const playlist = await netease.getPlaylist(id, (p) => send('progress', p));
      const total = playlist.tracks.length;
      send('progress', { phase: 'persist', percent: 88, message: `保存 ${total} 首到数据库...`, total, done: 0 });

      // 在事务外异步插入并定期 emit 进度（事务内 emit SSE 会跨 tick，写不下）
      // 实际上为简化：把 save 拆成「分批插入 + 周期回调」，每 100 首 emit 一次
      const insert = db.prepare(`INSERT OR REPLACE INTO playlist_tracks(playlist_id, position, song_id, name, artists, album, duration) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const upsertPlaylistTx = db.transaction((pl) => {
        stmts.upsertPlaylist.run({
          id: String(pl.id),
          source: 'netease',
          name: pl.name,
          cover: pl.coverImgUrl,
          trackCount: pl.tracks.length,
          importedAt: Date.now(),
        });
        stmts.removeTracks.run(String(pl.id));
      });
      upsertPlaylistTx(playlist);

      // 分批插入 + 周期进度
      const batchSize = 200;
      let done = 0;
      let lastEmit = Date.now();
      for (let i = 0; i < playlist.tracks.length; i += batchSize) {
        const batch = playlist.tracks.slice(i, i + batchSize);
        const tx = db.transaction((arr) => {
          arr.forEach((t, idx) => {
            const pos = i + idx;
            insert.run(String(playlist.id), pos, String(t.id), t.name || '', downloader.joinArtists(t.artists || []), t.album || '', t.duration || 0);
          });
        });
        tx(batch);
        done = Math.min(done + batch.length, total);
        // 限频 emit：每批都 emit（200 首约几十 ms 完成）但保证 UI 不被压垮
        send('progress', {
          phase: 'persist',
          percent: 88 + Math.round((done / Math.max(1, total)) * 11),  // 88% → 99%
          message: `保存 ${done} / ${total} 首`,
          total,
          done,
        });
        lastEmit = Date.now();
      }

      send('progress', { phase: 'done', percent: 100, message: '导入完成' });
      send('done', {
        summary: {
          id: playlist.id,
          name: playlist.name,
          trackCount: playlist.tracks.length,
          coverImgUrl: playlist.coverImgUrl,
          creator: playlist.creator,
        },
        total: playlist.tracks.length,
      });
    } catch (err) {
      logger.warn(`[playlist/import-stream] ${err.message}`);
      send('error', { message: err.message });
    } finally {
      // 显式结束 SSE 流（不要用 return reply——那会让 fastify 提前关掉 raw 流，
      // 导致只有第一个 progress 事件能到客户端，进度条/完成事件全部丢失）
      setTimeout(close, 100);
    }
  });
}

module.exports = playlistRoutes;
