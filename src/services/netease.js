'use strict';

const axios = require('axios');
const { default: iconv } = require('iconv-lite');
const config = require('../config');
const logger = require('../utils/logger');

const ENDPOINTS = {
  detail: 'https://music.163.com/api/v6/playlist/detail',
  detailV3: 'https://music.163.com/api/v3/playlist/detail',
  songDetail: 'https://music.163.com/api/v3/song/detail',
  songUrl: 'https://music.163.com/api/song/enhance/player/url',
};

function buildHeaders(extra = {}) {
  const headers = {
    'User-Agent': config.neteaseUserAgent,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://music.163.com/',
    Origin: 'https://music.163.com',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (config.neteaseMusicU) headers.Cookie = `MUSIC_U=${config.neteaseMusicU}`;
  Object.assign(headers, extra);
  return headers;
}

async function getPlaylist(id, onProgress) {
  if (!id) throw new Error('id is required');
  if (typeof onProgress !== 'function') onProgress = () => {};

  onProgress({ phase: 'meta', percent: 5, message: '解析歌单元数据...' });

  async function fetchDetail(url, n) {
    const payload = new URLSearchParams({ id: String(id), n: String(n) }).toString();
    const res = await axios.post(url, payload, {
      headers: buildHeaders(),
      timeout: 20000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    const buf = Buffer.from(res.data);
    let text;
    try { text = iconv.decode(buf, 'utf8'); } catch (e) { text = buf.toString('utf8'); }
    try { return JSON.parse(text); } catch (e) {
      throw new Error(`netease response not valid json (status=${res.status})`);
    }
  }

  async function fetchSongDetail(ids) {
    const payload = new URLSearchParams({ c: JSON.stringify(ids.map((i) => ({ id: i }))) }).toString();
    const res = await axios.post(ENDPOINTS.songDetail, payload, {
      headers: buildHeaders(),
      timeout: 30000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    const buf = Buffer.from(res.data);
    let text;
    try { text = iconv.decode(buf, 'utf8'); } catch (e) { text = buf.toString('utf8'); }
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // 1) 拉歌单元数据（最多 1000 首）
  let json = await fetchDetail(ENDPOINTS.detail, 1000);
  if (!json || (json.code !== undefined && json.code !== 200)) {
    json = await fetchDetail(ENDPOINTS.detailV3, 1000);
  }
  if (!json || json.code !== 200) {
    throw new Error(`netease error: code=${json && json.code} message=${json && json.message}`);
  }

  const pl = json.playlist || {};
  let tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
  const trackIds = Array.isArray(pl.trackIds) ? pl.trackIds.map((t) => t && t.id).filter(Boolean) : tracks.map((t) => t.id);

  onProgress({
    phase: 'tracks',
    percent: 30,
    message: `已拉取元数据 ${tracks.length} 首`,
    total: trackIds.length || tracks.length,
    done: tracks.length,
  });

  // 2) 超出 1000 首时，剩余走 /song/detail 批量拉
  if (trackIds.length > tracks.length && trackIds.length > 0) {
    const haveIds = new Set(tracks.map((t) => t.id));
    const missing = trackIds.filter((id) => !haveIds.has(id));
    const batchSize = 500;
    onProgress({ phase: 'tracks', percent: 35, message: `共 ${trackIds.length} 首，分 ${Math.ceil(missing.length / batchSize)} 批补拉...`, total: trackIds.length, done: tracks.length });
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      try {
        const r = await fetchSongDetail(batch);
        const list = (r && r.songs) || [];
        tracks = tracks.concat(list);
      } catch (e) {
        logger.warn(`[netease] song detail batch failed: ${e.message}`);
      }
      const done = tracks.length;
      const percent = 35 + Math.round((done / Math.max(1, trackIds.length)) * 45);
      onProgress({
        phase: 'tracks',
        percent,
        message: `已补拉 ${done} / ${trackIds.length} 首`,
        total: trackIds.length,
        done,
      });
    }
  }

  onProgress({ phase: 'saving', percent: 82, message: `准备写入 ${tracks.length} 首...`, total: tracks.length, done: 0 });

  return {
    id: pl.id,
    name: pl.name,
    coverImgUrl: pl.coverImgUrl,
    creator: pl.creator && pl.creator.nickname,
    description: pl.description,
    playCount: pl.playCount,
    trackCount: pl.trackCount || trackIds.length,
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      duration: Math.round((t.duration || 0) / 1000),
      artists: (t.ar || []).map((a) => a.name).filter(Boolean),
      album: t.al && t.al.name,
      picUrl: t.al && t.al.picUrl,
      fee: t.fee,
      noCopyrightRcmd: t.noCopyrightRcmd,
      source: 'netease',
      raw: { id: t.id, name: t.name, artists: (t.ar || []).map((a) => a.name), album: t.al && t.al.name },
    })),
  };
}

function parseIdFromInput(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // 1. 纯数字 ID
  if (/^\d{4,}$/.test(s)) return s;

  // 2. URL：优先用 URL API 拿 query / hash 里的 id
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      for (const k of ['id', 'playlistId', 'userId']) {
        const v = u.searchParams.get(k);
        if (v && /^\d{4,}$/.test(v)) return v;
      }
      if (u.hash && u.hash.includes('?')) {
        const q = u.hash.split('?')[1];
        const sp = new URLSearchParams(q);
        for (const k of ['id', 'playlistId', 'userId']) {
          const v = sp.get(k);
          if (v && /^\d{4,}$/.test(v)) return v;
        }
      }
    } catch (_) { /* fall through */ }
  }

  // 3. 常见 NetEase URL 形式
  const patterns = [
    /music\.163\.com\/playlist\/(\d{4,})/i,
    /music\.163\.com[^\d]{0,40}(\d{4,})/i,
    /[?&]id=(\d{4,})/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m && m[1]) return m[1];
  }

  // 4. 兜底：抓第一个长数字段（≥4 位，避免误匹配）
  const fallback = s.match(/(\d{4,})/);
  if (fallback) return fallback[1];

  return null;
}

module.exports = {
  getPlaylist,
  parseIdFromInput,
};
