const { loadEnv } = require('../../lib/env');
loadEnv();
const claude = require('../../lib/claude');
const { sendJSON, readJsonBody } = require('../../lib/http');

module.exports = async (req, res) => {
  const { name, text } = await readJsonBody(req);
  if (!text || !text.trim()) {
    return sendJSON(res, 400, { error: 'missing-text', message: 'Paste some recipe text first.' });
  }

  if (claude.hasApiKey()) {
    try {
      const recipe = await claude.extractRecipeFromText(text, name);
      return sendJSON(res, 200, { status: 'ai-parsed', recipe });
    } catch (err) {
      console.error('Claude text extraction failed:', err.message);
      // fall through to manual mode
    }
  }

  return sendJSON(res, 200, {
    status: 'needs-manual',
    rawText: text,
    message: claude.hasApiKey()
      ? "Couldn't auto-structure that text — clean it up in the fields below."
      : 'No AI key configured yet (see .env.example) — fill in the fields below manually, or save as a draft for later.',
    recipe: { name: name || '' },
  });
};
