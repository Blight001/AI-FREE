'use strict';

const net = require('net');

function readSocketBytes(socket, byteCount, bridgeError) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', read);
      socket.off('error', fail);
      socket.off('end', fail);
      socket.off('close', fail);
    };
    const fail = () => {
      cleanup();
      reject(bridgeError('PROXY_UPSTREAM_UNAVAILABLE', '代理连接失败'));
    };
    const read = () => {
      const value = socket.read(byteCount);
      if (!value) return;
      cleanup();
      resolve(value);
    };
    socket.on('readable', read);
    socket.once('error', fail);
    socket.once('end', fail);
    socket.once('close', fail);
    read();
  });
}

async function negotiateSocks5(socket, proxy, host, port, bridgeError) {
  socket.write(Buffer.from([5, 1, 2]));
  const greeting = await readSocketBytes(socket, 2, bridgeError);
  if (greeting[0] !== 5 || greeting[1] !== 2) {
    throw bridgeError('PROXY_UPSTREAM_AUTH_FAILED', 'SOCKS5 代理未接受用户名密码认证');
  }
  const username = Buffer.from(proxy.username);
  const password = Buffer.from(proxy.password);
  socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
  const authentication = await readSocketBytes(socket, 2, bridgeError);
  if (authentication[0] !== 1 || authentication[1] !== 0) {
    throw bridgeError('PROXY_UPSTREAM_AUTH_FAILED', 'SOCKS5 代理认证失败');
  }
  const destination = Buffer.from(host.replace(/^\[|\]$/g, ''));
  if (destination.length > 255) throw bridgeError('PROXY_TARGET_INVALID', '代理目标主机无效');
  const targetPort = Buffer.alloc(2);
  targetPort.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, destination.length]), destination, targetPort]));
  const reply = await readSocketBytes(socket, 4, bridgeError);
  if (reply[0] !== 5 || reply[1] !== 0) throw bridgeError('PROXY_UPSTREAM_CONNECT_FAILED', 'SOCKS5 代理连接目标失败');
  const addressSize = reply[3] === 1 ? 4 : reply[3] === 4 ? 16
    : reply[3] === 3 ? (await readSocketBytes(socket, 1, bridgeError))[0] : 0;
  if (!addressSize) throw bridgeError('PROXY_UPSTREAM_RESPONSE_INVALID', 'SOCKS5 代理响应无效');
  await readSocketBytes(socket, addressSize + 2, bridgeError);
}

async function openSocks5Tunnel(proxy, host, port, trackSocket, bridgeError, timeoutMs) {
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  trackSocket(socket);
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  timer.unref?.();
  try {
    await negotiateSocks5(socket, proxy, host, port, bridgeError);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function openSocks4Tunnel(proxy, host, port, trackSocket, bridgeError, timeoutMs) {
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  trackSocket(socket);
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  timer.unref?.();
  try {
    const destination = Buffer.from(host.replace(/^\[|\]$/g, ''));
    const userId = Buffer.from(proxy.username);
    if (destination.length > 255) throw bridgeError('PROXY_TARGET_INVALID', 'SOCKS4 代理目标主机无效');
    const targetPort = Buffer.alloc(2);
    targetPort.writeUInt16BE(port);
    socket.write(Buffer.concat([
      Buffer.from([4, 1]), targetPort, Buffer.from([0, 0, 0, 1]), userId, Buffer.from([0]), destination, Buffer.from([0]),
    ]));
    const reply = await readSocketBytes(socket, 8, bridgeError);
    if (reply[0] !== 0 || reply[1] !== 90) {
      throw bridgeError('PROXY_UPSTREAM_CONNECT_FAILED', 'SOCKS4 代理连接目标失败');
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openSocksTunnel(proxy, host, port, trackSocket, bridgeError, timeoutMs) {
  return proxy.protocol === 'socks4'
    ? openSocks4Tunnel(proxy, host, port, trackSocket, bridgeError, timeoutMs)
    : openSocks5Tunnel(proxy, host, port, trackSocket, bridgeError, timeoutMs);
}

module.exports = { openSocksTunnel };
