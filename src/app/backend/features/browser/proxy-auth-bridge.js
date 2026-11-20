'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { openSocksTunnel } = require('./proxy-auth-socks-transport');

const LOOPBACK_HOST = '127.0.0.1';
const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;

function bridgeError(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function validateProxyAddress(host, port) {
  if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw bridgeError('PROXY_AUTH_BRIDGE_PROXY_INVALID', '代理主机或端口无效');
  }
}

function validateProxyCredentials(protocol, username, password) {
  if (!username && !password) {
    throw bridgeError('PROXY_AUTH_BRIDGE_CREDENTIALS_REQUIRED', '代理认证凭据为空');
  }
  if (protocol === 'socks4' && password) {
    throw bridgeError('PROXY_AUTH_BRIDGE_CREDENTIALS_UNSUPPORTED', 'SOCKS4 仅支持用户 ID，不支持密码认证');
  }
  if (protocol === 'socks4' && Buffer.byteLength(username) > 255) {
    throw bridgeError('PROXY_AUTH_BRIDGE_CREDENTIALS_INVALID', 'SOCKS4 用户 ID 最多为 255 字节');
  }
  if (protocol === 'socks5' && (!username || !password)) {
    throw bridgeError('PROXY_AUTH_BRIDGE_CREDENTIALS_INVALID', 'SOCKS5 用户名和密码都必须填写');
  }
  if (protocol === 'socks5' && (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255)) {
    throw bridgeError('PROXY_AUTH_BRIDGE_CREDENTIALS_INVALID', 'SOCKS5 用户名和密码最多为 255 字节');
  }
}

function normalizeProxy(input = {}) {
  const protocol = String(input.protocol || 'http').trim().toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
    throw bridgeError('PROXY_AUTH_BRIDGE_PROTOCOL_UNSUPPORTED', '代理认证协议不受支持');
  }
  const host = String(input.host || '').trim().replace(/^\[|\]$/g, '');
  const port = Number(input.port);
  validateProxyAddress(host, port);
  const username = String(input.username || '');
  const password = String(input.password || '');
  validateProxyCredentials(protocol, username, password);
  return { protocol, host, port, username, password };
}

function createUpstreamAuthorization(proxy) {
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`, 'utf8').toString('base64')}`;
}

function isHopByHopHeader(name) {
  return ['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']
    .includes(name.toLowerCase());
}

function responseWithError(response, statusCode, message) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
  response.end(message);
}

function parseAbsoluteHttpUrl(value) {
  try {
    const target = new URL(value);
    return ['http:', 'https:'].includes(target.protocol) ? target : null;
  } catch (_) {
    return null;
  }
}

function copyResponseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !isHopByHopHeader(name)));
}

function upstreamResponseHandler(response) {
  return (upstreamResponse) => {
    if (upstreamResponse.statusCode === 407) {
      upstreamResponse.resume();
      responseWithError(response, 407, 'Proxy authentication failed');
      return;
    }
    response.writeHead(upstreamResponse.statusCode || 502, copyResponseHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
    upstreamResponse.on('error', () => response.destroy());
  };
}

function createHttpRequestHandler(proxy, authHeader, trackSocket) {
  return (request, response) => {
    const target = parseAbsoluteHttpUrl(request.url);
    if (!target) {
      responseWithError(response, 400, 'Invalid proxy request');
      return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers)
      .filter(([name]) => !isHopByHopHeader(name)));
    headers.host = target.host;
    headers['proxy-authorization'] = authHeader;
    if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
      void forwardSocksHttpRequest(proxy, request, response, target, trackSocket);
      return;
    }
    const transport = proxy.protocol === 'https' ? https : http;
    const upstream = transport.request({
      hostname: proxy.host,
      port: proxy.port,
      method: request.method,
      path: target.href,
      headers,
      setHost: false,
      timeout: UPSTREAM_TIMEOUT_MS,
    }, upstreamResponseHandler(response));
    upstream.on('socket', trackSocket);
    upstream.on('timeout', () => upstream.destroy(bridgeError('PROXY_UPSTREAM_TIMEOUT', '代理上游超时')));
    upstream.on('error', () => responseWithError(response, 502, 'Proxy upstream unavailable'));
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  };
}

async function forwardSocksHttpRequest(proxy, request, response, target, trackSocket) {
  try {
    const socket = await openSocksTunnel(
      proxy, target.hostname, Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
      trackSocket, bridgeError, UPSTREAM_TIMEOUT_MS,
    );
    if (request.aborted || response.destroyed) { socket.destroy(); return; }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !isHopByHopHeader(name)));
    headers.host = target.host;
    const transport = target.protocol === 'https:' ? https : http;
    const upstreamSocket = target.protocol === 'https:'
      ? tls.connect({ socket, servername: target.hostname }) : socket;
    trackSocket(upstreamSocket);
    const agent = new transport.Agent({ keepAlive: false });
    Object.assign(agent, { createConnection: () => upstreamSocket });
    const upstream = transport.request({
      hostname: target.hostname,
      port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
      agent,
      timeout: UPSTREAM_TIMEOUT_MS,
    }, upstreamResponseHandler(response));
    upstream.on('timeout', () => upstream.destroy(bridgeError('PROXY_UPSTREAM_TIMEOUT', '代理上游超时')));
    upstream.on('error', () => responseWithError(response, 502, 'Proxy upstream unavailable'));
    upstream.on('close', () => agent.destroy());
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  } catch (_) {
    responseWithError(response, 502, 'Proxy upstream unavailable');
  }
}

function connectUpstream(proxy, trackSocket) {
  const tlsOptions = net.isIP(proxy.host) ? {} : { servername: proxy.host };
  const socket = proxy.protocol === 'https'
    ? tls.connect({ host: proxy.host, port: proxy.port, ...tlsOptions })
    : net.connect({ host: proxy.host, port: proxy.port });
  trackSocket(socket);
  return socket;
}

function connectHeader(target, authHeader) {
  return [
    `CONNECT ${target} HTTP/1.1`,
    `Host: ${target}`,
    `Proxy-Authorization: ${authHeader}`,
    'Proxy-Connection: keep-alive',
    '',
    '',
  ].join('\r\n');
}

function parseConnectTarget(value) {
  const match = String(value || '').match(/^\[([0-9a-f:.]+)\]:(\d{1,5})$|^([^:[\]\s]+):(\d{1,5})$/i);
  if (!match) return null;
  const host = match[1] || match[3];
  const port = Number(match[2] || match[4]);
  if (port < 1 || port > 65535) return null;
  return { authority: match[0], host, port };
}

function relayConnectTunnel(client, upstream, initialData) {
  client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: AI-FREE\r\n\r\n');
  if (initialData.length) client.write(initialData);
  client.pipe(upstream);
  upstream.pipe(client);
}

function rejectConnect(client, upstream, statusLine) {
  client.end(`${statusLine}\r\nConnection: close\r\n\r\n`);
  upstream.destroy();
}

function safeConnectFailureStatus(statusLine) {
  const status = Number(String(statusLine || '').match(/^HTTP\/1\.[01] (\d{3})(?:\s|$)/)?.[1]);
  if (!Number.isInteger(status) || status < 400 || status > 599) return 'HTTP/1.1 502 Bad Gateway';
  return `HTTP/1.1 ${status} ${status === 407 ? 'Proxy Authentication Required' : 'Proxy Error'}`;
}

async function connectSocks5Client(proxy, target, client, initialData, trackSocket) {
  try {
    const upstream = await openSocksTunnel(
      proxy, target.host, target.port, trackSocket, bridgeError, UPSTREAM_TIMEOUT_MS,
    );
    if (client.destroyed) { upstream.destroy(); return; }
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    upstream.on('error', () => client.destroy());
    upstream.pause();
    relayConnectTunnel(client, upstream, Buffer.alloc(0));
    if (initialData.length) upstream.write(initialData);
    upstream.resume();
  } catch (_) {
    if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  }
}

function createConnectHandler(proxy, authHeader, trackSocket) {
  return (request, client, initialData) => {
    const target = parseConnectTarget(request.url);
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
      void connectSocks5Client(proxy, target, client, initialData, trackSocket);
      return;
    }
    const upstream = connectUpstream(proxy, trackSocket);
    let responseBuffer = Buffer.alloc(0);
    let responseComplete = false;
    let tunnelEstablished = false;
    const timer = setTimeout(() => upstream.destroy(bridgeError('PROXY_UPSTREAM_TIMEOUT', '代理上游超时')), UPSTREAM_TIMEOUT_MS);
    timer.unref?.();
    upstream.once(proxy.protocol === 'https' ? 'secureConnect' : 'connect', () => (
      upstream.write(connectHeader(target.authority, authHeader))
    ));
    const handleUpstreamResponse = (chunk) => {
      if (responseComplete) return;
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      if (responseBuffer.length > MAX_CONNECT_RESPONSE_BYTES) {
        clearTimeout(timer);
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        upstream.destroy();
        return;
      }
      const headerEnd = responseBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      responseComplete = true;
      clearTimeout(timer);
      const headerBlock = responseBuffer.subarray(0, headerEnd);
      const statusLine = headerBlock.toString('latin1').split('\r\n', 1)[0];
      if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(statusLine)) {
        upstream.off('data', handleUpstreamResponse);
        rejectConnect(client, upstream, safeConnectFailureStatus(statusLine));
        return;
      }
      const remainder = responseBuffer.subarray(headerEnd + 4);
      upstream.off('data', handleUpstreamResponse);
      tunnelEstablished = true;
      upstream.pause();
      relayConnectTunnel(client, upstream, remainder);
      if (initialData.length) upstream.write(initialData);
      upstream.resume();
    };
    upstream.on('data', handleUpstreamResponse);
    upstream.on('error', () => {
      clearTimeout(timer);
      if (tunnelEstablished) client.destroy();
      else if (!client.destroyed && !client.writableEnded) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    });
    upstream.on('close', () => {
      clearTimeout(timer);
      if (tunnelEstablished) client.destroy();
      else if (!client.destroyed && !client.writableEnded) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  };
}

async function startProxyAuthBridge(input) {
  const proxy = normalizeProxy(input);
  const authHeader = createUpstreamAuthorization(proxy);
  const sockets = new Set();
  let closing = false;
  let closePromise;
  const trackSocket = (socket) => {
    if (!socket || sockets.has(socket)) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  };
  const server = http.createServer(createHttpRequestHandler(proxy, authHeader, trackSocket));
  server.on('connection', trackSocket);
  server.on('connect', createConnectHandler(proxy, authHeader, trackSocket));
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(bridgeError('PROXY_AUTH_BRIDGE_LISTEN_FAILED', error.code || 'Loopback proxy could not start'));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw bridgeError('PROXY_AUTH_BRIDGE_LISTEN_FAILED', 'Loopback proxy address unavailable');
  }
  return {
    proxyServer: `http://${LOOPBACK_HOST}:${address.port}`,
    async close() {
      if (closing) return closePromise;
      closing = true;
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      closePromise = new Promise((resolve) => server.close(() => resolve(undefined)));
      await closePromise;
      sockets.clear();
    },
  };
}

module.exports = { startProxyAuthBridge };
