'use strict';
/*
 * Shared helpers for the API routes (files starting with "_" are NOT routes).
 *  - tiny signed-cookie auth (admin / user roles)
 *  - GitHub Contents API storage (db.json + uploaded media on a data branch)
 */
const crypto = require('crypto');
const SEED = require('../public/seed.js');

const COOKIE = 'mw_session';
const MAX_FILE = 3 * 1024 * 1024; // Vercel functions accept ~4.5 MB bodies; base64 adds 33%
const CATS = ['pictures', 'videos', 'music', 'messages'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const httpError = (status, message) => new HttpError(status, message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- auth */

function accounts() {
  return [
    { name: process.env.ADMIN_USER || 'macky', pass: process.env.ADMIN_PASS || '1009', role: 'admin' },
    { name: process.env.USER_USER || 'Mark', pass: process.env.USER_PASS || 'mark', role: 'user' },
  ];
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }

function secret() {
  return process.env.SESSION_SECRET ||
    crypto.createHash('sha256').update('mw|' + (process.env.GITHUB_TOKEN || '') + '|' + (process.env.ADMIN_PASS || '1009')).digest('hex');
}

function checkLogin(username, password) {
  const u = String(username || '').trim().toLowerCase();
  const p = String(password || '');
  let found = null;
  for (const a of accounts()) {
    // evaluate every account so timing doesn't reveal which one matched
    const ok = safeEqual(a.name.toLowerCase(), u) && safeEqual(a.pass, p);
    if (ok) found = a;
  }
  return found ? { name: found.name, role: found.role } : null;
}

function signToken(user) {
  const payload = Buffer.from(JSON.stringify({ n: user.name, r: user.role, e: Date.now() + 30 * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!d.e || d.e < Date.now()) return null;
    if (d.r !== 'admin' && d.r !== 'user') return null;
    return { name: String(d.n), role: d.r };
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) { return verifyToken(parseCookies(req)[COOKIE]); }

function setSessionCookie(req, res, token) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(req, res) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

function requireSession(req, admin) {
  const s = getSession(req);
  if (!s) throw httpError(401, 'Please log in again.');
  if (admin && s.role !== 'admin') throw httpError(403, 'Only the admin can do this.');
  return s;
}

/* ---------------------------------------------------------------- http */

function send(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(obj);
}

function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error(e);
      send(res, status, { error: e instanceof HttpError ? e.message : 'Server error. Please try again.' });
    }
  };
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== 'object') throw httpError(400, 'Invalid request.');
  return b;
}

/* -------------------------------------------------------------- github */

function cfg() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    throw httpError(500, 'Server is not set up yet: add GITHUB_TOKEN and GITHUB_REPO in Vercel > Settings > Environment Variables, then redeploy.');
  }
  return {
    token, repo,
    branch: process.env.GITHUB_BRANCH || 'data',
    dir: (process.env.DATA_DIR || 'album').replace(/^\/+|\/+$/g, ''),
  };
}

async function gh(method, path, body, accept) {
  const { token } = cfg();
  let r;
  try {
    r = await fetch('https://api.github.com' + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mark-memory-album',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw httpError(502, 'Could not reach GitHub. Please try again.');
  }
  return r;
}

async function ghFail(r, what) {
  let msg = '';
  try { msg = (await r.json()).message || ''; } catch { /* ignore */ }
  if (r.status === 401) return httpError(500, 'GitHub rejected the token (GITHUB_TOKEN is invalid or expired).');
  if (r.status === 403 || r.status === 404) {
    return httpError(500, `GitHub: no access while ${what}. Check GITHUB_REPO and that the token has "Contents: Read and write" on that repo. (${msg})`);
  }
  return httpError(502, `GitHub error while ${what} (${r.status}). ${msg}`);
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const repoPath = (rel) => `${cfg().dir}/${rel}`;

let branchReady = false;
async function ensureBranch() {
  if (branchReady) return;
  const { repo, branch } = cfg();
  let r = await gh('GET', `/repos/${repo}/git/ref/heads/${enc(branch)}`);
  if (r.ok) { branchReady = true; return; }
  if (r.status !== 404) throw await ghFail(r, 'checking the data branch');

  // Branch doesn't exist yet: create it from the repo's default branch.
  r = await gh('GET', `/repos/${repo}`);
  if (!r.ok) throw await ghFail(r, 'reading the repository');
  const def = (await r.json()).default_branch;
  r = await gh('GET', `/repos/${repo}/git/ref/heads/${enc(def)}`);
  if (!r.ok) throw httpError(500, 'The GitHub repo looks empty. Push the project code to it first.');
  const sha0 = (await r.json()).object.sha;
  r = await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: sha0 });
  if (!r.ok && r.status !== 422) throw await ghFail(r, 'creating the data branch'); // 422 = already exists (race)
  branchReady = true;
}

async function getMeta(rel) {
  await ensureBranch();
  const { repo, branch } = cfg();
  const r = await gh('GET', `/repos/${repo}/contents/${enc(repoPath(rel))}?ref=${encodeURIComponent(branch)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw await ghFail(r, 'reading a file');
  return r.json();
}

async function getRaw(rel) {
  await ensureBranch();
  const { repo, branch } = cfg();
  const r = await gh('GET', `/repos/${repo}/contents/${enc(repoPath(rel))}?ref=${encodeURIComponent(branch)}`, null, 'application/vnd.github.raw+json');
  if (r.status === 404) return null;
  if (!r.ok) throw await ghFail(r, 'reading a file');
  return Buffer.from(await r.arrayBuffer());
}

async function putFile(rel, buffer, message, sha) {
  await ensureBranch();
  const { repo, branch } = cfg();
  return gh('PUT', `/repos/${repo}/contents/${enc(repoPath(rel))}`, {
    message, branch, content: buffer.toString('base64'), ...(sha ? { sha } : {}),
  });
}

async function deleteFile(rel, message) {
  const meta = await getMeta(rel);
  if (!meta || !meta.sha) return;
  const { repo, branch } = cfg();
  const r = await gh('DELETE', `/repos/${repo}/contents/${enc(repoPath(rel))}`, { message, sha: meta.sha, branch });
  if (!r.ok && r.status !== 404) throw await ghFail(r, 'deleting a file');
}

/* ------------------------------------------------------------------ db */

const DB_FILE = 'db.json';
let dbCache = null; // { at, db } – only used for the public (login page) read

function normalizeDb(raw) {
  const db = raw && typeof raw === 'object' ? raw : {};
  if (!db.texts || typeof db.texts !== 'object') db.texts = {};
  if (!db.items || typeof db.items !== 'object') db.items = {};
  for (const c of CATS) if (!Array.isArray(db.items[c])) db.items[c] = [];
  return db;
}

function defaultDb() { return normalizeDb(JSON.parse(JSON.stringify(SEED))); }

async function readDb() {
  const meta = await getMeta(DB_FILE);
  if (!meta) return { db: defaultDb(), sha: null };
  let text;
  if (meta.content && meta.encoding === 'base64') text = Buffer.from(meta.content, 'base64').toString('utf8');
  else text = (await getRaw(DB_FILE) || Buffer.from('{}')).toString('utf8');
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { throw httpError(500, 'album/db.json on GitHub is not valid JSON.'); }
  return { db: normalizeDb(parsed), sha: meta.sha };
}

async function readDbCached(ttl) {
  if (dbCache && Date.now() - dbCache.at < ttl) return dbCache.db;
  const { db } = await readDb();
  dbCache = { at: Date.now(), db };
  return db;
}

/** Read-modify-write with retry on conflicting commits. */
async function updateDb(mutator, message) {
  for (let i = 0; i < 4; i++) {
    const { db, sha } = await readDb();
    const result = await mutator(db);
    const r = await putFile(DB_FILE, Buffer.from(JSON.stringify(db, null, 2)), message, sha);
    if (r.ok) { dbCache = null; return { db, result }; }
    if (r.status === 409 || r.status === 422) { await sleep(300 * (i + 1)); continue; }
    throw await ghFail(r, 'saving the album');
  }
  throw httpError(409, 'The album was busy. Please try again.');
}

module.exports = {
  COOKIE, MAX_FILE, CATS, HttpError, httpError, sleep,
  checkLogin, signToken, getSession, requireSession, setSessionCookie, clearSessionCookie,
  send, handler, readBody,
  cfg, getRaw, putFile, deleteFile, readDb, readDbCached, updateDb, defaultDb,
};
