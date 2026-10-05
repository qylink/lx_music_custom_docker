'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');

/**
 * 使用 Node.js 内置 vm 模块在受限沙箱中执行音源脚本。
 *
 * 完整兼容洛雪桌面版(LX Music)的自定义音源脚本契约，参考：
 *   https://github.com/lyswhut/lx-music-desktop/blob/master/src/main/modules/userApi/renderer/preload.js
 *
 * 注入的 globalThis.lx 提供：
 *   EVENT_NAMES          = { request, inited, updateAlert }
 *   request(url, opts, cb) -> 双模式：有 callback 时返回 cancel 函数（needle 风格回调），
 *                           无 callback 时返回 Promise（{ status, statusCode, body, headers, raw }）
 *   on(eventName, handler) / send(eventName, data)  -> 事件系统（request / inited / updateAlert）
 *   utils.crypto.{ aesEncrypt(buf,mode,key,iv), rsaEncrypt(buf,key), randomBytes, md5, ... }
 *   utils.buffer.{ from, bufToString, toString, concat }
 *   utils.zlib.{ inflate(buf)->Promise, deflate(data)->Promise, deflateSync, inflateSync }
 *   currentScriptInfo.{ name, description, version, author, homepage, rawScript }
 *   version='2.0.0', env='docker'
 *
 * 返回 { exports, bridge }，bridge 供 sourceManager 检测"官方脚本风格"（send(inited) 注册的 sources）：
 *   bridge.sources     -> { source: { type, actions, qualitys } }
 *   bridge.callAction(source, action, info) -> 调用脚本注册的 request handler 并校验返回
 */
async function executeSourceScript(scriptCode, filename, meta = {}) {
  const builtinHttp = require('http');
  const builtinHttps = require('https');
  const builtinUrl = require('url');
  const builtinCrypto = require('crypto');
  const builtinZlib = require('zlib');

  const allowedModules = {
    axios,
    crypto: builtinCrypto,
    https: builtinHttps,
    http: builtinHttp,
    url: builtinUrl,
    querystring,
    zlib: builtinZlib,
  };

  const sandboxRequire = (mod) => {
    if (Object.prototype.hasOwnProperty.call(allowedModules, mod)) {
      return allowedModules[mod];
    }
    throw new Error(`module "${mod}" is not allowed in source scripts`);
  };

  const noop = () => {};
  const dbg = process.env.LX_DEBUG === '1';
  const sandboxConsole = dbg
    ? { log: (...a) => process.stdout.write('[sx.log] ' + a.map(String).join(' ') + '\n'), info: (...a) => process.stdout.write('[sx.info] ' + a.map(String).join(' ') + '\n'), warn: (...a) => process.stdout.write('[sx.warn] ' + a.map(String).join(' ') + '\n'), error: (...a) => process.stdout.write('[sx.error] ' + a.map(String).join(' ') + '\n'), debug: (...a) => process.stdout.write('[sx.debug] ' + a.map(String).join(' ') + '\n') }
    : { log: noop, info: noop, warn: noop, error: noop, debug: noop };

  /* ============ LX 契约：request（needle 风格，双模式） ============ */
  function lxRequest(url, options = {}, callback) {
    if (dbg) process.stdout.write(`[sx.req] ${String(url).slice(0, 150)}\n`);
    const method = (options.method || 'get').toLowerCase();
    const headers = { ...(options.headers || {}) };
    const timeout = typeof options.timeout === 'number' && options.timeout > 0
      ? Math.min(options.timeout, 60000)
      : 60000;

    const config = {
      url,
      method,
      headers,
      timeout,
      validateStatus: () => true,
      maxRedirects: 5,
      maxContentLength: 50 * 1024 * 1024,
      responseType: 'arraybuffer',
      transformResponse: [(d) => d],
    };
    if (options.params) config.params = options.params;

    let data;
    let isForm = false;
    if (options.body !== undefined) {
      data = options.body;
    } else if (options.form) {
      data = options.form;
      isForm = true;
    } else if (options.formData) {
      data = options.formData;
      isForm = true;
    } else if (options.data !== undefined) {
      data = options.data;
    }
    if (data !== undefined) {
      if (typeof data === 'string') {
        config.data = data;
      } else if (isForm) {
        config.data = querystring.stringify(data);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        config.data = JSON.stringify(data);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
    }

    const perform = () => axios.request(config).then((res) => {
      const buf = Buffer.from(res.data || []);
      const headers2 = {};
      for (const [k, v] of Object.entries(res.headers || {})) headers2[k.toLowerCase()] = v;
      const resp = {
        statusCode: res.status,
        statusMessage: res.statusText || String(res.status),
        headers: headers2,
        bytes: Number(res.headers['content-length'] || 0),
        raw: buf,
      };
      let body = buf.toString('utf8');
      try { body = JSON.parse(body); } catch (_) { /* keep text */ }
      resp.body = body;
      return resp;
    });

    if (typeof callback === 'function') {
      const CancelToken = axios.CancelToken;
      const source = CancelToken.source();
      config.cancelToken = source.token;
      perform().then((resp) => {
        callback.call(null, null, resp, resp.body);
      }).catch((err) => {
        if (axios.isCancel(err)) return;
        callback.call(null, err, null, null);
      });
      return () => source.cancel('cancelled');
    }

    return perform().then((resp) => ({
      status: resp.statusCode,
      statusCode: resp.statusCode,
      body: resp.body,
      headers: resp.headers,
      raw: resp.raw,
    }));
  }

  /* ============ LX 契约：事件系统（request / inited / updateAlert） ============ */
  const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
  const eventNames = Object.values(EVENT_NAMES);
  const events = { request: null };
  let isInitedApi = false;
  let isShowedUpdateAlert = false;
  let initedSources = null;

  const allSources = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'];
  const supportQualitys = {
    kw: ['128k', '320k', 'flac', 'flac24bit'],
    kg: ['128k', '320k', 'flac', 'flac24bit'],
    tx: ['128k', '320k', 'flac', 'flac24bit'],
    wy: ['128k', '320k', 'flac', 'flac24bit'],
    mg: ['128k', '320k', 'flac', 'flac24bit'],
    local: [],
  };
  const supportActions = {
    kw: ['musicUrl'],
    kg: ['musicUrl'],
    tx: ['musicUrl'],
    wy: ['musicUrl'],
    mg: ['musicUrl'],
    xm: ['musicUrl'],
    local: ['musicUrl', 'lyric', 'pic'],
  };

  function handleInit(info) {
    if (!info || typeof info !== 'object' || !info.sources) {
      throw new Error('Missing required parameter init info');
    }
    const sourceInfo = {};
    for (const source of allSources) {
      const userSource = info.sources[source];
      if (!userSource || userSource.type !== 'music') continue;
      const qualitys = supportQualitys[source] || [];
      const actions = supportActions[source] || [];
      sourceInfo[source] = {
        type: 'music',
        actions: actions.filter((a) => userSource.actions && userSource.actions.includes(a)),
        qualitys: qualitys.filter((q) => userSource.qualitys && userSource.qualitys.includes(q)),
      };
    }
    return sourceInfo;
  }

  const on = (eventName, handler) => {
    if (!eventNames.includes(eventName)) return Promise.reject(new Error('The event is not supported: ' + eventName));
    if (eventName === EVENT_NAMES.request && typeof handler === 'function') {
      events.request = handler;
      return Promise.resolve();
    }
    return Promise.reject(new Error('The event is not supported: ' + eventName));
  };

  const off = () => Promise.resolve();
  const sendMessage = noop;
  const send = (eventName, data) => new Promise((resolve, reject) => {
    if (!eventNames.includes(eventName)) return reject(new Error('The event is not supported: ' + eventName));
    switch (eventName) {
      case EVENT_NAMES.inited:
        if (isInitedApi) return reject(new Error('Script is inited'));
        isInitedApi = true;
        try {
          initedSources = handleInit(data);
          resolve();
        } catch (err) {
          reject(err);
        }
        break;
      case EVENT_NAMES.updateAlert:
        if (isShowedUpdateAlert) return reject(new Error('The update alert can only be called once.'));
        isShowedUpdateAlert = true;
        resolve();
        break;
      default:
        reject(new Error('Unknown event name: ' + eventName));
    }
  });

  function callAction(source, action, info) {
    if (!events.request) return Promise.reject(new Error('Request event is not defined'));
    return Promise.resolve(events.request.call(null, { source, action, info })).then((response) => {
      switch (action) {
        case 'musicUrl':
          if (typeof response !== 'string' || response.length > 2048 || !/^https?:/.test(response)) {
            throw new Error('failed');
          }
          return { source, action, data: { type: info.type, url: response } };
        case 'pic':
          if (typeof response !== 'string' || response.length > 2048 || !/^https?:/.test(response)) {
            throw new Error('failed');
          }
          return { source, action, data: response };
        case 'lyric':
          if (!response || typeof response.lyric !== 'string') throw new Error('failed');
          return {
            source, action,
            data: {
              lyric: response.lyric,
              tlyric: typeof response.tlyric === 'string' ? response.tlyric : null,
              rlyric: typeof response.rlyric === 'string' ? response.rlyric : null,
              lxlyric: typeof response.lxlyric === 'string' ? response.lxlyric : null,
            },
          };
        default:
          return { source, action, data: response };
      }
    });
  }

  /* ============ LX 契约：utils ============ */
  const lxUtils = {
    buffer: {
      from(...args) { return Buffer.from(...args); },
      bufToString(buf, format) { return Buffer.from(buf, 'binary').toString(format); },
      toString(buf, encoding) { return Buffer.from(buf).toString(encoding || 'utf8'); },
      concat: (list, total) => Buffer.concat(list, total),
    },
    crypto: {
      aesEncrypt(buffer, mode, key, iv) {
        const cipher = builtinCrypto.createCipheriv(mode, key, iv);
        return Buffer.concat([cipher.update(buffer), cipher.final()]);
      },
      rsaEncrypt(buffer, key) {
        buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
        return builtinCrypto.publicEncrypt({ key, padding: builtinCrypto.constants.RSA_NO_PADDING }, buffer);
      },
      randomBytes(size) { return builtinCrypto.randomBytes(size); },
      md5(str) { return builtinCrypto.createHash('md5').update(str).digest('hex'); },
      sha1(str) { return builtinCrypto.createHash('sha1').update(str).digest('hex'); },
      sha256(str) { return builtinCrypto.createHash('sha256').update(str).digest('hex'); },
      hmac: (algo, key, data) => builtinCrypto.createHmac(algo, key).update(data).digest('hex'),
      uuid: () => builtinCrypto.randomUUID(),
    },
    zlib: {
      inflate(buf) {
        return new Promise((resolve, reject) => {
          builtinZlib.inflate(buf, (err, data) => (err ? reject(new Error(err.message)) : resolve(data)));
        });
      },
      deflate(data) {
        return new Promise((resolve, reject) => {
          builtinZlib.deflate(data, (err, buf) => (err ? reject(new Error(err.message)) : resolve(buf)));
        });
      },
      inflateSync: (data) => builtinZlib.inflateSync(Buffer.isBuffer(data) ? data : Buffer.from(String(data))),
      deflateSync: (data) => builtinZlib.deflateSync(Buffer.isBuffer(data) ? data : Buffer.from(String(data))),
    },
    string: {
      hexToBytes: (hex) => Buffer.from(hex, 'hex'),
      bytesToHex: (buf) => Buffer.from(buf).toString('hex'),
      reverseHex: (hex) => Buffer.from(hex, 'hex').reverse().toString('hex'),
    },
    rawScript: scriptCode,
  };

  const baseName = (meta.name || filename || 'source.js').split(/[\\/]/).pop();
  const lx = {
    VERSION: 'lx-music-docker-1.4.5',
    version: '2.0.0',
    env: 'docker',
    platform: 'docker',
    scriptInfo: { name: baseName, type: 'music' },
    EVENT_NAMES,
    request: lxRequest,
    on,
    off,
    send,
    sendMessage,
    rawScript: scriptCode,
    utils: lxUtils,
    scripts: { on: noop, off: noop, open: noop, close: noop },
    currentScriptInfo: {
      name: meta.name || baseName,
      description: meta.description || '',
      version: meta.version || '',
      author: meta.author || '',
      homepage: meta.homepage || '',
      rawScript: scriptCode,
    },
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: sandboxRequire,
    console: sandboxConsole,
    Buffer,
    URL,
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    setImmediate, clearImmediate,
    Promise,
    JSON,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    Symbol,
    Map,
    Set,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    TextDecoder,
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    process: {
      env: {
        NETEASE_MUSIC_U: process.env.NETEASE_MUSIC_U || '',
        TZ: process.env.TZ || '',
        NODE_ENV: process.env.NODE_ENV || 'production',
      },
      platform: process.platform,
      version: process.version,
    },
    lx: dbg
      ? new Proxy(lx, {
          get(t, prop) {
            if (typeof prop === 'string') {
              const v = t[prop];
              process.stdout.write(`[sx.lx.get] ${prop} -> ${typeof v === 'function' ? 'fn' : JSON.stringify(v)}\n`);
            }
            const v = t[prop];
            if (dbg && typeof v === 'function') {
              return (...args) => {
                process.stdout.write(`[sx.lx.call] ${String(prop)}(${args.map((a) => (typeof a === 'string' ? a.slice(0, 60) : typeof a)).join(', ')})\n`);
                return v.apply(t, args);
              };
            }
            return v;
          },
        })
      : lx,
  };

  const script = new vm.Script(scriptCode, { filename, lineOffset: 0, displayErrors: true });
  const context = vm.createContext(sandbox);
  try {
    script.runInContext(context, { timeout: 10000 });
  } catch (err) {
    if (dbg) process.stdout.write(`[sx.catch] ${err && err.stack ? err.stack : err}\n`);
    throw new Error(`script init failed: ${err && err.message ? err.message : err}`);
  }

  // 官方脚本风格的音源脚本会异步调用 send(EVENT_NAMES.inited, ...)，
  // 这里等一等异步的 inited（有 request handler 但还没 inited 时等待最多 5s），
  // 这样 add/add-url 后能立即注册出派生的子音源。
  if (typeof events.request === 'function' && initedSources === null) {
    const deadline = Date.now() + 5000;
    while (initedSources === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const exported = sandbox.module.exports && Object.keys(sandbox.module.exports).length > 0
    ? sandbox.module.exports
    : sandbox.exports;

  Promise.resolve(exported).catch((err) => {
    console.warn(`[sandbox] unhandled rejection from ${filename}: ${err && err.message}`);
  });

  return {
    exports: exported,
    bridge: {
      sources: initedSources || null,
      hasRequestHandler: typeof events.request === 'function',
      callAction,
    },
  };
}

module.exports = { executeSourceScript };