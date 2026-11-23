  function parseToolArguments(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function toolDisplayName(tool = {}) {
    const rawName = String(tool.name || '').trim();
    const args = parseToolArguments(tool.arguments);
    const action = String(args.action || '').trim().toLowerCase();
    const actionName = TOOL_ACTION_DISPLAY_NAMES[rawName]?.[action];
    if (actionName) return actionName;
    if (TOOL_DISPLAY_NAMES[rawName]) return TOOL_DISPLAY_NAMES[rawName];
    if (/\p{Script=Han}/u.test(rawName)) return rawName;
    const separatorIndex = rawName.indexOf('.');
    if (separatorIndex > 0) {
      const namespace = TOOL_NAMESPACE_NAMES[rawName.slice(0, separatorIndex)];
      const operation = TOOL_OPERATION_NAMES[rawName.slice(separatorIndex + 1)];
      if (namespace && operation) return `${namespace}${operation}`;
      if (namespace) return `${namespace}工具`;
    }
    return '浏览器原生工具';
  }

  function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
    if (milliseconds < 1000) return `${Math.max(0.1, milliseconds / 1000).toFixed(1)}s`;
    if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  function createToolCopyButton(value, label = '复制') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-chat-copy-action';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const copied = await copyTextToClipboard(value);
      button.textContent = copied ? '已复制' : '复制失败';
      window.setTimeout(() => { button.textContent = label; }, 1400);
    });
    return button;
  }

  function appendToolSection(container, labelText, value, error = false) {
    if (value === undefined || value === null || value === '') return;
    const label = document.createElement('div');
    label.className = `ai-chat-tool-detail-label${error ? ' error' : ''}`;
    label.textContent = labelText;
    const pre = document.createElement('pre');
    pre.className = `ai-chat-tool-detail-body${error ? ' error' : ''}`;
    pre.textContent = formatActivityDetail(value);
    container.append(label, pre);
  }

  const COMMAND_STATE_LABELS = Object.freeze({
    running: '运行中', stopping: '正在停止', exited: '执行完成', failed: '执行失败',
    timed_out: '已超时', stopped: '已停止', termination_unconfirmed: '无法确认终止',
  });

  function commandState(tool, snapshot) {
    if (Object.hasOwn(COMMAND_STATE_LABELS, snapshot.state)) return snapshot.state;
    if (snapshot.timed_out === true || snapshot.timedOut === true) return 'timed_out';
    if (snapshot.success === false || tool.status === 'error') return 'failed';
    return tool.status === 'running' ? 'running' : 'exited';
  }

  function appendCommandCard(container, args) {
    const card = document.createElement('section');
    card.className = 'ai-chat-command-card';
    const meta = document.createElement('div');
    meta.className = 'ai-chat-command-meta';
    const cwd = document.createElement('span');
    cwd.textContent = String(args.cwd || args.directory || '.');
    const timeout = document.createElement('span');
    const timeoutMs = args.timeout_ms ?? (args.timeout_seconds ? Number(args.timeout_seconds) * 1000 : null);
    const duration = timeoutMs ? formatDuration(timeoutMs) : '';
    timeout.textContent = duration ? `超时 ${duration}` : '';
    const command = document.createElement('div');
    command.className = 'ai-chat-command-code';
    const prompt = document.createElement('span');
    prompt.textContent = '$';
    const pre = document.createElement('pre');
    pre.textContent = String(args.command || '');
    command.append(prompt, pre, createToolCopyButton(pre.textContent, '复制命令'));
    meta.append(cwd, timeout);
    card.append(meta, command);
    container.appendChild(card);
  }

  function createCommandOutput(container, label, error = false) {
    const title = document.createElement('div');
    title.className = `ai-chat-tool-detail-label${error ? ' error' : ''}`;
    const pre = document.createElement('pre');
    pre.className = `ai-chat-tool-detail-body${error ? ' error' : ''}`;
    container.append(title, pre);
    return (value, truncated) => {
      title.hidden = pre.hidden = !value && !truncated;
      const nextTitle = truncated ? `${label}（已截断）` : label;
      if (title.textContent !== nextTitle) title.textContent = nextTitle;
      if (pre.textContent !== value) pre.textContent = value;
    };
  }

  function appendCommandResult(container, tool) {
    const card = document.createElement('section');
    const heading = document.createElement('div');
    heading.className = 'ai-chat-command-result-heading';
    const status = document.createElement('strong');
    const code = document.createElement('span');
    heading.append(status, code);
    card.appendChild(heading);
    const stdout = createCommandOutput(card, '标准输出');
    const stderr = createCommandOutput(card, '错误输出', true);
    const failure = createCommandOutput(card, '错误原因', true);
    container.appendChild(card);
    return (snapshot) => {
      const state = commandState(tool, snapshot);
      card.className = `ai-chat-command-result${['running', 'stopping', 'exited'].includes(state) ? '' : ' error'}`;
      status.textContent = COMMAND_STATE_LABELS[state];
      const exitCode = snapshot.exit_code ?? snapshot.exitCode;
      code.textContent = exitCode == null ? '' : `退出码 ${exitCode}`;
      const empty = state === 'exited' && !snapshot.stderr ? '命令未返回文本输出' : '';
      stdout(String(snapshot.stdout || empty), snapshot.stdout_truncated === true);
      stderr(String(snapshot.stderr || ''), snapshot.stderr_truncated === true);
      failure(String(snapshot.error || ''), false);
    };
  }

  function restoredToolActivity(tool) {
    if (tool?.name === 'run_command' && tool.status === 'running') {
      return { ...tool, status: 'error', result: { state: 'termination_unconfirmed' } };
    }
    return tool || {};
  }

  function appendToolDetails(detail, tool, rawOpen) {
    const args = parseToolArguments(tool.arguments);
    const rawCopy = [
      `工具: ${String(tool.name || '')}`,
      `参数:\n${formatActivityDetail(tool.arguments)}`,
      `结果:\n${formatActivityDetail(tool.result)}`,
    ].join('\n\n');
    const copy = createToolCopyButton(rawCopy, '复制全部');
    copy.classList.add('ai-chat-tool-copy-all');
    detail.appendChild(copy);
    const doc = document.createElement('div');
    doc.className = 'ai-chat-tool-detail-doc';
    detail.appendChild(doc);
    if (tool.name === 'run_command') {
      if (args.command) appendCommandCard(doc, args);
      const updateOutput = appendCommandResult(doc, tool);
      const raw = document.createElement('details');
      raw.className = 'ai-chat-tool-raw';
      raw.open = rawOpen;
      const summary = document.createElement('summary');
      summary.innerHTML = '查看原始调用数据<span class="ai-chat-disclosure" aria-hidden="true">›</span>';
      const rawBody = document.createElement('div');
      appendToolSection(rawBody, '参数', tool.arguments);
      appendToolSection(rawBody, '结果', tool.result);
      raw.append(summary, rawBody);
      enableDetailsAnimation(raw, rawBody);
      doc.appendChild(raw);
      return updateOutput;
    } else {
      appendToolSection(doc, '参数', tool.arguments);
      appendToolSection(doc, tool.status === 'error' ? '错误' : '结果', tool.result, tool.status === 'error');
    }
    return null;
  }

  function updateToolSummary(summary, tool, snapshot) {
    const status = String(tool.status || 'running');
    const duration = formatDuration(snapshot.duration_ms ?? tool.duration_ms);
    const genericState = toolStateLabel(status, snapshot);
    const label = tool.name === 'run_command' ? COMMAND_STATE_LABELS[commandState(tool, snapshot)] : genericState;
    summary.querySelector('.ai-chat-tool-state').textContent = label;
    const name = summary.querySelector('.ai-chat-tool-name');
    name.textContent = String(tool.name || 'MCP 工具');
    name.title = toolDisplayName(tool);
    summary.querySelector('.ai-chat-tool-duration').textContent = duration;
    summary.setAttribute('aria-label', `${toolDisplayName(tool)}，${label}${duration ? `，耗时 ${duration}` : ''}`);
  }

  function toolStateLabel(status, snapshot) {
    if (Number.isInteger(snapshot.requested) && Number.isInteger(snapshot.completed)) {
      const count = `${snapshot.completed}/${snapshot.requested} 步`;
      return status === 'error' ? `已中断 · ${count}` : count;
    }
    if (snapshot.uploadVerification === 'file_selected') return '文件已选入控件';
    if (snapshot.errorCode === 'UPLOAD_OUTCOME_UNVERIFIED') return '结果待核验';
    if (snapshot.errorCode === 'UPLOAD_CANCELLED') return '上传已取消';
    if (status === 'running') return '调用中';
    return status === 'error' ? '调用失败' : '调用';
  }

  function createToolActivity(tool = {}, onToggle = () => {}) {
    const card = document.createElement('details');
    card.className = `ai-chat-tool ${tool.status || 'running'}`;
    card.dataset.toolId = String(tool.id || '');
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="ai-chat-tool-dot" aria-hidden="true"></span><span class="ai-chat-tool-state"></span><span class="ai-chat-tool-provider">AI-FREE</span><code class="ai-chat-tool-name"></code><span class="ai-chat-tool-duration"></span><span class="ai-chat-disclosure" aria-hidden="true">›</span>';
    const detail = document.createElement('div');
    detail.className = 'ai-chat-tool-detail';
    card.append(summary, detail);
    const disclosure = enableDetailsAnimation(card, detail, onToggle);
    let updateOutput = null;
    let snapshot = {};
    card.addEventListener('toggle', () => { if (card.open) updateOutput?.(snapshot); });
    const update = ({ progress, ...next } = {}) => {
      if (progress) {
        if (!['run_command', 'browser_page_batch'].includes(tool.name) || (tool.status && tool.status !== 'running')) return;
        snapshot = progress;
        updateToolSummary(summary, tool, snapshot);
        if (card.open) updateOutput?.(snapshot);
        return;
      }
      Object.assign(tool, next);
      card.className = `ai-chat-tool ${tool.status || 'running'}`;
      snapshot = ['run_command', 'browser_file', 'browser_page_batch'].includes(tool.name) ? parseToolArguments(tool.result) : {};
      updateToolSummary(summary, tool, snapshot);
      const rawOpen = detail.querySelector('.ai-chat-tool-raw')?.open === true;
      detail.innerHTML = '';
      updateOutput = appendToolDetails(detail, tool, rawOpen);
      updateOutput?.(snapshot);
    };
    update(tool);
    return { card, tool, update, setOpen: disclosure.setOpen };
  }
