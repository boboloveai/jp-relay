#!/usr/bin/env node
/**
 * jp-relay on KamuiDash (Tokyo, 30-day trial).
 *
 * KamuiDash deploys only Node.js / Go / Python / Ruby apps from a GitHub
 * repo -- no Dockerfile, no arbitrary binary entry. So this repo is a
 * plain Node.js app (stdlib only, no dependencies) whose start script:
 *   1. downloads the official xray-core release at runtime if the binary
 *      is not already present (same Route-A runtime-wrapper pattern as
 *      DEPLOY_MEMORY.md),
 *   2. writes an xray config from env vars (XRAY_UUID, WS_PATH),
 *   3. starts xray listening on 127.0.0.1:XRAY_PORT (VLESS+WS),
 *   4. listens on 0.0.0.0:$PORT itself: answers 200 on / and /healthz
 *      (KamuiDash health check), and forwards WebSocket upgrades
 *      byte-for-byte to xray (xray alone answers plain GETs with 4xx,
 *      which would fail the deploy health check).
 *
 * KamuiDash settings (dashboard, from the official Node.js guide):
 *   Runtime: Web server / Node.js
 *   Repository + branch: this repo, main
 *   Setup: npm ci
 *   Start: npm run start
 *   Health check: /healthz
 *   Env vars (set in the dashboard, NEVER committed here):
 *     XRAY_UUID  - VLESS client UUID
 *     WS_PATH    - WebSocket path, e.g. /<random-hex>
 *   $PORT is supplied by the platform. TLS is terminated at the
 *   KamuiDash gateway, so xray sees plain WS internally.
 *
 * Trial limits (verified 2026-11-21): 256Mi RAM / 200m CPU / 500Mi disk,
 * 10 GiB outbound/month, always-on, Tokyo only, expiry = suspension
 * (not auto-billing) unless a card + auto-upgrade is registered.
 * Transport fallback per methodology: if the gateway breaks WS twice
 * (400 / disconnect after 101 / H2 downgrade), switch the xray inbound
 * to VLESS+XHTTP(packet-up) and lock ALPN -- do not keep retrying WS.
 */
'use strict';

const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const XRAY_PORT = Number(process.env.XRAY_PORT || 18000);
const UUID = process.env.XRAY_UUID || '';
const WS_PATH = process.env.WS_PATH || '';
const BIN_DIR = path.join(__dirname, 'xray-bin');
const XRAY_BIN = path.join(BIN_DIR, 'xray');
const XRAY_URL =
  'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';

if (!UUID) {
  console.error('XRAY_UUID is not set');
  process.exit(1);
}
if (!WS_PATH) {
  console.error('WS_PATH is not set');
  process.exit(1);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) return;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zip = path.join(BIN_DIR, 'xray.zip');
  console.log('downloading xray-core from official release...');
  // curl is present in the Node build image; unzip via python3 zipfile
  // as a fallback if the unzip binary is missing.
  await run('curl', ['-fsSL', '-o', zip, XRAY_URL]);
  try {
    await run('unzip', ['-o', zip, '-d', BIN_DIR]);
  } catch (_e) {
    await run('python3', ['-m', 'zipfile', '-e', zip, BIN_DIR]);
  }
  fs.chmodSync(XRAY_BIN, 0o755);
  fs.unlinkSync(zip);
  console.log('xray binary ready:', XRAY_BIN);
}

function writeConfig() {
  const dir = path.join(os.tmpdir(), 'xray');
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        port: XRAY_PORT,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: { clients: [{ id: UUID, flow: '' }], decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } },
      },
    ],
    outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  return cfgPath;
}

async function main() {
  await ensureXray();
  const cfgPath = writeConfig();
  const xray = spawn(XRAY_BIN, ['run', '-config', cfgPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  xray.on('exit', (code) => {
    console.error(`xray exited with code ${code}`);
    process.exit(1);
  });
  // Give xray a moment to bind before accepting traffic.
  await new Promise((r) => setTimeout(r, 2000));
  if (xray.exitCode !== null) {
    console.error('xray exited during startup');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    // Plain HTTP (health check, stray GETs): xray would answer 4xx,
    // so answer here. /healthz is the KamuiDash health-check path.
    const body = req.url === '/healthz' ? JSON.stringify({ ok: true }) : 'ok';
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });

  // WebSocket upgrade: forward the whole handshake + stream to xray.
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: XRAY_PORT }, () => {
      // Re-emit the original request line + headers, then the buffered head.
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`jp-relay listening on 0.0.0.0:${PORT}, forwarding WS ${WS_PATH} to xray on 127.0.0.1:${XRAY_PORT}`);
  });

  const shutdown = () => {
    try { xray.kill('SIGTERM'); } catch (_e) { /* already gone */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
