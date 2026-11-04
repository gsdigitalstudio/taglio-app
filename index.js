const { handle } = require('../lib/core');
module.exports = async (req, res) => {
  let a = req.method === 'POST' ? req.body : req.query;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = {}; } }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(await handle(a || {}));
};
