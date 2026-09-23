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
in "groceryBaseline" and every person's "target"/"avgDaily"/"gap" is GROUND TRUTH, already
correct. Your job is judgment and writing, not arithmetic: decide which allergy/dislike
rules apply, assemble the grocery list and weigh & pack, and write specific nutrition
advice. You never invent, recalculate, round further, or re-derive a quantity.

THE ONE RULE THAT MATTERS MOST: for every ingredient in "groceryBaseline", the qty you
return (summed across every item you produce for it — a swap item plus a remaining item
both count) must equal that ingredient's "totalQty" EXACTLY, in the SAME unit — no
conversions. You may re-route which item an amount sits on (see RULE MATCHING below); you
may never change how much of it exists, and every item you return must have a
"sourceName" that exactly matches a real ingredient name in groceryBaseline — never an
item that doesn't trace back to one. If a family rule removes an ingredient entirely, list
it in "excludedIngredients" instead of silently omitting it — that is how the app tells
the difference between "you correctly excluded this" and "you dropped a number."

**CATEGORIES — you do not assign these.** groceryBaseline is already organized into exactly
3 supermarket-shopping categories, and there are never more than these 3: "Fresh Produce &
Bakery" (fruit, veg, roots, bread/pita/tortillas/anything bakery), "Dairy & Proteins"
(anything from the fridge or freezer — meat, fish, dairy, eggs), and "Pantry" (everything
shelf-stable — spices, oils, sauces, cans/jars, dried grains/legumes, and the catch-all for
anything that isn't clearly one of the other two). Your response is a flat list of items
("items", not grouped by category) — the app re-attaches each item's category itself by
looking up its "sourceName" in groceryBaseline. Do not invent a category, do not try to
move an item to a "better" one — that decision was already made correctly before you saw
this data.

**RULE MATCHING — read the raw text yourself, it will have typos and shorthand:**
"recipeEaters" lists who eats each recipe and THEIR OWN rule notes, exactly as the
household typed them (e.g. "dont llike okra" means this person dislikes okra — read for
real meaning, not a literal keyword match). "familyRules" apply to every recipe regardless
of who's eating, household-wide.
- type "allergy" (or any family rule) = HARD: must never reach that person's/the
  household's plate. Find their exact contribution for that ingredient in its
  "contributions" array (matched by recipeName + memberName — their contribution's qty is
  already computed, don't recalculate it), and split it into its own item named
  "<ingredient> — swap for <name> (<their rule note>): <a sensible substitute>" carrying
  EXACTLY that contribution's qty/unit, with "sourceName" still the ORIGINAL ingredient
  name (that's how the app knows the swap item belongs in that ingredient's real category
  — you never state a category yourself). The remaining item (if any quantity is left)
  keeps totalQty minus that amount, same sourceName/unit as the baseline. A family rule
  instead removes the ingredient for every contribution across every recipe — put it in
  "excludedIngredients" and don't return an item for it at all.
- type "dislike" = SOFT: NEVER change the shared grocery quantity or split an item for it.
  Add a short prep flag instead (e.g. "Vic dislikes onion — leave hers out when plating").

**PANTRY / SPICE ITEMS — "isPantryUnit": true on a groceryBaseline item** means it's
measured in tsp/tbsp/pinch/"to taste" — nobody buys curry powder in units of "2 tbsp," so
never invent a fake retail size ("1 jar", "1 pack") for these. Instead write "displayQty"
as "<qty> <unit> needed" (e.g. "2 tbsp needed", "3 tsp needed") — the item still belongs in
its real category (usually Pantry) with everything else; the app sorts these
to the end of their category automatically, you don't need to reorder anything yourself.

**BUY VS MAKE / TRAINING / CYCLE PHASE** — the ingredient names in groceryBaseline already
reflect the household's buy-vs-make choice (the engine picked the label, not you). Use
each adult's "cyclePhase" and "trainingDetail" (free text) only to make AI Advice more
specific — never to change a quantity.

**WEIGH & PACK — state a real per-serving portion AND how many servings, never a bare
weekly total.** Organized by recipe, covering the mains, breakfast, and snacks. For each
recipe in "recipeEaters", list EVERY eater. For each eater, find their contribution(s) to
that recipe's ingredients in groceryBaseline's "contributions" arrays (matched by
recipeName + memberName) — each contribution already gives you "qtyPerOccasion" (one
serving, already computed) and "occasionsPerWeek" (how many times they eat it this week,
already computed). Report BOTH, explicitly, as separate fields ("servingSize" and
"servingsThisWeek") — never collapse them into one number, and never report a weekly TOTAL
as if it were a single portion (that is a real bug this app has shipped before: a whole
week's salmon reported as "one portion"). If a hard rule swaps them onto a substitute, say
so in "note". CHILDREN ARE INCLUDED HERE, with their real portion, no different from an
adult's line — the "never mention calories/macros for a child" rule below applies ONLY to
AI Advice, not to Weigh & Pack. A portion size in grams is practical prep information a
cook needs, not a nutrition assessment — do not skip a child here.

How much of "servingSize" to include depends on "mealType" (each recipeEaters entry has
one):
- mealType "breakfast" or "snack" — list EVERY ingredient's amount for that person's
  serving, no exceptions. A jar of overnight oats missing its chia/honey/vanilla because
  they seemed minor is exactly the kind of incompleteness that makes this section useless
  to whoever's actually packing jars — small components matter here precisely because
  there are few ingredients and each one is a deliberate part of the recipe.
- mealType "main" — focus on the protein/carb components as the headline, and still
  mention a sauce/other amount if it's meaningfully large; a main can have enough
  incidental ingredients (garnish, a pinch of this, a dash of that) that listing every
  single one adds noise rather than clarity for a cook plating a full dish.

**AI ADVICE** — max 3 points per person, as concise as possible. Medical/allergy first,
the "gapFillSnack" mentioned first if one is present. If someone's on target / nothing
stands out, say so briefly and recommend nothing further — never pad to fill 3 points.

- ADULTS with a "target": use their real target/avgDaily/gap/warnings/cyclePhase/
  trainingDetail for specific, nutritionist-quality advice — never generic tips.
- CHILDREN: this data was deliberately NOT sent to you (no "target"/"gap"/"avgDaily" exists
  for a child in "people") — that is the guardrail, not an instruction to work around. A
  child's advice must NEVER mention calories, kcal, grams of protein/fat/carb, macros,
  portion size being too much/too little, bulking, cutting, or weight — if you don't have
  the numbers, you cannot reference them, and you must not estimate or reconstruct them
  from the recipes either. Instead, base a child's advice on real, source-checked general
  pediatric nutrition guidance and whatever food-group signal you can see from
  "recipeEaters"/"groceryBaseline" for that child this week — e.g. no produce ("Fresh
  Produce & Bakery") ingredient has their name in its contributions this week → "this
  week's plan is light on fruit/veg for [name]"; a reminder about water, variety, or a
  missing food group is appropriate; a calorie/macro/portion comment is not, under any
  framing. If nothing food-quality-relevant stands out, skip the child's aiAdvice entry
  entirely rather than inventing something.
- This is advice only, not a commitment — a recommended snack must NEVER be treated as
  something the household has already decided to buy. Do not add its ingredients to any
  grocery list; just name the snack and portion in the recommendation text so the person
  can add it themselves if they want to.

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "items": [
    {
      "sourceName": "string — the EXACT original ingredient name from groceryBaseline this item derives from (required on every item — used to verify your numbers AND to look up its category)",
      "name": "string — display name (a swap item's own descriptive name, or the same as sourceName if unchanged)",
      "qty": number,
      "unit": "string — EXACTLY the same unit groceryBaseline used, no conversions",
      "displayQty": "string — human-readable, e.g. '1.2 kg' or '8 medium'; for an isPantryUnit item, '<qty> <unit> needed'",
      "shelfLife": "string or null",
      "freezeFriendly": true|false
    }
  ],
  "excludedIngredients": [
    { "sourceName": "string", "familyRule": "string" }
  ],
  "flags": [
    { "scope": "family"|"individual", "type": "allergy"|"dislike"|null, "memberName": "string or null", "ingredient": "string", "recipeName": "string", "note": "string or null", "resolution": "string" }
  ],
  "aiAdvice": [
    { "memberName": "string", "summary": "string", "recommendation": "string or null" }
  ],
  "weighAndPack": [
    {
      "recipeName": "string",
      "portions": [
        {
          "memberName": "string",
          "servingSize": "string — ONE serving, e.g. '140g kafta, sauce as per recipe ratio'",
          "servingsThisWeek": "number — from that contribution's occasionsPerWeek, unmodified",
          "note": "string or null"
        }
      ]
    }
  ]
}

"qty"/"unit" on grocery items and "servingsThisWeek" in weigh & pack are both validated
against the engine's numbers — get them right; "displayQty"/"servingSize" are yours to
write naturally.
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
    // groceryBaseline items now also carry occasionsPerWeek + qtyPerOccasion per
    // contribution, and isPantryUnit per item — see lib/mealEngine.js's
    // buildGroceryBaseline. The AI reads these numbers, it never computes them.
    groceryBaseline: engineResult.groceryBaseline,
    recipeEaters: engineResult.recipeEaters,
    buyVsMake: buyVsMake || [],
  };
}

// Indexes groceryBaseline by ingredient name (case-insensitive) — this is now the ONLY
// source of truth for an item's category. The AI's response never carries a category at
// all (see ASSEMBLY_SYSTEM_PROMPT's "you do not assign these"), which is what closes the
// bug where the AI invented extra categories / misfiled items: there's no field left for
// it to get that wrong in.
function indexBaselineByName(groceryBaseline) {
  const index = new Map();
  for (const cat of groceryBaseline) {
    for (const item of cat.items) {
      index.set(item.name.toLowerCase(), { category: cat.name, ...item });
    }
  }
  return index;
}
function round1(n) { return Math.round(n * 10) / 10; }

// ---------------- guardrail (Point 5, revised) ----------------
//
// Two independent things get checked, both against numbers the engine already computed —
// never anything the AI asserts about itself:
// 1. Grocery quantities: every baseline ingredient's totalQty must be matched EXACTLY
//    (small float tolerance) by the sum of every returned item sharing its sourceName —
//    unless it's listed in excludedIngredients (a legitimate family-rule removal, not a
//    dropped number). An item whose sourceName doesn't match any real baseline ingredient
//    is now ALSO a mismatch — previously nothing checked for fabricated items, which is
//    how invented categories slipped through undetected.
// 2. Weigh & Pack completeness: every eater recipeEaters says should appear for a recipe
//    must appear in that recipe's weighAndPack portions, and their servingsThisWeek must
//    match that person's real occasionsPerWeek — this is the check that would have caught
//    "790g of salmon" being reported as a single portion (a weekly total, not one serving)
//    and a child silently missing from Weigh & Pack.
// Returns { mismatches, unknownItems } — unknownItems (fabricated sourceNames) get dropped
// outright in the fallback rather than "corrected", since there's no baseline line to fall
// back to for something that was never real.
function validateAssemblyAgainstBaseline(groceryBaseline, recipeEaters, aiResult) {
  const mismatches = [];
  const unknownItems = [];
  const baselineIndex = indexBaselineByName(groceryBaseline);
  const excludedKeys = new Set((aiResult.excludedIngredients || []).map((e) => String(e.sourceName || '').toLowerCase()));

  const returnedSums = new Map(); // sourceName (lowercase) -> { qty, unit }
  for (const item of aiResult.items || []) {
    if (!item.sourceName) { mismatches.push(`Item "${item.name}" is missing sourceName.`); continue; }
    const key = item.sourceName.toLowerCase();
    if (!baselineIndex.has(key)) { unknownItems.push(item.sourceName); mismatches.push(`"${item.sourceName}" doesn't match any real groceryBaseline ingredient — fabricated or misspelled.`); continue; }
    const existing = returnedSums.get(key) || { qty: 0, unit: item.unit };
    if (existing.unit && item.unit && existing.unit !== item.unit) {
      mismatches.push(`"${item.sourceName}" has inconsistent units across split items (${existing.unit} vs ${item.unit}).`);
    }
    existing.qty += Number(item.qty) || 0;
    returnedSums.set(key, existing);
  }

  for (const [key, baseItem] of baselineIndex) {
    if (excludedKeys.has(key)) {
      if (returnedSums.has(key)) mismatches.push(`"${baseItem.name}" was marked excluded but still appears in items.`);
      continue;
    }
    const returned = returnedSums.get(key);
    if (!returned) { mismatches.push(`"${baseItem.name}" (baseline ${baseItem.totalQty}${baseItem.unit}) is missing from the response.`); continue; }
    if (returned.unit !== baseItem.unit) { mismatches.push(`"${baseItem.name}" returned in unit "${returned.unit}", baseline unit is "${baseItem.unit}".`); continue; }
    const diff = Math.abs(returned.qty - baseItem.totalQty);
    const tolerance = Math.max(0.05, baseItem.totalQty * 0.005); // 0.5%, floor 0.05 for tiny quantities
    if (diff > tolerance) {
      mismatches.push(`"${baseItem.name}": baseline ${baseItem.totalQty}${baseItem.unit}, response summed to ${round1(returned.qty)}${returned.unit}.`);
    }
  }

  const weighAndPackByRecipe = new Map((aiResult.weighAndPack || []).map((r) => [r.recipeName, r]));
  for (const { recipeName, eaters } of recipeEaters) {
    const entry = weighAndPackByRecipe.get(recipeName);
    if (!entry) { mismatches.push(`Weigh & Pack is missing "${recipeName}" entirely (${eaters.length} eater(s) expected).`); continue; }
    const portionsByMember = new Map((entry.portions || []).map((p) => [p.memberName, p]));
    for (const eater of eaters) {
      const portion = portionsByMember.get(eater.memberName);
      if (!portion) { mismatches.push(`Weigh & Pack "${recipeName}" is missing ${eater.memberName} (they eat this ${eater.occasionsPerWeek}x/week).`); continue; }
      const servings = Number(portion.servingsThisWeek);
      if (!Number.isFinite(servings)) { mismatches.push(`Weigh & Pack "${recipeName}" / ${eater.memberName}: servingsThisWeek is missing or not a number.`); continue; }
      if (Math.abs(servings - eater.occasionsPerWeek) > 0.15) {
        mismatches.push(`Weigh & Pack "${recipeName}" / ${eater.memberName}: servingsThisWeek is ${servings}, but recipeEaters says ${eater.occasionsPerWeek}x/week — looks like a weekly total was reported as one serving, or vice versa.`);
      }
    }
  }

  return { mismatches, unknownItems };
}

// One retry with a stricter reminder if the guardrail catches a mismatch; if it's still
// wrong, fall back to the engine's own raw line for just the mismatched ingredient(s) and
// flag them for manual review — never ships a silently-wrong quantity, and never fails the
// whole list over one bad item.
async function generateWeekAssembly(engineResult, { cookSchedule, buyVsMake }) {
  const payload = buildAssemblyPayload(engineResult, { cookSchedule, buyVsMake });
  const basePrompt = `Here is this week's plan. Assemble the grocery list, weigh & pack, and AI Advice.\n\n${JSON.stringify(payload, null, 2)}`;

  let result = await callClaudeMessages([{ type: 'text', text: basePrompt }], { system: ASSEMBLY_SYSTEM_PROMPT, maxTokens: 10000 });
  let { mismatches, unknownItems } = validateAssemblyAgainstBaseline(engineResult.groceryBaseline, engineResult.recipeEaters, result);

  if (mismatches.length > 0) {
    const retryPrompt = `${basePrompt}\n\nYour previous attempt had these problems — fix them exactly, the numbers listed are ground truth:\n${mismatches.map((m) => `- ${m}`).join('\n')}\n\nRemember: every item needs a real sourceName from groceryBaseline (never invent one), every ingredient's qty (summed across split items) must equal its baseline totalQty exactly in the same unit, and every Weigh & Pack entry must list every eater from recipeEaters with servingsThisWeek matching their real occasionsPerWeek (never their weekly total quantity).`;
    result = await callClaudeMessages([{ type: 'text', text: retryPrompt }], { system: ASSEMBLY_SYSTEM_PROMPT, maxTokens: 10000 });
    ({ mismatches, unknownItems } = validateAssemblyAgainstBaseline(engineResult.groceryBaseline, engineResult.recipeEaters, result));
  }

  if (mismatches.length > 0) {
    result = applyGroceryFallback(engineResult.groceryBaseline, result, mismatches, unknownItems);
  }

  // Server-side category assignment (never the AI's) + grouping, then sort pantry/spice
  // items to the end of their category — both per this fix, not left to the model.
  result.categories = attachCategoriesAndSort(engineResult.groceryBaseline, result.items || []);

  // Backstop, not just a prompt instruction: children CAN get advice (food-quality/food-
  // group guidance is wanted), but never calorie/macro content — and their target/gap
  // numbers were already withheld from the payload above, so there's nothing real for the
  // model to cite. This scans for it anyway and drops just that entry if it slips through,
  // rather than trusting prompt wording alone for something this specific.
  const childNames = new Set(engineResult.people.filter((p) => p.isChild).map((p) => p.name));
  const CHILD_ADVICE_BANNED_PATTERNS = [
    /\d+(\.\d+)?\s*(kcal|calories?)\b/i,
    /\d+(\.\d+)?\s*g\s*(of\s*)?(protein|fat|carbs?|carbohydrates?)\b/i,
    /\bmacros?\b/i,
  ];
  result.aiAdvice = (result.aiAdvice || []).filter((a) => {
    if (!childNames.has(a.memberName)) return true;
    const text = `${a.summary || ''} ${a.recommendation || ''}`;
    return !CHILD_ADVICE_BANNED_PATTERNS.some((re) => re.test(text));
  });

  return result;
}

// Groups the AI's flat item list into the app's fixed categories using ONLY the baseline's
// own category per sourceName (never anything the AI said), then moves isPantryUnit items
// to the end of their category so spices/staples cluster together instead of scattering
// through the produce/protein sections. Adapts to the shape the frontend renders
// (items[].qty as a display string) in the same pass.
function attachCategoriesAndSort(groceryBaseline, aiItems) {
  const baselineIndex = indexBaselineByName(groceryBaseline);
  const byCategory = new Map();

  for (const item of aiItems) {
    const base = item.sourceName ? baselineIndex.get(item.sourceName.toLowerCase()) : null;
    if (!base) continue; // fabricated/unmatched — already dropped by applyGroceryFallback if this ran after a mismatch
    if (!byCategory.has(base.category)) byCategory.set(base.category, []);
    byCategory.get(base.category).push({
      name: item.name || base.name,
      qty: item.displayQty || `${item.qty ?? base.totalQty} ${item.unit || base.unit || ''}`.trim(),
      shelfLife: item.shelfLife ?? base.shelfLife ?? null,
      freezeFriendly: Boolean(item.freezeFriendly ?? base.freezeFriendly),
      _isPantryUnit: Boolean(base.isPantryUnit),
    });
  }

  return Array.from(byCategory.entries()).map(([name, items]) => ({
    name,
    // Stable sort: pantry/spice items to the end, otherwise keep the AI's own ordering.
    items: items
      .map((it, idx) => ({ ...it, _idx: idx }))
      .sort((a, b) => (a._isPantryUnit === b._isPantryUnit ? a._idx - b._idx : a._isPantryUnit ? 1 : -1))
      .map(({ name, qty, shelfLife, freezeFriendly }) => ({ name, qty, shelfLife, freezeFriendly })),
  }));
}

// For each ingredient the guardrail flagged as a genuine quantity mismatch (not a
// fabricated item — those are just dropped, there's nothing real to fall back to),
// discard whatever the AI returned for it and substitute the engine's own raw baseline
// line instead — unswapped, but numerically guaranteed correct, flagged for manual
// review so a human can apply any rule the AI missed by hand. Never touches ingredients
// that passed validation.
function applyGroceryFallback(groceryBaseline, aiResult, mismatches, unknownItems) {
  const unknownSet = new Set(unknownItems.map((n) => n.toLowerCase()));
  const badKeys = new Set();
  for (const cat of groceryBaseline) {
    for (const item of cat.items) {
      if (mismatches.some((m) => m.includes(`"${item.name}"`))) badKeys.add(item.name.toLowerCase());
    }
  }

  const items = (aiResult.items || []).filter((item) => {
    const key = (item.sourceName || '').toLowerCase();
    return !unknownSet.has(key) && !badKeys.has(key);
  });
  for (const cat of groceryBaseline) {
    for (const item of cat.items) {
      if (!badKeys.has(item.name.toLowerCase())) continue;
      items.push({
        sourceName: item.name, name: `${item.name} (needs manual review — the app couldn't verify the AI's numbers for this item)`,
        qty: item.totalQty, unit: item.unit, displayQty: `${item.totalQty} ${item.unit || ''}`.trim(),
        shelfLife: item.shelfLife, freezeFriendly: item.freezeFriendly,
      });
    }
  }
  return { ...aiResult, items };
}

module.exports = {
  hasApiKey, extractRecipeFromText, extractRecipeFromImage, classifyRecipeDraft,
  generateWeekAssembly, buildAssemblyPayload, validateAssemblyAgainstBaseline,
};
