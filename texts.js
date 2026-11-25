'use strict';
const L = require('./_lib');

// POST /api/texts  { texts: { "tab.pictures": "Mga Larawan", "hero.title": "" } }   (admin only)
// An empty string removes the custom text, so the default comes back.
module.exports = L.handler(async (req, res) => {
  if (req.method !== 'POST') throw L.httpError(405, 'Method not allowed.');
  L.requireSession(req, true);
  const body = L.readBody(req);
  const patch = body.texts;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw L.httpError(400, 'Invalid request.');

  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!/^[a-z0-9._-]{1,60}$/i.test(k)) throw L.httpError(400, 'Invalid text key.');
    clean[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  }
  if (!Object.keys(clean).length) return L.send(res, 200, { ok: true });

  const { db } = await L.updateDb((d) => {
    for (const [k, v] of Object.entries(clean)) {
      if (v) d.texts[k] = v; else delete d.texts[k];
    }
    if (Object.keys(d.texts).length > 150) throw L.httpError(400, 'Too many custom texts.');
  }, 'Update album texts');

  L.send(res, 200, { ok: true, texts: db.texts });
});
