'use strict';

/**
 * 通用洛雪兼容脚本（自包含、不联网更新）
 * 使用 Deezer 公开 API 获取试听 + 完整元数据；下载的是 30 秒 mp3 试听片段。
 *
 * 真实环境请替换 musicUrl 中的 return，让它返回完整歌曲直链。
 * 真实社区脚本：https://github.com/lyswhut/lx-music-script
 */

const { request } = globalThis.lx;

const info = {
  name: 'Deezer 演示音源 (lx-music-docker 内置)',
  platform: 'deezer-demo',
  author: 'lx-music-docker',
  description: '粘贴即用，无远程依赖，下载 30 秒试听片段 (128kbps)',
  type: 'music',
};

async function musicSearch({ key, page = 1, limit = 30 }) {
  const offset = (page - 1) * limit;
  const { body } = await request('https://api.deezer.com/search', {
    method: 'GET',
    params: { q: key, index: offset, limit },
    timeout: 15000,
  });
  if (!body || !body.data) return { total: 0, pages: 0, list: [] };
  const list = body.data.map((t) => ({
    id: String(t.id),
    name: t.title,
    singer: (t.artist && t.artist.name) || '',
    artists: (t.contributors || []).map((c) => c.name).filter(Boolean),
    album: (t.album && t.album.title) || '',
    source: 'deezer-demo',
    interval: t.duration || 0,
    picUrl: (t.album && (t.album.cover_big || t.album.cover)) || '',
  }));
  return { total: body.total || list.length, pages: Math.ceil((body.total || list.length) / limit), list };
}

async function musicUrl(songInfo, quality) {
  const { body } = await request(`https://api.deezer.com/track/${songInfo.id}`, {
    method: 'GET',
    timeout: 15000,
  });
  if (!body || !body.preview) throw new Error('no preview url from deezer');
  return { url: body.preview, br: 128, size: 0, type: 'mp3' };
}

async function lyric(songInfo) {
  try {
    const { body } = await request(`https://api.deezer.com/track/${songInfo.id}/lyrics`, {
      method: 'GET',
      timeout: 15000,
    });
    const list = body && body.lyrics ? body.lyrics : [];
    return {
      lyric: list.map((l) => `${Math.round((l.start || 0) * 1000)},${Math.round((l.duration || 0) * 1000)},${(l.text || '').replace(/\n/g, '')}`).join('\n'),
      tlyric: '',
    };
  } catch (e) {
    return { lyric: '', tlyric: '' };
  }
}

async function pic(songInfo) {
  return { url: songInfo.picUrl || '' };
}

module.exports = { info, musicSearch, musicUrl, lyric, pic };