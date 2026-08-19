'use strict';

const {
  DEFAULT_EXPORT_TIMEOUT_SECONDS,
  DEFAULT_OPENCUT_PORT,
  MAX_EXPORT_TIMEOUT_SECONDS,
} = require('./opencut-constants');

function objSchema(properties, required) {
  const schema = { type: 'object', additionalProperties: false, properties };
  if (required) schema.required = required;
  return schema;
}

function createProjectTools(handlers) {
  return [
    {
      name: 'opencut.status',
      description: '查看 OpenCut 连接状态、本机 ffmpeg、当前工程和界面进程。',
      input_schema: objSchema({}),
      handler: handlers.status,
    },
    {
      name: 'opencut.project.list',
      description: '列出本机已保存的 OpenCut 工程。',
      input_schema: objSchema({}),
      handler: handlers.projectList,
    },
    {
      name: 'opencut.project.create',
      description: '新建并打开一个 OpenCut 工程。',
      input_schema: objSchema({
        name: { type: 'string', description: '工程名' },
        width: { type: 'integer', description: '画布宽，默认 1920' },
        height: { type: 'integer', description: '画布高，默认 1080' },
        fps: { type: 'integer', description: '帧率，默认 30' },
      }, ['name']),
      handler: handlers.projectCreate,
      destructive: true,
    },
    {
      name: 'opencut.project.open',
      description: '打开已有工程，后续导入/剪辑/导出都作用在这个工程上。',
      input_schema: objSchema({
        project_id: { type: 'string', description: 'opencut.project.list 返回的 id' },
      }, ['project_id']),
      handler: handlers.projectOpen,
    },
    {
      name: 'opencut.media.import',
      description: '把本机视频/音频/图片复制进当前工程素材库。path 可以是绝对路径或 AI-Workspace 相对路径；HeySure 远程也可传 file_ref。',
      input_schema: objSchema({
        path: { type: 'string', description: '本机绝对路径或 AI-Workspace 相对路径；与 file_ref 二选一' },
        project_id: { type: 'string', description: '可选，默认当前打开的工程' },
      }),
      handler: handlers.mediaImport,
      destructive: true,
    },
  ];
}

function createTimelineTools(handlers) {
  return [
    {
      name: 'opencut.timeline.get',
      description: '读取当前工程的轨道、片段和素材清单。',
      input_schema: objSchema({ project_id: { type: 'string', description: '可选，默认当前工程' } }),
      handler: handlers.timelineGet,
    },
    {
      name: 'opencut.timeline.edit',
      description: '编辑时间线：add 添加片段；trim 裁剪；move 移动；split 切开；delete 删除。同一轨道片段不能重叠。',
      input_schema: objSchema({
        action: { type: 'string', description: 'add / trim / move / split / delete' },
        project_id: { type: 'string' },
        media_id: { type: 'string', description: 'add 时必填' },
        track_id: { type: 'string', description: 'add/move 可选' },
        clip_id: { type: 'string', description: 'trim/move/split/delete 必填' },
        start_ms: { type: 'integer', description: '时间线起点，毫秒；add 省略则接到轨道末尾' },
        duration_ms: { type: 'integer' },
        in_ms: { type: 'integer', description: '素材入点，毫秒' },
        at_ms: { type: 'integer', description: 'split 的切开时间，必须落在片段内部' },
      }, ['action']),
      handler: handlers.timelineEdit,
      destructive: true,
    },
    {
      name: 'opencut.preview',
      description: '抽取时间线上某一时刻的预览帧，作为图片返回给用户。需要本机 ffmpeg。',
      input_schema: objSchema({
        at_ms: { type: 'integer', description: '时间线位置，毫秒，默认 0' },
        project_id: { type: 'string' },
      }),
      handler: handlers.preview,
    },
    {
      name: 'opencut.export',
      description: '用 ffmpeg 把当前工程第一条视频轨道导出为 MP4。可能超过 120 秒，请传 timeout_seconds。',
      input_schema: objSchema({
        output: { type: 'string', description: '输出文件名或绝对路径，默认 <工程名>.mp4' },
        project_id: { type: 'string' },
        timeout_seconds: {
          type: 'integer',
          description: `最长等待秒数，默认 ${DEFAULT_EXPORT_TIMEOUT_SECONDS}，上限 ${MAX_EXPORT_TIMEOUT_SECONDS}`,
        },
      }),
      handler: handlers.exportProject,
      destructive: true,
    },
    {
      name: 'opencut.app.control',
      description: `启动、停止或查看 OpenCut Web 界面（默认 http://127.0.0.1:${DEFAULT_OPENCUT_PORT}）。软件启动后会自动拉起该端口。`,
      input_schema: objSchema({
        action: { type: 'string', description: 'start / stop / status，默认 status' },
      }),
      handler: handlers.appControl,
      destructive: true,
    },
  ];
}

function createOpenCutToolCatalog(handlers) {
  return [...createProjectTools(handlers), ...createTimelineTools(handlers)];
}

module.exports = { createOpenCutToolCatalog, objSchema };
