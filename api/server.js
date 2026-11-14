// API Mastu : tokens côté serveur, données Twitch + YouTube, panneau admin, stockage persistant
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');

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

// Comptes : voir accounts.js
let ACCOUNTS = [];
try { ACCOUNTS = require('./accounts.js'); } catch (e) { console.error('accounts.js :', e.message); }
const MAIN_LOGIN = String((ACCOUNTS.find(a => a.platform === 'twitch' && a.main) || ACCOUNTS.find(a => a.platform === 'twitch') || { login: 'mastu' }).login).toLowerCase();
const { INSTAGRAM_ACCESS_TOKEN, SELF_URL = process.env.RENDER_EXTERNAL_URL } = process.env;
const socialId = a => a.platform + ':' + String(a.username).replace(/^@/, '').toLowerCase();

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
const store = { announcements: [], notifResetAt: 0, collab: null, broadcasts: [], posts: {}, igToken: null, igTokenAt: 0 };
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
const twitchUser = login => cached('tw:user:' + login, 10 * 60 * 1000, async () => {
  const u = (await helix('/users?login=' + login)).data[0];
  if (!u) throw new Error('Chaîne Twitch introuvable : ' + login);
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

async function getTwitch(login = MAIN_LOGIN, main = true) {
  const u = await twitchUser(login);
  const none = { data: [] };
  let streamsOk = true;
  const [streams, vods] = await Promise.all([
    helix('/streams?user_id=' + u.id).catch(e => { streamsOk = false; console.error(e.message); return none; }),
    cached('tw:vod:' + login, TTL, () => helix(`/videos?user_id=${u.id}&type=archive&first=1`)).catch(e => { console.error(e.message); return none; }),
  ]);
  const s = streams.data[0];
  // les invités ne valent que pour le live en cours
  if (main && streamsOk && store.collab && (!s || store.collab.streamId !== s.id)) {
    mutate(() => { store.collab = null; }).catch(e => console.error(e.message));
  }
  let live = null;
  if (s) {
    live = {
      id: s.id, title: s.title, game: s.game_name, viewers: s.viewer_count, startedAt: s.started_at,
      thumbnail: (s.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360'),
      url: 'https://www.twitch.tv/' + u.login,
      guests: main ? await guestsFor(s.id, u.id).catch(e => { console.error(e.message); return []; }) : [],
    };
  }
  const v = vods.data[0];
  return {
    platform: 'twitch', main, id: 'twitch:' + u.id, name: u.display_name, handle: u.login, logo: u.profile_image_url,
    banner: u.offline_image_url || '', description: u.description, subscribers: null,
    url: 'https://www.twitch.tv/' + u.login, live,
    lastVod: v ? {
      id: v.id, title: v.title, url: v.url, views: v.view_count, publishedAt: v.published_at,
      thumbnail: (v.thumbnail_url || '').replace('%{width}', '640').replace('%{height}', '360'),
    } : null,
  };
}
const getTwitchCached = () => cached('tw', LIVE_TTL, () => getTwitch(MAIN_LOGIN, true)); // chaîne principale
const getTwitchOther = login => cached('tw:' + login, LIVE_TTL, () => getTwitch(login, false));

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

// ---------- Instagram / TikTok ----------
// Instagram : API officielle si INSTAGRAM_ACCESS_TOKEN est défini (jeton du compte, renouvelé automatiquement).
// TikTok et Instagram sans jeton : le lien de la dernière publication se colle dans le panneau (titre et vignette récupérés tout seuls).
const igToken = () => store.igToken || INSTAGRAM_ACCESS_TOKEN;
async function ig(path) {
  const r = await fetch(`https://graph.instagram.com/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(igToken())}`, { signal: AbortSignal.timeout(6000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Instagram : ' + (j.error?.message || r.status));
  return j;
}
async function igRefreshIfNeeded() { // le jeton dure 60 jours : on le renouvelle tous les ~20 jours
  if (!igToken() || Date.now() - (store.igTokenAt || 0) < 20 * 864e5) return;
  try {
    const j = await ig('refresh_access_token?grant_type=ig_refresh_token');
    if (j.access_token) await mutate(() => { store.igToken = j.access_token; store.igTokenAt = Date.now(); });
  } catch (e) { console.error(e.message); }
}
const decodeEntities = t => String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function linkPreview(platform, url) { // titre + vignette d'un lien TikTok / Instagram
  if (platform === 'tiktok') {
    const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(6000) });
    if (r.ok) { const j = await r.json(); return { title: j.title || '', thumbnail: j.thumbnail_url || '' }; }
    return {};
  }
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MastuBot/1.0)' }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return {};
  const html = await r.text();
  const metas = [...html.matchAll(/<meta\s+[^>]*>/gi)].map(m => m[0]);
  const attr = (tag, n) => (tag.match(new RegExp(n + '\\s*=\\s*["\']([^"\']*)["\']', 'i')) || [])[1];
  const og = n => { const t = metas.find(m => attr(m, 'property') === 'og:' + n); return t ? decodeEntities(attr(t, 'content')) : ''; };
  return { title: og('title') || og('description'), thumbnail: og('image') };
}
async function getSocial(acc) {
  const id = socialId(acc), user = String(acc.username).replace(/^@/, '');
  let prof = null, latest = null;
  if (acc.platform === 'instagram' && igToken()) {
    cached('ig:refresh', 6 * 3600e3, igRefreshIfNeeded).catch(() => {});
    prof = await cached('ig:profile', 6 * 3600e3, () => ig('me?fields=username,name,profile_picture_url,followers_count,biography')).catch(e => { console.error(e.message); return null; });
    if (prof && String(prof.username).toLowerCase() === user.toLowerCase()) {
      latest = await cached('ig:latest', 5 * 60 * 1000, async () => {
        const m = (await ig('me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=1')).data?.[0];
        return m ? { id: 'instagram:' + m.id, title: (m.caption || '').split('\n')[0].slice(0, 140) || (m.media_type === 'VIDEO' ? 'Nouveau reel' : 'Nouvelle publication'),
          thumbnail: m.thumbnail_url || m.media_url || '', views: null, publishedAt: m.timestamp, url: m.permalink } : null;
      }).catch(e => { console.error(e.message); return null; });
    } else prof = null;
  }
  const post = store.posts[id];
  if (!latest && post) latest = { id: post.id, title: post.title, thumbnail: post.thumbnail, views: null, publishedAt: post.date, url: post.url };
  return {
    platform: acc.platform, id, name: acc.name || prof?.name || prof?.username || '@' + user, handle: user,
    logo: acc.logo || prof?.profile_picture_url || '', banner: '', description: acc.description || prof?.biography || '',
    subscribers: prof?.followers_count ?? null,
    url: acc.platform === 'instagram' ? `https://www.instagram.com/${user}/` : `https://www.tiktok.com/@${user}`,
    latest,
  };
}

// ---------- assemblage ----------
async function buildData() {
  const res = await Promise.allSettled(ACCOUNTS.map(a => {
    if (a.platform === 'twitch') return String(a.login).toLowerCase() === MAIN_LOGIN ? getTwitchCached() : getTwitchOther(String(a.login).toLowerCase());
    if (a.platform === 'youtube') return getYoutube(a);
    if (a.platform === 'instagram' || a.platform === 'tiktok') return getSocial(a);
    return Promise.reject(new Error('Réseau inconnu : ' + a.platform));
  }));
  res.filter(r => r.status === 'rejected').forEach(r => console.error(r.reason.message));
  const channels = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!channels.length) throw new Error('Aucune donnée');
  return { updatedAt: new Date().toISOString(), channels };
}

// ---------- annonces mises en forme (HTML nettoyé) ----------
const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s,.%]+\)$/i];
const SIZE = [/^\d{1,3}(\.\d+)?(px|%)$/];
const RICH = {
  allowedTags: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'sub', 'sup', 'h1', 'h2', 'h3', 'ul', 'ol', 'li',
    'blockquote', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col', 'a'],
  allowedAttributes: { '*': ['style'], a: ['href'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], col: ['span'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedStyles: { '*': {
    'font-size': [/^([89]|[1-5]\d|6[0-4])(\.\d+)?px$/], 'font-weight': [/^(normal|bold|[1-9]00)$/], 'font-style': [/^(normal|italic)$/],
    'text-decoration': [/^(none|underline|line-through|underline line-through|line-through underline)$/],
    'text-align': [/^(left|right|center|justify)$/], 'color': COLOR, 'background-color': COLOR,
    'width': SIZE, 'height': SIZE, 'vertical-align': [/^(top|middle|bottom)$/] } },
};
const cleanHtml = html => sanitizeHtml(String(html || ''), RICH);
// texte brut (notifications, historique) : les blocs deviennent des espaces
const toPlain = html => sanitizeHtml(String(html || '').replace(/<\/(p|div|li|tr|td|th|h[1-6]|blockquote)>|<br\s*\/?>/gi, ' '), { allowedTags: [], allowedAttributes: {} })
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

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
      broadcasts: store.broadcasts.filter(b => Date.now() - Date.parse(b.date) < 7 * 864e5).slice(0, 10),
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
    announcements: store.announcements, notifResetAt: store.notifResetAt, persistent: PERSISTENT, broadcasts: store.broadcasts.slice(0, 5),
    socials: ACCOUNTS.filter(a => a.platform === 'instagram' || a.platform === 'tiktok').map(a => ({
      id: socialId(a), platform: a.platform, name: a.name || '@' + String(a.username).replace(/^@/, ''), post: store.posts[socialId(a)] || null, api: a.platform === 'instagram' && !!igToken() })),
    live: tw?.live ? { id: tw.live.id, title: tw.live.title, viewers: tw.live.viewers } : null,
    guests: tw?.live?.guests || [],
    collabActive: !!(store.collab && tw?.live && store.collab.streamId === tw.live.id),
  });
});

app.post('/api/announcement', auth, express.json({ limit: '300kb' }), async (req, res) => {
  const html = req.body?.html != null ? cleanHtml(req.body.html) : '';
  const text = html ? toPlain(html) : String(req.body?.text || '').trim();
  const link = String(req.body?.link || '').trim();
  if (!text && !/<(table|hr)/i.test(html)) return res.status(400).json({ error: "L'annonce est vide." });
  if (html.length > 40000) return res.status(400).json({ error: 'Annonce trop longue.' });
  if (text.length > 3000) return res.status(400).json({ error: 'Texte trop long (3000 caractères maximum).' });
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'Le lien doit commencer par http:// ou https://.' });
  const a = { id: String(Date.now()), text: text.slice(0, 500), html, link, date: new Date().toISOString() };
  try { await mutate(() => { store.announcements = [a, ...store.announcements].slice(0, 50); }); res.json(a); }
  catch (e) { storageError(res, e); }
});

// Notification envoyée à tout le monde (cloche + notification Chrome)
app.post('/api/admin/broadcast', auth, express.json({ limit: '20kb' }), async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const text = String(req.body?.text || '').trim();
  const link = String(req.body?.link || '').trim();
  if (!title) return res.status(400).json({ error: 'Le titre est vide.' });
  if (title.length > 80) return res.status(400).json({ error: 'Titre trop long (80 caractères maximum).' });
  if (text.length > 300) return res.status(400).json({ error: 'Message trop long (300 caractères maximum).' });
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'Le lien doit commencer par http:// ou https://.' });
  const b = { id: String(Date.now()), title, text, link, date: new Date().toISOString() };
  try { await mutate(() => { store.broadcasts = [b, ...store.broadcasts].slice(0, 20); }); res.json(b); }
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
    const logins = [...new Set(raw.map(parseLogin).filter(Boolean))].filter(l => l !== MAIN_LOGIN).slice(0, 8);
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

// Dernier TikTok / dernière publication Instagram d'un compte (lien collé dans le panneau)
app.post('/api/admin/social-post', auth, express.json({ limit: '20kb' }), async (req, res) => {
  const acc = ACCOUNTS.find(a => (a.platform === 'tiktok' || a.platform === 'instagram') && socialId(a) === req.body?.id);
  if (!acc) return res.status(400).json({ error: 'Compte inconnu (voir accounts.js).' });
  const url = String(req.body?.url || '').trim();
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
  const hostOk = acc.platform === 'tiktok' ? /(^|\.)tiktok\.com$/.test(host) : /(^|\.)instagram\.com$/.test(host);
  if (!hostOk) return res.status(400).json({ error: `Le lien doit venir de ${acc.platform === 'tiktok' ? 'tiktok.com' : 'instagram.com'}.` });
  const prev = await linkPreview(acc.platform, url).catch(() => ({}));
  const title = String(req.body?.title || '').trim() || prev.title || (acc.platform === 'tiktok' ? 'Nouveau TikTok' : 'Nouvelle publication');
  const post = { id: acc.platform + ':' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 12), url, title: title.slice(0, 200), thumbnail: prev.thumbnail || '', date: new Date().toISOString() };
  try { await mutate(() => { store.posts = { ...store.posts, [socialId(acc)]: post }; }); res.json(post); }
  catch (e) { storageError(res, e); }
});
app.delete('/api/admin/social-post/:id', auth, async (req, res) => {
  try { await mutate(() => { const p = { ...store.posts }; delete p[req.params.id]; store.posts = p; }); res.json({ ok: true }); }
  catch (e) { storageError(res, e); }
});

app.listen(PORT, () => console.log('Mastu API sur le port ' + PORT));

// Anti-veille : le serveur s'appelle lui-même toutes les 30 s (URL publique fournie par Render)
if (SELF_URL) {
  const ping = () => fetch(SELF_URL.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(10000) }).catch(() => {});
  setInterval(ping, Number(process.env.KEEP_ALIVE_SECONDS || 30) * 1000).unref();
}
