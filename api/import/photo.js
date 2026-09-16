const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../../lib/env');
loadEnv();
const claude = require('../../lib/claude');
const { sendJSON, readJsonBody, slugify } = require('../../lib/http');

const PHOTO_DRAFTS_DIR = path.join(__dirname, '..', '..', 'recipes', '_photo-drafts');

module.exports = async (req, res) => {
  const { imageBase64, mimeType, name } = await readJsonBody(req);
  if (!imageBase64 || !mimeType || !mimeType.startsWith('image/')) {
    return sendJSON(res, 400, { error: 'bad-image', message: 'No image received.' });
  }

  if (claude.hasApiKey()) {
    try {
      const recipe = await claude.extractRecipeFromImage(imageBase64, mimeType);
      return sendJSON(res, 200, { status: 'ai-parsed', recipe });
    } catch (err) {
      console.error('Claude photo extraction failed:', err.message);
      return sendJSON(res, 502, { error: 'ai-failed', message: `AI couldn't read that photo (${err.message}). Try the paste-text tab instead.` });
    }
  }

  // No API key — try to save the photo locally so it isn't lost (works when
  // running `node server.js` locally; on Vercel's read-only filesystem this
  // silently no-ops rather than failing the request).
  let savedAs = null;
  try {
    fs.mkdirSync(PHOTO_DRAFTS_DIR, { recursive: true });
    const ext = mimeType.split('/')[1] || 'jpg';
    const filename = `${Date.now()}-${slugify(name || 'recipe-photo')}.${ext}`;
    fs.writeFileSync(path.join(PHOTO_DRAFTS_DIR, filename), Buffer.from(imageBase64, 'base64'));
    savedAs = `recipes/_photo-drafts/${filename}`;
  } catch (err) {
    console.error('Could not save photo draft to disk:', err.message);
  }

  return sendJSON(res, 200, {
    status: 'needs-manual',
    ...(savedAs ? { savedAs } : {}),
    message: savedAs
      ? `No AI key configured yet (see .env.example) — saved the photo to ${savedAs} so you can transcribe it into the fields below or add it later.`
      : 'No AI key configured yet (see .env.example) — transcribe the photo into the fields below manually.',
  });
};
