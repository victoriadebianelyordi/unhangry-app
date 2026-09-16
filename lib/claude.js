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
  "method": "air-fryer" | "oven" | "stovetop" | "no-cook" | null,
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
- "mealType": "main" if this is a full lunch/dinner someone would eat as the whole meal. "breakfast"
  if it's clearly a breakfast dish (oats, egg muffins, parfait, etc). "snack" if it's really a dip,
  side, condiment, or light bite (e.g. guacamole, hummus on its own) — a giveaway is low protein
  (under ~10g/serving), under ~250 kcal/serving, or no real protein source, and it's not a breakfast dish.
- "method": use "no-cook" for anything assembled/chilled with no active cooking (overnight oats, a
  fridge parfait, a dip) instead of forcing it into air-fryer/oven/stovetop.
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

async function extractRecipeFromImage(base64Data, mimeType) {
  const prompt = `This image shows a recipe (handwritten or printed). Read it carefully and extract a structured recipe.

${RECIPE_SCHEMA_INSTRUCTIONS}`;

  return callClaudeMessages([
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
    { type: 'text', text: prompt },
  ]);
}

// ---------------- weekly grocery list generation ----------------
//
// This is a focused, single-purpose prompt — not the full Unhangry Assistant
// chat persona from unhangry_system_prompt_3.md (that's built for a
// back-and-forth planning conversation, with jokes, guardrails for off-topic
// questions, etc). Here we only need its portion-scaling math and output
// format applied once to an already-decided set of recipes, so we ask for
// clean structured JSON instead of a chatty reply.

const GROCERY_LIST_SYSTEM_PROMPT = `
You are the grocery-scaling engine behind The Unhangry Society meal prep system. Given a
household profile and the recipes they picked for the week, calculate the correct total
grocery quantities and return them as structured JSON. This is a calculation task, not a
conversation — no commentary, no chat persona, just accurate numbers.

THE CORE RULE — read carefully:
A recipe's "feeds" number is a base RATIO between ingredients, not a fixed serving count.
Never just divide a recipe by its feeds count and call it done. Each person's actual
portion should scale toward their own daily needs:
- For a household member with a daily calorie target (goal is lose weight / gain muscle /
  maintain weight), scale their share of each recipe up or down so their meals actually
  hit their target — protein and carb components scale most per-person; sauces, aromatics
  and spice blends scale with the whole dish, not 1:1 per person. Never tell someone to
  "fill the rest with snacks" — if the meals as scaled don't hit a high target, scale the
  protein and carb components up further, even if that looks like an unusually large
  portion.
- For members without a specific calorie target (goals are just save time / save money /
  eat cleaner / feed the family), scale simply by headcount and normal appetite — no macro
  math needed.
- Children eat a scaled-down portion appropriate for their age (roughly 50-70% of an adult
  portion depending on age — younger children lower, teens closer to full).
- A household member marked "away" this week contributes nothing to the totals. A member
  marked "partial" only contributes for the days they're present (prorate their portion by
  daysPresent / cookDays).
- Sum every person's scaled portion across all cook days to get the true total quantity for
  each ingredient — this is not "recipe feeds 6, buy for 6," it's the sum of everyone's
  actual individual scaled portions across the week.

CONSOLIDATION — critical: merge the same ingredient from different recipes into ONE line
with a combined total quantity. Never list "onions" twice because two recipes used them.

BUY VS MAKE: where a buyVsMake choice is given for an ingredient, use the chosen version
(the "buy" description as a single line item, or the "make" description's sub-ingredients)
instead of both.

HOUSE RULES: a family-wide rule (e.g. "no pork") means that ingredient must not appear on
the list at all — substitute or omit sensibly. An individual rule (e.g. "Sofia hates
cucumber") does NOT change the shared shopping quantity — instead add a short prep note
explaining how that person's portion should be handled.

FLAGS — be selective, not reflexive: only set "shelfLife" on items that genuinely won't
keep the full week as bought — fresh fish/seafood, fresh herbs, fresh bread, delicate
fruit. Shelf-stable produce (onions, garlic, potatoes, carrots), pantry staples, dairy
with a normal fridge life, and anything canned/frozen should have "shelfLife": null. Do
not flag something just because it's fresh — flag it because it will actually spoil
before the week's cook days are up. Set "freezeFriendly": true only for items that
actually freeze well.

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "summaryLine": "string, e.g. '6 people · 5 cook days · Kafta Sandwiches / Chili Con Carne / Salmon Teriyaki / Vanilla Overnight Oats'",
  "categories": [
    {
      "name": "Fresh Produce" | "Proteins and Meat" | "Fish and Seafood" | "Dry Goods and Pantry" | "Dairy and Chilled" | "Canned and Jarred" | "Freezer",
      "items": [
        { "name": "string", "qty": "string (human-readable, e.g. '8 medium' or '1.2 kg')", "shelfLife": "string or null", "freezeFriendly": true|false }
      ]
    }
  ]
}

Only include categories that actually have items. Keep ingredient names clean and
consolidated. "qty" should be a short human-readable string, not a bare number.
`.trim();

// A second call, fired right after the grocery list (not lazy/button-gated —
// both happen automatically on "Generate The List"). Tried merging this into
// the grocery call first, per the brief's stated preference, but it wasn't
// reliable: even with thinking disabled, working out each person's real
// day-by-day intake on top of the full grocery consolidation regularly blew
// through a 14,000-token budget or ran past the timeout. Splitting keeps each
// call the size of something already proven to work reliably. This is still
// "never one call per section" — AI Advice and Weigh & Pack share this call.
const ADVICE_PACK_SYSTEM_PROMPT = `
You are building two things for The Unhangry Society meal prep system, using the same
household profile and recipes already used to build this week's grocery list. Return
structured JSON only — no commentary, no chat persona.

**AI ADVICE — follow this sequencing exactly:**
1. Scale the 3 selected mains + breakfast per person to their individual targets (same
   logic as the grocery list: protein/carb components scale per-person toward their
   target, sauces/aromatics scale with the whole dish, children get 50-70% of an adult
   portion, an "away" member contributes nothing, a "partial" member is prorated by
   daysPresent/cookDays).
2. Recalculate each fitness-goal household member's TOTAL actual weekly intake from those
   scaled portions — their real kcal and macros, day by day across the household's cook
   days (invent a sensible rotation of the 3 mains across lunch/dinner slots).
3. Compare that real intake against each person's daily target. Find the gaps — which
   days fall short, and in which macro (protein / carb / fat).
4. Only THEN recommend snacks to close the gaps. For each gap, pick a snack from
   "availableSnacks" whose "primaryMacro" matches the missing macro, and note a portion
   that reasonably closes the gap size. Pull ONLY from "availableSnacks" — never invent a
   snack that isn't in that list.

Rules:
- Only produce AI Advice entries for members with a calorie target (goals include lose
  weight / gain muscle / maintain weight). Skip convenience-goal members (save time / save
  money / feed the family / eat cleaner) and children entirely — don't include them at all.
- Keep it short and practical — a couple of lines per person. Light tone, never preachy.
  If someone's on target all week, say so briefly and recommend nothing.
- This is advice only, not a commitment — the recommended snack must NEVER be treated as
  something the household has already decided to buy. Do not add its ingredients to any
  grocery list; just name the snack and portion in the recommendation text so the person
  can add it themselves if they want to.

**WEIGH & PACK** — per-recipe portioning, organized BY RECIPE (not by person), covering
the 3 mains plus breakfast (not snacks). For each, list every household member who eats it
this week (skip anyone marked "away", or whose individual rules exclude that dish) with
their specific scaled portion in grams/practical units — reuse the same per-person scaling
as step 1 above. If someone's individual rule affects this recipe (e.g. no fish), either
omit them from that recipe's breakdown or add a short note on their line about what they
get instead (e.g. an increased portion of one of the other mains).

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:

{
  "aiAdvice": [
    {
      "memberName": "string",
      "summary": "string (e.g. 'meals run ~200 kcal short on Mon & Wed, mostly protein.' or 'On target all week.')",
      "recommendation": "string or null (e.g. 'Add a protein shake with milk on those 2 days.', null if no gap)"
    }
  ],
  "weighAndPack": [
    {
      "recipeName": "string",
      "portions": [ { "memberName": "string", "portionText": "string (e.g. '320g fish · 180g rice')", "note": "string or null" } ]
    }
  ]
}
`.trim();

// Drops notes/sourceUrl/flags — not needed for scaling math.
function slimRecipeForPrompt(recipe) {
  return {
    id: recipe.id,
    name: recipe.name,
    protein: recipe.protein,
    method: recipe.method,
    feeds: recipe.feeds,
    macrosPerServing: recipe.macrosPerServing,
    ingredients: (recipe.ingredients || []).map((i) => ({
      name: i.name, qty: i.qty, unit: i.unit, component: i.component,
      ...(i.buyVsMake ? { buyVsMake: i.buyVsMake } : {}),
    })),
  };
}

// Lighter still — AI Advice only needs enough to pick a snack and know what to
// add to the grocery list, not cooking steps.
function slimSnackForPrompt(recipe) {
  return {
    id: recipe.id,
    name: recipe.name,
    primaryMacro: recipe.primaryMacro || null,
    macrosPerServing: recipe.macrosPerServing,
    ingredients: (recipe.ingredients || []).map((i) => ({ name: i.name, qty: i.qty, unit: i.unit })),
  };
}

function buildWeekPayload({ household, mains, breakfast, snacks, availableSnacks, buyVsMake, weeklyAdjustments }) {
  return {
    household: {
      cookDays: household.cookSchedule.cookDays,
      breakfastDays: household.cookSchedule.breakfastDays,
      familyRules: household.familyRules,
      members: household.members.map((m) => {
        const adjustment = weeklyAdjustments.find((a) => a.memberId === m.id);
        return {
          name: m.name,
          isChild: m.isChild,
          goals: m.goals,
          dailyCalorieTarget: m.calorieTarget,
          individualRules: household.individualRules.filter((r) => r.memberId === m.id).map((r) => r.note),
          thisWeek: adjustment ? { status: adjustment.status, daysPresent: adjustment.daysPresent ?? null } : { status: 'home' },
        };
      }),
    },
    mains: mains.map(({ method, recipe }) => ({ method, ...slimRecipeForPrompt(recipe) })),
    breakfast: breakfast ? slimRecipeForPrompt(breakfast) : null,
    snacks: (snacks || []).map(slimRecipeForPrompt),
    buyVsMake: buyVsMake || [],
    availableSnacks: (availableSnacks || []).map(slimSnackForPrompt),
  };
}

async function generateGroceryList(week) {
  const payload = buildWeekPayload(week);
  const prompt = `Here is this week's plan. Calculate the grocery list.\n\n${JSON.stringify(payload, null, 2)}`;

  return callClaudeMessages(
    [{ type: 'text', text: prompt }],
    { system: GROCERY_LIST_SYSTEM_PROMPT, maxTokens: 10000 }
  );
}

async function generateAdvicePack(week) {
  const payload = buildWeekPayload(week);
  const prompt = `Here is this week's plan. Build AI Advice and Weigh & Pack.\n\n${JSON.stringify(payload, null, 2)}`;

  return callClaudeMessages(
    [{ type: 'text', text: prompt }],
    { system: ADVICE_PACK_SYSTEM_PROMPT, maxTokens: 10000 }
  );
}

module.exports = {
  hasApiKey, extractRecipeFromText, extractRecipeFromImage,
  generateGroceryList, generateAdvicePack,
};
