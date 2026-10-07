#!/usr/bin/env node
// minimax-code-proxy — turn a logged-in MiniMax Code account into a local
// Anthropic-compatible endpoint.
//
// Bridges Anthropic Messages clients (Claude Code, any Anthropic SDK app) to the
// managed gateway used by MiniMax Code, reusing the OAuth login state stored by
// MiniMax Code in ~/.minimax/auth/. The access token lives ~1h and every refresh
// rotates the refresh token, so the credential file is the single source of
// truth: this proxy writes refreshed tokens back to it, and the MiniMax Code app
// keeps working unchanged.
//
// Unofficial community tool, not affiliated with MiniMax or Anthropic.
// Use your own account, for personal use. See README for details.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || process.env.HOME || '';

// MiniMax Code stores its login under ~/.minimax/auth/prod/<region>/;
// `mcode login` (cn) writes prod/cn, `mcode login --region global` writes prod/en.
const REGION_PRESETS = {
  cn: {
    upstream: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
    oauthTokenEndpoint: 'https://account.minimax.cn/oauth2/token',
    authDir: 'prod/cn',
  },
  global: {
    upstream: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
    oauthTokenEndpoint: 'https://account.minimax.io/oauth2/token',
    authDir: 'prod/en',
  },
};

const BASE_DEFAULTS = {
  host: '127.0.0.1',
  port: 15722,
  region: 'cn',
  clientId: 'mcode-public',
  scope: 'agent.default',
  audience: 'agent-backend',
  models: ['MiniMax-M3.1-Flash-Preview', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
  defaultModel: 'MiniMax-M3',
  fastModel: 'MiniMax-M3.1-Flash-Preview',
  refreshSkewMs: 120000,
  maxBodyBytes: 64 * 1024 * 1024,
  logFile: path.join(HERE, 'proxy.log'),
};

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[config] ignoring config.json: ${err.message}`);
  }
  const preset = REGION_PRESETS[fileCfg.region] || REGION_PRESETS.cn;
  const home = HOME.replace(/\\/g, '/');
  return {
    ...BASE_DEFAULTS,
    upstream: preset.upstream,
    oauthTokenEndpoint: preset.oauthTokenEndpoint,
    authFile: `${home}/.minimax/auth/${preset.authDir}/mcode-public/auth.json`,
    stateFile: `${home}/.minimax/auth/${preset.authDir}/mcode-public/auth-state.json`,
    ...fileCfg,
  };
}

const CFG = loadConfig();

// ---------------------------------------------------------------- logging

let logStream = null;
try {
  if (fs.existsSync(CFG.logFile) && fs.statSync(CFG.logFile).size > 5 * 1024 * 1024) {
    fs.renameSync(CFG.logFile, `${CFG.logFile}.1`);
  }
  logStream = fs.createWriteStream(CFG.logFile, { flags: 'a' });
} catch (err) {
  console.error(`[log] file logging disabled: ${err.message}`);
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  logStream?.write(`${line}\n`);
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------ token store

class AuthError extends Error {}

let cache = { token: null, expiresAtMs: 0 };
let inFlightRefresh = null;

function readRecord() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CFG.authFile, 'utf8'));
  } catch (err) {
    throw new AuthError(`cannot read MiniMax credential file ${CFG.authFile}: ${err.message}`);
  }
  const key = Object.keys(data.records || {})[0];
  if (!key) throw new AuthError('credential file has no records; run `mcode login`');
  const rec = data.records[key];
  if (!rec.refreshToken) throw new AuthError('credential file has no refreshToken; run `mcode login`');
  return { data, key, rec };
}

async function exchangeRefreshToken(rec) {
  const res = await fetch(CFG.oauthTokenEndpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rec.refreshToken,
      client_id: CFG.clientId,
      scope: CFG.scope,
      audience: CFG.audience,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AuthError(`token refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const tok = JSON.parse(text);
  if (!tok.access_token || !(tok.expires_in > 0)) {
    throw new AuthError(`unexpected refresh response: ${text.slice(0, 300)}`);
  }
  return tok;
}

async function refreshAndPersist() {
  const { data, key, rec } = readRecord();
  const tok = await exchangeRefreshToken(rec);

  rec.accessToken = tok.access_token;
  if (tok.refresh_token) rec.refreshToken = tok.refresh_token;
  rec.expiresAtMs = Date.now() + tok.expires_in * 1000;
  rec.generation = (rec.generation || 0) + 1;
  data.records[key] = rec;
  atomicWrite(CFG.authFile, JSON.stringify(data, null, 2));

  // Keep the app's state file in sync so it does not treat the refreshed
  // credential as stale.
  try {
    const st = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    st.generation = rec.generation;
    st.expiresAtMs = rec.expiresAtMs;
    atomicWrite(CFG.stateFile, JSON.stringify(st, null, 2));
  } catch (err) {
    log(`[auth] state file not updated: ${err.message}`);
  }

  log(`[auth] refreshed; expires ${new Date(rec.expiresAtMs).toISOString()} gen=${rec.generation}`);
  return rec;
}

async function getToken({ force = false } = {}) {
  if (!force && cache.token && cache.expiresAtMs - Date.now() > CFG.refreshSkewMs) {
    return cache.token;
  }
  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      // Another MiniMax process may have refreshed while we were idle; prefer
      // its token over burning another rotation.
      try {
        const { rec } = readRecord();
        if (rec.expiresAtMs - Date.now() > CFG.refreshSkewMs) {
          cache = { token: rec.accessToken, expiresAtMs: rec.expiresAtMs };
          return rec.accessToken;
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
      }

      let rec;
      try {
        rec = await refreshAndPersist();
      } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        const { rec: current } = readRecord();
        if (current.expiresAtMs - Date.now() > 1000) {
          log('[auth] refresh raced another process; using the token it wrote');
          rec = current;
        } else {
          throw err;
        }
      }
      cache = { token: rec.accessToken, expiresAtMs: rec.expiresAtMs };
      return rec.accessToken;
    })().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

// ----------------------------------------------------------- model mapping

// Clients speak Claude model names; the MiniMax gateway only knows its own.
function resolveModel(requested) {
  if (!requested) return CFG.defaultModel;
  const exact = CFG.models.find((m) => m.toLowerCase() === String(requested).toLowerCase());
  if (exact) return exact;
  if (/haiku|flash|highspeed/i.test(requested)) return CFG.fastModel;
  return CFG.defaultModel;
}

const ACCOUNT_NAMES = {
  'MiniMax-M3': 'MiniMax M3',
  'MiniMax-M3.1-Flash-Preview': 'MiniMax M3.1 Flash Preview',
  'MiniMax-M2.7': 'MiniMax M2.7',
  'MiniMax-M2.7-highspeed': 'MiniMax M2.7 Highspeed',
};

// -------------------------------------------------------------- forwarding

const STRIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'authorization', 'x-api-key',
  'accept-encoding', 'user-agent',
]);
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > CFG.maxBodyBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message, type = 'api_error') {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

function buildUpstreamUrl(suffix, query) {
  const base = CFG.upstream.replace(/\/+$/, '');
  return `${base}${suffix}${query || ''}`;
}

// The request body is read once by the caller and handed in as `raw`, so the
// 401 retry below can resend it (an IncomingMessage cannot be re-read).
async function forward(req, res, suffix, { mapModel, token, raw, retried = false }) {
  let payload = null;
  if (mapModel && raw.length) {
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(res, 400, 'request body is not valid JSON', 'invalid_request_error');
    }
    const requested = payload.model;
    payload.model = resolveModel(requested);
    lastModel = { requested: requested ?? null, resolved: payload.model };
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['authorization'] = `Bearer ${token}`;
  headers['x-api-key'] = 'sk-xxx'; // mcode's placeholder; the gateway ignores it
  headers['user-agent'] = 'MiniMaxAgent';
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';

  const upstreamRes = await fetch(buildUpstreamUrl(suffix, req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), {
    method: req.method,
    headers,
    body: payload ? JSON.stringify(payload) : raw,
  });

  if (upstreamRes.status === 401 && !retried) {
    await upstreamRes.body?.cancel();
    log('[proxy] upstream 401; forcing token refresh and retrying once');
    const fresh = await getToken({ force: true });
    return forward(req, res, suffix, { mapModel, token: fresh, raw, retried: true });
  }

  const outHeaders = {};
  for (const [k, v] of upstreamRes.headers) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
  }
  res.writeHead(upstreamRes.status, outHeaders);
  res.flushHeaders?.();
  if (upstreamRes.body) {
    await new Promise((resolve, reject) => {
      const src = Readable.fromWeb(upstreamRes.body);
      src.pipe(res);
      src.on('end', resolve);
      src.on('error', reject);
      res.on('close', () => src.destroy());
    });
  } else {
    res.end();
  }
}

// ------------------------------------------------------------------ router

let lastModel = null;

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

  if (url === '/health' || url === '/') {
    let auth = { ok: false };
    try {
      const { rec } = readRecord();
      auth = {
        ok: true,
        expiresAt: new Date(rec.expiresAtMs).toISOString(),
        secondsLeft: Math.round((rec.expiresAtMs - Date.now()) / 1000),
        generation: rec.generation,
      };
    } catch (err) {
      auth = { ok: false, error: err.message };
    }
    return sendJson(res, 200, {
      status: 'ok',
      upstream: CFG.upstream,
      region: CFG.region,
      defaultModel: CFG.defaultModel,
      models: CFG.models,
      lastRequestedModel: lastModel,
      auth,
    });
  }

  if (url === '/v1/models') {
    const now = new Date().toISOString();
    return sendJson(res, 200, {
      data: CFG.models.map((id) => ({ type: 'model', id, display_name: ACCOUNT_NAMES[id] || id, created_at: now })),
      has_more: false,
      first_id: CFG.models[0],
      last_id: CFG.models[CFG.models.length - 1],
    });
  }

  const isMessages = url.endsWith('/v1/messages') || url === '/messages';
  const isCountTokens = url.endsWith('/v1/messages/count_tokens') || url === '/messages/count_tokens';

  if (req.method !== 'POST' || (!isMessages && !isCountTokens)) {
    return sendError(res, 404, `no route for ${req.method} ${req.url}`, 'not_found_error');
  }

  try {
    const token = await getToken();
    const raw = await readBody(req);
    await forward(req, res, isCountTokens ? '/messages/count_tokens' : '/messages', {
      mapModel: true,
      token,
      raw,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      log(`[proxy] auth error: ${err.message}`);
      return sendError(res, 401, err.message, 'authentication_error');
    }
    log(`[proxy] error: ${err.stack || err.message}`);
    if (!res.headersSent) sendError(res, 502, `proxy error: ${err.message}`);
    else res.end();
  }
});

server.listen(CFG.port, CFG.host, () => {
  log(`[boot] MiniMax -> Anthropic gateway on http://${CFG.host}:${CFG.port} (region=${CFG.region})`);
  log(`[boot] upstream=${CFG.upstream} models=${CFG.models.join(',')}`);
  log(`[boot] credential=${CFG.authFile}`);
});

server.on('error', (err) => {
  log(`[fatal] ${err.stack || err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`[exit] ${sig}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
