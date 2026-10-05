'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function toast(msg, type = '') {
  const box = $('#toast');
  const el = document.createElement('div');
  el.textContent = msg;
  if (type) el.style.borderColor = `var(--${type})`;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let json;
  try { json = await r.json(); } catch (e) { json = { code: -1, message: await r.text() }; }
  if (json.code !== 0) {
    const err = new Error(json.message || `HTTP ${r.status}`);
    err.data = json;
    throw err;
  }
  return json.data;
}

function fmtSize(b) {
  if (!b) return '-';
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + 'MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}
function fmtDuration(s) {
  if (!s) return '-';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function fmtSpeed(bps) {
  if (!bps) return '';
  return `${fmtSize(bps)}/s`;
}
function fmtEta(sec) {
  if (!sec || sec < 0) return '';
  if (sec > 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec > 60) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${sec}s`;
}

/* ============ tabs ============ */
$$('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    t.classList.add('active');
    $(`.panel[data-panel="${t.dataset.tab}"]`).classList.add('active');
    handlers[t.dataset.tab]?.();
  });
});

const handlers = {
  sources: loadSources,
  search: loadSearch,
  playlist: loadPlaylists,
  download: loadDownloads,
  files: loadFiles,
  settings: loadSettings,
};

/* ============ health check ============ */
async function healthTick() {
  try {
    const info = await api('GET', '/api/info');
    $('#health').innerHTML = `<span class="dot ok"></span>已连接 · ${info.sources} 个音源`;
    window.__info = info;
    // NETEASE_MUSIC_U 未配置时，在下载面板顶部显示横幅提示
    const banner = $('#neteaseBanner');
    if (banner) {
      if (!info.neteaseConfigured) {
        banner.classList.remove('hidden');
        banner.innerHTML = '<strong>网易云 MUSIC_U 未配置</strong>　当前只能下 128k 公开歌曲（VIP/付费会失败）。在 <code>.env</code> 设 <code>NETEASE_MUSIC_U=&lt;你的token&gt;</code> 后重启容器即可下 320k / flac 和 VIP 歌（多个 token 用 <code>||</code> 分隔会轮换使用）。';
      } else {
        banner.classList.add('hidden');
      }
    }
  } catch (e) {
    $('#health').innerHTML = `<span class="dot err"></span>未连接`;
  }
}

setInterval(healthTick, 8000);
healthTick();

/* ============ sources ============ */
async function loadSources() {
  const list = await api('GET', '/api/sources');
  $('#srcCount').textContent = `(${list.length})`;
  const root = $('#sourceList');
  if (!list.length) {
    root.innerHTML = `<div class="muted">还没有音源，请在上方表单里添加一个，或者点击「拉取并添加」使用公开的 LX 脚本。</div>`;
    return;
  }
  root.innerHTML = '';

  // 官方 LX 桌面端操作逻辑：父脚本一张卡，子音源挂在下面
  // 1) 把 list 按 parentId 分组（parentId 为空的就是父或独立音源）
  const byParent = new Map();
  const standalone = [];
  list.forEach((s) => {
    if (s.parentId) {
      if (!byParent.has(s.parentId)) byParent.set(s.parentId, []);
      byParent.get(s.parentId).push(s);
    } else {
      standalone.push(s);
    }
  });

  // 2) 父脚本优先（含子音源的），再排独立音源
  let ordered = [...standalone.filter((s) => byParent.has(s.id)), ...standalone.filter((s) => !byParent.has(s.id))];
  // 排序
  const sort = ($('#srcSort') && $('#srcSort').value) || 'default';
  if (sort === 'name') {
    ordered = [...ordered].sort((a, b) => ((a.info && a.info.name) || a.fileName).localeCompare((b.info && b.info.name) || b.fileName, 'zh'));
  } else if (sort === 'type') {
    ordered = [...ordered].sort((a, b) => (a.info && a.info.platform || '').localeCompare(b.info && b.info.platform || ''));
  }

  // 需 cookie 徽章：netease 且未配置 NETEASE_MUSIC_U 时提示
  const needCookie = !(window.__info && window.__info.neteaseConfigured);
  const cookieBadge = (platform) => needCookie && /netease|网易|wy/i.test(platform || '') ? '<span class="src-cookie-badge">需cookie</span> ' : '';

  ordered.forEach((s) => {
    const children = byParent.get(s.id) || [];
    const card = document.createElement('div');
    const allEnabled = children.length === 0 ? s.enabled : children.every((c) => c.enabled) && s.enabled;
    card.className = `src-card ${allEnabled ? '' : 'disabled'}`;
    const info = s.info || {};
    const badge = s.builtin ? '<span class="badge-builtin">内置</span> ' : '';
    const cookieB = cookieBadge(info.platform);
    const urlHint = s.sourceUrl ? `<span class="src-url" title="${escapeHtml(s.sourceUrl)}">${escapeHtml(shortUrl(s.sourceUrl))}</span>` : '';
    card.innerHTML = `
      <h3>${badge}${cookieB}${escapeHtml(info.name || s.fileName)}${urlHint}</h3>
      <div class="meta">${escapeHtml(info.platform || 'custom')} · ${escapeHtml(info.author || '')}${s.parentId ? '' : ` · <span class="muted">${children.length ? children.length + ' 个子音源' : ''}</span>`}</div>
      <div class="meta">${escapeHtml(info.description || '')}</div>
      ${s.error ? `<div class="err">${escapeHtml(s.error)}</div>` : ''}
      <div class="actions">
        <button data-act="toggle-script" title="切换脚本及所有子音源的启用状态">${allEnabled ? '全部禁用' : '全部启用'}</button>
        <button data-act="view">查看脚本</button>
        <button data-act="reload">重新加载</button>
        ${s.sourceUrl ? '<button data-act="refresh">从 URL 更新</button>' : ''}
        <button data-act="del" class="danger"${s.builtin ? ' disabled title="内置音源不可删除"' : ''}>${s.builtin ? '内置' : (children.length ? '删除全部' : '删除')}</button>
      </div>
    `;
    const fileEndpoint = s.file || null;
    card.querySelector('[data-act=toggle-script]').onclick = async () => {
      try {
        await api('POST', `/api/sources/${s.id}/toggle`, { enabled: !allEnabled, scope: 'script' });
        toast(allEnabled ? '已全部禁用' : '已全部启用', 'ok');
        loadSources();
      } catch (e) { toast(e.message, 'err'); }
    };
    card.querySelector('[data-act=view]').onclick = async () => {
      try {
        const r = await api('GET', `/api/sources/${s.id}/file`);
        $('#srcDialogCode').textContent = r.code;
        $('#srcDialog').showModal();
      } catch (e) { toast(e.message, 'err'); }
    };
    card.querySelector('[data-act=reload]').onclick = async () => {
      try {
        const r = await api('POST', `/api/sources/${s.id}/reload`);
        r.error ? toast(r.error, 'err') : toast('已重载', 'ok');
        loadSources();
      } catch (e) { toast(e.message, 'err'); }
    };
    const refreshBtn = card.querySelector('[data-act=refresh]');
    if (refreshBtn) refreshBtn.onclick = async () => {
      try {
        await api('POST', `/api/sources/${s.id}/refresh`);
        toast('已更新脚本', 'ok');
        loadSources();
      } catch (e) { toast(e.message, 'err'); }
    };
    card.querySelector('[data-act=del]').onclick = async () => {
      const childTxt = children.length ? `（含 ${children.length} 个子音源）` : '';
      if (!confirm(`删除音源 ${s.fileName}${childTxt}？`)) return;
      try {
        await api('DELETE', `/api/sources/${s.id}`);
        toast('已删除', 'ok');
        loadSources();
      } catch (e) { toast(e.message, 'err'); }
    };
    root.appendChild(card);

    // 子音源（嵌套在父卡下）
    children.forEach((c) => {
      const sub = document.createElement('div');
      sub.className = `src-sub ${c.enabled ? '' : 'disabled'}`;
      const cinfo = c.info || {};
      sub.innerHTML = `
        <span class="src-sub-name">${escapeHtml(cinfo.name || c.fileName)}</span>
        <span class="src-sub-platform">${escapeHtml(cinfo.platform || '')}</span>
        <span class="src-sub-methods">${(c.methods || []).map((m) => `<span>${m}</span>`).join('')}</span>
        ${c.error ? `<span class="err">${escapeHtml(c.error)}</span>` : ''}
        <span class="src-sub-actions">
          <button data-act="toggle" data-id="${c.id}">${c.enabled ? '禁用' : '启用'}</button>
          <button data-act="del-sub" data-id="${c.id}" class="danger">移除</button>
        </span>
      `;
      sub.querySelector('[data-act=toggle]').onclick = async (e) => {
        e.stopPropagation();
        try {
          await api('POST', `/api/sources/${c.id}/toggle`, { enabled: !c.enabled });
          toast(c.enabled ? '已禁用' : '已启用', 'ok');
          loadSources();
        } catch (err) { toast(err.message, 'err'); }
      };
      sub.querySelector('[data-act=del-sub]').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`仅移除子音源 ${c.fileName}（不删除脚本文件）？`)) return;
        try {
          await api('DELETE', `/api/sources/${c.id}`);
          toast('已移除子音源', 'ok');
          loadSources();
        } catch (err) { toast(err.message, 'err'); }
      };
      card.appendChild(sub);
    });
  });
}

// 全部启用/禁用 + 排序切换
$('#btnSrcEnableAll').onclick = async () => {
  try { await api('POST', '/api/sources/toggle-all', { enabled: true }); toast('已全部启用', 'ok'); loadSources(); }
  catch (e) { toast(e.message, 'err'); }
};
$('#btnSrcDisableAll').onclick = async () => {
  try { await api('POST', '/api/sources/toggle-all', { enabled: false }); toast('已全部禁用', 'ok'); loadSources(); }
  catch (e) { toast(e.message, 'err'); }
};
$('#srcSort').onchange = () => loadSources();

function shortUrl(url, max = 38) {
  if (!url || url.length <= max) return url || '';
  const u = url.replace(/^https?:\/\//, '');
  if (u.length <= max) return u;
  return u.slice(0, max - 1) + '…';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#btnAddSource').onclick = async () => {
  const fileName = $('#srcFileName').value.trim() || `source-${Date.now()}.js`;
  const content = $('#srcContent').value;
  if (!content.trim()) return toast('请填音源脚本', 'warn');
  try {
    const r = await api('POST', '/api/sources/add', { fileName, content });
    toast(r.sources && r.sources.length ? `已添加，注册 ${r.sources.length} 个子音源` : '已添加', 'ok');
    $('#srcContent').value = '';
    $('#srcFileName').value = '';
    // 添加成功后自动折叠 + 跳到列表
    $('#srcAddDetails').removeAttribute('open');
    loadSources();
  } catch (e) { toast(e.message, 'err'); loadSources(); }
};
$('#btnAddSourceUrl').onclick = async () => {
  const url = $('#srcUrl').value.trim();
  if (!url) return toast('请填 URL', 'warn');
  try {
    const r = await api('POST', '/api/sources/add-url', { url });
    toast(r.sources && r.sources.length ? `已从 URL 添加，注册 ${r.sources.length} 个子音源` : '已从 URL 添加', 'ok');
    $('#srcUrl').value = '';
    loadSources();
  } catch (e) { toast(e.message, 'err'); loadSources(); }
};

/* ============ playlists ============ */
async function loadPlaylists() {
  const list = await api('GET', '/api/playlist/list');
  const sel = $('#matchSource');
  const sources = await api('GET', '/api/sources');
  sel.innerHTML = sources.filter((s) => s.enabled && (s.methods || []).includes('musicUrl')).map((s) => `<option value="${s.id}">${(s.info && s.info.name) || s.fileName}</option>`).join('');

  const root = $('#playlistList');
  if (!list.length) {
    root.innerHTML = `<div class="muted">还没有导入的歌单</div>`;
    return;
  }
  root.innerHTML = '';
  list.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'src-card';
    card.innerHTML = `
      <h3>${escapeHtml(p.name)}</h3>
      <div class="meta">${p.track_count || 0} 首 · 导入于 ${new Date(p.imported_at).toLocaleString()}</div>
      <div class="actions">
        <button data-act="open">打开</button>
        <button data-act="update">更新</button>
        <button data-act="del" class="danger">删除</button>
      </div>
    `;
    card.querySelector('[data-act=open]').onclick = () => openPlaylist(p.id);
    card.querySelector('[data-act=update]').onclick = () => importPlaylistWithProgress({ id: p.id }, 'update');
    card.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`删除歌单 ${p.name} ？`)) return;
      await api('DELETE', `/api/playlist/${p.id}`);
      toast('已删除', 'ok'); loadPlaylists();
    };
    root.appendChild(card);
  });
}

async function openPlaylist(id) {
  window.__currentPlaylistId = id;
  window.__currentPage = 1;
  await renderPlaylistPage();
}

async function renderPlaylistPage() {
  const id = window.__currentPlaylistId;
  if (!id) return;
  const limit = parseInt($('#plPageSize').value, 10) || 100;
  const page = window.__currentPage || 1;
  const data = await api('GET', `/api/playlist/${id}?page=${page}&limit=${limit}`);
  $('#playlistDetail').style.display = '';
  $('#plDetailTitle').textContent = `${data.playlist.name} · 共 ${data.total} 首`;
  const tbody = $('#plTrackBody');
  tbody.innerHTML = '';
  const basePos = (page - 1) * limit;
  data.tracks.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.dataset.song = JSON.stringify({
      song: t,
      name: t.name,
      artists: (t.artists || '').split(',').filter(Boolean),
      album: t.album,
    });
    tr.innerHTML = `
      <td><input type="checkbox" data-pos="${basePos + i}" checked></td>
      <td>${basePos + i + 1}</td>
      <td>${escapeHtml(t.name)}</td>
      <td>${escapeHtml(t.artists || '')}</td>
      <td>${escapeHtml(t.album || '')}</td>
      <td>${fmtDuration(t.duration)}</td>
      <td data-col="match">-</td>
    `;
    tbody.appendChild(tr);
  });
  $('#plPageInfo').textContent = `第 ${data.page} / ${data.pages} 页 · 共 ${data.total} 首`;
  $('#plPagePrev').disabled = data.page <= 1;
  $('#plPageNext').disabled = data.page >= data.pages;
  window.__currentTotal = data.total;
  window.__currentPages = data.pages;
}

$('#plPagePrev').onclick = () => {
  if (window.__currentPage > 1) {
    window.__currentPage -= 1;
    renderPlaylistPage();
  }
};
$('#plPageNext').onclick = () => {
  if (window.__currentPage < (window.__currentPages || 1)) {
    window.__currentPage += 1;
    renderPlaylistPage();
  }
};
$('#plPageFirst').onclick = () => {
  if (window.__currentPage !== 1) {
    window.__currentPage = 1;
    renderPlaylistPage();
  }
};
$('#plPageLast').onclick = () => {
  const last = window.__currentPages || 1;
  if (window.__currentPage !== last) {
    window.__currentPage = last;
    renderPlaylistPage();
  }
};
$('#plPageSize').onchange = () => {
  window.__currentPage = 1;
  renderPlaylistPage();
};
$('#plPageJumpBtn').onclick = () => {
  const v = parseInt($('#plPageGoto').value, 10);
  if (v && v >= 1 && v <= (window.__currentPages || 1)) {
    window.__currentPage = v;
    renderPlaylistPage();
  } else {
    toast(`页码范围 1 - ${window.__currentPages || 1}`, 'warn');
  }
};
$('#plCheckAll').onclick = (e) => {
  $$('#plTrackBody input[type=checkbox]').forEach((cb) => cb.checked = e.target.checked);
};

$('#btnSelectAll').onclick = () => { $$('#plTrackBody input[type=checkbox]').forEach((cb) => cb.checked = true); };
$('#btnSelectNone').onclick = () => { $$('#plTrackBody input[type=checkbox]').forEach((cb) => cb.checked = false); };

$('#btnImportPl').onclick = async () => {
  const input = $('#plInput').value.trim();
  if (!input) return toast('请填歌单链接或 ID', 'warn');
  await importPlaylistWithProgress({ url: input }, 'import');
};

async function importPlaylistWithProgress(payload, mode = 'import') {
  const dlg = $('#importDlg');
  const title = mode === 'update' ? '更新歌单中...' : '导入歌单中...';
  const doneTitle = mode === 'update' ? '更新完成' : '导入完成';
  const doneToast = (s) => mode === 'update' ? `已更新 ${s.name}（${s.total} 首）` : `已导入 ${s.name}（${s.total} 首）`;
  $('#importDlgTitle').textContent = title;
  $('#importDlgBar').style.width = '0%';
  $('#importDlgText').textContent = '准备中...';
  $('#importDlgCount').textContent = '';
  $('#importDlgClose').disabled = true;
  if (!dlg.open) dlg.showModal();

  let summary = null;
  try {
    const res = await fetch('/api/playlist/import-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleSseChunk(chunk, (event, data) => {
          if (event === 'progress') {
            const p = Math.max(0, Math.min(100, Number(data.percent) || 0));
            $('#importDlgBar').style.width = p + '%';
            $('#importDlgText').textContent = data.message || '';
            if (data.total) $('#importDlgCount').textContent = `${data.done || 0} / ${data.total}`;
          } else if (event === 'done') {
            summary = data;
            $('#importDlgBar').style.width = '100%';
            $('#importDlgTitle').textContent = doneTitle;
            $('#importDlgText').textContent = `${data.summary.name}（${data.total} 首）`;
            $('#importDlgCount').textContent = '';
          } else if (event === 'error') {
            throw new Error(data.message);
          }
        });
      }
    }
  } catch (e) {
    $('#importDlgTitle').textContent = '导入失败';
    $('#importDlgText').textContent = e.message;
    toast(`导入失败：${e.message}`, 'err');
    $('#importDlgClose').disabled = false;
    return;
  }

  if (summary) {
    toast(doneToast(summary), 'ok');
    $('#importDlgClose').disabled = false;
    $('#importDlgClose').onclick = () => {
      dlg.close();
      if (summary && summary.summary && summary.summary.id) {
        openPlaylist(String(summary.summary.id));
      }
      loadPlaylists();
    };
  }
}

function handleSseChunk(chunk, cb) {
  const lines = chunk.split('\n');
  let event = 'message';
  let data = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (data) {
    try { cb(event, JSON.parse(data)); }
    catch (e) { cb(event, { raw: data }); }
  }
}

$('#btnMatchSongs').onclick = async () => {
  const sourceId = $('#matchSource').value;
  if (!sourceId) return toast('请选择音源', 'warn');
  const targets = $$('#plTrackBody input[type=checkbox]:checked').map((cb) => JSON.parse(cb.closest('tr').dataset.song));
  if (!targets.length) return toast('请先勾选歌曲', 'warn');
  toast('正在匹配...');
  let matchedCount = 0;
  for (const t of targets) {
    const tr = Array.from($('#plTrackBody').children).find((row) => row.dataset.song === JSON.stringify(t));
    if (!tr) continue;
    const matchCell = tr.querySelector('[data-col=match]');
    try {
      const r = await api('GET', `/api/music/search?sourceId=${encodeURIComponent(sourceId)}&key=${encodeURIComponent(t.name + ' ' + (t.artists||[]).join(' '))}&limit=5`);
      const hit = (r.list || []).find((s) => isClose(s, t));
      if (hit) { matchCell.textContent = (hit.name || '') + ' / ' + (hit.singer || hit.artists || ''); matchCell.style.color = '#4ade80'; tr.dataset.matchSource = hit.source || sourceId; matchedCount++; }
      else { matchCell.textContent = '未找到'; matchCell.style.color = '#f87171'; tr.dataset.matchSource = ''; }
    } catch (err) { matchCell.textContent = '音源错误'; matchCell.style.color = '#f87171'; }
  }
  toast(`匹配完成，找到 ${matchedCount} / ${targets.length}`, matchedCount ? 'ok' : 'warn');
};

$('#btnEnqueue').onclick = async () => {
  const defaultSourceId = $('#matchSource').value;
  if (!defaultSourceId) return toast('请选择音源', 'warn');
  const targets = $$('#plTrackBody input[type=checkbox]:checked').map((cb) => JSON.parse(cb.closest('tr').dataset.song));
  if (!targets.length) return toast('请先勾选歌曲', 'warn');
  if (!confirm(`将入队 ${targets.length} 首歌曲到下载队列，确定？`)) return;

  // 收集所有启用的音源作为 fallback（不含主源）
  const allSources = await api('GET', '/api/sources');
  const fallbackAll = allSources.filter((s) => s.enabled && (s.methods || []).includes('musicUrl')).map((s) => s.id);

  // 按「命中音源」分组：匹配过的用命中源作主源，未匹配用默认源
  const rows = Array.from($('#plTrackBody tr'));
  const bySource = new Map(); // sourceId -> [songs]
  const unmatched = [];
  targets.forEach((t) => {
    const tr = rows.find((row) => row.dataset.song === JSON.stringify(t));
    let mSrc = (tr && tr.dataset.matchSource) || '';
    if (!mSrc || mSrc === defaultSourceId) { unmatched.push(t); return; }
    if (!bySource.has(mSrc)) bySource.set(mSrc, []);
    bySource.get(mSrc).push(t);
  });

  const quality = $('#quality').value;
  const playlistId = window.__currentPlaylistId || null;
  let succ = 0, skipped = 0, errCount = 0, extra = '';

  // 未命中的 → 用默认源
  if (unmatched.length) {
    const songs = unmatched.map((t) => ({
      song: t.song.name, name: t.name, songId: t.song.song_id, songmid: t.song.song_id,
      artists: t.artists, album: t.album, duration: t.song.duration,
    }));
    const r = await api('POST', '/api/download/enqueue', {
      sourceId: defaultSourceId, fallbackSourceIds: fallbackAll.filter((s) => s !== defaultSourceId),
      songs, quality, playlistId,
    });
    succ += r.enqueued.filter((x) => !x.error && !x.skipped).length;
    skipped += r.enqueued.filter((x) => x.skipped).length;
    errCount += r.enqueued.filter((x) => x.error).length;
  }
  // 命中的 → 各按命中原分组
  for (const [mSrc, list] of bySource) {
    const songs = list.map((t) => ({
      song: t.song.name, name: t.name, songId: t.song.song_id, songmid: t.song.song_id,
      artists: t.artists, album: t.album, duration: t.song.duration,
    }));
    const r = await api('POST', '/api/download/enqueue', {
      sourceId: mSrc, fallbackSourceIds: fallbackAll.filter((s) => s !== mSrc),
      songs, quality, playlistId,
    });
    succ += r.enqueued.filter((x) => !x.error && !x.skipped).length;
    skipped += r.enqueued.filter((x) => x.skipped).length;
    errCount += r.enqueued.filter((x) => x.error).length;
    extra += `（${(allSources.find((s) => s.id === mSrc) || {}).fileName || mSrc} 组）`;
  }
  try {
    toast(`已入队 ${succ} / ${targets.length}（跳过重复 ${skipped}${errCount ? `，失败 ${errCount}` : ''}）${extra}`, 'ok');
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    $('.tab[data-tab=download]').classList.add('active');
    $('.panel[data-panel=download]').classList.add('active');
    loadDownloads();
  } catch (e) { toast(e.message, 'err'); }
};

function isClose(s, t) {
  const sName = String(s.name || s.title || '').replace(/\s/g, '').toLowerCase();
  const tName = (t.name || '').replace(/\s/g, '').toLowerCase();
  if (!sName.includes(tName) && !tName.includes(sName)) return false;
  const sArtist = String(s.singer || s.artists || '').replace(/\s/g, '').toLowerCase();
  const tArtist = (t.artists || []).join(',').toLowerCase();
  return !tArtist || sArtist.includes(tArtist.split(',')[0].toLowerCase());
}

/* ============ search ============ */
let __searchResults = [];
let __searchActiveSource = 'all';      // 当前显示哪个 tab 的结果
let __searchBySource = {};             // { sourceId | 'all': [results] }
let __searchSourcesCache = [];         // 启用的音源列表
let __searchTimer = null;

async function loadSearch() {
  const sources = await api('GET', '/api/sources');
  __searchSourcesCache = sources.filter((s) => s.enabled && s.methods.includes('musicSearch'));
  renderSearchTabs();
}

function renderSearchTabs() {
  const root = $('#searchTabs');
  const tabs = [{ id: 'all', label: '全部' }, ...__searchSourcesCache.map((s) => ({
    id: s.id, label: (s.info && s.info.name) || s.fileName,
  }))];
  root.innerHTML = tabs.map((t) => `
    <div class="tab${__searchActiveSource === t.id ? ' active' : ''}" data-sid="${t.id}">
      <span class="status-dot"></span>
      <span class="label">${escapeHtml(t.label)}</span>
      <span class="count">0</span>
    </div>
  `).join('');
  $$('#searchTabs .tab').forEach((el) => {
    el.onclick = () => {
      const sid = el.dataset.sid;
      __searchActiveSource = sid;
      $$('#searchTabs .tab').forEach((e2) => e2.classList.toggle('active', e2.dataset.sid === sid));
      const data = __searchBySource[sid] || [];
      __searchResults = data;
      renderSearchResults(data);
    };
  });
}

function setTabStatus(sid, status, count) {
  const el = $(`#searchTabs .tab[data-sid="${sid}"]`);
  if (!el) return;
  el.classList.remove('loading', 'done', 'error');
  if (status) el.classList.add(status);
  if (typeof count === 'number') el.querySelector('.count').textContent = String(count);
}

function setAllTabsLoading() {
  $$('#searchTabs .tab').forEach((el) => {
    el.classList.remove('done', 'error');
    el.classList.add('loading');
    el.querySelector('.count').textContent = '…';
  });
}

function searchPickSong(r) {
  return {
    name: r.name,
    songId: r.id,
    songmid: r.id,
    artists: (r.singer || '').split(/[,、&\/]/).filter(Boolean),
    album: r.album,
    duration: r.interval || 0,
    picUrl: r.picUrl || '',
  };
}

const SEARCH_HISTORY_KEY = 'lx-search-history';
function searchHistoryAdd(term) {
  if (!term) return;
  let h = [];
  try { h = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); } catch (_) {}
  h = h.filter((x) => x !== term);
  h.unshift(term);
  h = h.slice(0, 12);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(h)); } catch (_) {}
  searchHistoryRender();
}
function searchHistoryRender() {
  let h = [];
  try { h = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); } catch (_) {}
  const dl = $('#searchHistoryList');
  if (dl) dl.innerHTML = h.map((x) => `<option value="${escapeHtml(x)}">`).join('');
}
function searchHistoryClear() {
  try { localStorage.removeItem(SEARCH_HISTORY_KEY); } catch (_) {}
  searchHistoryRender();
  toast('已清空搜索历史', 'ok');
}

async function doSearch(opts = {}) {
  const key = $('#searchKey').value.trim();
  const singer = $('#searchSinger').value.trim();
  if (!key && !singer) return toast('请输入歌名或歌手', 'warn');
  if (key) searchHistoryAdd(key + (singer ? ' ' + singer : ''));

  const tbody = $('#searchBody');
  tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:2em;">搜索中...</td></tr>`;
  $('#searchStats').textContent = '';
  __searchBySource = {};
  setAllTabsLoading();

  try {
    if (__searchActiveSource === 'all' && opts.all !== false) {
      // 跨源：每个源都查一次
      const r = await api('POST', '/api/music/find', { name: key, singer });
      const matches = r.matches || [];
      const stats = r.sources || [];
      // 写入每个源的 tab 计数
      stats.forEach((st) => {
        const sid = st.sourceId;
        if (sid) setTabStatus(sid, st.error ? 'error' : 'done', st.count);
      });
      setTabStatus('all', 'done', matches.length);
      // 按源分组
      const grouped = { all: matches };
      matches.forEach((m) => {
        if (m.source) {
          grouped[m.source] = grouped[m.source] || [];
          if (!grouped[m.source].some((x) => x.id === m.id)) grouped[m.source].push(m);
        }
      });
      __searchBySource = grouped;
      // 默认显示「全部」tab
      $$('#searchTabs .tab').forEach((e2) => e2.classList.toggle('active', e2.dataset.sid === __searchActiveSource));
      __searchResults = __searchBySource['all'] || [];
      renderSearchResults(__searchResults);
      $('#searchStats').textContent = `找到 ${matches.length} 条（跨 ${stats.length} 个源排序）`;
    } else {
      // 单源
      const sid = __searchActiveSource;
      const r = await api('GET', `/api/music/search?sourceId=${encodeURIComponent(sid)}&key=${encodeURIComponent(key)}&singer=${encodeURIComponent(singer)}&limit=30`);
      const list = r.list || [];
      __searchBySource = { [sid]: list };
      setTabStatus(sid, 'done', list.length);
      __searchResults = list;
      renderSearchResults(list);
      $('#searchStats').textContent = `找到 ${list.length} 条`;
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:2em;">搜索失败：${escapeHtml(e.message)}</td></tr>`;
    $$('#searchTabs .tab').forEach((el) => {
      el.classList.remove('loading');
      el.classList.add('error');
    });
  }
}

// 防抖：用户输入停下 300ms 才发起搜索
function scheduleSearch() {
  if (__searchTimer) clearTimeout(__searchTimer);
  __searchTimer = setTimeout(() => doSearch({ all: true }), 300);
}

function renderSearchResults(results) {
  const tbody = $('#searchBody');
  tbody.innerHTML = '';
  if (!results.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:2em;">未找到匹配歌曲。</td></tr>`;
    return;
  }
  results.forEach((m, i) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = i;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(m.name || '')}</td>
      <td>${escapeHtml(m.singer || '')}</td>
      <td>${escapeHtml(m.album || '')}</td>
      <td>${fmtDuration(m.interval)}</td>
      <td><span class="badge-builtin">${escapeHtml(m.sourceLabel || m.source || '')}</span></td>
      <td><button data-act="dl" class="primary">下载</button></td>
    `;
    tr.querySelector('[data-act=dl]').onclick = () => downloadSearchOne(i);
    tbody.appendChild(tr);
  });
}

async function enqueueSearchSongs(songs, label) {
  if (!songs.length) return toast('没有可下载的项', 'warn');
  const allSources = await api('GET', '/api/sources');
  const enabledSrc = allSources.filter((s) => s.enabled && (s.methods || []).includes('musicUrl')).map((s) => s.id);
  // 每首歌用各自的 sourceId，fallback 为其它启用的音源
  const bySource = {};
  songs.forEach(({ sourceId, song }) => {
    (bySource[sourceId] = bySource[sourceId] || []).push(song);
  });
  let succ = 0, skipped = 0, errCount = 0;
  for (const [sourceId, list] of Object.entries(bySource)) {
    const fallbacks = enabledSrc.filter((s) => s !== sourceId);
    const r = await api('POST', '/api/download/enqueue', {
      sourceId,
      fallbackSourceIds: fallbacks,
      songs: list,
      quality: $('#searchQuality').value,
      playlistId: null,
    });
    succ += r.enqueued.filter((x) => !x.error && !x.skipped).length;
    skipped += r.enqueued.filter((x) => x.skipped).length;
    errCount += r.enqueued.filter((x) => x.error).length;
  }
  toast(`${label}：入队 ${succ}${skipped ? `，跳过重复 ${skipped}` : ''}${errCount ? `，失败 ${errCount}` : ''}`, 'ok');
  // 切到下载页
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((p) => p.classList.remove('active'));
  $('.tab[data-tab=download]').classList.add('active');
  $('.panel[data-panel=download]').classList.add('active');
  loadDownloads();
}

async function downloadSearchOne(idx) {
  const m = __searchResults[idx];
  if (!m) return;
  const sourceId = m.source;
  await enqueueSearchSongs([{ sourceId, song: searchPickSong(m) }], `下载「${m.name}」`);
}

$('#btnSearch').onclick = () => doSearch({ all: true });
$('#searchKey').addEventListener('input', scheduleSearch);
$('#searchSinger').addEventListener('input', scheduleSearch);
$('#searchKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (__searchTimer) clearTimeout(__searchTimer); doSearch({ all: true }); } });
$('#searchSinger').addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (__searchTimer) clearTimeout(__searchTimer); doSearch({ all: true }); } });
$('#btnSearchHistory').onclick = () => { if (!confirm('清空搜索历史？')) return; searchHistoryClear(); };
searchHistoryRender();
$('#btnSearchDlAll').onclick = async () => {
  if (!__searchResults.length) return toast('先搜索', 'warn');
  await enqueueSearchSongs(__searchResults.map((m) => ({ sourceId: m.source, song: searchPickSong(m) })), '批量下载');
};

/* ============ downloads ============ */
let es = null;
function buildStatusCell(t) {
  const pill = `<span class="status-pill status-${t.status}">${statusLabel(t.status)}</span>`;
  let extra = '';
  if (t.status === 'running') {
    extra = `<div class="progress" style="margin-top:.3em;"><span style="width:${t.progress || 0}%"></span></div>`;
    if (t.progress) extra += `<span class="muted" style="font-size:.8em;">${t.progress}%</span>`;
  } else if (t.status === 'skipped') {
    extra = `<div class="muted">${escapeHtml((t.error || '已跳过').slice(0, 90))}</div>`;
  } else if (t.status === 'success') {
    extra = '';
  } else if (t.status === 'failed' && t.error) {
    extra = `<div class="muted err-detail" title="${escapeHtml(t.error)}">${escapeHtml(t.error.slice(0, 90))}${t.error.length > 90 ? '...' : ''}</div>`;
  } else if (t.status === 'pending' && t.source_label) {
    extra = `<div class="muted" style="font-size:.8em;">排队中 · ${escapeHtml((t.source_label || '').slice(0, 30))}</div>`;
  } else if (t.status === 'fallback' && t.source_label) {
    extra = `<div class="muted" style="font-size:.8em;">→ ${escapeHtml(t.source_label.slice(0, 30))}</div>`;
  }
  return `<div>${pill}</div>${extra}`;
}

// 单任务行构建器（被 loadDownloads + SSE 新任务插入 共用）
// _liveSources 缓存可用音源列表（避免每次 buildTaskRow 都请求）
let _liveSourcesCache = null;
let _liveSourcesCacheTime = 0;
async function getLiveSources() {
  if (_liveSourcesCache && Date.now() - _liveSourcesCacheTime < 30000) return _liveSourcesCache;
  try {
    const r = await api('GET', '/api/sources?all=1');
    const list = (r.data || []).filter((s) => s.enabled && (s.methods || []).includes('musicUrl'));
    _liveSourcesCache = list;
    _liveSourcesCacheTime = Date.now();
    return list;
  } catch (e) {
    return _liveSourcesCache || [];
  }
}

function buildTaskRow(t) {
  const tr = document.createElement('tr');
  tr.dataset.id = t.id;
  // 失败 / 跳过 / fallback 中 才显示音源下拉（成功的固定即可）
  const showSourcePicker = ['failed', 'skipped'].includes(t.status) || (t.source_id && !t.source_label);
  const sourcePickerHtml = showSourcePicker
    ? `<select data-act="src" style="font-size:.8em;padding:1px 4px;margin-left:.3em;border-radius:4px;border:1px solid var(--border);background:var(--card2);color:var(--text)" data-cur="${escapeHtml(t.source_id || '')}">
         <option value="">${escapeHtml(t.source_label || '请选源')}</option>
       </select>`
    : '';
  tr.innerHTML = `
    <td>${t.id}</td>
    <td>${escapeHtml(t.song_name)}</td>
    <td>${escapeHtml(t.artists || '')}</td>
    <td>${buildStatusCell(t)}</td>
    <td>${fmtSize(t.size)}</td>
    <td>
      ${sourcePickerHtml}
      <button data-act="retry" class="secondary">重试</button>
      <button data-act="del" class="danger">删除</button>
    </td>
  `;
  // 异步填充下拉
  if (showSourcePicker) {
    getLiveSources().then((sources) => {
      const sel = tr.querySelector('[data-act=src]');
      if (!sel) return;
      sources.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = (s.info && s.info.name) || s.fileName;
        sel.appendChild(opt);
      });
      // 默认值（如果原 source_id 还可用，保留）
      if (t.source_id && sources.some((s) => s.id === t.source_id)) sel.value = t.source_id;
    });
  }
  tr.querySelector('[data-act=retry]').onclick = async (ev) => {
    ev.target.disabled = true;
    try {
      const sel = tr.querySelector('[data-act=src]');
      const sourceId = sel && sel.value ? sel.value : null;
      const body = sourceId ? { sourceId } : {};
      await api('POST', `/api/download/retry/${t.id}`, body);
      const what = sourceId ? `已重新入队 task#${t.id}（用 ${sourceId.slice(0,8)}…）` : `已重新入队 task#${t.id}`;
      toast(what, 'ok');
      tr.children[3].innerHTML = `<div><span class="status-pill status-pending">待处理</span></div><div class="muted" style="font-size:.8em;">排队中</div>`;
      const s = await api('GET', '/api/download/stats');
      updateDlStats(s);
    } catch (e) {
      toast('重试失败: ' + e.message, 'err');
    } finally {
      ev.target.disabled = false;
    }
  };
  tr.querySelector('[data-act=del]').onclick = async () => {
    if (!confirm(`删除 task#${t.id}「${t.song_name}」？`)) return;
    try {
      await api('DELETE', `/api/download/${t.id}`);
      tr.remove();
      const s = await api('GET', '/api/download/stats');
      updateDlStats(s);
    } catch (e) {
      toast('删除失败: ' + e.message, 'err');
    }
  };
  return tr;
}

function updateDlStats(stats) {
  $('#dlStats').textContent = `(${stats.pending} 待 · ${stats.running} 进行 · ${stats.success} 完成 · ${stats.failed} 失败 · 总 ${stats.total} · 本次 ${stats.session ? stats.session.downloaded : '?'} 首 / ${fmtSize(stats.session ? stats.session.bytes : 0)})`;
}

async function loadDownloads() {
  try {
    const stats = await api('GET', '/api/download/stats');
    updateDlStats(stats);
    const data = await api('GET', '/api/download/list?limit=200');
    const tbody = $('#dlBody');
    if (!data.list || data.list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:2em;">暂无下载任务。<br>去「歌单导入」→ 勾选歌曲 → 「批量下载」开始。</td></tr>';
      return;
    }
    const frag = document.createDocumentFragment();
    data.list.forEach((t) => frag.appendChild(buildTaskRow(t)));
    tbody.replaceChildren(frag);
  } catch (err) {
    console.error('loadDownloads failed:', err);
    $('#dlStats').textContent = `加载失败: ${err.message}`;
  }
  bindProgressStream();
}

function bindProgressStream() {
  if (es) es.close();
  try {
    es = new EventSource('/api/download/stream');
    // 每次 SSE 事件：拉一次完整任务状态（从后端取权威数据），重建这一行
    // 这样所有列（id/歌名/状态/进度/大小/来源/错误）都同步，不会漏字段
    es.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      if (!data || !data.id) return;
      // pruned → 行已被删，直接从 DOM 移除
      if (data.status === 'pruned') {
        const tr = $(`#dlBody tr[data-id="${data.id}"]`);
        if (tr) tr.remove();
        return;
      }
      // 拉完整状态
      api('GET', `/api/download/task/${data.id}`).then((r) => {
        if (!r || r.code !== 0) return;
        const t = r.data;
        if (!t) return;
        const tbody = $('#dlBody');
        let tr = $(`#dlBody tr[data-id="${t.id}"]`);
        if (tr) {
          // 已存在 → 整行替换
          const newTr = buildTaskRow(t);
          tr.replaceWith(newTr);
          tr = newTr;
        } else {
          // 不存在 → 插到顶部（按 id DESC，新任务在前）
          tbody.insertBefore(buildTaskRow(t), tbody.firstChild);
        }
      }).catch(() => {});
    });
    es.addEventListener('stats', async (e) => {
      const stats = JSON.parse(e.data);
      updateDlStats(stats);
    });
    es.onerror = (e) => {
      // EventSource 自动重连，5s 后重试；不刷整页避免状态丢失
      console.warn('SSE stream disconnected, will auto-reconnect');
    };
  } catch (err) { /* noop */ }
}

function statusLabel(s) {
  return ({ pending: '待处理', running: '下载中', success: '完成', failed: '失败' })[s] || s;
}

$('#btnRetryAll').onclick = async () => {
  try {
    const r = await api('POST', '/api/download/retry-all');
    // 把跳过的原因串起来，让用户知道为啥没有重试
    const reasons = r.skippedReasons ? Object.entries(r.skippedReasons).map(([k, n]) => `${k} ×${n}`).join('，') : '';
    const parts = [];
    if (r.retried) parts.push(`重试 ${r.retried}`);
    if (r.skipped) parts.push(`跳过 ${r.skipped}`);
    if (r.errors) parts.push(`错误 ${r.errors}`);
    const msg = parts.length ? parts.join('，') : '没有可重试的任务';
    const detail = reasons ? `（${reasons}）` : '';
    toast(msg + detail, r.retried ? 'ok' : 'warn');
    loadDownloads();
    const s = await api('GET', '/api/download/stats');
    $('#dlStats').textContent = `(${s.pending} 待 · ${s.running} 进行 · ${s.success} 完成 · ${s.failed} 失败 · 跳过 ${s.skipped} · 总 ${s.total})`;
  } catch (e) {
    toast('重试失败: ' + e.message, 'err');
  }
};
$('#btnRefreshDl').onclick = () => loadDownloads();

/* ============ files ============ */
let fileState = { page: 1, pageSize: 50, search: '' };

async function loadFiles() {
  const q = new URLSearchParams({ page: fileState.page, pageSize: fileState.pageSize });
  if (fileState.search) q.set('search', fileState.search);
  const data = await api('GET', `/api/files/query?${q.toString()}`);
  $('#fileInfo').textContent = `(共 ${data.total} 个文件)`;
  const tbody = $('#fileBody');
  if (!data.items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:2em;">没有文件</td></tr>`;
  } else {
    tbody.innerHTML = data.items.map((f) => `
      <tr>
        <td>${escapeHtml(f.name)}</td>
        <td class="muted">${escapeHtml(f.relpath)}</td>
        <td>${fmtSize(f.size)}</td>
        <td class="muted">${fmtTime(f.mtime)}</td>
        <td><button class="danger" data-del="${encodeURIComponent(f.relpath)}" data-name="${escapeHtml(f.name)}">删除</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('button[data-del]').forEach((b) => {
      b.onclick = () => deleteFile(decodeURIComponent(b.dataset.del), b.dataset.name);
    });
  }
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  if (data.page > totalPages) {
    fileState.page = totalPages;
    return loadFiles();
  }
  $('#filePageInfo').textContent = `第 ${data.page}/${totalPages} 页 · 共 ${data.total} 条`;
  $('#filePager').style.display = data.total > data.pageSize ? 'flex' : 'none';
  $('#filePrev').disabled = data.page <= 1;
  $('#fileNext').disabled = data.page >= totalPages;
}

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function deleteFile(rel, name) {
  try {
    await api('DELETE', `/api/files?path=${encodeURIComponent(rel)}`);
    toast(`已删除: ${name}`);
    loadFiles();
  } catch (e) {
    toast('删除失败: ' + e.message, 'err');
  }
}

$('#btnRefreshFiles').onclick = () => loadFiles();
$('#btnFileSearch').onclick = () => {
  fileState.page = 1;
  fileState.search = $('#fileSearch').value.trim();
  loadFiles();
};
$('#fileSearch').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('#btnFileSearch').click(); });
$('#filePrev').onclick = () => { fileState.page--; loadFiles(); };
$('#fileNext').onclick = () => { fileState.page++; loadFiles(); };
$('#filePageSize').onchange = () => {
  fileState.page = 1;
  fileState.pageSize = parseInt($('#filePageSize').value, 10) || 50;
  loadFiles();
};

/* ============ settings ============ */
async function loadSettings() {
  try {
    const info = await api('GET', '/api/info');
    const settings = {
      后端版本: info.version,
      Node版本: info.node || 'n/a',
      运行平台: `${info.platform}/${info.arch}`,
      进程PID: info.pid,
      运行时长: formatUptime(info.uptime || 0),
      数据目录: info.dataDir,
      音乐保存目录: info.musicDir,
      音源目录: info.sourcesDir,
      已加载音源: `${info.sources} 个`,
      网易云MUSIC_U: info.neteaseConfigured
        ? `已配置 ${info.neteaseCookieCount || 1} 个`
        : '未配置（VIP/付费歌曲无法下载）',
    };
    $('#sysInfo').textContent = Object.entries(settings).map(([k, v]) => `${k.padEnd(8)}: ${v}`).join('\n');
  } catch (e) { $('#sysInfo').textContent = e.message; }

  await loadLogs(true);
}

let logAutoTimer = null;
let lastLogTs = 0;
async function loadLogs(initial = false) {
  const level = $('#logLevel').value;
  const limit = parseInt($('#logLimit').value, 10) || 1000;
  try {
    const r = await api('GET', `/api/logs?limit=${limit}${level ? `&level=${level}` : ''}`);
    const box = $('#logBox');
    const lines = r.lines || [];
    const html = lines.map((l) => {
      // 显示北京时间（容器 TZ=Asia/Shanghai）
      const d = new Date(l.ts);
      const pad = (n, w = 2) => String(n).padStart(w, '0');
      const ts = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      return `<span class="lv-${l.level}"><span class="ts">${ts}</span>${escapeHtml(l.text)}</span>`;
    }).join('\n');
    box.innerHTML = html;
    if (initial || logAutoTimer !== null) {
      box.scrollTop = box.scrollHeight;
    }
    $('#logInfo').textContent = `${r.total} 条 in-memory / 显示 ${lines.length} / 文件 ${r.logFile ? r.logFile.split('/').pop() : '-'}`;
    if (lines.length) lastLogTs = lines[lines.length - 1].ts;
  } catch (e) {
    $('#logBox').textContent = `加载日志失败: ${e.message}`;
  }
}

$('#logRefresh').onclick = () => loadLogs(true);
$('#logLevel').onchange = () => loadLogs(true);
$('#logLimit').onchange = () => loadLogs(true);
$('#logDownload').onclick = () => {
  window.location.href = '/api/logs/download?limit=1000';
};
$('#logClear').onclick = async () => {
  if (!confirm('清空 Web UI 显示的日志？\n注：磁盘文件不会删除（容器重启后仍能看到历史）。')) return;
  $('#logBox').innerHTML = '';
};
$('#logAuto').onclick = () => {
  if (logAutoTimer) {
    clearInterval(logAutoTimer);
    logAutoTimer = null;
    $('#logAuto').textContent = '▶ 自动刷新';
  } else {
    logAutoTimer = setInterval(() => loadLogs(true), 3000);
    $('#logAuto').textContent = '⏸ 暂停自动';
  }
};

function formatUptime(sec) {
  if (!sec || sec < 0) return '-';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

/* ============ boot ============ */
window.addEventListener('DOMContentLoaded', () => {
  loadSources();
});
