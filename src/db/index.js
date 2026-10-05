'use strict';

const path = require('path');
const fs = require('fs');
const betterSqlite3 = require('better-sqlite3');
const config = require('../config');

const dbFile = config.dbFile;
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new betterSqlite3(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
// 解决「retry-all 期间 worker 并发写 → database is locked」：自动重试最多 5s
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  name TEXT,
  cover TEXT,
  track_count INTEGER,
  imported_at INTEGER
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT,
  position INTEGER,
  song_id TEXT,
  name TEXT,
  artists TEXT,
  album TEXT,
  duration INTEGER,
  PRIMARY KEY (playlist_id, position)
);
CREATE TABLE IF NOT EXISTS download_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  source_label TEXT,
  song_name TEXT,
  artists TEXT,
  album TEXT,
  duration INTEGER,
  pic_url TEXT,
  source_url TEXT,
  quality TEXT,
  status TEXT,
  progress INTEGER,
  size INTEGER,
  target_relpath TEXT,
  error TEXT,
  fallback_source_ids TEXT,
  fallback_index INTEGER,
  song_id TEXT,
  song_key TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  playlist_id TEXT
);
CREATE TABLE IF NOT EXISTS song_cache (
  key TEXT PRIMARY KEY,
  source TEXT,
  source_id TEXT,
  name TEXT,
  artists TEXT,
  album TEXT,
  duration INTEGER,
  meta TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON download_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_playlist ON download_tasks(playlist_id);
`);

/**
 * 启动时 schema 迁移：检测 download_tasks 是否有新加的字段，没有就 ALTER TABLE 加
 * SQLite 没有 IF NOT EXISTS ADD COLUMN，所以用 try/catch 吞 duplicate column 错误
 */
function migrateDownloadTasks() {
  const cols = db.prepare(`PRAGMA table_info(download_tasks)`).all();
  const names = new Set(cols.map((c) => c.name));
  const alters = [];
  if (!names.has('fallback_source_ids')) alters.push('ADD COLUMN fallback_source_ids TEXT');
  if (!names.has('fallback_index')) alters.push('ADD COLUMN fallback_index INTEGER');
  if (!names.has('song_id')) alters.push('ADD COLUMN song_id TEXT');
  if (!names.has('song_key')) alters.push('ADD COLUMN song_key TEXT');
  if (!names.has('retry_count')) alters.push('ADD COLUMN retry_count INTEGER DEFAULT 0');
  if (!names.has('error_kind')) alters.push('ADD COLUMN error_kind TEXT');
  if (!names.has('tried_sources')) alters.push('ADD COLUMN tried_sources TEXT');
  for (const ddl of alters) {
    try {
      db.exec(`ALTER TABLE download_tasks ${ddl}`);
    } catch (err) {
      // duplicate column / 兼容旧 SQLite
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
  if (alters.length) {
    console.info(`[db] migration: download_tasks +${alters.length} column(s)`);
  }
  // 一次性清理历史永久失败任务：
  // 1) error_kind=permanent（早已分类） 2) 错误文案匹配已知永久模式（改进前产生，error_kind 是 unknown/null）
  //    —— 这些歌在来源上已下架/无版权/无链接，无需再堆积在失败列表
  try {
    const r = db.prepare(`
      DELETE FROM download_tasks
      WHERE status = 'failed' AND (
        error_kind = 'permanent'
        OR error LIKE '%未返回可用链接%'
        OR error LIKE '%无版权%'
        OR error LIKE '%下架%'
        OR error LIKE '%source not found%'
        OR error LIKE '%source is disabled%'
      )
    `).run();
    if (r.changes > 0) console.info(`[db] cleanup: pruned ${r.changes} historical permanent-failed task(s)`);
  } catch (err) {
    // 列不存在（极旧 DB）就跳过
    if (!/no such column/i.test(err.message)) throw err;
  }
}
migrateDownloadTasks();

// song_key 列可能由上面迁移新增，索引必须放在迁移之后
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_song_key ON download_tasks(song_key)`);

const stmts = {
  upsertPlaylist: db.prepare(`
    INSERT INTO playlists(id, source, name, cover, track_count, imported_at)
    VALUES (@id, @source, @name, @cover, @trackCount, @importedAt)
    ON CONFLICT(id) DO UPDATE SET
      source=excluded.source, name=excluded.name, cover=excluded.cover,
      track_count=excluded.track_count, imported_at=excluded.imported_at
  `),
  insertTrack: db.prepare(`
    INSERT OR REPLACE INTO playlist_tracks(playlist_id, position, song_id, name, artists, album, duration)
    VALUES (@playlistId, @position, @songId, @name, @artists, @album, @duration)
  `),
  removeTracks: db.prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ?`),
  insertTask: db.prepare(`
    INSERT INTO download_tasks(
      source_id, source_label, song_name, artists, album, duration, pic_url,
      source_url, quality, status, progress, size, target_relpath, error,
      fallback_source_ids, fallback_index, song_id, song_key, retry_count,
      error_kind, tried_sources,
      created_at, updated_at, playlist_id
    ) VALUES (
      @sourceId, @sourceLabel, @songName, @artists, @album, @duration, @picUrl,
      @sourceUrl, @quality, @status, @progress, @size, @targetRelpath, @error,
      @fallbackSourceIds, @fallbackIndex, @songId, @songKey, @retryCount,
      @errorKind, @triedSources,
      @createdAt, @updatedAt, @playlistId
    )
  `),
  updateTask: db.prepare(`
    UPDATE download_tasks SET
      status = @status,
      progress = @progress,
      size = @size,
      target_relpath = @targetRelpath,
      error = @error,
      source_id = @sourceId,
      source_label = @sourceLabel,
      fallback_index = @fallbackIndex,
      quality = @quality,
      retry_count = @retryCount,
      error_kind = @errorKind,
      tried_sources = @triedSources,
      updated_at = @updatedAt
    WHERE id = @id
  `),
  listTasks: db.prepare(`
    SELECT * FROM download_tasks
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `),
  countTasks: db.prepare(`SELECT COUNT(*) AS c FROM download_tasks WHERE (? = '' OR status = ?)`),
  getTask: db.prepare(`SELECT * FROM download_tasks WHERE id = ?`),
  deleteTask: db.prepare(`DELETE FROM download_tasks WHERE id = ?`),
  pendingOnly: db.prepare(`SELECT * FROM download_tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1`),
  statTasks: db.prepare(`SELECT status, COUNT(*) AS c FROM download_tasks GROUP BY status`),
  listPlaylists: db.prepare(`SELECT * FROM playlists ORDER BY imported_at DESC`),
  getPlaylist: db.prepare(`SELECT * FROM playlists WHERE id = ?`),
  getPlaylistTracks: db.prepare(`SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC`),
  getPlaylistTracksPage: db.prepare(`SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC LIMIT ? OFFSET ?`),
  countPlaylistTracks: db.prepare(`SELECT COUNT(*) AS c FROM playlist_tracks WHERE playlist_id = ?`),
  upsertSongCache: db.prepare(`
    INSERT INTO song_cache(key, source, source_id, name, artists, album, duration, meta, updated_at)
    VALUES (@key, @source, @sourceId, @name, @artists, @album, @duration, @meta, @updatedAt)
    ON CONFLICT(key) DO UPDATE SET
      source=excluded.source, source_id=excluded.source_id, name=excluded.name,
      artists=excluded.artists, album=excluded.album, duration=excluded.duration,
      meta=excluded.meta, updated_at=excluded.updated_at
  `),
  getSongCache: db.prepare(`SELECT * FROM song_cache WHERE key = ?`),
  existingTaskBySongKey: db.prepare(`
    SELECT id, status FROM download_tasks
    WHERE song_key = ? AND status IN ('success', 'skipped', 'pending', 'running')
    LIMIT 1
  `),
  updateTaskSongKey: db.prepare(`
    UPDATE download_tasks SET song_key = @songKey, updated_at = @updatedAt WHERE id = @id
  `),
};

module.exports = {
  db,
  stmts,
};
