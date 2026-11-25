'use strict';
const L = require('./_lib');

// GET /api/db
//  - logged out : only the customised texts (so the login page shows the right title)
//  - logged in  : texts + every item
module.exports = L.handler(async (req, res) => {
  if (req.method !== 'GET') throw L.httpError(405, 'Method not allowed.');
  const session = L.getSession(req);

  if (!session) {
    try {
      const db = await L.readDbCached(10000);
      return L.send(res, 200, { texts: db.texts });
    } catch {
      return L.send(res, 200, { texts: {} }); // never block the login page
    }
  }
  const { db } = await L.readDb();
  return L.send(res, 200, { texts: db.texts, items: db.items });
});
