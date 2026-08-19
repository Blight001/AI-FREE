'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_PROJECT_FPS,
  DEFAULT_PROJECT_HEIGHT,
  DEFAULT_PROJECT_WIDTH,
} = require('./opencut-constants');
const { EditorError, atomicWriteJson, newId, nowMs, readJsonFile, safeName } = require('./opencut-ids');
const { resolveWorkspaceMediaPath } = require('./opencut-paths');
const { editTimeline, timelineDuration } = require('./opencut-timeline');
const { probeFile } = require('./opencut-ffmpeg');

function clampDims(width, height, fps) {
  return {
    width: Math.max(16, Math.min(7680, Number(width || DEFAULT_PROJECT_WIDTH))),
    height: Math.max(16, Math.min(4320, Number(height || DEFAULT_PROJECT_HEIGHT))),
    fps: Math.max(1, Math.min(120, Number(fps || DEFAULT_PROJECT_FPS))),
  };
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    width: project.width,
    height: project.height,
    fps: project.fps,
    media_count: (project.media || []).length,
    track_count: (project.tracks || []).length,
    duration_ms: timelineDuration(project),
    updated_at: project.updated_at,
  };
}

function readActiveId(root) {
  const saved = path.join(root, 'active.json');
  if (!fs.existsSync(saved)) return '';
  try { return String(readJsonFile(saved).project_id || ''); } catch (_) { return ''; }
}

function createStoreContext(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    probe: options.probeFile || probeFile,
    activeId: readActiveId(root),
  };
}

function projectDir(ctx, projectId) {
  return path.join(ctx.root, projectId);
}

function loadProject(ctx, projectId) {
  const filePath = path.join(projectDir(ctx, projectId), 'project.json');
  if (!projectId || !fs.existsSync(filePath)) return null;
  return readJsonFile(filePath);
}

function saveProject(ctx, project) {
  project.updated_at = nowMs();
  atomicWriteJson(path.join(projectDir(ctx, project.id), 'project.json'), project);
}

function setActive(ctx, projectId) {
  ctx.activeId = projectId;
  atomicWriteJson(path.join(ctx.root, 'active.json'), { project_id: projectId });
}

function requireProject(ctx, projectId) {
  const id = String(projectId || ctx.activeId || '').trim();
  if (!id) throw new EditorError('还没有打开的工程，请先 opencut.project.create 或 open');
  const project = loadProject(ctx, id);
  if (!project) throw new EditorError(`工程不存在: ${id}`);
  return project;
}

function listProjects(ctx) {
  if (!fs.existsSync(ctx.root)) return [];
  return fs.readdirSync(ctx.root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try { return publicProject(readJsonFile(path.join(projectDir(ctx, entry.name), 'project.json'))); } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function createProject(ctx, name, dims = {}) {
  const size = clampDims(dims.width, dims.height, dims.fps);
  const projectId = newId('proj');
  const now = nowMs();
  const project = {
    id: projectId,
    name: safeName(name),
    ...size,
    created_at: now,
    updated_at: now,
    media: [],
    tracks: [
      { id: newId('trk'), kind: 'video', name: 'V1', clips: [] },
      { id: newId('trk'), kind: 'audio', name: 'A1', clips: [] },
    ],
  };
  saveProject(ctx, project);
  setActive(ctx, projectId);
  return publicProject(project);
}

function importMedia(ctx, source, extra = {}) {
  const src = resolveWorkspaceMediaPath(source, extra.workspaceDir);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new EditorError(`找不到素材文件: ${path.basename(src)}`);
  }
  const project = requireProject(ctx, extra.project_id);
  const destDir = path.join(projectDir(ctx, project.id), 'media');
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(src));
  if (fs.existsSync(dest)) {
    dest = path.join(destDir, `${path.parse(src).name}_${newId('dup').slice(-6)}${path.extname(src)}`);
  }
  fs.copyFileSync(src, dest);
  const probeResult = ctx.probe(dest);
  const asset = {
    id: newId('media'), name: path.basename(dest), kind: probeResult.kind, path: dest,
    duration_ms: probeResult.duration_ms, width: probeResult.width, height: probeResult.height, fps: probeResult.fps,
  };
  project.media.push(asset);
  saveProject(ctx, project);
  return asset;
}

function resolveClipAt(ctx, atMs, projectId) {
  const project = requireProject(ctx, projectId);
  for (const track of project.tracks || []) {
    if (track.kind !== 'video') continue;
    for (const clip of track.clips || []) {
      const start = Number(clip.start_ms);
      const end = start + Number(clip.duration_ms);
      if (start <= atMs && atMs < end) {
        const media = (project.media || []).find((item) => item.id === clip.media_id);
        if (!media) throw new EditorError(`素材不存在: ${clip.media_id}`);
        return { project, clip, media, source_ms: Number(clip.in_ms) + (atMs - start) };
      }
    }
  }
  throw new EditorError(`时间 ${atMs}ms 处没有视频片段`);
}

function createEditorStore(rootDir, options = {}) {
  const ctx = createStoreContext(rootDir, options);
  return {
    root: ctx.root,
    snapshot: () => {
      const active = ctx.activeId ? loadProject(ctx, ctx.activeId) : null;
      return {
        data_dir: ctx.root,
        active_project_id: ctx.activeId || '',
        project_count: listProjects(ctx).length,
        active: active ? publicProject(active) : null,
      };
    },
    listProjects: () => listProjects(ctx),
    createProject: (name, dims) => createProject(ctx, name, dims),
    openProject: (projectId) => {
      const project = requireProject(ctx, projectId);
      setActive(ctx, project.id);
      return publicProject(project);
    },
    importMedia: (source, extra) => importMedia(ctx, source, extra),
    timeline: (projectId) => {
      const project = requireProject(ctx, projectId);
      return { ...publicProject(project), duration_ms: timelineDuration(project), tracks: project.tracks, media: project.media };
    },
    edit: (args = {}) => {
      const project = requireProject(ctx, args.project_id);
      const result = editTimeline(project, args);
      saveProject(ctx, project);
      return { ...result, duration_ms: timelineDuration(project), tracks: project.tracks };
    },
    resolveClipAt: (atMs, projectId) => resolveClipAt(ctx, atMs, projectId),
    getProject: (projectId) => requireProject(ctx, projectId),
    projectDir: (projectId) => projectDir(ctx, projectId),
  };
}

module.exports = {
  EditorError,
  createEditorStore,
  publicProject,
};
