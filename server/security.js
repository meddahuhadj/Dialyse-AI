'use strict';

// Phase 4 — transport hardening: security headers + optional HTTPS.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const CERT_DIR = process.env.HADJ_CERT_DIR || path.join(__dirname, 'certs');

/** Express middleware: baseline security headers. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  // NOTE: a strict Content-Security-Policy is deferred — the single-file front-end
  // relies on inline <script>/<style> and esm.sh + Google Fonts. Tightening it
  // (nonces / hashes / self-hosting) is tracked in SECURITY.md.
  next();
}

/**
 * Create an HTTP or HTTPS server for `app`.
 * HTTPS is used when certs/key.pem + certs/cert.pem exist (see scripts/gen-cert.*).
 * Returns { server, protocol }.
 */
function createServer(app) {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      app
    );
    return { server, protocol: 'https' };
  }
  return { server: http.createServer(app), protocol: 'http' };
}

module.exports = { securityHeaders, createServer, CERT_DIR };
