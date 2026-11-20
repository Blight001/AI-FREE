'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
const { startProxyAuthBridge } = require('../../../src/app/backend/features/browser/proxy-auth-bridge');

const credentials = { username: 'route-user', password: 'private-password' };
const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;

function createSocks5AuthProxy(expectedCredentials) {
  const state = { username: '', password: '', target: '', request: '' };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let phase = 'greeting';
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (phase === 'tunnel') {
        state.request += chunk.toString('latin1');
        if (state.request.includes('\r\n\r\n')) {
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
          socket.end();
        }
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 'greeting') {
        if (buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        phase = 'authentication';
        socket.write(Buffer.from([5, 2]));
      }
      if (phase === 'authentication') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        const usernameLength = buffer[1];
        if (buffer.length < 3 + usernameLength) return;
        const passwordLength = buffer[2 + usernameLength];
        if (buffer.length < 3 + usernameLength + passwordLength) return;
        state.username = buffer.subarray(2, 2 + usernameLength).toString();
        state.password = buffer.subarray(3 + usernameLength, 3 + usernameLength + passwordLength).toString();
        buffer = buffer.subarray(3 + usernameLength + passwordLength);
        const success = state.username === expectedCredentials.username
          && state.password === expectedCredentials.password;
        socket.write(Buffer.from([1, success ? 0 : 1]));
        phase = success ? 'connect' : 'failed';
        if (!success) { socket.end(); return; }
      }
      if (phase === 'connect') {
        if (buffer.length < 5) return;
        const addressLength = buffer[4];
        if (buffer.length < 5 + addressLength + 2) return;
        state.target = buffer.subarray(5, 5 + addressLength).toString();
        buffer = buffer.subarray(7 + addressLength);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        phase = 'tunnel';
        if (buffer.length) socket.emit('data', buffer);
      }
    });
  });
  return {
    server,
    state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}

function createSocks4UserProxy(expectedUser) {
  const state = { userId: '', target: '', request: '' };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let phase = 'request';
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (phase === 'tunnel') {
        state.request += chunk.toString('latin1');
        if (state.request.includes('\r\n\r\n')) {
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
          socket.end();
        }
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const userEnd = buffer.indexOf(0, 8);
      const hostEnd = userEnd >= 0 ? buffer.indexOf(0, userEnd + 1) : -1;
      if (hostEnd < 0) return;
      state.userId = buffer.subarray(8, userEnd).toString();
      state.target = buffer.subarray(userEnd + 1, hostEnd).toString();
      socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
      phase = 'tunnel';
      buffer = buffer.subarray(hostEnd + 1);
      if (buffer.length) socket.emit('data', buffer);
    });
  });
  return {
    server,
    state,
    expectedUser,
    async close() {
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}

function createSocks4TunnelProxy() {
  const state = { userId: '', target: '', port: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let connected = false;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (connected) {
        socket.write(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const userEnd = buffer.indexOf(0, 8);
      const hostEnd = userEnd >= 0 ? buffer.indexOf(0, userEnd + 1) : -1;
      if (hostEnd < 0) return;
      state.port = buffer.readUInt16BE(2);
      state.userId = buffer.subarray(8, userEnd).toString();
      state.target = buffer.subarray(userEnd + 1, hostEnd).toString();
      connected = true;
      socket.write(Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]));
    });
  });
  return {
    server,
    state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function makeLocalRequest(port, options, body = '') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, ...options }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('proxy auth bridge forwards absolute HTTP requests with upstream-only credentials', async (t) => {
  let observed;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      observed = {
        authorization: request.headers['proxy-authorization'],
        host: request.headers.host,
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('proxied');
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const bridge = await startProxyAuthBridge({
    protocol: 'http', host: '127.0.0.1', port: upstreamPort, ...credentials,
  });
  t.after(() => bridge.close());
  const localPort = Number(new URL(bridge.proxyServer).port);

  const response = await makeLocalRequest(localPort, {
    method: 'POST',
    path: 'http://target.example/path?item=1',
    headers: { host: 'target.example', 'content-type': 'text/plain' },
  }, 'request-body');

  assert.deepEqual(response, { statusCode: 200, body: 'proxied' });
  assert.deepEqual(observed, {
    authorization,
    host: 'target.example',
    method: 'POST',
    path: 'http://target.example/path?item=1',
    body: 'request-body',
  });
});

test('proxy auth bridge authenticates CONNECT then relays the encrypted-target tunnel', async (t) => {
  let observedAuthorization = '';
  const upstreamSockets = new Set();
  const upstream = http.createServer();
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  upstream.on('connect', (request, socket) => {
    observedAuthorization = request.headers['proxy-authorization'];
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startProxyAuthBridge({
    protocol: 'http', host: '127.0.0.1', port: upstreamPort, ...credentials,
  });

  const localPort = Number(new URL(bridge.proxyServer).port);
  const client = net.connect(localPort, '127.0.0.1');
  t.after(async () => {
    client.destroy();
    await bridge.close();
    for (const socket of upstreamSockets) socket.destroy();
    await close(upstream);
  });
  const result = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let tunnelReady = false;
    const timer = setTimeout(() => reject(new Error('CONNECT tunnel test timed out')), 3000);
    client.on('error', reject);
    client.on('connect', () => client.write('CONNECT secure.example:443 HTTP/1.1\r\nHost: secure.example:443\r\n\r\n'));
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (!tunnelReady && headerEnd >= 0) {
        const header = buffer.subarray(0, headerEnd).toString('latin1');
        assert.match(header, /^HTTP\/1\.1 200 Connection Established/);
        buffer = buffer.subarray(headerEnd + 4);
        tunnelReady = true;
        client.write('tunnel-check');
      }
      if (tunnelReady && buffer.includes('tunnel-check')) {
        clearTimeout(timer);
        resolve(buffer.toString('utf8'));
      }
    });
  });

  assert.equal(result, 'tunnel-check');
  assert.equal(observedAuthorization, authorization);
});

test('proxy auth failures return sanitized HTTP and CONNECT responses', async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(407, { 'proxy-authenticate': `Basic realm="${credentials.password}"` });
    response.end(credentials.password);
  });
  upstream.on('connect', (_request, socket) => {
    socket.end(`HTTP/1.1 407 ${credentials.password}\r\nProxy-Authenticate: Basic realm="${credentials.password}"\r\n\r\n`);
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startProxyAuthBridge({
    protocol: 'http', host: '127.0.0.1', port: upstreamPort, ...credentials,
  });
  const localPort = Number(new URL(bridge.proxyServer).port);
  let client;
  t.after(async () => {
    client?.destroy();
    await bridge.close();
    await close(upstream);
  });

  const httpResponse = await makeLocalRequest(localPort, {
    method: 'GET', path: 'http://target.example/', headers: { host: 'target.example' },
  });
  const connectResponse = await new Promise((resolve, reject) => {
    const chunks = [];
    client = net.connect(localPort, '127.0.0.1');
    client.on('error', reject);
    client.on('data', (chunk) => chunks.push(chunk));
    client.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    client.on('connect', () => client.write('CONNECT target.example:443 HTTP/1.1\r\nHost: target.example:443\r\n\r\n'));
  });

  assert.deepEqual(httpResponse, { statusCode: 407, body: 'Proxy authentication failed' });
  assert.doesNotMatch(httpResponse.body, /private-password/);
  assert.match(connectResponse, /^HTTP\/1\.1 407 Proxy Authentication Required/);
  assert.doesNotMatch(connectResponse, /private-password/);
});

test('proxy auth bridge forwards HTTP over SOCKS5 username/password authentication', async (t) => {
  const upstream = createSocks5AuthProxy(credentials);
  const upstreamPort = await listen(upstream.server);
  const bridge = await startProxyAuthBridge({
    protocol: 'socks5', host: '127.0.0.1', port: upstreamPort, ...credentials,
  });
  t.after(async () => {
    await bridge.close();
    await upstream.close();
  });

  const response = await makeLocalRequest(Number(new URL(bridge.proxyServer).port), {
    method: 'GET',
    path: 'http://target.example/path?item=1',
    headers: { host: 'target.example' },
  });

  assert.deepEqual(response, { statusCode: 200, body: 'ok' });
  assert.equal(upstream.state.username, credentials.username);
  assert.equal(upstream.state.password, credentials.password);
  assert.match(upstream.state.request, /^GET \/path\?item=1 HTTP\/1\.1/);
  assert.doesNotMatch(upstream.state.request, /proxy-authorization/i);
});

test('proxy auth bridge reports SOCKS5 credential rejection without forwarding secrets', async (t) => {
  const upstream = createSocks5AuthProxy(credentials);
  const upstreamPort = await listen(upstream.server);
  const bridge = await startProxyAuthBridge({
    protocol: 'socks5', host: '127.0.0.1', port: upstreamPort,
    username: credentials.username, password: 'wrong-password',
  });
  t.after(async () => {
    await bridge.close();
    await upstream.close();
  });

  const response = await makeLocalRequest(Number(new URL(bridge.proxyServer).port), {
    method: 'GET', path: 'http://target.example/', headers: { host: 'target.example' },
  });

  assert.deepEqual(response, { statusCode: 502, body: 'Proxy upstream unavailable' });
  assert.equal(upstream.state.password, 'wrong-password');
  assert.doesNotMatch(response.body, /wrong-password|private-password/);
});

test('proxy auth bridge uses the SOCKS4 user ID field without inventing password support', async (t) => {
  const upstream = createSocks4UserProxy('legacy-user');
  const upstreamPort = await listen(upstream.server);
  const bridge = await startProxyAuthBridge({
    protocol: 'socks4', host: '127.0.0.1', port: upstreamPort,
    username: upstream.expectedUser,
  });
  t.after(async () => {
    await bridge.close();
    await upstream.close();
  });

  const response = await makeLocalRequest(Number(new URL(bridge.proxyServer).port), {
    method: 'GET', path: 'http://target.example/path', headers: { host: 'target.example' },
  });

  assert.deepEqual(response, { statusCode: 200, body: 'ok' });
  assert.equal(upstream.state.userId, upstream.expectedUser);
  assert.equal(upstream.state.target, 'target.example');
  assert.match(upstream.state.request, /^GET \/path HTTP\/1\.1/);
  assert.doesNotMatch(upstream.state.request, /proxy-authorization/i);
});

test('proxy auth bridge relays CONNECT tunnels over SOCKS4', async (t) => {
  const upstream = createSocks4TunnelProxy();
  const upstreamPort = await listen(upstream.server);
  const bridge = await startProxyAuthBridge({
    protocol: 'socks4', host: '127.0.0.1', port: upstreamPort, username: 'legacy-user',
  });
  const client = net.connect(Number(new URL(bridge.proxyServer).port), '127.0.0.1');
  t.after(async () => {
    client.destroy();
    await bridge.close();
    await upstream.close();
  });
  const response = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let tunnelReady = false;
    const timer = setTimeout(() => reject(new Error('SOCKS4 CONNECT test timed out')), 3000);
    client.on('error', reject);
    client.on('connect', () => client.write(
      'CONNECT secure.example:443 HTTP/1.1\r\nHost: secure.example:443\r\n\r\n',
    ));
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!tunnelReady) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        assert.match(buffer.subarray(0, headerEnd).toString('latin1'), /^HTTP\/1\.1 200 Connection Established/);
        buffer = buffer.subarray(headerEnd + 4);
        tunnelReady = true;
        client.write('tunnel-check');
      }
      if (tunnelReady && buffer.includes(Buffer.from('tunnel-check'))) {
        clearTimeout(timer);
        resolve(buffer.toString('utf8'));
      }
    });
  });

  assert.equal(response, 'tunnel-check');
  assert.deepEqual(upstream.state, { userId: 'legacy-user', target: 'secure.example', port: 443 });
});

test('proxy auth bridge rejects SOCKS4 password authentication without exposing credentials', async () => {
  await assert.rejects(
    startProxyAuthBridge({ protocol: 'socks4', host: '127.0.0.1', port: 1080, ...credentials }),
    (error) => {
      assert.equal(error.code, 'PROXY_AUTH_BRIDGE_CREDENTIALS_UNSUPPORTED');
      assert.doesNotMatch(error.message, /route-user|private-password/);
      return true;
    },
  );
});
