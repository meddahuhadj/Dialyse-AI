'use strict';

// Gemini Live — server-side ephemeral token minting.
//
// The long-lived Gemini API key never leaves this server. The browser talks
// directly to Google's Live API WebSocket (for real low-latency audio), but
// authenticates with a short-lived EPHEMERAL TOKEN minted here, not the key.
// See: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
//
// If Google tweaks the exact model id, override it with GEMINI_LIVE_MODEL —
// no code change needed.

const secrets = require('./secrets');

const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com';
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025';

// How long the *session* stays open once started, and how long the client has
// to actually start that session after receiving the token (kept short — a
// token is single-purpose and shown to the browser).
const SESSION_LIFETIME_SEC = Number(process.env.GEMINI_LIVE_SESSION_SEC || 15 * 60); // 15 min call
const START_WINDOW_SEC = Number(process.env.GEMINI_LIVE_START_WINDOW_SEC || 60);     // 1 min to connect

function isConfigured() {
  return secrets.hasSecret('gemini_api_key');
}

/**
 * Mint a single-use ephemeral token scoped to the Live API + our model/config.
 * Throws with a safe (non-key-leaking) message on failure.
 */
async function mintEphemeralToken() {
  const apiKey = secrets.getSecret('gemini_api_key');
  if (!apiKey) {
    const err = new Error('Aucune clé Gemini configurée côté serveur');
    err.code = 'NO_KEY';
    throw err;
  }

  const now = Date.now();
  const body = {
    uses: 1,
    expireTime: new Date(now + SESSION_LIFETIME_SEC * 1000).toISOString(),
    newSessionExpireTime: new Date(now + START_WINDOW_SEC * 1000).toISOString(),
    // NOTE: Google's docs describe an optional `liveConnectConstraints` field to
    // pre-scope the token to one model/config. As of 2026-09-04 the live
    // v1beta/v1alpha auth_tokens endpoint rejects that field ("Unknown name
    // liveConnectConstraints") regardless of API version — confirmed by direct
    // testing, not just reading the docs. Omitted for now; the model and
    // response modality are instead declared by the client in the WebSocket
    // 'setup' message, which the protocol requires anyway. Re-add here if
    // Google's implementation catches up with its documentation.
  };

  let res;
  try {
    // v1alpha, not v1beta: confirmed against Google's own reference
    // implementation (google-gemini/gemini-live-api-examples,
    // gemini-live-ephemeral-tokens-websocket sample) that the token-creation
    // call AND the WebSocket endpoint below must both target v1alpha. A token
    // minted on v1beta connects to the plain BidiGenerateContent method but is
    // rejected by it ("Method doesn't allow unregistered callers") — that
    // method expects a full API key, not an ephemeral token. Ephemeral tokens
    // are meant for the *Constrained* RPC variant, which only exists on
    // v1alpha.
    res = await fetch(`${API_BASE}/v1alpha/auth_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const err = new Error(`Réseau Gemini injoignable : ${e.message}`);
    err.code = 'NETWORK';
    throw err;
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    const err = new Error(`Gemini a refusé la demande de jeton (HTTP ${res.status})${detail ? ' : ' + detail : ''}`);
    err.code = 'REJECTED';
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  // The AuthToken resource's `name` IS the bearer value for access_token/Authorization use.
  const token = data.name || data.token;
  if (!token) {
    const err = new Error("Réponse Gemini inattendue (jeton absent) — l'API a peut-être changé de format");
    err.code = 'BAD_RESPONSE';
    throw err;
  }

  return {
    accessToken: token,
    model: LIVE_MODEL,
    expiresAt: body.expireTime,
    startBy: body.newSessionExpireTime,
    // Browser connects directly to this WS endpoint with ?access_token=<accessToken>.
    // v1alpha + BidiGenerateContentConstrained (NOT v1beta + BidiGenerateContent):
    // the "Constrained" RPC is the one that accepts ephemeral-token auth.
    wsBase: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
  };
}

module.exports = { isConfigured, mintEphemeralToken, LIVE_MODEL };
