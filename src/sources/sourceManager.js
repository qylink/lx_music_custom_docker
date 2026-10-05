'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { executeSourceScript } = require('./sandbox');
const config = require('../config');
const logger = require('../utils/logger');

const BUILTIN_DIR = path.join(__dirname, '..', '..', 'builtin-sources');
const OFFICIAL_DIR = path.join(__dirname, '..', '..', 'official-sources');

// 用户音源启用状态持久化：server 重启后保留用户手动禁用的音源
const STATE_FILE = path.join(config.dataDir, 'sources-state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn(`[sources] failed to persist state: ${err.message}`);
  }
}

// 官方脚本（LX user-api 契约）里只上线 wy（网易）源；kg/kw/tx/mg 需要各自原生搜索，
// 继续用 gdstudio 内置源即可。需要扩展时往这里加即可。
const BRIDGE_ENABLED_SOURCES = ['wy'];

/**
 * 音源注册中心
 *
 * 音源脚本采用 LX Music 兼容格式（commonjs 模块）：
 *   const source = {
 *     info: {
 *       name: '音源名称',
 *       platform: 'custom',
 *       author: 'xxx',
 *       description: 'xxx',
 *       type: 'music',           // music | video
 *       config: { foo: { defaultValue, type } }, // 可选
 *     },
 *     async musicSearch({ key, page, limit }) { return { total, pages, list } },
 *     async musicUrl(songInfo, quality) { return { url, br, ... } },
 *     async lyric(songInfo) { return { lyric, tlyric } },
 *     async pic(songInfo) { return { url } },
 *   };
 *   module.exports = source;
 */

const registry = new Map(); // id -> record

// 音源变更回调（enable/disable/增删/刷新），用于让 queue 的 live-source 缓存失效
let _onChange = null;
function notifyChange() {
  if (typeof _onChange === 'function') { try { _onChange(); } catch (_) { /* noop */ } }
}
async function onChange(fn) { _onChange = fn; }

function hashId(filePath) {
  return crypto.createHash('md5').update(path.basename(filePath)).digest('hex').slice(0, 16);
}

function normalizeMethods(instance) {
  const map = {
    musicSearch: ['musicSearch', 'search'],
    musicUrl: ['musicUrl', 'getMusicUrl', 'songUrl'],
    lyric: ['lyric', 'lyricInfo'],
    pic: ['pic', 'picInfo', 'getPic'],
  };
  const out = {};
  for (const [key, candidates] of Object.entries(map)) {
    for (const name of candidates) {
      if (typeof instance[name] === 'function') { out[key] = instance[name]; break; }
    }
  }
  return out;
}

// 官方脚本风格：把音质映射为 LX 的 quality（128k/320k/flac...）
const { mapQuality } = require('../services/quality-utils');

// 官方脚本风格：根据脚本 send(inited) 注册的 sources 生成音源记录
function buildBridgeRecords(scriptRecord, bridge) {
  if (!bridge || !bridge.sources || typeof bridge.callAction !== 'function') return [];
  const records = [];
  const state = loadState();
  for (const [source, info] of Object.entries(bridge.sources)) {
    if (!BRIDGE_ENABLED_SOURCES.includes(source)) continue;
    if (!info.actions || !info.actions.includes('musicUrl')) continue;
    const id = `${scriptRecord.id}__${source}`;
    const qualitys = info.qualitys || [];
    const record = {
      id,
      file: scriptRecord.file,
      fileName: `${path.basename(scriptRecord.file, '.js')}__${source}.js`,
      size: scriptRecord.size,
      modifiedAt: scriptRecord.modifiedAt,
      parentId: scriptRecord.id,
      parentFileName: scriptRecord.fileName,
      // 子音源也恢复持久化的启用状态（用户可能只关掉 wy 不关 parent）
      enabled: state[id] && typeof state[id].enabled === 'boolean' ? state[id].enabled : true,
      info: {
        name: `官方脚本 · ${source} 直链`,
        platform: source,
        author: 'lyswhut/lx-music-source',
        description: `运行 lyswhut 官方脚本（${path.basename(scriptRecord.file)}），取 ${source} 直链。支持音质: ${qualitys.join('/') || '-'}`,
        type: 'music',
        qualitys,
      },
      methods: {
        musicUrl: async (songInfo, quality) => {
          const type = mapQuality(quality, qualitys);
          const r = await bridge.callAction(source, 'musicUrl', { musicInfo: songInfo, type });
          const url = r && r.data && r.data.url;
          if (!url) throw new Error('官方脚本未返回可用链接');
          return { url, type, source: `official-${source}` };
        },
      },
      error: null,
      loadedAt: Date.now(),
      builtin: !!scriptRecord.builtin,
    };
    if (info.actions.includes('lyric')) {
      record.methods.lyric = async (songInfo) => {
        const r = await bridge.callAction(source, 'lyric', { musicInfo: songInfo, type: '' });
        return r && r.data ? r.data : { lyric: '' };
      };
    }
    if (info.actions.includes('pic')) {
      record.methods.pic = async (songInfo) => {
        const r = await bridge.callAction(source, 'pic', { musicInfo: songInfo, type: '' });
        return { url: r && r.data ? r.data : '' };
      };
    }
    records.push(record);
  }
  return records;
}

// 把"官方桥接风格"脚本聚合为单一独立音源（供用户添加的 URL / 粘贴脚本使用）。
// 这样用户在 UI 里看到的是一张独立的音源卡片，而不是"父脚本 + 若干子音源"。
// 内部 musicUrl/lyric/pic 会自动尝试脚本声明的所有平台源（kw/kg/tx/wy/mg...）。
function buildAggregateRecord(scriptRecord, bridge) {
  if (!bridge || !bridge.sources) return scriptRecord;
  const state = loadState();
  const id = scriptRecord.id;

  // 收集脚本声明且支持 musicUrl 的平台源
  const urlSources = [];
  for (const [source, info] of Object.entries(bridge.sources)) {
    if (!info.actions || !info.actions.includes('musicUrl')) continue;
    urlSources.push({
      source,
      qualitys: info.qualitys || [],
      hasLyric: !!(info.actions && info.actions.includes('lyric')),
      hasPic: !!(info.actions && info.actions.includes('pic')),
    });
  }
  // 无任何可用音乐平台时保持原脚本（保留原错误/方法，交由 UI 提示）
  if (!urlSources.length) return scriptRecord;

  const platformNames = urlSources.map((s) => s.source).join('/');
  const info = scriptRecord.info || {};
  const aggregateInfo = {
    name: info.name || path.basename(scriptRecord.fileName, '.js'),
    platform: info.platform || 'custom',
    author: info.author || '',
    description: info.description || `聚合音源 · 平台：${platformNames}`,
    type: 'music',
    // 汇总所有平台的音质
    qualitys: Array.from(new Set(urlSources.flatMap((s) => s.qualitys))),
  };

  const methods = {
    musicUrl: async (songInfo, quality) => {
      let lastErr = null;
      for (const { source, qualitys } of urlSources) {
        try {
          const type = mapQuality(quality, qualitys);
          const r = await bridge.callAction(source, 'musicUrl', { musicInfo: songInfo, type });
          const url = r && r.data && r.data.url;
          if (url) return { url, type, source: `aggregate-${source}` };
        } catch (err) { lastErr = err; }
      }
      throw lastErr || new Error('未返回可用链接');
    },
  };
  // 歌词 / 封面：只要任一平台支持，就尝试
  const anyLyric = urlSources.some((s) => s.hasLyric);
  const anyPic = urlSources.some((s) => s.hasPic);
  if (anyLyric) {
    methods.lyric = async (songInfo) => {
      for (const { source, hasLyric } of urlSources) {
        if (!hasLyric) continue;
        try {
          const r = await bridge.callAction(source, 'lyric', { musicInfo: songInfo, type: '' });
          if (r && r.data && r.data.lyric) return r.data;
        } catch (_) { /* try next */ }
      }
      return { lyric: '' };
    };
  }
  if (anyPic) {
    methods.pic = async (songInfo) => {
      let lastErr = null;
      for (const { source, hasPic } of urlSources) {
        if (!hasPic) continue;
        try {
          const r = await bridge.callAction(source, 'pic', { musicInfo: songInfo, type: '' });
          if (r && r.data) return { url: r.data };
        } catch (err) { lastErr = err; }
      }
      throw lastErr || new Error('未获取到封面');
    };
  }

  return {
    ...scriptRecord,
    info: aggregateInfo,
    methods,
    error: null,
    parentId: null,
    parentFileName: null,
  };
}

async function loadFromFile(filePath, builtin = false, opts = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || !filePath.endsWith('.js')) return null;
  const code = await fsp.readFile(filePath, 'utf8');
  const id = hashId(filePath);
  const state = opts.state || loadState();
  const record = {
    id,
    file: filePath,
    fileName: path.basename(filePath),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    info: null,
    methods: {},
    enabled: state[id] && typeof state[id].enabled === 'boolean' ? state[id].enabled : true,
    error: null,
    loadedAt: Date.now(),
    builtin,
    sourceUrl: opts.sourceUrl || (state[id] && state[id].sourceUrl) || null,
    parentId: null,
    parentFileName: null,
    // 用户添加的音源（非内置）一律聚合为单一独立音源，不拆成"父脚本 + 子音源"
    aggregate: !builtin,
  };

  try {
    const { exports: instance, bridge } = await executeSourceScript(code, filePath, {
      name: path.basename(filePath, '.js'),
    });
    if (instance && instance.info) record.info = instance.info;
    record.methods = normalizeMethods(instance);
    const hasBridge = !!(bridge && bridge.sources && Object.keys(bridge.sources).length > 0);
    if (!record.methods.musicSearch && !record.methods.musicUrl && !hasBridge) {
      throw new Error('source must export at least musicSearch or musicUrl');
    }
    record.bridge = bridge;
  } catch (err) {
    record.error = err.message;
    logger.warn(`[sources] load failed: ${filePath} → ${err.message}`);
  }

  return record;
}

// 注册一条脚本记录（含官方脚本风格派生的子音源）
function registerRecord(record) {
  if (!record) return;
  // 用户添加的音源：聚合为单一独立音源（不拆分子音源）
  if (record.aggregate && record.bridge) {
    registry.set(record.id, buildAggregateRecord(record, record.bridge));
    notifyChange();
    return;
  }
  const children = record.bridge ? buildBridgeRecords(record, record.bridge) : [];
  for (const child of children) registry.set(child.id, child);
  // 父脚本始终注册（用于 UI 分组展示、删除、刷新、URL 追踪等）
  // 即使无 module.exports 方法、纯 bridge 父也要可见；callMethod 会因无对应方法自然报错
  registry.set(record.id, record);
  notifyChange();
}

async function loadAll() {
  registry.clear();
  let userCount = 0;
  let builtinCount = 0;
  let officialCount = 0;
  // 1) 先加载用户目录（高优先级，用户同名脚本会覆盖内置）
  try {
    const files = await fsp.readdir(config.sourcesDir);
    for (const name of files) {
      const file = path.join(config.sourcesDir, name);
      const record = await loadFromFile(file, false);
      if (record) {
        registerRecord(record);
        userCount++;
      }
    }
  } catch (err) {
    logger.warn('[sources] user readdir failed:', err.message);
  }
  // 2) 再加载内置目录（同名跳过，避免覆盖）
  for (const dir of [BUILTIN_DIR, OFFICIAL_DIR]) {
    try {
      const files = await fsp.readdir(dir).catch(() => []);
      for (const name of files) {
        const file = path.join(dir, name);
        const id = hashId(file);
        if (registry.has(id)) continue; // 用户版本优先
        const record = await loadFromFile(file, true);
        if (record) {
          registerRecord(record);
          if (dir === OFFICIAL_DIR) officialCount++; else builtinCount++;
        }
      }
    } catch (err) {
      logger.warn(`[sources] readdir failed (${dir}):`, err.message);
    }
  }
  logger.info(`[sources] loaded ${userCount} user + ${builtinCount} builtin + ${officialCount} official source(s)`);
}

async function reload(id) {
  const record = registry.get(id);
  if (!record) return null;
  for (const [rid, r] of [...registry.entries()]) {
    if (r.file === record.file) registry.delete(rid);
  }
  const fresh = await loadFromFile(record.file);
  if (!fresh) return null;
  registerRecord(fresh);
  return fresh;
}

function list() {
  return Array.from(registry.values()).map((r) => ({
    id: r.id,
    fileName: r.fileName,
    enabled: r.enabled,
    error: r.error,
    info: r.info,
    methods: Object.keys(r.methods),
    modifiedAt: r.modifiedAt,
    builtin: !!r.builtin,
    parentId: r.parentId || null,
    parentFileName: r.parentFileName || null,
    sourceUrl: r.sourceUrl || null,
    file: r.file,
  })).sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.fileName.localeCompare(b.fileName);
  });
}

function get(id) {
  return registry.get(id) || null;
}

async function addFromContent({ fileName, content, overwrite = false, sourceUrl = null }) {
  if (!fileName || !fileName.endsWith('.js')) {
    throw new Error('fileName must end with .js');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content is empty');
  }
  if (content.length > 1024 * 512) {
    throw new Error('source script too large (> 512KB)');
  }

  const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const target = path.join(config.sourcesDir, safeName);
  if (!overwrite && fs.existsSync(target)) {
    throw new Error(`source file already exists: ${safeName}`);
  }
  await fsp.writeFile(target, content, 'utf8');

  const record = await loadFromFile(target, false, { sourceUrl });
  if (record) registerRecord(record);
  return record;
}

async function addFromUrl({ url, fileName }) {
  const candidates = [url];
  // 1) raw.githubusercontent.com → jsdelivr CDN 兜底
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (m) {
    candidates.push(`https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`);
    candidates.push(`https://raw.gitmirror.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`);
  }
  // 2) github raw blob URL 兜底（api.github.com 多数情况能通）
  const blob = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (blob) {
    candidates.push(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`);
    candidates.push(`https://api.github.com/repos/${blob[1]}/${blob[2]}/contents/${blob[4]}?ref=${blob[3]}`);
  }

  const errors = [];
  for (const u of candidates) {
    try {
      const res = await axios.get(u, {
        timeout: 15000,
        maxContentLength: 1024 * 1024,
        responseType: 'text',
        headers: { 'User-Agent': 'lx-music-docker/1.0' },
      });
      let data = String(res.data || '');

      // GitHub Contents API 返回 base64 编码
      try {
        const obj = typeof data === 'string' ? JSON.parse(data) : null;
        if (obj && typeof obj.content === 'string' && obj.encoding === 'base64') {
          data = Buffer.from(obj.content.replace(/\n/g, ''), 'base64').toString('utf8');
        }
      } catch (_) { /* not json */ }

      let name = fileName;
      if (!name) {
        name = u.split('?')[0].split('/').pop() || `source-${Date.now()}.js`;
        if (!name.endsWith('.js')) name += '.js';
      }
      return addFromContent({ fileName: name, content: data, overwrite: true, sourceUrl: url });
    } catch (err) {
      errors.push(`${u} → ${err.message}`);
    }
  }
  throw new Error(`failed to fetch source script (tried ${candidates.length} mirrors). ${errors[0]}. 容器可能无法访问外网，请改用「直接粘贴脚本内容」方式。`);
}

async function remove(id) {
  const record = registry.get(id);
  if (!record) throw new Error('source not found');
  if (record.builtin) throw new Error('内置音源不可删除，可「禁用」隐藏');
  // 区分：删除脚本（父 + 子 + 文件）vs 仅删除子音源（保留父与文件）
  const isChild = !!record.parentId;
  if (isChild) {
    registry.delete(id);
    return { removed: id, fileDeleted: false };
  }
  // 父脚本：删除自身 + 所有共享同一文件的子音源
  for (const [rid, r] of [...registry.entries()]) {
    if (r.file === record.file) registry.delete(rid);
  }
  await fsp.unlink(record.file).catch(() => {});
  // 清理持久化状态
  const st = loadState();
  for (const [rid] of [...registry.entries()]) { /* registry already updated above */ }
  for (const key of Object.keys(st)) {
    if (key === id || (registry.get(key) === undefined)) {
      // 仅清理本次删除涉及到的 id（保留其它源的状态）
    }
  }
  delete st[id];
  // 同时清理子音源（按 file 推断）
  for (const key of Object.keys(st)) {
    // 子音源的 id 不是文件 hash，且持久化里只存 enabled/sourceUrl；删除父后对应子也无效
  }
  saveState(st);
  notifyChange();
  return { removed: id, fileDeleted: true };
}

async function setEnabled(id, enabled) {
  const record = registry.get(id);
  if (!record) throw new Error('source not found');
  record.enabled = !!enabled;
  // 持久化
  const st = loadState();
  st[id] = st[id] || {};
  st[id].enabled = record.enabled;
  if (record.sourceUrl) st[id].sourceUrl = record.sourceUrl;
  saveState(st);
  notifyChange();
  return record;
}

// 脚本级联携启用/禁用：影响父及其所有子音源（按 file）
async function setScriptEnabled(filePath, enabled) {
  const st = loadState();
  let count = 0;
  for (const [rid, r] of [...registry.entries()]) {
    if (r.file === filePath) {
      r.enabled = !!enabled;
      st[rid] = st[rid] || {};
      st[rid].enabled = r.enabled;
      if (r.sourceUrl) st[rid].sourceUrl = r.sourceUrl;
      count++;
    }
  }
  saveState(st);
  notifyChange();
  return { count };
}

// 一键启用/禁用所有音源（支持排除 builtin 不想动的情况，这里全量按 enabled 覆盖）
async function setAllEnabled(enabled) {
  const st = loadState();
  let count = 0;
  for (const [rid, r] of [...registry.entries()]) {
    if (r.parentId) continue; // 子音源跟随父，不单独改
    r.enabled = !!enabled;
    st[rid] = st[rid] || {};
    st[rid].enabled = r.enabled;
    if (r.sourceUrl) st[rid].sourceUrl = r.sourceUrl;
    count++;
  }
  saveState(st);
  notifyChange();
  return { count };
}

// 重新拉取 URL 并替换当前脚本（仅对 URL 添加的脚本）
async function refreshFromUrl(id) {
  const record = registry.get(id);
  if (!record) throw new Error('source not found');
  if (record.builtin) throw new Error('内置音源不可更新');
  if (!record.sourceUrl) throw new Error('该音源不是通过 URL 添加，无可更新链接');
  if (record.parentId) throw new Error('请刷新父脚本');

  // 重新拉取（同 addFromUrl 的镜像兜底逻辑）
  const url = record.sourceUrl;
  const candidates = [url];
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (m) {
    candidates.push(`https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`);
    candidates.push(`https://raw.gitmirror.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`);
  }
  const blob = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (blob) {
    candidates.push(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`);
    candidates.push(`https://api.github.com/repos/${blob[1]}/${blob[2]}/contents/${blob[4]}?ref=${blob[3]}`);
  }
  const errors = [];
  for (const u of candidates) {
    try {
      const res = await axios.get(u, {
        timeout: 15000,
        maxContentLength: 1024 * 1024,
        responseType: 'text',
        headers: { 'User-Agent': 'lx-music-docker/1.0' },
      });
      let data = String(res.data || '');
      try {
        const obj = typeof data === 'string' ? JSON.parse(data) : null;
        if (obj && typeof obj.content === 'string' && obj.encoding === 'base64') {
          data = Buffer.from(obj.content.replace(/\n/g, ''), 'base64').toString('utf8');
        }
      } catch (_) { /* not json */ }

      // 写回原文件
      await fsp.writeFile(record.file, data, 'utf8');
      // 卸载当前 file 的所有记录
      for (const [rid, r] of [...registry.entries()]) {
        if (r.file === record.file) registry.delete(rid);
      }
      // 重新加载（保留持久化 enabled/sourceUrl）
      const fresh = await loadFromFile(record.file, false, { sourceUrl: url });
      if (fresh) registerRecord(fresh);
      return fresh;
    } catch (err) {
      errors.push(`${u} → ${err.message}`);
    }
  }
  throw new Error(`failed to refresh source script (tried ${candidates.length} mirrors). ${errors[0]}`);
}

async function callMethod(id, method, ...args) {
  const record = registry.get(id);
  if (!record) throw new Error('source not found');
  if (!record.enabled) throw new Error('source is disabled');
  const fn = record.methods[method];
  if (!fn) throw new Error(`method ${method} not implemented by this source`);

  // 音乐直链下载：脚本若声明 info.qualitys，先按最接近规则调整请求音质
  // （bridge 派生子音源已在 buildBridgeRecords 里独立处理，这里覆盖普通 module.exports 脚本）
  let effectiveQuality = null;
  if (method === 'musicUrl' && args.length >= 2) {
    const qualitys = (record.info && Array.isArray(record.info.qualitys) && record.info.qualitys.length)
      ? record.info.qualitys : null;
    if (qualitys) {
      const requested = args[1];
      const adjusted = mapQuality(requested, qualitys);
      if (adjusted !== requested) {
        logger.info(`[sources] ${id}: quality ${requested} → ${adjusted} (supported: ${qualitys.join('/')})`);
      }
      args = [args[0], adjusted];
      effectiveQuality = adjusted;
    }
  }

  const timeoutMs = config.sourceCallTimeout || 15000;
  const result = await Promise.race([
    Promise.resolve().then(() => fn.apply(null, args)),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`source call timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)),
  ]);

  // 把 effectiveQuality 透出，调用方可在任务记录里存实际命中的音质
  if (effectiveQuality && result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, effectiveQuality };
  }
  return result;
}

module.exports = {
  loadAll,
  reload,
  list,
  get,
  addFromContent,
  addFromUrl,
  remove,
  setEnabled,
  setScriptEnabled,
  setAllEnabled,
  refreshFromUrl,
  callMethod,
  onChange,
};
