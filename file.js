'use strict';
const L = require('./_lib');

// GET /api/file?p=uploads/pictures/abc.jpg   (logged-in users only)
// Streams a media file out of the GitHub data branch. Supports Range requests,
// which Safari/iOS needs before it will play audio or video.

const TYPES = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', weba: 'audio/webm',
};

module.exports = L.handler(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw L.httpError(405, 'Method not allowed.');
  L.requireSession(req, false);

  const p = String(req.query.p || '');
  if (!/^uploads\/(pictures|videos|music)\/[a-z0-9][a-z0-9._-]*\.[a-z0-9]+$/.test(p)) throw L.httpError(400, 'Bad file path.');

  const buf = await L.getRaw(p);
  if (!buf) throw L.httpError(404, 'File not found.');

  const type = TYPES[p.split('.').pop()] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // file names are unique

  const total = buf.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    let start, end;
    if (range[1] === '') { start = Math.max(0, total - Number(range[2])); end = total - 1; }
    else { start = Number(range[1]); end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1); }
    if (start >= total || start > end) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    return res.status(206).end(req.method === 'HEAD' ? undefined : buf.subarray(start, end + 1));
  }

  res.setHeader('Content-Length', total);
  res.status(200).end(req.method === 'HEAD' ? undefined : buf);
});
