'use strict';

const { EditorError, newId } = require('./opencut-ids');

function timelineDuration(project) {
  let end = 0;
  for (const track of project.tracks || []) {
    for (const clip of track.clips || []) {
      end = Math.max(end, Number(clip.start_ms || 0) + Number(clip.duration_ms || 0));
    }
  }
  return end;
}

function findMedia(project, mediaId) {
  const media = (project.media || []).find((item) => item.id === mediaId);
  if (!media) throw new EditorError(`素材不存在: ${mediaId}`);
  return media;
}

function findTrack(project, trackId) {
  const track = (project.tracks || []).find((item) => item.id === trackId);
  if (!track) throw new EditorError(`轨道不存在: ${trackId}`);
  return track;
}

function findClip(project, clipId) {
  if (!clipId) throw new EditorError('缺少 clip_id');
  for (const track of project.tracks || []) {
    const clip = (track.clips || []).find((item) => item.id === clipId);
    if (clip) return { track, clip };
  }
  throw new EditorError(`片段不存在: ${clipId}`);
}

function trackForAdd(project, trackId, kind) {
  if (trackId) {
    const track = findTrack(project, String(trackId));
    const expected = kind === 'audio' ? 'audio' : 'video';
    if (track.kind !== expected && kind !== 'image') {
      throw new EditorError(`素材类型 ${kind} 不能放到 ${track.kind} 轨道`);
    }
    return track;
  }
  const wanted = kind === 'audio' ? 'audio' : 'video';
  const track = (project.tracks || []).find((item) => item.kind === wanted);
  if (!track) throw new EditorError(`工程里没有 ${wanted} 轨道`);
  return track;
}

function appendStart(track) {
  let end = 0;
  for (const clip of track.clips || []) {
    end = Math.max(end, Number(clip.start_ms) + Number(clip.duration_ms));
  }
  return end;
}

function assertNoOverlap(track, clip, ignoreId = '') {
  const start = Number(clip.start_ms);
  const end = start + Number(clip.duration_ms);
  for (const other of track.clips || []) {
    if ([clip.id, ignoreId].includes(other.id)) continue;
    const otherStart = Number(other.start_ms);
    const otherEnd = otherStart + Number(other.duration_ms);
    if (start < otherEnd && end > otherStart) {
      throw new EditorError('同一轨道上的片段不能重叠，请先移动或裁剪');
    }
  }
}

function sortClips(track) {
  track.clips.sort((left, right) => Number(left.start_ms) - Number(right.start_ms));
}

function addClip(project, args) {
  const media = findMedia(project, String(args.media_id || ''));
  const track = trackForAdd(project, args.track_id, media.kind);
  const duration = Number(args.duration_ms || media.duration_ms || 1000);
  if (duration <= 0) throw new EditorError('duration_ms 必须大于 0');
  const startMs = args.start_ms == null || args.start_ms === ''
    ? appendStart(track)
    : Number(args.start_ms);
  const clip = {
    id: newId('clip'),
    media_id: media.id,
    start_ms: startMs,
    duration_ms: duration,
    in_ms: Math.max(0, Number(args.in_ms || 0)),
  };
  assertNoOverlap(track, clip);
  track.clips.push(clip);
  sortClips(track);
  return { clip, summary: `已把 ${media.name} 放到 ${track.name} @${startMs}ms` };
}

function trimClip(project, args) {
  const { track, clip } = findClip(project, String(args.clip_id || ''));
  if (args.in_ms != null) clip.in_ms = Math.max(0, Number(args.in_ms));
  if (args.duration_ms != null) {
    const duration = Number(args.duration_ms);
    if (duration <= 0) throw new EditorError('duration_ms 必须大于 0');
    clip.duration_ms = duration;
  }
  assertNoOverlap(track, clip, clip.id);
  return { clip, summary: `已裁剪片段 ${clip.id} 为 ${clip.duration_ms}ms` };
}

function moveClip(project, args) {
  let { track, clip } = findClip(project, String(args.clip_id || ''));
  if (args.track_id) {
    const nextTrack = findTrack(project, String(args.track_id));
    if (nextTrack.id !== track.id) {
      track.clips = track.clips.filter((item) => item.id !== clip.id);
      nextTrack.clips.push(clip);
      track = nextTrack;
    }
  }
  if (args.start_ms != null) clip.start_ms = Math.max(0, Number(args.start_ms));
  assertNoOverlap(track, clip, clip.id);
  sortClips(track);
  return { clip, summary: `已移动片段 ${clip.id} 到 ${track.name} @${clip.start_ms}ms` };
}

function splitClip(project, args) {
  const { track, clip } = findClip(project, String(args.clip_id || ''));
  const atMs = Number(args.at_ms ?? -1);
  if (atMs <= clip.start_ms || atMs >= clip.start_ms + clip.duration_ms) {
    throw new EditorError('at_ms 必须落在片段内部');
  }
  const leftDur = atMs - Number(clip.start_ms);
  const right = {
    id: newId('clip'),
    media_id: clip.media_id,
    start_ms: atMs,
    duration_ms: Number(clip.duration_ms) - leftDur,
    in_ms: Number(clip.in_ms) + leftDur,
  };
  clip.duration_ms = leftDur;
  track.clips.push(right);
  sortClips(track);
  return { clip: { left: clip, right }, summary: `已在 ${atMs}ms 切开片段` };
}

function deleteClip(project, args) {
  const { track, clip } = findClip(project, String(args.clip_id || ''));
  track.clips = track.clips.filter((item) => item.id !== clip.id);
  return { clip, summary: `已删除片段 ${clip.id}` };
}

function editTimeline(project, args) {
  const action = String(args.action || '').trim().toLowerCase();
  const handlers = { add: addClip, trim: trimClip, move: moveClip, split: splitClip, delete: deleteClip };
  const handler = handlers[action];
  if (!handler) throw new EditorError('action 必须是 add / trim / move / split / delete');
  return handler(project, args);
}

module.exports = {
  editTimeline,
  findMedia,
  timelineDuration,
};
