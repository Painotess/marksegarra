'use strict';
const crypto = require('crypto');
const L = require('./_lib');

// POST   /api/items            add an item (admin)  { category, ...fields, file?: {name,type,data(base64)} }
// DELETE /api/items?category=&id=   remove an item (admin)

const MIME = {
  pictures: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' },
  videos: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' },
  music: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'weba' },
};

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dateStr = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const dim = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 20000 ? n : 0; };

function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/);
  return m ? m[1] : '';
}

function cleanUrl(v) {
  const s = str(v, 600);
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch { /* fall through */ }
  throw L.httpError(400, 'Please paste a valid link starting with http:// or https://');
}

module.exports = L.handler(async (req, res) => {
  if (req.method === 'POST') return add(req, res);
  if (req.method === 'DELETE') return remove(req, res);
  res.setHeader('Allow', 'POST, DELETE');
  throw L.httpError(405, 'Method not allowed.');
});

async function add(req, res) {
  L.requireSession(req, true);
  const b = L.readBody(req);
  const cat = b.category;
  if (!L.CATS.includes(cat)) throw L.httpError(400, 'Unknown category.');

  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const item = { id, createdAt: new Date().toISOString() };
  let upload = null; // { rel, buffer }

  if (cat === 'messages') {
    item.title = str(b.title, 120);
    item.body = str(b.body, 8000);
    item.date = dateStr(b.date);
    if (!item.title) throw L.httpError(400, 'Please add a title.');
    if (!item.body) throw L.httpError(400, 'Please write your message.');
  } else {
    // ---- media: either an uploaded file or (videos/music) a link
    if (b.file) {
      const f = b.file;
      const ext = MIME[cat][String(f.type || '').toLowerCase()];
      if (!ext) throw L.httpError(400, 'This file type is not supported for ' + cat + '.');
      if (typeof f.data !== 'string' || !f.data) throw L.httpError(400, 'The file is empty.');
      const buffer = Buffer.from(f.data, 'base64');
      if (!buffer.length) throw L.httpError(400, 'The file is empty.');
      if (buffer.length > L.MAX_FILE) throw L.httpError(413, 'File is too big for the live site (max 3 MB). Use a smaller file or paste a link instead.');
      const rel = `uploads/${cat}/${id}.${ext}`;
      upload = { rel, buffer };
      item.kind = 'file';
      item.src = rel;
    } else if (cat !== 'pictures' && b.url) {
      const url = cleanUrl(b.url);
      const yt = cat === 'videos' ? youtubeId(url) : '';
      if (yt) { item.kind = 'youtube'; item.ytId = yt; item.src = url; }
      else { item.kind = 'url'; item.src = url; }
    } else {
      throw L.httpError(400, cat === 'pictures' ? 'Please choose a picture.' : 'Please choose a file or paste a link.');
    }

    if (cat === 'pictures') {
      item.caption = str(b.caption, 300);
      item.date = dateStr(b.date);
      const w = dim(b.w), h = dim(b.h);
      if (w && h) { item.w = w; item.h = h; }
    } else if (cat === 'videos') {
      item.title = str(b.title, 120);
      item.caption = str(b.caption, 300);
    } else {
      item.title = str(b.title, 120);
      item.artist = str(b.artist, 120);
      if (!item.title) throw L.httpError(400, 'Please add a song title.');
    }
  }

  if (upload) {
    const r = await L.putFile(upload.rel, upload.buffer, `Upload ${cat} ${id}`);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('upload failed', r.status, t);
      throw L.httpError(502, 'GitHub could not save the file. Check the token has "Contents: Read and write" access.');
    }
  }

  try {
    await L.updateDb((db) => { db.items[cat].unshift(item); }, `Add ${cat} item ${id}`);
  } catch (e) {
    if (upload) await L.deleteFile(upload.rel, `Rollback ${id}`).catch(() => {});
    throw e;
  }
  L.send(res, 200, { item });
}

async function remove(req, res) {
  L.requireSession(req, true);
  const cat = String(req.query.category || '');
  const id = String(req.query.id || '');
  if (!L.CATS.includes(cat) || !id) throw L.httpError(400, 'Invalid request.');

  const { result: removed } = await L.updateDb((db) => {
    const i = db.items[cat].findIndex((x) => x.id === id);
    if (i === -1) return null;
    return db.items[cat].splice(i, 1)[0];
  }, `Delete ${cat} item ${id}`);

  if (!removed) throw L.httpError(404, 'That item was already removed.');
  if (typeof removed.src === 'string' && /^uploads\/(pictures|videos|music)\//.test(removed.src)) {
    await L.deleteFile(removed.src, `Delete file ${id}`).catch((e) => console.error('file cleanup failed', e.message));
  }
  L.send(res, 200, { ok: true });
}
