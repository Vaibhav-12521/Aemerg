/* A local stand-in for the hosted store.

   It understands the handful of commands lib/store.js uses and keeps them in
   a JSON file beside the project. That is what lets the app run and be tested
   on a laptop with no account anywhere, while the deployed copy talks to the
   real thing. Same commands, same semantics, so store.js cannot tell them
   apart and there is no second code path to keep honest. */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'data.json');

let db = { s: {}, l: {}, t: {} };   /* strings, lists, expiries */

try {
  if (fs.existsSync(FILE)) db = Object.assign({ s: {}, l: {}, t: {} }, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch (err) {
  console.error('local store unreadable, starting fresh:', err.message);
}

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {
        console.error('could not write the local store:', e.message);
      }
    }
  }, 40);
}
process.on('exit', () => {
  clearTimeout(timer);
  try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) {}
});

function alive(key) {
  const until = db.t[key];
  if (until === undefined) return true;
  if (Date.now() < until) return true;
  delete db.t[key];
  delete db.s[key];
  delete db.l[key];
  return false;
}

const list = (key) => {
  if (!alive(key)) return [];
  if (!db.l[key]) db.l[key] = [];
  return db.l[key];
};

function run(parts) {
  const op = String(parts[0]).toUpperCase();
  const key = parts[1];

  switch (op) {
    case 'GET':
      return alive(key) && key in db.s ? db.s[key] : null;

    case 'SET': {
      const value = parts[2];
      const rest = parts.slice(3).map((x) => String(x).toUpperCase());
      const nx = rest.indexOf('NX') > -1;
      if (nx && alive(key) && key in db.s) return null;
      db.s[key] = String(value);
      delete db.t[key];
      const exAt = parts.findIndex((x) => String(x).toUpperCase() === 'EX');
      if (exAt > -1 && parts[exAt + 1]) db.t[key] = Date.now() + Number(parts[exAt + 1]) * 1000;
      persist();
      return 'OK';
    }

    case 'DEL': {
      const had = (key in db.s) || (key in db.l);
      delete db.s[key]; delete db.l[key]; delete db.t[key];
      persist();
      return had ? 1 : 0;
    }

    case 'EXISTS':
      return alive(key) && ((key in db.s) || (key in db.l)) ? 1 : 0;

    case 'RPUSH': {
      const arr = list(key);
      for (let i = 2; i < parts.length; i++) arr.push(String(parts[i]));
      db.l[key] = arr;
      persist();
      return arr.length;
    }

    case 'LPUSH': {
      const arr = list(key);
      for (let i = 2; i < parts.length; i++) arr.unshift(String(parts[i]));
      db.l[key] = arr;
      persist();
      return arr.length;
    }

    case 'LRANGE': {
      const arr = list(key);
      let start = Number(parts[2]);
      let stop = Number(parts[3]);
      if (start < 0) start = Math.max(arr.length + start, 0);
      if (stop < 0) stop = arr.length + stop;
      return arr.slice(start, stop + 1);
    }

    case 'LTRIM': {
      const arr = list(key);
      let start = Number(parts[2]);
      let stop = Number(parts[3]);
      if (start < 0) start = Math.max(arr.length + start, 0);
      if (stop < 0) stop = arr.length + stop;
      db.l[key] = arr.slice(start, stop + 1);
      persist();
      return 'OK';
    }

    case 'LREM': {
      const arr = list(key);
      const count = Number(parts[2]);
      const value = String(parts[3]);
      let removed = 0;
      const keep = [];
      for (const item of arr) {
        if (item === value && (count === 0 || removed < Math.abs(count))) { removed++; continue; }
        keep.push(item);
      }
      db.l[key] = keep;
      persist();
      return removed;
    }

    case 'SADD': {
      const arr = list(key);
      let added = 0;
      for (let i = 2; i < parts.length; i++) {
        const v = String(parts[i]);
        if (arr.indexOf(v) === -1) { arr.push(v); added++; }
      }
      db.l[key] = arr;
      persist();
      return added;
    }

    case 'SREM': {
      const arr = list(key);
      const before = arr.length;
      db.l[key] = arr.filter((x) => x !== String(parts[2]));
      persist();
      return before - db.l[key].length;
    }

    case 'SMEMBERS':
      return list(key).slice();

    default:
      throw new Error('the local store does not know ' + op);
  }
}

module.exports = {
  file: FILE,
  cmd: async (parts) => run(parts),
  pipe: async (commands) => commands.map(run)
};
