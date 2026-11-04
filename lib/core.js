// TAGLIO – motore per Vercel. Variabili d'ambiente: APP_KEY, CRON_SECRET, GEMINI_API_KEY (+ database Upstash collegato da Vercel).
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; Taglio personal reader)' };
const DEF = { categories: [
  { id: 'pol', name: 'Politica italiana', feeds: [
    { name: 'ANSA', url: 'https://www.ansa.it/sito/notizie/politica/politica_rss.xml' },
    { name: 'Il Post', url: 'https://www.ilpost.it/italia/feed/' },
    { name: 'Il Fatto Quotidiano', url: 'https://www.ilfattoquotidiano.it/feed/' }] },
  { id: 'est', name: 'Esteri', feeds: [
    { name: 'ANSA', url: 'https://www.ansa.it/sito/notizie/mondo/mondo_rss.xml' },
    { name: 'Il Post', url: 'https://www.ilpost.it/mondo/feed/' },
    { name: 'Il Sole 24 Ore', url: 'https://www.ilsole24ore.com/rss/mondo.xml' }] },
  { id: 'eco', name: 'Economia', feeds: [
    { name: 'ANSA', url: 'https://www.ansa.it/sito/notizie/economia/economia_rss.xml' },
    { name: 'Il Sole 24 Ore', url: 'https://www.ilsole24ore.com/rss/economia.xml' }] },
  { id: 'ita', name: "Come funziona l'Italia", feeds: [
    { name: 'Il Post', url: 'https://www.ilpost.it/feed' },
    { name: 'ANSA', url: 'https://www.ansa.it/sito/notizie/topnews/topnews_rss.xml' }] }
] };

// ---- Database (Upstash Redis via REST) ----
const R = async cmd => {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) throw new Error('Database non collegato: in Vercel, Storage, collega Upstash Redis al progetto');
  const j = await (await fetch(u, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: JSON.stringify(cmd) })).json();
  if (j.error) throw new Error(j.error);
  return j.result;
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const cfg = async () => { const c = await R(['GET', 'cfg']); return c ? JSON.parse(c) : DEF; };
const load = async d => { const v = await R(['GET', 'day:' + d]); return v ? JSON.parse(v) : null; };
const dayNames = async () => ((await R(['SMEMBERS', 'days'])) || []).sort().reverse().slice(0, 30);
const days = async () => Promise.all((await dayNames()).map(async d => {
  const o = (await load(d)) || {};
  return { data: d, tema: (o.categorie || []).map(c => (c.storie || [])[0] && c.storie[0].titolo).filter(Boolean).slice(0, 3).join(' · ') };
}));
async function search(q) {
  const r = [];
  if (q.length < 2) return r;
  for (const d of await dayNames()) for (const c of ((await load(d)) || {}).categorie || []) for (const s of c.storie || [])
    if ((s.titolo + ' ' + s.in_breve + ' ' + (s.punti || []).join(' ')).toLowerCase().includes(q) && r.length < 40)
      r.push({ data: d, cat: c.id, categoria: c.nome, titolo: s.titolo, in_breve: s.in_breve });
  return r;
}

// ---- Feed e articoli ----
const strip = s => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const tag = (s, n) => { const m = new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>', 'i').exec(s); return m ? m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '') : ''; };
async function readFeed(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const x = await r.text(), lim = Date.now() - 36 * 36e5, res = [];
  for (const b of x.split(/<(?:item|entry)[\s>]/i).slice(1)) {
    const link = strip(tag(b, 'link')) || (/<link[^>]+href=["']([^"']+)/i.exec(b) || [])[1] || '';
    const d = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded');
    const im = /<(?:media:content|media:thumbnail|enclosure)[^>]+url=["']([^"']+)/i.exec(b) || /<img[^>]+src=["']([^"']+)/i.exec(d);
    const t = Date.parse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'));
    if (t && t < lim) continue;
    res.push({ titolo: strip(tag(b, 'title')), link: link.trim(), testo: strip(d).slice(0, 400), img: im ? im[1] : '' });
  }
  return res;
}
async function article(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return '';
    const h = (await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    return (h.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map(strip).filter(p => p.length > 40).join('\n');
  } catch (e) { return ''; }
}
async function testFeed(url) {
  try {
    const it = await readFeed(url);
    if (!it.length) return { url, stato: 'errore', msg: 'feed vuoto' };
    return { url, stato: (await article(it[0].link)).length > 1500 ? 'completo' : 'anteprima', n: it.length };
  } catch (e) { return { url, stato: 'errore', msg: String(e).slice(0, 80) }; }
}

// ---- Gemini ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gem(p) {
  const models = [process.env.GEMINI_MODEL || 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'].filter((m, i, a) => a.indexOf(m) === i);
  let err = new Error('Gemini non risponde');
  for (const m of models) for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } })
      });
      const j = await r.json();
      if (j.candidates) return JSON.parse(j.candidates[0].content.parts[0].text);
      err = new Error('Gemini (' + m + '): ' + JSON.stringify(j.error || j).slice(0, 200));
      const c = j.error && j.error.code;
      if (![429, 500, 503, 504].includes(c)) break; // errore non temporaneo: passa al modello di riserva
    } catch (e) { err = e; }
    await sleep(3000 * (k + 1));
  }
  throw err;
}
const P_GROUP = 'Raggruppa questi articoli di quotidiani italiani per fatto raccontato. Ordina i gruppi per importanza: prima quelli coperti da più testate. Al massimo 7 gruppi, ognuno con al massimo 4 numeri. Ignora sport, gossip e oroscopi. Rispondi in JSON: {"storie":[{"ids":[0,1]}]}. Articoli (numero|testata|titolo|sommario):\n';
const P_SUM = 'Sei il redattore di una rassegna stampa. Ricevi gruppi di articoli sullo stesso fatto: numero, testata, titolo, testo (FONTE: completo = testo dell\'articolo, anteprima = solo titolo e sommario). Scrivi in italiano semplice, frasi brevi, una idea per frase; spiega i termini tecnici tra parentesi. Usa SOLO le informazioni fornite: se un dato manca, non scriverlo e non inventare. Per ogni gruppo: titolo (max 10 parole); in_breve (3-5 frasi, sintesi unica di tutte le fonti); punti (max 4 frasi brevi); testate: per ogni numero un sunto di 2-4 frasi di cosa sostiene QUELL\'articolo e con quale taglio (se FONTE è anteprima, basati solo su titolo e sommario ed essere più breve; se tutte le testate dicono lo stesso, scrivilo senza ripetere). In in_breve e punti racchiudi tra **doppi asterischi** 2-3 parole chiave per frase (nomi, cifre, luoghi, decisioni). Aggiungi in_30_secondi: 3 righe con l\'essenziale della categoria. JSON esatto: {"in_30_secondi":["","",""],"storie":[{"gruppo":0,"titolo":"","in_breve":"","punti":[""],"testate":[{"id":0,"sunto":""}]}]}\n\n';

async function buildCat(cat) {
  const items = [];
  await Promise.all(cat.feeds.map(async f => { try { (await readFeed(f.url)).slice(0, 15).forEach(i => { i.testata = f.name; items.push(i); }); } catch (e) {} }));
  if (!items.length) throw new Error('nessun articolo dai feed');
  const g = await gem(P_GROUP + items.map((i, n) => n + '|' + i.testata + '|' + i.titolo + '|' + i.testo.slice(0, 120)).join('\n'));
  const groups = (g.storie || []).map(s => (s.ids || []).filter(n => items[n]).slice(0, 4)).filter(a => a.length).slice(0, 7);
  const ids = [].concat(...groups), full = {}, body = {};
  const texts = await Promise.all(ids.map(n => article(items[n].link)));
  ids.forEach((n, k) => { full[n] = texts[k].length > 1500; body[n] = full[n] ? texts[k].slice(0, 4500) : items[n].testo; });
  const s = await gem(P_SUM + groups.map((a, k) => 'GRUPPO ' + k + '\n' + a.map(n =>
    n + ' | ' + items[n].testata + ' | ' + items[n].titolo + ' | FONTE: ' + (full[n] ? 'completo' : 'anteprima') + '\n' + body[n]).join('\n---\n')).join('\n\n'));
  return { id: cat.id, nome: cat.name, in_30_secondi: s.in_30_secondi || [], storie: (s.storie || []).map(st => ({
    titolo: st.titolo, in_breve: st.in_breve, punti: st.punti || [],
    testate: (st.testate || []).filter(t => items[t.id]).map(t => ({ nome: items[t.id].testata, url: items[t.id].link, img: items[t.id].img,
      fonte: full[t.id] ? 'completo' : 'anteprima', sunto: t.sunto }))
  })) };
}
async function update() {
  const day = today(), t0 = Date.now();
  const old = (await load(day)) || { data: day, categorie: [] };
  const res = { data: day, categorie: [] };
  const persist = async () => {
    const rest = old.categorie.filter(o => !res.categorie.some(x => x.id === o.id));
    await R(['SET', 'day:' + day, JSON.stringify({ data: day, categorie: res.categorie.concat(rest) })]);
    await R(['SADD', 'days', day]);
  };
  for (const c of (await cfg()).categories) {
    const prev = old.categorie.find(x => x.id === c.id), ok = prev && !prev.errore && (prev.storie || []).length;
    if (ok) { res.categorie.push(prev); continue; } // già pronta: non la rifaccio
    if (Date.now() - t0 > 200000) { res.categorie.push(prev || { id: c.id, nome: c.name, storie: [], errore: 'Tempo scaduto: premi di nuovo Rigenera ora' }); continue; }
    try { res.categorie.push(await buildCat(c)); }
    catch (e) { res.categorie.push(prev || { id: c.id, nome: c.name, storie: [], errore: String(e.message || e).slice(0, 160) }); }
    await persist();
  }
  await persist();
}

async function handle(a) {
  if (!process.env.APP_KEY || a.key !== process.env.APP_KEY) return { error: 'Chiave non valida' };
  try {
    switch (a.action) {
      case 'config': return await cfg();
      case 'save': await R(['SET', 'cfg', JSON.stringify(a.config)]); return { ok: 1 };
      case 'digest': return (await load(a.date || today())) || { vuoto: 1 };
      case 'days': return await days();
      case 'search': return await search(String(a.q || '').toLowerCase());
      case 'test': return await Promise.all((a.urls || []).map(testFeed));
      case 'refresh': await update(); return { ok: 1 };
    }
    return { error: 'Azione sconosciuta' };
  } catch (e) { return { error: String(e.message || e) }; }
}
module.exports = { handle, update, gem };
