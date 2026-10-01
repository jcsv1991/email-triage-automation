// Preloaded into the n8n process with NODE_OPTIONS=--require. It sends connections that
// n8n would make to Google, Slack and Anthropic to the local fake servers instead,
// without root, /etc/hosts changes or any change to the workflow under test.
// TLS server-name stays the real host name, so the fake's certificate (signed by a
// throwaway CA that n8n is told to trust) is checked exactly as a real one would be.
'use strict';
const net = require('net');

const hosts = new Set((process.env.E2E_REDIRECT_HOSTS || '').split(',').filter(Boolean));
const fakePort = Number(process.env.E2E_FAKE_PORT || 0);

if (hosts.size > 0 && fakePort > 0) {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    // net passes either connect(options, cb) or one pre-normalized array [options, cb].
    const holder = Array.isArray(args[0]) ? args[0] : args;
    const first = holder[0];
    if (first && typeof first === 'object' && hosts.has(String(first.host).toLowerCase()) && Number(first.port) === 443) {
      holder[0] = { ...first, host: '127.0.0.1', port: fakePort };
    }
    return originalConnect.apply(this, args);
  };
}
