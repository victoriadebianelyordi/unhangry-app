const { loadEnv } = require('../lib/env');
loadEnv();
const claude = require('../lib/claude');
const { sendJSON } = require('../lib/http');

module.exports = async (req, res) => {
  return sendJSON(res, 200, { aiImportEnabled: claude.hasApiKey() });
};
