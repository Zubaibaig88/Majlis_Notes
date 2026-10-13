/*
 * Majlis Notes server — stores meetings, runs AI prompts, shares links,
 * transcribes uploaded recordings, and serves the web dashboard.
 * No npm packages needed. Run:  node server.js
 */
const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.MAJLIS_TOKEN || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const GOOGLE_CALENDAR_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || "";
const GOOGLE_CALENDAR_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "";
const GOOGLE_CALENDAR_REDIRECT_URI = process.env.GOOGLE_CALENDAR_REDIRECT_URI || "http://localhost:8787/api/calendar/callback";
const DATA = path.resolve(process.env.MAJLIS_DATA || path.join(__dirname, "data"));
const PUBLIC = path.join(__dirname, "public");
const MAX_UPLOAD = 200 * 1024 * 1024;

for (const d of ["meetings", "shots", "uploads"]) fs.mkdirSync(path.join(DATA, d), { recursive: true });

/* ------------------------------------------------------------------ */
/* Built-in AI prompts (users can add their own in the dashboard)      */
/* ------------------------------------------------------------------ */
const BUILTIN_PROMPTS = [
  {
    id: "summary",
    name: "Meeting summary",
    icon: "✦",
    text:
      "Write a clear meeting summary.\n## Overview\n2–3 sentences.\n## Key points\nBullets.\n## Decisions\nBullets (write 'None' if none).\n## Action items\nChecklist '- [ ] Task — Owner — Due date' (use 'Unassigned' / 'No date' when not said).\n## Open questions\nBullets.",
  },
  { id: "actions", name: "Action items", icon: "☑", text: "List every action item as a checklist: '- [ ] Task — Owner — Due date'. Group by owner. Only include tasks that were really said or agreed." },
  { id: "decisions", name: "Decisions made", icon: "⚑", text: "List every decision that was made, with who made or agreed to it and the reason if given. Then list things that were discussed but NOT decided." },
  { id: "email", name: "Follow-up email", icon: "✉", text: "Write a short, friendly follow-up email to all participants: thank them, recap the key points and decisions, list action items with owners and dates, and give the next step. Include a subject line." },
  { id: "minutes", name: "Detailed minutes", icon: "≡", text: "Write formal meeting minutes: title, date, attendees, agenda topics (inferred), discussion per topic, decisions, action items, next meeting." },
  { id: "questions", name: "Questions & answers", icon: "?", text: "List every question that was asked, who asked it, and the answer given (or 'Not answered')." },
  { id: "sales", name: "Sales call notes", icon: "$", text: "Write sales call notes: customer needs and pain points, budget, decision makers, timeline, objections and how they were handled, competitors mentioned, next steps, and a deal risk rating (Low/Medium/High) with one line why." },
  { id: "interview", name: "Interview scorecard", icon: "★", text: "Write an interview scorecard: candidate background, strengths, concerns, key answers by topic, culture fit notes, and a hire / no-hire leaning with reasons. Stay factual." },
  { id: "highlights", name: "Summarize highlights", icon: "✸", text: "Use ONLY the lines marked ★ HIGHLIGHT and any notes. Turn them into a short, clear list of the most important moments, with timestamps." },
  { id: "arabic", name: "Summary in Arabic", icon: "ع", text: "اكتب ملخصًا واضحًا للاجتماع باللغة العربية: نظرة عامة، النقاط الرئيسية، القرارات، المهام مع المسؤول والموعد." },
];

/* ------------------------------------------------------------------ */
/* Storage                                                            */
/* ------------------------------------------------------------------ */
const mPath = (id) => path.join(DATA, "meetings", safeId(id) + ".json");
const readJSON = async (p, fallback) => {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJSON = async (p, v) => {
  const tmp = p + "." + process.pid + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(v, null, 1));
  await fsp.rename(tmp, p);
};
function safeId(id, min = 6) {
  const s = String(id || "");
  if (s.length < min || !/^[\w-]{1,80}$/.test(s)) throw httpError(400, "Bad id");
  return s;
}
const getMeeting = (id) => readJSON(mPath(id), null);
const saveMeeting = (m) => writeJSON(mPath(m.id), m);

async function listMeetings() {
  const files = await fsp.readdir(path.join(DATA, "meetings"));
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const m = await readJSON(path.join(DATA, "meetings", f), null);
    if (m) out.push(m);
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
function meetingSummary(m) {
  const words = (m.entries || []).reduce((n, e) => n + wordCount(e.text), 0);
  return {
    id: m.id,
    title: m.title,
    platform: m.platform,
    platformName: m.platformName,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    durationMs: duration(m),
    lines: (m.entries || []).length,
    words,
    speakers: speakersOf(m),
    tags: m.tags || [],
    folder: m.folder || "",
    highlights: (m.entries || []).filter((e) => e.highlight).length,
    hasSummary: !!(m.ai || []).find((a) => a.promptId === "summary"),
    shareId: m.shareId || null,
    source: m.source || "live",
  };
}
const wordCount = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
const speakersOf = (m) => Array.from(new Set((m.entries || []).map((e) => e.speaker).filter((s) => s && !s.startsWith("📷"))));
function duration(m) {
  if (m.endedAt && m.startedAt) return new Date(m.endedAt) - new Date(m.startedAt);
  const last = (m.entries || [])[m.entries.length - 1];
  return last ? last.t : 0;
}

async function getPrompts() {
  const custom = await readJSON(path.join(DATA, "prompts.json"), []);
  return [...BUILTIN_PROMPTS.map((p) => ({ ...p, builtin: true })), ...custom];
}
const getShares = () => readJSON(path.join(DATA, "shares.json"), {});
const getSettings = () => readJSON(path.join(DATA, "settings.json"), { slackWebhook: "", webhookUrl: "", autoSummary: true, autoCalendar: false, language: "auto" });
const saveSettings = (s) => writeJSON(path.join(DATA, "settings.json"), s);
const getSpaces = () => readJSON(path.join(DATA, "spaces.json"), { default: { id: "default", name: "My Meetings", description: "", color: "#6366f1" } });
const saveSpaces = (s) => writeJSON(path.join(DATA, "spaces.json"), s);

/* Pull screenshots out of the meeting JSON into image files. */
async function extractShots(m) {
  for (const s of m.screenshots || []) {
    if (s.dataUrl && s.dataUrl.startsWith("data:image/")) {
      const ext = s.dataUrl.startsWith("data:image/jpeg") ? "jpg" : "png";
      const name = `${safeId(m.id)}-${safeId(s.id, 1)}.${ext}`;
      await fsp.writeFile(path.join(DATA, "shots", name), Buffer.from(s.dataUrl.split(",")[1], "base64"));
      delete s.dataUrl;
      s.url = "/shots/" + name;
    }
  }
}

/* Merge an incoming copy from the extension with the server copy. */
function mergeMeeting(old, inc) {
  if (!old) return { ...inc, ai: [], tags: inc.tags || [], comments: [], spaceId: "default", createdAt: new Date().toISOString() };
  const byId = new Map((old.entries || []).map((e) => [e.id, e]));
  const entries = (inc.entries || []).map((e) => {
    const o = byId.get(e.id);
    byId.delete(e.id);
    return o && o.srvEdit ? o : e;
  });
  // Keep lines that only exist on the server (e.g. added in the dashboard).
  for (const o of byId.values()) if (o.srvEdit) entries.push(o);
  entries.sort((a, b) => a.t - b.t);
  const shots = new Map((old.screenshots || []).map((s) => [s.id, s]));
  for (const s of inc.screenshots || []) if (!shots.has(s.id) || s.dataUrl) shots.set(s.id, s);
  return {
    ...old,
    ...inc,
    title: old.titleLocked ? old.title : inc.title,
    titleLocked: old.titleLocked,
    entries,
    screenshots: Array.from(shots.values()),
    participants: Array.from(new Set([...(old.participants || []), ...(inc.participants || [])])),
    tags: old.tags || [],
    folder: old.folder,
    spaceId: old.spaceId || "default",
    notes: old.notesLocked ? old.notes : inc.notes || old.notes,
    notesLocked: old.notesLocked,
    ai: old.ai || [],
    comments: old.comments || [],
    shareId: old.shareId,
    createdAt: old.createdAt,
    endedAt: inc.endedAt || old.endedAt,
  };
}

/* ------------------------------------------------------------------ */
/* AI (Claude)                                                        */
/* ------------------------------------------------------------------ */
function fmtOffset(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(s / 3600);
  const p = (n) => String(n).padStart(2, "0");
  return (h ? h + ":" : "") + p(Math.floor((s % 3600) / 60)) + ":" + p(s % 60);
}
function transcriptForAI(m) {
  const lines = (m.entries || []).map(
    (e) => `[${fmtOffset(e.t)}] ${e.speaker}: ${e.text}${e.highlight ? "  ★ HIGHLIGHT" : ""}${e.note ? `  (Note: ${e.note})` : ""}`
  );
  let text = lines.join("\n");
  if (text.length > 700000) text = text.slice(0, 350000) + "\n…[middle of transcript cut for length]…\n" + text.slice(-350000);
  return text;
}

async function askClaude(m, instruction) {
  if (!ANTHROPIC_API_KEY) throw httpError(400, "AI is not set up. Add ANTHROPIC_API_KEY to the server .env file and restart.");
  const system =
    "You are Majlis Notes, an assistant that turns meeting transcripts into useful notes. " +
    "Transcripts come from live captions and may have small errors, missing punctuation, or mixed Arabic and English — read through these. " +
    "Only use facts from the transcript. Never invent names, dates or numbers. Use plain, simple English unless asked for another language. " +
    "Use Markdown headings and bullet lists. Keep it short and useful.";
  const user =
    `Meeting: ${m.title}\nDate: ${m.startedAt}\nPlatform: ${m.platformName || m.platform || "unknown"}\n` +
    `Participants: ${(m.participants && m.participants.length ? m.participants : speakersOf(m)).join(", ") || "unknown"}\n` +
    (m.notes ? `My notes: ${m.notes}\n` : "") +
    `\n<transcript>\n${transcriptForAI(m)}\n</transcript>\n\nTask:\n${instruction}`;
  const res = await fetch(ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 3000, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, "AI error: " + ((data.error && data.error.message) || res.status));
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
}

async function runPrompt(m, { promptId, prompt, question }) {
  let instruction, name;
  if (question) {
    instruction = `Answer this question about the meeting. If the transcript does not say, answer "The meeting did not cover this." Quote the timestamp(s) you used.\n\nQuestion: ${question}`;
    name = "Q: " + question.slice(0, 80);
  } else if (prompt) {
    instruction = prompt;
    name = "Custom prompt";
  } else {
    const p = (await getPrompts()).find((x) => x.id === (promptId || "summary"));
    if (!p) throw httpError(404, "Prompt not found");
    instruction = p.text;
    name = p.name;
  }
  if (!(m.entries || []).some((e) => !e.speaker.startsWith("📷"))) throw httpError(400, "This transcript is empty — nothing to summarize yet.");
  const text = await askClaude(m, instruction);
  const result = { id: crypto.randomUUID(), promptId: promptId || (question ? "ask" : "custom"), name, text, createdAt: new Date().toISOString() };
  m.ai = [result, ...(m.ai || []).filter((a) => !(promptId && a.promptId === promptId))];
  await saveMeeting(m);
  return result;
}

/* ------------------------------------------------------------------ */
/* Recording upload → transcript                                      */
/* ------------------------------------------------------------------ */
async function transcribeFile(buf, filename, mime) {
  if (DEEPGRAM_API_KEY) {
    const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(DEEPGRAM_MODEL)}&diarize=true&punctuate=true&smart_format=true&utterances=true&detect_language=true`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: "Token " + DEEPGRAM_API_KEY, "content-type": mime || "application/octet-stream" }, body: buf });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(502, "Deepgram error: " + (data.err_msg || data.message || res.status));
    const utt = (data.results && data.results.utterances) || [];
    return utt.map((u) => ({ speaker: "Speaker " + ((u.speaker || 0) + 1), text: u.transcript, t: Math.round(u.start * 1000) }));
  }
  if (OPENAI_API_KEY) {
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime || "application/octet-stream" }), filename || "audio.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + OPENAI_API_KEY }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(502, "OpenAI error: " + ((data.error && data.error.message) || res.status));
    return (data.segments || [{ start: 0, text: data.text || "" }]).map((s) => ({ speaker: "Speaker", text: String(s.text).trim(), t: Math.round(s.start * 1000) }));
  }
  throw httpError(400, "To transcribe recordings, add DEEPGRAM_API_KEY (best: speaker names + Arabic) or OPENAI_API_KEY to the server .env file.");
}

/* ------------------------------------------------------------------ */
/* Integrations: Slack + any webhook (Zapier / Make / n8n)            */
/* ------------------------------------------------------------------ */
async function pushIntegrations(m, target) {
  const s = await getSettings();
  const summary = (m.ai || []).find((a) => a.promptId === "summary");
  const body = summary ? summary.text : "(No AI summary yet)";
  const results = {};
  if ((!target || target === "slack") && s.slackWebhook) {
    const r = await fetch(s.slackWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `*${m.title}* — ${new Date(m.startedAt).toLocaleString()}\n\n${body.replace(/\*\*/g, "*").replace(/^#+ /gm, "*")}` }),
    });
    results.slack = r.ok;
  }
  if ((!target || target === "webhook") && s.webhookUrl) {
    const r = await fetch(s.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "meeting.ready", meeting: { ...meetingSummary(m), summary: body, transcript: transcriptForAI(m), ai: m.ai } }),
    });
    results.webhook = r.ok;
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
function sendJSON(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
async function readBody(req, limit = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, "File too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJSONBody(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    throw httpError(400, "Bad JSON");
  }
}
function authed(req) {
  if (!TOKEN) return true;
  const got = String(req.headers["x-majlis-token"] || "");
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
async function serveFile(res, file, extraHeaders = {}) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", ...extraHeaders });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

const routes = [];
const route = (method, pattern, handler, open = false) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, handler, open });
};

route("GET", "/api/health", async () => ({ ok: true, name: "Majlis Notes", ai: !!ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL, upload: !!(DEEPGRAM_API_KEY || OPENAI_API_KEY), auth: !!TOKEN }), true);

route("GET", "/api/meetings", async (req, p, url) => {
  const q = (url.searchParams.get("q") || "").toLowerCase().trim();
  const tag = url.searchParams.get("tag") || "";
  const folder = url.searchParams.get("folder") || "";
  const all = await listMeetings();
  const out = [];
  for (const m of all) {
    if (tag && !(m.tags || []).includes(tag)) continue;
    if (folder && (m.folder || "") !== folder) continue;
    let hit = null;
    if (q) {
      if ((m.title || "").toLowerCase().includes(q)) hit = { title: true };
      else {
        const e = (m.entries || []).find((x) => (x.text || "").toLowerCase().includes(q) || (x.speaker || "").toLowerCase().includes(q));
        if (e) hit = { line: e.text.slice(0, 160), speaker: e.speaker, t: e.t };
        else if ((m.ai || []).some((a) => a.text.toLowerCase().includes(q))) hit = { ai: true };
        else continue;
      }
    }
    out.push({ ...meetingSummary(m), hit });
  }
  return { meetings: out };
});

route("POST", "/api/meetings", async (req) => {
  const inc = await readJSONBody(req);
  if (!inc.id || !Array.isArray(inc.entries)) throw httpError(400, "Meeting needs id and entries");
  safeId(inc.id);
  await extractShots(inc);
  const old = await getMeeting(inc.id);
  const m = mergeMeeting(old, inc);
  m.updatedAt = new Date().toISOString();
  await saveMeeting(m);
  // When a call ends, make the summary and push it to Slack / webhook.
  if (inc.endedAt && (!old || !old.endedAt)) onMeetingEnded(m).catch((e) => console.error("auto-summary:", e.message));
  return { ok: true, id: m.id };
});

async function onMeetingEnded(m) {
  const s = await getSettings();
  if (s.autoSummary && ANTHROPIC_API_KEY && (m.entries || []).length >= 3 && !(m.ai || []).some((a) => a.promptId === "summary")) {
    await runPrompt(m, { promptId: "summary" });
  }
  if (s.slackWebhook || s.webhookUrl) await pushIntegrations(await getMeeting(m.id));
  if (s.autoCalendar && s.googleCalendarAccessToken) {
    await createCalendarEvent(m, s).catch((e) => console.error("calendar sync:", e.message));
  }
}

async function createCalendarEvent(m, s) {
  if (!s.googleCalendarAccessToken) return;
  const dur = m.endedAt ? new Date(m.endedAt) - new Date(m.startedAt) : (m.entries[m.entries.length - 1] || {}).t || 0;
  const startTime = new Date(m.startedAt);
  const endTime = new Date(startTime.getTime() + dur);

  const event = {
    summary: m.title || "Meeting",
    description: m.notes || "",
    start: { dateTime: startTime.toISOString(), timeZone: "UTC" },
    end: { dateTime: endTime.toISOString(), timeZone: "UTC" },
    attendees: (m.participants || []).map((p) => ({ email: "", displayName: p })),
  };

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${s.googleCalendarId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + s.googleCalendarAccessToken,
    },
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    const data = await res.json();
    if (data.error?.code === 401) {
      // Token expired, try to refresh
      await refreshGoogleToken(s);
    } else {
      throw new Error(data.error?.message || "Failed to create calendar event");
    }
  }
}

async function refreshGoogleToken(s) {
  if (!s.googleCalendarRefreshToken || !GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET) return;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: GOOGLE_CALENDAR_CLIENT_SECRET,
      refresh_token: s.googleCalendarRefreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = await res.json();
  if (data.access_token) {
    s.googleCalendarAccessToken = data.access_token;
    await saveSettings(s);
  }
}

route("GET", "/api/meetings/:id", async (req, p) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  return { meeting: m };
});

route("PATCH", "/api/meetings/:id", async (req, p) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  const b = await readJSONBody(req);
  if (typeof b.title === "string") (m.title = b.title.trim() || m.title), (m.titleLocked = true);
  if (Array.isArray(b.tags)) m.tags = Array.from(new Set(b.tags.map((t) => String(t).trim()).filter(Boolean))).slice(0, 30);
  if (typeof b.folder === "string") m.folder = b.folder.trim();
  if (typeof b.spaceId === "string") m.spaceId = b.spaceId.trim() || "default";
  if (typeof b.notes === "string") (m.notes = b.notes), (m.notesLocked = true);
  if (b.renameSpeaker && b.renameSpeaker.from && b.renameSpeaker.to) {
    for (const e of m.entries) if (e.speaker === b.renameSpeaker.from) (e.speaker = b.renameSpeaker.to.trim()), (e.srvEdit = true);
    m.participants = (m.participants || []).map((x) => (x === b.renameSpeaker.from ? b.renameSpeaker.to.trim() : x));
  }
  if (b.entry && b.entry.id) {
    const e = m.entries.find((x) => x.id === b.entry.id);
    if (!e) throw httpError(404, "Line not found");
    for (const k of ["text", "speaker", "note"]) if (typeof b.entry[k] === "string") e[k] = b.entry[k];
    if (typeof b.entry.highlight === "boolean") e.highlight = b.entry.highlight;
    e.srvEdit = true;
  }
  if (b.deleteEntry) m.entries = m.entries.filter((x) => x.id !== b.deleteEntry);
  if (b.deleteAi) m.ai = (m.ai || []).filter((a) => a.id !== b.deleteAi);
  m.updatedAt = new Date().toISOString();
  await saveMeeting(m);
  return { meeting: m };
});

route("DELETE", "/api/meetings/:id", async (req, p) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  for (const s of m.screenshots || []) if (s.url) await fsp.rm(path.join(DATA, s.url.replace(/^\//, "")), { force: true });
  if (m.shareId) {
    const shares = await getShares();
    delete shares[m.shareId];
    await writeJSON(path.join(DATA, "shares.json"), shares);
  }
  await fsp.rm(mPath(p.id), { force: true });
  return { ok: true };
});

route("POST", "/api/meetings/:id/comments", async (req, p) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  const b = await readJSONBody(req);
  if (!b.text || !b.text.trim()) throw httpError(400, "Empty comment");
  m.comments = m.comments || [];
  m.comments.push({ id: crypto.randomUUID(), entryId: b.entryId || null, author: (b.author || "Me").slice(0, 60), text: b.text.trim().slice(0, 4000), at: new Date().toISOString() });
  await saveMeeting(m);
  return { comments: m.comments };
});

route("POST", "/api/meetings/:id/ai", async (req, p) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found — wait a few seconds for it to sync.");
  const b = await readJSONBody(req);
  const result = await runPrompt(m, b);
  return { ok: true, ...result };
});

route("POST", "/api/meetings/:id/share", async (req, p) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  const b = await readJSONBody(req);
  const shares = await getShares();
  if (b.off) {
    if (m.shareId) delete shares[m.shareId];
    m.shareId = null;
  } else if (!m.shareId) {
    m.shareId = crypto.randomBytes(12).toString("base64url");
    shares[m.shareId] = m.id;
  }
  m.shareOptions = { transcript: b.transcript !== false, ai: b.ai !== false };
  await writeJSON(path.join(DATA, "shares.json"), shares);
  await saveMeeting(m);
  return { shareId: m.shareId };
});

route("POST", "/api/meetings/:id/push", async (req, p) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  const b = await readJSONBody(req);
  return { results: await pushIntegrations(m, b.target) };
});

/* Audio chunk buffer for streaming transcription */
const audioBuffers = new Map(); // meetingId -> { chunks: [], processing: false }

route("POST", "/api/meetings/:id/audio", async (req, p) => {
  if (!DEEPGRAM_API_KEY) throw httpError(400, "Audio transcription is not configured. Add DEEPGRAM_API_KEY to .env");
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  const b = await readJSONBody(req);
  if (!Array.isArray(b.audio)) throw httpError(400, "Audio data required");

  // Buffer the audio chunk
  if (!audioBuffers.has(p.id)) {
    audioBuffers.set(p.id, { chunks: [], processing: false });
  }
  const buf = audioBuffers.get(p.id);
  buf.chunks.push(new Uint8Array(b.audio));

  // If we have enough audio (e.g., 0.5 seconds = 44100 samples), transcribe
  const totalSamples = buf.chunks.reduce((n, c) => n + c.length, 0);
  if (totalSamples > 22050 && !buf.processing) {
    buf.processing = true;
    setImmediate(async () => {
      try {
        const pcmBuffer = Buffer.concat(buf.chunks);
        buf.chunks = [];

        // Send to Deepgram for transcription
        const deepgRes = await fetch("https://api.deepgram.com/v1/listen?model=" + DEEPGRAM_MODEL, {
          method: "POST",
          headers: {
            "Authorization": "Token " + DEEPGRAM_API_KEY,
            "Content-Type": "audio/raw;encoding=linear16;sample_rate=44100",
          },
          body: pcmBuffer,
        });
        if (!deepgRes.ok) {
          console.error("Deepgram error:", deepgRes.status, await deepgRes.text());
          buf.processing = false;
          return;
        }
        const dgData = await deepgRes.json();
        const transcript = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        if (!transcript) {
          buf.processing = false;
          return;
        }

        // Add the transcription as an entry in the meeting
        const m = await getMeeting(p.id);
        if (m && transcript.trim()) {
          const lastEntry = m.entries[m.entries.length - 1];
          const lastSpeaker = (dgData.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.[0]?.sentences?.[0]?.speaker || lastEntry?.speaker || "Speaker").trim();

          // If same speaker and recent, append to last entry
          if (lastEntry && lastEntry.speaker === lastSpeaker && Date.now() - new Date(lastEntry.at) < 5000) {
            lastEntry.text = (lastEntry.text || "") + " " + transcript;
            lastEntry.text = lastEntry.text.trim();
          } else {
            m.entries.push({
              id: crypto.randomUUID(),
              speaker: lastSpeaker,
              text: transcript,
              t: Date.now() - new Date(m.startedAt),
              at: new Date().toISOString(),
              highlight: false,
              note: "",
            });
          }
          m.updatedAt = new Date().toISOString();
          await saveMeeting(m);
        }
      } catch (e) {
        console.error("Audio transcription error:", e.message);
      } finally {
        buf.processing = false;
      }
    });
  }

  return { ok: true };
});

route(
  "GET",
  "/api/share/:sid",
  async (req, p) => {
    const shares = await getShares();
    const id = shares[p.sid];
    const m = id && (await getMeeting(id));
    if (!m || m.shareId !== p.sid) throw httpError(404, "This link is not active.");
    const o = m.shareOptions || { transcript: true, ai: true };
    return {
      meeting: {
        title: m.title,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        platformName: m.platformName,
        participants: m.participants,
        entries: o.transcript ? m.entries.map(({ id, speaker, text, t, highlight, screenshot }) => ({ id, speaker, text, t, highlight, screenshot })) : [],
        screenshots: o.transcript ? m.screenshots : [],
        ai: o.ai ? m.ai : [],
      },
    };
  },
  true
);

route("GET", "/api/prompts", async () => ({ prompts: await getPrompts() }));
route("POST", "/api/prompts", async (req) => {
  const b = await readJSONBody(req);
  if (!b.name || !b.text) throw httpError(400, "Prompt needs a name and text");
  const custom = await readJSON(path.join(DATA, "prompts.json"), []);
  const item = { id: b.id && custom.some((c) => c.id === b.id) ? b.id : "c-" + crypto.randomBytes(6).toString("hex"), name: b.name.slice(0, 80), icon: (b.icon || "◆").slice(0, 2), text: b.text.slice(0, 8000), kit: (b.kit || "").slice(0, 60) };
  const i = custom.findIndex((c) => c.id === item.id);
  if (i >= 0) custom[i] = item;
  else custom.push(item);
  await writeJSON(path.join(DATA, "prompts.json"), custom);
  return { prompt: item };
});
route("DELETE", "/api/prompts/:pid", async (req, p) => {
  const custom = await readJSON(path.join(DATA, "prompts.json"), []);
  await writeJSON(path.join(DATA, "prompts.json"), custom.filter((c) => c.id !== p.pid));
  return { ok: true };
});

route("GET", "/api/settings", async () => ({ settings: await getSettings(), env: { ai: !!ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL, upload: DEEPGRAM_API_KEY ? "deepgram" : OPENAI_API_KEY ? "openai" : "" } }));
route("PUT", "/api/settings", async (req) => {
  const b = await readJSONBody(req);
  const s = await getSettings();
  for (const k of ["slackWebhook", "webhookUrl"]) if (typeof b[k] === "string") {
    if (b[k] && !/^https:\/\//.test(b[k])) throw httpError(400, k + " must start with https://");
    s[k] = b[k].trim();
  }
  if (typeof b.autoSummary === "boolean") s.autoSummary = b.autoSummary;
  if (typeof b.autoCalendar === "boolean") s.autoCalendar = b.autoCalendar;
  await saveSettings(s);
  return { settings: s };
});

route("GET", "/api/stats", async () => {
  const all = await listMeetings();
  const now = Date.now();
  const week = all.filter((m) => now - new Date(m.startedAt) < 7 * 864e5);
  const speakers = {};
  for (const m of all) for (const e of m.entries || []) if (!e.speaker.startsWith("📷")) speakers[e.speaker] = (speakers[e.speaker] || 0) + wordCount(e.text);
  return {
    meetings: all.length,
    thisWeek: week.length,
    hoursTotal: all.reduce((n, m) => n + duration(m), 0) / 36e5,
    hoursWeek: week.reduce((n, m) => n + duration(m), 0) / 36e5,
    words: all.reduce((n, m) => n + (m.entries || []).reduce((k, e) => k + wordCount(e.text), 0), 0),
    topSpeakers: Object.entries(speakers).sort((a, b) => b[1] - a[1]).slice(0, 8),
    tags: Array.from(new Set(all.flatMap((m) => m.tags || []))).sort(),
    folders: Array.from(new Set(all.map((m) => m.folder).filter(Boolean))).sort(),
    spaces: getSpaces(),
  };
});

route("GET", "/api/spaces", async () => getSpaces());
route("POST", "/api/spaces", async (req) => {
  const b = await readJSONBody(req);
  const spaces = await getSpaces();
  const id = crypto.randomUUID();
  spaces[id] = { id, name: String(b.name || "New space").slice(0, 80), description: String(b.description || "").slice(0, 200), color: String(b.color || "#6366f1"), createdAt: new Date().toISOString() };
  await saveSpaces(spaces);
  return spaces[id];
});
route("PATCH", "/api/spaces/:id", async (req, p) => {
  const b = await readJSONBody(req);
  const spaces = await getSpaces();
  if (!spaces[p.id]) throw httpError(404, "Space not found");
  if (typeof b.name === "string") spaces[p.id].name = b.name.slice(0, 80);
  if (typeof b.description === "string") spaces[p.id].description = b.description.slice(0, 200);
  if (typeof b.color === "string") spaces[p.id].color = b.color;
  await saveSpaces(spaces);
  return spaces[p.id];
});
route("DELETE", "/api/spaces/:id", async (req, p) => {
  if (p.id === "default") throw httpError(400, "Cannot delete default space");
  const spaces = await getSpaces();
  delete spaces[p.id];
  // Move meetings from deleted space to default
  const all = await listMeetings();
  for (const m of all) if (m.spaceId === p.id) { m.spaceId = "default"; await saveMeeting(m); }
  await saveSpaces(spaces);
  return { ok: true };
});

/* Google Calendar Integration */
route("GET", "/api/calendar/auth-url", async () => {
  if (!GOOGLE_CALENDAR_CLIENT_ID) throw httpError(400, "Google Calendar not configured");
  const state = crypto.randomBytes(16).toString("hex");
  const settings = await getSettings();
  settings.calendarAuthState = state;
  await saveSettings(settings);
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CALENDAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_CALENDAR_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  return { authUrl: authUrl.toString() };
});

route("GET", "/api/calendar/callback", async (req, p, url) => {
  if (!GOOGLE_CALENDAR_CLIENT_ID) throw httpError(400, "Google Calendar not configured");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) throw httpError(400, "No authorization code");
  const settings = await getSettings();
  if (!settings.calendarAuthState || settings.calendarAuthState !== state) throw httpError(400, "Invalid state");

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: GOOGLE_CALENDAR_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: GOOGLE_CALENDAR_REDIRECT_URI,
    }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw httpError(400, "Failed to get tokens: " + (tokenData.error || "unknown"));

  settings.googleCalendarAccessToken = tokenData.access_token;
  settings.googleCalendarRefreshToken = tokenData.refresh_token;
  settings.googleCalendarId = "primary"; // Default calendar
  delete settings.calendarAuthState;
  await saveSettings(settings);

  return {
    __html: true,
    body: `<html><head><title>Connected</title><script>window.location='/#/settings'</script></head><body>Connected to Google Calendar. Redirecting...</body></html>`,
  };
});

route("POST", "/api/calendar/disconnect", async () => {
  const settings = await getSettings();
  delete settings.googleCalendarAccessToken;
  delete settings.googleCalendarRefreshToken;
  delete settings.googleCalendarId;
  await saveSettings(settings);
  return { ok: true };
});

route("POST", "/api/upload", async (req, p, url) => {
  const filename = decodeURIComponent(String(req.headers["x-filename"] || "recording"));
  const mime = String(req.headers["content-type"] || "application/octet-stream");
  if (!/^(audio|video)\//.test(mime)) throw httpError(400, "Please upload an audio or video file.");
  const buf = await readBody(req, MAX_UPLOAD);
  if (!buf.length) throw httpError(400, "Empty file");
  const lines = await transcribeFile(buf, filename, mime);
  const startedAt = new Date().toISOString();
  const m = {
    id: crypto.randomUUID(),
    title: (url.searchParams.get("title") || filename.replace(/\.[^.]+$/, "")).slice(0, 120),
    platform: "upload",
    platformName: "Uploaded recording",
    source: "upload",
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + ((lines[lines.length - 1] || {}).t || 0)).toISOString(),
    entries: lines.filter((l) => l.text).map((l) => ({ id: crypto.randomUUID(), speaker: l.speaker, text: l.text, t: l.t, at: startedAt, highlight: false, note: "" })),
    screenshots: [],
    participants: [],
    tags: ["upload"],
    ai: [],
    comments: [],
    spaceId: "default",
    createdAt: startedAt,
  };
  await saveMeeting(m);
  onMeetingEnded(m).catch((e) => console.error("auto-summary:", e.message));
  return { id: m.id };
});

route("GET", "/api/meetings/:id/export", async (req, p, url) => {
  const m = await getMeeting(p.id);
  if (!m) throw httpError(404, "Meeting not found");
  const fmt = url.searchParams.get("format") || "txt";
  return { __file: true, ...exportMeeting(m, fmt) };
});

function exportMeeting(m, fmt) {
  const safe = (m.title || "meeting").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "meeting";
  const when = new Date(m.startedAt).toLocaleString("en-GB");
  if (fmt === "json") return { name: safe + ".json", type: "application/json", body: JSON.stringify(m, null, 2) };
  if (fmt === "srt") {
    const ts = (ms) => {
      const d = new Date(ms);
      return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")},${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
    };
    const es = m.entries.filter((e) => !e.speaker.startsWith("📷"));
    const body = es.map((e, i) => `${i + 1}\n${ts(e.t)} --> ${ts(es[i + 1] ? es[i + 1].t : e.t + 4000)}\n${e.speaker}: ${e.text}\n`).join("\n");
    return { name: safe + ".srt", type: "text/plain", body };
  }
  if (fmt === "md") {
    let md = `# ${m.title}\n\n*${when} · ${m.platformName || ""}*  \n**Participants:** ${(m.participants || speakersOf(m)).join(", ")}\n\n`;
    for (const a of m.ai || []) md += `## ${a.name}\n\n${a.text}\n\n`;
    if (m.notes) md += `## My notes\n\n${m.notes}\n\n`;
    md += `## Transcript\n\n` + m.entries.map((e) => `**${e.speaker}** \`${fmtOffset(e.t)}\`${e.highlight ? " ★" : ""}  \n${e.text}${e.note ? `  \n> ${e.note}` : ""}\n`).join("\n");
    return { name: safe + ".md", type: "text/markdown", body: md };
  }
  if (fmt === "doc") {
    // Word opens HTML saved as .doc — good enough for sharing without extra packages.
    const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const mdToHtml = (t) => esc(t).replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/^# (.*)$/gm, "<h2>$1</h2>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^\s*[-*] \[ \] (.*)$/gm, "<p>☐ $1</p>").replace(/^\s*[-*] (.*)$/gm, "<p>• $1</p>").replace(/\n/g, "<br>");
    let h = `<html><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial;font-size:11pt}h1{color:#14213d}.s{color:#14213d;font-weight:bold}.t{color:#888;font-size:9pt}</style></head><body><h1>${esc(m.title)}</h1><p>${esc(when)} · ${esc(m.platformName || "")}</p>`;
    for (const a of m.ai || []) h += `<h2>${esc(a.name)}</h2>${mdToHtml(a.text)}`;
    h += `<h2>Transcript</h2>` + m.entries.map((e) => `<p><span class="s">${esc(e.speaker)}</span> <span class="t">${fmtOffset(e.t)}</span><br>${esc(e.text)}</p>`).join("");
    return { name: safe + ".doc", type: "application/msword", body: h + "</body></html>" };
  }
  const body = `${m.title}\n${when} · ${m.platformName || ""}\nParticipants: ${(m.participants || speakersOf(m)).join(", ")}\n\n` + m.entries.map((e) => `[${fmtOffset(e.t)}] ${e.speaker}: ${e.text}${e.note ? `\n    Note: ${e.note}` : ""}`).join("\n");
  return { name: safe + ".txt", type: "text/plain", body };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, x-majlis-token, x-filename");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("x-content-type-options", "nosniff");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith("/api/")) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = pathname.match(r.re);
        if (!match) continue;
        if (!r.open && !authed(req)) throw httpError(401, "Wrong or missing access key.");
        const params = Object.fromEntries(r.keys.map((k, i) => [k, match[i + 1]]));
        const out = await r.handler(req, params, url);
        if (out && out.__file) {
          res.writeHead(200, { "content-type": out.type + "; charset=utf-8", "content-disposition": `attachment; filename="${out.name}"` });
          return res.end(out.body);
        }
        return sendJSON(res, 200, out);
      }
      throw httpError(404, "Not found");
    }
    if (pathname.startsWith("/shots/")) {
      const name = path.basename(pathname);
      if (!/^[\w-]+\.(png|jpg)$/.test(name)) throw httpError(404, "Not found");
      return serveFile(res, path.join(DATA, "shots", name), { "cache-control": "private, max-age=86400" });
    }
    if (pathname.startsWith("/s/")) return serveFile(res, path.join(PUBLIC, "share.html"));
    const file = path.normalize(path.join(PUBLIC, pathname === "/" ? "index.html" : pathname));
    if (!file.startsWith(PUBLIC)) throw httpError(404, "Not found");
    return serveFile(res, file);
  } catch (e) {
    if (!e.status) console.error(e);
    sendJSON(res, e.status || 500, { error: e.status ? e.message : "Server error" });
  }
});

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  Majlis Notes is running → http://localhost:${PORT}`);
    console.log(`  Data folder: ${DATA}`);
    console.log(`  AI summaries: ${ANTHROPIC_API_KEY ? "ON (" + ANTHROPIC_MODEL + ")" : "OFF — add ANTHROPIC_API_KEY to .env"}`);
    console.log(`  Recording upload: ${DEEPGRAM_API_KEY ? "Deepgram" : OPENAI_API_KEY ? "OpenAI Whisper" : "OFF — add DEEPGRAM_API_KEY or OPENAI_API_KEY"}`);
    if (!TOKEN) console.log("  ⚠  No MAJLIS_TOKEN set — anyone who can reach this server can read your meetings.\n");
  });
}
module.exports = { server, mergeMeeting, exportMeeting };
