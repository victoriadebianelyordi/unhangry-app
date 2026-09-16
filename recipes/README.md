# How to add a recipe

You never need to touch any code to add a recipe. Just drop a new `.json` file into this
folder and it will appear in the app automatically the next time the page loads.

## Steps

1. Duplicate `_template.json` (in this same folder).
2. Rename the copy to match the recipe, e.g. `beef-burgers.json`. Use lowercase words
   separated by dashes, no spaces.
3. Fill in the fields — see the guide below.
4. Save it in this `recipes/` folder.
5. Refresh the app. Done.

## Field guide

- **id** — must match the filename (without `.json`). Lowercase, dashes only.
- **name** — the recipe name as shown to the user.
- **protein** — one of: `beef`, `chicken`, `seafood`, `veggie`. For `breakfast` and `snack`
  recipes this is mostly decorative (no protein filter is shown for those sections) — pick
  whichever fits closest.
- **method** — one of: `air-fryer`, `oven`, `stovetop`, `no-cook` (fridge/overnight prep —
  no active cooking, e.g. overnight oats, chia parfait). The weekly 3-method rule (one of
  each: air fryer/oven/stovetop) only applies to `mealType: "main"` recipes.
- **mealType** — which section of The Database this belongs to, and how it's used:
  - `main` — a full lunch/dinner. This is what gets offered when picking the week's 3
    mains (one per cooking method).
  - `breakfast` — a breakfast jar/dish. Shown in its own Breakfasts section.
  - `snack` — a side, dip, or light bite that isn't a full meal on its own (guacamole,
    hummus-only, etc). Shown in its own Snacks & Sides section, never offered as a main.

  Default to `main` if you're not sure.
- **feeds** — the base number of people this recipe is written for. This is a ratio, not
  a fixed output — the app scales it up or down per household.
- **macrosPerServing** — kcal, protein, carbs, fat for ONE base serving (feeds ratio).
- **ingredients** — a list. Each ingredient needs:
  - `name`
  - `qty` (number) and `unit` (e.g. "g", "kg", "cup", "tbsp", "pc")
  - `component` — one of:
    - `protein` — scales freely per person to hit their targets
    - `carb` — scales freely per person to hit their targets
    - `sauce` — scales with the whole dish, not per-person (sauce-locked)
    - `aromatic` — scales with the whole dish (onions, garlic, spices — not per-person)
    - `other` — anything else (garnish, bread, sides)
  - `buyVsMake` (optional) — if this ingredient has a "buy ready" vs "make from scratch"
    option, fill in both `buy` and `make` strings. Leave this field out entirely if there's
    no such choice for this ingredient.
- **steps** — a numbered list of plain-English instructions.
- **notes** — any extra notes (freezer tips, technique notes, Mirna/Vic quotes). Optional list.
- **flags**:
  - `shelfLife` — a short warning string if this doesn't keep the full week (e.g. seafood,
    fresh bread), or `null` if it's fine for the week.
  - `freezeFriendly` — `true` or `false`.

That's the whole format. Keep it simple — if you're not sure about a field, look at how
the existing recipes use it.

## Recipes added through the app

When you use "Add a recipe" in the app (paste text, a URL, or a photo), it parses the
recipe, shows you a review screen to fix anything, and — once you hit **Save to
database** — writes a proper `.json` file into this folder itself. No manual file
creation needed for those.

- Recipes imported from a URL get an extra `sourceUrl` field (just for reference/credit
  — not required if you're writing a recipe by hand).
- If a photo is uploaded while no AI key is configured (see the project's `.env.example`),
  the photo itself is saved to `_photo-drafts/` (a `_`-prefixed folder, so the app ignores
  it as a recipe file) so it isn't lost — you can transcribe it into a real recipe file
  whenever you get to it.
