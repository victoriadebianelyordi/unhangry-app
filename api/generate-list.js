const { loadEnv } = require('../lib/env');
loadEnv();
const claude = require('../lib/claude');
const { sendJSON, readJsonBody } = require('../lib/http');
const { loadAllRecipes } = require('../lib/recipes');

module.exports = async (req, res) => {
  if (!claude.hasApiKey()) {
    return sendJSON(res, 200, {
      status: 'unavailable',
      message: 'Add ANTHROPIC_API_KEY to .env to generate the list — see README.md.',
    });
  }

  const input = await readJsonBody(req);
  const { household, mains, breakfast, snacks, buyVsMake, weeklyAdjustments, localRecipes } = input;

  if (!Array.isArray(mains) || mains.length !== 3 || mains.some((m) => !m || !m.recipe)) {
    return sendJSON(res, 400, { error: 'incomplete-mains', message: 'Pick all 3 mains (one per method) first.' });
  }

  if (!household || !Array.isArray(household.members) || household.members.length === 0) {
    return sendJSON(res, 400, { error: 'no-members', message: 'Add at least one household member in the Family Hub first.' });
  }

  // The full snack catalog — bundled recipes plus anything the household
  // added locally (stored client-side, sent along in the request) — not just
  // whatever was added to Snacks & Sides this week. AI Advice picks freely
  // from every snack available to fill macro gaps, per mealType "snack".
  const allRecipes = [...loadAllRecipes(), ...(Array.isArray(localRecipes) ? localRecipes : [])];
  const availableSnacks = allRecipes.filter((r) => r.mealType === 'snack');

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
};
