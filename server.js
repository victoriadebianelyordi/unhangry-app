// Local development server for the Unhangry Assistant.
// No framework, no npm install — just Node's built-ins. Run with: node server.js
//
// This is a thin static-file server that delegates every /api/* route to the
// same handler files Vercel runs in production (see api/*.js) — so local dev
// and the deployed app always run identical code, no duplicated logic:
//   GET  /api/recipes        — the bundled recipe library (read-only)
//   GET  /api/config         — tells the frontend whether AI import is available
//   POST /api/import/url     — fetch a recipe page, extract structured data
//   POST /api/import/photo   — send a recipe photo to Claude for transcription
//   POST /api/import/text    — send pasted recipe text to Claude for structuring
//   POST /api/generate-list  — scales this week's picks into a grocery list,
//                               AI Advice, and Weigh & Pack
//
// Household, saved weeks, and admin-added recipes all live in the browser's
// localStorage now (js/app.js) — there's no server-side persistence left.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./lib/env');
loadEnv();

const claude = require('./lib/claude');
const { sendJSON } = require('./lib/http');

const configHandler = require('./api/config');
const recipesHandler = require('./api/recipes');
const importText = require('./api/import/text');
const importUrl = require('./api/import/url');
const importPhoto = require('./api/import/photo');
const generateList = require('./api/generate-list');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/recipes' && req.method === 'GET') {
      return await recipesHandler(req, res);
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return await configHandler(req, res);
    }
    if (url.pathname === '/api/import/url' && req.method === 'POST') {
      return await importUrl(req, res);
    }
    if (url.pathname === '/api/import/photo' && req.method === 'POST') {
      return await importPhoto(req, res);
    }
    if (url.pathname === '/api/import/text' && req.method === 'POST') {
      return await importText(req, res);
    }
    if (url.pathname === '/api/generate-list' && req.method === 'POST') {
      return await generateList(req, res);
    }
  } catch (err) {
    console.error(err);
    return sendJSON(res, err.statusCode || 500, { error: 'server-error', message: err.message });
  }

  // Static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(ROOT, decodeURIComponent(filePath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Unhangry Assistant running at http://localhost:${PORT}`);
  console.log(claude.hasApiKey()
    ? 'AI recipe import (URL/photo/paste) is ENABLED.'
    : 'AI recipe import is OFF — add ANTHROPIC_API_KEY to .env to enable it (see .env.example).');
});
