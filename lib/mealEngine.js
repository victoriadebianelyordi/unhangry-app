// Calculation Engine Spec v2, Part B — the deterministic weekly engineering core.
//
// Pure functions only. No network calls, no Claude, nothing async. Given a household,
// this week's picks (3 mains + breakfast + up to 2 user-picked snacks), who's home, and
// the household's rules, this works out exactly how much of each recipe everyone needs,
// scales real portions to real targets, rounds to kitchen-realistic amounts, hard-replaces
// allergens, flags dislikes, and recommends a gap-fill snack from the real database — all
// as plain arithmetic. Nothing in this file is allowed to depend on an LLM (that's the
// whole point of this rewrite — see the Calculation Engine Spec v2 header).
//
// Not wired into the live app yet — api/generate-list.js still uses the old AI-driven
// grocery call. This module is proven standalone first (Stage 3), then Stage 4 swaps the
// AI call's job from "compute the numbers" to "narrate numbers this engine already
// computed."

// ---------------- meal-share model ----------------
//
// The spec's B8 (breakfast 25% / lunch 35% / dinner 40%) assumes a day-by-day schedule,
// but this app deliberately doesn't track which of the 3 mains lands on which specific
// day (the old "Calendar" feature was cut earlier — recipes rotate through the week, not
// pinned to dates). So "lunch" and "dinner" are treated as interchangeable draws from the
// same pool of 3 mains: a person eats 2 main-occasions per cook day, split evenly across
// the 3 recipes over the week. Each main-occasion targets the average of the lunch/dinner
// shares (35%+40%)/2 = 37.5% of daily kcal — two of those occasions per day sum back to
// the full 75% the spec allocates to lunch+dinner combined.
const BREAKFAST_SHARE = 0.25;
const MAIN_OCCASION_SHARE = 0.375; // (0.35 + 0.40) / 2

// B7 — soft caps, never hard-blocked.
const PROTEIN_PER_MEAL_CAP_G_PER_KG = 0.8;
const MAX_SINGLE_MEAT_COMPONENT_G = 250;

// B6 trigger (Point 4, confirmed) — only reallocate protein if the whole-recipe pass (B5)
// still leaves a genuine protein shortfall: >15g/day. B5 already targets calories directly,
// so the day's kcal gap is ~0 by construction — a person can still be meaningfully short on
// PROTEIN specifically even with calories matched (exactly what the Mjadara recipe file's
// own notes anticipate: "the recipe the app will flag for a protein boost"). 15g/day is a
// nutritionally meaningful shortfall worth actively correcting.
const PROTEIN_TOPUP_TRIGGER_G = 15;

// B12 trigger — only recommend a gap-fill snack for a genuine remaining shortfall.
const GAP_FILL_TRIGGER_KCAL = 150;

// Sensible clamps so a scale factor never produces an absurd portion (e.g. a tiny recipe
// against a huge target, or vice versa) — still deterministic, just bounded.
const MIN_SCALE = 0.4;
const MAX_SCALE = 3.0;

function round1(n) { return Math.round(n * 10) / 10; }

// ---------------- B10 — portion rounding ----------------
// Snaps a scaled ingredient quantity to a realistic kitchen increment. Only ingredients
// with a weight/volume unit and a scalable component (protein/carb) get food-specific
// rounding, per the spec's named categories — everything else (sauce/aromatic/other, or
// units that don't map to a gram/ml amount like "clove"/"bunch"/"to taste") passes through
// unrounded rather than forcing a fake conversion.
function roundIngredientQty(qty, unit, component) {
  if (qty == null || !isFinite(qty)) return qty;
  const u = String(unit || '').toLowerCase();

  const asGrams = (u === 'kg') ? qty * 1000 : (u === 'g') ? qty : null;
  if (asGrams != null) {
    if (component === 'protein') return { qty: Math.ceil(asGrams / 25) * 25, unit: 'g' };
    if (component === 'carb') return { qty: Math.ceil(asGrams / 25) * 25, unit: 'g' };
    if (component === 'other') return { qty: Math.ceil(asGrams / 50) * 50, unit: 'g' }; // vegetables etc.
    if (component === 'sauce') return { qty: Math.ceil(asGrams / 5) * 5, unit: 'g' };
    return { qty: round1(qty), unit };
  }

  const asMl = (u === 'ml') ? qty : (u === 'tbsp') ? qty * 15 : (u === 'tsp') ? qty * 5 : null;
  if (asMl != null && (component === 'other' || component === 'sauce')) {
    // Oils and liquid sauces/dressings — 5ml increments.
    const rounded = Math.ceil(asMl / 5) * 5;
    return { qty: round1(rounded / (u === 'tbsp' ? 15 : u === 'tsp' ? 5 : 1)), unit };
  }

  if (u === 'scoop' || u === 'pc' || u === 'clove') {
    return { qty: Math.ceil(qty), unit }; // whole units — eggs, scoops, pieces, cloves
  }

  if ((u === 'cup' || u === 'cups') && component === 'carb') {
    return { qty: Math.round(qty * 20) / 20, unit }; // nearest 1/20 cup — a practical measuring-cup increment for dry rice/oats
  }

  return { qty: round1(qty), unit };
}

// ---------------- component-aware ingredient scaling ----------------
// Scales one recipe's ingredient list by a whole-dish factor, with an optional extra
// multiplier applied ONLY to protein-tagged ingredients (B6's component top-up), and an
// optional reduction multiplier applied to everything else (B6's calorie-balancing —
// Point 4: pulling non-protein components down when protein is topped up, so the dish's
// total kcal holds near its B5 baseline instead of drifting up).
function scaleIngredients(ingredients, wholeDishFactor, proteinExtraFactor = 1, otherFactor = 1) {
  return ingredients.map((ing) => {
    if (ing.qty == null) return { ...ing };
    const isScalableProtein = ing.component === 'protein';
    const factor = isScalableProtein ? wholeDishFactor * proteinExtraFactor : wholeDishFactor * otherFactor;
    return { ...ing, qty: ing.qty * factor };
  });
}

function scaleMacros(macros, factor) {
  return {
    kcal: (macros.kcal || 0) * factor,
    protein: (macros.protein || 0) * factor,
    carbs: (macros.carbs || 0) * factor,
    fat: (macros.fat || 0) * factor,
  };
}

function addMacros(a, b) {
  return {
    kcal: (a.kcal || 0) + (b.kcal || 0),
    protein: (a.protein || 0) + (b.protein || 0),
    carbs: (a.carbs || 0) + (b.carbs || 0),
    fat: (a.fat || 0) + (b.fat || 0),
  };
}

// ---------------- presence (weeklyAdjustments) ----------------
// Part B2, reworked (Point 2 feedback): "This Week's Exceptions" now tracks four
// independent occasion counts per person — breakfast / lunch / dinner / snack — each
// preset to the household's cook-days (breakfast to breakfastDays) but freely editable per
// person, per week, for every member including children. There's no separate "away" /
// "partial" status any more: skipping a meal type for someone is just setting that count
// to 0, and a person who's 0 across all four is fully excluded from this week's groceries,
// recipes, and scaling — same effect as the old "away all week", just derived instead of
// chosen from a dropdown.
function memberPresence(member, weeklyAdjustments, cookSchedule) {
  const adj = weeklyAdjustments.find((a) => a.memberId === member.id) || {};
  const breakfastOccasions = adj.breakfastCount ?? cookSchedule.breakfastDays;
  const lunchOccasions = adj.lunchCount ?? cookSchedule.cookDays;
  const dinnerOccasions = adj.dinnerCount ?? cookSchedule.cookDays;
  const snackOccasions = adj.snackCount ?? cookSchedule.cookDays;
  // "How many days this week does this person need feeding at all" — used only to turn
  // weekly totals back into a daily average for comparing against their daily target. The
  // four occasion counts aren't tied to specific calendar days (this app deliberately
  // doesn't schedule day-by-day — see the meal-share model note at the top of this file),
  // so the highest single count is the most defensible stand-in for "days active" without
  // adding yet another input field the shopper would have to keep in sync by hand.
  const daysActive = Math.max(breakfastOccasions, lunchOccasions, dinnerOccasions, snackOccasions);
  return {
    breakfastOccasions, lunchOccasions, dinnerOccasions, snackOccasions, daysActive,
    active: daysActive > 0,
  };
}

function calcAgeFromDob(dobStr) {
  if (!dobStr) return null;
  const dob = new Date(dobStr);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ---------------- Part A target lookup ----------------
// Reads the target Stage 1/Point 1 already computed and stored on the member
// (macroTargets) — this engine never recomputes targets, it only consumes them. A child's
// target is app.js's computeChildTarget (Health Canada EER + RDA protein), stored the same
// way as an adult's — not a special case this function needs to know about.
function resolveMemberTarget(member) {
  // Every member — child or adult, fitness goal or not — gets a real computed target now
  // (app.js's computeBackendTarget). A missing target here means genuinely incomplete
  // profile data (no weight/height on file yet), not "this person doesn't get math" —
  // falls back to a flat 1.0x for that person only, not a silent default.
  if (member.calorieTarget && member.macroTargets) {
    return {
      kcal: member.calorieTarget,
      proteinG: member.macroTargets.proteinG,
      fatG: member.macroTargets.fatG,
      carbG: member.macroTargets.carbG,
    };
  }
  return null;
}

// ---------------- B5 — whole-recipe scaling ----------------
// The per-occasion scale factor for one person eating one recipe once. Calorie-driven
// (spec priority: calories first) — B6 tops up protein afterward if there's still a gap.
// Headcount-only members and children don't get macro-driven scaling (spec: "scale
// simply by headcount and normal appetite").
function wholeRecipeScaleFactor(member, target, recipeMacrosPerServing, occasionShare) {
  // A child's real EER-based target (app.js's computeChildTarget) is what scales their
  // portion here — no separate discount or isChild special-case needed.
  if (!target) return 1.0; // incomplete profile data only — see resolveMemberTarget
  const kcalTarget = target.kcal * occasionShare;
  const factor = kcalTarget / (recipeMacrosPerServing.kcal || 1);
  return clamp(factor, MIN_SCALE, MAX_SCALE);
}

// ---------------- B6 support — how far can a main's protein absorb a top-up ----------------
// The maximum protein-component multiplier (relative to the main's current B5 factor)
// before hitting either B7 soft cap — the per-meal protein-gram cap (0.8g/kg bodyweight)
// or the single-ingredient raw-weight cap (250g). Returns 1 (no room) for a dish with no
// scalable protein component, or one whose BASELINE portion already meets/exceeds a cap.
function maxProteinMultiplier(member, p) {
  const proteinIngredients = (p.recipe.ingredients || []).filter((i) => i.component === 'protein' && i.qty != null);
  if (proteinIngredients.length === 0 || !p.recipe.macrosPerServing.protein) return 1;

  let mMax = MAX_SCALE; // sane ceiling even when neither cap type applies below
  if (member.weightKg) {
    const perMealCapG = member.weightKg * PROTEIN_PER_MEAL_CAP_G_PER_KG;
    const baselineMealProteinG = p.recipe.macrosPerServing.protein * p.factor;
    if (baselineMealProteinG > 0) mMax = Math.min(mMax, perMealCapG / baselineMealProteinG);
  }
  for (const ing of proteinIngredients) {
    const u = (ing.unit || '').toLowerCase();
    if (u !== 'g' && u !== 'kg') continue; // only weight-based ingredients carry a raw-gram cap
    const baselineGrams = ((u === 'kg' ? ing.qty * 1000 : ing.qty) / (p.recipe.feeds || 1)) * p.factor;
    if (baselineGrams > 0) mMax = Math.min(mMax, MAX_SINGLE_MEAT_COMPONENT_G / baselineGrams);
  }
  return Math.max(1, mMax);
}

// ---------------- one person's full week against the 3 mains + breakfast ----------------
//
// mains: [{ method, recipe, occasionsPerWeek }] — recipe already resolved, occasionsPerWeek
// pre-computed by the caller from this person's lunch+dinner occasion counts.
// breakfastOccasions: this person's breakfast count for the week (Point 2's counter).
// snackBaseline: macros object — B1's user-picked-snacks contribution, PER SNACK OCCASION
// (already summed across both snack slots; scaled by snackOccasions below).
// snackOccasions: this person's snack count for the week (Point 2's counter) — independent
// of daysActive, so a household can dial the snack down/up without touching meals.
// daysActive: how many days this person needs feeding at all this week (see
// memberPresence) — the divisor for turning weekly totals back into a daily average.
//
// Returns the person's full engineering result: scaled portions per recipe, weekly/daily
// actual totals, the gap vs target, and any soft warnings (B7).
function engineerPersonWeek({ member, target, mains, breakfast, breakfastOccasions, snackBaseline, snackOccasions, daysActive }) {
  const warnings = [];

  // B1 — user-picked snacks are folded in as a baseline BEFORE any scaling, not added on
  // top of a full day's worth of mains/breakfast. So the calorie-driven whole-recipe
  // scaling (B5) targets the day's remaining budget after the snack, not the raw target —
  // otherwise everyone ends up overshot by exactly the snack's calories every day. Since
  // Point 2 lets snackOccasions differ from daysActive (e.g. the snack only 2x/week against
  // 5 active days), this subtracts the AVERAGE daily snack contribution, not the full
  // snack's kcal — consistent with the app's "average day" model used everywhere else.
  const avgDailySnackKcal = daysActive > 0 ? (snackBaseline.kcal || 0) * snackOccasions / daysActive : 0;
  const mealScalingTarget = target ? { ...target, kcal: Math.max(0, target.kcal - avgDailySnackKcal) } : null;

  // B5 — whole-recipe (calorie-driven) factor per main, plus breakfast. proteinFactor/
  // otherFactor start at 1 (no adjustment) — B6 below may raise proteinFactor and lower
  // otherFactor on a PER-MAIN basis for whichever mains absorb the protein top-up (Point 4
  // rebuild: this used to be one uniform factor applied to every main equally).
  const mainPortions = mains.map(({ method, recipe, occasionsPerWeek }) => ({
    method, recipe, occasionsPerWeek,
    factor: wholeRecipeScaleFactor(member, mealScalingTarget, recipe.macrosPerServing, MAIN_OCCASION_SHARE),
    proteinFactor: 1, otherFactor: 1,
  }));
  const breakfastFactor = breakfast
    ? wholeRecipeScaleFactor(member, mealScalingTarget, breakfast.macrosPerServing, BREAKFAST_SHARE)
    : 0;

  // A main's weekly macro contribution at its current factor/proteinFactor/otherFactor.
  // Protein-tagged content is treated as pure protein calories (protein x 4) — the schema
  // only stores whole-dish macros, not per-ingredient, so this is the closest estimate
  // available of "how many of this dish's calories come from its protein component"
  // (the same approximation this file has always used). Everything else (carbs, fat, and
  // the dish's remaining kcal) scales with otherFactor, which B6 pulls down when
  // proteinFactor is raised — so a dish's total kcal holds near its B5 calorie-correct
  // baseline instead of drifting up every time protein gets topped up.
  function mainWeeklyMacros(p) {
    const m = p.recipe.macrosPerServing;
    const proteinG = (m.protein || 0) * p.factor * p.proteinFactor;
    const proteinKcal = proteinG * 4;
    const otherKcal = Math.max(0, (m.kcal || 0) * p.factor - (m.protein || 0) * p.factor * 4) * p.otherFactor;
    const perOccasion = {
      kcal: proteinKcal + otherKcal, protein: proteinG,
      carbs: (m.carbs || 0) * p.factor * p.otherFactor, fat: (m.fat || 0) * p.factor * p.otherFactor,
    };
    return scaleMacros(perOccasion, p.occasionsPerWeek);
  }
  function weeklyMainsMacros(portions) {
    return portions.reduce((sum, p) => addMacros(sum, mainWeeklyMacros(p)), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  }

  const weeklySnacks = scaleMacros(snackBaseline, snackOccasions);
  const weeklyBreakfast = breakfast
    ? scaleMacros(scaleMacros(breakfast.macrosPerServing, breakfastFactor), breakfastOccasions)
    : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  let weeklyActual = addMacros(addMacros(weeklyMainsMacros(mainPortions), weeklyBreakfast), weeklySnacks);

  // ---- B6, rebuilt (Point 4) — calorie-constrained protein reallocation ----
  // Trigger: a genuine protein shortfall alone, >15g/day (PROTEIN_TOPUP_TRIGGER_G) — B5
  // already targets calories directly, so the kcal side is ~0 by construction; protein is
  // the one that can still be meaningfully short even with calories matched.
  // Point 1 (child rebuild): explicitly skipped for children — "keep it flexible, no exact
  // macro scaling to be done for children, only a healthy caloric intake check." B5 above
  // still scales their portions to the right calorie level (their EER target); only this
  // aggressive per-dish protein reallocation is adults-only.
  if (target && daysActive > 0 && !member.isChild) {
    const avgDailyProtein = weeklyActual.protein / daysActive;
    const proteinGapG = target.proteinG - avgDailyProtein;

    if (proteinGapG > PROTEIN_TOPUP_TRIGGER_G) {
      let remainingWeeklyGapG = proteinGapG * daysActive;

      // Rank this person's mains by protein density (dish protein g per dish kcal, at the
      // current B5 scale) so the most protein-efficient dish absorbs the top-up first — a
      // protein-light-by-design dish (e.g. Mjadara) isn't force-fed unrealistic bulk just
      // to hit a uniform factor across every main. Only mains with room left under B7's
      // caps (maxProteinMultiplier > 1) and an actual protein component are candidates.
      const ranked = mainPortions
        .map((p) => ({
          p, mMax: maxProteinMultiplier(member, p),
          density: p.recipe.macrosPerServing.kcal > 0 ? (p.recipe.macrosPerServing.protein || 0) / p.recipe.macrosPerServing.kcal : 0,
        }))
        .filter((r) => r.mMax > 1 && r.p.recipe.macrosPerServing.protein > 0)
        .sort((a, b) => b.density - a.density);

      for (const { p, mMax } of ranked) {
        if (remainingWeeklyGapG <= 0) break;
        const baselineProteinGPerOccasion = p.recipe.macrosPerServing.protein * p.factor;
        const maxAddedGWeekly = baselineProteinGPerOccasion * (mMax - 1) * p.occasionsPerWeek;
        const addedGWeekly = Math.min(remainingWeeklyGapG, maxAddedGWeekly);
        if (addedGWeekly <= 0) continue;

        p.proteinFactor = 1 + (addedGWeekly / p.occasionsPerWeek) / baselineProteinGPerOccasion;
        // Hold this dish's per-occasion kcal near its B5 baseline: the added protein's
        // kcal comes back out of the dish's non-protein components, not stacked on top —
        // this is the "reduce the other macros to balance the caloric total" fix.
        const addedKcalPerOccasion = (addedGWeekly / p.occasionsPerWeek) * 4;
        const baselineOtherKcal = Math.max(0, p.recipe.macrosPerServing.kcal * p.factor - baselineProteinGPerOccasion * 4);
        p.otherFactor = baselineOtherKcal > 0 ? clamp(1 - addedKcalPerOccasion / baselineOtherKcal, 0.5, 1) : 1;

        remainingWeeklyGapG -= addedGWeekly;
      }

      if (remainingWeeklyGapG > 0) {
        warnings.push(`Even after boosting protein as far as each dish realistically allows under the per-meal caps, ${member.name}'s mains still fall short on protein — the rest needs to come from a gap-fill snack.`);
      }

      weeklyActual = addMacros(addMacros(weeklyMainsMacros(mainPortions), weeklyBreakfast), weeklySnacks);
    }
  }

  // B7 — soft protein caps, per occurrence. Checked against the FINAL (post-top-up)
  // per-meal protein-component grams for each main. Should rarely fire from B6's own
  // top-up now that the allocation above is itself cap-aware (maxProteinMultiplier) — but
  // still catches the case where the BASELINE B5 portion alone already exceeds a cap
  // (a large target against a small recipe), which is real and worth flagging regardless.
  // Skipped for children (Point 1) — B6 never runs for them, and these are macro-scolding
  // warnings ("Xg protein — above the guideline") the brief explicitly doesn't want
  // surfaced for a child's meals; only the calorie side is checked for them.
  if (member.weightKg && !member.isChild) {
    const perMealCapG = member.weightKg * PROTEIN_PER_MEAL_CAP_G_PER_KG;
    for (const p of mainPortions) {
      const proteinIngredients = (p.recipe.ingredients || []).filter((i) => i.component === 'protein');
      for (const ing of proteinIngredients) {
        if (ing.qty == null) continue;
        // ing.qty is the whole BASE RECIPE's quantity (feeds servings) — p.factor is in
        // units of "servings", so one person's one-occasion share needs dividing by feeds.
        const scaledQty = (ing.qty / (p.recipe.feeds || 1)) * p.factor * p.proteinFactor;
        const grams = (ing.unit || '').toLowerCase() === 'kg' ? scaledQty * 1000 : scaledQty;
        if ((ing.unit || '').toLowerCase() === 'g' || (ing.unit || '').toLowerCase() === 'kg') {
          if (grams > MAX_SINGLE_MEAT_COMPONENT_G) {
            warnings.push(`${member.name}'s ${p.recipe.name} portion needs ~${Math.round(grams)}g of ${ing.name} — above the ${MAX_SINGLE_MEAT_COMPONENT_G}g single-meal guideline. Consider another occasion or food for the rest, or keep it if the target genuinely needs it.`);
          }
        }
      }
      // Rough per-meal protein check using the recipe's own macro (not just the one
      // ingredient) — catches the case even when the protein source isn't in g/kg units.
      const mealProteinG = p.recipe.macrosPerServing.protein * p.factor * p.proteinFactor;
      if (mealProteinG > perMealCapG) {
        warnings.push(`${member.name}'s ${p.recipe.name} portion is ~${Math.round(mealProteinG)}g protein — above the soft ${Math.round(perMealCapG)}g/meal guideline (0.8g/kg bodyweight). Fine if the target needs it, otherwise consider moving some to another occasion.`);
      }
    }
  }

  const avgDaily = daysActive > 0 ? {
    kcal: weeklyActual.kcal / daysActive, protein: weeklyActual.protein / daysActive,
    carbs: weeklyActual.carbs / daysActive, fat: weeklyActual.fat / daysActive,
  } : { kcal: 0, protein: 0, carbs: 0, fat: 0 };

  const gap = target ? {
    kcal: target.kcal - avgDaily.kcal,
    proteinG: target.proteinG - avgDaily.protein,
    fatG: target.fatG - avgDaily.fat,
    carbG: target.carbG - avgDaily.carbs,
  } : null;

  return { mainPortions, breakfastFactor, weeklyActual, avgDaily, gap, warnings };
}

// ---------------- B12 — gap-fill snack recommendation ----------------
// Only for a genuine remaining shortfall after all scaling, AND only when the household
// didn't already pick their own snack(s) this week (buildWeek gates this on
// snacks.length === 0). If the shopper picked Snack 1/2 themselves, the app uses exactly
// what they picked — it never piles an extra recommended snack on top just because a gap
// remains. Picks from the real snack database (availableSnacks) by nearest primaryMacro
// match to whichever macro is most short, and suggests a portion multiplier — never
// invents a snack.
function recommendGapFillSnack(gap, availableSnacks) {
  if (!gap || gap.kcal < GAP_FILL_TRIGGER_KCAL) return null;

  const macroGapsKcal = {
    protein: Math.max(0, gap.proteinG) * 4,
    carb: Math.max(0, gap.carbG) * 4,
    fat: Math.max(0, gap.fatG) * 9,
  };
  const neededMacro = Object.entries(macroGapsKcal).sort((a, b) => b[1] - a[1])[0][0];

  const candidates = availableSnacks.filter((s) => s.primaryMacro === neededMacro && s.macrosPerServing && s.macrosPerServing.kcal > 0);
  if (candidates.length === 0) return null;

  // Nearest match: the snack whose serving size comes closest to (without wildly
  // overshooting) the remaining daily kcal gap.
  candidates.sort((a, b) => Math.abs(a.macrosPerServing.kcal - gap.kcal) - Math.abs(b.macrosPerServing.kcal - gap.kcal));
  const snack = candidates[0];
  const portionMultiplier = clamp(round1(gap.kcal / snack.macrosPerServing.kcal), 0.5, 2);

  return { recipeId: snack.id, name: snack.name, primaryMacro: snack.primaryMacro, portionMultiplier, dailyKcalGapClosed: Math.round(snack.macrosPerServing.kcal * portionMultiplier) };
}

// ---------------- categorization ----------------
//
// Still deterministic, still the engine's job — this is just "which grocery aisle,"
// unrelated to the rule-matching that used to live here (Point 5 / Stage 4 rewire moved
// allergy/dislike swap decisions to the AI call — see buildGroceryBaseline below. The old
// keyword-based matchIndividualRule/familyRuleExcludes are gone: that was a "documented
// simplification" this whole rewrite exists to replace with an AI reading the raw,
// unedited rule text directly, typos and all, instead of guessing from keywords).

const CATEGORY_KEYWORDS = {
  'Fish and Seafood': ['fish', 'salmon', 'shrimp', 'tuna', 'seafood', 'prawn', 'crab', 'lobster'],
  'Dairy and Chilled': ['milk', 'yogurt', 'yoghurt', 'cheese', 'butter', 'cream', 'hummus'],
  'Freezer': ['frozen'],
  'Dry Goods and Pantry': ['rice', 'pasta', 'oil', 'spice', 'flour', 'sugar', 'salt', 'pepper',
    'cumin', 'turmeric', 'curry', 'lentil', 'chickpea', 'oats', 'bread', 'pita', 'tahini',
    'honey', 'syrup', 'protein powder', 'cocoa', 'nut butter', 'peanut butter', 'tofu'],
};

function classifyCategory(ingredientName, component, recipeProteinType) {
  const n = ingredientName.toLowerCase();
  if (component === 'protein') {
    if (recipeProteinType === 'seafood') return 'Fish and Seafood';
    if (recipeProteinType === 'beef' || recipeProteinType === 'chicken') return 'Proteins and Meat';
    if (CATEGORY_KEYWORDS['Dairy and Chilled'].some((k) => wordMatch(n, k))) return 'Dairy and Chilled';
    return 'Dry Goods and Pantry'; // veggie protein — lentils, chickpeas, tofu, protein powder
  }
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => wordMatch(n, k))) return cat;
  }
  return 'Fresh Produce'; // default for veg/aromatics/unclassified
}

// Whole-word match — plain .includes() false-positives badly here (e.g. "veggies"
// contains the substring "egg", "donut" contains "nut"), so every keyword check in this
// file goes through this instead. Allows a trailing s/es so "onion" matches ingredient
// names written as "onions" (recipe ingredient names are frequently pluralized) — a
// simple heuristic, not a full lemmatizer, but covers the common English case.
function wordMatch(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(e?s)?\\b`, 'i').test(text);
}

// ---------------- grocery baseline (Point 5 / Stage 4 rewire) ----------------
//
// This is now the FULL extent of the engine's involvement in the grocery list: raw,
// deterministic, consolidated quantities per ingredient — ground truth the AI call must
// not alter. It deliberately does NOT decide allergy swaps or family-rule exclusions
// anymore — that requires reading free-text rule notes tolerant of typos/synonyms ("dont
// llike okra"), which this rewrite moved OFF keyword matching and ONTO the AI call itself,
// reading the raw rule text directly at generate-time (see buildWeek's recipeEaters).
//
// Each line keeps its individual CONTRIBUTIONS (per recipe, per member, already-scaled
// qty), not just the summed total — the AI needs that granularity to correctly carve out
// an allergy swap for the ONE person it applies to (their own already-computed
// contribution) without re-deriving any arithmetic itself. The summed `totalQty` is the
// number the AI's response is validated against (see lib/claude.js's guardrail).
//
// Buy-vs-make stays here, not moved to the AI — it's a deterministic pick between two
// pre-authored labels for the SAME already-computed quantity (no judgment call, no free
// text to interpret), so there's no reason to hand it to a language model.
function buildGroceryBaseline({ recipeContributions, buyVsMakeAnswers }) {
  const lines = new Map(); // key: `${category}::${name}` -> { name, category, unit, component, shelfLife, freezeFriendly, contributions: [] }

  for (const contrib of recipeContributions) {
    const { recipe, perPersonQty } = contrib; // perPersonQty: [{ member, factor, proteinFactor?, otherFactor? }]
    for (const ing of recipe.ingredients || []) {
      if (ing.qty == null) continue;

      const buyVsMakeChoice = (buyVsMakeAnswers || []).find((b) => b.recipeName === recipe.name && b.ingredientName === ing.name);
      const effectiveName = buyVsMakeChoice && buyVsMakeChoice.choice === 'buy' && ing.buyVsMake ? ing.buyVsMake.buy : ing.name;
      const category = classifyCategory(ing.name, ing.component, recipe.protein);
      const key = `${category}::${effectiveName.toLowerCase()}`;

      if (!lines.has(key)) {
        lines.set(key, {
          name: effectiveName, category, unit: ing.unit, component: ing.component,
          shelfLife: null, freezeFriendly: false, contributions: [],
        });
      }
      const line = lines.get(key);
      if ((recipe.flags || {}).shelfLife) line.shelfLife = recipe.flags.shelfLife;
      if ((recipe.flags || {}).freezeFriendly) line.freezeFriendly = true;

      for (const { member, factor, proteinFactor, otherFactor } of perPersonQty) {
        // B6's reallocation (Point 4) scales protein-tagged ingredients UP by
        // proteinFactor and everything else DOWN by otherFactor, both per main.
        // Breakfast/snack contributions don't carry either field, so they fall through to
        // 1 (unaffected) via the `?? 1` defaults. `factor` is the person's total
        // servings-equivalent needed for the WEEK — ing.qty is the whole base recipe's
        // quantity (feeds servings), so it's divided down to a per-serving amount first.
        const effectiveFactor = ing.component === 'protein' ? factor * (proteinFactor ?? 1) : factor * (otherFactor ?? 1);
        const rawQty = (ing.qty / (recipe.feeds || 1)) * effectiveFactor;
        if (rawQty <= 0) continue;
        line.contributions.push({ recipeName: recipe.name, memberId: member.id, memberName: member.name, qty: round1(rawQty) });
      }
    }
  }

  const byCategory = new Map();
  for (const line of lines.values()) {
    const totalRaw = line.contributions.reduce((sum, c) => sum + c.qty, 0);
    const rounded = roundIngredientQty(totalRaw, line.unit, line.component);
    if (!byCategory.has(line.category)) byCategory.set(line.category, []);
    byCategory.get(line.category).push({
      name: line.name, unit: rounded.unit || line.unit || '', component: line.component,
      totalQty: round1(rounded.qty),
      shelfLife: line.shelfLife, freezeFriendly: line.freezeFriendly,
      contributions: line.contributions,
    });
  }
  return Array.from(byCategory.entries()).map(([name, items]) => ({ name, items }));
}

// ---------------- top-level orchestration ----------------
//
// household: { members, familyRules, individualRules, cookSchedule }
// mains: [{ method, recipe }] (3)
// breakfast: recipe | null
// snacks: [recipe, ...] (0-2, user-picked — B1 baseline)
// availableSnacks: full snack catalog (bundled + local), for B12 gap-fill recommendation
// weeklyAdjustments: [{ memberId, breakfastCount, lunchCount, dinnerCount, snackCount }] —
//   Point 2's four independent per-person occasion counts; any field left out defaults to
//   the household's cookSchedule (see memberPresence).
// buyVsMake: [{ recipeName, ingredientName, choice }]
// cyclePhases: [{ memberId, phase }] — Part E.1, only members who set a phase this week.
function buildWeek({ household, mains, breakfast, snacks, availableSnacks, weeklyAdjustments, buyVsMake, cyclePhases }) {
  const refusals = [];
  const allRecipesInPlay = [...mains.map((m) => m.recipe), ...(breakfast ? [breakfast] : []), ...snacks];
  for (const r of allRecipesInPlay) {
    const m = r.macrosPerServing || {};
    if (!m.kcal && !m.protein) {
      refusals.push(`"${r.name}" doesn't have calorie/macro info yet — add it in The Database before this recipe can be used to build a scaled week.`);
    }
  }
  if (refusals.length > 0) return { refusals };

  // B1 — user-picked snacks fold into everyone's daily baseline, once per cook day, BEFORE
  // any scaling (a baseline, not a gap-filler).
  const snackBaseline = snacks.reduce((sum, s) => addMacros(sum, s.macrosPerServing), { kcal: 0, protein: 0, carbs: 0, fat: 0 });

  // Attach each member's individual rules for easy lookup inside grocery assembly.
  const membersWithRules = household.members.map((m) => ({
    ...m,
    individualRules: household.individualRules.filter((r) => r.memberId === m.id),
  }));

  const people = [];
  // Each recipe's grocery contribution is a list of { member, factor, proteinFactor?,
  // otherFactor? } — buildGroceryBaseline applies proteinFactor to protein-tagged
  // ingredients and otherFactor to everything else (Point 4's per-main reallocation).
  const mainContributions = mains.map(({ recipe }) => ({ recipe, perPersonQty: [] }));
  const breakfastContribution = breakfast ? { recipe: breakfast, perPersonQty: [] } : null;
  const snackContributions = snacks.map((s) => ({ recipe: s, perPersonQty: [] }));

  for (const member of membersWithRules) {
    const presence = memberPresence(member, weeklyAdjustments || [], household.cookSchedule);
    if (!presence.active) continue; // away this week — contributes nothing (B2)

    const target = resolveMemberTarget(member);
    // Lunch + dinner occasions split evenly across the 3 selected mains (still the
    // "average day" model — see the file-top note — just now from two independently
    // editable counters instead of one cook-days scalar doubled).
    const mainsForPerson = mains.map(({ method, recipe }) => ({
      method, recipe, occasionsPerWeek: (presence.lunchOccasions + presence.dinnerOccasions) / 3,
    }));

    const result = engineerPersonWeek({
      member, target, mains: mainsForPerson, breakfast, breakfastOccasions: presence.breakfastOccasions,
      snackBaseline, snackOccasions: presence.snackOccasions, daysActive: presence.daysActive,
    });

    // B6's reallocation only applies to mains (see engineerPersonWeek) — breakfast and
    // user-picked snacks scale by their plain factor. Grocery needs the person's TOTAL
    // servings-equivalent for the whole week (per-occasion factor x occasions/week) —
    // buildGroceryBaseline divides by the recipe's feeds to get a per-serving amount first.
    // Each main now carries its OWN proteinFactor/otherFactor (Point 4) rather than one
    // shared value for every main this person eats.
    result.mainPortions.forEach((p, idx) => {
      mainContributions[idx].perPersonQty.push({
        member, factor: p.factor * p.occasionsPerWeek, proteinFactor: p.proteinFactor, otherFactor: p.otherFactor,
      });
    });
    if (breakfastContribution) {
      breakfastContribution.perPersonQty.push({ member, factor: result.breakfastFactor * presence.breakfastOccasions });
    }
    // B1 — every present person gets each user-picked snack once per THEIR snack count for
    // the week (Point 2's independent snack counter) — a flat headcount baseline, not
    // macro-scaled per person.
    for (const contrib of snackContributions) {
      contrib.perPersonQty.push({ member, factor: presence.snackOccasions });
    }

    // Point 3: only recommend a gap-fill snack when the household didn't already choose
    // their own snack(s) for the week — if they picked Snack 1/2 themselves, respect that
    // choice exactly, even if a gap remains (Advice can mention it; the engine doesn't
    // silently add more food on top of what was explicitly chosen).
    const gapFillSnack = (target && snacks.length === 0) ? recommendGapFillSnack(result.gap, availableSnacks) : null;

    people.push({
      memberId: member.id, name: member.name, isChild: Boolean(member.isChild), hasTarget: Boolean(target), target,
      avgDaily: result.avgDaily, gap: result.gap, warnings: result.warnings,
      // mainPortions carries each main's own proteinFactor/otherFactor (Point 4) — read
      // those per-main instead of a single person-level proteinExtraFactor.
      mainPortions: result.mainPortions, breakfastFactor: result.breakfastFactor, gapFillSnack,
      // Point 5 (Stage 4 rewire) — Advice-writing context the AI call needs and the engine
      // never interprets itself: this member's cycle phase for the week (if opted in) and
      // their free-text training plan (if activity is "training").
      cyclePhase: (cyclePhases || []).find((c) => c.memberId === member.id)?.phase || null,
      trainingDetail: member.trainingDetail || null,
    });
  }

  // Point 5 (Stage 4 rewire): the engine's grocery involvement stops at raw, consolidated,
  // per-contribution quantities (buildGroceryBaseline) — no more swap/exclusion decisions
  // here. The AI call gets that baseline as ground truth, plus WHO eats each recipe and
  // THEIR raw individual-rule notes (verbatim — the AI reads the free text itself, typos
  // and all), plus the household-wide family rules, which apply to every recipe regardless
  // of who's eating it (per the explicit scoping this rewrite is built on).
  const allContributions = [...mainContributions, ...(breakfastContribution ? [breakfastContribution] : []), ...snackContributions];
  const groceryBaseline = buildGroceryBaseline({ recipeContributions: allContributions, buyVsMakeAnswers: buyVsMake });
  const recipeEaters = allContributions.map((contrib) => ({
    recipeName: contrib.recipe.name,
    eaters: contrib.perPersonQty.map(({ member }) => ({
      memberName: member.name,
      individualRules: (member.individualRules || []).map((r) => ({ type: r.type, note: r.note })),
    })),
  }));

  return { people, groceryBaseline, recipeEaters, familyRules: household.familyRules, refusals: [] };
}

module.exports = {
  BREAKFAST_SHARE, MAIN_OCCASION_SHARE,
  PROTEIN_PER_MEAL_CAP_G_PER_KG, MAX_SINGLE_MEAT_COMPONENT_G,
  PROTEIN_TOPUP_TRIGGER_G, GAP_FILL_TRIGGER_KCAL,
  MIN_SCALE, MAX_SCALE,
  roundIngredientQty, scaleIngredients, scaleMacros, addMacros,
  memberPresence, calcAgeFromDob,
  resolveMemberTarget, wholeRecipeScaleFactor, maxProteinMultiplier, engineerPersonWeek, recommendGapFillSnack,
  classifyCategory, buildGroceryBaseline,
  buildWeek, clamp,
};
