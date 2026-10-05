'use strict';

// 纯函数工具：错误分类、音质降级、Retry-After 解析
// 无 Node 原生依赖，便于单测；queue.js / sourceManager.js 复用。

const { LX_QUALITY_PRIORITY, QUALITY_ALIAS } = require('../constants');

// 错误分类：transient 网络 vs rate_limited 限流 vs permanent 内容问题
function classifyError(err) {
  if (!err) return 'unknown';
  if (err.trialOnly) return 'permanent';
  const code = (err.code || '').toString();
  const msg = (err.message || '').toLowerCase();
  const status = err.response && err.response.status;
  if (status === 429) return 'rate_limited';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'transient';
  if (status >= 500 && status < 600) return 'transient';
  if (/timeout|速率|限流|rate.?limit|too many|abuse|blocked|ip.?banned/i.test(msg)) return 'rate_limited';
  if (status === 401 || status === 403 || status === 404 || status === 410) return 'permanent';
  if (/not.?found|不存在|无权|no such|empty url|no.*available/i.test(msg)) return 'permanent';
  if (/source (is disabled|not found)/i.test(msg)) return 'permanent';
  // 中文版权/下架/无返回可用链接：歌在该源不存在或下架，跨源 fallback，全失败后 prune
  if (/未返回可用链接|无版权|下架|版权|无.*链接|无.*资源/i.test(msg)) return 'permanent';
  return 'unknown';
}

// 解析 Retry-After 头（秒数或 HTTP 日期）
function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const s = String(headerVal).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const t = Date.parse(s);
  if (!isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

// 同源内降级音质（按 LX_QUALITY_PRIORITY 找更低的支持档）
function downgradeQuality(q, supported = []) {
  const order = LX_QUALITY_PRIORITY;
  const normalized = QUALITY_ALIAS[String(q || '').toLowerCase()] || q;
  const idx = order.indexOf(normalized);
  if (idx < 0) return null;
  for (let i = idx + 1; i < order.length; i++) {
    if (supported.length === 0 || supported.includes(order[i])) return order[i];
  }
  return null;
}

// 把请求音质映射到支持的音质（from sourceManager.mapQuality）
function mapQuality(requested, supported = []) {
  const q = QUALITY_ALIAS[String(requested || '')] || '320k';
  if (supported.includes(q)) return q;
  for (const p of LX_QUALITY_PRIORITY) {
    if (supported.includes(p)) return p;
  }
  return supported[0] || '128k';
}

module.exports = { classifyError, parseRetryAfter, downgradeQuality, mapQuality };
