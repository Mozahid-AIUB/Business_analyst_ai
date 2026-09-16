/* ============================================================================
   auth.js - BRI.Auth
   Accounts, sessions and usage tracking.

   ---------------------------------------------------------------------------
   READ THIS BEFORE SHIPPING TO REAL USERS
   ---------------------------------------------------------------------------
   The active provider is DEMO. It keeps everything in this browser's
   localStorage, which means:

     - It is NOT security. Every check runs on the client, so anyone can edit
       localStorage and grant themselves an admin role. There is no server to
       say no.
     - Nothing is shared. Accounts created on one device or browser do not
       exist on another, and you cannot see what your users are doing.
     - Clearing site data deletes every account and every event.

   It exists so the sign-in flow, the roles and the admin console can be
   demonstrated and reviewed before a backend is chosen. Passwords are still
   salted and iterated rather than stored in the clear - not because that makes
   this safe, but so the data shape is already correct when it moves.

   To go live, implement the same seven methods against a real backend and
   change PROVIDER. `providers.supabase` below is a worked sketch of that, with
   the SQL schema it expects. Nothing in app.js needs to change.
   ========================================================================== */
(function (global) {
  'use strict';

  var PROVIDER = 'demo';          /* 'demo' | 'supabase' */
  var STORAGE_KEY = 'sentinel-auth-v1';
  var SESSION_KEY = 'sentinel-session-v1';
  var PBKDF_ROUNDS = 600;

  /* ---------------------------------------------------------------- sha256 */
  /* Written out rather than using crypto.subtle so the same code path works
     from a file:// URL, inside an embedded preview, and on a web host - and
     so it stays synchronous, which keeps the provider interface simple. */

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Bytes(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        i++;
        c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256(message) {
    var bytes = utf8Bytes(message);
    var bitLen = bytes.length * 8;

    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var b = 7; b >= 0; b--) bytes.push((bitLen / Math.pow(2, b * 8)) & 0xff);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Int32Array(64), i, t;

    for (var off = 0; off < bytes.length; off += 64) {
      for (i = 0; i < 16; i++) {
        w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
               (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & bb) ^ (a & c) ^ (bb & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }

    var hex = '';
    for (i = 0; i < 8; i++) {
      for (t = 3; t >= 0; t--) hex += ('0' + ((H[i] >>> (t * 8)) & 0xff).toString(16)).slice(-2);
    }
    return hex;
  }

  /* Iterated salted hash. Six hundred rounds is nothing against a real
     attacker with the file - it is the shape, not the protection. */
  function hashPassword(password, salt) {
    var h = salt + '|' + password;
    for (var i = 0; i < PBKDF_ROUNDS; i++) h = sha256(h + '|' + i);
    return h;
  }

  function randomId(prefix) {
    var s = '';
    for (var i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    return (prefix || '') + s;
  }

  /* --------------------------------------------------------- demo storage */

  function safeRead(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function safeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  /* In-memory mirror, so the app keeps working when storage is unavailable
     (a private window, blocked site data) - it just will not survive a
     reload, and the UI says so. */
  var memory = null;
  var storageWorks = true;

  function db() {
    if (memory) return memory;
    memory = safeRead(STORAGE_KEY, null);
    if (!memory) {
      memory = { users: [], events: [], seededAt: null };
      seed(memory);
      storageWorks = safeWrite(STORAGE_KEY, memory);
    }
    return memory;
  }

  function persist() {
    storageWorks = safeWrite(STORAGE_KEY, memory) && storageWorks;
  }

  function normaliseEmail(email) { return String(email || '').trim().toLowerCase(); }

  /* ------------------------------------------------------------- seeding */
  /* An empty console teaches nobody anything, so the demo ships with a month
     of plausible history. Every seeded row carries seeded:true and the console
     labels them, so nothing here can be mistaken for a real customer. */

  var SEED_COMPANIES = [
    ['maya.rahman@northgate.com', 'Maya Rahman', 'Northgate Trading'],
    ['t.okafor@ironwood.co', 'Tunde Okafor', 'Ironwood Engineering'],
    ['s.haque@pemberton.com', 'Sadia Haque', 'Pemberton Foods'],
    ['dlee@cobaltsys.io', 'Daniel Lee', 'Cobalt Systems'],
    ['r.fernandes@juniperlog.com', 'Rita Fernandes', 'Juniper Logistics']
  ];

  var SEED_FILES = ['march_settlements.csv', 'q1_card_txns.csv', 'wire_batch_0412.csv',
    'acquirer_export.csv', 'claims_feed_week12.csv', 'daily_auth_log.csv'];

  function seed(store) {
    var now = Date.now(), day = 86400000;
    var rnd = (function (s) {
      return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    })(20260916);

    function addUser(email, name, company, role, daysAgo, seeded) {
      var salt = randomId();
      var pw = role === 'admin' ? 'admin1234' : 'owner1234';
      var u = {
        id: randomId('u_'), email: normaliseEmail(email), name: name, company: company,
        role: role, salt: salt, hash: hashPassword(pw, salt),
        createdAt: now - daysAgo * day, lastLoginAt: null, loginCount: 0,
        active: true, seeded: !!seeded
      };
      store.users.push(u);
      return u;
    }

    /* The two accounts the demo hands out. Their passwords are printed on the
       sign-in screen, which is the correct behaviour for a demo and the wrong
       behaviour for anything else. */
    var admin = addUser('admin@rebintech.com', 'ReBin Tech', 'ReBin Tech', 'admin', 34, false);
    var owner = addUser('owner@demo.com', 'Demo Owner', 'Demo Trading Co', 'owner', 30, false);

    var seeded = SEED_COMPANIES.map(function (c, i) {
      return addUser(c[0], c[1], c[2], 'owner', 28 - i * 4, true);
    });

    var all = [admin, owner].concat(seeded);

    function ev(user, type, ts, meta) {
      store.events.push({
        id: randomId('e_'), ts: ts, userId: user.id, type: type,
        meta: meta || {}, seeded: true
      });
      if (type === 'login') {
        user.loginCount++;
        if (!user.lastLoginAt || ts > user.lastLoginAt) user.lastLoginAt = ts;
      }
    }

    all.forEach(function (u) { ev(u, 'signup', u.createdAt, {}); });

    /* 30 days of activity, weighted so recent days are busier and weekends
       are quiet - a usage chart that is flat teaches nobody anything either. */
    for (var d = 29; d >= 0; d--) {
      var ts0 = now - d * day;
      var weekday = new Date(ts0).getDay();
      var weekendFactor = (weekday === 0 || weekday === 6) ? 0.3 : 1;
      var recency = 0.5 + (30 - d) / 30;

      all.forEach(function (u) {
        if (u.createdAt > ts0) return;
        var activity = rnd() * weekendFactor * recency;
        if (activity < 0.35) return;

        var t = ts0 - (ts0 % day) + (8 + Math.floor(rnd() * 10)) * 3600000 + Math.floor(rnd() * 3600000);
        ev(u, 'login', t, {});

        var scans = Math.floor(rnd() * 3);
        for (var s = 0; s < scans; s++) {
          var rows = 120 + Math.floor(rnd() * 2400);
          var high = Math.floor(rows * (0.005 + rnd() * 0.03));
          var medium = high + Math.floor(rows * (0.02 + rnd() * 0.09));
          ev(u, 'scan', t + (s + 1) * 420000, {
            file: SEED_FILES[Math.floor(rnd() * SEED_FILES.length)],
            rows: rows, high: high, medium: medium,
            exposure: Math.round(rows * (8 + rnd() * 70)),
            meanScore: Math.round((0.02 + rnd() * 0.06) * 1000) / 1000
          });
        }

        if (rnd() > 0.55) {
          var score = 22 + rnd() * 70;
          ev(u, 'health', t + 900000, {
            company: u.company,
            score: Math.round(score * 10) / 10,
            grade: score >= 90 ? 'Excellent' : score >= 75 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Needs improvement',
            failureProb: Math.round((0.02 + (100 - score) / 100 * 0.5) * 1000) / 1000
          });
        }
        if (rnd() > 0.82) ev(u, 'portfolio', t + 1500000, { rows: 40 + Math.floor(rnd() * 400) });
        if (rnd() > 0.86) ev(u, 'export', t + 1800000, { kind: rnd() > 0.5 ? 'queue' : 'scored', rows: 20 + Math.floor(rnd() * 300) });
      });
    }

    store.events.sort(function (a, b) { return a.ts - b.ts; });
    store.seededAt = now;
  }

  /* ------------------------------------------------------- demo provider */

  var demoProvider = {
    name: 'demo',

    signUp: function (email, password, name, company) {
      email = normaliseEmail(email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
      if (!password || password.length < 8) throw new Error('Use a password of at least 8 characters.');
      var store = db();
      if (store.users.some(function (u) { return u.email === email; })) {
        throw new Error('An account already exists for that email. Sign in instead.');
      }
      var salt = randomId();
      var user = {
        id: randomId('u_'), email: email, name: (name || '').trim() || email.split('@')[0],
        company: (company || '').trim() || '—', role: 'owner',
        salt: salt, hash: hashPassword(password, salt),
        createdAt: Date.now(), lastLoginAt: null, loginCount: 0, active: true, seeded: false
      };
      store.users.push(user);
      persist();
      this.track('signup', {}, user.id);
      return this.signIn(email, password);
    },

    signIn: function (email, password) {
      email = normaliseEmail(email);
      var store = db();
      var user = store.users.filter(function (u) { return u.email === email; })[0];
      /* Same message either way, so the form cannot be used to discover which
         emails have accounts. */
      if (!user || user.hash !== hashPassword(password, user.salt)) {
        throw new Error('That email and password do not match.');
      }
      if (!user.active) throw new Error('This account has been disabled. Contact your administrator.');

      user.lastLoginAt = Date.now();
      user.loginCount = (user.loginCount || 0) + 1;
      persist();
      this.track('login', {}, user.id);
      safeWrite(SESSION_KEY, { userId: user.id, since: Date.now() });
      return this.publicUser(user);
    },

    signOut: function () {
      var u = this.currentUser();
      if (u) this.track('logout', {}, u.id);
      try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
      memorySession = null;
    },

    currentUser: function () {
      var s = memorySession || safeRead(SESSION_KEY, null);
      if (!s) return null;
      var user = db().users.filter(function (u) { return u.id === s.userId; })[0];
      if (!user || !user.active) return null;
      return this.publicUser(user);
    },

    publicUser: function (u) {
      return {
        id: u.id, email: u.email, name: u.name, company: u.company, role: u.role,
        createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, loginCount: u.loginCount,
        active: u.active, seeded: u.seeded
      };
    },

    listUsers: function () {
      var self = this;
      return db().users.map(function (u) { return self.publicUser(u); });
    },

    setActive: function (userId, active) {
      var store = db();
      var u = store.users.filter(function (x) { return x.id === userId; })[0];
      if (!u) return false;
      if (u.role === 'admin') throw new Error('An administrator account cannot be disabled here.');
      u.active = !!active;
      persist();
      return true;
    },

    track: function (type, meta, userIdOverride) {
      var store = db();
      var uid = userIdOverride;
      if (!uid) {
        var s = memorySession || safeRead(SESSION_KEY, null);
        uid = s ? s.userId : null;
      }
      if (!uid) return null;
      var e = { id: randomId('e_'), ts: Date.now(), userId: uid, type: type, meta: meta || {}, seeded: false };
      store.events.push(e);
      persist();
      return e;
    },

    events: function (filter) {
      var list = db().events.slice();
      if (filter && filter.type) list = list.filter(function (e) { return e.type === filter.type; });
      if (filter && filter.userId) list = list.filter(function (e) { return e.userId === filter.userId; });
      if (filter && filter.since) list = list.filter(function (e) { return e.ts >= filter.since; });
      return list.sort(function (a, b) { return b.ts - a.ts; });
    },

    reset: function () {
      try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
      memory = null;
      memorySession = null;
      db();
    },

    diagnostics: function () {
      var store = db();
      return {
        provider: 'demo',
        storageWorks: storageWorks,
        users: store.users.length,
        events: store.events.length,
        seededUsers: store.users.filter(function (u) { return u.seeded; }).length,
        seededEvents: store.events.filter(function (e) { return e.seeded; }).length
      };
    }
  };

  var memorySession = null;

  /* ---------------------------------------------------- supabase sketch */
  /* Not wired up - this is the contract the demo provider is standing in for,
     kept here so swapping is a matter of filling in two constants and flipping
     PROVIDER above.

     Load the client from an allowed CDN before this file:
       <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>

     Schema:

       create table profiles (
         id uuid primary key references auth.users on delete cascade,
         email text not null,
         name text,
         company text,
         role text not null default 'owner',
         active boolean not null default true,
         created_at timestamptz not null default now(),
         last_login_at timestamptz,
         login_count int not null default 0
       );

       create table usage_events (
         id bigserial primary key,
         user_id uuid not null references auth.users on delete cascade,
         type text not null,
         meta jsonb not null default '{}',
         ts timestamptz not null default now()
       );
       create index on usage_events (user_id, ts desc);
       create index on usage_events (type, ts desc);

       alter table profiles enable row level security;
       alter table usage_events enable row level security;

       -- a user sees only their own rows; an admin sees everything
       create policy "own profile" on profiles for select
         using (id = auth.uid() or exists (
           select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

       create policy "own events" on usage_events for select
         using (user_id = auth.uid() or exists (
           select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

       create policy "insert own events" on usage_events for insert
         with check (user_id = auth.uid());

     Row-level security is the part that makes this real: the rules live in the
     database, so a user editing their own browser cannot read anyone else's
     rows the way they can in the demo provider. */

  var SUPABASE_URL = '';          /* e.g. https://xxxx.supabase.co */
  var SUPABASE_ANON_KEY = '';

  function supabaseProvider() {
    if (!global.supabase || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase is selected but SUPABASE_URL / SUPABASE_ANON_KEY are not set in auth.js.');
    }
    /* Implement signUp, signIn, signOut, currentUser, listUsers, setActive,
       track and events against supabase.createClient(...) here. The rest of
       the application calls nothing else. */
    throw new Error('Supabase provider not implemented yet.');
  }

  /* --------------------------------------------------------------- export */

  var active = PROVIDER === 'supabase' ? supabaseProvider() : demoProvider;

  global.BRI = global.BRI || {};
  global.BRI.Auth = {
    provider: active.name,
    isDemo: active.name === 'demo',
    signUp: function () { return active.signUp.apply(active, arguments); },
    signIn: function () { return active.signIn.apply(active, arguments); },
    signOut: function () { return active.signOut.apply(active, arguments); },
    currentUser: function () { return active.currentUser.apply(active, arguments); },
    listUsers: function () { return active.listUsers.apply(active, arguments); },
    setActive: function () { return active.setActive.apply(active, arguments); },
    track: function () { return active.track.apply(active, arguments); },
    events: function () { return active.events.apply(active, arguments); },
    reset: function () { return active.reset.apply(active, arguments); },
    diagnostics: function () { return active.diagnostics.apply(active, arguments); },
    sha256: sha256
  };
})(typeof window !== 'undefined' ? window : globalThis);
