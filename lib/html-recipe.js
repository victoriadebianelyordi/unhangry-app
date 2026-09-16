// Helpers for pulling a recipe out of a fetched web page.
//
// Most recipe blogs (AllRecipes, NYT Cooking, Half Baked Harvest, any WordPress
// recipe plugin, etc.) embed a schema.org Recipe as JSON-LD in a <script type=
// "application/ld+json"> tag. When that's there, we can build a structured
// recipe deterministically — no AI needed. When it's not there, the caller
// falls back to stripping the page to plain text and asking Claude to read it.

const UNIT_WORDS = [
  'cups?', 'tbsp', 'tbs', 'tablespoons?', 'tsp', 'teaspoons?', 'g', 'grams?', 'kg',
  'kilograms?', 'ml', 'l', 'liters?', 'oz', 'ounces?', 'lb', 'lbs', 'pounds?',
  'cans?', 'cloves?', 'pcs?', 'pieces?', 'slices?', 'bunch(?:es)?', 'heads?',
  'packs?', 'packets?', 'pinch(?:es)?', 'handfuls?',
];
const UNIT_RE = new RegExp(`^(${UNIT_WORDS.join('|')})$`, 'i');

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  frac12: '½', frac14: '¼', frac34: '¾',
  frac13: '⅓', frac23: '⅔', frac18: '⅛',
  frac38: '⅜', frac58: '⅝', frac78: '⅞',
  deg: '°', mdash: '—', ndash: '–',
};

const FRACTION_CHARS = {
  '½': 0.5, '¼': 0.25, '¾': 0.75,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

function decodeEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z0-9]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function findJsonLdRecipe(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const found = searchForRecipe(data);
    if (found) return found;
  }
  return null;
}

function searchForRecipe(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchForRecipe(item);
      if (found) return found;
    }
    return null;
  }
  const type = node['@type'];
  const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
  if (isRecipe) return node;
  if (node['@graph']) return searchForRecipe(node['@graph']);
  return null;
}

function parseYield(recipeYield) {
  if (!recipeYield) return null;
  const str = Array.isArray(recipeYield) ? recipeYield[0] : String(recipeYield);
  const match = String(str).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function parseNutritionNumber(value) {
  if (!value) return 0;
  const match = String(value).match(/[\d.]+/);
  return match ? Math.round(Number(match[0])) : 0;
}

function flattenInstructions(instructions) {
  if (!instructions) return [];
  if (typeof instructions === 'string') {
    return instructions.split(/\n+/).map((s) => decodeEntities(s).trim()).filter(Boolean);
  }
  if (!Array.isArray(instructions)) return [];
  const out = [];
  for (const item of instructions) {
    if (typeof item === 'string') {
      out.push(decodeEntities(item).trim());
    } else if (item && item['@type'] === 'HowToSection' && item.itemListElement) {
      out.push(...flattenInstructions(item.itemListElement));
    } else if (item && item.text) {
      out.push(decodeEntities(item.text).trim());
    }
  }
  return out.filter(Boolean);
}

function parseIngredientLine(rawLine) {
  const decoded = decodeEntities(rawLine).replace(/\s+/g, ' ').trim();

  // Normalize a leading "1 ½" / "½" into a plain decimal (e.g. "1.5") so the
  // quantity regex below can read it like any other number.
  const fractionChars = Object.keys(FRACTION_CHARS).join('');
  const clean = decoded.replace(
    new RegExp(`(\\d+)?\\s*([${fractionChars}])`),
    (_, whole, frac) => String((whole ? Number(whole) : 0) + FRACTION_CHARS[frac])
  );

  // e.g. "2 1/2 cups flour", "500g ground beef", "1 onion, diced"
  const match = clean.match(/^([\d.\/\s]+)?\s*([a-zA-Z]+)?\s+(.*)$/);
  if (!match) return { name: clean, qty: null, unit: null, component: 'other' };

  let [, qtyRaw, maybeUnit, rest] = match;
  let qty = null;
  if (qtyRaw) {
    qtyRaw = qtyRaw.trim();
    if (qtyRaw.includes('/')) {
      const [num, denom] = qtyRaw.split('/').map(Number);
      qty = denom ? Number((num / denom).toFixed(2)) : null;
    } else if (qtyRaw) {
      qty = Number(qtyRaw.split(' ')[0]);
    }
    if (Number.isNaN(qty)) qty = null;
  }

  let unit = null;
  let name = rest;
  if (maybeUnit && UNIT_RE.test(maybeUnit)) {
    unit = maybeUnit.toLowerCase();
  } else if (maybeUnit) {
    name = `${maybeUnit} ${rest}`.trim();
  }

  return { name: name || clean, qty, unit, component: 'other' };
}

function jsonLdToRecipeDraft(ld, sourceUrl) {
  const ingredients = (ld.recipeIngredient || ld.ingredients || []).map(parseIngredientLine);
  const nutrition = ld.nutrition || {};

  return {
    name: decodeEntities(ld.name) || 'Imported recipe',
    protein: null,
    method: null,
    feeds: parseYield(ld.recipeYield) || 4,
    macrosPerServing: {
      kcal: parseNutritionNumber(nutrition.calories),
      protein: parseNutritionNumber(nutrition.proteinContent),
      carbs: parseNutritionNumber(nutrition.carbohydrateContent),
      fat: parseNutritionNumber(nutrition.fatContent),
    },
    ingredients,
    steps: flattenInstructions(ld.recipeInstructions),
    notes: [],
    flags: { shelfLife: null, freezeFriendly: false },
    sourceUrl,
  };
}

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|li|div|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

module.exports = { findJsonLdRecipe, jsonLdToRecipeDraft, stripHtmlToText };
