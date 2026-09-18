const { loadEnv } = require('../../lib/env');
loadEnv();
const claude = require('../../lib/claude');
const { sendJSON, readJsonBody } = require('../../lib/http');
const { findJsonLdRecipe, jsonLdToRecipeDraft, stripHtmlToText } = require('../../lib/html-recipe');

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '0.0.0.0' || h.startsWith('127.') || h.startsWith('192.168.') ||
    h.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h);
}

module.exports = async (req, res) => {
  const { url } = await readJsonBody(req);
  if (!url || typeof url !== 'string') {
    return sendJSON(res, 400, { error: 'missing-url', message: 'Give me a URL to import.' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return sendJSON(res, 400, { error: 'bad-url', message: "That doesn't look like a valid URL." });
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return sendJSON(res, 400, { error: 'bad-url', message: 'Only http/https links are supported.' });
  }
  if (isBlockedHost(parsed.hostname)) {
    return sendJSON(res, 400, { error: 'bad-url', message: 'That host is not allowed.' });
  }
  if (/instagram\.com$|instagr\.am$/i.test(parsed.hostname)) {
    return sendJSON(res, 400, {
      error: 'instagram-coming-soon',
      message: "Instagram import is coming soon — for now, paste the caption/recipe text instead using the Paste tab.",
    });
  }

  let html;
  try {
    const pageRes = await fetchWithTimeout(parsed.toString(), 15000);
    if (!pageRes.ok) {
      // Many recipe sites (especially larger commercial ones) block plain automated
      // fetches outright — no real browser, no cookies, no JS — sometimes via an odd
      // status code rather than a normal 403. There's no reliable way around that, so
      // redirect to the fallbacks that always work instead of surfacing a raw status code.
      return sendJSON(res, 502, {
        error: 'fetch-failed',
        message: "Couldn't read that page — some sites block automated requests like this one just did. Try screenshotting the recipe and uploading the photo, or pasting the text instead.",
      });
    }
    html = await pageRes.text();
  } catch (err) {
    return sendJSON(res, 502, {
      error: 'fetch-failed',
      message: "Couldn't reach that page. Try screenshotting the recipe and uploading the photo, or pasting the text instead.",
    });
  }

  const ld = findJsonLdRecipe(html);
  if (ld) {
    const recipe = jsonLdToRecipeDraft(ld, parsed.toString());

    // The page's own markup never gives protein/method/ingredient-component tags, and often
    // no nutrition data — fill in exactly those gaps (never overwrite what the page gave)
    // so this recipe is just as complete as one that went through the AI paths. If this
    // fails (no API key, or the call errors), fall back gracefully: return the structured
    // draft as-is, same as before this existed — never block the import on it.
    if (claude.hasApiKey() && recipe.ingredients.length > 0) {
      try {
        const classified = await claude.classifyRecipeDraft(recipe);
        recipe.protein = classified.protein ?? recipe.protein;
        recipe.method = classified.method ?? recipe.method;
        recipe.mealType = classified.mealType || recipe.mealType || 'main';
        if (Array.isArray(classified.ingredientComponents) && classified.ingredientComponents.length === recipe.ingredients.length) {
          recipe.ingredients = recipe.ingredients.map((ing, idx) => ({ ...ing, component: classified.ingredientComponents[idx] || 'other' }));
        }
        const hadNoMacros = !recipe.macrosPerServing || (!recipe.macrosPerServing.kcal && !recipe.macrosPerServing.protein);
        if (hadNoMacros && classified.macrosPerServing) {
          recipe.macrosPerServing = classified.macrosPerServing;
        }
      } catch (err) {
        console.error('Recipe classification pass failed (using structured data as-is):', err.message);
      }
    }

    return sendJSON(res, 200, { status: 'structured', recipe });
  }

  const text = stripHtmlToText(html);

  if (claude.hasApiKey()) {
    try {
      const recipe = await claude.extractRecipeFromText(text, null);
      recipe.sourceUrl = parsed.toString();
      return sendJSON(res, 200, { status: 'ai-parsed', recipe });
    } catch (err) {
      console.error('Claude extraction failed:', err.message);
      // fall through to manual mode below
    }
  }

  return sendJSON(res, 200, {
    status: 'needs-manual',
    rawText: text.slice(0, 6000),
    message: claude.hasApiKey()
      ? "Couldn't auto-extract that page — here's the raw text, clean it up in the fields below."
      : "No AI key configured yet (see .env.example) — here's the page's text so you can fill in the fields manually.",
  });
};
