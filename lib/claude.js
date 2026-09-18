// Thin wrapper around the Claude API (Messages endpoint) — no SDK dependency,
// just the global fetch that ships with Node 18+.
//
// Used to turn messy recipe text or a photo of a recipe into the structured
// JSON shape the app's recipe files use. Requires ANTHROPIC_API_KEY to be set
// (see .env.example) — without it, callers should fall back to a manual-review
// flow instead of calling anything here.

const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

function hasApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  return Boolean(key && key.trim() && !key.startsWith('sk-REPLACE'));
}

const RECIPE_SCHEMA_INSTRUCTIONS = `
Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "name": "string",
  "protein": "beef" | "chicken" | "seafood" | "veggie" | null,
  "method": "stovetop" | "oven" | "third-spot" | null,
  "mealType": "main" | "breakfast" | "snack",
  "feeds": number,
  "macrosPerServing": { "kcal": number, "protein": number, "carbs": number, "fat": number },
  "ingredients": [
    { "name": "string", "qty": number|null, "unit": "string|null", "component": "protein"|"carb"|"sauce"|"aromatic"|"other" }
  ],
  "steps": ["string", ...],
  "notes": ["string", ...],
  "flags": { "shelfLife": "string or null", "freezeFriendly": true|false }
}

Rules:
- "protein" and "method" are a best guess from the ingredients/technique — use null only if you truly can't tell.
  There are ONLY 3 valid "method" values — never invent one outside them: "stovetop" (cooked in a pot/
  pan on the hob), "oven" (baked/roasted), or "third-spot" (everything else — air fryer, no-cook/cold,
  rice cooker, outdoor grill, whatever). A cold dish (salad, no active cooking) is a completely normal,
  valid recipe — tag it "third-spot", don't force it into stovetop/oven just because it's a main course.
- "mealType": "main" if this is a full lunch/dinner someone would eat as the whole meal. "breakfast"
  if it's clearly a breakfast dish (oats, egg muffins, parfait, etc). "snack" if it's really a dip,
  side, condiment, or light bite (e.g. guacamole, hummus on its own) — a giveaway is low protein
  (under ~10g/serving), under ~250 kcal/serving, or no real protein source, and it's not a breakfast dish.
- "component" on each ingredient: the main meat/fish/legume = "protein", rice/pasta/potato/bread = "carb",
  sauces/spice blends/pastes = "sauce", onion/garlic/fresh herbs used for flavor base = "aromatic", everything
  else (garnish, sides, oil, salt) = "other".
- If macros aren't given, estimate them reasonably from the ingredients — don't leave zeros unless truly unknown.
- "flags.shelfLife" should flag fresh fish/seafood or anything that won't keep a week, else null.
- Keep step instructions concise and in plain English.
`.trim();

async function callClaudeMessages(content, { maxTokens = 3000, system } = {}) {
  if (!hasApiKey()) {
    throw new Error('No ANTHROPIC_API_KEY configured');
  }

  const controller = new AbortController();
  const timeoutMs = 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        // This model reasons with extended thinking by default, which spends
        // the max_tokens budget on invisible "thinking" tokens before ever
        // writing the actual reply — for a single-shot JSON answer like ours
        // that just burns the whole budget with nothing to show for it.
        thinking: { type: 'disabled' },
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Claude took too long to respond (over ${timeoutMs / 1000}s) — try again.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');

  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Claude's response was cut off at the token limit before finishing — try again with fewer recipes/snacks, or increase maxTokens.`);
  }

  return parseJsonLoose(text);
}

function parseJsonLoose(text) {
  let cleaned = text.trim();
  // Strip ```json ... ``` fences if the model added them anyway.
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  return JSON.parse(cleaned);
}

async function extractRecipeFromText(rawText, hintName) {
  const prompt = `Extract a structured recipe from the text below. ${hintName ? `The recipe's name is "${hintName}".` : ''}

${RECIPE_SCHEMA_INSTRUCTIONS}

RECIPE TEXT:
"""
${rawText.slice(0, 12000)}
"""`;

  return callClaudeMessages([{ type: 'text', text: prompt }]);
}

// A structured (JSON-LD) URL import gets its name/ingredients/quantities/steps straight
// from the page's own recipe markup — accurate, and skips Claude entirely for speed. But
// that markup never says which protein/method this is, never tags ingredient components
// (protein/carb/sauce/aromatic — what Calculation Engine v2 needs to know what's scalable),
// and often doesn't publish nutrition data. This fills in exactly those gaps and nothing
// else — it must never overwrite a name, quantity, step, or a macro the page already gave.
async function classifyRecipeDraft({ name, feeds, ingredients, macrosPerServing }) {
  const needsMacros = !macrosPerServing || (!macrosPerServing.kcal && !macrosPerServing.protein
    && !macrosPerServing.carbs && !macrosPerServing.fat);

  const prompt = `A recipe's name, ingredients, and quantities were already extracted accurately from a
webpage's own structured data — do not change or second-guess any of that. Your only job is
to classify what that page's markup doesn't provide.

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "protein": "beef" | "chicken" | "seafood" | "veggie" | null,
  "method": "stovetop" | "oven" | "third-spot" | null,
  "mealType": "main" | "breakfast" | "snack",
  "ingredientComponents": ["protein"|"carb"|"sauce"|"aromatic"|"other", ...] // same length and order as the ingredients list below
  ${needsMacros ? ',\n  "macrosPerServing": { "kcal": number, "protein": number, "carbs": number, "fat": number }' : ''}
}

Rules:
- "protein" and "method" are a best guess from the ingredients/technique — use null only if you truly can't tell.
  There are ONLY 3 valid "method" values — never invent one outside them: "stovetop" (cooked in a pot/
  pan on the hob), "oven" (baked/roasted), or "third-spot" (everything else — air fryer, no-cook/cold,
  rice cooker, outdoor grill, whatever). A cold dish (salad, no active cooking) is a completely normal,
  valid recipe — tag it "third-spot", don't force it into stovetop/oven just because it's a main course.
- "mealType": "main" if this is a full lunch/dinner someone would eat as the whole meal. "breakfast"
  if it's clearly a breakfast dish (oats, egg muffins, parfait, etc). "snack" if it's really a dip,
  side, condiment, or light bite — a giveaway is low protein (under ~10g/serving), under ~250
  kcal/serving, or no real protein source, and it's not a breakfast dish.
- "ingredientComponents": the main meat/fish/legume = "protein", rice/pasta/potato/bread = "carb",
  sauces/spice blends/pastes = "sauce", onion/garlic/fresh herbs used for flavor base = "aromatic",
  everything else (garnish, sides, oil, salt) = "other".
${needsMacros ? '- This page did not publish nutrition data — estimate macrosPerServing reasonably from the ingredients, don\'t leave zeros unless truly unknown.' : ''}

RECIPE: "${name}" (feeds ${feeds})
INGREDIENTS:
${ingredients.map((i, idx) => `${idx + 1}. ${[i.qty, i.unit, i.name].filter(Boolean).join(' ')}`).join('\n')}`;

  return callClaudeMessages([{ type: 'text', text: prompt }], { maxTokens: 1500 });
}

async function extractRecipeFromImage(base64Data, mimeType) {
  const prompt = `This image shows a recipe (handwritten or printed). Read it carefully and extract a structured recipe.

${RECIPE_SCHEMA_INSTRUCTIONS}`;

  return callClaudeMessages([
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
    { type: 'text', text: prompt },
  ]);
}

// ---------------- weekly list assembly (Point 5 / Stage 4 rewire) ----------------
//
// Everything numeric is already computed by lib/mealEngine.js before this call ever runs
// — this prompt's job is judgment and writing, never arithmetic: which allergy/dislike
// rules apply (read from raw, unedited household text), the final grocery list, weigh &
// pack, and AI Advice. See generateWeekAssembly's guardrail below for how a quantity
// mismatch in the response is caught and never silently shipped.

const ASSEMBLY_SYSTEM_PROMPT = `
You are assembling the final weekly output for The Unhangry Society meal prep system. All
of the MATH is already done by deterministic code before you ever see this — every number
in "groceryBaseline" and every person's "target"/"avgDaily"/"gap"/"mainPortions" is GROUND
TRUTH, already correct. Your job is judgment and writing, not arithmetic: decide which
allergy/dislike rules apply, assemble the grocery list and weigh & pack, and write specific
nutrition advice. You never invent, recalculate, round further, or re-derive a quantity.

THE ONE RULE THAT MATTERS MOST: for every ingredient in "groceryBaseline", the qty you
return (summed across every line you produce for it — a swap line plus a remaining line
both count) must equal that ingredient's "totalQty" EXACTLY, in the SAME unit — no
conversions. You may re-route which line an amount sits on (see RULE MATCHING below); you
may never change how much of it exists. If a family rule removes an ingredient entirely,
list it in "excludedIngredients" instead of silently omitting it — that is how the app
tells the difference between "you correctly excluded this" and "you dropped a number."

**RULE MATCHING — read the raw text yourself, it will have typos and shorthand:**
"recipeEaters" lists who eats each recipe and THEIR OWN rule notes, exactly as the
household typed them (e.g. "dont llike okra" means this person dislikes okra — read for
real meaning, not a literal keyword match). "familyRules" apply to every recipe regardless
of who's eating, household-wide.
- type "allergy" (or any family rule) = HARD: must never reach that person's/the
  household's plate. Find their exact contribution for that ingredient in its
  "contributions" array (matched by recipeName + memberName — their contribution's qty is
  already computed, don't recalculate it), and split it into its own line named
  "<ingredient> — swap for <name> (<their rule note>): <a sensible substitute>" carrying
  EXACTLY that contribution's qty/unit. The remaining line (if any quantity is left) keeps
  totalQty minus that amount, same name/unit as the baseline. A family rule instead removes
  the ingredient for every contribution across every recipe — put it in
  "excludedIngredients" and don't list it in "categories" at all.
- type "dislike" = SOFT: NEVER change the shared grocery quantity or split a line for it.
  Add a short prep flag instead (e.g. "Vic dislikes onion — leave hers out when plating").

**GROCERY LIST** — "categories": the baseline's lines, untouched except for the rule
matching above. Every item needs a "sourceName" = the exact original ingredient name from
groceryBaseline it derives from (so a swap line and its remaining line share the same
sourceName) — this is how the app verifies your quantities, so it must be exact.

**BUY VS MAKE / TRAINING / CYCLE PHASE** — the ingredient names in groceryBaseline already
reflect the household's buy-vs-make choice (the engine picked the label, not you). Use
each adult's "cyclePhase" and "trainingDetail" (free text) only to make AI Advice more
specific — never to change a quantity.

**WEIGH & PACK** — organized by recipe, covering the mains, breakfast, and snacks. For
each recipe in "recipeEaters", list EVERY eater with their specific portion in
grams/practical units — read it straight from that ingredient's "contributions" array in
groceryBaseline (matched by recipeName + memberName), don't re-derive it from a factor.
Focus on the recipe's protein/carb components for the headline portion text; you can
mention a sauce/other amount too if it's meaningfully large. If a hard rule swaps them onto
a substitute, say so on their line. CHILDREN ARE INCLUDED HERE, with their real portion, no
different from an adult's line — the "never mention calories/macros for a child" rule
below applies ONLY to AI Advice, not to Weigh & Pack. A portion size in grams is practical
prep information a cook needs, not a nutrition assessment — do not skip a child here.

**AI ADVICE** (this section only — Weigh & Pack above is unaffected by this rule):
- Only for adults ("isChild": false) with a "target" — up to 3 points each, medical/allergy
  first, the "gapFillSnack" mentioned first if one is present. Use their real
  target/avgDaily/gap/warnings/cyclePhase/trainingDetail for specific, nutritionist-quality
  advice — never generic tips. If someone's on target, say so briefly and recommend nothing
  further.
- CHILDREN — a hard rule for THIS SECTION: never write ANYTHING about calories, macros,
  protein/fat/carb targets, portion size being too much/too little, bulking, or cutting for
  a child. Their calorie/macro computations are backend-only and must never surface in
  written text. If a child needs an aiAdvice entry at all (e.g. an allergy swap applies to
  them), keep it to a practical prep note only, never a nutrition assessment. When in
  doubt, skip the child from aiAdvice entirely rather than risk this — but this does NOT
  apply to Weigh & Pack, where children are always included normally.
- This is advice only, not a commitment — a recommended snack must NEVER be treated as
  something the household has already decided to buy. Do not add its ingredients to any
  grocery list; just name the snack and portion in the recommendation text so the person
  can add it themselves if they want to.

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "categories": [
    {
      "name": "Fresh Produce" | "Proteins and Meat" | "Fish and Seafood" | "Dry Goods and Pantry" | "Dairy and Chilled" | "Canned and Jarred" | "Freezer",
      "items": [
        {
          "sourceName": "string — the EXACT original ingredient name from groceryBaseline this line derives from (required, used to verify your numbers)",
          "name": "string — display name (a swap line's own descriptive name, or the same as sourceName if unchanged)",
          "qty": number,
          "unit": "string — EXACTLY the same unit groceryBaseline used, no conversions",
          "displayQty": "string — human-readable, e.g. '1.2 kg' or '8 medium'",
          "shelfLife": "string or null",
          "freezeFriendly": true|false
        }
      ]
    }
  ],
  "excludedIngredients": [
    { "sourceName": "string", "category": "string", "familyRule": "string" }
  ],
  "flags": [
    { "scope": "family"|"individual", "type": "allergy"|"dislike"|null, "memberName": "string or null", "ingredient": "string", "recipeName": "string", "note": "string or null", "resolution": "string" }
  ],
  "aiAdvice": [
    { "memberName": "string", "summary": "string", "recommendation": "string or null" }
  ],
  "weighAndPack": [
    { "recipeName": "string", "portions": [ { "memberName": "string", "portionText": "string (e.g. '320g fish · 180g rice')", "note": "string or null" } ] }
  ]
}

Only include categories that actually have items. "qty"/"unit" are validated against
groceryBaseline — get them right; "displayQty" is yours to write naturally.
`.trim();

// Builds the payload for the single combined assembly call. Deliberately does NOT include
// full recipe objects (macrosPerServing, feeds, raw ingredient lists) — everything the AI
// needs (quantities, who eats what, targets/gaps) is already in the engine's output below,
// and not handing over the raw recipes removes any temptation/ability to re-derive a
// number instead of reading the one it was given.
function buildAssemblyPayload(engineResult, { cookSchedule, buyVsMake }) {
  return {
    cookDays: cookSchedule.cookDays,
    breakfastDays: cookSchedule.breakfastDays,
    familyRules: engineResult.familyRules,
    people: engineResult.people.map((p) => ({
      name: p.name,
      isChild: p.isChild,
      // Children: target/avgDaily/gap/warnings are deliberately left OUT of this payload
      // entirely (not just "don't mention them") — the child's calorie/macro system is a
      // real computation (Point 1), but it's backend-only, and the surest way to guarantee
      // it never leaks into written Advice is to never put the numbers in front of the
      // model that writes Advice.
      ...(p.isChild ? {} : {
        target: p.target, avgDaily: p.avgDaily, gap: p.gap, warnings: p.warnings, gapFillSnack: p.gapFillSnack,
      }),
      cyclePhase: p.cyclePhase, trainingDetail: p.trainingDetail,
    })),
    groceryBaseline: engineResult.groceryBaseline,
    recipeEaters: engineResult.recipeEaters,
    buyVsMake: buyVsMake || [],
  };
}

// ---------------- guardrail (Point 5) ----------------
//
// Validates the AI's returned categories against groceryBaseline's ground truth: every
// baseline ingredient's totalQty must be matched EXACTLY (small float tolerance) by the
// sum of every returned item sharing its sourceName, in the same unit — unless it's listed
// in excludedIngredients (a legitimate family-rule removal, not a dropped number). Returns
// a list of mismatches (empty = clean).
function validateAssemblyAgainstBaseline(groceryBaseline, aiResult) {
  const mismatches = [];
  const excludedKeys = new Set((aiResult.excludedIngredients || []).map((e) => `${e.category}::${e.sourceName}`.toLowerCase()));

  const returnedSums = new Map(); // `${category}::${sourceName}` -> { qty, unit }
  for (const cat of aiResult.categories || []) {
    for (const item of cat.items || []) {
      if (!item.sourceName) { mismatches.push(`Item "${item.name}" in "${cat.name}" is missing sourceName.`); continue; }
      const key = `${cat.name}::${item.sourceName}`.toLowerCase();
      const existing = returnedSums.get(key) || { qty: 0, unit: item.unit };
      if (existing.unit && item.unit && existing.unit !== item.unit) {
        mismatches.push(`"${item.sourceName}" in "${cat.name}" has inconsistent units across split lines (${existing.unit} vs ${item.unit}).`);
      }
      existing.qty += Number(item.qty) || 0;
      returnedSums.set(key, existing);
    }
  }

  for (const cat of groceryBaseline) {
    for (const baseItem of cat.items) {
      const key = `${cat.name}::${baseItem.name}`.toLowerCase();
      if (excludedKeys.has(key)) {
        if (returnedSums.has(key)) mismatches.push(`"${baseItem.name}" in "${cat.name}" was marked excluded but still appears in categories.`);
        continue;
      }
      const returned = returnedSums.get(key);
      if (!returned) { mismatches.push(`"${baseItem.name}" in "${cat.name}" (baseline ${baseItem.totalQty}${baseItem.unit}) is missing from the response.`); continue; }
      if (returned.unit !== baseItem.unit) { mismatches.push(`"${baseItem.name}" in "${cat.name}" returned in unit "${returned.unit}", baseline unit is "${baseItem.unit}".`); continue; }
      const diff = Math.abs(returned.qty - baseItem.totalQty);
      const tolerance = Math.max(0.05, baseItem.totalQty * 0.005); // 0.5%, floor 0.05 for tiny quantities
      if (diff > tolerance) {
        mismatches.push(`"${baseItem.name}" in "${cat.name}": baseline ${baseItem.totalQty}${baseItem.unit}, response summed to ${round1(returned.qty)}${returned.unit}.`);
      }
    }
  }
  return mismatches;
}
function round1(n) { return Math.round(n * 10) / 10; }

// One retry with a stricter reminder if the guardrail catches a mismatch; if it's still
// wrong, fall back to the engine's own raw line for just the mismatched ingredient(s) and
// flag them for manual review — never ships a silently-wrong quantity, and never fails the
// whole list over one bad item.
async function generateWeekAssembly(engineResult, { cookSchedule, buyVsMake }) {
  const payload = buildAssemblyPayload(engineResult, { cookSchedule, buyVsMake });
  const basePrompt = `Here is this week's plan. Assemble the grocery list, weigh & pack, and AI Advice.\n\n${JSON.stringify(payload, null, 2)}`;

  let result = await callClaudeMessages([{ type: 'text', text: basePrompt }], { system: ASSEMBLY_SYSTEM_PROMPT, maxTokens: 10000 });
  let mismatches = validateAssemblyAgainstBaseline(engineResult.groceryBaseline, result);

  if (mismatches.length > 0) {
    const retryPrompt = `${basePrompt}\n\nYour previous attempt had quantity mismatches against groceryBaseline — this is not allowed, groceryBaseline is ground truth:\n${mismatches.map((m) => `- ${m}`).join('\n')}\n\nTry again. Every ingredient's qty (summed across any split lines, matched by sourceName) must equal its groceryBaseline totalQty exactly, in the same unit.`;
    result = await callClaudeMessages([{ type: 'text', text: retryPrompt }], { system: ASSEMBLY_SYSTEM_PROMPT, maxTokens: 10000 });
    mismatches = validateAssemblyAgainstBaseline(engineResult.groceryBaseline, result);
  }

  if (mismatches.length > 0) {
    result = applyGroceryFallback(engineResult.groceryBaseline, result, mismatches);
  }

  // Adapt to the shape the frontend already renders (list.categories[].items[].qty as a
  // display string) — qty/unit/sourceName were only needed for the guardrail.
  result.categories = (result.categories || []).map((cat) => ({
    name: cat.name,
    items: (cat.items || []).map((item) => ({
      name: item.name, qty: item.displayQty || `${item.qty} ${item.unit || ''}`.trim(),
      shelfLife: item.shelfLife || null, freezeFriendly: Boolean(item.freezeFriendly),
    })),
  }));
  return result;
}

// For each ingredient the guardrail flagged, drop whatever the AI returned for it and
// substitute the engine's own raw baseline line instead — unswapped, but numerically
// guaranteed correct, with a manual-review flag so a human can apply any rule the AI
// missed by hand. Never touches ingredients that passed validation.
function applyGroceryFallback(groceryBaseline, aiResult, mismatches) {
  const badKeys = new Set();
  for (const cat of groceryBaseline) {
    for (const item of cat.items) {
      if (mismatches.some((m) => m.includes(`"${item.name}"`) && m.includes(`"${cat.name}"`))) {
        badKeys.add(`${cat.name}::${item.name}`.toLowerCase());
      }
    }
  }

  const categories = (aiResult.categories || []).map((cat) => ({
    name: cat.name,
    items: (cat.items || []).filter((item) => !badKeys.has(`${cat.name}::${item.sourceName || item.name}`.toLowerCase())),
  }));
  for (const cat of groceryBaseline) {
    for (const item of cat.items) {
      const key = `${cat.name}::${item.name}`.toLowerCase();
      if (!badKeys.has(key)) continue;
      let target = categories.find((c) => c.name === cat.name);
      if (!target) { target = { name: cat.name, items: [] }; categories.push(target); }
      target.items.push({
        sourceName: item.name, name: `${item.name} (needs manual review — the app couldn't verify the AI's swap for this item)`,
        qty: item.totalQty, unit: item.unit, displayQty: `${item.totalQty} ${item.unit || ''}`.trim(),
        shelfLife: item.shelfLife, freezeFriendly: item.freezeFriendly,
      });
    }
  }
  return { ...aiResult, categories };
}

module.exports = {
  hasApiKey, extractRecipeFromText, extractRecipeFromImage, classifyRecipeDraft,
  generateWeekAssembly, buildAssemblyPayload, validateAssemblyAgainstBaseline,
};
