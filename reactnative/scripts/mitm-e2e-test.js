#!/usr/bin/env node
/**
 * End-to-end check of the HTTPS interception.
 *
 * Speaks the proxy protocol by hand so the bytes are exact:
 *
 *   TCP  -> 127.0.0.1:<proxyPort>            (use `adb forward tcp:15291 tcp:5291`)
 *   CONNECT <host>:443
 *   TLS  -> through the tunnel, trusting certs/auto366-ca.pem
 *   GET  -> plain HTTP inside the tunnel
 *
 * Usage:
 *   node scripts/mitm-e2e-test.js [--host fs.up366.cn] [--proxy 127.0.0.1:15291]
 *                                 [--path /] [--ca certs/auto366-ca.pem]
 *                                 [--expect <text>] [--body <bytes>]
 *
 * Exit code 0 means: CONNECT accepted, the MITM certificate verified against our
 * CA, and the upstream answered with an HTTP response. With `--expect`, the
 * response body must also contain the given text (used to verify that a rule
 * rewrote the response); with `--body`, the first N bytes of the body are
 * printed.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const host = arg('host', 'fs.up366.cn');
const requestPath = arg('path', '/');
const caFile = path.resolve(arg('ca', path.join(__dirname, '..', 'certs', 'auto366-ca.pem')));
const [proxyHost, proxyPort] = arg('proxy', '127.0.0.1:15291').split(':');
const timeoutMs = Number(arg('timeout', '15000'));
const expectedText = arg('expect', '');
const bodyBytes = Number(arg('body', '0'));

const ca = fs.readFileSync(caFile);

let finished = false;
function done(code, message) {
  if (finished) {
    return;
  }
  finished = true;
  process.stdout.write(`${message}\n`);
  process.exit(code);
}

const timer = setTimeout(() => {
  done(2, 'FAIL: 超时（CONNECT / TLS 握手 / 上游响应没有完成）');
}, timeoutMs);

const socket = net.connect(Number(proxyPort), proxyHost, () => {
  socket.write(
    `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`,
  );
});

let connectBuffer = '';
socket.on('data', onConnectResponse);
socket.on('error', error => done(2, `FAIL: 代理连接出错: ${error.message}`));
socket.on('close', () => done(2, 'FAIL: 代理在 CONNECT 之后关闭了连接'));

function onConnectResponse(chunk) {
  connectBuffer += chunk.toString('latin1');
  const end = connectBuffer.indexOf('\r\n\r\n');
  if (end === -1) {
    return;
  }
  socket.removeListener('data', onConnectResponse);
  const statusLine = connectBuffer.slice(0, connectBuffer.indexOf('\r\n'));
  if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
    done(2, `FAIL: CONNECT 被拒绝: ${statusLine}`);
    return;
  }
  process.stdout.write(`OK: ${statusLine}\n`);

  const secure = tls.connect(
    {
      socket,
      servername: host,
      ca,
      rejectUnauthorized: true,
    },
    () => {
      process.stdout.write(
        `OK: TLS 握手完成 (${secure.getProtocol()}, 证书 CN=${
          secure.getPeerCertificate()?.subject?.CN ?? '?'
        })\n`,
      );
      secure.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          'Accept: */*\r\n' +
          'Connection: close\r\n\r\n',
      );
    },
  );

  let response = Buffer.alloc(0);
  secure.on('data', data => {
    response = Buffer.concat([response, data]);
  });
  secure.on('end', () => {
    const text = response.toString('latin1');
    const firstLine = text.split('\r\n')[0] || '(空)';
    if (!/^HTTP\/1\.[01] \d{3}/.test(firstLine)) {
      done(2, `FAIL: 上游没有返回 HTTP 响应: ${JSON.stringify(text.slice(0, 120))}`);
      return;
    }
    process.stdout.write(`OK: 上游响应 ${firstLine}\n`);

    const separator = response.indexOf('\r\n\r\n');
    const body =
      separator === -1 ? Buffer.alloc(0) : response.subarray(separator + 4);
    if (bodyBytes > 0) {
      const size = Math.min(bodyBytes, body.length);
      process.stdout.write(
        `OK: 响应正文前 ${size} 字节:\n${body.subarray(0, size).toString('utf8')}\n`,
      );
    }
    if (expectedText && !body.toString('utf8').includes(expectedText)) {
      done(
        2,
        `FAIL: 响应正文不包含 ${JSON.stringify(expectedText)}（前 200 字节: ${JSON.stringify(
          body.subarray(0, 200).toString('utf8'),
        )}）`,
      );
      return;
    }

    clearTimeout(timer);
    done(0, `PASS: ${host}${requestPath} 经 HTTPS 中间人代理成功`);
  });
  secure.on('error', error => {
    done(2, `FAIL: TLS 出错: ${error.message}`);
  });
}
