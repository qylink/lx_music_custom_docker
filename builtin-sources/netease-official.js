'use strict';

/**
 * 音源：网易云音乐官方 eapi（自包含，无需第三方镜像）
 *
 * 用 Node 内置 crypto 实现 NetEase 官方 AES-128-ECB 加密协议，
 * 直接连 https://interface3.music.163.com，能下 128k mp3。
 * 如果 .env 里设置了 NETEASE_MUSIC_U cookie，则可下到 320k / flac。
 *
 * 接口契约（兼容洛雪桌面版）：
 *   musicSearch({ key, page, limit }) -> { total, pages, list }
 *   musicUrl(songInfo, quality)        -> { url, br, size, type }
 *   lyric(songInfo)                    -> { lyric, tlyric }
 *   pic(songInfo)                      -> { url }
 *
 * 字段参考：
 *   https://github.com/lyswhut/lx-music-source/blob/master/src/apis/wy.js
 *   https://github.com/listen1/listen1_chrome_extension/blob/master/js/provider/netease.js
 */

const crypto = require('crypto');
const { request } = globalThis.lx;

const SOURCE = 'netease';
const EAPI_key = 'e82ckenh8dichen8';
const EAPI_BASE = 'https://interface3.music.163.com';
const MOBILE_BASE = 'https://music.163.com';

// = 官方 LX 桌面端 wy 源同名变量：
//   wy_qualitys  = 音质名 → br number
//   wy_token     = MUSIC_U（官方从脚本注释 @wy_token 解析；我们从 env 读）
//   wy_cookie    = 实际请求用的 cookie header
//   wy_qualitys 官方是 '128k'/'320k'/flac，我们再加 '192k' 和 string 数字兼容老调用
const wy_qualitys = { '128': 128000, '128k': 128000, '192': 192000, '192k': 192000, '320': 320000, '320k': 320000, flac: 999000 };

// 扩展：wy_token 池（NETEASE_MUSIC_U 支持 || 或 , 分隔的多个 token 轮换）→ 官方没有、我们加的
let wy_token_pool = [];
let wy_token_idx = 0;
function initWyTokenPool() {
  if (wy_token_pool.length > 0) return;
  const raw = (process.env.NETEASE_MUSIC_U || '').trim();
  if (!raw) return;
  wy_token_pool = raw.split(/[||,]/).map((s) => s.trim()).filter(Boolean);
}
function nextWyToken() {
  if (wy_token_pool.length === 0) return null;
  const c = wy_token_pool[wy_token_idx % wy_token_pool.length];
  wy_token_idx = (wy_token_idx + 1) % wy_token_pool.length;
  return c;
}
function rotateWyTokenFromResponse(headers) {
  if (!headers || typeof headers !== 'object') return;
  const raw = headers['set-cookie'] || headers['Set-Cookie'] || headers['cookie'];
  if (!raw) return;
  const lines = Array.isArray(raw) ? raw : String(raw).split(/\r?\n/);
  for (const line of lines) {
    const m = String(line).match(/MUSIC_U=([^;,;]+)/);
    if (m && m[1]) {
      const fresh = decodeURIComponent(m[1]);
      if (fresh && !wy_token_pool.includes(fresh)) wy_token_pool[wy_token_idx] = fresh;
    }
  }
}
initWyTokenPool();

const info = {
  name: '网易云音乐 (官方 eapi)',
  platform: SOURCE,
  author: 'lx-music-docker 内置',
  description:
    '用 Node crypto 实现 NetEase 官方 AES-128-ECB 加密协议，直连 interface3.music.163.com，' +
    '无需第三方镜像。默认 128k mp3；填入 .env 的 NETEASE_MUSIC_U 后可下到 320k / flac。',
  type: 'music',
  qualitys: ['128', '192', '320', 'flac'],
};

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function aes128EcbEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  cipher.setAutoPadding(true);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

/**
 * NetEase eapi 加密
 *   text = url + '-' + SALT1 + '-' + body + '-' + SALT1 + '-' + md5('nobody'+url+'use'+body+'md5forencrypt')
 *   enc  = AES-128-ECB(text, 'e82ckenh8dichen8') -> HEX (大写)
 */
function eapi(url, body) {
  const text = typeof body === 'object' ? JSON.stringify(body) : String(body);
  const digest = md5(`nobody${url}use${text}md5forencrypt`);
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return aes128EcbEncrypt(data, EAPI_key).toUpperCase();
}

function pickArt(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((a) => a && (a.name || a)).filter(Boolean).join('、');
}

async function musicSearch({ key, page = 1, limit = 30 }) {
  const offset = (page - 1) * limit;
  // 公开的搜索接口（web 接口，无登录态可下）
  const url = `${MOBILE_BASE}/api/cloudsearch/pc?s=${encodeURIComponent(key)}&type=1&limit=${limit}&offset=${offset}&total=true`;
  let body;
  try {
    ({ body } = await request(url, { method: 'GET', timeout: 15000 }));
  } catch (e) {
    throw new Error(`搜索失败：${e.message}`);
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

async function fetchSongUrl(songmid, br) {
  const target = `${EAPI_BASE}/eapi/song/enhance/player/url`;
  const eapiPath = '/api/song/enhance/player/url';
  const params = eapi(eapiPath, { ids: `[${songmid}]`, br });
  // 官方 LX 风格 cookie 头：MUSIC_U=<token>; os=pc
  const myToken = nextWyToken();
  const wy_cookie = myToken ? `MUSIC_U=${myToken}; os=pc` : 'os=pc';
  let resp;
  try {
    resp = await request(target, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:82.0) Gecko/20100101 Firefox/82.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: wy_cookie,
      },
      form: { params },
      timeout: 15000,
    });
  } catch (e) {
    const err = new Error(`eapi 请求失败：${e.message}`);
    err.transient = true;
    throw err;
  }
  // 官方 LX 模式：resp.headers.cookie 更新到 wy_token 池
  if (resp && resp.headers) rotateWyTokenFromResponse(resp.headers);
  const body = resp && resp.body;
  if (!body || !Array.isArray(body.data)) {
    throw new Error(`无返回数据（body.code=${body && body.code}）`);
  }
  return { item: body.data[0] || null, body };
}

async function musicUrl(songInfo, quality) {
  const requestedBr = wy_qualitys[String(quality)] || wy_qualitys['128'];
  // 自动降级阶梯：320 → 192 → 128；任何源失败的 VIP/付费都自动往下试
  const ladder = [320000, 192000, 128000].filter((b) => b <= requestedBr);
  // 用户没指定高质量时不主动尝试低档
  if (ladder.length === 0) ladder.push(wy_qualitys['128']);
  let lastErr = null;
  for (const br of ladder) {
    try {
      const { item, body } = await fetchSongUrl(songInfo.id, br);
      if (item && item.url) {
        return {
          url: item.url,
          br: item.br || br,
          size: item.size || 0,
          type: item.type || 'mp3',
          level: item.level || '',
        };
      }
      // item 为空 → 看为什么
      const flags = [];
      if (item && item.code != null) flags.push(`code=${item.code}`);
      if (item && item.fee === 1) flags.push('VIP');
      else if (item && item.fee && item.fee > 1) flags.push(`fee=${item.fee}`);
      if (item && item.freeTrialInfo) flags.push('试听版');
      if (item && item.url && /\.m3u8(\?|$)/i.test(item.url)) flags.push('m3u8试听流');
      if (item && item.payed === 0 && br > wy_qualitys['128']) flags.push('需登录下 320k/Flac');
      const reason = '网易云无版权/需登录/下架' + (flags.length ? ` [${flags.join(',')}]` : '');
      // 试听版 → 所有源都一样，直接 throw（不再降级也不再 fallback 浪费公网请求）
      if (flags.some((f) => f === '试听版' || f === 'm3u8试听流')) {
        const e = new Error(reason);
        e.trialOnly = true;
        throw e;
      }
      // 先看 VIP / 付费 → 自动降一档（即使 code=-110 也可能是仅高码VIP）
      if (item && (item.fee > 0 || item.payed === 0) && br > wy_qualitys['128']) {
        lastErr = new Error(reason);
        continue;
      }
      // 显式不存在（code -110 / 404）→ 不再降级
      if (item && (item.code === -110 || item.code === 404)) {
        throw new Error(reason);
      }
      // 其他未知空 url → 当作不存在
      throw new Error(reason);
    } catch (e) {
      // 网络错误 → 视为 transient 让 queue 处理
      if (e.transient) throw e;
      // 试听版抛错 → 跳过 fallback，直接走永久失败路径
      if (e.trialOnly) throw e;
      lastErr = e;
      // 不可恢复错误（code -110）→ 跳出
      if (/code=-110|code=404/.test(e.message)) throw e;
    }
  }
  // 所有品质都试了仍失败
  throw lastErr || new Error('网易云无版权/需登录/下架');
}

async function lyric(songInfo) {
  try {
    const target = `${MOBILE_BASE}/api/song/lyric?id=${songInfo.id}&lv=1&kv=1&tv=-1`;
    const { body } = await request(target, { method: 'GET', timeout: 15000 });
    const lrc = (body && body.lrc && body.lrc.lyric) || '';
    const tlc = (body && body.tlyric && body.tlyric.lyric) || '';
    return { lyric: lrc, tlyric: tlc };
  } catch (e) {
    return { lyric: '', tlyric: '' };
  }
}

async function pic(songInfo) {
  return { url: songInfo.picUrl || '' };
}

module.exports = { info, musicSearch, musicUrl, lyric, pic };