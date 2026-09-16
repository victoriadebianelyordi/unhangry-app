# UNHANGRY APP — COMBINED UPDATE (matches your actual recipe schema)
# Paste this whole thing into Claude Code

---

## OVERVIEW

Four changes in one:
1. Add 40 snack files (they use your existing recipe schema, mealType "snack")
2. Add an "AI Advice" section that fills each person's macro gaps with snacks, in the correct order
3. Scope: keep only AI Advice + Weigh & Pack. Remove the 3-hour Prep Session and the Calendar grid (deferred to a later upgrade, taught in the course for now)
4. Confirm the add-a-recipe lightness rule routes light recipes to snacks (your schema already supports this via mealType "snack")

---

## 1. THE SNACK FILES

I'm adding 40 snack .json files. They use your EXISTING recipe schema exactly — same fields as any recipe: id, name, protein, method ("no-cook"), mealType ("snack"), feeds, macrosPerServing, ingredients (component-tagged), steps, notes, flags.

They drop straight into the same folder your recipes and breakfasts live in. The app already reads mealType "snack" and shows them in the Snacks & Sides section — so no loading changes needed. They just work.

One field is added beyond your schema: **primaryMacro** ("protein", "carb", or "fat"). This is what the AI Advice engine uses to match a snack to a person's macro gap. It's harmless to the rest of the app — just extra metadata.

---

## 2. THE "AI ADVICE" SECTION — exact sequencing

A short snack-recommendation block. The ORDER of operations is critical and must be exactly this:

Step 1 — Scale the 3 selected main recipes per person to their individual targets (existing logic).
Step 2 — Generate the consolidated grocery list (existing logic).
Step 3 — Recalculate each person's TOTAL actual weekly intake from the scaled mains + breakfast — their real kcal and macros, day by day.
Step 4 — Compare real intake vs each person's daily target. Find the gaps (which days fall short, in which macro).
Step 5 — ONLY THEN recommend snacks to fill the gaps. For each gap, pick the snack whose primaryMacro matches the missing macro, and nudge its portion to fill the gap size. Pull ONLY from the snack files (mealType "snack") — never invent snacks.

Rules:
- Only run AI Advice for fitness-goal members (Lose Weight, Gain Muscle, Maintain). Skip convenience-goal members (Save Time, Save Money, Feed My Family, Eat Cleaner).
- Short and practical — a few lines per person, light tone, never preachy.
- If a recommended snack adds a grocery item (nuts, yogurt, dates), include it in the WhatsApp copy so the shopper grabs it.

Reference output:
```
AI ADVICE — week summary

Firas (gain muscle): meals run ~200 kcal short on Mon & Wed, mostly protein.
  → Add a protein shake with milk on those 2 days.

Vic (maintain): on target all week. Nothing to add.

Sofia (maintain): Thursday's veggie day runs low on protein.
  → Add Greek yogurt or a handful of almonds.
```

---

## 3. OUTPUT PAGE LAYOUT + SCOPE CHANGE

Output page after "Generate The List", top to bottom:
1. The grocery list (categorized, consolidated — unchanged)
2. AI Advice (the snack block above, directly below the list)
3. Copy to WhatsApp button — copies BOTH the grocery list AND the AI Advice
4. Weigh & Pack (unchanged — per-recipe, each person's portion in grams, individual rules carried through)

REMOVE, if present: the 3-hour Prep Session schedule and the Calendar weekly grid. Strip related buttons, AI-call structure, and UI. We are not shipping those now.

Optimize the AI call for cost — one structured call if cheapest, split if cheaper. Never one call per section.

---

## 4. ADD-A-RECIPE LIGHTNESS RULE (confirm it works)

Your schema already supports this: when a user adds a recipe too light to be a main (low kcal AND low protein — the guacamole case), it should be saved as mealType "snack" instead of "main", landing in Snacks & Sides and becoming available to AI Advice. Confirm the add-a-recipe flow offers this and tags primaryMacro on save (infer it from the dominant macro). If it already does this, leave it.

---

## BUILD ORDER

1. Drop in the 40 snack files (no loading changes — schema already supported).
2. Implement AI Advice sequencing (steps 1-5) in the AI call's structured output, reading snacks by mealType "snack" and primaryMacro.
3. Update output layout: grocery list → AI Advice → Copy to WhatsApp (both) → Weigh & Pack.
4. Remove Prep Session and Calendar code.
5. Confirm the add-a-recipe lightness routing + primaryMacro tagging.

Show me the AI Advice output working with real data (correct sequencing, real gaps, sensible snack picks from the files) BEFORE polishing visuals. Explain each step in plain language.
