/* ============================================================================
   auth.js - BRI.Auth
   Accounts, sessions and usage tracking against the FastAPI backend.

   There used to be a second, localStorage-backed provider for use before a
   server existed - it kept accounts in the browser only, so nothing was
   shared between devices and any check could be bypassed by editing
   localStorage. It has been removed now that this application runs against a
   real backend for every account; there is no mode switch left in this file,
   and no build of this app talks to anything but the API below.

   The access token is held in memory rather than localStorage. A token in
   localStorage is readable by any script that gets onto the page, and this
   application renders user-supplied text; the refresh token is the only
   thing that persists, and it rides in an HttpOnly cookie that JavaScript
   cannot read at all.
   ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = 'https://api.fdetection.com';
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

  var Auth = {
    provider: 'api',
    isDemo: false,

    signUp: function (email, password, name, company) {
      return apiCall('/auth/register', {
        method: 'POST',
        body: { email: email, password: password, name: name, company: company }
      }).then(function () {
        return Auth.signIn(email, password);
      });
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

    diagnostics: function () {
      return apiCall('/health').then(function (h) {
        return { provider: 'api', base: API_BASE, server: h };
      });
    }
  };

  global.BRI = global.BRI || {};
  global.BRI.Auth = Auth;
})(typeof window !== 'undefined' ? window : globalThis);
