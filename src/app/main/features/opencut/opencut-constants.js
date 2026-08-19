'use strict';

const OPENCUT_DIR_NAME = 'opencut';
const DEFAULT_OPENCUT_HOST = '127.0.0.1';
const DEFAULT_OPENCUT_PORT = 5173;
const DEFAULT_PROJECT_WIDTH = 1920;
const DEFAULT_PROJECT_HEIGHT = 1080;
const DEFAULT_PROJECT_FPS = 30;
const DEFAULT_IMAGE_DURATION_MS = 3000;
const DEFAULT_EXPORT_TIMEOUT_SECONDS = 180;
const MAX_EXPORT_TIMEOUT_SECONDS = 300;

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

const TOOL_PREFIX = 'opencut.';

module.exports = {
  AUDIO_EXT,
  DEFAULT_EXPORT_TIMEOUT_SECONDS,
  DEFAULT_IMAGE_DURATION_MS,
  DEFAULT_OPENCUT_HOST,
  DEFAULT_OPENCUT_PORT,
  DEFAULT_PROJECT_FPS,
  DEFAULT_PROJECT_HEIGHT,
  DEFAULT_PROJECT_WIDTH,
  IMAGE_EXT,
  MAX_EXPORT_TIMEOUT_SECONDS,
  OPENCUT_DIR_NAME,
  TOOL_PREFIX,
  VIDEO_EXT,
};
