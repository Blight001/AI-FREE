'use strict';

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败: ${response.status}`);
  }
  return payload;
}

function text(value, fallback = '') {
  return String(value || fallback);
}

function renderProjects(projects, activeId) {
  const root = document.getElementById('project-list');
  root.innerHTML = projects.map((item) => (
    `<li data-id="${item.id}" class="${item.id === activeId ? 'active' : ''}">`
    + `<strong>${text(item.name)}</strong><br><small>${item.duration_ms || 0}ms · ${item.media_count || 0} 素材</small></li>`
  )).join('') || '<li>还没有工程</li>';
  root.querySelectorAll('li[data-id]').forEach((item) => {
    item.addEventListener('click', () => openProject(item.getAttribute('data-id')));
  });
}

function renderMedia(media) {
  const root = document.getElementById('media-list');
  root.innerHTML = (media || []).map((item) => (
    `<li><strong>${text(item.name)}</strong><br><small>${text(item.kind)} · ${item.duration_ms || 0}ms</small></li>`
  )).join('') || '<li>还没有素材</li>';
}

function renderTimeline(timeline) {
  const root = document.getElementById('timeline');
  if (!timeline || !timeline.tracks) {
    root.className = 'timeline empty';
    root.textContent = '还没有打开的工程';
    return;
  }
  root.className = 'timeline';
  root.innerHTML = timeline.tracks.map((track) => (
    `<div class="track"><div class="track-name">${text(track.name)} · ${text(track.kind)}</div>`
    + `<div class="clips">${(track.clips || []).map((clip) => (
      `<div class="clip">${text(clip.id)}<br><small>${clip.start_ms}–${clip.start_ms + clip.duration_ms}ms</small></div>`
    )).join('') || '<span class="empty">空轨道</span>'}</div></div>`
  )).join('');
}

async function openProject(projectId) {
  await request('/api/projects/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId }),
  });
  await refresh();
}

async function refresh() {
  const [status, projects, tools] = await Promise.all([
    request('/api/status'),
    request('/api/projects'),
    request('/api/tools'),
  ]);
  document.getElementById('status-url').textContent = status.url || '端口未启动';
  document.getElementById('ffmpeg-status').textContent = status.ffmpeg?.ready
    ? 'ffmpeg 可用' : '未检测到 ffmpeg，预览/导出不可用';
  document.getElementById('project-status').textContent = status.active?.name
    ? `当前工程 ${status.active.name}` : '未打开工程';
  renderProjects(projects.projects || [], status.active_project_id);
  document.getElementById('tool-names').innerHTML = (tools.tools || [])
    .map((tool) => `<span>${tool.name}</span>`).join('');
  if (!status.active_project_id) {
    renderTimeline(null);
    renderMedia([]);
    return;
  }
  const timeline = await request(`/api/timeline?project_id=${encodeURIComponent(status.active_project_id)}`);
  renderTimeline(timeline);
  renderMedia(timeline.media);
}

document.getElementById('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('project-name').value.trim();
  if (!name) return;
  await request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  document.getElementById('project-name').value = '';
  await refresh();
});

document.getElementById('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const mediaPath = document.getElementById('media-path').value.trim();
  if (!mediaPath) return;
  await request('/api/media/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: mediaPath }),
  });
  document.getElementById('media-path').value = '';
  await refresh();
});

refresh().catch((error) => {
  document.getElementById('status-url').textContent = error.message || '无法连接 OpenCut 端口';
});
setInterval(() => { refresh().catch(() => {}); }, 4000);
