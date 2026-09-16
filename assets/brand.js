/* ============================================================================
   brand.js - BRI.Brand
   Every piece of naming the product shows, in one place.

   The final name has not been chosen yet, so nothing else in the codebase
   writes it down. Change the values here and the sign-in screen, both
   sidebars, both page titles and the footer all follow. The <title> tags in
   index.html and admin.html are the one thing a script cannot set before the
   browser paints them, so they are overwritten on load rather than hardcoded
   twice.

   WHO IS WHO
   ----------
   This is worth stating plainly, because the roles are easy to mix up:

     operator  - ReBin Tech. The client this platform is being built for.
                 They run it, they hold the staff accounts, and the staff
                 console (admin.html) is theirs. Their people have role
                 'admin'.
     customer  - the businesses that sign up and use the scanner and the
                 health score. Role 'customer'. They never see the console.
     builder   - whoever is developing this. Not a role in the product and
                 not an account; mentioned only so the distinction is on the
                 record.
   ========================================================================== */
(function (global) {
  'use strict';

  var BRAND = {
    /* The product. Rename freely - nothing derives meaning from these. */
    name: 'Sentinel Risk Desk',
    tagline: 'Risk & Intelligence',
    consoleName: 'Staff console',

    /* The company that operates the platform and holds the staff accounts. */
    operator: 'ReBin Tech',
    operatorDomain: 'rebintech.com',

    /* Shown in the footer once real values exist; empty means "do not show". */
    supportEmail: '',
    website: ''
  };

  /* Both pages ship a <title> so the tab is never blank before scripts run;
     this keeps it in step once they have. */
  function applyTitles(isConsole) {
    try {
      document.title = isConsole
        ? BRAND.name + ' — ' + BRAND.consoleName
        : BRAND.name;
    } catch (e) { /* no document during a headless check */ }
  }

  /* The markup carries the current name so the page is never blank before
     scripts run; this replaces it with whatever brand.js now says. */
  function applyMarkup() {
    try {
      var nodes = document.querySelectorAll('[data-brand]');
      for (var i = 0; i < nodes.length; i++) {
        var key = nodes[i].getAttribute('data-brand');
        if (BRAND[key] != null && BRAND[key] !== '') nodes[i].textContent = BRAND[key];
      }
      var subs = document.querySelectorAll('.brand-sub');
      for (var j = 0; j < subs.length; j++) {
        /* The console labels itself; the customer app carries the tagline. */
        if (!subs[j].hasAttribute('data-brand-keep')) {
          subs[j].textContent = document.body.getAttribute('data-page') === 'console'
            ? BRAND.consoleName : BRAND.tagline;
        }
      }
    } catch (e) { /* nothing to paint in a headless check */ }
  }

  function apply() {
    var isConsole = false;
    try { isConsole = document.body.getAttribute('data-page') === 'console'; } catch (e) {}
    applyTitles(isConsole);
    applyMarkup();
  }

  /* Both pages load this at the end of <body>, so the nodes it paints already
     exist and it can run at once. The listener is a fallback for the case
     where the file is pulled in from <head> instead; applying twice is
     harmless because the operation is idempotent. */
  if (typeof document !== 'undefined') {
    apply();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  }

  global.BRI = global.BRI || {};
  global.BRI.Brand = {
    name: BRAND.name,
    tagline: BRAND.tagline,
    consoleName: BRAND.consoleName,
    operator: BRAND.operator,
    operatorDomain: BRAND.operatorDomain,
    supportEmail: BRAND.supportEmail,
    website: BRAND.website,
    applyTitles: applyTitles,
    apply: apply
  };
})(typeof window !== 'undefined' ? window : globalThis);
