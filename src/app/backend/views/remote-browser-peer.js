'use strict';

const FALLBACK_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const outbound = [];
const pendingIce = [];
let connection = null;
let channel = null;
let canvas = null;
let context = null;
let sessionId = '';
let readySent = false;
let latestBrowserState = null;

function queue(event, payload = {}) {
  outbound.push({ event, sessionId, ...payload });
}

function drain() {
  return outbound.splice(0, outbound.length);
}

function sendBrowserState() {
  if (!channel || channel.readyState !== 'open' || latestBrowserState === null) return;
  try { channel.send(JSON.stringify({ kind: 'browser-state', state: latestBrowserState })); } catch (_) {}
}

function cleanup() {
  if (channel) {
    try { channel.close(); } catch (_) {}
  }
  if (connection) {
    connection.onicecandidate = null;
    connection.onconnectionstatechange = null;
    try { connection.close(); } catch (_) {}
  }
  connection = null;
  channel = null;
  canvas = null;
  context = null;
  sessionId = '';
  readySent = false;
  latestBrowserState = null;
  pendingIce.length = 0;
}

async function start(input = {}) {
  cleanup();
  sessionId = String(input.sessionId || '');
  if (!sessionId) throw new Error('remote session id is required');
  canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  context = canvas.getContext('2d', { alpha: false });
  const stream = canvas.captureStream(20);
  const iceServers = Array.isArray(input.iceServers) && input.iceServers.length
    ? input.iceServers : FALLBACK_ICE_SERVERS;
  connection = new RTCPeerConnection({ iceServers });
  connection.onicecandidate = (event) => {
    if (event.candidate) queue('ice', { candidate: event.candidate.toJSON() });
  };
  connection.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(connection?.connectionState)) queue('stopped');
  };
  const track = stream.getVideoTracks()[0];
  if (track) track.contentHint = 'detail';
  const sender = track ? connection.addTrack(track, stream) : null;
  if (sender) void configureSender(sender);
  channel = connection.createDataChannel('control');
  channel.onopen = sendBrowserState;
  channel.onmessage = (event) => {
    try { queue('control', { message: JSON.parse(String(event.data)) }); } catch (_) {}
  };
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  queue('offer', { sdp: offer.sdp });
}

async function configureSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 8_000_000;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch (_) {}
}

async function answer(input = {}) {
  if (!connection || String(input.sessionId || '') !== sessionId) return;
  await connection.setRemoteDescription({ type: 'answer', sdp: input.sdp });
  for (const candidate of pendingIce.splice(0)) {
    await connection.addIceCandidate(candidate).catch(() => {});
  }
}

async function ice(input = {}) {
  if (!connection || String(input.sessionId || '') !== sessionId || !input.candidate) return;
  if (connection.remoteDescription) await connection.addIceCandidate(input.candidate).catch(() => {});
  else pendingIce.push(input.candidate);
}

function frame(input = {}) {
  if (!context || !canvas || String(input.sessionId || '') !== sessionId) return;
  const image = new Image();
  image.onload = () => {
    if (!context || !canvas) return;
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    context.drawImage(image, 0, 0);
    if (!readySent) {
      readySent = true;
      queue('ready', { width: image.width, height: image.height });
    }
  };
  image.src = String(input.dataUrl || '');
}

function browserState(input = {}) {
  if (String(input.sessionId || '') !== sessionId) return;
  latestBrowserState = input.state || null;
  sendBrowserState();
}

Object.defineProperty(window, 'remoteBrowserPeer', {
  value: Object.freeze({ start, answer, ice, frame, browserState, cleanup, drain }),
});
