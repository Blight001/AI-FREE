function renderHomeMcpTool(tool) {
  const field = (id, value) => { document.getElementById(`home-mcp-${id}`).textContent = value; };
  const json = (value) => JSON.stringify(value, null, 2);
  document.getElementById('home-mcp-details').hidden = !tool;
  document.getElementById('home-mcp-example').hidden = !tool?.sample;
  if (!tool) return;
  field('tool-name', tool.name);
  field('tool-availability', tool.availability);
  field('tool-description', tool.description);
  field('tool-schema', json(tool.inputSchema));
  if (!tool.sample) return;
  field('prompt', tool.sample.prompt);
  field('request', json(tool.sample.request));
  field('response', json(tool.sample.response));
  field('example-note', tool.sample.note || '');
}

function bindHomeMcp() {
  const home = document.getElementById('browser-empty-state');
  const panel = document.getElementById('home-mcp');
  const refresh = document.getElementById('home-mcp-refresh');
  const debug = document.getElementById('home-mcp-debug');
  const status = document.getElementById('home-mcp-status');
  const list = document.getElementById('home-mcp-tools');
  debug?.addEventListener('click', async () => {
    const result = await window.aiFree?.diagnostics?.openMcpDebugPanel?.();
    if (!result?.ok) status.textContent = result?.error?.message || '调试面板不可用';
  });
  let active = false;
  let selected = '';

  function select(tool) {
    selected = tool?.name || '';
    for (const button of list.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === selected));
    }
    renderHomeMcpTool(tool);
  }

  async function load() {
    if (refresh.disabled) return;
    refresh.disabled = true;
    status.textContent = '正在读取工具目录…';
    try {
      const result = await window.aiFree.diagnostics.getMcpCatalog();
      if (!result.ok) throw new Error(result.error.message);
      const { tools } = result.data;
      list.replaceChildren(...tools.map((tool) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.tool = tool.name;
        button.textContent = tool.name;
        button.addEventListener('click', () => select(tool));
        return button;
      }));
      select(tools.find((tool) => tool.name === selected) || tools[0]);
      status.textContent = tools.length ? `${tools.length} 个工具` : '暂无 MCP 工具';
    } catch (error) {
      list.replaceChildren();
      select(null);
      status.textContent = `目录读取失败：${error.message}`;
    } finally {
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', load);
  return () => {
    const visible = !home.hidden && !panel.hidden;
    if (visible && !active) void load();
    active = visible;
  };
}
