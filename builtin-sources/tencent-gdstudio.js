'use strict';

/**
 * 音源 3: QQ音乐 (gdstudio 公共镜像)
 * 通过 https://music-api.gdstudio.xyz/api/ 获取QQ音乐歌曲直链，可下 320k mp3。
 */

const { request } = globalThis.lx;

const BASE = 'https://music-api.gdstudio.xyz/api';
const SOURCE = 'tencent';

const QUALITY_MAP = { '128': 128000, '192': 192000, '320': 320000, 'flac': 999000 };

const info = {
  name: 'QQ音乐 (gdstudio 镜像)',
  platform: SOURCE,
  author: 'lx-music-docker 内置',
  description: '调用 gdstudio 公共镜像获取QQ音乐直链，可下 320k mp3 / flac。覆盖腾讯系版权内容。',
  type: 'music',
};

function pickArt(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((a) => a && (a.name || a)).filter(Boolean).join('、');
}

async function musicSearch({ key, page = 1, limit = 30 }) {
  const offset = (page - 1) * limit;
  let body;
  try {
    ({ body } = await request(`${BASE}/search`, {
      method: 'GET',
      params: { keywords: key, limit, offset, type: 1, source: SOURCE },
      timeout: 15000,
    }));
  } catch (e) {
    throw new Error(`搜索失败：${e.message}（检查 API 地址 ${BASE} 是否可达）`);
  }
  const songs = (body && body.result && body.result.songs) || [];
  if (!songs.length) return { total: 0, pages: 0, list: [] };
  const list = songs.map((s) => ({
    id: String(s.id),
    name: s.name,
    singer: pickArt(s.ar),
    artists: Array.isArray(s.ar) ? s.ar.map((a) => a && a.name).filter(Boolean) : [],
    album: s.al && s.al.name,
    source: SOURCE,
    interval: Math.round((s.dt || 0) / 1000),
    picUrl: s.al && s.al.picUrl,
    duration: Math.round((s.dt || 0) / 1000),
  }));
  const total = (body.result && body.result.songCount) || list.length;
  return { total, pages: Math.max(1, Math.ceil(total / limit)), list };
}

async function musicUrl(songInfo, quality) {
  const br = QUALITY_MAP[String(quality)] || QUALITY_MAP['320'];
  let body;
  try {
    ({ body } = await request(`${BASE}/song/url`, {
      method: 'GET',
      params: { id: songInfo.id, br, source: SOURCE },
      timeout: 15000,
    }));
  } catch (e) {
    throw new Error(`获取下载链接失败：${e.message}`);
  }
  const item = body && Array.isArray(body.data) ? body.data[0] : null;
  if (!item || !item.url) {
    throw new Error('此音源未返回可用链接（可能版权/地区限制下架）');
  }
  return {
    url: item.url,
    br: item.br || br,
    size: item.size || 0,
    type: item.type || 'mp3',
    level: item.level || '',
  };
}

async function lyric(songInfo) {
  try {
    const { body } = await request(`${BASE}/lyric`, {
      method: 'GET',
      params: { id: songInfo.id, source: SOURCE },
      timeout: 15000,
    });
    const lrc = body && body.lrc && body.lrc.lyric ? body.lrc.lyric : '';
    const tlc = body && body.tlyric && body.tlyric.lyric ? body.tlyric.lyric : '';
    return { lyric: lrc, tlyric: tlc };
  } catch (e) {
    return { lyric: '', tlyric: '' };
  }
}

async function pic(songInfo) {
  return { url: songInfo.picUrl || '' };
}

module.exports = { info, musicSearch, musicUrl, lyric, pic };