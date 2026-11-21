'use strict';

const AUTOMATION_NODE_COLORS = Object.freeze({
  mcp: '#2563eb', navigate: '#0f766e', click: '#0891b2', type: '#7c3aed',
  wait: '#ca8a04', delay: '#64748b', condition: '#ea580c', end: '#dc2626',
});

function automationNodeId(node, index) { return String(node.id || `step_${index + 1}`); }

function automationNodePosition(node, index, layout) {
  const saved = layout[automationNodeId(node, index)] || {};
  return { x: Number(saved.x ?? (60 + (index % 3) * 210)), y: Number(saved.y ?? (70 + Math.floor(index / 3) * 145)) };
}

function automationEdgePath(from, to) {
  const startX = from.x + 150;
  const startY = from.y + 44;
  const endX = to.x;
  const endY = to.y + 44;
  const bend = Math.max(45, Math.abs(endX - startX) * 0.4);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

class AutomationCanvas {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.card = null;
    this.selectedId = '';
    this.connectFrom = '';
    this.connectMode = false;
  }

  layout() {
    if (!this.card.flow || typeof this.card.flow !== 'object') this.card.flow = { start: '', edges: [], layout: {} };
    this.card.flow.edges = Array.isArray(this.card.flow.edges) ? this.card.flow.edges : [];
    this.card.flow.layout = this.card.flow.layout && typeof this.card.flow.layout === 'object' ? this.card.flow.layout : {};
    return this.card.flow.layout;
  }

  addEdge(from, to) {
    const label = this.options.getEdgeLabel?.() || 'next';
    this.card.flow.edges = this.card.flow.edges.filter((edge) => !(String(edge.from || edge.source) === from
      && String(edge.label || edge.branch || 'next') === label));
    this.card.flow.edges.push({ from, to, label });
    this.render();
  }

  moveNode(node, index, event) {
    const start = automationNodePosition(node, index, this.layout());
    const origin = { x: event.clientX, y: event.clientY };
    const item = event.currentTarget;
    const move = (next) => this.updateNodePosition(node, index, start, origin, item, next);
    const finish = () => this.finishNodeMove(move, finish);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', finish, { once: true });
  }

  updateNodePosition(node, index, start, origin, item, event) {
    const id = automationNodeId(node, index);
    const pos = { x: Math.max(12, start.x + event.clientX - origin.x), y: Math.max(12, start.y + event.clientY - origin.y) };
    this.layout()[id] = pos;
    item.style.left = `${pos.x}px`;
    item.style.top = `${pos.y}px`;
    this.renderEdges(this.container.clientWidth, this.container.clientHeight);
  }

  finishNodeMove(move, finish) {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
  }

  chooseNode(node, index) {
    const id = automationNodeId(node, index);
    if (this.connectMode) return this.chooseConnectionTarget(id);
    this.selectedId = id;
    this.options.onSelect?.(node, index);
    this.render();
  }

  chooseConnectionTarget(id) {
    if (!this.connectFrom) this.connectFrom = id;
    else { this.addEdge(this.connectFrom, id); this.connectFrom = ''; }
    this.options.onHint?.(this.connectFrom ? '再选择连线终点' : '连线已更新');
  }

  edgeNodes() {
    return this.card.steps.map((node, index) => [automationNodeId(node, index), automationNodePosition(node, index, this.layout())]);
  }

  renderEdges(width, height) {
    const svg = this.container.querySelector('svg');
    if (!svg) return;
    svg.setAttribute('width', String(Math.max(width, 760)));
    svg.setAttribute('height', String(Math.max(height, 520)));
    const positions = new Map(this.edgeNodes());
    svg.replaceChildren();
    this.appendArrowMarker(svg);
    this.card.flow.edges.forEach((edge) => this.renderEdge(svg, edge, positions));
  }

  appendArrowMarker(svg) {
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'automation-arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    arrow.setAttribute('fill', 'currentColor');
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);
  }

  renderEdge(svg, edge, positions) {
    const from = positions.get(String(edge.from || edge.source || ''));
    const to = positions.get(String(edge.to || edge.target || ''));
    if (!from || !to) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', automationEdgePath(from, to));
    path.setAttribute('class', 'automation-edge');
    path.setAttribute('marker-end', 'url(#automation-arrow)');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = String(edge.label || 'next');
    path.append(title);
    svg.append(path);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String((from.x + to.x + 150) / 2));
    label.setAttribute('y', String((from.y + to.y + 88) / 2 - 5));
    label.setAttribute('class', 'automation-edge-label');
    label.textContent = String(edge.label || 'next');
    svg.append(label);
  }

  renderNodes() { this.card.steps.forEach((node, index) => this.renderNode(node, index)); }

  renderNode(node, index) {
    const id = automationNodeId(node, index);
    const pos = automationNodePosition(node, index, this.layout());
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `automation-node${id === this.selectedId ? ' is-selected' : ''}`;
    item.style.setProperty('--node-color', AUTOMATION_NODE_COLORS[node.type] || '#475569');
    item.style.left = `${pos.x}px`;
    item.style.top = `${pos.y}px`;
    item.dataset.nodeId = id;
    item.setAttribute('aria-label', `${node.name || node.type || '流程节点'}，${node.type || 'unknown'}`);
    const type = document.createElement('small');
    const name = document.createElement('strong');
    type.textContent = String(node.type || 'unknown').toUpperCase();
    name.textContent = String(node.name || id);
    item.append(type, name);
    item.addEventListener('pointerdown', (event) => this.startNodeDrag(node, index, event));
    item.addEventListener('click', () => this.chooseNode(node, index));
    this.container.append(item);
  }

  startNodeDrag(node, index, event) {
    if (event.button === 0 && !this.connectMode) this.moveNode(node, index, event);
  }

  render() {
    if (!this.card) return;
    this.container.replaceChildren();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    this.container.append(svg);
    this.renderNodes();
    this.renderEdges(this.container.clientWidth, this.container.clientHeight);
  }

  setCard(value) {
    this.card = value;
    this.layout();
    this.selectedId = '';
    this.render();
  }

  setConnectMode(value) {
    this.connectMode = Boolean(value);
    this.connectFrom = '';
    this.container.classList.toggle('is-connecting', this.connectMode);
  }

  removeSelected() {
    if (!this.selectedId) return;
    const removed = this.selectedId;
    this.card.steps = this.card.steps.filter((node, index) => automationNodeId(node, index) !== removed);
    this.card.flow.edges = this.card.flow.edges.filter((edge) => String(edge.from || edge.source) !== removed
      && String(edge.to || edge.target) !== removed);
    if (this.card.flow.start === removed) this.card.flow.start = automationNodeId(this.card.steps[0] || {}, 0);
    delete this.card.flow.layout[removed];
    this.selectedId = '';
    this.options.onSelect?.(null, -1);
    this.render();
  }

  selectNode(id) {
    const index = this.card?.steps.findIndex((node, nodeIndex) => automationNodeId(node, nodeIndex) === id) ?? -1;
    if (index < 0) return;
    this.selectedId = id;
    this.options.onSelect?.(this.card.steps[index], index);
    this.render();
  }
}

function createAutomationCanvas(container, options = {}) { return new AutomationCanvas(container, options); }
window.createAutomationCanvas = createAutomationCanvas;
