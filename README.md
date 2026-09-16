# Unhangry Assistant

The web app behind The Unhangry Society's weekly meal prep system.

## Running it locally

You need [Node.js](https://nodejs.org) installed (you already have it — v24). No other
install step, no dependencies.

From this folder, run:

```
node server.js
```

Then open **http://localhost:4173** in your browser.

To stop it, go back to the terminal and press `Ctrl + C`.

## Turning on AI recipe import (optional but recommended)

Importing a recipe from a photo, or from a URL that doesn't have built-in recipe data,
uses the Claude API to read and structure it. To enable that:

1. Get an API key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
2. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
3. Open `.env` and paste your key in place of `sk-REPLACE-ME`.
4. Restart the server (`Ctrl+C`, then `node server.js` again).

Without a key, the app still works — it just falls back to "fill this in manually"
for recipe photos and pages that don't publish their recipe data in a standard format.
Most recipe blogs do (WordPress recipe plugins almost always include it), so URL import
works for a lot of sites even with no key at all.

`.env` is in `.gitignore` — your key never gets committed if you put this folder under
version control later.

## Project layout

```
unhangry-assistant/
├── index.html            the whole app shell (all 3 screens)
├── css/styles.css        the brand system + all styling
├── js/app.js              all app logic — Database, Family Hub, and The List
├── server.js               local server: serves files, recipe/household APIs, recipe
│                              import, and weekly grocery-list generation
├── lib/
│   ├── env.js               tiny .env file reader
│   ├── claude.js             calls the Claude API for AI recipe extraction
│   └── html-recipe.js        pulls recipe data out of a fetched web page
├── .env.example            copy to .env and add your Anthropic API key
├── recipes/                 ← every recipe lives here as its own .json file
│   ├── README.md              how to add a recipe, field by field
│   ├── _template.json         copy this to start a new recipe by hand
│   ├── _photo-drafts/          photos saved here when imported with no AI key set
│   └── *.json                   the 20 starter recipes (15 mains + 4 breakfasts + 1 snack)
├── data/
│   ├── household.json        your household profile (members, rules, schedule, roles) —
│   │                            not committed to git; created the first time you save
│   └── saved-weeks/          each saved week as its own .json file — also not committed
└── assets/                  logo and other images
```

## Adding recipes

**The easy way — through the app:** click **+ Add a recipe** and paste text, drop a
recipe URL, or upload a photo. It parses the recipe, shows you a review screen to check
and fix anything, and saves it straight into `recipes/` when you hit **Save to database**.
No code, no manual file editing.

- **Paste text** and **URL import** work with or without an API key (URL import reads a
  page's built-in recipe data directly when the site provides it — no AI needed for that
  path).
- **Photo import** needs an API key to actually read the photo. Without one, the photo is
  saved to `recipes/_photo-drafts/` so nothing is lost, and you can transcribe it later.
- **Instagram links specifically** aren't supported yet (noted right in the URL tab) —
  paste the caption text instead for now.

**The manual way:** drop a new `.json` file into `recipes/`, following the format in
[`recipes/README.md`](recipes/README.md). Refresh the page — it shows up automatically.
This works because `server.js` reads every file in that folder each time the app asks
for the recipe list, so there's no separate "registry" file to keep in sync.

## What's built

- ✅ **The Database**: three sections — 🍽️ Lunch & Dinners, 🍳 Breakfasts, 🥨
  Snacks & Sides — with protein filter chips inside Lunch & Dinners, a recipe grid,
  click-through detail view (ingredients with buy-vs-make notes, macros, method steps,
  shelf-life and freezer flags), and a fully working **Add a recipe** flow — paste text,
  import from a URL, or import from a photo, each parsed and shown in an editable review
  screen before saving straight into the recipe database.
  - A **meal-fit guardrail** runs live in that review screen: if a recipe looks more like
    a snack/dip than a full meal (low protein, low calories, or no protein-tagged
    ingredient — like guacamole), it's flagged and defaulted to Snack/Side instead of
    Main, with the reasoning shown and a one-click override either way.
- ✅ **The Family Hub**: add/edit household members with a conditional profile form
  (children get a short form — name, DOB, allergies, dislikes; adults get goals, activity
  level, and more), a live daily-calorie estimate (Mifflin-St Jeor, or Katch-McArdle when
  lean mass is given) that's always editable if you already know the number,
  cycle-tracking and body-composition fields that only appear when they're actually
  relevant, family-wide vs. individual house rules, cook/breakfast day counts, and role
  assignment (planner/shopper/cook). Everything saves to `data/household.json` as you go.
- ✅ **The List**: pick one recipe per cooking method (air fryer/oven/stovetop — each
  method locks out its own picker so you can't double up), a friendly non-blocking nudge
  if two mains repeat the same protein, a breakfast pick, an optional Snacks & Sides
  add-on section, "this week's exceptions" (mark anyone away or home only part of the
  week — a one-off override that never touches their saved Family Hub profile), and
  buy-vs-make questions that appear automatically for any selected recipe that has them.
  Hitting **Generate The List** sends all of it to Claude, which scales real portions
  (not just "recipe feeds 6, buy for 6") against each person's targets, consolidates
  ingredients across recipes, and returns a categorized grocery list with shelf-life and
  freezer flags — plus **Copy for WhatsApp** and **Copy recipes for the cook**.
  - **Save this week**: after generating, name the week and jot how long the Sunday
    sprint took, what went well, what was hard — saved to `data/saved-weeks/`. A
    **Past Weeks** section (top of The List) lists everything you've saved; click one to
    reopen its full list and notes, or delete it.
  - **My Prep Plan**: a button on the grocery list output reveals three cards, styled
    like the Database's recipe cards with the same click-to-expand interaction —
    **The Prep Session** (a phase-grouped Sunday timeline the AI sequences from the
    actual steps of the actual recipes picked, running all 3 methods in parallel),
    **Weigh & Pack** (per-recipe, per-person gram portions — reusing the same scaling as
    the grocery list, with individual rules like "no fish" handled explicitly), and
    **The Calendar** (a day-by-day view per person; only members with a calorie target
    get numbers and gap-flags with a specific fix, everyone else just sees their meals).
    This is a separate, lazy API call — it only fires the first time you click the
    button, not bundled into Generate The List, so it costs nothing if you never open it.
    If you save the week after opening it, the prep plan is saved too and reappears when
    you reopen that saved week later.

## A note on the Claude model used

This app calls `claude-sonnet-5`, which has two quirks worth knowing if you ever touch
`lib/claude.js`:

- It **reasons with extended thinking on by default**. For our single-shot "return this
  exact JSON" calls that's counterproductive — the model spends its whole token budget on
  invisible reasoning and never gets to write the answer, which looks like the request
  just silently failing. Every call explicitly sends `thinking: { type: 'disabled' }` to
  prevent this.
- It **does not accept a `temperature` parameter at all** ("temperature is deprecated for
  this model" — a 400 error, not a warning). Don't try to add one for consistency;  it'll
  fail immediately.

Even with thinking disabled, response length varies run to run — the same exact input
occasionally takes a lot longer or runs a lot longer than usual. The grocery-list and
prep-plan calls use a generous `maxTokens` (10,000) and a 120-second timeout to absorb
that variance; if you ever see "cut off at the token limit" or "took too long," it's
almost always safe to just click the button again rather than treating it as broken.

## What's next

The core app is functionally complete end to end. From here it's mostly refinement:
trying it with your real weekly picks, tuning the grocery-list prompt if the scaling or
formatting needs adjusting, and deciding when you're ready to host it (see the note in
`.env.example` about adding your real API key for that).
