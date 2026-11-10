import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { channels as channelConfig } from "./config.js";
dotenv.config();

const app = express();
app.use(express.json());
const allowed = (process.env.CHROME_EXTENSION_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
app.use(cors({origin(origin, cb) {
  if (!origin || allowed.length === 0 || allowed.some(id => origin === `chrome-extension://${id}`)) return cb(null, true);
  return cb(new Error("Origin not allowed"));
}}));

const ttl = Math.max(15, Number(process.env.CACHE_TTL_SECONDS || 60)) * 1000;
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttl) return hit.value;
  const value = await fn(); cache.set(key, {time:Date.now(), value}); return value;
}
async function jsonFetch(url, options={}) {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`Upstream ${r.status}: ${await r.text()}`);
  return r.json();
}
let twitchToken = null, twitchTokenExpiry = 0;
async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiry) return twitchToken;
  const body = new URLSearchParams({client_id:process.env.TWITCH_CLIENT_ID, client_secret:process.env.TWITCH_CLIENT_SECRET, grant_type:"client_credentials"});
  const data = await jsonFetch("https://id.twitch.tv/oauth2/token", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body});
  twitchToken = data.access_token; twitchTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return twitchToken;
}
async function twitch(path) {
  const token = await getTwitchToken();
  return jsonFetch(`https://api.twitch.tv/helix/${path}`, {headers:{"Client-ID":process.env.TWITCH_CLIENT_ID, "Authorization":`Bearer ${token}`}});
}
async function getYoutubeChannel(id) {
  if (!id || !process.env.YOUTUBE_API_KEY) return null;
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.search = new URLSearchParams({part:"snippet,statistics,brandingSettings,contentDetails", id, key:process.env.YOUTUBE_API_KEY});
  const data = await jsonFetch(url);
  const c = data.items?.[0]; if (!c) return null;
  const uploads = c.contentDetails.relatedPlaylists.uploads;
  const videoUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  videoUrl.search = new URLSearchParams({part:"snippet", playlistId:uploads, maxResults:"1", key:process.env.YOUTUBE_API_KEY});
  const videos = await jsonFetch(videoUrl);
  const v = videos.items?.[0]?.snippet;
  const videoId = v?.resourceId?.videoId;
  return {
    name:c.snippet.title, handle:c.snippet.customUrl || "", avatar:c.snippet.thumbnails?.default?.url,
    banner:c.brandingSettings?.image?.bannerExternalUrl, description:c.snippet.description,
    subscribers:Number(c.statistics.subscriberCount || 0), subscribersLabel:c.statistics.hiddenSubscriberCount ? "Abonnés masqués" : Number(c.statistics.subscriberCount || 0).toLocaleString("fr-FR"),
    latest: videoId ? {type:"video", title:v.title, thumbnail:v.thumbnails?.high?.url || v.thumbnails?.default?.url, url:`https://www.youtube.com/watch?v=${videoId}`, channelName:c.snippet.title, handle:c.snippet.customUrl || "", views:"—"} : null,
    url:`https://www.youtube.com/channel/${id}`
  };
}
async function getYoutubeVideos() {
  const result = [];
  for (const cfg of channelConfig) {
    const data = await getYoutubeChannel(process.env[cfg.env]);
    if (data) result.push({...cfg, ...data});
  }
  return result;
}
async function getTwitchChannel() {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return null;
  const [users, streams] = await Promise.all([
    twitch("users?login=mastu"), twitch("streams?user_login=mastu")
  ]);
  const user = users.data?.[0]; if (!user) return null;
  const stream = streams.data?.[0];
  const videos = await twitch(`videos?user_id=${encodeURIComponent(user.id)}&first=1`);
  const lastVideo = videos.data?.[0];
  return {
    name:"Mastu", handle:"mastu", platform:"twitch", avatar:user.profile_image_url, url:"https://www.twitch.tv/mastu",
    live:!!stream,
    latest: stream ? {type:"live", title:stream.title, thumbnail:stream.thumbnail_url?.replace("{width}","640").replace("{height}","360"), url:"https://www.twitch.tv/mastu", viewers:stream.viewer_count, duration:durationSince(stream.started_at), channelName:"Mastu"} : null,
    lastStream: !stream && lastVideo ? {type:"video", title:lastVideo.title, thumbnail:lastVideo.thumbnail_url, url:lastVideo.url, channelName:"Mastu", handle:"mastu"} : null,
    description:user.description || ""
  };
}
function durationSince(date) {
  if (!date) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  return `${Math.floor(mins/60)} h ${mins%60} min`;
}
async function announcement() {
  const url = process.env.ANNOUNCEMENT_API_URL;
  if (!url) return {title:"Bienvenue !", message:"Bienvenue dans Mastu Extension. Les annonces officielles apparaîtront ici.", updatedAt:new Date().toISOString()};
  const headers = {};
  if (process.env.ANNOUNCEMENT_API_TOKEN) headers.Authorization = `Bearer ${process.env.ANNOUNCEMENT_API_TOKEN}`;
  return jsonFetch(url, {headers});
}
app.get("/api/health", (_req,res) => res.json({ok:true}));
app.get("/api/announcement", async (_req,res) => {
  try { res.json(await cached("announcement", announcement)); }
  catch(e) { res.status(502).json({error:"Announcement service unavailable"}); }
});
app.get("/api/channels", async (_req,res) => {
  try {
    const [youtube, twitchData] = await Promise.all([cached("youtube", getYoutubeVideos), cached("twitch", getTwitchChannel)]);
    const channels = [...youtube];
    if (twitchData) channels.unshift(twitchData);
    res.json({channels});
  } catch(e) { console.error(e); res.status(502).json({error:"Unable to load channels"}); }
});
app.get("/api/current", async (_req,res) => {
  try {
    const [youtube, twitchData] = await Promise.all([cached("youtube", getYoutubeVideos), cached("twitch", getTwitchChannel)]);
    const live = twitchData?.latest;
    const videos = youtube.map(c => c.latest).filter(Boolean);
    const item = live || videos[0] || null;
    res.json({item});
  } catch(e) { console.error(e); res.status(502).json({error:"Unable to load current media"}); }
});
app.get("/api/updates", async (_req,res) => {
  try {
    const [a, c] = await Promise.all([cached("announcement", announcement), cached("twitch", getTwitchChannel)]);
    const ids = [];
    if (a.updatedAt) ids.push({id:`announcement-${a.updatedAt}`, title:"Nouvelle annonce", message:a.title || a.message, date:a.updatedAt});
    if (c?.live) ids.push({id:`live-${c.latest.title}-${c.latest.duration}`, title:"Mastu est en live", message:c.latest.title, date:new Date().toISOString()});
    res.json({notifications:ids});
  } catch(e) { res.json({notifications:[]}); }
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Mastu API listening on ${port}`));
