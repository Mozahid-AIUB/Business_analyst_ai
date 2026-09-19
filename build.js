/* ============================================================================
   build.js — produce the hosted variant of the page.

   `app.html` is a complete standalone document: open it from disk and it
   works. Some hosts (including Claude Artifacts) supply their own
   <!doctype>/<head>/<body> wrapper and expect only the page content, which
   would otherwise end up nested inside a second document.

   This script strips the wrapper and writes dist/artifact.html. Assets are
   referenced by the same relative paths, so nothing else changes.

   Usage:  node build.js
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = fs.readFileSync(path.join(root, 'app.html'), 'utf8');

const pick = (re) => (src.match(re) || []).join('\n');

const title = pick(/<title>[\s\S]*?<\/title>/i);
const fonts = pick(/<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/gi);
const styles = pick(/<link[^>]+rel=["']stylesheet["'][^>]*href=["'](?!https?:)[^"']+["'][^>]*>/gi);

const bodyMatch = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
if (!bodyMatch) {
  console.error('build: could not find a <body> in app.html');
  process.exit(1);
}

const out = [title, fonts, styles, bodyMatch[1].trim(), ''].filter(Boolean).join('\n');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), out);

console.log('build: wrote dist/artifact.html (' + (out.length / 1024).toFixed(1) + ' KB)');
console.log('build: publish it alongside assets/app.css, assets/ml.js, assets/data.js, assets/app.js');
