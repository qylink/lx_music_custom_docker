'use strict';

const axios = require('axios');
const { parseStream } = require('music-metadata');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');

let pinyin = null;
try { pinyin = require('pinyin').pinyin; } catch (_) { /* optional */ }

function sanitize(name) {
  if (!name) return 'unknown';
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
}

function joinArtists(artists, sep = '、') {
  if (!Array.isArray(artists) || artists.length === 0) return 'Unknown Artist';
  return artists.map((a) => sanitize(typeof a === 'string' ? a : a.name)).join(sep);
}

function letterFolder(name) {
  if (!name) return '#';
  const cleaned = String(name).trim();
  const c = cleaned.charAt(0);
  if (/[A-Za-z]/.test(c)) return c.toUpperCase();
  if (/[\u3400-\u9fff]/.test(cleaned)) {
    if (pinyin) {
      try {
        const py = pinyin(cleaned[0], { pattern: 'first', toneType: 'none' })[0]?.[0] || '';
        const f = (py || '').charAt(0).toUpperCase();
        return /[A-Z]/.test(f) ? f : '#';
      } catch (_) { /* fall through */ }
    }
    return '#中';
  }
  if (/[0-9]/.test(c)) return '#';
  return '#';
}

function buildTargetFile({ artist, album, name }) {
  const artistFolder = sanitize(joinArtists([artist]).split(/[&]/)[0]);
  const albumFolder = sanitize(album);
  const fileName = `${sanitize(name)}.mp3`;
  return path.join(
    letterFolder(artistFolder),
    artistFolder,
    albumFolder,
    fileName,
  );
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function downloadOne(url, targetAbs) {
  await ensureDir(path.dirname(targetAbs));
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: config.downloadTimeout,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: '*/*',
      Referer: 'https://music.163.com/',
    },
    maxRedirects: 5,
    maxContentLength: 100 * 1024 * 1024,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const total = Number(res.headers['content-length'] || 0);
  const out = fs.createWriteStream(targetAbs);
  let received = 0;
  await new Promise((resolve, reject) => {
    res.data.on('data', (chunk) => {
      received += chunk.length;
    });
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.data.pipe(out);
  });
  return { size: total || received, received };
}

async function writeId3v2(target, meta) {
  try {
    const stream = fs.createReadStream(target);
    const originalMeta = await parseStream(stream, { duration: true, skipCovers: false });
    stream.close();
    const { title, artist, album, artists, albumArtist } = meta;
    const updated = {
      ...(originalMeta.common || {}),
      title: title || originalMeta.common.title,
      artist: artist || originalMeta.common.artist,
      artists: artists || originalMeta.common.artists,
      album: album || originalMeta.common.album,
      albumartist: albumArtist || originalMeta.common.albumartist,
    };
    fs.writeFileSync(target + '.meta.json', JSON.stringify({ ...updated, metaWroteAt: Date.now() }, null, 2));
  } catch (err) {
    try { fs.writeFileSync(target + '.meta.error.txt', err.message); } catch (_) { /* noop */ }
  }
}

function matches(songName, songArtists, fileKey) {
  const k = String(fileKey || '').toLowerCase();
  if (!k) return false;
  const n = String(songName || '').toLowerCase();
  const ar = Array.isArray(songArtists) ? songArtists.join('-').toLowerCase() : String(songArtists || '').toLowerCase();
  return k.includes(n) && (ar ? k.includes(ar.split(/[& /]/)[0]) : true);
}

function fmtSize(b) {
  if (b == null || isNaN(b)) return '-';
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + 'MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

function fmtShortUrl(url, maxLen = 80) {
  if (!url) return '';
  if (url.length <= maxLen) return url;
  const qIdx = url.indexOf('?');
  const base = qIdx >= 0 ? url.slice(0, qIdx) : url;
  return base.slice(0, maxLen) + '…';
}

// 按 source 平台选 UA / Referer / Accept 等请求头。模拟官方 LX 桌面端按平台选头，
// 避免单一 UA + 163 referer 被识别为机器行为。
const PLATFORM_HEADERS = {
  wy:     { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', referer: 'https://music.163.com/' },
  kg:     { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', referer: 'https://www.kugou.com/' },
  kw:     { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', referer: 'http://www.kuwo.cn/' },
  tx:     { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', referer: 'https://y.qq.com/' },
  mg:     { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', referer: 'https://music.migu.cn/' },
  netease:{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', referer: 'https://music.163.com/' },
  default:{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', referer: 'https://music.163.com/' },
};

function detectPlatform(sourceLabel, sourceId) {
  const haystack = `${sourceLabel || ''} ${sourceId || ''}`.toLowerCase();
  if (haystack.includes('netease') || haystack.includes('wy') || haystack.includes('网易')) return 'wy';
  if (haystack.includes('kugou') || haystack.includes('kg') || haystack.includes('酷狗')) return 'kg';
  if (haystack.includes('kuwo') || haystack.includes('kw') || haystack.includes('酷我')) return 'kw';
  if (haystack.includes('tencent') || haystack.includes('tx') || haystack.includes('qq') || haystack.includes('腾讯')) return 'tx';
  if (haystack.includes('migu') || haystack.includes('mg') || haystack.includes('咪咕')) return 'mg';
  return 'default';
}

function headersForSource(sourceLabel, sourceId) {
  const platform = detectPlatform(sourceLabel, sourceId);
  const ph = PLATFORM_HEADERS[platform] || PLATFORM_HEADERS.default;
  return {
    'User-Agent': ph.userAgent,
    Accept: '*/*',
    Referer: ph.referer,
  };
}

module.exports = {
  sanitize,
  joinArtists,
  letterFolder,
  buildTargetFile,
  downloadOne,
  writeId3v2,
  matches,
  fmtSize,
  fmtShortUrl,
  headersForSource,
  detectPlatform,
};
