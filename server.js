// Local development server for the Unhangry Assistant.
// No framework, no npm install — just Node's built-ins. Run with: node server.js
//
// Besides serving the static app, this handles:
//   GET  /api/recipes        — reads every .json file in /recipes and returns them
//   GET  /api/config         — tells the frontend whether AI import is available
//   POST /api/import/url     — fetch a recipe page, extract structured data
//   POST /api/import/photo   — send a recipe photo to Claude for transcription
//   POST /api/import/text    — send pasted recipe text to Claude for structuring
//   POST /api/recipes        — save a reviewed recipe draft as a real recipe file
//   GET  /api/household       — read the saved household profile (data/household.json)
//   POST /api/household       — save the household profile (members, rules, schedule, roles)
//   POST /api/generate-list       — one call: scales this week's picks into a grocery
//                                     list, AI Advice (snack gap-filling), and Weigh & Pack
//   GET    /api/saved-weeks    — list saved weeks (data/saved-weeks/*.json)
//   POST   /api/saved-weeks    — save a generated week (list + notes) for later reference
//   DELETE /api/saved-weeks    — remove a saved week (body: { id })

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./lib/env');
loadEnv();

const claude = require('./lib/claude');
const { findJsonLdRecipe, jsonLdToRecipeDraft, stripHtmlToText } = require('./lib/html-recipe');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const RECIPES_DIR = path.join(ROOT, 'recipes');
const PHOTO_DRAFTS_DIR = path.join(RECIPES_DIR, '_photo-drafts');
const DATA_DIR = path.join(ROOT, 'data');
const HOUSEHOLD_FILE = path.join(DATA_DIR, 'household.json');
const SAVED_WEEKS_DIR = path.join(DATA_DIR, 'saved-weeks');

const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15MB — enough for a photo as base64

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

const VALID_PROTEINS = ['beef', 'chicken', 'seafood', 'veggie'];
const VALID_METHODS = ['air-fryer', 'oven', 'stovetop', 'no-cook'];
const VALID_MEAL_TYPES = ['main', 'breakfast', 'snack'];
const VALID_COMPONENTS = ['protein', 'carb', 'sauce', 'aromatic', 'other'];
const VALID_PRIMARY_MACROS = ['protein', 'carb', 'fat'];

const VALID_GOALS = [
  'save-time', 'save-money', 'lose-weight', 'gain-muscle',
  'maintain-weight', 'eat-cleaner', 'feed-family', 'medical',
];
const VALID_ACTIVITY = ['not-active', 'light', 'moderate', 'very-active', 'training'];
const DEFAULT_HOUSEHOLD = {
  members: [],
  familyRules: [],
  individualRules: [],
  cookSchedule: { cookDays: 5, breakfastDays: 5 },
  roles: { planner: null, shopper: null, cook: null },
};

// ---------------- helpers ----------------

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function loadAllRecipes() {
  const files = fs.readdirSync(RECIPES_DIR).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  );
  const recipes = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8');
      recipes.push(JSON.parse(raw));
    } catch (err) {
      console.error(`Skipping ${file} — invalid JSON: ${err.message}`);
    }
  }
  return recipes;
}

function slugify(name) {
  return String(name || 'recipe')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'recipe';
}

function uniqueId(base) {
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(RECIPES_DIR, `${id}.json`))) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function normalizeRecipeForSave(input) {
  const num = (v, fallback = 0) => (typeof v === 'number' && !Number.isNaN(v) ? v : fallback);

  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Recipe name is required'), { statusCode: 400 });

  const protein = VALID_PROTEINS.includes(input.protein) ? input.protein : 'veggie';
  const method = VALID_METHODS.includes(input.method) ? input.method : 'stovetop';
  const mealType = VALID_MEAL_TYPES.includes(input.mealType) ? input.mealType : 'main';

  const ingredients = Array.isArray(input.ingredients) ? input.ingredients.map((ing) => ({
    name: String(ing.name || '').trim(),
    qty: typeof ing.qty === 'number' ? ing.qty : (ing.qty ? Number(ing.qty) : null),
    unit: ing.unit ? String(ing.unit).trim() : null,
    component: VALID_COMPONENTS.includes(ing.component) ? ing.component : 'other',
    ...(ing.buyVsMake && ing.buyVsMake.buy && ing.buyVsMake.make ? { buyVsMake: ing.buyVsMake } : {}),
  })).filter((i) => i.name) : [];

  const id = uniqueId(slugify(name));
  const macrosPerServing = {
    kcal: num(input?.macrosPerServing?.kcal),
    protein: num(input?.macrosPerServing?.protein),
    carbs: num(input?.macrosPerServing?.carbs),
    fat: num(input?.macrosPerServing?.fat),
  };

  return {
    id,
    name,
    protein,
    method,
    mealType,
    // Only meaningful for snacks — AI Advice uses it to match a snack to
    // whichever macro a person is short on. Infer from the dominant macro
    // (by calorie contribution) if the client didn't send a valid one.
    ...(mealType === 'snack' ? { primaryMacro: inferPrimaryMacro(input.primaryMacro, macrosPerServing) } : {}),
    feeds: num(input.feeds, 4),
    macrosPerServing,
    ingredients,
    steps: Array.isArray(input.steps) ? input.steps.map(String).filter(Boolean) : [],
    notes: Array.isArray(input.notes) ? input.notes.map(String).filter(Boolean) : [],
    flags: {
      shelfLife: input?.flags?.shelfLife || null,
      freezeFriendly: Boolean(input?.flags?.freezeFriendly),
    },
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
  };
}

function inferPrimaryMacro(provided, macrosPerServing) {
  if (VALID_PRIMARY_MACROS.includes(provided)) return provided;
  const proteinCals = (macrosPerServing.protein || 0) * 4;
  const carbCals = (macrosPerServing.carbs || 0) * 4;
  const fatCals = (macrosPerServing.fat || 0) * 9;
  const max = Math.max(proteinCals, carbCals, fatCals);
  if (max === 0) return 'carb'; // no macro data at all — harmless default
  if (max === fatCals) return 'fat';
  if (max === proteinCals) return 'protein';
  return 'carb';
}

function loadHousehold() {
  if (!fs.existsSync(HOUSEHOLD_FILE)) return DEFAULT_HOUSEHOLD;
  try {
    return JSON.parse(fs.readFileSync(HOUSEHOLD_FILE, 'utf8'));
  } catch (err) {
    console.error(`household.json is invalid JSON (${err.message}) — returning an empty household.`);
    return DEFAULT_HOUSEHOLD;
  }
}

function normalizeMember(input, index) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error(`Member #${index + 1} needs a name.`), { statusCode: 400 });
  if (!input.dob) throw Object.assign(new Error(`"${name}" needs a date of birth.`), { statusCode: 400 });

  const isChild = Boolean(input.isChild);
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v)) ?? null;

  return {
    id: input.id || `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    dob: String(input.dob),
    isChild,
    gender: ['female', 'male'].includes(input.gender) ? input.gender : '',
    heightCm: isChild ? null : num(input.heightCm),
    weightKg: isChild ? null : num(input.weightKg),
    goals: isChild ? [] : (Array.isArray(input.goals) ? input.goals.filter((g) => VALID_GOALS.includes(g)) : []),
    activityLevel: isChild ? null : (VALID_ACTIVITY.includes(input.activityLevel) ? input.activityLevel : null),
    medicalConditions: isChild ? '' : String(input.medicalConditions || '').trim(),
    cycleTracking: isChild ? false : Boolean(input.cycleTracking),
    bodyComposition: (!isChild && input.bodyComposition && num(input.bodyComposition.leanMassKg))
      ? { leanMassKg: num(input.bodyComposition.leanMassKg) }
      : null,
    calorieTarget: isChild ? null : num(input.calorieTarget),
  };
}

function normalizeHousehold(input) {
  const members = Array.isArray(input.members) ? input.members.map(normalizeMember) : [];
  const memberIds = new Set(members.map((m) => m.id));
  const validRoleValue = (v) => (v && memberIds.has(v) ? v : null);

  return {
    members,
    familyRules: Array.isArray(input.familyRules) ? input.familyRules.map(String).map((s) => s.trim()).filter(Boolean) : [],
    individualRules: Array.isArray(input.individualRules) ? input.individualRules
      .filter((r) => r && memberIds.has(r.memberId) && String(r.note || '').trim())
      .map((r) => ({ memberId: r.memberId, note: String(r.note).trim() }))
      : [],
    cookSchedule: {
      cookDays: Math.min(7, Math.max(1, Number(input?.cookSchedule?.cookDays) || 5)),
      breakfastDays: Math.min(7, Math.max(0, Number(input?.cookSchedule?.breakfastDays) || 0)),
    },
    roles: {
      planner: validRoleValue(input?.roles?.planner),
      shopper: validRoleValue(input?.roles?.shopper),
      cook: validRoleValue(input?.roles?.cook),
    },
  };
}

async function handleGetHousehold(req, res) {
  return sendJSON(res, 200, loadHousehold());
}

async function handleSaveHousehold(req, res) {
  const input = await readJsonBody(req);
  let household;
  try {
    household = normalizeHousehold(input);
  } catch (err) {
    return sendJSON(res, err.statusCode || 400, { error: 'invalid-household', message: err.message });
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HOUSEHOLD_FILE, JSON.stringify(household, null, 2) + '\n');

  return sendJSON(res, 200, { status: 'saved', household });
}

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

// ---------------- route handlers ----------------

async function handleImportUrl(req, res) {
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
      return sendJSON(res, 502, { error: 'fetch-failed', message: `The site responded with ${pageRes.status}.` });
    }
    html = await pageRes.text();
  } catch (err) {
    return sendJSON(res, 502, { error: 'fetch-failed', message: `Couldn't reach that page (${err.message}).` });
  }

  const ld = findJsonLdRecipe(html);
  if (ld) {
    const recipe = jsonLdToRecipeDraft(ld, parsed.toString());
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
}

async function handleImportPhoto(req, res) {
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

  // No API key — save the photo so it isn't lost, and ask for manual entry.
  fs.mkdirSync(PHOTO_DRAFTS_DIR, { recursive: true });
  const ext = mimeType.split('/')[1] || 'jpg';
  const filename = `${Date.now()}-${slugify(name || 'recipe-photo')}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DRAFTS_DIR, filename), Buffer.from(imageBase64, 'base64'));

  return sendJSON(res, 200, {
    status: 'needs-manual',
    savedAs: `recipes/_photo-drafts/${filename}`,
    message: 'No AI key configured yet (see .env.example) — saved the photo to recipes/_photo-drafts/ so you can transcribe it into the fields below or add it later.',
  });
}

async function handleImportText(req, res) {
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
}

async function handleSaveRecipe(req, res) {
  const input = await readJsonBody(req);
  let recipe;
  try {
    recipe = normalizeRecipeForSave(input);
  } catch (err) {
    return sendJSON(res, err.statusCode || 400, { error: 'invalid-recipe', message: err.message });
  }

  fs.writeFileSync(
    path.join(RECIPES_DIR, `${recipe.id}.json`),
    JSON.stringify(recipe, null, 2) + '\n'
  );

  return sendJSON(res, 201, { status: 'saved', recipe });
}

async function handleGenerateList(req, res) {
  if (!claude.hasApiKey()) {
    return sendJSON(res, 200, {
      status: 'unavailable',
      message: 'Add ANTHROPIC_API_KEY to .env to generate the list — see README.md.',
    });
  }

  const input = await readJsonBody(req);
  const { mains, breakfast, snacks, buyVsMake, weeklyAdjustments } = input;

  if (!Array.isArray(mains) || mains.length !== 3 || mains.some((m) => !m || !m.recipe)) {
    return sendJSON(res, 400, { error: 'incomplete-mains', message: 'Pick all 3 mains (one per method) first.' });
  }

  const household = loadHousehold();
  if (household.members.length === 0) {
    return sendJSON(res, 400, { error: 'no-members', message: 'Add at least one household member in the Family Hub first.' });
  }

  // The full snack catalog, not just whatever the user added to Snacks & Sides
  // this week — AI Advice picks freely from every snack in the database to
  // fill macro gaps, per mealType "snack".
  const availableSnacks = loadAllRecipes().filter((r) => r.mealType === 'snack');

  const week = {
    household,
    mains,
    breakfast: breakfast || null,
    snacks: Array.isArray(snacks) ? snacks : [],
    availableSnacks,
    buyVsMake: Array.isArray(buyVsMake) ? buyVsMake : [],
    weeklyAdjustments: Array.isArray(weeklyAdjustments) ? weeklyAdjustments : [],
  };

  // Two calls, run concurrently. The grocery list is the critical path — if
  // it fails, the whole request fails. AI Advice + Weigh & Pack are
  // best-effort supplementary: if that call fails, still return the grocery
  // list successfully with a note, rather than blocking the whole "Generate
  // The List" action on it.
  const [groceryResult, adviceResult] = await Promise.allSettled([
    claude.generateGroceryList(week),
    claude.generateAdvicePack(week),
  ]);

  if (groceryResult.status === 'rejected') {
    console.error('Grocery list generation failed:', groceryResult.reason.message);
    return sendJSON(res, 502, { error: 'generation-failed', message: `Couldn't generate the list (${groceryResult.reason.message}). Try again.` });
  }

  const list = groceryResult.value;
  if (adviceResult.status === 'fulfilled') {
    const { aiAdvice, weighAndPack } = adviceResult.value;
    list.aiAdvice = Array.isArray(aiAdvice) ? aiAdvice : [];
    list.weighAndPack = Array.isArray(weighAndPack) ? weighAndPack : [];
  } else {
    console.error('AI Advice / Weigh & Pack generation failed:', adviceResult.reason.message);
    list.aiAdvice = [];
    list.weighAndPack = [];
    list.adviceError = `Couldn't build AI Advice / Weigh & Pack (${adviceResult.reason.message}). The grocery list above is still correct — try generating again for these two sections.`;
  }

  return sendJSON(res, 200, { status: 'ok', list });
}

// ---------------- saved weeks ----------------

function loadSavedWeeks() {
  fs.mkdirSync(SAVED_WEEKS_DIR, { recursive: true });
  const files = fs.readdirSync(SAVED_WEEKS_DIR).filter((f) => f.endsWith('.json'));
  const weeks = [];
  for (const file of files) {
    try {
      weeks.push(JSON.parse(fs.readFileSync(path.join(SAVED_WEEKS_DIR, file), 'utf8')));
    } catch (err) {
      console.error(`Skipping ${file} — invalid JSON: ${err.message}`);
    }
  }
  weeks.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  return weeks;
}

function normalizeSavedWeek(input) {
  if (!input.list || !Array.isArray(input.list.categories)) {
    throw Object.assign(new Error('No grocery list to save — generate one first.'), { statusCode: 400 });
  }

  const name = String(input.name || '').trim() || `Week of ${new Date().toLocaleDateString()}`;
  const id = uniqueSavedWeekId(slugify(name));

  return {
    id,
    name,
    savedAt: new Date().toISOString(),
    selections: {
      mains: Array.isArray(input.selections?.mains) ? input.selections.mains.map((m) => ({
        method: String(m.method || ''), recipeName: String(m.recipeName || ''),
      })) : [],
      breakfast: input.selections?.breakfast ? { recipeName: String(input.selections.breakfast.recipeName || '') } : null,
      snacks: Array.isArray(input.selections?.snacks) ? input.selections.snacks.map((s) => ({
        recipeName: String(s.recipeName || ''),
      })) : [],
    },
    list: input.list,
    notes: {
      sprintDuration: String(input.notes?.sprintDuration || '').trim(),
      wentWell: String(input.notes?.wentWell || '').trim(),
      wentHard: String(input.notes?.wentHard || '').trim(),
      general: String(input.notes?.general || '').trim(),
    },
  };
}

function uniqueSavedWeekId(base) {
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(SAVED_WEEKS_DIR, `${id}.json`))) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

async function handleGetSavedWeeks(req, res) {
  return sendJSON(res, 200, loadSavedWeeks());
}

async function handleSaveSavedWeek(req, res) {
  const input = await readJsonBody(req);
  let week;
  try {
    week = normalizeSavedWeek(input);
  } catch (err) {
    return sendJSON(res, err.statusCode || 400, { error: 'invalid-week', message: err.message });
  }

  fs.mkdirSync(SAVED_WEEKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SAVED_WEEKS_DIR, `${week.id}.json`), JSON.stringify(week, null, 2) + '\n');

  return sendJSON(res, 201, { status: 'saved', week });
}

async function handleDeleteSavedWeek(req, res) {
  const { id } = await readJsonBody(req);
  if (!id) return sendJSON(res, 400, { error: 'missing-id', message: 'No week id given.' });

  const filePath = path.join(SAVED_WEEKS_DIR, `${path.basename(String(id))}.json`);
  if (!fs.existsSync(filePath)) return sendJSON(res, 404, { error: 'not-found', message: 'That saved week no longer exists.' });

  fs.unlinkSync(filePath);
  return sendJSON(res, 200, { status: 'deleted' });
}

// ---------------- server ----------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/recipes' && req.method === 'GET') {
      return sendJSON(res, 200, loadAllRecipes());
    }
    if (url.pathname === '/api/recipes' && req.method === 'POST') {
      return await handleSaveRecipe(req, res);
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return sendJSON(res, 200, { aiImportEnabled: claude.hasApiKey() });
    }
    if (url.pathname === '/api/household' && req.method === 'GET') {
      return await handleGetHousehold(req, res);
    }
    if (url.pathname === '/api/household' && req.method === 'POST') {
      return await handleSaveHousehold(req, res);
    }
    if (url.pathname === '/api/import/url' && req.method === 'POST') {
      return await handleImportUrl(req, res);
    }
    if (url.pathname === '/api/import/photo' && req.method === 'POST') {
      return await handleImportPhoto(req, res);
    }
    if (url.pathname === '/api/import/text' && req.method === 'POST') {
      return await handleImportText(req, res);
    }
    if (url.pathname === '/api/generate-list' && req.method === 'POST') {
      return await handleGenerateList(req, res);
    }
    if (url.pathname === '/api/saved-weeks' && req.method === 'GET') {
      return await handleGetSavedWeeks(req, res);
    }
    if (url.pathname === '/api/saved-weeks' && req.method === 'POST') {
      return await handleSaveSavedWeek(req, res);
    }
    if (url.pathname === '/api/saved-weeks' && req.method === 'DELETE') {
      return await handleDeleteSavedWeek(req, res);
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
