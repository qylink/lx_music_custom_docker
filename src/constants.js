'use strict';

// 音质统一常量：供 queue.js（降级阶梯）与 sourceManager.js（mapQuality）共享
// 注意：builtin-sources / official-sources 里运行的音源脚本是独立沙箱，
// 无法 require 本文件，它们各自维护映射（wy_qualitys 等）。
//
// LX 优先级：从高到低（flac24bit > flac > wav > ape > 320k > 192k > 128k）
const LX_QUALITY_PRIORITY = ['flac24bit', 'flac', 'wav', 'ape', '320k', '192k', '128k'];

// 数字/别名 → LX 标准音质名
const QUALITY_ALIAS = {
  '128': '128k', '128k': '128k',
  '192': '192k', '192k': '192k',
  '320': '320k', '320k': '320k',
  flac: 'flac',
  flac24bit: 'flac24bit',
  wav: 'wav',
  ape: 'ape',
};

module.exports = { LX_QUALITY_PRIORITY, QUALITY_ALIAS };
