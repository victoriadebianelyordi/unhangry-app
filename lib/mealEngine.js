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

// ---------------- meal-share model (rebuilt) ----------------
//
// Every lunch/dinner occasion targets a FLAT 35% of the person's daily calorie target
// (70% lunch+dinner combined, assumed 2 main occasions/day regardless of their real
// weekly occasion count — confirmed: "having a non-active lunch or dinner occasion
// doesn't mean the person won't eat, it just means they won't eat at home or prepped
// food"). Breakfast targets a flat 30%. These are per-OCCASION constants, not derived
// from how many occasions actually happen this week — that's the fix for the old model,
// where dividing a week's total occasions unevenly by 3 produced nonsense like "3.33
// servings of Beef Stroganoff." Occasion COUNTS are now always whole numbers (see
// fixOccasionCounts/assignOccasionsToPeople below); only the per-occasion SIZE is
// computed from these flat shares.
const BREAKFAST_OCCASION_SHARE = 0.30;
const LUNCH_DINNER_OCCASION_SHARE = 0.35; // 0.70 / 2

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

// Part F — the final aggregate check: real weekly totals (post rounding/B7/B6) must not
// meaningfully cross the person's daily calorie ceiling. Protein being "enough" is already
// handled by B6 (reallocation) + the warning it pushes when it can't fully close the gap,
// and B12 (below) already recommends a scaled snack for whatever's left — this constant is
// specifically the missing calorie-overage half of that check.
const CALORIE_CEILING_TOLERANCE = 0.10; // 10% over daily target triggers a warning

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
// Point 2 (confirmed spec): protein rounds to the nearest 20g, carbs (rice/pasta/grains/
// oats) to the nearest 50g — both NEAREST, not always rounded up, so a 210g protein
// portion can come down to 200g as easily as up to 220g. Sauces/spices/oils measured in
// tsp/tbsp/ml stay in those units — never forced into grams (a gram-to-volume conversion
// depends on the ingredient's density, which isn't reliable to assume generically; this is
// also directly why "2 tbsp curry powder" needs to just stay "2 tbsp," not become a fake
// gram figure). Whole units (eggs, pieces, cloves) always stay whole.
function roundIngredientQty(qty, unit, component) {
  if (qty == null || !isFinite(qty)) return qty;
  const u = String(unit || '').toLowerCase();

  const asGrams = (u === 'kg') ? qty * 1000 : (u === 'g') ? qty : null;
  if (asGrams != null) {
    if (component === 'protein') return { qty: Math.round(asGrams / 20) * 20, unit: 'g' };
    if (component === 'carb') return { qty: Math.round(asGrams / 50) * 50, unit: 'g' };
    if (component === 'other') return { qty: Math.ceil(asGrams / 50) * 50, unit: 'g' }; // vegetables etc.
    // A gram/kg-measured "sauce" here is a bulk cooking ingredient (yogurt, hummus,
    // canned tomatoes, sugar) — not a tsp/tbsp spice/oil, which never reaches this
    // branch (handled below, always kept in its own unit). Nearest 5g stays sensible here.
    if (component === 'sauce') return { qty: Math.round(asGrams / 5) * 5, unit: 'g' };
    return { qty: round1(qty), unit };
  }

  if (component === 'sauce' || component === 'other') {
    if (u === 'tbsp') return { qty: Math.round(qty * 2) / 2, unit }; // nearest half-tablespoon
    if (u === 'tsp') return { qty: Math.round(qty), unit }; // nearest whole teaspoon
    if (u === 'ml') return { qty: Math.round(qty / 5) * 5, unit }; // nearest 5ml
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

// ---------------- Part A — fix household-wide whole-number occasion counts ----------------
//
// Before any personal scaling happens, decide exactly how many total servings each chosen
// recipe provides this week, as a WHOLE number, household-wide — never a fraction. Compares
// the recipes' authored `feeds` values (their base serving count) against how many main
// occasions the household actually needs, and closes the gap in whole units, distributed
// evenly with any remainder going to the highest-protein-density recipe (if adding) or
// taken from the lowest-protein-density recipe (if removing, i.e. the recipes already cover
// more than needed). Works for breakfast too (n=1 — trivially just the total, no
// distribution decision to make).
function fixOccasionCounts(recipes, totalOccasionsNeeded) {
  const n = recipes.length;
  if (n === 0) return [];
  const counts = recipes.map((r) => r.feeds || 1);
  const baseTotal = counts.reduce((a, b) => a + b, 0);
  const diff = totalOccasionsNeeded - baseTotal;
  if (diff === 0) return counts;

  const density = recipes.map((r) => (r.macrosPerServing.protein || 0) / (r.macrosPerServing.kcal || 1));
  // Adding: highest density gets the remainder first. Removing: lowest density loses first.
  const order = [...Array(n).keys()].sort((a, b) => diff > 0 ? density[b] - density[a] : density[a] - density[b]);
  const absDiff = Math.abs(diff);
  const evenShare = Math.floor(absDiff / n);
  const remainder = absDiff % n;
  for (let i = 0; i < n; i++) {
    const rank = order.indexOf(i);
    const delta = evenShare + (rank < remainder ? 1 : 0);
    counts[i] += diff > 0 ? delta : -delta;
  }
  return counts.map((c) => Math.max(0, c));
}

// ---------------- Part B — assign each recipe's fixed occasions to individual people ----------------
//
// Each person's own total occasions (e.g. lunch+dinner combined) splits evenly across the
// chosen recipes by floor division — 10 total / 3 recipes = 3 each, remainder 1. Any
// leftover occasion a person can't evenly place goes, at random, to whichever recipe
// hasn't yet reached the household-wide target fixed by fixOccasionCounts above (never to
// one that's already full) — confirmed: "distribute them randomly... from whichever
// recipe still has portions." Returns assigned[personIndex][recipeIndex].
function assignOccasionsToPeople(peopleTotals, recipeTargets) {
  const n = recipeTargets.length;
  const assigned = peopleTotals.map(() => new Array(n).fill(0));
  const remaining = [...recipeTargets];
  const leftovers = [];

  peopleTotals.forEach((total, personIdx) => {
    const even = Math.floor(total / n);
    const rem = total % n;
    for (let i = 0; i < n; i++) {
      assigned[personIdx][i] += even;
      remaining[i] -= even;
    }
    if (rem > 0) leftovers.push({ personIdx, count: rem });
  });

  for (const { personIdx, count } of leftovers) {
    for (let k = 0; k < count; k++) {
      const available = [];
      for (let i = 0; i < n; i++) if (remaining[i] > 0) available.push(i);
      if (available.length === 0) break; // shouldn't happen if totals reconcile, but stay defensive
      const pick = available[Math.floor(Math.random() * available.length)];
      assigned[personIdx][pick] += 1;
      remaining[pick] -= 1;
    }
  }
  return assigned;
}

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
// Takes the already-computed flat per-occasion kcal target directly (see
// lunchDinnerOccasionTarget/breakfastOccasionTarget below) — no daily-target-times-share
// math happens in here any more, since the flat target already IS that number.
function wholeRecipeScaleFactor(occasionKcalTarget, recipeMacrosPerServing) {
  if (occasionKcalTarget == null) return 1.0; // incomplete profile data only — see resolveMemberTarget
  const factor = occasionKcalTarget / (recipeMacrosPerServing.kcal || 1);
  return clamp(factor, MIN_SCALE, MAX_SCALE);
}

// ---------------- Part C — flat per-occasion calorie targets ----------------
//
// Lunch/dinner: a flat 35% of the daily target (confirmed — not derived from the real
// occasion count). If a snack was hand-picked for the week, its average daily calories
// (from the household's OWN "This Week's Exceptions" snackCount, never a vague total —
// snackOccasions here IS that field) get halved (same flat 2-occasions/day assumption)
// and subtracted, so lunch/dinner portions shrink to make room for the snack instead of
// stacking on top of it. No snack picked (snackOccasions from an empty snacks[] means
// snackBaseline is {kcal:0,...} regardless of the count) → no deduction.
function lunchDinnerOccasionTarget(dailyKcalTarget, snackBaseline, snackOccasions, daysActive) {
  if (dailyKcalTarget == null) return null;
  const flat = dailyKcalTarget * LUNCH_DINNER_OCCASION_SHARE;
  if (!snackOccasions || !daysActive) return flat;
  const avgDailySnackKcal = (snackBaseline.kcal || 0) * snackOccasions / daysActive;
  const perOccasionDeduction = avgDailySnackKcal / 2; // flat 2 main occasions/day, same as the target itself
  return Math.max(0, flat - perOccasionDeduction);
}

function breakfastOccasionTarget(dailyKcalTarget) {
  if (dailyKcalTarget == null) return null;
  return dailyKcalTarget * BREAKFAST_OCCASION_SHARE;
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

// ---------------- component recipes — per-person sizing ----------------
// A component recipe's plate for ONE occasion, per the approved rule:
//   1. fixed sides, addon toppings and fixed-count units (½ pita) take 1 base serving;
//   2. units sized by calories (kafta sandwiches, arayes chunks) take their calorie share,
//      rounded to their step and clamped to min/max;
//   3. with one protein + one fill ratio component, both are solved together so the plate
//      hits the protein portion AND the calorie target; with only a protein component, it
//      is sized to the protein portion; otherwise (children, whole dishes, no protein
//      target) every ratio component shares one factor sized to the remaining calories.
// Optional components (to-taste toppings) are never sized or counted — factor 1 for the
// grocery list only.
function isComponentRecipe(recipe) {
  return Array.isArray(recipe.components) && recipe.components.length > 0;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function componentMacros(recipe, factors) {
  return recipe.components
    .filter((c) => !c.optional)
    .reduce((sum, c) => addMacros(sum, scaleMacros(c.macrosPerServing || {}, factors[c.id] ?? 1)), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

function sizeComponentsForOccasion(recipe, { kcalTarget, proteinTarget, isChild }) {
  const factors = {};
  const units = {};
  const K = (c) => (c.macrosPerServing || {}).kcal || 0;
  const P = (c) => (c.macrosPerServing || {}).protein || 0;
  const baseUnitsPerServing = (c) => c.units.count / (c.servings || recipe.feeds || 1);
  let usedK = 0;
  let usedP = 0;
  const take = (c, f) => { factors[c.id] = f; usedK += K(c) * f; usedP += P(c) * f; };

  const active = recipe.components.filter((c) => !c.optional);
  recipe.components.filter((c) => c.optional).forEach((c) => { factors[c.id] = 1; });

  for (const c of active) {
    if (c.scaling === 'fixed' || c.scaling === 'addon') take(c, 1);
    else if (c.scaling === 'units' && c.units && c.units.sizeBy === 'fixed') {
      units[c.id] = c.units.perServing;
      take(c, c.units.perServing / baseUnitsPerServing(c));
    }
  }

  if (kcalTarget == null) {
    for (const c of active) {
      if (factors[c.id] != null) continue;
      if (c.scaling === 'units') units[c.id] = roundToStep(baseUnitsPerServing(c), c.units.step || 1);
      take(c, c.scaling === 'units' ? units[c.id] / baseUnitsPerServing(c) : 1);
    }
    return { factors, units };
  }

  for (const c of active.filter((x) => x.scaling === 'units' && factors[x.id] == null)) {
    const kcalPerUnit = K(c) / baseUnitsPerServing(c);
    const share = c.units.calorieShare ?? 1;
    const wanted = share < 1 ? (kcalTarget * share) / kcalPerUnit : (kcalTarget - usedK) / kcalPerUnit;
    const step = c.units.step || 1;
    const n = clamp(roundToStep(wanted, step), c.units.min ?? step, c.units.max ?? Infinity);
    units[c.id] = n;
    take(c, n / baseUnitsPerServing(c));
  }

  const ratio = active.filter((c) => c.scaling === 'ratio');
  const proteinComps = ratio.filter((c) => c.role === 'protein');
  const otherComps = ratio.filter((c) => c.role !== 'protein');
  const remK = kcalTarget - usedK;
  const remP = proteinTarget != null ? proteinTarget - usedP : null;
  const sizeByProtein = !isChild && remP != null && proteinComps.length === 1;

  if (sizeByProtein && otherComps.length === 1) {
    const [pc, fc] = [proteinComps[0], otherComps[0]];
    const det = P(pc) * K(fc) - P(fc) * K(pc);
    let a = det !== 0 ? (remP * K(fc) - P(fc) * remK) / det : NaN;
    let b = det !== 0 ? (P(pc) * remK - remP * K(pc)) / det : NaN;
    const inRange = (x) => Number.isFinite(x) && x >= MIN_SCALE && x <= MAX_SCALE;
    if (!inRange(a) || !inRange(b)) {
      a = clamp(remP / (P(pc) || 1), MIN_SCALE, MAX_SCALE);
      b = clamp((remK - K(pc) * a) / (K(fc) || 1), MIN_SCALE, MAX_SCALE);
    }
    take(pc, a);
    take(fc, b);
  } else if (sizeByProtein && otherComps.length === 0) {
    take(proteinComps[0], clamp(remP / (P(proteinComps[0]) || 1), MIN_SCALE, MAX_SCALE));
  } else if (ratio.length) {
    const ratioK = ratio.reduce((s, c) => s + K(c), 0);
    const f = clamp(remK / (ratioK || 1), MIN_SCALE, MAX_SCALE);
    ratio.forEach((c) => take(c, f));
  }
  return { factors, units };
}

// How much of the base per-serving quantity one ingredient gets for this person: its
// component's factor for component recipes, otherwise the whole-dish factor (with B6's
// protein/other split).
function ingredientFactor(ing, { factor, proteinFactor, otherFactor, componentFactors }) {
  if (componentFactors && ing.componentId != null && componentFactors[ing.componentId] != null) {
    return componentFactors[ing.componentId];
  }
  return ing.component === 'protein' ? factor * (proteinFactor ?? 1) : factor * (otherFactor ?? 1);
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

  // Part C — flat per-occasion targets (35% of daily kcal per lunch/dinner, 30% for
  // breakfast), snack-adjusted for lunch/dinner only. occasionsPerWeek on each main is now
  // a REAL WHOLE NUMBER (fixed by fixOccasionCounts/assignOccasionsToPeople before this
  // function ever runs) — this function only decides how big ONE serving is, never how
  // many there are.
  const lunchDinnerTarget = target ? lunchDinnerOccasionTarget(target.kcal, snackBaseline, snackOccasions, daysActive) : null;
  const breakfastTarget = target ? breakfastOccasionTarget(target.kcal) : null;

  // B5 — whole-recipe (calorie-driven) factor per main, plus breakfast. proteinFactor/
  // otherFactor start at 1 (no adjustment) — B6 below may raise proteinFactor and lower
  // otherFactor on a PER-MAIN basis for whichever mains absorb the protein top-up (Point 4
  // rebuild: this used to be one uniform factor applied to every main equally).
  const lunchDinnerProteinTarget = target && target.proteinG != null ? target.proteinG * LUNCH_DINNER_OCCASION_SHARE : null;
  const mainPortions = mains.map(({ method, recipe, occasionsPerWeek }) => {
    if (isComponentRecipe(recipe)) {
      const { factors, units } = sizeComponentsForOccasion(recipe, {
        kcalTarget: lunchDinnerTarget, proteinTarget: lunchDinnerProteinTarget, isChild: Boolean(member.isChild),
      });
      return {
        method, recipe, occasionsPerWeek,
        factor: componentMacros(recipe, factors).kcal / (recipe.macrosPerServing.kcal || 1),
        proteinFactor: 1, otherFactor: 1, componentFactors: factors, componentUnits: units,
      };
    }
    return {
      method, recipe, occasionsPerWeek,
      factor: wholeRecipeScaleFactor(lunchDinnerTarget, recipe.macrosPerServing),
      proteinFactor: 1, otherFactor: 1,
    };
  });
  const breakfastFactor = breakfast
    ? wholeRecipeScaleFactor(breakfastTarget, breakfast.macrosPerServing)
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
    if (p.componentFactors) return scaleMacros(componentMacros(p.recipe, p.componentFactors), p.occasionsPerWeek);
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
      // Point 4 (confirmed scope): only recipes marked componentScalable can absorb an
      // independent protein top-up — not every dish separates cleanly into "the meat" and
      // "everything else" (a lasagna can't give one person extra beef and less pasta/sauce
      // independently; a stroganoff can). Non-scalable dishes still count toward this
      // person's actual weekly protein via their calorie-driven B5 factor — they just can't
      // be individually boosted.
      const ranked = mainPortions
        .map((p) => ({
          p, mMax: maxProteinMultiplier(member, p),
          density: p.recipe.macrosPerServing.kcal > 0 ? (p.recipe.macrosPerServing.protein || 0) / p.recipe.macrosPerServing.kcal : 0,
        }))
        .filter((r) => r.p.recipe.componentScalable && r.mMax > 1 && r.p.recipe.macrosPerServing.protein > 0)
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
        const scaledQty = (ing.qty / (p.recipe.feeds || 1)) * ingredientFactor(ing, p);
        const grams = (ing.unit || '').toLowerCase() === 'kg' ? scaledQty * 1000 : scaledQty;
        if ((ing.unit || '').toLowerCase() === 'g' || (ing.unit || '').toLowerCase() === 'kg') {
          if (grams > MAX_SINGLE_MEAT_COMPONENT_G) {
            warnings.push(`${member.name}'s ${p.recipe.name} portion needs ~${Math.round(grams)}g of ${ing.name} — above the ${MAX_SINGLE_MEAT_COMPONENT_G}g single-meal guideline. Consider another occasion or food for the rest, or keep it if the target genuinely needs it.`);
          }
        }
      }
      // Rough per-meal protein check using the recipe's own macro (not just the one
      // ingredient) — catches the case even when the protein source isn't in g/kg units.
      const mealProteinG = p.componentFactors
        ? componentMacros(p.recipe, p.componentFactors).protein
        : p.recipe.macrosPerServing.protein * p.factor * p.proteinFactor;
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

  // Part F — final aggregate check: does the real, final, post-rounding weekly plan
  // meaningfully cross the daily calorie ceiling? (Protein-enough is already B6's job
  // above, plus B12's gap-fill snack recommendation, called separately in buildWeek.)
  if (target && gap && gap.kcal < -(target.kcal * CALORIE_CEILING_TOLERANCE)) {
    warnings.push(`${member.name}'s weekly plan averages ~${Math.round(avgDaily.kcal)} kcal/day — about ${Math.round(-gap.kcal)} kcal over their ${target.kcal} kcal target. Consider a smaller portion or one fewer occasion of a main this week.`);
  }

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
// Up to `limit` snacks that close the gap, nearest first, each with its engine-computed
// portion and exact macros — the only fixes AI Advice may choose from.
function gapFillCandidates(gap, availableSnacks, limit = 3) {
  if (!gap || gap.kcal < GAP_FILL_TRIGGER_KCAL) return [];

  const macroGapsKcal = {
    protein: Math.max(0, gap.proteinG) * 4,
    carb: Math.max(0, gap.carbG) * 4,
    fat: Math.max(0, gap.fatG) * 9,
  };
  const neededMacro = Object.entries(macroGapsKcal).sort((a, b) => b[1] - a[1])[0][0];

  const candidates = availableSnacks.filter((s) => s.primaryMacro === neededMacro && s.macrosPerServing && s.macrosPerServing.kcal > 0);
  // Nearest match: the snack whose serving size comes closest to the remaining daily kcal gap.
  candidates.sort((a, b) => Math.abs(a.macrosPerServing.kcal - gap.kcal) - Math.abs(b.macrosPerServing.kcal - gap.kcal));

  return candidates.slice(0, limit).map((snack) => {
    const portionMultiplier = clamp(round1(gap.kcal / snack.macrosPerServing.kcal), 0.5, 2);
    const m = scaleMacros(snack.macrosPerServing, portionMultiplier);
    return {
      recipeId: snack.id, name: snack.name, primaryMacro: snack.primaryMacro, portionMultiplier,
      dailyKcalGapClosed: Math.round(m.kcal),
      kcal: Math.round(m.kcal), proteinG: Math.round(m.protein), carbG: Math.round(m.carbs), fatG: Math.round(m.fat),
    };
  });
}

function recommendGapFillSnack(gap, availableSnacks) {
  return gapFillCandidates(gap, availableSnacks, 1)[0] || null;
}

// The gap numbers AI Advice is allowed to use — computed here, never by the model.
// Positive = short of target, negative = over target.
function lockedGaps(gap) {
  if (!gap) return null;
  return {
    kcalGap: Math.round(gap.kcal), proteinGapG: Math.round(gap.proteinG),
    carbGapG: Math.round(gap.carbG), fatGapG: Math.round(gap.fatG),
  };
}

// ---------------- categorization ----------------
//
// Still deterministic, still the engine's job — this is just "which grocery aisle,"
// unrelated to the rule-matching that used to live here (Point 5 / Stage 4 rewire moved
// allergy/dislike swap decisions to the AI call — see buildGroceryBaseline below. The old
// keyword-based matchIndividualRule/familyRuleExcludes are gone: that was a "documented
// simplification" this whole rewrite exists to replace with an AI reading the raw,
// unedited rule text directly, typos and all, instead of guessing from keywords).

// Exactly 3 categories, per explicit spec — nothing else is valid, and the AI is never
// allowed to invent a 4th (see lib/claude.js). Priority order matters: dairy/protein
// (fridge) keywords are checked FIRST regardless of the ingredient's component tag, since
// e.g. a cream/yogurt SAUCE is still a fridge item even though its component is "sauce."
// Anything that matches nothing falls through to Pantry — the deliberate catch-all, per
// spec ("any item that doesn't match any category goes to Pantry").
const GROCERY_CATEGORIES = {
  PRODUCE_BAKERY: 'Fresh Produce & Bakery',
  DAIRY_PROTEINS: 'Dairy & Proteins',
  PANTRY: 'Pantry',
};

const DAIRY_PROTEIN_KEYWORDS = [
  // meat / poultry / fish — the fridge case
  'beef', 'chicken', 'turkey', 'pork', 'lamb', 'veal', 'bacon', 'ham', 'sausage', 'kafta',
  'fish', 'salmon', 'tuna', 'shrimp', 'prawn', 'crab', 'lobster', 'seafood',
  // dairy + eggs + fridge-stored plant protein/dip — specific cheese names listed
  // separately from the generic word "cheese" (mozzarella/parmesan don't contain it)
  'milk', 'yogurt', 'yoghurt', 'cheese', 'butter', 'cream', 'egg', 'skyr', 'tofu', 'labneh',
  'hummus', 'mozzarella', 'parmesan', 'cheddar', 'feta', 'ricotta', 'halloumi', 'gouda', 'brie',
];
const BAKERY_KEYWORDS = ['bread', 'pita', 'tortilla', 'wrap', 'croissant', 'bun', 'bagel', 'naan'];
// Common fresh produce this app's recipes actually use — a keyword list, not an exhaustive
// botanical one; anything genuinely missed here still lands safely in Pantry (never in the
// wrong section), so extending this list is low-risk if something new comes up.
const PRODUCE_KEYWORDS = [
  'onion', 'garlic', 'tomato', 'cucumber', 'lettuce', 'spinach', 'broccoli', 'cauliflower',
  'carrot', 'potato', 'zucchini', 'pepper', 'jalapeno', 'jalapeño', 'mushroom', 'avocado',
  'lime', 'lemon', 'cilantro', 'parsley', 'mint', 'basil', 'ginger', 'scallion', 'shallot',
  'pomegranate', 'banana', 'apple', 'berry', 'berries', 'mango', 'grape', 'orange', 'kale',
  'cabbage', 'celery', 'herb', 'veggie', 'vegetable', 'salad', 'greens', 'fruit',
];
// A produce-sounding name that's actually canned/jarred is shelf-stable, not fresh —
// checked before PRODUCE_KEYWORDS so it wins the classification instead of the base word
// ("tomato") pulling it into Fresh Produce & Bakery. Generic 'canned'/'tinned'/'jarred'
// catch anything not explicitly listed here (canned corn, jarred artichokes, etc).
const CANNED_PRODUCE_KEYWORDS = [
  'canned', 'tinned', 'jarred', 'crushed tomato', 'diced tomato', 'chopped tomato',
  'tomato paste', 'tomato puree', 'tomato sauce',
];

// Shelf-stable items whose names contain a dairy/protein or produce keyword ("peanut butter",
// "beef broth", "canned tuna", "black pepper", "garlic powder") — checked first so they land
// in Pantry.
const SHELF_STABLE_KEYWORDS = [
  'peanut butter', 'nut butter', 'almond butter', 'cashew butter', 'cocoa butter',
  'broth', 'stock', 'canned', 'tinned', 'jarred',
  'salt', 'black pepper', 'red pepper flakes', 'garlic powder', 'onion powder', 'dry ginger', 'dry lemon',
  'passata', 'marinara',
];

// A recipe-context note in parens ("Olive oil (for salad)") must never leak a keyword
// match into the wrong category — "(for salad)" contains "salad" (a produce keyword) but
// the ingredient itself is oil, not produce. Classification always looks at the name with
// any trailing parenthetical stripped, same as the grocery-line consolidation key does.
function stripTrailingParen(name) {
  const n = name.toLowerCase();
  return n.includes(',') ? n : n.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Same idea, but for what actually gets shown to the shopper: a recipe-context note
// ("for salad", "for rice", "optional", "air fried") is authoring metadata, not something
// a shopper needs — nobody buying olive oil cares which dish it's going toward, and there
// is exactly one bottle to buy regardless. Always strips the trailing parenthetical for
// display, case preserved; a comma-separated compound ingredient ("Salt, pepper, nutmeg
// (for bechamel)") still only loses the trailing note, not its real distinguishing content.
function displayIngredientName(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function classifyCategory(ingredientName, component, recipeProteinType) {
  const n = stripTrailingParen(ingredientName);
  if (SHELF_STABLE_KEYWORDS.some((k) => wordMatch(n, k))) return GROCERY_CATEGORIES.PANTRY;
  if (DAIRY_PROTEIN_KEYWORDS.some((k) => wordMatch(n, k))) return GROCERY_CATEGORIES.DAIRY_PROTEINS;
  if (component === 'protein' && (recipeProteinType === 'beef' || recipeProteinType === 'chicken' || recipeProteinType === 'seafood')) {
    return GROCERY_CATEGORIES.DAIRY_PROTEINS;
  }
  if (BAKERY_KEYWORDS.some((k) => wordMatch(n, k))) return GROCERY_CATEGORIES.PRODUCE_BAKERY;
  // Canned/jarred produce is shelf-stable, not fresh — check BEFORE the produce keyword
  // match below, so "Crushed tomatoes" doesn't get caught by "tomato" and land in Fresh
  // Produce & Bakery; it's a canned good and belongs in Pantry, per spec ("cans, jars that
  // are not cooled").
  if (CANNED_PRODUCE_KEYWORDS.some((k) => wordMatch(n, k))) return GROCERY_CATEGORIES.PANTRY;
  if (component === 'aromatic' || PRODUCE_KEYWORDS.some((k) => wordMatch(n, k))) return GROCERY_CATEGORIES.PRODUCE_BAKERY;
  return GROCERY_CATEGORIES.PANTRY; // shelf-stable catch-all — spices, oils, grains, cans/jars, dried legumes, etc.
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
// Each line keeps its individual CONTRIBUTIONS (per recipe, per member), not just the
// summed total — the AI needs that granularity to correctly carve out an allergy swap for
// the ONE person it applies to, and Weigh & Pack needs it to state a real per-serving
// portion. Each contribution carries BOTH the per-occasion amount (qtyPerOccasion — one
// serving) and occasionsPerWeek (how many times this person eats it this week), computed
// here, never left for the AI to divide out of a weekly total itself — that's what
// produced a "790g salmon portion" that was actually a whole week's worth of servings. The
// summed `totalQty` per ingredient is the number the AI's response is validated against
// (see lib/claude.js's guardrail).
//
// Buy-vs-make stays here, not moved to the AI — it's a deterministic pick between two
// pre-authored labels for the SAME already-computed quantity (no judgment call, no free
// text to interpret), so there's no reason to hand it to a language model.
//
// isPantryUnit flags ingredients measured in tsp/tbsp/pinch/"to taste" — spices and
// pantry staples nobody buys in that exact amount. The app doesn't invent a fake retail
// pack size for these; it keeps the real quantity needed but labels and groups them
// differently in the final list (see lib/claude.js and the frontend sort).
const PANTRY_UNITS = new Set(['tsp', 'tbsp', 'pinch', 'to taste']);

// Ingredient names vary in wording across recipe files even when they mean the exact same
// grocery item — "Onion (large)", "Onions (medium)", "Brown onion" should all consolidate
// into one line, per spec. Normalizes ONLY the matching key (never the displayed name) by
// stripping a trailing parenthetical note, a short list of common size/color/prep
// qualifiers, and simple pluralization on the head noun — deliberately conservative: it
// never touches a comma-separated compound ingredient (so "Salt, pepper, nutmeg (for
// bechamel)" stays its own line rather than wrongly merging with plain "Salt"), and it
// only de-pluralizes words that clearly aren't already something like "hummus"/"cress".
const IGNORABLE_QUALIFIERS = new Set([
  'large', 'medium', 'small', 'brown', 'white', 'yellow', 'red', 'fresh', 'dried',
  'chopped', 'diced', 'sliced', 'minced', 'ground', 'shredded', 'grated', 'whole',
]);
function normalizeIngredientKey(name) {
  const n = stripTrailingParen(name);
  const words = n.split(/\s+/).filter((w) => w && !IGNORABLE_QUALIFIERS.has(w));
  if (words.length > 0) {
    const last = words[words.length - 1];
    if (last.length > 3 && last.endsWith('s') && !last.endsWith('us') && !last.endsWith('ss')) {
      words[words.length - 1] = last.slice(0, -1);
    }
  }
  return words.join(' ');
}

function buildGroceryBaseline({ recipeContributions, buyVsMakeAnswers }) {
  const lines = new Map(); // key: `${category}::${normalizedName}` -> { name, category, unit, component, shelfLife, freezeFriendly, contributions: [] }

  for (const contrib of recipeContributions) {
    const { recipe, perPersonQty } = contrib; // perPersonQty: [{ member, factor, occasionsPerWeek, proteinFactor?, otherFactor? }]
    for (const ing of recipe.ingredients || []) {
      if (ing.qty == null) continue;

      const buyVsMakeChoice = (buyVsMakeAnswers || []).find((b) => b.recipeName === recipe.name && b.ingredientName === ing.name);
      const effectiveName = buyVsMakeChoice && buyVsMakeChoice.choice === 'buy' && ing.buyVsMake ? ing.buyVsMake.buy : ing.name;
      const category = classifyCategory(ing.name, ing.component, recipe.protein);
      // Unit is part of the key too — never silently merge "500g onion" from one recipe
      // with "2 pc onion" from another (incompatible units summed as raw numbers would be
      // a real, silent quantity bug). Same-name-different-unit stays as two honest lines
      // rather than one wrong one.
      const key = `${category}::${normalizeIngredientKey(effectiveName)}::${String(ing.unit || '').toLowerCase()}`;

      if (!lines.has(key)) {
        lines.set(key, {
          name: displayIngredientName(effectiveName), category, unit: ing.unit, component: ing.component,
          shelfLife: null, freezeFriendly: false,
          isPantryUnit: PANTRY_UNITS.has(String(ing.unit || '').toLowerCase()),
          contributions: [],
        });
      }
      const line = lines.get(key);
      // recipe.flags.shelfLife/freezeFriendly describe the PREPARED DISH (e.g. "this
      // assembled oats jar keeps 4-5 days refrigerated"), not every raw ingredient that
      // went into it — a shelf-stable Pantry item (honey, salt, flour) doesn't inherit a
      // fridge dish's shelf life just because it's one of the dish's ingredients. Only
      // ingredients in the genuinely perishable categories (fresh/chilled) can carry
      // either flag; Pantry items never do, regardless of what the recipe itself says.
      if (category !== GROCERY_CATEGORIES.PANTRY) {
        if ((recipe.flags || {}).shelfLife) line.shelfLife = recipe.flags.shelfLife;
        if ((recipe.flags || {}).freezeFriendly) line.freezeFriendly = true;
      }

      for (const contribution of perPersonQty) {
        const { member, occasionsPerWeek } = contribution;
        if (!occasionsPerWeek) continue; // this person doesn't actually eat this occasion type
        // ing.qty is the whole base recipe's quantity (feeds servings), so it's divided down
        // to a per-serving amount, then scaled by this person's per-occasion factor for this
        // ingredient — that's ONE serving; the weekly total is that times occasionsPerWeek.
        const effectiveFactor = ingredientFactor(ing, contribution);
        const qtyPerOccasion = (ing.qty / (recipe.feeds || 1)) * effectiveFactor;
        if (qtyPerOccasion <= 0) continue;
        line.contributions.push({
          recipeName: recipe.name, memberId: member.id, memberName: member.name,
          occasionsPerWeek: round1(occasionsPerWeek),
          qtyPerOccasion: round1(qtyPerOccasion),
          qty: round1(qtyPerOccasion * occasionsPerWeek), // this contribution's weekly total
        });
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
      isPantryUnit: line.isPantryUnit,
      shelfLife: line.shelfLife, freezeFriendly: line.freezeFriendly,
      contributions: line.contributions,
    });
  }
  return Array.from(byCategory.entries()).map(([name, items]) => ({ name, items }));
}

// "Copy recipes for the cook" needs a different total than the grocery list: not one
// consolidated cross-recipe line (groceryBaseline merges "Onion" from every recipe into
// one shopping quantity, with a shopper-facing name that's already dropped notes like
// "(large)"), but the whole household's weekly total for THIS recipe alone, keeping the
// recipe's own ingredient order/name/unit exactly as authored (a cook following "1 pc
// Onion (large)" step-by-step needs that note; a shopper buying onions doesn't). Same
// per-occasion scaling math as buildGroceryBaseline, just grouped by recipe instead of by
// normalized cross-recipe name — still 100% engine arithmetic, nothing the AI computes.
function buildRecipeIngredientTotals(recipeContributions) {
  const byRecipe = new Map();
  for (const { recipe, perPersonQty } of recipeContributions) {
    if (!byRecipe.has(recipe.name)) byRecipe.set(recipe.name, new Map());
    const ingredientTotals = byRecipe.get(recipe.name);
    for (const ing of recipe.ingredients || []) {
      if (ing.qty == null) continue;
      // componentId in the key: the same ingredient in two components (olive oil in the
      // stroganoff AND in the rice) stays two lines, each under its own component.
      const key = `${ing.componentId || ''}::${ing.name}::${String(ing.unit || '').toLowerCase()}`;
      if (!ingredientTotals.has(key)) {
        ingredientTotals.set(key, {
          name: ing.name, unit: ing.unit, component: ing.component, totalQty: 0,
          componentId: ing.componentId || null, group: ing.group || null,
        });
      }
      const line = ingredientTotals.get(key);
      for (const contribution of perPersonQty) {
        const { occasionsPerWeek } = contribution;
        if (!occasionsPerWeek) continue;
        const qtyPerOccasion = (ing.qty / (recipe.feeds || 1)) * ingredientFactor(ing, contribution);
        if (qtyPerOccasion <= 0) continue;
        line.totalQty += qtyPerOccasion * occasionsPerWeek;
      }
    }
  }

  const result = [];
  for (const [recipeName, ingredientTotals] of byRecipe.entries()) {
    const items = Array.from(ingredientTotals.values())
      .filter((line) => line.totalQty > 0)
      .map((line) => {
        const rounded = roundIngredientQty(line.totalQty, line.unit, line.component);
        return {
          name: line.name, unit: rounded.unit || line.unit || '', qty: round1(rounded.qty),
          componentId: line.componentId, group: line.group,
        };
      });
    result.push({ recipeName, items });
  }
  return result;
}

// ---------------- Weigh & Pack (engine-written) ----------------
// Component mains: each component per person — cooked grams to the nearest 10g for ratio
// components, units in their steps, fixed sides/toppings as "1 portion". Breakfast, snacks
// and flat recipes list every ingredient per serving (g→5, ml→10, tbsp→½, tsp→¼, cup→¼,
// cloves whole, other units→½).
const FRACTION_GLYPHS = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
function formatAmount(n) {
  const whole = Math.floor(n + 1e-9);
  const frac = Math.round((n - whole) * 100) / 100;
  if (frac === 0) return String(whole);
  if (FRACTION_GLYPHS[frac]) return `${whole || ''}${FRACTION_GLYPHS[frac]}`;
  return String(round1(n));
}

function pluralize(label, n) {
  if (n <= 1) return label;
  if (label === 'loaf') return 'loaves';
  return /(ch|sh|s)$/.test(label) ? `${label}es` : `${label}s`;
}

const PACK_STEP = { g: 5, ml: 10, tbsp: 0.5, tsp: 0.25, cup: 0.25, cups: 0.25, clove: 1 };
function describeFlatServing(recipe, factor) {
  return (recipe.ingredients || []).filter((i) => i.qty != null).map((ing) => {
    const name = displayIngredientName(ing.name);
    const lower = name.charAt(0).toLowerCase() + name.slice(1);
    let u = String(ing.unit || '').toLowerCase();
    if (u === 'to taste') return `${lower} to taste`;
    if (u === 'pinch') return /^pinch/i.test(name) ? lower : `pinch of ${lower}`;
    let q = (ing.qty / (recipe.feeds || 1)) * factor;
    if (u === 'kg') { q *= 1000; u = 'g'; }
    if (u === 'l') { q *= 1000; u = 'ml'; }
    const step = PACK_STEP[u] ?? 0.5;
    const r = Math.max(step, roundToStep(q, step));
    if (u === 'g' || u === 'ml') return `${r}${u} ${lower}`;
    if (u === 'pc' || u === '') return `${formatAmount(r)} ${lower}`;
    return `${formatAmount(r)} ${u} ${lower}`;
  }).join(', ');
}

function describeComponentServing(recipe, contribution) {
  const comps = recipe.components.filter((c) => !c.optional);
  const single = comps.length === 1;
  const parts = comps.map((c) => {
    const servings = c.servings || recipe.feeds || 1;
    const f = (contribution.componentFactors || {})[c.id] ?? contribution.factor ?? 1;
    const gramsPerServing = c.cookedYieldG ? c.cookedYieldG / servings : null;
    let amount;
    if (c.scaling === 'units') {
      const n = (contribution.componentUnits || {})[c.id] ?? roundToStep((f * c.units.count) / servings, c.units.step || 1);
      amount = `${formatAmount(n)} ${pluralize(c.units.label, n)}`;
    } else if (c.scaling === 'ratio') {
      const grams = gramsPerServing ? `${Math.max(10, roundToStep(gramsPerServing * f, 10))}g` : `${formatAmount(round1(f))}× base serving`;
      amount = single ? `1 portion, ${grams}` : grams;
    } else {
      amount = gramsPerServing ? `1 portion (~${roundToStep(gramsPerServing, 10)}g)` : '1 portion';
    }
    return single ? amount : `${c.name} ${amount}`;
  });
  const optional = recipe.components.filter((c) => c.optional);
  const suffix = optional.length ? ` (+ ${optional.map((c) => c.name.toLowerCase()).join(', ')} to taste)` : '';
  return parts.join(' + ') + suffix;
}

function buildWeighAndPack(recipeContributions) {
  return recipeContributions.map(({ recipe, perPersonQty }) => ({
    recipeName: recipe.name,
    portions: perPersonQty
      .filter((p) => p.occasionsPerWeek > 0)
      .map((p) => ({
        memberName: p.member.name,
        servingSize: isComponentRecipe(recipe) ? describeComponentServing(recipe, p) : describeFlatServing(recipe, p.factor),
        servingsThisWeek: round1(p.occasionsPerWeek),
        note: null,
      })),
  })).filter((r) => r.portions.length);
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

  // ---- Parts A & B (rebuilt from scratch, confirmed) ----
  // Pass 1: work out every active member's presence and raw occasion totals FIRST — the
  // whole-number fix (Part A) and the per-person assignment (Part B) both need every
  // active person's numbers at once, not one person at a time.
  const activeMembers = membersWithRules
    .map((member) => ({ member, presence: memberPresence(member, weeklyAdjustments || [], household.cookSchedule) }))
    .filter(({ presence }) => presence.active);

  const totalMainOccasionsNeeded = activeMembers.reduce((sum, a) => sum + a.presence.lunchOccasions + a.presence.dinnerOccasions, 0);

  // Part A — fix each main's household-wide occasion count to a whole number (never
  // "3.33 servings"). Breakfast doesn't need this step — there's only one recipe, so
  // there's no rotation/distribution decision to make; each person's own breakfastOccasions
  // (from Part B... which is trivial here too) is used directly, below.
  const mainOccasionCounts = fixOccasionCounts(mains.map((m) => m.recipe), totalMainOccasionsNeeded);

  // Part B — hand those fixed counts out to individual people (even split + random
  // leftover placement, confirmed).
  const perPersonMainOccasions = assignOccasionsToPeople(
    activeMembers.map((a) => a.presence.lunchOccasions + a.presence.dinnerOccasions),
    mainOccasionCounts,
  );

  const people = [];
  // Each recipe's grocery contribution is a list of { member, factor, proteinFactor?,
  // otherFactor? } — buildGroceryBaseline applies proteinFactor to protein-tagged
  // ingredients and otherFactor to everything else (Point 4's per-main reallocation).
  const mainContributions = mains.map(({ recipe }) => ({ recipe, perPersonQty: [] }));
  const breakfastContribution = breakfast ? { recipe: breakfast, perPersonQty: [] } : null;
  const snackContributions = snacks.map((s) => ({ recipe: s, perPersonQty: [] }));

  activeMembers.forEach(({ member, presence }, personIdx) => {
    const target = resolveMemberTarget(member);
    // Each main now carries this specific person's WHOLE-NUMBER occasion count from Part
    // B — never a fractional "(lunch+dinner)/3" split.
    const mainsForPerson = mains.map(({ method, recipe }, recipeIdx) => ({
      method, recipe, occasionsPerWeek: perPersonMainOccasions[personIdx][recipeIdx],
    }));

    const result = engineerPersonWeek({
      member, target, mains: mainsForPerson, breakfast, breakfastOccasions: presence.breakfastOccasions,
      snackBaseline, snackOccasions: presence.snackOccasions, daysActive: presence.daysActive,
    });

    // B6's reallocation only applies to mains (see engineerPersonWeek) — breakfast and
    // user-picked snacks scale by their plain factor. `factor` here is the PER-OCCASION
    // scale (one serving), kept separate from `occasionsPerWeek` (how many times this
    // person eats it this week) — buildGroceryBaseline needs both, not pre-multiplied
    // together, so it can hand the AI a real per-serving amount alongside the weekly total
    // instead of just a weekly figure with no portion count (the bug behind an AI-reported
    // "790g salmon portion" that was actually a whole week's worth). Each main carries its
    // own proteinFactor/otherFactor (Point 4) rather than one shared value for every main
    // this person eats.
    result.mainPortions.forEach((p, idx) => {
      mainContributions[idx].perPersonQty.push({
        member, factor: p.factor, occasionsPerWeek: p.occasionsPerWeek,
        proteinFactor: p.proteinFactor, otherFactor: p.otherFactor,
        componentFactors: p.componentFactors, componentUnits: p.componentUnits,
      });
    });
    if (breakfastContribution) {
      breakfastContribution.perPersonQty.push({
        member, factor: result.breakfastFactor, occasionsPerWeek: presence.breakfastOccasions,
      });
    }
    // B1, fixed — this used to give EVERY selected snack the person's FULL snackOccasions
    // count independently (2 snacks picked + snackCount=10 meant 10 dates AND 10 crackers
    // = 20 total snack occasions, double what was actually asked for). Snacks rotate
    // through the same pool the person's snackOccasions counter describes, same idea as
    // mains — split the count evenly across however many snacks were picked, remainder to
    // the first slot(s). A flat headcount baseline (factor 1 per occasion), not
    // macro-scaled per person.
    const snackCount = snackContributions.length;
    if (snackCount > 0) {
      const evenShare = Math.floor(presence.snackOccasions / snackCount);
      const remainder = presence.snackOccasions % snackCount;
      snackContributions.forEach((contrib, idx) => {
        const occasionsPerWeek = evenShare + (idx < remainder ? 1 : 0);
        contrib.perPersonQty.push({ member, factor: 1, occasionsPerWeek });
      });
    }

    // Point 3: only recommend a gap-fill snack when the household didn't already choose
    // their own snack(s) for the week — if they picked Snack 1/2 themselves, respect that
    // choice exactly, even if a gap remains (Advice can mention it; the engine doesn't
    // silently add more food on top of what was explicitly chosen).
    const gapFillSnack = (target && snacks.length === 0) ? recommendGapFillSnack(result.gap, availableSnacks) : null;
    const fixOptions = target ? gapFillCandidates(result.gap, availableSnacks) : [];

    people.push({
      memberId: member.id, name: member.name, isChild: Boolean(member.isChild), hasTarget: Boolean(target), target,
      avgDaily: result.avgDaily, gap: result.gap, warnings: result.warnings,
      // mainPortions carries each main's own proteinFactor/otherFactor (Point 4) — read
      // those per-main instead of a single person-level proteinExtraFactor.
      mainPortions: result.mainPortions, breakfastFactor: result.breakfastFactor, gapFillSnack,
      lockedGaps: lockedGaps(result.gap), fixOptions,
      // Point 5 (Stage 4 rewire) — Advice-writing context the AI call needs and the engine
      // never interprets itself: this member's cycle phase for the week (if opted in) and
      // their free-text training plan (if activity is "training").
      cyclePhase: (cyclePhases || []).find((c) => c.memberId === member.id)?.phase || null,
      trainingDetail: member.trainingDetail || null,
    });
  });

  // Point 5 (Stage 4 rewire): the engine's grocery involvement stops at raw, consolidated,
  // per-contribution quantities (buildGroceryBaseline) — no more swap/exclusion decisions
  // here. The AI call gets that baseline as ground truth, plus WHO eats each recipe and
  // THEIR raw individual-rule notes (verbatim — the AI reads the free text itself, typos
  // and all), plus the household-wide family rules, which apply to every recipe regardless
  // of who's eating it (per the explicit scoping this rewrite is built on).
  const allContributions = [...mainContributions, ...(breakfastContribution ? [breakfastContribution] : []), ...snackContributions];
  const groceryBaseline = buildGroceryBaseline({ recipeContributions: allContributions, buyVsMakeAnswers: buyVsMake });
  const recipeIngredientTotals = buildRecipeIngredientTotals(allContributions);
  const weighAndPack = buildWeighAndPack(allContributions);
  const recipeEaters = allContributions.map((contrib) => ({
    recipeName: contrib.recipe.name,
    mealType: contrib.recipe.mealType, // 'main' | 'breakfast' | 'snack' — Weigh & Pack's ingredient-completeness rule differs by this
    eaters: contrib.perPersonQty
      .filter((p) => p.occasionsPerWeek > 0)
      .map(({ member, occasionsPerWeek }) => ({
        memberName: member.name,
        occasionsPerWeek: round1(occasionsPerWeek), // how many times THIS person eats THIS recipe this week
        individualRules: (member.individualRules || []).map((r) => ({ type: r.type, note: r.note })),
      })),
  }));

  return { people, groceryBaseline, recipeIngredientTotals, weighAndPack, recipeEaters, familyRules: household.familyRules, refusals: [] };
}

module.exports = {
  BREAKFAST_OCCASION_SHARE, LUNCH_DINNER_OCCASION_SHARE,
  PROTEIN_PER_MEAL_CAP_G_PER_KG, MAX_SINGLE_MEAT_COMPONENT_G,
  PROTEIN_TOPUP_TRIGGER_G, GAP_FILL_TRIGGER_KCAL, CALORIE_CEILING_TOLERANCE,
  MIN_SCALE, MAX_SCALE,
  roundIngredientQty, scaleIngredients, scaleMacros, addMacros,
  memberPresence, calcAgeFromDob,
  fixOccasionCounts, assignOccasionsToPeople, lunchDinnerOccasionTarget, breakfastOccasionTarget,
  resolveMemberTarget, wholeRecipeScaleFactor, maxProteinMultiplier, engineerPersonWeek, recommendGapFillSnack,
  classifyCategory, buildGroceryBaseline, buildRecipeIngredientTotals,
  buildWeek, clamp,
};
