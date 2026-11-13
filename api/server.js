// API Mastu : tokens côté serveur, données Twitch + YouTube, panneau admin, stockage persistant
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, YOUTUBE_API_KEY,
  CHROME_EXTENSION_IDS = '', CACHE_TTL_SECONDS = '60', LIVE_TTL_SECONDS = '15',
  ADMIN_TOKEN,
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, // stockage persistant (recommandé)
  DATA_DIR,                                          // ou dossier d'un Disque Render
  PORT = 3000,
} = process.env;

const TTL = Number(CACHE_TTL_SECONDS) * 1000;        // rediffusions Twitch
const LIVE_TTL = Number(LIVE_TTL_SECONDS) * 1000;    // état du live : très court pour être quasi instantané
const YT_TTL = Math.max(TTL, 5 * 60 * 1000);         // protège le quota YouTube (10 000 unités/jour)
const ALLOWED = CHROME_EXTENSION_IDS.split(',').map(s => s.trim()).filter(Boolean);
const WEB_ORIGINS = (process.env.WEB_ORIGINS || 'https://leptitpiou.github.io').split(',').map(s => s.trim()).filter(Boolean);

const TWITCH_LOGIN = 'mastu';
// Chaînes YouTube : variable Render YOUTUBE_CHANNELS (séparées par des virgules : @handle ou ID UC...)
const YT_CHANNELS = (process.env.YOUTUBE_CHANNELS || '@Mastu,UCLnv0iKl-QbLnkuF-aSZKTQ,UCW2JcUbafBUzIYP6X1-3YJQ')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => /^UC[\w-]{20,}$/.test(s) ? { id: s } : { handle: s.startsWith('@') ? s : '@' + s });

// ---------- cache ----------
const cache = new Map(), inflight = new Map();
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return c.v;
  if (inflight.has(key)) return inflight.get(key);
  const p = fn()
    .then(v => { cache.set(key, { t: Date.now(), v }); return v; })
    .catch(e => { if (c) return c.v; throw e; }) // en cas d'erreur : dernière valeur connue
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- stockage persistant : annonces, reset des notifications, invités du live ----------
const KEY = 'mastu:state';
const FILE = path.join(DATA_DIR || __dirname, 'state.json');
const PERSISTENT = !!(UPSTASH_REDIS_REST_URL || DATA_DIR);
const store = { announcements: [], notifResetAt: 0, collab: null };
let loaded = false;

async function upstash(cmd) {
  const r = await fetch(UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Upstash : ' + (j.error || r.status));
  return j.result;
}
async function loadStore() {
  let raw = null;
  if (UPSTASH_REDIS_REST_URL) raw = await upstash(['GET', KEY]);
  else { try { raw = fs.readFileSync(FILE, 'utf8'); } catch (_) {} }
  if (raw) Object.assign(store, JSON.parse(raw));
  loaded = true;
}
async function saveStore() {
  const raw = JSON.stringify(store);
  if (UPSTASH_REDIS_REST_URL) await upstash(['SET', KEY, raw]);
  else { try { fs.writeFileSync(FILE, raw); } catch (e) { console.error(e.message); } }
}
const ensureLoaded = async () => { if (!loaded) await loadStore(); };
// modifie le stockage ; si l'enregistrement échoue, on revient en arrière
async function mutate(fn) {
  await ensureLoaded();
  const snap = JSON.stringify(store);
  try { const out = fn(); await saveStore(); return out; }
  catch (e) { Object.assign(store, JSON.parse(snap)); throw e; }
}
loadStore().catch(e => console.error('Stockage :', e.message));

// ---------- Twitch ----------
let twTok = { token: null, exp: 0 };
async function twitchToken() {
  if (twTok.token && Date.now() < twTok.exp) return twTok.token;
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Twitch token: ' + JSON.stringify(j));
  twTok = { token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return twTok.token;
}
async function helix(p) {
  const r = await fetch('https://api.twitch.tv/helix' + p, {
    headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: 'Bearer ' + await twitchToken() },
  });
  if (!r.ok) throw new Error(`Helix ${p} -> ${r.status}`);
  return r.json();
}
const twitchUser = () => cached('tw:user', 10 * 60 * 1000, async () => {
  const u = (await helix('/users?login=' + TWITCH_LOGIN)).data[0];
  if (!u) throw new Error('Chaîne Twitch introuvable : ' + TWITCH_LOGIN);
  return u;
});
const usersByLogin = async logins => logins.length
  ? (await helix('/users?' + logins.map(l => 'login=' + encodeURIComponent(l)).join('&'))).data : [];

// Nombre de followers d'un invité : l'API officielle ne le donne pas sans autorisation de la chaîne,
// on passe donc par des services publics (decapi.me, puis ivr.fi). Sans réponse : null.
async function followersOf(login) {
  const key = 'fol:' + login;
  const v = await cached(key, 10 * 60 * 1000, async () => {
    try {
      const r = await fetch('https://decapi.me/twitch/followcount/' + encodeURIComponent(login), { signal: AbortSignal.timeout(3000) });
      const t = (await r.text()).trim();
      if (r.ok && /^[\d.,\s]+$/.test(t)) return Number(t.replace(/\D/g, ''));
    } catch (_) {}
    try {
      const r = await fetch('https://api.ivr.fi/v2/twitch/user?login=' + encodeURIComponent(login), { signal: AbortSignal.timeout(3000) });
      const f = (await r.json())?.[0]?.followers;
      if (r.ok && Number.isFinite(f)) return f;
    } catch (_) {}
    return null;
  }).catch(() => null);
  if (v == null) cache.delete(key); // on réessaie au prochain passage
  return v;
}

// Invités du live : ceux saisis dans le panneau, sinon ceux du chat partagé. Triés par followers décroissants.
async function guestsFor(streamId, ownerId) {
  let users = [];
  const manual = store.collab && store.collab.streamId === streamId ? store.collab.logins : [];
  if (manual.length) {
    users = (await usersByLogin(manual)).sort((a, b) => manual.indexOf(a.login) - manual.indexOf(b.login));
  } else {
    try {
      const sc = await helix('/shared_chat/session?broadcaster_id=' + ownerId);
      const ids = (sc.data[0]?.participants || []).map(p => p.broadcaster_id).filter(id => id !== ownerId);
      if (ids.length) users = (await helix('/users?' + ids.map(i => 'id=' + i).join('&'))).data;
    } catch (_) { /* pas de chat partagé */ }
  }
  const list = await Promise.all(users.map(async u => ({
    name: u.display_name, handle: u.login, logo: u.profile_image_url,
    url: 'https://www.twitch.tv/' + u.login, followers: await followersOf(u.login),
  })));
  return list.sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1));
}

async function getTwitch() {
  const u = await twitchUser();
  const none = { data: [] };
  let streamsOk = true;
  const [streams, vods] = await Promise.all([
    helix('/streams?user_id=' + u.id).catch(e => { streamsOk = false; console.error(e.message); return none; }),
    cached('tw:vod', TTL, () => helix(`/videos?user_id=${u.id}&type=archive&first=1`)).catch(e => { console.error(e.message); return none; }),
  ]);
  const s = streams.data[0];
  // les invités ne valent que pour le live en cours
  if (streamsOk && store.collab && (!s || store.collab.streamId !== s.id)) {
    mutate(() => { store.collab = null; }).catch(e => console.error(e.message));
  }
  let live = null;
  if (s) {
    live = {
      id: s.id, title: s.title, game: s.game_name, viewers: s.viewer_count, startedAt: s.started_at,
      thumbnail: (s.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360'),
      url: 'https://www.twitch.tv/' + u.login,
      guests: await guestsFor(s.id, u.id).catch(e => { console.error(e.message); return []; }),
    };
  }
  const v = vods.data[0];
  return {
    platform: 'twitch', id: 'twitch:' + u.id, name: u.display_name, handle: u.login, logo: u.profile_image_url,
    banner: u.offline_image_url || '', description: u.description, subscribers: null,
    url: 'https://www.twitch.tv/' + u.login, live,
    lastVod: v ? {
      id: v.id, title: v.title, url: v.url, views: v.view_count, publishedAt: v.published_at,
      thumbnail: (v.thumbnail_url || '').replace('%{width}', '640').replace('%{height}', '360'),
    } : null,
  };
}
const getTwitchCached = () => cached('tw', LIVE_TTL, getTwitch);

// ---------- YouTube ----------
async function yt(p) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${p}&key=${YOUTUBE_API_KEY}`);
  if (!r.ok) throw new Error(`YouTube ${p.split('?')[0]} -> ${r.status}`);
  return r.json();
}
const ytChannel = c => cached('ytc:' + (c.handle || c.id), 30 * 60 * 1000, async () => {
  const q = c.id ? 'id=' + c.id : 'forHandle=' + encodeURIComponent(c.handle);
  const i = (await yt(`channels?part=snippet,statistics,brandingSettings,contentDetails&${q}`)).items?.[0];
  if (!i) throw new Error('Chaîne YouTube introuvable : ' + (c.handle || c.id));
  const banner = i.brandingSettings?.image?.bannerExternalUrl;
  return {
    platform: 'youtube', id: i.id, name: i.snippet.title, handle: i.snippet.customUrl || '',
    logo: (i.snippet.thumbnails.high || i.snippet.thumbnails.default).url,
    banner: banner ? banner + '=w1060' : '', description: i.snippet.description,
    subscribers: i.statistics.hiddenSubscriberCount ? null : Number(i.statistics.subscriberCount),
    url: 'https://www.youtube.com/' + (i.snippet.customUrl || 'channel/' + i.id),
    uploads: i.contentDetails.relatedPlaylists.uploads,
  };
});
const ytLatest = ch => cached('ytv:' + ch.id, YT_TTL, async () => {
  const p = await yt(`playlistItems?part=contentDetails&maxResults=1&playlistId=${ch.uploads}`);
  const id = p.items?.[0]?.contentDetails.videoId;
  if (!id) return null;
  const x = (await yt(`videos?part=snippet,statistics&id=${id}`)).items[0];
  const t = x.snippet.thumbnails;
  return {
    id, title: x.snippet.title, thumbnail: (t.maxres || t.high || t.default).url,
    views: Number(x.statistics.viewCount), publishedAt: x.snippet.publishedAt, url: 'https://www.youtube.com/watch?v=' + id,
  };
});
async function getYoutube(c) {
  const { uploads, ...ch } = await ytChannel(c);
  const latest = await ytLatest({ id: ch.id, uploads }).catch(() => null);
  return { ...ch, latest };
}

// ---------- assemblage ----------
async function buildData() {
  const res = await Promise.allSettled([getTwitchCached(), ...YT_CHANNELS.map(getYoutube)]);
  res.filter(r => r.status === 'rejected').forEach(r => console.error(r.reason.message));
  const channels = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!channels.length) throw new Error('Aucune donnée');
  return { updatedAt: new Date().toISOString(), channels };
}

// ---------- authentification admin ----------
const fails = new Map();
function auth(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "ADMIN_TOKEN n'est pas défini sur Render." });
  const ip = req.ip, f = fails.get(ip);
  if (f && Date.now() - f.t > 15 * 60 * 1000) fails.delete(ip);
  if ((fails.get(ip)?.n || 0) >= 10) return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
  const real = Buffer.from(ADMIN_TOKEN);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    fails.set(ip, { n: (fails.get(ip)?.n || 0) + 1, t: Date.now() });
    return res.status(401).json({ error: 'Token incorrect.' });
  }
  fails.delete(ip);
  next();
}

// ---------- serveur ----------
const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && (ALLOWED.some(id => o === 'chrome-extension://' + id) || WEB_ORIGINS.includes(o))) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', Vary: 'Origin' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_q, r) => r.send('ok'));

app.get('/api/data', async (_q, res) => {
  try {
    await ensureLoaded().catch(() => {});
    const base = await buildData();
    res.set('Cache-Control', 'no-store').json({
      ...base, announcement: store.announcements[0] || null, notifResetAt: store.notifResetAt,
    });
  } catch (e) { console.error(e.message); res.status(502).json({ error: 'upstream' }); }
});

// ---------- site admin : https://TON-SERVICE.onrender.com/admin ----------
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.get('/', (_q, r) => r.redirect('/admin'));

const storageError = (res, e) => { console.error(e.message); res.status(503).json({ error: 'Stockage indisponible, réessaie.' }); };

app.get('/api/admin/state', auth, async (_q, res) => {
  await ensureLoaded().catch(() => {});
  const tw = await getTwitchCached().catch(() => null);
  res.json({
    announcements: store.announcements, notifResetAt: store.notifResetAt, persistent: PERSISTENT,
    live: tw?.live ? { id: tw.live.id, title: tw.live.title, viewers: tw.live.viewers } : null,
    guests: tw?.live?.guests || [],
    collabActive: !!(store.collab && tw?.live && store.collab.streamId === tw.live.id),
  });
});

app.post('/api/announcement', auth, express.json({ limit: '20kb' }), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  const link = String(req.body?.link || '').trim();
  if (!text) return res.status(400).json({ error: "Le texte de l'annonce est vide." });
  if (text.length > 500) return res.status(400).json({ error: 'Texte trop long (500 caractères maximum).' });
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'Le lien doit commencer par http:// ou https://.' });
  const a = { id: String(Date.now()), text, link, date: new Date().toISOString() };
  try { await mutate(() => { store.announcements = [a, ...store.announcements].slice(0, 50); }); res.json(a); }
  catch (e) { storageError(res, e); }
});

app.delete('/api/announcement/:id', auth, async (req, res) => {
  try {
    await ensureLoaded();
    if (!store.announcements.some(a => a.id === req.params.id)) return res.status(404).json({ error: 'Annonce introuvable.' });
    await mutate(() => { store.announcements = store.announcements.filter(a => a.id !== req.params.id); });
    res.json({ ok: true });
  } catch (e) { storageError(res, e); }
});

// Efface les notifications de tous les fans (chaque extension / site l'applique à sa prochaine actualisation)
app.post('/api/admin/reset-notifications', auth, async (_q, res) => {
  try { await mutate(() => { store.notifResetAt = Date.now(); }); res.json({ notifResetAt: store.notifResetAt }); }
  catch (e) { storageError(res, e); }
});

// Invités du live (uniquement pendant un live)
const parseLogin = s => {
  s = String(s).trim();
  const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{1,25})/i) || s.match(/^@?([A-Za-z0-9_]{3,25})$/);
  return m ? m[1].toLowerCase() : null;
};
app.post('/api/admin/collab', auth, express.json({ limit: '20kb' }), async (req, res) => {
  try {
    const tw = await getTwitchCached().catch(() => null);
    if (!tw?.live) return res.status(409).json({ error: "Mastu n'est pas en live : les invités ne se définissent que pendant un live." });
    const raw = Array.isArray(req.body?.links) ? req.body.links : String(req.body?.links || '').split(/[\s,]+/);
    const logins = [...new Set(raw.map(parseLogin).filter(Boolean))].filter(l => l !== TWITCH_LOGIN).slice(0, 8);
    if (!logins.length) return res.status(400).json({ error: 'Aucun lien de chaîne Twitch valide.' });
    const found = (await usersByLogin(logins)).map(x => x.login);
    const missing = logins.filter(l => !found.includes(l));
    if (missing.length) return res.status(400).json({ error: 'Chaîne(s) Twitch introuvable(s) : ' + missing.join(', ') });
    await mutate(() => { store.collab = { streamId: tw.live.id, logins }; });
    cache.delete('tw');
    const fresh = await getTwitchCached();
    res.json({ guests: fresh.live?.guests || [] });
  } catch (e) { storageError(res, e); }
});
app.delete('/api/admin/collab', auth, async (_q, res) => {
  try { await mutate(() => { store.collab = null; }); cache.delete('tw'); res.json({ ok: true }); }
  catch (e) { storageError(res, e); }
});

app.listen(PORT, () => console.log('Mastu API sur le port ' + PORT));