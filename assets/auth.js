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

   To go live, set PROVIDER to 'api' and API_BASE to the FastAPI backend in
   ../backend. That provider is written and sits below this one; nothing in
   app.js or admin.js changes, because both call through the same interface.
   ========================================================================== */
(function (global) {
  'use strict';

  var PROVIDER = 'demo';          /* 'demo' | 'api' */
  /* Bump these when the stored shape changes. Renaming the customer role left
     v1 browsers holding accounts whose role still read "owner", which the
     console then displayed - a rename in the source does not reach data that
     is already saved. A new key starts clean rather than half-migrated. */
  var STORAGE_KEY = 'sentinel-auth-v2';
  var SESSION_KEY = 'sentinel-session-v2';
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

  /* The handful that show up at the top of every breach dump. A real system
     would check a downloaded list of the top hundred thousand; this is the
     same rule at demo scale, so the shape is already correct when it moves. */
  var COMMON_PASSWORDS = [
    'password', 'password1', 'password123', '12345678', '123456789', 'qwerty123',
    'letmein', 'welcome1', 'admin123', 'abc12345', 'iloveyou', 'sunshine',
    'football', 'monkey123'
  ];

  function isCommonPassword(password) {
    var lower = String(password).toLowerCase();
    return COMMON_PASSWORDS.indexOf(lower) !== -1;
  }

  /* A password built out of the address it protects is guessable by anyone who
     knows the address. Short local parts ('bob', 'hr') are skipped because
     they collide with ordinary words too often to be evidence of anything. */
  function containsEmailLocalPart(password, email) {
    var local = String(email || '').split('@')[0].toLowerCase();
    if (local.length < 4) return false;
    return String(password).toLowerCase().indexOf(local) !== -1;
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
      var pw = role === 'admin' ? 'admin1234' : 'customer1234';
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
    var customer = addUser('customer@demo.com', 'Demo Customer', 'Northwind Payments', 'customer', 30, false);

    var seeded = SEED_COMPANIES.map(function (c, i) {
      return addUser(c[0], c[1], c[2], 'customer', 28 - i * 4, true);
    });

    var all = [admin, customer].concat(seeded);

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
        /* Today's slot can land past the current hour, which would sort seeded
           rows above real ones and show a future timestamp. */
        if (t > now) t = now - Math.floor(rnd() * 5400000);
        ev(u, 'login', t, {});

        var scans = Math.floor(rnd() * 3);
        for (var s = 0; s < scans; s++) {
          var rows = 120 + Math.floor(rnd() * 2400);
          var high = Math.floor(rows * (0.005 + rnd() * 0.03));
          var medium = high + Math.floor(rows * (0.02 + rnd() * 0.09));
          ev(u, 'scan', Math.min(now, t + (s + 1) * 420000), {
            file: SEED_FILES[Math.floor(rnd() * SEED_FILES.length)],
            rows: rows, high: high, medium: medium,
            exposure: Math.round(rows * (8 + rnd() * 70)),
            meanScore: Math.round((0.02 + rnd() * 0.06) * 1000) / 1000
          });
        }

        if (rnd() > 0.55) {
          var score = 22 + rnd() * 70;
          ev(u, 'health', Math.min(now, t + 900000), {
            company: u.company,
            score: Math.round(score * 10) / 10,
            grade: score >= 90 ? 'Excellent' : score >= 75 ? 'Strong' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Needs improvement',
            failureProb: Math.round((0.02 + (100 - score) / 100 * 0.5) * 1000) / 1000
          });
        }
        if (rnd() > 0.82) ev(u, 'portfolio', Math.min(now, t + 1500000), { rows: 40 + Math.floor(rnd() * 400) });
        if (rnd() > 0.86) ev(u, 'export', Math.min(now, t + 1800000), { kind: rnd() > 0.5 ? 'queue' : 'scored', rows: 20 + Math.floor(rnd() * 300) });
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
      if (isCommonPassword(password)) {
        throw new Error('That password is too common. Choose something less guessable.');
      }
      if (containsEmailLocalPart(password, email)) {
        throw new Error('Your password should not contain your email address.');
      }
      var store = db();
      if (store.users.some(function (u) { return u.email === email; })) {
        throw new Error('An account already exists for that email. Sign in instead.');
      }
      var salt = randomId();
      var user = {
        id: randomId('u_'), email: email, name: (name || '').trim() || email.split('@')[0],
        company: (company || '').trim() || '—', role: 'customer',
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

  /* ------------------------------------------------------- API provider */
  /* Talks to the FastAPI backend in ../backend. Switch by setting PROVIDER to
     'api' at the top of this file and API_BASE to wherever the API is served.

     One shape difference worth knowing about: the demo provider is synchronous
     because localStorage is, while a network call cannot be. Every method here
     returns a Promise, and the callers in app.js and admin.js handle both -
     they wrap each call in Promise.resolve(...).then(...), which leaves the
     demo provider working unchanged and lets this one await properly.

     The access token is held in memory rather than localStorage. A token in
     localStorage is readable by any script that gets onto the page, and this
     application renders user-supplied text; the refresh token is the only
     thing that persists, so a stolen page context cannot outlive the tab. */

  var API_BASE = '';              /* e.g. https://api.yourdomain.com */
  var accessToken = null;

  function apiCall(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;

    return fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers: headers,
      credentials: 'include',      /* carries the HttpOnly refresh cookie */
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        /* FastAPI puts validation failures in `detail`, which may be a string
           or a list of field errors; surface something a person can act on. */
        var msg = data.detail;
        if (Array.isArray(msg)) {
          /* Pydantic prefixes its own messages with "Value error, ", which is
             an implementation detail of the validator and not something a
             person signing up should be shown. */
          msg = msg.map(function (d) {
            return String(d.msg || '').replace(/^Value error,\s*/i, '');
          }).filter(Boolean).join(' ');
        }
        throw new Error(msg || ('Request failed (' + res.status + ')'));
      });
    });
  }

  function apiProvider() {
    if (!API_BASE) {
      throw new Error('PROVIDER is "api" but API_BASE is not set in auth.js.');
    }
    return {
      name: 'api',

      signUp: function (email, password, name, company) {
        return apiCall('/auth/register', {
          method: 'POST',
          body: { email: email, password: password, name: name, company: company }
        }).then(function () {
          return this.signIn(email, password);
        }.bind(this));
      },

      signIn: function (email, password) {
        return apiCall('/auth/login', {
          method: 'POST',
          body: { email: email, password: password }
        }).then(function (data) {
          accessToken = data.access_token;
          return data.user;
        });
      },

      signOut: function () {
        var done = apiCall('/auth/logout', { method: 'POST' })
          .catch(function () { /* the local session ends either way */ });
        accessToken = null;
        return done;
      },

      currentUser: function () {
        if (!accessToken) {
          /* A page reload loses the in-memory token. The refresh cookie is
             HttpOnly, so the browser sends it and this code never sees it -
             which is the point: a script that got onto the page cannot steal
             a credential it has no way to read. */
          return apiCall('/auth/refresh', { method: 'POST' })
            .then(function (data) {
              accessToken = data.access_token;
              return data.user;
            })
            .catch(function () { return null; });
        }
        return apiCall('/auth/me').catch(function () { return null; });
      },

      listUsers: function () { return apiCall('/admin/users'); },

      setActive: function (userId, active) {
        return apiCall('/admin/users/' + userId, { method: 'PATCH', body: { active: active } });
      },

      track: function (type, meta) {
        /* Usage tracking must never interrupt someone's work, so a failure
           here is swallowed rather than surfaced. */
        return apiCall('/events', { method: 'POST', body: { type: type, meta: meta || {} } })
          .catch(function () { return null; });
      },

      events: function (filter) {
        var q = [];
        if (filter && filter.type) q.push('type=' + encodeURIComponent(filter.type));
        if (filter && filter.userId) q.push('user_id=' + encodeURIComponent(filter.userId));
        if (filter && filter.since) q.push('since=' + encodeURIComponent(new Date(filter.since).toISOString()));
        return apiCall('/events' + (q.length ? '?' + q.join('&') : ''));
      },

      reset: function () {
        throw new Error('reset() is a demo-provider convenience and has no server equivalent.');
      },

      diagnostics: function () {
        return apiCall('/health').then(function (h) {
          return { provider: 'api', base: API_BASE, storageWorks: true, server: h };
        });
      }
    };
  }

  /* --------------------------------------------------------------- export */

  var active = PROVIDER === 'api' ? apiProvider() : demoProvider;

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
