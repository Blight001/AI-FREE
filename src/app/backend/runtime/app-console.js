const util = require('util');

const APP_CONSOLE_COLORS = {
  reset: '\x1b[0m', cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m',
};

function formatAppConsoleValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.stack || value.message || String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function detectAppConsoleSource(args) {
  const match = args.map(formatAppConsoleValue).join(' ').trim().match(/^\[([^\]]+)\]/);
  return match ? String(match[1] || '').trim() : '其它';
}

function captureAppConsole() {
  const log = console.log.bind(console);
  return {
    log,
    info: typeof console.info === 'function' ? console.info.bind(console) : log,
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: typeof console.debug === 'function' ? console.debug.bind(console) : log,
  };
}

class AppConsoleBridge {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.historyLimit = options.historyLimit || 500;
    this.history = [];
    this.revision = 0;
    this.hasColor = Boolean(process.stdout?.isTTY || process.stderr?.isTTY || process.env.FORCE_COLOR);
  }

  shouldSuppress(args) {
    return detectAppConsoleSource(args) === 'TCP';
  }

  buildEntry(level, args) {
    return {
      level,
      source: detectAppConsoleSource(args),
      text: args.map(formatAppConsoleValue).join(' '),
      timestamp: new Date().toISOString(),
    };
  }

  getSnapshot(revision) {
    return revision === this.revision ? { revision } : { revision: this.revision, history: this.history.slice() };
  }

  clearHistory() {
    this.history.length = 0;
    this.revision += 1;
    return this.getSnapshot();
  }

  pushDebugOnly(level, args) {
    if (!this.enabled) return;
    try {
      const entry = this.buildEntry(level, Array.isArray(args) ? args : [args]);
      if (entry.source === 'TCP') return;
      this.history.push(entry);
      if (this.history.length > this.historyLimit) this.history.shift();
      this.revision += 1;
    } catch (_) {
      // Diagnostic capture must not break the operation that emitted the log.
    }
  }

  pickColor(level, args) {
    if (!this.hasColor) return null;
    if (level === 'error') return APP_CONSOLE_COLORS.red;
    if (level === 'warn') return APP_CONSOLE_COLORS.yellow;
    const tag = (util.format(...args).trim().match(/^\[([^\]]+)\]/) || [])[1] || '';
    return ({ 启动: APP_CONSOLE_COLORS.cyan, 配置: APP_CONSOLE_COLORS.blue, IPC: APP_CONSOLE_COLORS.magenta,
      bridge: APP_CONSOLE_COLORS.green, Shutdown: APP_CONSOLE_COLORS.yellow })[tag] || APP_CONSOLE_COLORS.cyan;
  }

  emit(level, args, originalConsole) {
    if (this.shouldSuppress(args)) return;
    const line = util.format(...args);
    const color = this.pickColor(level, args);
    const text = color ? `${color}${line}${APP_CONSOLE_COLORS.reset}` : line;
    try {
      const writer = level === 'error' ? originalConsole.error
        : level === 'warn' ? originalConsole.warn : level === 'info' ? originalConsole.info : originalConsole.log;
      writer(text);
    } catch (error) {
      if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error?.code)) throw error;
    }
  }

  installLevel(level, originalConsole) {
    return (...args) => {
      this.emit(level, args, originalConsole);
      this.pushDebugOnly(level, args);
    };
  }

  install() {
    const originalConsole = captureAppConsole();
    console.log = this.installLevel('info', originalConsole);
    console.info = this.installLevel('info', originalConsole);
    console.warn = this.installLevel('warn', originalConsole);
    console.error = this.installLevel('error', originalConsole);
    console.debug = this.installLevel('info', originalConsole);
  }
}

function createAppConsoleBridge(options) {
  const bridge = new AppConsoleBridge(options);
  return {
    install: bridge.install.bind(bridge),
    pushDebugOnly: bridge.pushDebugOnly.bind(bridge),
    getSnapshot: bridge.getSnapshot.bind(bridge),
    clearHistory: bridge.clearHistory.bind(bridge),
  };
}

module.exports = { createAppConsoleBridge };
