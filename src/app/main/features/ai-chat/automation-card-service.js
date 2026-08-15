'use strict';

const { firstText } = require('../../../shared/safe-values');

function compactCardField(value, max = 160) {
  return firstText(value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function summarizeAutomationCard(item) {
  const data = item && item.cardData && typeof item.cardData === 'object' ? item.cardData : {};
  return {
    id: firstText(item && item.id),
    name: firstText(item && item.cardName, data.name, item && item.id, '未命名卡片'),
    website: compactCardField(data.website, 200),
    description: compactCardField(data.description, 160),
    stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
    savedAt: firstText(item && item.savedAt),
  };
}

function listAutomationCards(bridge) {
  const cached = bridge?.getCardCacheState?.() || { exists: false, state: { items: [], selectedId: '' } };
  const items = cached.state && Array.isArray(cached.state.items) ? cached.state.items : [];
  return items.map(summarizeAutomationCard).filter((item) => item.id);
}

async function getAutomationCards(bridge) {
  const cached = bridge?.getCardCacheState?.() || { exists: false, state: { items: [], selectedId: '' } };
  return {
    ok: true,
    selectedId: firstText(cached.state && cached.state.selectedId),
    cards: listAutomationCards(bridge),
  };
}

function selectAutomationCard(bridge, input = {}) {
  const selected = typeof bridge?.selectCard === 'function' ? bridge.selectCard(input?.id) : null;
  if (!selected || !selected.item) throw new Error('软件卡片库不可用');
  return {
    ok: true,
    selectedId: firstText(selected.state && selected.state.selectedId),
    card: {
      id: firstText(selected.item.id),
      name: firstText(selected.item.cardName, selected.item.cardData && selected.item.cardData.name, selected.item.id, '未命名卡片'),
      stepCount: selected.item.cardData && Array.isArray(selected.item.cardData.steps) ? selected.item.cardData.steps.length : 0,
    },
  };
}

async function manageAutomationCard(bridge, input = {}) {
  if (!bridge || typeof bridge.manageCard !== 'function') throw new Error('软件卡片库不可用');
  const args = { .../** @type {Record<string, any>} */ (input) };
  const connectionId = args.connectionId;
  delete args.connectionId;
  const data = await bridge.manageCard(connectionId, args, { timeoutMs: 30 * 60 * 1000 });
  return { ok: true, data };
}

async function saveAutomationSession(bridge, input = {}) {
  if (!bridge || typeof bridge.saveBrowserSession !== 'function') throw new Error('浏览器会话保存功能不可用');
  const connectionId = firstText(input && input.connectionId);
  if (!connectionId) throw new Error('请先选择已连接的浏览器窗口');
  const data = await bridge.saveBrowserSession(connectionId, {
    format: firstText(input && input.format, 'json'),
  }, { timeoutMs: 120000 });
  return { ok: true, data };
}

function createAutomationCardService({ bridge }) {
  return {
    getAutomationCards: () => getAutomationCards(bridge),
    manageAutomationCard: (input) => manageAutomationCard(bridge, input),
    saveAutomationSession: (input) => saveAutomationSession(bridge, input),
    selectAutomationCard: (input) => selectAutomationCard(bridge, input),
  };
}

module.exports = {
  compactCardField,
  createAutomationCardService,
  listAutomationCards,
  summarizeAutomationCard,
};
