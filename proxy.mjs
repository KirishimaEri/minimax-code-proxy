#!/usr/bin/env node
// minimax-code-proxy — turn logged-in MiniMax Code account(s) into a local
// Anthropic-compatible endpoint.
//
// Bridges Anthropic Messages clients (Claude Code, any Anthropic SDK app) to the
// managed gateway used by MiniMax Code, reusing the OAuth login state stored by
// MiniMax Code in ~/.minimax/auth/. The access token lives ~1h and every refresh
// rotates the refresh token, so the credential file is the single source of
// truth: this proxy writes refreshed tokens back to it, and the MiniMax Code app
// keeps working unchanged.
//
// Extras over a plain bridge:
// - multiple accounts (separate MiniMax Code data dirs) with round-robin
//   rotation and 401/429 failover;
// - daily check-in (the same claim the mcode client's /checkin command makes),
//   run automatically per account once a day, plus a manual POST /checkin.
//
// Unofficial community tool, not affiliated with MiniMax or Anthropic.
// Use your own accounts, for personal use. See README for details.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const MCODE_VERSION = '0.6.3'; // reported as desktop_version in check-in queries

// MiniMax Code stores its login under ~/.minimax/auth/prod/<region>/;
// `mcode login` (cn) writes prod/cn, `mcode login --region global` writes prod/en.
// `mcode --profile <name> login` writes to ~/.minimax-<name> instead.
const REGION_PRESETS = {
  cn: {
    upstream: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
    oauthTokenEndpoint: 'https://account.minimax.cn/oauth2/token',
    signinOrigin: 'https://agent.minimaxi.com',
    authDir: 'prod/cn',
    lang: 'zh',
  },
  global: {
    upstream: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
    oauthTokenEndpoint: 'https://account.minimax.io/oauth2/token',
    signinOrigin: 'https://agent.minimax.io',
    authDir: 'prod/en',
    lang: 'en',
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
  checkin: { enabled: false, intervalMinutes: 30 },
};

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[config] ignoring config.json: ${err.message}`);
  }
  const checkin = { ...BASE_DEFAULTS.checkin, ...(fileCfg.checkin || {}) };
  return { ...BASE_DEFAULTS, ...fileCfg, checkin };
}

const CFG = loadConfig();

function makeAccount(a, index) {
  const region = a.region || CFG.region;
  const preset = REGION_PRESETS[region] || REGION_PRESETS.cn;
  const dataDir = String(a.dataDir || `${HOME}/.minimax`).replace(/\\/g, '/').replace(/\/+$/, '');
  const credBase = `${dataDir}/auth/${preset.authDir}/mcode-public`;
  return {
    label: a.label || `account-${index + 1}`,
    region,
    upstream: preset.upstream,
    oauthTokenEndpoint: preset.oauthTokenEndpoint,
    signinOrigin: preset.signinOrigin,
    lang: preset.lang,
    authFile: a.authFile || `${credBase}/auth.json`,
    stateFile: a.stateFile || `${credBase}/auth-state.json`,
    identityFile: `${dataDir}/cli-auth/${preset.authDir}/account-identity.json`,
    userId: a.userId || '',
    cache: { token: null, expiresAtMs: 0 },
    inFlight: null,
    served: 0,
  };
}

// One entry per MiniMax Code login. With no `accounts` in config, the default
// data dir is used — identical to single-account behaviour.
const ACCOUNTS = (Array.isArray(CFG.accounts) && CFG.accounts.length ? CFG.accounts : [{}])
  .map(makeAccount);

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

function readRecord(acc) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(acc.authFile, 'utf8'));
  } catch (err) {
    throw new AuthError(`cannot read MiniMax credential file ${acc.authFile}: ${err.message}`);
  }
  const key = Object.keys(data.records || {})[0];
  if (!key) throw new AuthError('credential file has no records; run `mcode login`');
  const rec = data.records[key];
  if (!rec.refreshToken) throw new AuthError('credential file has no refreshToken; run `mcode login`');
  return { data, key, rec };
}

async function exchangeRefreshToken(acc, rec) {
  const res = await fetch(acc.oauthTokenEndpoint, {
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

async function refreshAndPersist(acc) {
  const { data, key, rec } = readRecord(acc);
  const tok = await exchangeRefreshToken(acc, rec);

  rec.accessToken = tok.access_token;
  if (tok.refresh_token) rec.refreshToken = tok.refresh_token;
  rec.expiresAtMs = Date.now() + tok.expires_in * 1000;
  rec.generation = (rec.generation || 0) + 1;
  data.records[key] = rec;
  atomicWrite(acc.authFile, JSON.stringify(data, null, 2));

  // Keep the app's state file in sync so it does not treat the refreshed
  // credential as stale.
  try {
    const st = JSON.parse(fs.readFileSync(acc.stateFile, 'utf8'));
    st.generation = rec.generation;
    st.expiresAtMs = rec.expiresAtMs;
    atomicWrite(acc.stateFile, JSON.stringify(st, null, 2));
  } catch (err) {
    log(`[auth] ${acc.label}: state file not updated: ${err.message}`);
  }

  log(`[auth] ${acc.label}: refreshed; expires ${new Date(rec.expiresAtMs).toISOString()} gen=${rec.generation}`);
  return rec;
}

async function getToken(acc, { force = false } = {}) {
  if (!force && acc.cache.token && acc.cache.expiresAtMs - Date.now() > CFG.refreshSkewMs) {
    return acc.cache.token;
  }
  if (!acc.inFlight) {
    acc.inFlight = (async () => {
      // Another MiniMax process may have refreshed while we were idle; prefer
      // its token over burning another rotation.
      try {
        const { rec } = readRecord(acc);
        if (rec.expiresAtMs - Date.now() > CFG.refreshSkewMs) {
          acc.cache = { token: rec.accessToken, expiresAtMs: rec.expiresAtMs };
          return rec.accessToken;
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
      }

      let rec;
      try {
        rec = await refreshAndPersist(acc);
      } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        const { rec: current } = readRecord(acc);
        if (current.expiresAtMs - Date.now() > 1000) {
          log(`[auth] ${acc.label}: refresh raced another process; using the token it wrote`);
          rec = current;
        } else {
          throw err;
        }
      }
      acc.cache = { token: rec.accessToken, expiresAtMs: rec.expiresAtMs };
      return rec.accessToken;
    })().finally(() => {
      acc.inFlight = null;
    });
  }
  return acc.inFlight;
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

function buildUpstreamUrl(acc, suffix, query) {
  const base = acc.upstream.replace(/\/+$/, '');
  return `${base}${suffix}${query || ''}`;
}

function requestHeaders(req, token) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['authorization'] = `Bearer ${token}`;
  headers['x-api-key'] = 'sk-xxx'; // mcode's placeholder; the gateway ignores it
  headers['user-agent'] = 'MiniMaxAgent';
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
  return headers;
}

async function drainBody(upstream) {
  try {
    await upstream.body?.cancel();
  } catch {}
}

async function pipeResponse(res, upstream) {
  const outHeaders = {};
  for (const [k, v] of upstream.headers) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
  }
  res.writeHead(upstream.status, outHeaders);
  res.flushHeaders?.();
  if (upstream.body) {
    await new Promise((resolve, reject) => {
      const src = Readable.fromWeb(upstream.body);
      src.pipe(res);
      src.on('end', resolve);
      src.on('error', reject);
      res.on('close', () => src.destroy());
    });
  } else {
    res.end();
  }
}

// Round-robin across accounts; on 401 (after a forced refresh) or 429 the same
// request is retried on the next account. The body is read once by the caller
// and handed in as `raw` (an IncomingMessage cannot be re-read).
let rrIndex = 0;

async function relay(req, res, suffix, raw, payload) {
  const n = ACCOUNTS.length;
  const start = rrIndex;
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  for (let off = 0; off < n; off++) {
    const acc = ACCOUNTS[(start + off) % n];
    let token = await getToken(acc);

    for (let retry = 0; retry < 2; retry++) {
      if (retry > 0) token = await getToken(acc, { force: true });
      const upstream = await fetch(buildUpstreamUrl(acc, suffix, query), {
        method: req.method,
        headers: requestHeaders(req, token),
        body: payload ? JSON.stringify(payload) : raw,
      });
      const status = upstream.status;

      if (status === 401 && retry === 0) {
        await drainBody(upstream);
        log(`[proxy] ${acc.label}: upstream 401; forcing token refresh and retrying`);
        continue;
      }
      if ((status === 401 || status === 429) && off < n - 1) {
        await drainBody(upstream);
        log(`[proxy] ${acc.label}: upstream ${status}; rotating to next account`);
        break;
      }

      rrIndex = (start + off + 1) % n;
      acc.served += 1;
      await pipeResponse(res, upstream);
      return;
    }
  }
}

// ---------------------------------------------------------------- check-in

// Same endpoints and headers the mcode client's /checkin command uses
// (packages/tui/src/checkin/ in the open-source repo). The yy / x-signature
// headers are client-attribution constants from that client, not credentials.
const md5hex = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function readUserId(acc) {
  if (acc.userId) return acc.userId;
  try {
    const id = JSON.parse(fs.readFileSync(acc.identityFile, 'utf8'));
    for (const k of ['realUserID', 'real_user_id', 'userId']) {
      if (id[k]) return String(id[k]);
    }
  } catch {}
  return '0';
}

function signinQuery(acc, nowMs) {
  const tzOffsetSeconds = String(-(new Date().getTimezoneOffset()) * 60);
  const entries = [
    ['app_id', '3001'],
    ['biz_id', '3'],
    ['browser_name', 'mcode'],
    ['client', 'mcode'],
    ['device_id', '0'],
    ['device_platform', 'web'],
    ['desktop_version', MCODE_VERSION],
    ['is_desktop', '1'],
    ['lang', acc.lang],
    ['os_name', process.platform],
    ['sys_language', acc.lang],
    ['timezone_offset', tzOffsetSeconds],
    ['unix', String(nowMs)],
    ['user_id', readUserId(acc)],
    ['version_code', '22201'],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const q = new URLSearchParams();
  for (const [k, v] of entries) q.append(k, v);
  return q.toString();
}

async function signinFetch(acc, method, pathWithQueryPath) {
  const token = await getToken(acc);
  const nowMs = Date.now();
  const sec = Math.floor(nowMs / 1000);
  const pathWithSearch = `${pathWithQueryPath}?${signinQuery(acc, nowMs)}`;
  const body = method === 'POST' ? '{}' : '';
  return fetch(`${acc.signinOrigin}${pathWithSearch}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'MiniMaxCode',
      authorization: `Bearer ${token}`,
      yy: md5hex(`${encodeURIComponent(pathWithSearch)}_{}${md5hex(String(nowMs))}ooui`),
      'x-timestamp': String(sec),
      'x-signature': md5hex(`${sec}I*7Cf%WZ#S&%1RlZJ&C2${body}`),
    },
    body: method === 'POST' ? '{}' : undefined,
  });
}

async function checkinAccount(acc) {
  try {
    const stRes = await signinFetch(acc, 'GET', '/minimax-cloud/api/v1/signin/status');
    const stText = await stRes.text();
    if (!stRes.ok) return { status: 'error', detail: `status HTTP ${stRes.status}: ${stText.slice(0, 200)}` };
    const st = JSON.parse(stText);
    if (st.base_resp?.status_code !== 0) {
      return { status: 'error', detail: `status base_resp ${st.base_resp?.status_code}: ${st.base_resp?.status_msg}` };
    }
    const today = (st.data?.panel?.days || []).find((d) => d.is_today);
    if (!today) {
      const hint = readUserId(acc) === '0'
        ? ' (hint: set accounts[].userId — the panel is empty without a real user id)'
        : '';
      return { status: 'not-available', detail: `panel has no is_today entry${hint}` };
    }
    if (today.status !== 2) {
      // 1=upcoming, 3=claimed, 4=disabled
      return { status: today.status === 3 ? 'already' : 'not-claimable', detail: `cycle day ${today.day_no}, status ${today.status}` };
    }

    const claimRes = await signinFetch(acc, 'POST', '/minimax-cloud/api/v1/signin/claim');
    const claimText = await claimRes.text();
    if (!claimRes.ok) return { status: 'error', detail: `claim HTTP ${claimRes.status}: ${claimText.slice(0, 200)}` };
    const cl = JSON.parse(claimText);
    if (cl.base_resp?.status_code !== 0) {
      return { status: 'error', detail: `claim base_resp ${cl.base_resp?.status_code}: ${cl.base_resp?.status_msg}` };
    }
    const d = cl.data || {};
    return {
      status: d.claim_result === 2 ? 'already' : 'claimed',
      day: d.day_no,
      points: d.points,
      expireAt: d.expire_at_ms ? new Date(d.expire_at_ms).toISOString() : undefined,
    };
  } catch (err) {
    return { status: 'error', detail: err.message };
  }
}

const CHECKIN_STATE_FILE = path.join(HERE, 'checkin-state.json');

function loadCheckinState() {
  try {
    return JSON.parse(fs.readFileSync(CHECKIN_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
let checkinState = loadCheckinState();

function saveCheckinState() {
  try {
    atomicWrite(CHECKIN_STATE_FILE, JSON.stringify(checkinState, null, 2));
  } catch (err) {
    log(`[checkin] state not saved: ${err.message}`);
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function runDueCheckins(reason) {
  if (!CFG.checkin.enabled) return;
  const today = todayStr();
  for (const acc of ACCOUNTS) {
    if (checkinState[acc.label]?.lastDate === today) continue;
    log(`[checkin] ${acc.label}: running (${reason})`);
    const result = await checkinAccount(acc);
    if (result.status === 'error') {
      // Transient failures retry on the next timer tick.
      checkinState[acc.label] = { ...(checkinState[acc.label] || {}), lastError: result.detail, lastErrorAt: new Date().toISOString() };
    } else {
      checkinState[acc.label] = { lastDate: today, ...result, at: new Date().toISOString() };
    }
    saveCheckinState();
    log(`[checkin] ${acc.label}: ${JSON.stringify(result)}`);
  }
}

async function runManualCheckin() {
  const results = {};
  for (const acc of ACCOUNTS) {
    const result = await checkinAccount(acc);
    if (result.status !== 'error') {
      checkinState[acc.label] = { lastDate: todayStr(), ...result, at: new Date().toISOString() };
    } else {
      checkinState[acc.label] = { ...(checkinState[acc.label] || {}), lastError: result.detail, lastErrorAt: new Date().toISOString() };
    }
    results[acc.label] = result;
  }
  saveCheckinState();
  return results;
}

// ------------------------------------------------------------------ router

let lastModel = null;

function accountHealth(acc) {
  let auth = { ok: false };
  try {
    const { rec } = readRecord(acc);
    auth = {
      ok: true,
      expiresAt: new Date(rec.expiresAtMs).toISOString(),
      secondsLeft: Math.round((rec.expiresAtMs - Date.now()) / 1000),
      generation: rec.generation,
    };
  } catch (err) {
    auth = { ok: false, error: err.message };
  }
  const ck = checkinState[acc.label] || {};
  return {
    label: acc.label,
    region: acc.region,
    served: acc.served,
    auth,
    checkin: CFG.checkin.enabled
      ? { lastDate: ck.lastDate || null, status: ck.status || null, points: ck.points ?? null, lastError: ck.lastError || null }
      : { enabled: false },
  };
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

  if (url === '/health' || url === '/') {
    return sendJson(res, 200, {
      status: 'ok',
      region: CFG.region,
      defaultModel: CFG.defaultModel,
      models: CFG.models,
      lastRequestedModel: lastModel,
      rotation: ACCOUNTS.length > 1 ? { strategy: 'round-robin', next: ACCOUNTS[rrIndex].label } : { strategy: 'single' },
      checkin: { enabled: CFG.checkin.enabled, intervalMinutes: CFG.checkin.intervalMinutes },
      accounts: ACCOUNTS.map(accountHealth),
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

  if (url === '/checkin' && req.method === 'POST') {
    const results = await runManualCheckin();
    return sendJson(res, 200, { results });
  }

  const isMessages = url.endsWith('/v1/messages') || url === '/messages';
  const isCountTokens = url.endsWith('/v1/messages/count_tokens') || url === '/messages/count_tokens';

  if (req.method !== 'POST' || (!isMessages && !isCountTokens)) {
    return sendError(res, 404, `no route for ${req.method} ${req.url}`, 'not_found_error');
  }

  try {
    const raw = await readBody(req);
    let payload = null;
    if (raw.length) {
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendError(res, 400, 'request body is not valid JSON', 'invalid_request_error');
      }
      const requested = payload.model;
      payload.model = resolveModel(requested);
      lastModel = { requested: requested ?? null, resolved: payload.model };
    }
    await relay(req, res, isCountTokens ? '/messages/count_tokens' : '/messages', raw, payload);
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
  log(`[boot] MiniMax -> Anthropic gateway on http://${CFG.host}:${CFG.port}`);
  log(`[boot] accounts=${ACCOUNTS.map((a) => a.label).join(',')} region=${CFG.region} checkin=${CFG.checkin.enabled ? 'on' : 'off'}`);
  for (const acc of ACCOUNTS) log(`[boot]   ${acc.label}: ${acc.authFile}`);
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

// Daily check-in scheduler: shortly after boot, then every interval.
if (CFG.checkin.enabled) {
  setTimeout(() => runDueCheckins('boot'), 5000).unref();
  setInterval(() => runDueCheckins('timer'), Math.max(5, CFG.checkin.intervalMinutes) * 60 * 1000).unref();
}
