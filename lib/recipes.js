// Reads the bundled recipe library from /recipes. Read-only — safe to call
// from a Vercel serverless function, since the folder ships with the deployment.

const fs = require('fs');
const path = require('path');

const RECIPES_DIR = path.join(__dirname, '..', 'recipes');

function loadAllRecipes() {
  const files = fs.readdirSync(RECIPES_DIR).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  );
  const recipes = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8');
      recipes.push(JSON.parse(raw));
    } catch (err) {
      console.error(`Skipping ${file} — invalid JSON: ${err.message}`);
    }
  }
  return recipes;
}

module.exports = { loadAllRecipes };
