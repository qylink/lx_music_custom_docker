/**
 * 示例音源：把歌曲名作为搜索关键字直接回传一个示例 URL（不真实可用，仅用于演示与测试）
 * 部署：将本文件保存到 data/sources/ 目录下，重启服务即可；或在 Web UI 中粘贴本内容添加。
 *
 * 真实环境请使用社区维护的音源（https://github.com/lyswhut/lx-music-script 等），
 * 它们使用相同的模块导出格式（module.exports）。
 */
'use strict';

const info = {
  name: '示例音源（Mock）',
  platform: 'example',
  author: 'lx-music-docker',
  description: '演示用，不返回真实音频链接',
  type: 'music',
};

async function musicSearch({ key, page = 1, limit = 30 }) {
  const all = Array.from({ length: 25 }, (_, i) => ({
    id: String(i + 1),
    name: `${key} · 第 ${i + 1} 首`,
    singer: '示例艺人',
    artists: ['示例艺人'],
    album: '示例专辑',
    source: 'example',
    interval: 180 + i,
    duration: 180 + i,
  }));
  const start = (page - 1) * limit;
  return {
    total: all.length,
    pages: Math.ceil(all.length / limit),
    list: all.slice(start, start + limit),
  };
}

async function musicUrl(songInfo, quality) {
  // 真实音源需要返回真实可用的 mp3 / flac URL
  return { url: '', br: 0, error: '此为示例音源，请安装一个真实音源后再下载' };
}

const source = {
  info,
  musicSearch,
  musicUrl,
  lyric: async () => ({ lyric: '', tlyric: '' }),
  pic: async () => ({ url: '' }),
};

module.exports = source;
