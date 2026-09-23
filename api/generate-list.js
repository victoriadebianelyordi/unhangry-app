const { loadEnv } = require('../lib/env');
loadEnv();
const claude = require('../lib/claude');
const engine = require('../lib/mealEngine');
const { sendJSON, readJsonBody } = require('../lib/http');
const { loadAllRecipes } = require('../lib/recipes');

// Point 5 / Stage 4 rewire: the deterministic engine (lib/mealEngine.js) computes every
// number first — targets, portions, the grocery baseline — with zero AI involvement. The
// AI call that follows only assembles/writes from that already-correct output (rule
// matching, the final grocery list, weigh & pack, AI Advice); see lib/claude.js's
// generateWeekAssembly for the guardrail that catches it if it ever alters a quantity.
module.exports = async (req, res) => {
  if (!claude.hasApiKey()) {
    return sendJSON(res, 200, {
      status: 'unavailable',
      message: 'Add ANTHROPIC_API_KEY to .env to generate the list — see README.md.',
    });
  }

  const input = await readJsonBody(req);
  const { household, mains, breakfast, snacks, buyVsMake, weeklyAdjustments, cyclePhases, localRecipes } = input;

  if (!Array.isArray(mains) || mains.length !== 3 || mains.some((m) => !m || !m.recipe)) {
    return sendJSON(res, 400, { error: 'incomplete-mains', message: 'Pick all 3 mains (one per method) first.' });
  }

  if (!household || !Array.isArray(household.members) || household.members.length === 0) {
    return sendJSON(res, 400, { error: 'no-members', message: 'Add at least one household member in the Family Hub first.' });
  }

  // The full snack catalog — bundled recipes plus anything the household added locally
  // (stored client-side, sent along in the request) — not just whatever was added to
  // Snacks & Sides this week. B12's gap-fill recommendation picks freely from every snack
  // available, per mealType "snack".
  const allRecipes = [...loadAllRecipes(), ...(Array.isArray(localRecipes) ? localRecipes : [])];
  const availableSnacks = allRecipes.filter((r) => r.mealType === 'snack');

  const engineResult = engine.buildWeek({
    household,
    mains,
    breakfast: breakfast || null,
    snacks: Array.isArray(snacks) ? snacks : [],
    availableSnacks,
    weeklyAdjustments: Array.isArray(weeklyAdjustments) ? weeklyAdjustments : [],
    buyVsMake: Array.isArray(buyVsMake) ? buyVsMake : [],
    cyclePhases: Array.isArray(cyclePhases) ? cyclePhases : [],
  });

  if (engineResult.refusals && engineResult.refusals.length > 0) {
    return sendJSON(res, 400, { error: 'incomplete-recipe-data', message: engineResult.refusals.join(' ') });
  }

  let list;
  try {
    list = await claude.generateWeekAssembly(engineResult, {
      cookSchedule: household.cookSchedule, buyVsMake: Array.isArray(buyVsMake) ? buyVsMake : [],
    });
  } catch (err) {
    console.error('Week assembly generation failed:', err.message);
    return sendJSON(res, 502, { error: 'generation-failed', message: `Couldn't generate the list (${err.message}). Try again.` });
  }

  list.aiAdvice = Array.isArray(list.aiAdvice) ? list.aiAdvice : [];
  list.weighAndPack = Array.isArray(list.weighAndPack) ? list.weighAndPack : [];
  // Engine-computed, not AI-touched: each recipe's own ingredients scaled to the whole
  // household's real weekly total — what "Copy recipes for the cook" needs (a batch-cook
  // ingredient list per recipe), as opposed to weighAndPack's per-person portions.
  list.recipeIngredientTotals = Array.isArray(engineResult.recipeIngredientTotals) ? engineResult.recipeIngredientTotals : [];

  // Built here, deterministically, from real data — not left for the AI to improvise
  // (it used to just add this field unprompted, which happened to work but wasn't
  // guaranteed by anything in its instructions).
  const childCount = household.members.filter((m) => m.isChild).length;
  list.summaryLine = `${household.members.length} people${childCount ? ` (${childCount} child${childCount === 1 ? '' : 'ren'})` : ''} · ${household.cookSchedule.cookDays} cook days · ${mains.map((m) => m.recipe.name).join(' / ')}`;

  return sendJSON(res, 200, { status: 'ok', list });
};
