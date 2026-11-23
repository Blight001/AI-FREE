'use strict';

const { createHash } = require('node:crypto');
const { CHAT_SESSION_TOOL } = require('./managed-chat-contract');

function makeDeviceChatCaller(service) {
  const identity = [service.credentials?.server, service.credentials?.account, service.serviceId];
  return `heysure:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

async function callDeviceTask(service, name, args) {
  if (name !== CHAT_SESSION_TOOL) return service.callTool(name, args);
  const result = await service.callTool(name, args, undefined, makeDeviceChatCaller(service));
  if (result?.ok === false) throw Object.assign(new Error(result.error.message), result.error);
  return result;
}

function emitDeviceTaskTerminal(service, socket, sourceName, event, payload, actor) {
  if (sourceName === CHAT_SESSION_TOOL && makeDeviceChatCaller(service) !== actor) return;
  const pending = sourceName === CHAT_SESSION_TOOL && !(service.registered && service.socket?.connected);
  service.rememberCompletedTask(payload.taskId, { event, payload, managed: sourceName === CHAT_SESSION_TOOL, pending });
  if (!pending) (sourceName === CHAT_SESSION_TOOL ? service.socket : socket)?.emit(event, payload);
}

function deliverPendingChatTasks(service) {
  if (!service.socket?.connected) return;
  for (const terminal of service.completedTasks.values()) {
    if (!terminal.pending) continue;
    service.socket.emit(terminal.event, terminal.payload);
    terminal.pending = false;
  }
}

module.exports = { callDeviceTask, deliverPendingChatTasks, emitDeviceTaskTerminal, makeDeviceChatCaller };
