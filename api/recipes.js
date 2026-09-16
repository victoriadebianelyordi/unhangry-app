// GET only — the bundled recipe library. Adding a recipe is handled entirely
// client-side now (saved to localStorage), since Vercel's function filesystem
// is read-only in production and can't write a new file into /recipes.

const { loadAllRecipes } = require('../lib/recipes');
const { sendJSON } = require('../lib/http');

module.exports = async (req, res) => {
  return sendJSON(res, 200, loadAllRecipes());
};
