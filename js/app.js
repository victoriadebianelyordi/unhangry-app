// Unhangry Assistant — Screen 1: The Database
// Loads recipes from /api/recipes (served by server.js from the /recipes folder),
// renders the filterable grid, and drives the recipe detail modal.

const PROTEIN_META = {
  beef: { icon: '🥩', label: 'Beef' },
  chicken: { icon: '🍗', label: 'Chicken' },
  seafood: { icon: '🐟', label: 'Seafood' },
  veggie: { icon: '🥦', label: 'Veggie' },
};

// Snacks are filtered/iconed by their primary macro, not protein type —
// filtering by protein type doesn't make sense for a rice cake or a shake.
const MACRO_META = {
  protein: { icon: '💪', label: 'Protein' },
  carb: { icon: '🍞', label: 'Carb' },
  fat: { icon: '🥑', label: 'Fat' },
};

// Exactly 3 valid method values — every recipe (main, breakfast, or snack) is tagged with
// one of these. "third-spot" is the catch-all for anything that isn't a literal stovetop
// pot or an oven bake (air fryer, no-cook, rice cooker, grill, whatever) — see
// methodMatchesSlot below for how this doubles as a Sunday-batch slot key for mains.
const METHOD_LABEL = {
  'stovetop': 'Stovetop',
  'oven': 'Oven',
  'third-spot': 'The Third Spot',
};

let ALL_RECIPES = [];
let activeSection = 'main'; // 'main' | 'breakfast' | 'snack'
let activeProtein = 'all';
let activeMacro = 'all';

// ---------------- local storage (per-device persistence) ----------------
// Household, saved weeks, and admin-added recipes all live in the browser's
// localStorage — each household uses the app on its own device, so there's
// no need for server-side storage (or a backend database) for any of it.

const LS_KEYS = {
  household: 'unhangry_household',
  savedWeeks: 'unhangry_saved_weeks',
  localRecipes: 'unhangry_local_recipes',
};

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`Could not read ${key} from localStorage:`, err);
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error(`Could not save ${key} to localStorage:`, err);
    throw new Error('Could not save — your browser may be blocking local storage (private/incognito mode?).');
  }
}

// ---------------- data loading ----------------

async function loadRecipes() {
  let serverRecipes = [];
  try {
    const res = await fetch('/api/recipes');
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    serverRecipes = await res.json();
  } catch (err) {
    console.error('Could not load recipes:', err);
    document.getElementById('recipe-grid').innerHTML =
      `<p class="empty-state">Couldn't load the built-in recipe database — showing anything saved on this device instead.</p>`;
  }
  const localRecipes = lsGet(LS_KEYS.localRecipes, []);
  ALL_RECIPES = [...serverRecipes, ...localRecipes];
  ALL_RECIPES.sort((a, b) => a.name.localeCompare(b.name));
  renderGrid();
}

// ---------------- rendering ----------------

function renderGrid() {
  const grid = document.getElementById('recipe-grid');
  const empty = document.getElementById('recipe-empty');

  let list = ALL_RECIPES.filter((r) => (r.mealType || 'main') === activeSection);
  if (activeSection === 'main' && activeProtein !== 'all') {
    list = list.filter((r) => r.protein === activeProtein);
  }
  if (activeSection === 'snack' && activeMacro !== 'all') {
    list = list.filter((r) => r.primaryMacro === activeMacro);
  }

  grid.innerHTML = '';

  if (list.length === 0) {
    empty.hidden = false;
    empty.textContent = EMPTY_STATE_TEXT[activeSection] || 'No recipes here yet.';
    return;
  }
  empty.hidden = true;

  for (const recipe of list) {
    grid.appendChild(renderCard(recipe));
  }
}

const EMPTY_STATE_TEXT = {
  main: 'No lunch/dinner recipes match that filter yet.',
  breakfast: 'No breakfasts saved yet — add one with "+ Add a recipe".',
  snack: 'No snacks or sides saved yet — add one with "+ Add a recipe".',
};

function cardMeta(recipe) {
  if (recipe.mealType === 'breakfast') {
    return { icon: '🍳', label: 'Breakfast' };
  }
  if (recipe.mealType === 'snack') {
    const macro = MACRO_META[recipe.primaryMacro];
    return { icon: macro ? macro.icon : '🥨', label: macro ? `${macro.label} Snack` : 'Snack / Side' };
  }
  return PROTEIN_META[recipe.protein] || { icon: '🍽️', label: recipe.protein };
}

function renderCard(recipe) {
  const meta = cardMeta(recipe);
  const m = recipe.macrosPerServing || {};

  const card = document.createElement('button');
  card.className = 'recipe-card';
  card.type = 'button';
  card.innerHTML = `
    <div class="recipe-card__top">
      <span class="recipe-card__icon">${meta.icon}</span>
      <span class="recipe-card__method">${METHOD_LABEL[recipe.method] || recipe.method}</span>
    </div>
    <div>
      <div class="recipe-card__label">${meta.label}</div>
      <div class="recipe-card__name">${recipe.name}</div>
    </div>
    <div class="recipe-card__flags">${flagIcons(recipe)}</div>
    <div class="recipe-card__macros">
      <span><b>${m.kcal ?? '–'}</b> kcal</span>
      <span><b>${m.protein ?? '–'}g</b> protein</span>
      <span><b>${m.carbs ?? '–'}g</b> carbs</span>
      <span><b>${m.fat ?? '–'}g</b> fat</span>
    </div>
  `;
  card.addEventListener('click', () => openRecipeModal(recipe));
  return card;
}

function flagIcons(recipe) {
  const flags = recipe.flags || {};
  let out = '';
  if (flags.shelfLife) out += '⚠️';
  if (flags.freezeFriendly) out += ' ❄️';
  return out;
}

// ---------------- recipe detail modal ----------------

function openRecipeModal(recipe) {
  const meta = cardMeta(recipe);
  const m = recipe.macrosPerServing || {};
  const body = document.getElementById('recipe-modal-body');

  const ingredientsHTML = (recipe.ingredients || []).map((ing) => `
    <li>
      <div>
        <div>${ing.name}</div>
        <div class="ingredient-component">${ing.component || ''}</div>
        ${ing.buyVsMake ? `<div class="buy-vs-make">Buy: ${ing.buyVsMake.buy}<br>Make: ${ing.buyVsMake.make}</div>` : ''}
      </div>
      <div class="ingredient-qty">${ing.qty ?? ''} ${ing.unit ?? ''}</div>
    </li>
  `).join('');

  const stepsHTML = (recipe.steps || []).map((s) => `<li>${s}</li>`).join('');
  const notesHTML = (recipe.notes || []).map((n) => `<li>${n}</li>`).join('');
  const flags = recipe.flags || {};

  body.innerHTML = `
    <div class="detail-tags">
      <span class="recipe-card__label">${meta.icon} ${meta.label} · ${METHOD_LABEL[recipe.method] || recipe.method}</span>
    </div>
    <h2 class="display-h2">${recipe.name}</h2>
    <p style="color: rgba(23,23,23,0.55); font-size: 13px; margin: 4px 0 0;">Base recipe feeds ${recipe.feeds} — this is a ratio, not a fixed serving count.</p>

    <div class="detail-macros">
      <div><b>${m.kcal ?? '–'}</b><span>kcal / serving</span></div>
      <div><b>${m.protein ?? '–'}g</b><span>protein</span></div>
      <div><b>${m.carbs ?? '–'}g</b><span>carbs</span></div>
      <div><b>${m.fat ?? '–'}g</b><span>fat</span></div>
    </div>

    ${flags.shelfLife ? `<div class="flag-line flag-line--shelf">⚠️ ${flags.shelfLife}</div>` : ''}
    ${flags.freezeFriendly ? `<div class="flag-line flag-line--freeze">❄️ Freeze-friendly</div>` : ''}

    <p class="detail-section-title">Ingredients</p>
    <ul class="ingredient-list">${ingredientsHTML || '<li>No ingredients listed yet.</li>'}</ul>

    <p class="detail-section-title">Method</p>
    <ol class="steps-list">${stepsHTML || '<li>Steps coming soon.</li>'}</ol>

    ${notesHTML ? `<p class="detail-section-title">Notes</p><ul class="notes-list">${notesHTML}</ul>` : ''}

    <div class="modal__actions">
      <button class="btn btn--primary" id="add-to-week-btn">+ Add to this week</button>
    </div>
  `;

  document.getElementById('add-to-week-btn').addEventListener('click', () => {
    showToast(`${recipe.name} saved — you'll pick it when The List is built next.`);
  });

  document.getElementById('recipe-modal').hidden = false;
}

document.getElementById('recipe-modal-close').addEventListener('click', () => {
  document.getElementById('recipe-modal').hidden = true;
});
document.getElementById('recipe-modal').addEventListener('click', (e) => {
  if (e.target.id === 'recipe-modal') document.getElementById('recipe-modal').hidden = true;
});

// ---------------- filters ----------------

document.getElementById('section-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.section-tab');
  if (!btn) return;
  activeSection = btn.dataset.section;
  document.querySelectorAll('.section-tab').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');

  // The protein filter only makes sense for Lunch & Dinners; snacks filter
  // by primary macro instead.
  document.getElementById('protein-filters').hidden = activeSection !== 'main';
  document.getElementById('macro-filters').hidden = activeSection !== 'snack';

  renderGrid();
});

document.getElementById('protein-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  activeProtein = btn.dataset.protein;
  document.querySelectorAll('#protein-filters .chip').forEach((c) => c.classList.remove('is-active'));
  btn.classList.add('is-active');
  renderGrid();
});

document.getElementById('macro-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  activeMacro = btn.dataset.macro;
  document.querySelectorAll('#macro-filters .chip').forEach((c) => c.classList.remove('is-active'));
  btn.classList.add('is-active');
  renderGrid();
});

// ---------------- tab navigation ----------------

document.getElementById('tabnav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tabnav__btn');
  if (!btn) return;
  document.querySelectorAll('.tabnav__btn').forEach((b) => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-active'));
  document.getElementById(`screen-${btn.dataset.screen}`).classList.add('is-active');
  if (btn.dataset.screen === 'list') renderListScreen();
});

// ---------------- importer modal ----------------

let aiImportEnabled = null;

async function checkAiStatus() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    aiImportEnabled = data.aiImportEnabled;
  } catch {
    aiImportEnabled = false;
  }
  const line = document.getElementById('ai-status-line');
  line.hidden = false;
  if (aiImportEnabled) {
    line.textContent = '✓ AI import is on — URL and photo parsing are fully active.';
    line.className = 'ai-status-line';
  } else {
    line.textContent = 'AI import is off (no API key set in .env) — URL import still works for recipe pages with built-in recipe data; photos and messy pages will need manual review.';
    line.className = 'ai-status-line is-off';
  }

  const listLine = document.getElementById('list-ai-status-line');
  listLine.hidden = false;
  if (aiImportEnabled) {
    listLine.textContent = '✓ AI is on — ready to scale and generate the list.';
    listLine.className = 'ai-status-line';
  } else {
    listLine.textContent = 'Add ANTHROPIC_API_KEY to .env to generate the list (see README) — everything else on this screen still works.';
    listLine.className = 'ai-status-line is-off';
  }
  updateGenerateButtonState();
}

document.getElementById('open-importer').addEventListener('click', () => {
  document.getElementById('importer-modal').hidden = false;
  setImporterStatus('');
  if (aiImportEnabled === null) checkAiStatus();
});
document.getElementById('importer-modal-close').addEventListener('click', () => {
  document.getElementById('importer-modal').hidden = true;
});
document.getElementById('importer-modal').addEventListener('click', (e) => {
  if (e.target.id === 'importer-modal') document.getElementById('importer-modal').hidden = true;
});

document.querySelector('.importer-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.importer-tab');
  if (!btn) return;
  document.querySelectorAll('.importer-tab').forEach((t) => t.classList.remove('is-active'));
  btn.classList.add('is-active');
  document.querySelectorAll('.importer-pane').forEach((p) => p.classList.remove('is-active'));
  document.querySelector(`.importer-pane[data-pane="${btn.dataset.method}"]`).classList.add('is-active');
});

// ---------------- import: paste / url / photo ----------------

function setImporterStatus(message, kind) {
  const el = document.getElementById('importer-status');
  if (!message) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = message;
  el.className = `importer-status${kind ? ` is-${kind}` : ''}`;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.status) {
    throw new Error(data.message || `Request failed (${res.status})`);
  }
  return data;
}

function handleImportResult(data, fallbackName) {
  if (data.status === 'structured' || data.status === 'ai-parsed') {
    document.getElementById('importer-modal').hidden = true;
    setImporterStatus('');
    openReviewModal(data.recipe, data.status === 'structured'
      ? 'Pulled straight from the page\'s recipe data — double-check quantities, then save.'
      : 'Parsed by AI — double-check everything, especially quantities and macros, then save.');
    return;
  }
  if (data.status === 'needs-manual') {
    document.getElementById('importer-modal').hidden = true;
    setImporterStatus('');
    const draftRecipe = data.recipe || { name: fallbackName || '' };
    if (data.rawText) draftRecipe.steps = [data.rawText];
    openReviewModal(draftRecipe, data.message);
    return;
  }
  // error shapes from the server: { error, message }
  setImporterStatus(data.message || 'Something went wrong — try again.', 'error');
}

document.getElementById('paste-parse').addEventListener('click', async () => {
  const name = document.getElementById('paste-name').value.trim();
  const text = document.getElementById('paste-textarea').value.trim();
  if (!text) { setImporterStatus('Paste some recipe text first.', 'error'); return; }
  setImporterStatus('Reading it now…', 'loading');
  try {
    const data = await postJSON('/api/import/text', { name, text });
    handleImportResult(data, name);
  } catch (err) {
    setImporterStatus(err.message, 'error');
  }
});

document.getElementById('url-parse').addEventListener('click', async () => {
  const url = document.getElementById('url-input').value.trim();
  if (!url) { setImporterStatus('Paste a link first.', 'error'); return; }
  setImporterStatus('Fetching and reading the page…', 'loading');
  try {
    const data = await postJSON('/api/import/url', { url });
    handleImportResult(data);
  } catch (err) {
    setImporterStatus(err.message, 'error');
  }
});

document.getElementById('photo-parse').addEventListener('click', async () => {
  const fileInput = document.getElementById('photo-input');
  const file = fileInput.files[0];
  if (!file) { setImporterStatus('Choose a photo first.', 'error'); return; }
  setImporterStatus('Reading the photo…', 'loading');
  try {
    const { base64, mimeType } = await fileToBase64(file);
    const data = await postJSON('/api/import/photo', { imageBase64: base64, mimeType, name: file.name });
    handleImportResult(data, file.name);
  } catch (err) {
    setImporterStatus(err.message, 'error');
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // "data:image/png;base64,AAAA..."
      const base64 = result.split(',')[1];
      resolve({ base64, mimeType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------- meal-fit guardrail ----------------
// Flags recipes that don't look like a full lunch/dinner — low protein, low
// calories, or no ingredient tagged as the main protein (dips, sides, snacks
// like guacamole). Runs live in the review form so it updates as fields change.

function assessMealFit({ macrosPerServing, ingredients }) {
  const kcal = Number(macrosPerServing?.kcal) || 0;
  const protein = Number(macrosPerServing?.protein) || 0;
  const namedIngredients = (ingredients || []).filter((i) => i.name && i.name.trim());

  // Nothing meaningful entered yet — nothing to assess.
  if (kcal === 0 && protein === 0 && namedIngredients.length === 0) {
    return { looksLikeSnack: false, reasons: [] };
  }

  const hasProteinIngredient = namedIngredients.some((i) => i.component === 'protein');
  const reasons = [];
  if (namedIngredients.length > 0 && !hasProteinIngredient) {
    reasons.push('none of the ingredients are tagged as the main protein');
  }
  if (kcal > 0 && protein > 0 && protein < 10) {
    reasons.push(`only ${protein}g of protein per serving`);
  }
  if (kcal > 0 && kcal < 250) {
    reasons.push(`only ${kcal} kcal per serving`);
  }

  return { looksLikeSnack: reasons.length > 0, reasons };
}

function updateMealFitAdvisory() {
  const macrosPerServing = {
    kcal: Number(document.getElementById('rf-kcal').value) || 0,
    protein: Number(document.getElementById('rf-protein-g').value) || 0,
  };
  const mealTypeSelect = document.getElementById('rf-mealtype');
  const banner = document.getElementById('meal-fit-advisory');

  // Breakfasts aren't judged against lunch/dinner protein/calorie norms.
  if (mealTypeSelect.value === 'breakfast') {
    banner.hidden = true;
    return;
  }

  const fit = assessMealFit({ macrosPerServing, ingredients: currentIngredients });

  if (!fit.looksLikeSnack) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;

  if (mealTypeSelect.value === 'snack') {
    banner.className = 'meal-fit-advisory is-ok';
    banner.innerHTML = `<strong>Tagged as a snack/side — that fits.</strong>This is lighter than a full lunch or dinner (${fit.reasons.join(', ')}), so it won't be offered when picking the week's 3 mains. It can still work as a side or dip alongside a higher-protein main.`;
    return;
  }

  banner.className = 'meal-fit-advisory';
  banner.innerHTML = `
    <strong>This looks more like a snack or side than a full lunch/dinner.</strong>
    <ul>${fit.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>
    We'd recommend saving it as a Snack, and picking a main with a bit more protein to pair it with.
    <div class="meal-fit-advisory__actions">
      <button type="button" class="btn btn--ghost btn--small" id="meal-fit-switch">Save as Snack instead</button>
    </div>
  `;
  document.getElementById('meal-fit-switch').addEventListener('click', () => {
    mealTypeSelect.value = 'snack';
    updateMealFitAdvisory();
  });
}

document.getElementById('rf-kcal').addEventListener('input', updateMealFitAdvisory);
document.getElementById('rf-protein-g').addEventListener('input', updateMealFitAdvisory);
document.getElementById('rf-mealtype').addEventListener('change', updateMealFitAdvisory);

// ---------------- review / edit form ----------------

let currentIngredients = [];

function openReviewModal(recipe, statusMessage) {
  document.getElementById('rf-name').value = recipe.name || '';
  document.getElementById('rf-feeds').value = recipe.feeds || 4;
  document.getElementById('rf-protein').value = recipe.protein || 'veggie';
  document.getElementById('rf-method').value = recipe.method || 'stovetop';

  const m = recipe.macrosPerServing || {};
  document.getElementById('rf-kcal').value = m.kcal || 0;
  document.getElementById('rf-protein-g').value = m.protein || 0;
  document.getElementById('rf-carbs').value = m.carbs || 0;
  document.getElementById('rf-fat').value = m.fat || 0;

  currentIngredients = (recipe.ingredients || []).map((i) => ({ ...i }));

  const initialFit = assessMealFit({ macrosPerServing: m, ingredients: currentIngredients });
  document.getElementById('rf-mealtype').value = recipe.mealType || (initialFit.looksLikeSnack ? 'snack' : 'main');

  renderIngredientEditor();

  document.getElementById('rf-steps').value = (recipe.steps || []).join('\n');
  document.getElementById('rf-notes').value = (recipe.notes || []).join('\n');

  const flags = recipe.flags || {};
  document.getElementById('rf-shelflife').value = flags.shelfLife || '';
  document.getElementById('rf-freeze').checked = Boolean(flags.freezeFriendly);

  const statusEl = document.getElementById('review-status');
  if (statusMessage) {
    statusEl.hidden = false;
    statusEl.textContent = statusMessage;
    statusEl.className = 'importer-status';
  } else {
    statusEl.hidden = true;
  }

  updateMealFitAdvisory();
  document.getElementById('review-modal').hidden = false;
}

function renderIngredientEditor() {
  const container = document.getElementById('rf-ingredients');
  container.innerHTML = '';
  currentIngredients.forEach((ing, idx) => {
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    row.innerHTML = `
      <input type="text" placeholder="Ingredient name" value="${escapeAttr(ing.name || '')}" data-field="name">
      <input type="number" placeholder="Qty" value="${ing.qty ?? ''}" data-field="qty">
      <input type="text" placeholder="Unit" value="${escapeAttr(ing.unit || '')}" data-field="unit">
      <select data-field="component">
        <option value="protein">Protein</option>
        <option value="carb">Carb</option>
        <option value="sauce">Sauce</option>
        <option value="aromatic">Aromatic</option>
        <option value="other">Other</option>
      </select>
      <button type="button" class="ingredient-row__remove" aria-label="Remove">&times;</button>
    `;
    row.querySelector('select').value = ing.component || 'other';
    row.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', () => {
        currentIngredients[idx][el.dataset.field] = el.type === 'number'
          ? (el.value === '' ? null : Number(el.value))
          : el.value;
        updateMealFitAdvisory();
      });
    });
    row.querySelector('.ingredient-row__remove').addEventListener('click', () => {
      currentIngredients.splice(idx, 1);
      renderIngredientEditor();
    });
    container.appendChild(row);
  });
  updateMealFitAdvisory();
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

document.getElementById('rf-add-ingredient').addEventListener('click', () => {
  currentIngredients.push({ name: '', qty: null, unit: '', component: 'other' });
  renderIngredientEditor();
});

document.getElementById('review-modal-close').addEventListener('click', () => {
  document.getElementById('review-modal').hidden = true;
});
document.getElementById('review-modal').addEventListener('click', (e) => {
  if (e.target.id === 'review-modal') document.getElementById('review-modal').hidden = true;
});

// ---------------- recipe saving (client-side — mirrors the shape the ----
// ---------------- bundled recipe files already use) ----------------

function slugify(name) {
  return String(name || 'recipe')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'recipe';
}

function uniqueRecipeId(base) {
  const existingIds = new Set(ALL_RECIPES.map((r) => r.id));
  let id = base;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

// Only meaningful for snacks — AI Advice uses it to match a snack to
// whichever macro a person is short on. Infer from the dominant macro (by
// calorie contribution) since the review form doesn't collect it directly.
function inferPrimaryMacro(macrosPerServing) {
  const proteinCals = (macrosPerServing.protein || 0) * 4;
  const carbCals = (macrosPerServing.carbs || 0) * 4;
  const fatCals = (macrosPerServing.fat || 0) * 9;
  const max = Math.max(proteinCals, carbCals, fatCals);
  if (max === 0) return 'carb'; // no macro data at all — harmless default
  if (max === fatCals) return 'fat';
  if (max === proteinCals) return 'protein';
  return 'carb';
}

document.getElementById('review-form').addEventListener('submit', (e) => {
  e.preventDefault();

  const name = document.getElementById('rf-name').value.trim();
  if (!name) { showToast('Recipe name is required.'); return; }

  const mealType = document.getElementById('rf-mealtype').value;
  const macrosPerServing = {
    kcal: Number(document.getElementById('rf-kcal').value) || 0,
    protein: Number(document.getElementById('rf-protein-g').value) || 0,
    carbs: Number(document.getElementById('rf-carbs').value) || 0,
    fat: Number(document.getElementById('rf-fat').value) || 0,
  };

  const recipe = {
    id: uniqueRecipeId(slugify(name)),
    name,
    protein: document.getElementById('rf-protein').value,
    method: document.getElementById('rf-method').value,
    mealType,
    ...(mealType === 'snack' ? { primaryMacro: inferPrimaryMacro(macrosPerServing) } : {}),
    feeds: Number(document.getElementById('rf-feeds').value) || 4,
    macrosPerServing,
    ingredients: currentIngredients.filter((i) => i.name && i.name.trim()),
    steps: document.getElementById('rf-steps').value.split('\n').map((s) => s.trim()).filter(Boolean),
    notes: document.getElementById('rf-notes').value.split('\n').map((s) => s.trim()).filter(Boolean),
    flags: {
      shelfLife: document.getElementById('rf-shelflife').value.trim() || null,
      freezeFriendly: document.getElementById('rf-freeze').checked,
    },
  };

  try {
    const localRecipes = lsGet(LS_KEYS.localRecipes, []);
    localRecipes.push(recipe);
    lsSet(LS_KEYS.localRecipes, localRecipes);

    ALL_RECIPES.push(recipe);
    ALL_RECIPES.sort((a, b) => a.name.localeCompare(b.name));
    renderGrid();
    document.getElementById('review-modal').hidden = true;
    showToast(`"${recipe.name}" saved on this device.`);
  } catch (err) {
    showToast(err.message);
  }
});

// ---------------- toast ----------------

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

// ==================================================================
// SCREEN 2 — THE FAMILY HUB
// ==================================================================

const GOALS = [
  { value: 'save-time', icon: '⏱️', label: 'Save time' },
  { value: 'save-money', icon: '💰', label: 'Save money' },
  { value: 'lose-weight', icon: '🔥', label: 'Lose weight' },
  { value: 'gain-muscle', icon: '💪', label: 'Gain muscle' },
  { value: 'maintain-weight', icon: '⚖️', label: 'Maintain weight' },
  { value: 'eat-cleaner', icon: '🥗', label: 'Eat cleaner' },
  { value: 'feed-family', icon: '👨‍👩‍👧', label: 'Feed my family better' },
  { value: 'medical', icon: '🩺', label: 'Managing a health condition' },
];

const ACTIVITY_LEVELS = [
  { value: 'not-active', icon: '🛋️', label: 'Not very active' },
  { value: 'light', icon: '🚶', label: 'Light (1-2x/week)' },
  { value: 'moderate', icon: '🏃', label: 'Moderate (3-4x/week)' },
  { value: 'very-active', icon: '🔥', label: 'Very active (5+/week)' },
  { value: 'training', icon: '🏅', label: 'Training for something specific' },
];

const FITNESS_GOALS = ['lose-weight', 'gain-muscle', 'maintain-weight'];
const ACTIVITY_MULTIPLIER = { 'not-active': 1.2, 'light': 1.375, 'moderate': 1.55, 'very-active': 1.725, 'training': 1.9 };

let HOUSEHOLD = { members: [], familyRules: [], individualRules: [], cookSchedule: { cookDays: 5, breakfastDays: 0 }, roles: {} };
let editingMemberId = null;
let currentGoals = [];
let currentActivity = null;

// ---------------- data loading / saving ----------------

async function loadHousehold() {
  HOUSEHOLD = lsGet(LS_KEYS.household, HOUSEHOLD);

  // Self-heal: a member saved without an id (a bug from before this fix — new members
  // never got one at all) would silently break every id-keyed feature — Individual
  // Rules, Weekly Adjustments, Roles, Cycle Phase — since nothing could ever match them.
  // Backfill on load so any already-saved household repairs itself automatically.
  let needsSave = false;
  for (const m of HOUSEHOLD.members) {
    if (!m.id) { m.id = crypto.randomUUID(); needsSave = true; }
  }
  if (needsSave) lsSet(LS_KEYS.household, HOUSEHOLD);

  renderFamilyHub();
}

async function saveHousehold() {
  lsSet(LS_KEYS.household, HOUSEHOLD);
  renderFamilyHub();
}

// Rules/schedule/roles each fire a save on every small edit. Debouncing
// coalesces rapid edits (e.g. setting 3 role dropdowns back to back) into a
// single write that reads HOUSEHOLD only once everything has settled —
// avoids thrashing localStorage on every keystroke.
let saveDebounceTimer = null;
let saveWaiters = [];

function scheduleSave() {
  return new Promise((resolve, reject) => {
    saveWaiters.push({ resolve, reject });
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(async () => {
      const waiters = saveWaiters;
      saveWaiters = [];
      try {
        await saveHousehold();
        waiters.forEach((w) => w.resolve());
      } catch (err) {
        waiters.forEach((w) => w.reject(err));
      }
    }, 300);
  });
}

// ---------------- calc helpers ----------------

function calcAge(dobStr) {
  if (!dobStr) return null;
  const dob = new Date(dobStr);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

// Calculation Engine Spec v2 Part A.1 — the safety floor is measured against BMR, so it
// needs to be its own value, not buried inside the activity-adjusted estimate below.
function calcBMR({ dob, gender, heightCm, weightKg, leanMassKg }) {
  const age = calcAge(dob);
  if (age == null || !heightCm || !weightKg) return null;
  if (leanMassKg) {
    return 370 + 21.6 * leanMassKg; // Katch-McArdle
  }
  if (gender === 'female') {
    return 10 * weightKg + 6.25 * heightCm - 5 * age - 161; // Mifflin-St Jeor
  }
  return 10 * weightKg + 6.25 * heightCm - 5 * age + 5; // Mifflin-St Jeor (male / unspecified)
}

function calcCalorieEstimate({ dob, gender, heightCm, weightKg, activityLevel, leanMassKg }) {
  const bmr = calcBMR({ dob, gender, heightCm, weightKg, leanMassKg });
  if (bmr == null || !activityLevel) return null;
  return Math.round(bmr * (ACTIVITY_MULTIPLIER[activityLevel] || 1.2));
}

// Calculation Engine Spec v2 Part A — protein multiplier table (g per kg bodyweight), by
// activity level x goal. null = no automatic target for that combination (see the sedentary
// + gain-muscle special case below).
const PROTEIN_MULTIPLIER = {
  'not-active':  { 'lose-weight': 1.4, 'gain-muscle': null, 'maintain-weight': 1.0 },
  'light':       { 'lose-weight': 1.5, 'gain-muscle': 1.6, 'maintain-weight': 1.2 },
  'moderate':    { 'lose-weight': 1.8, 'gain-muscle': 1.8, 'maintain-weight': 1.5 },
  'very-active': { 'lose-weight': 2.0, 'gain-muscle': 2.0, 'maintain-weight': 1.8 },
  // Athlete/event numbers are provisional planning targets needing sport-specific review —
  // the athleteFlag this returns must be stated explicitly wherever these targets are used.
  'training':    { 'lose-weight': 2.0, 'gain-muscle': 2.0, 'maintain-weight': 1.8 },
};

// Picks the protein multiplier for a member's activity level + selected fitness goal(s).
// When more than one fitness goal is selected, uses the highest qualifying multiplier among
// them — never under-shoots protein for someone who picked both, say, lose-weight and
// maintain-weight.
function pickProteinMultiplier(activityLevel, goals) {
  const row = PROTEIN_MULTIPLIER[activityLevel];
  if (!row) return null;
  const selected = FITNESS_GOALS.filter((g) => goals.includes(g));
  if (selected.length === 0) return null;

  let sedentaryMuscleGainFlag = false;
  let multiplier = null;
  for (const goal of selected) {
    let m = row[goal];
    if (m == null && goal === 'gain-muscle' && activityLevel === 'not-active') {
      // Muscle gain needs a training stimulus — no automatic target for sedentary. Fall
      // back to maintain protein and flag it, per spec.
      m = PROTEIN_MULTIPLIER['not-active']['maintain-weight'];
      sedentaryMuscleGainFlag = true;
    }
    if (m != null && (multiplier == null || m > multiplier)) multiplier = m;
  }
  return { multiplier, sedentaryMuscleGainFlag, athleteFlag: activityLevel === 'training' };
}

// Calculation Engine Spec v2 Part A steps 2-4: protein (bodyweight x multiplier, not a
// percentage), fat (% of daily kcal, by activity), carbs (whatever's left). Returns null
// when there's no qualifying fitness goal to derive a multiplier from.
function calcMacroTargets({ activityLevel, goals, weightKg, dailyKcal }) {
  if (!weightKg || !dailyKcal) return null;
  const picked = pickProteinMultiplier(activityLevel, goals || []);
  if (!picked || picked.multiplier == null) return null;

  const proteinG = Math.round(weightKg * picked.multiplier);
  const proteinKcal = proteinG * 4;
  const fatPct = (activityLevel === 'very-active' || activityLevel === 'training') ? 0.20 : 0.30;
  const fatG = Math.round((dailyKcal * fatPct) / 9);
  const fatKcal = fatG * 9;
  const carbG = Math.max(0, Math.round((dailyKcal - proteinKcal - fatKcal) / 4));

  return {
    proteinG, fatG, carbG,
    sedentaryMuscleGainFlag: picked.sedentaryMuscleGainFlag,
    athleteFlag: picked.athleteFlag,
  };
}

// Calculation Engine Spec v2 Part A.1 — the safety floor. Hard: a target below BMR is
// refused outright, not overridable. Soft: a target more than 500 kcal under maintenance
// (but still >= BMR) is allowed but flagged as aggressive.
function assessSafetyFloor({ calorieTarget, bmr, maintenanceKcal }) {
  if (!calorieTarget || !bmr) return { status: 'ok' };
  const roundedBmr = Math.round(bmr);
  if (calorieTarget < roundedBmr) {
    return {
      status: 'refused',
      message: `${roundedBmr} kcal/day is roughly what their body burns at rest — a target of ${calorieTarget} is below that, and it'll backfire rather than help. Please don't set it this low; message Vic on WhatsApp if you'd like to talk through a safe plan instead.`,
    };
  }
  if (maintenanceKcal && calorieTarget < maintenanceKcal - 500) {
    return {
      status: 'aggressive',
      message: `That's a fairly aggressive deficit — more than 500 kcal below maintenance. It'll work, but it's a harder pace to sustain, so keep an eye on energy and adjust if it's too much.`,
    };
  }
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------------------
// Point 1 rebuild — child calorie/macro system.
//
// The old approach (a flat 0.5/0.6/0.7 age-banded discount applied to whatever an adult's
// maintain-weight target or a recipe's serving happened to be) was flagged as "entirely
// false thinking and borderline dangerous" and scratched entirely. Replaced with the exact
// Estimated Energy Requirement (EER) equations Health Canada publishes for children and
// adolescents — coded in, not looked up by an LLM at request time.
//
// Source: Health Canada, "Dietary reference intakes tables: Equations to estimate energy
// requirement", page dated 2025-11-19 —
// https://www.canada.ca/en/health-canada/services/food-nutrition/healthy-eating/dietary-reference-intakes/tables/equations-estimate-energy-requirement.html
// (fetched and coefficients transcribed directly from that page; verify against the source
// if Health Canada revises it).
//
// The base age/height/weight coefficients are IDENTICAL across all three bands this app
// uses (4-<9, 9-<14, 14-<19) — only the "energy deposition for growth" constant differs by
// band and sex. So one set of 8 equations (4 activity categories x 2 sexes) covers all
// three bands; only CHILD_GROWTH_KCAL varies.
const CHILD_EER_COEFFICIENTS = {
  male: {
    inactive:   { base: -447.51, age: 3.68, height: 13.01, weight: 13.15 },
    lowActive:  { base: 19.12,   age: 3.68, height: 8.62,  weight: 20.28 },
    active:     { base: -388.19, age: 3.68, height: 12.66, weight: 20.46 },
    veryActive: { base: -671.75, age: 3.68, height: 15.38, weight: 23.25 },
  },
  female: {
    inactive:   { base: 55.59,   age: -22.25, height: 8.43,  weight: 17.07 },
    lowActive:  { base: -297.54, age: -22.25, height: 12.77, weight: 14.73 },
    active:     { base: -189.55, age: -22.25, height: 11.74, weight: 18.34 },
    veryActive: { base: -709.59, age: -22.25, height: 18.22, weight: 14.25 },
  },
};

// Growth-energy constant (kcal), added on top of the base equation — varies by age band
// and sex per Health Canada's table. Ages below 4 are refused entirely (see
// assessChildAgeGuardrail) — the 3-<4 band's constants aren't needed here.
function childGrowthKcal(age, gender) {
  const isFemale = gender === 'female';
  if (age < 9) return isFemale ? 15 : 15;   // 4 to <9 years
  if (age < 14) return isFemale ? 30 : 25;  // 9 to <14 years
  return isFemale ? 20 : 20;                // 14 to <19 years
}

// This app's 5 activity levels map onto Health Canada's 4 PA CAT buckets — "training"
// folds into "veryActive" the same way it already does in PROTEIN_MULTIPLIER for adults.
const CHILD_PA_CAT = {
  'not-active': 'inactive', 'light': 'lowActive', 'moderate': 'active',
  'very-active': 'veryActive', 'training': 'veryActive',
};

// Health Canada / IOM RDA protein-by-age table (screenshot supplied directly, g/day) — the
// protein side of a child's target, independent of the EER calorie math.
function childProteinRDA(age, gender) {
  if (age < 9) return 19;   // 4-8 years
  if (age < 14) return 34;  // 9-13 years
  return gender === 'female' ? 46 : 52; // 14-18 years
}

// Part A.1-equivalent guardrail for children: below age 4, Health Canada's own equations
// don't apply the way this app would need them to (infant/toddler energy needs are a
// pediatric matter, not a meal-prep calculation), so the app refuses outright rather than
// silently computing something. 4 through 18.99 is the EER child system below; 19+ is the
// existing adult system.
function assessChildAgeGuardrail(age) {
  if (age == null) return { status: 'unknown' };
  if (age < 4) return { status: 'toddler', message: 'Meals for toddlers should only be raised with your pediatrician.' };
  if (age < 19) return { status: 'child' };
  return { status: 'adult' };
}

// Point 1 rebuild: a child's calorie target is Health Canada's own EER equation for their
// age/sex/activity — not a discount on an adult formula or a recipe serving. Protein comes
// from the RDA-by-age table; fat is a flat 30% of that EER total; carbs are the remainder.
// Deliberately "flexible, not exact" per the brief — this is a healthy-caloric-intake
// check, not a bulking/cutting macro target, so mealEngine.js's protein reallocation (B6)
// skips children entirely (see the isChild guard there) and only the calorie side (B5)
// drives their portion scaling.
function computeChildTarget({ dob, gender, heightCm, weightKg, activityLevel }) {
  const age = calcAge(dob);
  const guardrail = assessChildAgeGuardrail(age);
  if (guardrail.status !== 'child') return { calorieTarget: null, macroTargets: null, guardrail };
  if (!heightCm || !weightKg || !activityLevel) return { calorieTarget: null, macroTargets: null, guardrail };

  const sexKey = gender === 'female' ? 'female' : 'male'; // same "not specified -> male formula" fallback as calcBMR
  const paCat = CHILD_PA_CAT[activityLevel] || 'lowActive';
  const eq = CHILD_EER_COEFFICIENTS[sexKey][paCat];
  const growth = childGrowthKcal(age, sexKey);
  const eer = Math.round(eq.base + eq.age * age + eq.height * heightCm + eq.weight * weightKg + growth);

  const proteinG = childProteinRDA(age, sexKey);
  const fatG = Math.round((eer * 0.30) / 9);
  const carbG = Math.max(0, Math.round((eer - proteinG * 4 - fatG * 9) / 4));

  return { calorieTarget: eer, macroTargets: { proteinG, fatG, carbG }, guardrail };
}

// Part B, Point 3 fix (adults) / Point 1 rebuild (children): every member — child or
// adult, fitness goal or not — gets a real computed target, not just people who explicitly
// picked a fitness goal. This is what the generate-list engine actually scales portions
// against for everyone; the Family Hub UI only ever *surfaces* it (the editable calorie
// box) for fitness-goal adults — for children and convenience-goal adults it's computed
// and stored silently. Children are routed to the EER system above entirely — never the
// adult maintain-weight formula.
function computeBackendTarget({ dob, gender, heightCm, weightKg, activityLevel, leanMassKg, isChild }) {
  if (isChild) {
    const child = computeChildTarget({ dob, gender, heightCm, weightKg, activityLevel });
    return { calorieTarget: child.calorieTarget, macroTargets: child.macroTargets };
  }

  const estimate = calcCalorieEstimate({ dob, gender, heightCm, weightKg, activityLevel, leanMassKg });
  if (!estimate || !weightKg) return { calorieTarget: null, macroTargets: null };

  // Uses the "maintain weight" row of the protein table — a convenience-goal adult isn't
  // cutting or bulking, so maintenance is the sensible default.
  const macros = calcMacroTargets({ activityLevel, goals: ['maintain-weight'], weightKg, dailyKcal: estimate });
  return { calorieTarget: estimate, macroTargets: macros || null };
}

// ---------------- rendering: whole hub ----------------

function renderFamilyHub() {
  renderMembers();
  renderFamilyRules();
  renderIndividualRules();
  renderScheduleAndRoles();
}

function renderMembers() {
  const grid = document.getElementById('member-grid');
  const empty = document.getElementById('member-empty');
  grid.innerHTML = '';

  if (HOUSEHOLD.members.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const member of HOUSEHOLD.members) {
    grid.appendChild(renderMemberCard(member));
  }
}

function renderMemberCard(member) {
  const age = calcAge(member.dob);
  const showCalorie = !member.isChild && member.goals.some((g) => FITNESS_GOALS.includes(g)) && member.calorieTarget;
  const avatar = member.isChild ? '🧒' : member.gender === 'female' ? '👩' : member.gender === 'male' ? '👨' : '🧑';
  const goalTags = member.goals.map((g) => {
    const meta = GOALS.find((x) => x.value === g);
    return meta ? `<span class="member-card__goal-tag">${meta.icon} ${meta.label}</span>` : '';
  }).join('');

  const card = document.createElement('button');
  card.className = 'member-card';
  card.type = 'button';
  card.innerHTML = `
    <div class="member-card__top">
      <span class="member-card__avatar">${avatar}</span>
      <span class="member-card__age">${age != null ? `${age} yrs` : ''}</span>
    </div>
    <div class="member-card__name">${member.name}</div>
    <div class="member-card__goals">${goalTags}</div>
    ${showCalorie ? `<div class="member-card__calorie"><b>${member.calorieTarget}</b> kcal/day target</div>` : ''}
  `;
  card.addEventListener('click', () => openMemberModal(member));
  return card;
}

// ---------------- rules ----------------

function renderFamilyRules() {
  const list = document.getElementById('family-rules-list');
  list.innerHTML = HOUSEHOLD.familyRules.map((rule, idx) => `
    <div class="rule-pill">
      <span>${rule}</span>
      <button type="button" class="rule-pill__remove" data-idx="${idx}" aria-label="Remove">&times;</button>
    </div>
  `).join('');
}

function renderIndividualRules() {
  const select = document.getElementById('individual-rule-member');
  select.innerHTML = HOUSEHOLD.members.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')
    || '<option value="">Add a member first</option>';

  const list = document.getElementById('individual-rules-list');
  list.innerHTML = HOUSEHOLD.individualRules.map((rule, idx) => {
    const member = HOUSEHOLD.members.find((m) => m.id === rule.memberId);
    const isHard = rule.type === 'allergy';
    return `
      <div class="rule-pill${isHard ? ' rule-pill--hard' : ''}">
        <span>${isHard ? '🚩' : '👎'} <b>${member ? member.name : 'Unknown'}</b> — ${rule.note}</span>
        <button type="button" class="rule-pill__remove" data-idx="${idx}" aria-label="Remove">&times;</button>
      </div>
    `;
  }).join('');
}

document.getElementById('family-rule-add').addEventListener('click', async () => {
  const input = document.getElementById('family-rule-input');
  const value = input.value.trim();
  if (!value) return;
  HOUSEHOLD.familyRules.push(value);
  input.value = '';
  try { await scheduleSave(); } catch (err) { showToast(err.message); }
});

document.getElementById('family-rules-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.rule-pill__remove');
  if (!btn) return;
  HOUSEHOLD.familyRules.splice(Number(btn.dataset.idx), 1);
  try { await scheduleSave(); } catch (err) { showToast(err.message); }
});

document.getElementById('individual-rule-add').addEventListener('click', async () => {
  const memberId = document.getElementById('individual-rule-member').value;
  const type = document.getElementById('individual-rule-type').value === 'allergy' ? 'allergy' : 'dislike';
  const input = document.getElementById('individual-rule-input');
  const note = input.value.trim();
  if (!memberId) { showToast('Add a member first.'); return; }
  if (!note) return;
  HOUSEHOLD.individualRules.push({ memberId, note, type });
  input.value = '';
  try { await scheduleSave(); } catch (err) { showToast(err.message); }
});

document.getElementById('individual-rules-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.rule-pill__remove');
  if (!btn) return;
  HOUSEHOLD.individualRules.splice(Number(btn.dataset.idx), 1);
  try { await scheduleSave(); } catch (err) { showToast(err.message); }
});

// ---------------- schedule + roles ----------------

function renderScheduleAndRoles() {
  document.getElementById('cook-days').value = HOUSEHOLD.cookSchedule.cookDays;
  document.getElementById('breakfast-days').value = HOUSEHOLD.cookSchedule.breakfastDays;
  document.getElementById('eat-out-note').textContent =
    `That leaves ${7 - HOUSEHOLD.cookSchedule.cookDays} day(s) a week eating out or ordering in.`;

  const memberOptions = HOUSEHOLD.members.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  for (const roleKey of ['planner', 'shopper', 'cook']) {
    const select = document.getElementById(`role-${roleKey}`);
    select.innerHTML = '<option value="">—</option>' + memberOptions;
    select.value = HOUSEHOLD.roles[roleKey] || '';
  }
}

document.getElementById('cook-days').addEventListener('change', async (e) => {
  HOUSEHOLD.cookSchedule.cookDays = Math.min(7, Math.max(1, Number(e.target.value) || 5));
  try { await scheduleSave(); } catch (err) { showToast(err.message); }
});

document.getElementById('breakfast-days').addEventListener('change', async (e) => {
  HOUSEHOLD.cookSchedule.breakfastDays = Math.min(7, Math.max(0, Number(e.target.value) || 0));
  try { await scheduleSave(); } catch (err) { showToast(err.message); }
});

for (const roleKey of ['planner', 'shopper', 'cook']) {
  document.getElementById(`role-${roleKey}`).addEventListener('change', async (e) => {
    HOUSEHOLD.roles[roleKey] = e.target.value || null;
    try { await scheduleSave(); } catch (err) { showToast(err.message); }
  });
}

// ---------------- member modal ----------------

function renderGoalButtons() {
  document.getElementById('mf-goals').innerHTML = GOALS.map((g) => `
    <button type="button" class="toggle-btn${currentGoals.includes(g.value) ? ' is-active' : ''}" data-goal="${g.value}">${g.icon} ${g.label}</button>
  `).join('');
}

function renderActivityButtons() {
  document.getElementById('mf-activity').innerHTML = ACTIVITY_LEVELS.map((a) => `
    <button type="button" class="toggle-btn${currentActivity === a.value ? ' is-active' : ''}" data-activity="${a.value}">${a.icon} ${a.label}</button>
  `).join('');
}

document.getElementById('mf-goals').addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn');
  if (!btn) return;
  const g = btn.dataset.goal;
  currentGoals = currentGoals.includes(g) ? currentGoals.filter((x) => x !== g) : [...currentGoals, g];
  renderGoalButtons();
  updateConditionalSections();
});

document.getElementById('mf-activity').addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn');
  if (!btn) return;
  currentActivity = btn.dataset.activity;
  renderActivityButtons();
  updateConditionalSections();
});

function currentFormValues() {
  return {
    dob: document.getElementById('mf-dob').value,
    gender: document.getElementById('mf-gender').value,
    heightCm: Number(document.getElementById('mf-height').value) || null,
    weightKg: Number(document.getElementById('mf-weight').value) || null,
    activityLevel: currentActivity,
    leanMassKg: Number(document.getElementById('mf-leanmass').value) || null,
  };
}

// Point 1 rebuild: "child" is derived live from date of birth — no manual checkbox. Shows
// the age-status hint (child / toddler-refusal / nothing for adults) and returns whether
// the rest of the form should treat this member as a child right now.
function updateAgeStatusAndGetIsChild() {
  const dobVal = document.getElementById('mf-dob').value;
  const age = dobVal ? calcAge(dobVal) : null;
  const guardrail = assessChildAgeGuardrail(age);
  const el = document.getElementById('mf-age-status');

  if (guardrail.status === 'toddler') {
    el.hidden = false;
    el.className = 'field-hint is-toddler';
    el.textContent = `🛑 ${guardrail.message}`;
  } else if (guardrail.status === 'child') {
    el.hidden = false;
    el.className = 'field-hint';
    el.textContent = `Age ${age} — using the pediatric calorie/protein guardrail (Health Canada EER + RDA protein). Computed silently; goals, activity-based macros, and calorie targets aren't shown for children.`;
  } else {
    el.hidden = true;
  }
  return guardrail.status === 'child';
}

function updateConditionalSections() {
  const isChild = updateAgeStatusAndGetIsChild();

  // Height/weight/activity are needed for EVERY member's calorie/macro math, children
  // included — only goals (fitness goals aren't a thing a child picks) and the visible
  // calorie-target box (children's target is computed silently, never shown — see
  // mf-calorie-wrap below) stay child-gated.
  document.getElementById('mf-adult-basics').hidden = false;
  document.getElementById('mf-goals-section').hidden = isChild;
  document.getElementById('mf-activity-section').hidden = false;
  document.getElementById('mf-medical-wrap').hidden = isChild;

  const medicalVal = document.getElementById('mf-medical').value.trim().toLowerCase();
  document.getElementById('mf-doctor-note').hidden = isChild || !medicalVal || medicalVal === 'none';

  const gender = document.getElementById('mf-gender').value;
  const hasFitnessGoal = currentGoals.some((g) => FITNESS_GOALS.includes(g));
  document.getElementById('mf-cycle-wrap').hidden = isChild || gender !== 'female' || !hasFitnessGoal;

  const bodyCompEligible = !isChild && (currentGoals.includes('lose-weight') || currentGoals.includes('gain-muscle'))
    && ['moderate', 'very-active', 'training'].includes(currentActivity);
  document.getElementById('mf-bodycomp-wrap').hidden = !bodyCompEligible;

  document.getElementById('mf-training-detail-wrap').hidden = isChild || currentActivity !== 'training';

  const calorieWrap = document.getElementById('mf-calorie-wrap');
  calorieWrap.hidden = isChild || !hasFitnessGoal;
  if (!calorieWrap.hidden) {
    const formValues = currentFormValues();
    const estimate = calcCalorieEstimate(formValues);
    const bmr = calcBMR(formValues);
    const estimateEl = document.getElementById('mf-calorie-estimate');
    const targetInput = document.getElementById('mf-calorie-target');
    if (estimate) {
      estimateEl.textContent = `Estimated: ${estimate} kcal/day (Mifflin-St Jeor × activity${formValues.leanMassKg ? ', using lean mass' : ''}). Adjust if you already know their target.`;
      if (!targetInput.value || targetInput.dataset.auto === 'true') {
        targetInput.value = estimate;
        targetInput.dataset.auto = 'true';
      }
    } else {
      estimateEl.textContent = 'Fill in date of birth, height, weight, and activity level for an estimate — or just type a target you already know.';
    }

    updateMacroAndSafetyDisplay({ formValues, bmr, maintenanceKcal: estimate, calorieTarget: Number(targetInput.value) || null });
  }
}

// Live protein/fat/carb preview + the Part A.1 safety-floor banner — recomputed on every
// relevant edit so the shopper sees it before they even try to save.
function updateMacroAndSafetyDisplay({ formValues, bmr, maintenanceKcal, calorieTarget }) {
  const macroEl = document.getElementById('mf-macro-summary');
  const macros = calorieTarget ? calcMacroTargets({
    activityLevel: currentActivity, goals: currentGoals, weightKg: formValues.weightKg, dailyKcal: calorieTarget,
  }) : null;

  if (macros) {
    macroEl.hidden = false;
    let text = `≈ ${macros.proteinG}g protein · ${macros.fatG}g fat · ${macros.carbG}g carbs / day`;
    if (macros.sedentaryMuscleGainFlag) text += ' — using maintain-level protein (sedentary, no training stimulus yet).';
    if (macros.athleteFlag) text += ' ⚠️ Provisional — needs sport-specific review.';
    macroEl.textContent = text;
  } else {
    macroEl.hidden = true;
  }

  const banner = document.getElementById('mf-safety-floor-banner');
  const floor = assessSafetyFloor({ calorieTarget, bmr, maintenanceKcal });
  if (floor.status === 'ok') {
    banner.hidden = true;
    banner.className = 'safety-floor-banner';
  } else {
    banner.hidden = false;
    banner.className = `safety-floor-banner is-${floor.status}`;
    banner.textContent = floor.status === 'refused' ? `🛑 ${floor.message}` : `⚠️ ${floor.message}`;
  }
}

document.getElementById('mf-recalculate').addEventListener('click', () => {
  const estimate = calcCalorieEstimate(currentFormValues());
  if (estimate) {
    const targetInput = document.getElementById('mf-calorie-target');
    targetInput.value = estimate;
    targetInput.dataset.auto = 'true';
  }
  updateConditionalSections();
});

document.getElementById('mf-calorie-target').addEventListener('input', (e) => {
  e.target.dataset.auto = 'false';
  updateConditionalSections();
});

['mf-gender', 'mf-height', 'mf-weight', 'mf-dob', 'mf-leanmass'].forEach((id) =>
  document.getElementById(id).addEventListener('input', updateConditionalSections));
document.getElementById('mf-medical').addEventListener('input', updateConditionalSections);

function openMemberModal(member) {
  editingMemberId = member ? member.id : null;
  document.getElementById('member-modal-title').textContent = member ? 'Edit member' : 'Add a member';
  document.getElementById('mf-delete').hidden = !member;

  document.getElementById('mf-name').value = member ? member.name : '';
  document.getElementById('mf-dob').value = member ? member.dob : '';
  document.getElementById('mf-gender').value = member ? member.gender || '' : '';
  document.getElementById('mf-height').value = member && member.heightCm ? member.heightCm : '';
  document.getElementById('mf-weight').value = member && member.weightKg ? member.weightKg : '';
  document.getElementById('mf-medical').value = member ? member.medicalConditions : '';
  document.getElementById('mf-cycle').checked = member ? Boolean(member.cycleTracking) : false;
  document.getElementById('mf-leanmass').value = member && member.bodyComposition ? member.bodyComposition.leanMassKg : '';
  document.getElementById('mf-training-detail').value = member ? member.trainingDetail || '' : '';

  const targetInput = document.getElementById('mf-calorie-target');
  targetInput.value = member && member.calorieTarget ? member.calorieTarget : '';
  targetInput.dataset.auto = member && member.calorieTarget ? 'false' : 'true';

  currentGoals = member ? [...member.goals] : [];
  currentActivity = member ? member.activityLevel : null;
  renderGoalButtons();
  renderActivityButtons();
  updateConditionalSections();

  document.getElementById('member-modal').hidden = false;
}

document.getElementById('open-member-modal').addEventListener('click', () => openMemberModal(null));
document.getElementById('member-modal-close').addEventListener('click', () => {
  document.getElementById('member-modal').hidden = true;
});
document.getElementById('member-modal').addEventListener('click', (e) => {
  if (e.target.id === 'member-modal') document.getElementById('member-modal').hidden = true;
});

document.getElementById('member-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  // Point 1 rebuild: age (from DOB) decides child status and the toddler guardrail — not a
  // checkbox. Recomputed here, not just trusted from the live display, so a fast submit
  // can't slip past the under-4 refusal.
  const age = calcAge(document.getElementById('mf-dob').value);
  const guardrail = assessChildAgeGuardrail(age);
  if (guardrail.status === 'toddler') {
    showToast(guardrail.message);
    return;
  }
  const isChild = guardrail.status === 'child';
  const hasFitnessGoal = !isChild && currentGoals.some((g) => FITNESS_GOALS.includes(g));
  const formValues = currentFormValues();

  let calorieTarget, macroTargets;
  if (hasFitnessGoal) {
    // Fitness-goal adults: the user-entered/estimated target, shown and editable in the
    // calorie box — Part A.1's safety floor hard-blocks the save (not just a warning).
    // Recomputed here (not just trusted from the live display) so it can't be bypassed by
    // submitting fast.
    calorieTarget = Number(document.getElementById('mf-calorie-target').value) || null;
    if (calorieTarget) {
      const bmr = calcBMR(formValues);
      const maintenanceKcal = calcCalorieEstimate(formValues);
      const floor = assessSafetyFloor({ calorieTarget, bmr, maintenanceKcal });
      if (floor.status === 'refused') {
        showToast(floor.message);
        return;
      }
    }
    macroTargets = calorieTarget ? calcMacroTargets({
      activityLevel: currentActivity, goals: currentGoals, weightKg: formValues.weightKg, dailyKcal: calorieTarget,
    }) : null;
  } else {
    // Convenience-goal adults: maintain-weight math, never surfaced as an editable box.
    // Children: Health Canada's own EER equations + RDA protein (computeChildTarget) —
    // never the adult formula, never a discount on it. Both computed and stored silently;
    // nothing for a human to override, so no safety-floor check needed (a maintain-weight
    // TDEE, and a child's EER, are both >= BMR by construction).
    const backend = computeBackendTarget({ ...formValues, isChild });
    calorieTarget = backend.calorieTarget;
    macroTargets = backend.macroTargets;
  }

  const memberData = {
    id: editingMemberId || crypto.randomUUID(),
    name: document.getElementById('mf-name').value.trim(),
    dob: document.getElementById('mf-dob').value,
    isChild,
    gender: document.getElementById('mf-gender').value,
    heightCm: Number(document.getElementById('mf-height').value) || null,
    weightKg: Number(document.getElementById('mf-weight').value) || null,
    goals: currentGoals,
    activityLevel: currentActivity,
    trainingDetail: currentActivity === 'training' ? document.getElementById('mf-training-detail').value.trim() : '',
    medicalConditions: document.getElementById('mf-medical').value.trim(),
    cycleTracking: document.getElementById('mf-cycle').checked,
    bodyComposition: document.getElementById('mf-leanmass').value
      ? { leanMassKg: Number(document.getElementById('mf-leanmass').value) }
      : null,
    calorieTarget,
    macroTargets,
  };

  if (editingMemberId) {
    const idx = HOUSEHOLD.members.findIndex((m) => m.id === editingMemberId);
    if (idx !== -1) HOUSEHOLD.members[idx] = { ...HOUSEHOLD.members[idx], ...memberData };
  } else {
    HOUSEHOLD.members.push(memberData);
  }

  try {
    await saveHousehold();
    document.getElementById('member-modal').hidden = true;
    showToast(`${memberData.name} saved.`);
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('mf-delete').addEventListener('click', async () => {
  if (!editingMemberId) return;
  HOUSEHOLD.members = HOUSEHOLD.members.filter((m) => m.id !== editingMemberId);
  HOUSEHOLD.individualRules = HOUSEHOLD.individualRules.filter((r) => r.memberId !== editingMemberId);
  for (const roleKey of ['planner', 'shopper', 'cook']) {
    if (HOUSEHOLD.roles[roleKey] === editingMemberId) HOUSEHOLD.roles[roleKey] = null;
  }
  try {
    await saveHousehold();
    document.getElementById('member-modal').hidden = true;
    showToast('Member removed.');
  } catch (err) {
    showToast(err.message);
  }
});

// ==================================================================
// SCREEN 3 — THE LIST
// ==================================================================

// The 3 Sunday-batch slots — every recipe's own "method" field is now one of exactly
// these 3 values (see METHOD_LABEL above), so in practice this is just an equality
// check. Kept as "anything not stovetop/oven" rather than strict equality only as a
// safety net for any recipe saved locally before this 3-value lock existed (an old
// "air-fryer" or "no-cook" tag sitting in someone's browser) — it still lands correctly
// in The Third Spot instead of quietly becoming unpickable again.
const METHODS = ['stovetop', 'oven', 'third-spot'];

function methodMatchesSlot(recipeMethod, slotKey) {
  if (slotKey === 'third-spot') return recipeMethod !== 'stovetop' && recipeMethod !== 'oven';
  return recipeMethod === slotKey;
}

const CATEGORY_ICON = {
  'Fresh Produce': '🥬',
  'Proteins and Meat': '🥩',
  'Fish and Seafood': '🐟',
  'Dry Goods and Pantry': '🥫',
  'Dairy and Chilled': '🧀',
  'Canned and Jarred': '🥫',
  'Freezer': '❄️',
};

let selectedMains = { 'stovetop': null, 'oven': null, 'third-spot': null };
let selectedBreakfast = null;
let selectedSnacks = [null, null];
let weeklyAdjustments = {}; // memberId -> { status, daysPresent }
let buyVsMakeAnswers = {}; // `${recipeId}::${ingredientName}` -> 'buy' | 'make'
let cyclePhases = {}; // memberId -> 'follicular' | 'ovulation' | 'luteal' | 'menstrual'
let pickerContext = null; // { type: 'method', method } | { type: 'breakfast' } | { type: 'snack', slotIndex }
let pickerProteinFilter = 'all';
let generatedList = null;

function renderListScreen() {
  renderMethodSlots();
  renderBreakfastSlot();
  renderSnackSlots();
  renderWeeklyAdjustments();
  renderBuyVsMakeSection();
  renderCyclePhaseSection();
  updateGenerateButtonState();
}

// ---- method slots (the 3 weekly mains) ----

function renderMethodSlots() {
  for (const method of METHODS) {
    const slot = document.querySelector(`.method-slot[data-method="${method}"]`);
    const recipe = selectedMains[method];
    fillSlot(slot, recipe, () => { selectedMains[method] = null; renderListScreen(); });
  }
  renderProteinWarning();
}

function fillSlot(slot, recipe, onRemove, placeholderText) {
  const cta = slot.querySelector('.method-slot__cta');
  slot.classList.toggle('is-filled', Boolean(recipe));
  cta.textContent = recipe ? recipe.name : (placeholderText || '+ Choose a recipe');

  const existingRemove = slot.querySelector('.method-slot__remove');
  if (recipe && !existingRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'method-slot__remove';
    removeBtn.setAttribute('aria-label', 'Remove');
    removeBtn.innerHTML = '&times;';
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    slot.appendChild(removeBtn);
  } else if (!recipe && existingRemove) {
    existingRemove.remove();
  }
}

function renderProteinWarning() {
  const banner = document.getElementById('protein-warning');
  const picked = METHODS.map((m) => selectedMains[m]).filter(Boolean);
  const counts = {};
  picked.forEach((r) => { counts[r.protein] = (counts[r.protein] || 0) + 1; });
  const repeated = Object.entries(counts).find(([, count]) => count >= 2);

  if (repeated && picked.length >= 2) {
    const meta = PROTEIN_META[repeated[0]];
    banner.hidden = false;
    banner.textContent = `Just flagging — you've got ${repeated[1]} ${meta ? meta.label.toLowerCase() : repeated[0]} recipes this week. Eating the same protein a lot can get old and limits variety — but your call, happy to keep it if that's what you want.`;
  } else {
    banner.hidden = true;
  }
}

document.getElementById('method-slots').addEventListener('click', (e) => {
  if (e.target.closest('.method-slot__remove')) return;
  const slot = e.target.closest('.method-slot');
  if (!slot) return;
  openPickerModal({ type: 'method', method: slot.dataset.method });
});
document.getElementById('method-slots').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.closest('.method-slot__remove')) return;
  const slot = e.target.closest('.method-slot');
  if (!slot) return;
  e.preventDefault();
  openPickerModal({ type: 'method', method: slot.dataset.method });
});

// ---- breakfast slot ----

function renderBreakfastSlot() {
  const slot = document.getElementById('breakfast-slot');
  fillSlot(slot, selectedBreakfast, () => { selectedBreakfast = null; renderListScreen(); }, '+ Choose');
}

document.getElementById('breakfast-slot').addEventListener('click', (e) => {
  if (e.target.closest('.method-slot__remove')) return;
  openPickerModal({ type: 'breakfast' });
});
document.getElementById('breakfast-slot').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.closest('.method-slot__remove')) return;
  e.preventDefault();
  openPickerModal({ type: 'breakfast' });
});

// ---- recipe picker modal (shared by method slots + breakfast) ----

function openPickerModal(context) {
  pickerContext = context;
  pickerProteinFilter = 'all';
  const filters = document.getElementById('picker-protein-filters');

  if (context.type === 'method') {
    document.getElementById('picker-modal-eyebrow').textContent = METHOD_LABEL[context.method];
    document.getElementById('picker-modal-title').textContent = 'Pick a recipe';
    filters.hidden = false;
  } else if (context.type === 'snack') {
    document.getElementById('picker-modal-eyebrow').textContent = `Snack ${context.slotIndex + 1}`;
    document.getElementById('picker-modal-title').textContent = 'Pick a snack or side';
    filters.hidden = true;
  } else {
    document.getElementById('picker-modal-eyebrow').textContent = 'Breakfast';
    document.getElementById('picker-modal-title').textContent = 'Pick a breakfast';
    filters.hidden = true;
  }
  document.querySelectorAll('#picker-protein-filters .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.protein === 'all'));

  renderPickerGrid();
  document.getElementById('picker-modal').hidden = false;
}

function renderPickerGrid() {
  const grid = document.getElementById('picker-grid');
  const empty = document.getElementById('picker-empty');
  let list;

  if (pickerContext.type === 'method') {
    list = ALL_RECIPES.filter((r) => r.mealType === 'main' && methodMatchesSlot(r.method, pickerContext.method));
    if (pickerProteinFilter !== 'all') list = list.filter((r) => r.protein === pickerProteinFilter);
  } else if (pickerContext.type === 'snack') {
    list = ALL_RECIPES.filter((r) => r.mealType === 'snack');
  } else {
    list = ALL_RECIPES.filter((r) => r.mealType === 'breakfast');
  }

  grid.innerHTML = '';
  if (list.length === 0) { empty.hidden = false; return; }
  empty.hidden = true;
  for (const recipe of list) grid.appendChild(renderPickerCard(recipe));
}

function renderPickerCard(recipe) {
  const meta = cardMeta(recipe);
  const m = recipe.macrosPerServing || {};
  const card = document.createElement('button');
  card.className = 'recipe-card';
  card.type = 'button';
  card.innerHTML = `
    <div class="recipe-card__top">
      <span class="recipe-card__icon">${meta.icon}</span>
      <span class="recipe-card__method">${METHOD_LABEL[recipe.method] || recipe.method}</span>
    </div>
    <div>
      <div class="recipe-card__label">${meta.label}</div>
      <div class="recipe-card__name">${recipe.name}</div>
    </div>
    <div class="recipe-card__macros">
      <span><b>${m.kcal ?? '–'}</b> kcal</span>
      <span><b>${m.protein ?? '–'}g</b> protein</span>
    </div>
  `;
  card.addEventListener('click', () => {
    if (pickerContext.type === 'method') selectedMains[pickerContext.method] = recipe;
    else if (pickerContext.type === 'snack') selectedSnacks[pickerContext.slotIndex] = recipe;
    else selectedBreakfast = recipe;
    document.getElementById('picker-modal').hidden = true;
    renderListScreen();
  });
  return card;
}

document.getElementById('picker-protein-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  pickerProteinFilter = btn.dataset.protein;
  document.querySelectorAll('#picker-protein-filters .chip').forEach((c) => c.classList.remove('is-active'));
  btn.classList.add('is-active');
  renderPickerGrid();
});

document.getElementById('picker-modal-close').addEventListener('click', () => {
  document.getElementById('picker-modal').hidden = true;
});
document.getElementById('picker-modal').addEventListener('click', (e) => {
  if (e.target.id === 'picker-modal') document.getElementById('picker-modal').hidden = true;
});

// ---- snacks & sides (optional, 2 slots) ----

function renderSnackSlots() {
  document.querySelectorAll('#snack-slots .method-slot').forEach((slot) => {
    const idx = Number(slot.dataset.snackSlot);
    const recipe = selectedSnacks[idx];
    fillSlot(slot, recipe, () => { selectedSnacks[idx] = null; renderListScreen(); }, '+ Choose (optional)');
  });
}

document.getElementById('snack-slots').addEventListener('click', (e) => {
  if (e.target.closest('.method-slot__remove')) return;
  const slot = e.target.closest('.method-slot');
  if (!slot) return;
  openPickerModal({ type: 'snack', slotIndex: Number(slot.dataset.snackSlot) });
});
document.getElementById('snack-slots').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.closest('.method-slot__remove')) return;
  const slot = e.target.closest('.method-slot');
  if (!slot) return;
  e.preventDefault();
  openPickerModal({ type: 'snack', slotIndex: Number(slot.dataset.snackSlot) });
});

// ---- this week's exceptions (Point 2 rework) ----
// Four independent occasion counters per person — breakfast / lunch / dinner / snack —
// each preset to the household's cook schedule but freely editable, for every member
// including children. Setting all four to 0 for someone excludes them from this week's
// groceries/recipes/scaling entirely (mealEngine.js's memberPresence derives that from the
// counts directly — no separate "away" toggle needed).
// Breakfast/lunch/dinner are capped at 7 (can't happen more than once a day) — snacks
// aren't tied to a single daily occasion the same way, so that counter is uncapped.
const EXCEPTION_FIELDS = [
  { field: 'breakfastCount', label: 'Breakfast', defaultKey: 'breakfastDays', maxValue: 7 },
  { field: 'lunchCount', label: 'Lunch', defaultKey: 'cookDays', maxValue: 7 },
  { field: 'dinnerCount', label: 'Dinner', defaultKey: 'cookDays', maxValue: 7 },
  { field: 'snackCount', label: 'Snacks', defaultKey: 'cookDays', maxValue: null },
];

function renderWeeklyAdjustments() {
  const container = document.getElementById('weekly-adjustments');
  const empty = document.getElementById('weekly-adjustments-empty');

  if (HOUSEHOLD.members.length === 0) {
    container.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  container.innerHTML = HOUSEHOLD.members.map((m) => {
    const adj = weeklyAdjustments[m.id] || {};
    const counters = EXCEPTION_FIELDS.map(({ field, label, defaultKey, maxValue }) => {
      const value = adj[field] ?? HOUSEHOLD.cookSchedule[defaultKey] ?? 0;
      return `
        <label class="adjustment-count">
          ${label}
          <input type="number" min="0" ${maxValue != null ? `max="${maxValue}"` : ''} value="${value}" data-field="${field}">
        </label>
      `;
    }).join('');
    return `
      <div class="adjustment-row" data-member="${m.id}">
        <span class="adjustment-row__name">${m.name}</span>
        <div class="adjustment-row__counts">${counters}</div>
      </div>
    `;
  }).join('');
}

document.getElementById('weekly-adjustments').addEventListener('change', (e) => {
  const row = e.target.closest('.adjustment-row');
  if (!row || !e.target.dataset.field) return;
  const memberId = row.dataset.member;
  const existing = weeklyAdjustments[memberId] || {};
  const fieldDef = EXCEPTION_FIELDS.find((f) => f.field === e.target.dataset.field);
  const raw = Math.max(0, Number(e.target.value) || 0);
  existing[e.target.dataset.field] = fieldDef && fieldDef.maxValue != null ? Math.min(fieldDef.maxValue, raw) : raw;
  weeklyAdjustments[memberId] = existing;
});

// ---- buy vs make (dynamic, from whatever's selected) ----

function collectBuyVsMakeCandidates() {
  const recipes = [...METHODS.map((m) => selectedMains[m]).filter(Boolean)];
  if (selectedBreakfast) recipes.push(selectedBreakfast);
  recipes.push(...selectedSnacks.filter(Boolean));

  const candidates = [];
  for (const recipe of recipes) {
    for (const ing of recipe.ingredients || []) {
      if (ing.buyVsMake) candidates.push({ recipe, ingredient: ing });
    }
  }
  return candidates;
}

function renderBuyVsMakeSection() {
  const section = document.getElementById('buy-vs-make-section');
  const container = document.getElementById('buy-vs-make-questions');
  const candidates = collectBuyVsMakeCandidates();

  if (candidates.length === 0) {
    section.hidden = true;
    container.innerHTML = '';
    return;
  }
  section.hidden = false;

  container.innerHTML = candidates.map(({ recipe, ingredient }) => {
    const key = `${recipe.id}::${ingredient.name}`;
    const current = buyVsMakeAnswers[key] || 'make';
    return `
      <div class="bvm-question" data-key="${key}">
        <p>For the <b>${ingredient.name}</b> in ${recipe.name} — buy ready or make from scratch?</p>
        <div class="bvm-choice">
          <button type="button" data-choice="buy" class="${current === 'buy' ? 'is-active' : ''}">Buy ready</button>
          <button type="button" data-choice="make" class="${current === 'make' ? 'is-active' : ''}">Make from scratch</button>
        </div>
      </div>
    `;
  }).join('');
}

document.getElementById('buy-vs-make-questions').addEventListener('click', (e) => {
  const btn = e.target.closest('.bvm-choice button');
  if (!btn) return;
  const key = btn.closest('.bvm-question').dataset.key;
  buyVsMakeAnswers[key] = btn.dataset.choice;
  renderBuyVsMakeSection();
});

// ---- cycle phase (Calculation Engine Spec v2 Part E.1) ----
// Shown per member who ticked "eat in a cycle-friendly way" (cycleTracking) in their
// Family Hub profile. Purely data collection this stage — nothing reads it yet.

const CYCLE_PHASES = [
  { value: 'follicular', label: 'Follicular' },
  { value: 'ovulation', label: 'Ovulation' },
  { value: 'luteal', label: 'Luteal' },
  { value: 'menstrual', label: 'Menstrual' },
];

function renderCyclePhaseSection() {
  const section = document.getElementById('cycle-phase-section');
  const container = document.getElementById('cycle-phase-rows');
  const eligible = HOUSEHOLD.members.filter((m) => m.cycleTracking);

  if (eligible.length === 0) {
    section.hidden = true;
    container.innerHTML = '';
    return;
  }
  section.hidden = false;

  container.innerHTML = eligible.map((m) => {
    const phase = cyclePhases[m.id] || '';
    return `
      <div class="adjustment-row" data-member="${m.id}">
        <span class="adjustment-row__name">${m.name}</span>
        <select data-field="phase">
          <option value="" ${phase === '' ? 'selected' : ''}>Skip this week</option>
          ${CYCLE_PHASES.map((p) => `<option value="${p.value}" ${phase === p.value ? 'selected' : ''}>${p.label}</option>`).join('')}
        </select>
      </div>
    `;
  }).join('');
}

document.getElementById('cycle-phase-rows').addEventListener('change', (e) => {
  const row = e.target.closest('.adjustment-row');
  if (!row) return;
  const memberId = row.dataset.member;
  if (e.target.value) cyclePhases[memberId] = e.target.value;
  else delete cyclePhases[memberId];
});

// ---- generate ----

function isReadyToGenerate() {
  const allMainsFilled = METHODS.every((m) => selectedMains[m]);
  const hasMembers = HOUSEHOLD.members.length > 0;
  return allMainsFilled && hasMembers && aiImportEnabled;
}

// Sets the button's disabled state AND the "why is this disabled" hint.
// Only call this when nothing else is trying to show a message in
// #generate-status (a loading state, a result, an error) — it unconditionally
// overwrites that text. Mid-generation or right after a result/error, just
// touch btn.disabled directly instead (see the click handler below).
function updateGenerateButtonState() {
  const btn = document.getElementById('generate-list-btn');
  const status = document.getElementById('generate-status');
  const allMainsFilled = METHODS.every((m) => selectedMains[m]);
  const hasMembers = HOUSEHOLD.members.length > 0;
  const ready = isReadyToGenerate();
  btn.disabled = !ready;

  if (ready) {
    status.hidden = true;
    return;
  }
  status.hidden = false;
  status.className = 'generate-status';
  if (!allMainsFilled) status.textContent = 'Pick all 3 mains above to generate the list.';
  else if (!hasMembers) status.textContent = 'Add at least one household member in the Family Hub first.';
  else if (!aiImportEnabled) status.textContent = 'Add ANTHROPIC_API_KEY to .env to generate the list (see README).';
}

// Builds the "this week's picks" payload sent to /api/generate-list.
function buildWeekPayload() {
  const allSelected = [...METHODS.map((m) => selectedMains[m]), selectedBreakfast, ...selectedSnacks].filter(Boolean);
  return {
    // The server has no disk access to household.json or the recipe library's
    // local additions anymore — both live in this browser's localStorage, so
    // they have to ride along in the request body.
    household: HOUSEHOLD,
    localRecipes: lsGet(LS_KEYS.localRecipes, []),
    mains: METHODS.map((m) => ({ method: m, recipe: selectedMains[m] })),
    breakfast: selectedBreakfast,
    snacks: selectedSnacks.filter(Boolean),
    buyVsMake: Object.entries(buyVsMakeAnswers).map(([key, choice]) => {
      const [recipeId, ingredientName] = key.split('::');
      const recipe = allSelected.find((r) => r.id === recipeId);
      return { recipeName: recipe ? recipe.name : recipeId, ingredientName, choice };
    }),
    // Point 2 — only send overrides that actually differ from the household default, so a
    // member nobody touched just falls through to mealEngine.js's own defaulting.
    weeklyAdjustments: Object.entries(weeklyAdjustments)
      .filter(([, adj]) => Object.keys(adj).length > 0)
      .map(([memberId, adj]) => ({ memberId, ...adj })),
    // Part E.1 — only members who set a phase this week are included.
    cyclePhases: Object.entries(cyclePhases)
      .filter(([, phase]) => phase)
      .map(([memberId, phase]) => ({ memberId, phase })),
  };
}

document.getElementById('generate-list-btn').addEventListener('click', async () => {
  const btn = document.getElementById('generate-list-btn');
  const status = document.getElementById('generate-status');
  btn.disabled = true;
  status.hidden = false;
  status.className = 'generate-status';
  status.textContent = 'Scaling portions and building your list…';

  const payload = buildWeekPayload();

  try {
    const res = await fetch('/api/generate-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.status === 'unavailable') {
      status.className = 'generate-status is-error';
      status.textContent = data.message;
      return;
    }
    if (!res.ok || data.status !== 'ok') {
      throw new Error(data.message || 'Something went wrong.');
    }

    generatedList = data.list;
    status.hidden = true;
    renderGroceryOutput(generatedList);
  } catch (err) {
    status.className = 'generate-status is-error';
    status.textContent = err.message;
  } finally {
    // Only re-enable the button here — don't call updateGenerateButtonState(),
    // it would immediately hide whatever message/error was just set above.
    btn.disabled = !isReadyToGenerate();
  }
});

// ---- output + sharing ----

function renderCategoriesInto(container, categories) {
  container.innerHTML = (categories || []).filter((c) => c.items && c.items.length).map((cat) => `
    <div class="grocery-category">
      <p class="grocery-category__title">${CATEGORY_ICON[cat.name] || ''} ${cat.name}</p>
      <ul>
        ${cat.items.map((item) => `
          <li>
            <b>${item.name}</b>
            <span class="flags">${item.qty}${item.shelfLife ? ' ⚠️' : ''}${item.freezeFriendly ? ' ❄️' : ''}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('');
}

function renderAiAdviceInto(container, advice) {
  container.innerHTML = (advice || []).map((a) => `
    <div class="ai-advice-card">
      <p class="ai-advice-card__name">${a.memberName}</p>
      <p class="ai-advice-card__summary">${a.summary}</p>
      ${a.recommendation ? `<p class="ai-advice-card__rec">→ ${a.recommendation}</p>` : ''}
    </div>
  `).join('');
}

function renderWeighAndPack(el, weighAndPack) {
  el.innerHTML = (weighAndPack || []).map((recipe) => `
    <div class="weigh-recipe">
      <p class="weigh-recipe__title">${recipe.recipeName}</p>
      <ul class="weigh-recipe__list">
        ${(recipe.portions || []).map((p) => `
          <li><b>${p.memberName}</b> — ${p.portionText}${p.note ? ` <span class="weigh-recipe__note">(${p.note})</span>` : ''}</li>
        `).join('')}
      </ul>
    </div>
  `).join('') || '<p class="list-step-hint">No weigh & pack breakdown available.</p>';
}

function renderGroceryOutput(list) {
  document.getElementById('grocery-summary').textContent = list.summaryLine || '';
  renderCategoriesInto(document.getElementById('grocery-categories'), list.categories);

  const aiSection = document.getElementById('ai-advice-section');
  const aiErrorEl = document.getElementById('ai-advice-error');
  if (list.adviceError) {
    aiSection.hidden = false;
    aiErrorEl.hidden = false;
    aiErrorEl.textContent = list.adviceError;
    document.getElementById('ai-advice-list').innerHTML = '';
  } else if (list.aiAdvice && list.aiAdvice.length) {
    aiSection.hidden = false;
    aiErrorEl.hidden = true;
    renderAiAdviceInto(document.getElementById('ai-advice-list'), list.aiAdvice);
  } else {
    aiSection.hidden = true;
  }

  const weighSection = document.getElementById('weigh-pack-section');
  if (list.weighAndPack && list.weighAndPack.length) {
    weighSection.hidden = false;
    renderWeighAndPack(document.getElementById('weigh-pack-list'), list.weighAndPack);
  } else {
    weighSection.hidden = true;
  }

  document.getElementById('save-week-name').value = '';
  document.getElementById('save-week-duration').value = '';
  document.getElementById('save-week-well').value = '';
  document.getElementById('save-week-hard').value = '';

  const output = document.getElementById('grocery-output');
  output.hidden = false;
  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildWhatsAppText(list) {
  let text = `🛒 THE LIST\n${list.summaryLine || ''}\n\n`;
  for (const cat of (list.categories || [])) {
    if (!cat.items || !cat.items.length) continue;
    text += `${CATEGORY_ICON[cat.name] || ''} ${cat.name.toUpperCase()}\n`;
    for (const item of cat.items) {
      let line = `- ${item.name} — ${item.qty}`;
      if (item.shelfLife) line += ' ⚠️';
      if (item.freezeFriendly) line += ' ❄️';
      text += line + '\n';
    }
    text += '\n';
  }
  text += "Copy this and send to your shopper — or screenshot and go. Khalas, you're done for the week. 🧡";
  return text;
}

document.getElementById('copy-whatsapp-btn').addEventListener('click', async () => {
  if (!generatedList) return;
  try {
    await navigator.clipboard.writeText(buildWhatsAppText(generatedList));
    showToast('Copied — paste it straight into WhatsApp.');
  } catch {
    showToast('Could not copy — your browser may be blocking clipboard access.');
  }
});

document.getElementById('copy-recipes-btn').addEventListener('click', async () => {
  const recipes = [...METHODS.map((m) => selectedMains[m]).filter(Boolean)];
  if (selectedBreakfast) recipes.push(selectedBreakfast);
  recipes.push(...selectedSnacks.filter(Boolean));

  let text = "THIS WEEK'S RECIPES\n\n";
  for (const r of recipes) {
    text += `*${r.name}* (${METHOD_LABEL[r.method] || r.method})\n`;
    text += (r.ingredients || []).map((i) => `- ${[i.qty, i.unit, i.name].filter(Boolean).join(' ')}`).join('\n') + '\n\n';
    text += (r.steps || []).map((s, idx) => `${idx + 1}. ${s}`).join('\n') + '\n\n';
  }

  try {
    await navigator.clipboard.writeText(text.trim());
    showToast('Recipes copied — paste them for the cook.');
  } catch {
    showToast('Could not copy — your browser may be blocking clipboard access.');
  }
});

// ---- past weeks (save + browse) ----

let SAVED_WEEKS = [];
let openSavedWeek = null;

async function loadSavedWeeks() {
  SAVED_WEEKS = lsGet(LS_KEYS.savedWeeks, []);
  SAVED_WEEKS.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  renderPastWeeks();
}

function uniqueSavedWeekId(base) {
  const existingIds = new Set(SAVED_WEEKS.map((w) => w.id));
  let id = base;
  let n = 2;
  while (existingIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function renderPastWeeks() {
  const section = document.getElementById('past-weeks-section');
  const list = document.getElementById('past-weeks-list');

  if (SAVED_WEEKS.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  list.innerHTML = SAVED_WEEKS.map((week) => {
    const names = [
      ...week.selections.mains.map((m) => m.recipeName),
      week.selections.breakfast ? week.selections.breakfast.recipeName : null,
      ...week.selections.snacks.map((s) => s.recipeName),
    ].filter(Boolean).join(' / ');
    const date = new Date(week.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `
      <button type="button" class="past-week-card" data-id="${week.id}">
        <span class="past-week-card__name">${week.name}</span>
        <span class="past-week-card__date">${date}</span>
        <span class="past-week-card__summary">${names}</span>
      </button>
    `;
  }).join('');
}

document.getElementById('past-weeks-list').addEventListener('click', (e) => {
  const card = e.target.closest('.past-week-card');
  if (!card) return;
  const week = SAVED_WEEKS.find((w) => w.id === card.dataset.id);
  if (week) openSavedWeekModal(week);
});

function openSavedWeekModal(week) {
  openSavedWeek = week;
  document.getElementById('saved-week-title').textContent = week.name;
  document.getElementById('saved-week-summary').textContent = week.list.summaryLine || '';

  const notes = week.notes || {};
  const noteEntries = [
    ['Sunday sprint took', notes.sprintDuration],
    ['What went well', notes.wentWell],
    ['What was hard', notes.wentHard],
    ['Other notes', notes.general],
  ].filter(([, v]) => v);
  const notesEl = document.getElementById('saved-week-notes');
  if (noteEntries.length) {
    notesEl.hidden = false;
    notesEl.innerHTML = noteEntries.map(([label, value]) => `
      <div class="note-block"><span>${label}</span><p>${value}</p></div>
    `).join('');
  } else {
    notesEl.hidden = true;
  }

  renderCategoriesInto(document.getElementById('saved-week-categories'), week.list.categories);

  const aiSection = document.getElementById('saved-week-ai-advice-section');
  if (week.list.aiAdvice && week.list.aiAdvice.length) {
    aiSection.hidden = false;
    renderAiAdviceInto(document.getElementById('saved-week-ai-advice-list'), week.list.aiAdvice);
  } else {
    aiSection.hidden = true;
  }

  const weighSection = document.getElementById('saved-week-weigh-pack-section');
  if (week.list.weighAndPack && week.list.weighAndPack.length) {
    weighSection.hidden = false;
    renderWeighAndPack(document.getElementById('saved-week-weigh-pack-list'), week.list.weighAndPack);
  } else {
    weighSection.hidden = true;
  }

  document.getElementById('saved-week-modal').hidden = false;
}

document.getElementById('saved-week-modal-close').addEventListener('click', () => {
  document.getElementById('saved-week-modal').hidden = true;
});
document.getElementById('saved-week-modal').addEventListener('click', (e) => {
  if (e.target.id === 'saved-week-modal') document.getElementById('saved-week-modal').hidden = true;
});

document.getElementById('saved-week-copy').addEventListener('click', async () => {
  if (!openSavedWeek) return;
  try {
    await navigator.clipboard.writeText(buildWhatsAppText(openSavedWeek.list));
    showToast('Copied — paste it straight into WhatsApp.');
  } catch {
    showToast('Could not copy — your browser may be blocking clipboard access.');
  }
});

document.getElementById('saved-week-delete').addEventListener('click', () => {
  if (!openSavedWeek) return;
  try {
    SAVED_WEEKS = SAVED_WEEKS.filter((w) => w.id !== openSavedWeek.id);
    lsSet(LS_KEYS.savedWeeks, SAVED_WEEKS);
    document.getElementById('saved-week-modal').hidden = true;
    showToast('Saved week deleted.');
    renderPastWeeks();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('save-week-btn').addEventListener('click', () => {
  if (!generatedList) return;

  const name = document.getElementById('save-week-name').value.trim() || `Week of ${new Date().toLocaleDateString()}`;
  const week = {
    id: uniqueSavedWeekId(slugify(name)),
    name,
    savedAt: new Date().toISOString(),
    selections: {
      mains: METHODS.map((m) => ({ method: m, recipeName: selectedMains[m] ? selectedMains[m].name : '' })).filter((m) => m.recipeName),
      breakfast: selectedBreakfast ? { recipeName: selectedBreakfast.name } : null,
      snacks: selectedSnacks.filter(Boolean).map((s) => ({ recipeName: s.name })),
    },
    list: generatedList,
    notes: {
      sprintDuration: document.getElementById('save-week-duration').value.trim(),
      wentWell: document.getElementById('save-week-well').value.trim(),
      wentHard: document.getElementById('save-week-hard').value.trim(),
      general: '',
    },
  };

  try {
    SAVED_WEEKS.push(week);
    lsSet(LS_KEYS.savedWeeks, SAVED_WEEKS);
    loadSavedWeeks();
    resetListScreenForNewWeek();
    showToast(`"${week.name}" saved — The List is cleared and ready for next week.`);
  } catch (err) {
    showToast(err.message);
  }
});

// Called right after a successful save — clears this week's picks and the
// generated output so The List is ready for the next week's planning.
// The Family Hub (household, rules, schedule) is untouched — that's set up
// once and stays on the shopper's device between weeks.
function resetListScreenForNewWeek() {
  selectedMains = { 'stovetop': null, 'oven': null, 'third-spot': null };
  selectedBreakfast = null;
  selectedSnacks = [null, null];
  weeklyAdjustments = {};
  buyVsMakeAnswers = {};
  cyclePhases = {};
  generatedList = null;
  document.getElementById('grocery-output').hidden = true;
  document.getElementById('generate-status').hidden = true;
  renderListScreen();
}

// ---------------- init ----------------

(async () => {
  await Promise.all([loadRecipes(), loadHousehold(), loadSavedWeeks()]);
  checkAiStatus();
  renderListScreen();
})();
