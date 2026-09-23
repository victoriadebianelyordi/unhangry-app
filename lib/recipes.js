// Reads the bundled recipe library from /recipes. Read-only — safe to call
// from a Vercel serverless function, since the folder ships with the deployment.

const fs = require('fs');
const path = require('path');

const RECIPES_DIR = path.join(__dirname, '..', 'recipes');

// Component recipes store ingredients/steps per component; everything downstream (engine,
// grocery list, buy-vs-make) reads the flat lists, so derive them here with each ingredient
// tagged by the component it came from.
function withFlatLists(recipe) {
  if (!Array.isArray(recipe.components)) return recipe;
  return {
    ...recipe,
    ingredients: recipe.components.flatMap((c) => (c.ingredients || []).map((i) => ({ ...i, componentId: c.id }))),
    steps: recipe.components.flatMap((c) => c.steps || []),
  };
}

function loadAllRecipes() {
  const files = fs.readdirSync(RECIPES_DIR).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  );
  const recipes = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8');
      recipes.push(withFlatLists(JSON.parse(raw)));
    } catch (err) {
      console.error(`Skipping ${file} — invalid JSON: ${err.message}`);
    }
  }
  return recipes;
}

module.exports = { loadAllRecipes };
