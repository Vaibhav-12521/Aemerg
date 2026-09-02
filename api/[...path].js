/* Every /api/* request lands here.

   Vercel's catch-all: one function for the whole API, which is what keeps the
   route count inside a Hobby project's limit. The implementation lives in lib
   so the local server can call exactly the same code. */

module.exports = require('../lib/handler');
