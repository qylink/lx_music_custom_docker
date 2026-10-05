'use strict';

const sourceManager = require('../sources/sourceManager');
const { ok, fail } = require('../utils/response');

// LX 兼容的字段名：LX Desktop 用 songmid，我们用 id/ids/songmid 都接受
function pickId(s) {
  return String(s.songmid || s.id || s.ids || s.songId || s.mid || '');
}
function pickInterval(s) {
  // LX 用 "mm:ss" 或 "HH:mm:ss"，我们用秒数。统一成秒
  if (s.interval == null) return 0;
  if (typeof s.interval === 'number') return s.interval;
  if (typeof s.interval === 'string' && s.interval.includes(':')) {
    const parts = s.interval.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}
function pickSinger(s) {
  return String(s.singer || (Array.isArray(s.artists) ? s.artists.join('、') : s.artist) || '').trim();
}
function pickAlbum(s) {
  return String(s.albumName || s.album || '').trim();
}
function pickName(s) {
  return String(s.name || s.title || s.songname || '').trim();
}

function filterStr(s) {
  return String(s || '')
    .replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!/g, '')
    .toLowerCase()
    .trim();
}

const SINGERS_SPLIT_RE = /、|&|;|；|\/|,|，|\|/;
function sortSingers(s) {
  if (!s || !SINGERS_SPLIT_RE.test(s)) return s || '';
  return s.split(SINGERS_SPLIT_RE).sort((a, b) => a.localeCompare(b)).join('、');
}

async function musicRoutes(fastify) {
  fastify.get('/api/music/search', async (req, reply) => {
    const { key, singer, sourceId, page = 1, limit = 30 } = req.query || {};
    if (!sourceId) return reply.code(400).send(fail('sourceId is required'));
    const trimmedKey = String(key || '').trim();
    const trimmedSinger = String(singer || '').trim();
    if (!trimmedKey && !trimmedSinger) return reply.code(400).send(fail('key or singer is required'));

    const numericPage = Math.max(1, parseInt(page, 10) || 1);
    const numericLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));

    try {
      // 参考官方 LX：把名字/歌手拆开传给音源脚本，让脚本各自过滤；老脚本若只用 key，仍能 work
      const searchKey = [trimmedKey, trimmedSinger].filter(Boolean).join(' ').trim();
      const result = await sourceManager.callMethod(
        sourceId,
        'musicSearch',
        { key: searchKey, name: trimmedKey, singer: trimmedSinger, page: numericPage, limit: numericLimit },
      );

      let list = [];
      let total = 0;
      let pages = 1;
      if (Array.isArray(result)) {
        list = result;
      } else if (result && typeof result === 'object') {
        list = result.list || result.data || result.songs || [];
        total = result.total || list.length;
        pages = result.pages || 1;
      }
      // 统一字段
      list = list.map((s) => ({
        ...s,
        source: sourceId,
        sourceLabel: sourceManager.get(sourceId)?.info?.name || sourceId,
        id: pickId(s),
        name: pickName(s),
        singer: pickSinger(s),
        album: pickAlbum(s),
        interval: pickInterval(s),
        picUrl: s.picUrl || s.img || s.pic || '',
      }));
      return ok({ list, total, pages, sourceId });
    } catch (err) {
      return reply.code(400).send(fail(err.message));
    }
  });

  /**
   * 跨音源搜索（按 LX Desktop 的 findMusic 算法）
   * 输入：一首歌（name + singer + albumName + interval）
   * 输出：所有音源里最匹配的结果，按名字/歌手/专辑/时长匹配度排序
   */
  fastify.post('/api/music/find', async (req, reply) => {
    const body = req.body || {};
    const name = filterStr(body.name || '');
    const singer = filterStr(sortSingers(body.singer || ''));
    const albumName = filterStr(body.albumName || '');
    const interval = body.interval ? MathIntv(body.interval) : 0;

    if (!name && !singer) return reply.code(400).send(fail('name or singer required'));

    const sources = sourceManager.list().filter((s) => s.enabled && s.methods.includes('musicSearch'));
    // 把歌手/名字都传过去，老脚本取 key；新脚本能拆开用 name+singer
    const searchKey = [name, singer].filter(Boolean).join(' ').trim();

    // 每个源独立 promise，立即返回状态（用于前端展示每个源的加载状态）
    const tasks = sources.map((src) =>
      sourceManager.callMethod(src.id, 'musicSearch', {
        key: searchKey, name, singer, page: 1, limit: 25,
      })
        .then((r) => ({ source: src, list: extractList(r) }))
        .catch((err) => ({ source: src, error: err.message, list: [] })),
    );
    const lists = await Promise.all(tasks);

    const sourceStats = lists.map((x) => ({
      sourceId: x.source.id,
      sourceLabel: x.source.info?.name || x.source.id,
      count: x.list.length,
      error: x.error || null,
    }));

    const validLists = lists.filter((x) => x.list.length);

    const isEqualsInterval = (intv) => Math.abs((interval || intv || 0) - (intv || interval || 0)) < 5;
    const isIncludesName = (n) => (name.includes(n) || n.includes(name));
    const isIncludesSinger = (s) => singer ? (singer.includes(s) || s.includes(singer)) : true;

    const allMatches = [];
    for (const { source, list } of validLists) {
      for (const raw of list) {
        const item = {
          ...raw,
          source: source.id,
          sourceLabel: source.info?.name || source.id,
          id: pickId(raw),
          name: pickName(raw),
          singer: pickSinger(raw),
          album: pickAlbum(raw),
          interval: pickInterval(raw),
          picUrl: raw.picUrl || raw.img || raw.pic || '',
          fSinger: filterStr(sortSingers(pickSinger(raw))),
          fMusicName: filterStr(pickName(raw)),
          fAlbumName: filterStr(pickAlbum(raw)),
          fInterval: pickInterval(raw),
        };
        if (isEqualsInterval(item.fInterval)) {
          if (item.fMusicName === name && isIncludesSinger(item.fSinger)) {
            allMatches.push(item); continue;
          }
        }
      }
    }

    // 第二轮：只匹配歌手 + 名字
    for (const { source, list } of validLists) {
      for (const raw of list) {
        const fn = filterStr(pickName(raw));
        const fs2 = filterStr(sortSingers(pickSinger(raw)));
        if (fn === '' || fs2 === '') continue;
        if (fs2 === singer && isIncludesName(fn) && !allMatches.some((m) => m.id === pickId(raw) && m.source === source.id)) {
          allMatches.push({
            ...raw,
            source: source.id,
            sourceLabel: source.info?.name || source.id,
            id: pickId(raw),
            name: pickName(raw),
            singer: pickSinger(raw),
            album: pickAlbum(raw),
            interval: pickInterval(raw),
            picUrl: raw.picUrl || raw.img || raw.pic || '',
            fSinger: filterStr(sortSingers(pickSinger(raw))),
            fMusicName: filterStr(pickName(raw)),
            fAlbumName: filterStr(pickAlbum(raw)),
            fInterval: pickInterval(raw),
          });
        }
      }
    }

    // 按 LX Desktop 的优先级排序
    const sortMusic = (arr, callback) => {
      const temp = [];
      for (let i = arr.length - 1; i > -1; i--) {
        const item = arr[i];
        if (callback(item)) {
          temp.push(item);
          arr.splice(i, 1);
        }
      }
      temp.reverse();
      return temp;
    };

    const result = [];
    if (allMatches.length) {
      result.push(...sortMusic(allMatches, (i) => i.fSinger === singer && i.fMusicName === name && i.interval === interval));
      result.push(...sortMusic(allMatches, (i) => i.fMusicName === name && i.fSinger === singer && i.fAlbumName === albumName));
      result.push(...sortMusic(allMatches, (i) => i.fSinger === singer && i.fMusicName === name));
      result.push(...sortMusic(allMatches, (i) => i.fMusicName === name && i.interval === interval));
      result.push(...sortMusic(allMatches, (i) => i.fSinger === singer && i.interval === interval));
      result.push(...sortMusic(allMatches, (i) => i.interval === interval));
      result.push(...sortMusic(allMatches, (i) => i.fMusicName === name));
      result.push(...sortMusic(allMatches, (i) => i.fSinger === singer));
      result.push(...sortMusic(allMatches, (i) => i.fAlbumName === albumName));
      for (const item of allMatches) {
        delete item.fSinger; delete item.fMusicName; delete item.fAlbumName; delete item.fInterval;
      }
      result.push(...allMatches);
    }

    return ok({
      matches: result.slice(0, 50),
      total: result.length,
      sources: sourceStats,
    });
  });
}

function extractList(r) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') return r.list || r.data || r.songs || [];
  return [];
}

function MathIntv(s) {
  if (!s) return 0;
  if (typeof s === 'number') return s;
  if (typeof s === 'string' && s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

module.exports = musicRoutes;
