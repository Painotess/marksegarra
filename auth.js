'use strict';
const L = require('./_lib');

// GET    /api/auth  -> who am I?  (also lets the front end detect the live backend)
// POST   /api/auth  -> log in
// DELETE /api/auth  -> log out
module.exports = L.handler(async (req, res) => {
  if (req.method === 'GET') {
    return L.send(res, 200, { remote: true, user: L.getSession(req) });
  }
  if (req.method === 'POST') {
    const b = L.readBody(req);
    const user = L.checkLogin(b.username, b.password);
    if (!user) {
      await L.sleep(500); // slow down guessing
      throw L.httpError(401, 'Wrong username or password.');
    }
    L.setSessionCookie(req, res, L.signToken(user));
    return L.send(res, 200, { remote: true, user });
  }
  if (req.method === 'DELETE') {
    L.clearSessionCookie(req, res);
    return L.send(res, 200, { ok: true });
  }
  res.setHeader('Allow', 'GET, POST, DELETE');
  throw L.httpError(405, 'Method not allowed.');
});
