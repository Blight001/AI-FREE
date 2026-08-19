'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_EXPORT_TIMEOUT_SECONDS,
  MAX_EXPORT_TIMEOUT_SECONDS,
} = require('./opencut-constants');
const { EditorError } = require('./opencut-ids');
const { available, extractFrame, exportTimeline } = require('./opencut-ffmpeg');

function wrap(result, summary) {
  return { success: true, ...result, summary };
}

function status(ctx) {
  const snap = ctx.editor.snapshot();
  const info = {
    ffmpeg: available(),
    opencut: ctx.host.status(),
    active_project: snap.active?.name || '',
    active_project_id: snap.active_project_id,
    project_count: snap.project_count,
    data_dir: snap.data_dir,
  };
  return wrap(info, `OpenCut 界面${info.opencut.running ? '运行中' : '未运行'}，当前工程 ${info.active_project || '无'}`);
}

function projectCreate(ctx, args) {
  const name = String(args.name || '').trim();
  if (!name) throw new EditorError('请提供工程名 name');
  const project = ctx.editor.createProject(name, args);
  return wrap(project, `已创建并打开工程 ${project.name}`);
}

function projectOpen(ctx, args) {
  const projectId = String(args.project_id || '').trim();
  if (!projectId) throw new EditorError('请提供 project_id');
  const project = ctx.editor.openProject(projectId);
  return wrap(project, `已打开工程 ${project.name}`);
}

function mediaImport(ctx, args) {
  const mediaPath = String(args.path || '').trim();
  if (!mediaPath) throw new EditorError('请提供本机素材路径 path');
  const asset = ctx.editor.importMedia(mediaPath, {
    project_id: args.project_id, workspaceDir: ctx.workspaceDir,
  });
  return wrap(asset, `已导入 ${asset.kind} 素材 ${asset.name}（${asset.duration_ms}ms）`);
}

function preview(ctx, args) {
  const atMs = Number(args.at_ms || 0);
  const hit = ctx.editor.resolveClipAt(atMs, args.project_id);
  const dest = path.join(ctx.editor.projectDir(hit.project.id), 'preview.jpg');
  extractFrame(hit.media.path, hit.source_ms, dest);
  const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(dest).toString('base64')}`;
  return wrap({
    at_ms: atMs, clip_id: hit.clip.id, media: hit.media.name, path: dest, dataUrl, send_to_user: true,
  }, `已生成 ${atMs}ms 处预览帧`);
}

function resolveExportPath(ctx, project, destName) {
  if (path.isAbsolute(destName)) return destName;
  const fileName = path.basename(destName);
  if (ctx.workspaceDir) {
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    return path.join(ctx.workspaceDir, fileName);
  }
  return path.join(ctx.editor.projectDir(project.id), fileName);
}

function exportProject(ctx, args) {
  const project = ctx.editor.getProject(args.project_id);
  const destName = String(args.output || `${project.name}.mp4`);
  const dest = resolveExportPath(ctx, project, destName);
  const timeout = Math.min(
    MAX_EXPORT_TIMEOUT_SECONDS, Number(args.timeout_seconds || DEFAULT_EXPORT_TIMEOUT_SECONDS),
  );
  const filePath = exportTimeline(project, dest, timeout);
  const bytes = fs.statSync(filePath).size;
  return wrap({ path: filePath, bytes, project_id: project.id }, `已导出 ${path.basename(filePath)}（${bytes} 字节）`);
}

async function appControl(ctx, args) {
  const action = String(args.action || 'status').trim().toLowerCase();
  if (action === 'start') {
    const info = await ctx.host.start();
    return wrap(info, info.summary || `已启动 OpenCut ${info.url || ''}`.trim());
  }
  if (action === 'stop') return wrap(ctx.host.stop(), '已停止 OpenCut 界面进程');
  const info = ctx.host.status();
  return wrap(info, `OpenCut 界面${info.running ? '运行中' : '未运行'}`);
}

function bind(ctx, fn) {
  return (args) => fn(ctx, args);
}

function createOpenCutHandlers(options = {}) {
  const ctx = {
    editor: options.editor,
    host: options.host,
    workspaceDir: options.workspaceDir || '',
  };
  return {
    status: () => status(ctx),
    projectList: () => {
      const projects = ctx.editor.listProjects();
      return wrap({ projects }, `共 ${projects.length} 个工程`);
    },
    projectCreate: bind(ctx, projectCreate),
    projectOpen: bind(ctx, projectOpen),
    mediaImport: bind(ctx, mediaImport),
    timelineGet: (args) => {
      const timeline = ctx.editor.timeline(args.project_id);
      return wrap(timeline, `工程 ${timeline.name} 时长 ${timeline.duration_ms}ms，${timeline.media_count} 个素材`);
    },
    timelineEdit: (args) => {
      const result = ctx.editor.edit(args);
      return wrap({ clip: result.clip, duration_ms: result.duration_ms, tracks: result.tracks }, result.summary);
    },
    preview: bind(ctx, preview),
    exportProject: bind(ctx, exportProject),
    appControl: bind(ctx, appControl),
  };
}

module.exports = { createOpenCutHandlers, wrap };
