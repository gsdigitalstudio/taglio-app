const { update } = require('../lib/core');
module.exports = async (req, res) => {
  const s = process.env.CRON_SECRET || process.env.APP_KEY;
  if (!s || req.headers.authorization !== 'Bearer ' + s) return res.status(401).json({ error: 'non autorizzato' });
  await update();
  res.status(200).json({ ok: 1 });
};
