// API Mastu : garde les tokens côté serveur et renvoie tout en un seul JSON (/api/data)
const express = require('express');
const fs = require('fs');
const path = require('path');

const {
  TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, YOUTUBE_API_KEY,
  CHROME_EXTENSION_IDS = '', CACHE_TTL_SECONDS = '60',
  ADMIN_TOKEN,        // (nouveau, optionnel) protège POST /api/announcement
  TWITCH_USER_TOKEN,  // (optionnel) token de Mastu avec moderator:read:followers -> nombre de followers
  PORT = 3000,
} = process.env;

const TTL = Number(CACHE_TTL_SECONDS) * 1000;
const YT_TTL = Math.max(TTL, 5 * 60 * 1000); // protège le quota YouTube (10 000 unités/jour)
const ALLOWED = CHROME_EXTENSION_IDS.split(',').map(s => s.trim()).filter(Boolean);

const TWITCH_LOGIN = 'mastu';
// À VÉRIFIER : handles (ou { id: 'UC...' }) des 3 chaînes YouTube
const YT_CHANNELS = [{ handle: '@Mastu' }, { handle: '@MastuGear2' }, { handle: '@MastuPlus' }];

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

// ---------- Twitch ----------
let tw = { token: null, exp: 0 };
async function twitchToken() {
  if (tw.token && Date.now() < tw.exp) return tw.token;
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Twitch token: ' + JSON.stringify(j));
  tw = { token: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return tw.token;
}
async function helix(p, token) {
  const r = await fetch('https://api.twitch.tv/helix' + p, {
    headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: 'Bearer ' + (token || await twitchToken()) },
  });
  if (!r.ok) throw new Error(`Helix ${p} -> ${r.status}`);
  return r.json();
}
async function getTwitch() {
  const u = (await helix('/users?login=' + TWITCH_LOGIN)).data[0];
  const [streams, vods] = await Promise.all([
    helix('/streams?user_id=' + u.id),
    helix(`/videos?user_id=${u.id}&type=archive&first=1`),
  ]);
  let subscribers = null;
  if (TWITCH_USER_TOKEN) {
    try { subscribers = (await helix(`/channels/followers?broadcaster_id=${u.id}&first=1`, TWITCH_USER_TOKEN)).total; } catch (e) { console.error(e.message); }
  }
  const s = streams.data[0];
  let live = null;
  if (s) {
    let participants = [];
    try { // stream partagé (Shared Chat)
      const sc = await helix('/shared_chat/session?broadcaster_id=' + u.id);
      const ids = (sc.data[0]?.participants || []).map(p => p.broadcaster_id).filter(id => id !== u.id);
      if (ids.length) {
        participants = (await helix('/users?' + ids.map(i => 'id=' + i).join('&'))).data
          .map(x => ({ name: x.display_name, handle: x.login, logo: x.profile_image_url, url: 'https://twitch.tv/' + x.login }));
      }
    } catch (_) { /* pas de session partagée */ }
    live = {
      id: s.id, title: s.title, game: s.game_name, viewers: s.viewer_count, startedAt: s.started_at,
      thumbnail: s.thumbnail_url.replace('{width}', '640').replace('{height}', '360'),
      url: 'https://www.twitch.tv/' + u.login, participants,
    };
  }
  const v = vods.data[0];
  return {
    platform: 'twitch', id: 'twitch:' + u.id, name: u.display_name, handle: u.login, logo: u.profile_image_url,
    banner: u.offline_image_url || '', description: u.description, subscribers,
    url: 'https://www.twitch.tv/' + u.login, live,
    lastVod: v ? {
      id: v.id, title: v.title, url: v.url, views: v.view_count, publishedAt: v.published_at,
      thumbnail: (v.thumbnail_url || '').replace('%{width}', '640').replace('%{height}', '360'),
    } : null,
  };
}

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
  const res = await Promise.allSettled([getTwitch(), ...YT_CHANNELS.map(getYoutube)]);
  res.filter(r => r.status === 'rejected').forEach(r => console.error(r.reason.message));
  const channels = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!channels.length) throw new Error('Aucune donnée');
  const twitch = channels.find(c => c.platform === 'twitch');
  let now = null;
  if (twitch?.live) {
    now = { type: 'live', channel: twitch, live: twitch.live };
  } else {
    const best = channels.filter(c => c.latest).sort((a, b) => Date.parse(b.latest.publishedAt) - Date.parse(a.latest.publishedAt))[0];
    if (best) now = { type: 'video', channel: best, video: best.latest };
  }
  return { updatedAt: new Date().toISOString(), channels, now };
}

// ---------- annonce ----------
const FILE = path.join(__dirname, 'announcement.json');
let announcement = null;
try { announcement = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) {}

// ---------- serveur ----------
const app = express();
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ALLOWED.some(id => o === 'chrome-extension://' + id)) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', Vary: 'Origin' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_q, r) => r.send('ok'));

app.get('/api/data', async (_q, res) => {
  try {
    const base = await cached('all', TTL, buildData);
    res.set('Cache-Control', 'no-store').json({ ...base, announcement });
  } catch (e) { console.error(e.message); res.status(502).json({ error: 'upstream' }); }
});

// Utilisé par ton panel : POST { text, link? } avec "Authorization: Bearer <ADMIN_TOKEN>"
app.post('/api/announcement', express.json(), (req, res) => {
  if (!ADMIN_TOKEN || req.headers.authorization !== 'Bearer ' + ADMIN_TOKEN) return res.sendStatus(401);
  const { text, link = '' } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text requis' });
  announcement = { id: String(Date.now()), text, link, date: new Date().toISOString() };
  try { fs.writeFileSync(FILE, JSON.stringify(announcement)); } catch (_) {}
  res.json(announcement);
});

app.listen(PORT, () => console.log('Mastu API sur le port ' + PORT));
