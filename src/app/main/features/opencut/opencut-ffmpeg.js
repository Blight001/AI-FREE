'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DEFAULT_IMAGE_DURATION_MS } = require('./opencut-constants');
const { AUDIO_EXT, IMAGE_EXT } = require('./opencut-constants');
const { FfmpegError } = require('./opencut-ids');

function which(name) {
  const ext = process.platform === 'win32' && !path.extname(name) ? '.exe' : '';
  const wanted = `${name}${ext}`;
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, wanted);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function ffmpegBin() {
  return which('ffmpeg');
}

function ffprobeBin() {
  return which('ffprobe');
}

function available() {
  const ffmpeg = ffmpegBin();
  const ffprobe = ffprobeBin();
  return { ffmpeg, ffprobe, ready: Boolean(ffmpeg && ffprobe) };
}

function kindFromSuffix(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'video';
}

function asInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function parseFps(value) {
  const text = String(value || '');
  if (text.includes('/')) {
    const [num, den] = text.split('/');
    const denom = Number(den);
    return denom ? Math.round((Number(num) / denom) * 1000) / 1000 : null;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function tail(text, limit = 400) {
  const raw = String(text || '').trim();
  return raw.slice(-limit);
}

function emptyProbe(kindGuess) {
  return {
    kind: kindGuess,
    duration_ms: kindGuess === 'image' ? DEFAULT_IMAGE_DURATION_MS : 0,
    width: null,
    height: null,
    fps: null,
  };
}

function applyVideoStream(result, stream, kind, duration) {
  if (result.width != null) return kind;
  result.width = asInt(stream.width);
  result.height = asInt(stream.height);
  result.fps = parseFps(stream.avg_frame_rate || stream.r_frame_rate);
  if (kind === 'audio') return kind;
  const singleFrame = stream.nb_frames === '1' || stream.nb_frames === 1;
  return singleFrame && duration <= 0.2 ? 'image' : 'video';
}

function applyAudioStream(kind, duration, stream) {
  if (kind === 'video' && duration <= 0) {
    return { kind, duration: Number(stream.duration || 0) || duration };
  }
  if (kind !== 'video' && kind !== 'image') return { kind: 'audio', duration };
  return { kind, duration };
}

function applyStreams(result, streams, kindGuess, formatDuration) {
  let kind = kindGuess;
  let duration = formatDuration;
  for (const stream of streams) {
    if (stream.codec_type === 'video') kind = applyVideoStream(result, stream, kind, duration);
    if (stream.codec_type === 'audio') {
      const next = applyAudioStream(kind, duration, stream);
      kind = next.kind;
      duration = next.duration;
    }
  }
  result.kind = kind;
  if (duration > 0) result.duration_ms = Math.max(1, Math.trunc(duration * 1000));
  else if (kind === 'image') result.duration_ms = DEFAULT_IMAGE_DURATION_MS;
  return result;
}

function probeFile(filePath) {
  const kindGuess = kindFromSuffix(filePath);
  const result = emptyProbe(kindGuess);
  const probe = ffprobeBin();
  if (!probe) return result;
  const completed = spawnSync(probe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', String(filePath),
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (completed.status !== 0) return result;
  let payload = {};
  try { payload = JSON.parse(completed.stdout || '{}'); } catch (_) { return result; }
  return applyStreams(result, payload.streams || [], kindGuess, Number(payload.format?.duration || 0) || 0);
}

function extractFrame(mediaPath, sourceMs, dest) {
  const binary = ffmpegBin();
  if (!binary) throw new FfmpegError('本机未找到 ffmpeg，无法抽帧预览');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const seconds = Math.max(0, Number(sourceMs) || 0) / 1000;
  const completed = spawnSync(binary, [
    '-y', '-ss', seconds.toFixed(3), '-i', String(mediaPath),
    '-frames:v', '1', '-q:v', '3', String(dest),
  ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (completed.status !== 0 || !fs.existsSync(dest)) {
    throw new FfmpegError(tail(completed.stderr) || '抽帧失败');
  }
  return dest;
}

function orderedVideoClips(project) {
  const mediaById = Object.fromEntries((project.media || []).map((item) => [item.id, item]));
  for (const track of project.tracks || []) {
    if (track.kind !== 'video') continue;
    const items = [...(track.clips || [])]
      .sort((left, right) => Number(left.start_ms) - Number(right.start_ms))
      .map((clip) => ({ clip, media: mediaById[clip.media_id] }))
      .filter((item) => item.media);
    if (items.length) return items;
  }
  return [];
}

function exportTimeline(project, dest, timeoutSeconds = 180) {
  const binary = ffmpegBin();
  if (!binary) throw new FfmpegError('本机未找到 ffmpeg，无法导出。请安装 ffmpeg 并加入 PATH。');
  const clips = orderedVideoClips(project);
  if (!clips.length) throw new FfmpegError('时间线上没有视频/图片片段可导出');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = ['-y'];
  const filterParts = [];
  const concatRefs = [];
  clips.forEach((item, index) => {
    args.push('-i', String(item.media.path));
    const start = Math.max(0, Number(item.clip.in_ms) || 0) / 1000;
    const duration = Math.max(1, Number(item.clip.duration_ms) || 0) / 1000;
    const scale = `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease`;
    const pad = `pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2,fps=${project.fps}`;
    if (item.media.kind === 'image') {
      filterParts.push(
        `[${index}:v]loop=loop=-1:size=1:start=0,trim=duration=${duration.toFixed(3)},`
        + `setpts=PTS-STARTPTS,${scale},${pad}[v${index}]`,
      );
    } else {
      filterParts.push(
        `[${index}:v]trim=start=${start.toFixed(3)}:duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,`
        + `${scale},${pad}[v${index}]`,
      );
    }
    concatRefs.push(`[v${index}]`);
  });
  filterParts.push(`${concatRefs.join('')}concat=n=${clips.length}:v=1:a=0[outv]`);
  args.push('-filter_complex', filterParts.join(';'), '-map', '[outv]', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', String(dest));
  const timeoutMs = Math.max(30, Math.min(300, Number(timeoutSeconds) || 180)) * 1000;
  const completed = spawnSync(binary, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (completed.status !== 0 || !fs.existsSync(dest)) {
    throw new FfmpegError(tail(completed.stderr) || '导出失败');
  }
  return dest;
}

module.exports = {
  FfmpegError,
  available,
  extractFrame,
  exportTimeline,
  ffmpegBin,
  ffprobeBin,
  kindFromSuffix,
  probeFile,
};
