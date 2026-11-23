'use strict';

class AutomationMcpNodeEditor {
  constructor(nodes, getTools) {
    this.nodes = nodes;
    this.getTools = getTools;
    this.json = nodes['automation-node-json'];
  }

  tool(name) { return this.getTools().find((item) => item.name === name); }

  setNode(node) {
    this.json.value = node ? JSON.stringify(node, null, 2) : '';
    this.render(node);
  }

  parseAndRender() {
    this.render(this.json.value ? JSON.parse(this.json.value) : null);
  }

  render(node) {
    const root = this.nodes['automation-mcp-editor'];
    root.hidden = node?.type !== 'mcp';
    root.style.display = root.hidden ? 'none' : 'flex';
    root.style.flexDirection = 'column';
    root.style.gap = '6px';
    root.replaceChildren();
    if (root.hidden) return;
    this.renderToolPicker(root, node);
    const tool = this.tool(node.tool);
    const schema = tool?.input_schema || tool?.inputSchema;
    const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (!Object.keys(properties).length) {
      const hint = document.createElement('p');
      hint.textContent = '此工具没有可用参数 schema，可直接编辑下方节点 JSON。';
      root.append(hint);
      return;
    }
    this.renderFields(root, node, schema, properties);
  }

  renderToolPicker(root, node) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'MCP 工具');
    select.append(new Option('选择 MCP 工具…', ''));
    this.getTools().forEach((tool) => select.append(new Option(tool.name, tool.name)));
    if (node.tool && !this.tool(node.tool)) select.append(new Option(`${node.tool}（目录不可用）`, node.tool));
    select.value = node.tool || '';
    select.addEventListener('change', () => {
      try {
        const draft = JSON.parse(this.json.value);
        draft.tool = select.value;
        this.setNode(draft);
      } catch (error) { this.showError(error); }
    });
    root.append(select);
  }

  renderFields(root, node, schema, properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const args = node.arguments ?? node.args ?? {};
    Object.entries(properties).forEach(([name, definition = {}]) => {
      root.append(this.renderField(name, definition || {}, args, required.has(name)));
    });
  }

  renderField(name, definition, args, required) {
    const label = document.createElement('label');
    const hasValue = Object.hasOwn(args, name);
    const value = hasValue ? args[name] : definition.default;
    label.textContent = `${name}${required ? ' *' : ''}`;
    label.title = definition.description || '';
    label.style.cssText = 'display:flex;flex-direction:column';
    const control = document.createElement(Array.isArray(definition.enum) ? 'select' : 'input');
    this.configureField(control, definition, value, hasValue);
    control.setAttribute('aria-label', name);
    control.style.width = '100%';
    control.addEventListener('change', () => this.updateField(name, definition, control));
    label.append(control);
    return label;
  }

  configureField(control, definition, value, hasValue) {
    if (Array.isArray(definition.enum)) {
      control.append(new Option('未设置', ''));
      const choices = definition.enum.map((item) => JSON.stringify(item));
      const current = JSON.stringify(value);
      if (hasValue && !choices.includes(current)) control.append(new Option(String(value), current));
      definition.enum.forEach((item, index) => control.append(new Option(String(item), choices[index])));
      control.value = hasValue ? current : '';
      return;
    }
    // Existing string expressions must remain visible even for numeric and boolean arguments.
    const typedValue = typeof value !== 'string';
    if (definition.type === 'boolean' && typedValue) {
      control.type = 'checkbox';
      control.checked = value === true;
      return;
    }
    const numeric = ['number', 'integer'].includes(definition.type);
    control.type = numeric && typedValue ? 'number' : 'text';
    if (numeric) control.step = definition.type === 'integer' ? '1' : 'any';
    if (['object', 'array'].includes(definition.type)) {
      control.placeholder = definition.type === 'array' ? '[]' : '{}';
      control.value = hasValue ? JSON.stringify(value) : '';
    } else control.value = value == null ? '' : String(value);
  }

  updateField(name, definition, control) {
    try {
      const draft = JSON.parse(this.json.value);
      const args = draft.arguments ?? draft.args ?? {};
      automationSchema.validate(args, { type: 'object' }, 'arguments');
      const value = this.fieldValue(definition, control);
      const updated = { ...args, [name]: value };
      // JSON.stringify omits undefined fields. Keep the original spelling and the executor's precedence.
      if (draft.arguments == null && draft.args != null) draft.args = updated;
      else draft.arguments = updated;
      this.json.value = JSON.stringify(draft, null, 2);
      this.nodes['automation-editor-message'].textContent = '';
    } catch (error) { this.showError(error); }
  }

  fieldValue(definition, control) {
    if (control.type === 'checkbox') return control.checked;
    if (control.value === '') return undefined;
    if (control.type === 'number') return Number(control.value);
    if (Array.isArray(definition.enum)) return JSON.parse(control.value);
    if (['number', 'integer', 'boolean', 'object', 'array'].includes(definition.type)) {
      try { return JSON.parse(control.value); } catch { return control.value; }
    }
    return control.value;
  }

  validateNode(node) {
    if (node.type !== 'mcp') return;
    if (!node.tool) throw new Error('请选择 MCP 工具');
    const tool = this.tool(node.tool);
    const args = node.arguments ?? node.args ?? {};
    automationSchema.validate(args, { type: 'object' }, 'arguments');
    const schema = tool?.input_schema ?? tool?.inputSchema;
    if (schema != null) automationSchema.validate(args, schema, 'arguments', { allowPlaceholders: true });
  }

  showError(error) { this.nodes['automation-editor-message'].textContent = `MCP 参数无效：${error.message}`; }
}
