/*
 * Majlis Notes – background service worker.
 * Saves transcripts on this computer, syncs them to your Majlis Notes server,
 * takes screenshots and calls the AI.
 */
const DEFAULTS = {
  enabled: true,
  autoStart: true,
  autoCaptions: true,
  showPanel: true,
  startMinimized: false,
  serverUrl: "http://localhost:8787",
  token: "",
  notifyMessage: "Hi all — I'm using Majlis Notes to transcribe this meeting so I can focus on the conversation.",
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

async function api(path, options = {}) {
  const s = await getSettings();
  const base = (s.serverUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("Set your Majlis Notes server address in Settings.");
  const res = await fetch(base + path, {
    ...options,
    headers: { "content-type": "application/json", "x-majlis-token": s.token || "", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

/* ---------- local storage ---------- */
async function saveLocal(meeting) {
  const { index = [] } = await chrome.storage.local.get("index");
  const summary = {
    id: meeting.id,
    title: meeting.title,
    platformName: meeting.platformName,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    lines: meeting.entries.length,
    synced: false,
  };
  const i = index.findIndex((m) => m.id === meeting.id);
  if (i >= 0) index[i] = { ...index[i], ...summary };
  else index.unshift(summary);
  await chrome.storage.local.set({ index: index.slice(0, 500), ["m:" + meeting.id]: meeting });
}

async function markSynced(id, ok) {
  const { index = [] } = await chrome.storage.local.get("index");
  const m = index.find((x) => x.id === id);
  if (m) {
    m.synced = ok;
    await chrome.storage.local.set({ index });
  }
}

/* ---------- sync (debounced per meeting) ---------- */
const pending = new Map();
function queueSync(meeting, immediate) {
  clearTimeout(pending.get(meeting.id));
  const run = async () => {
    pending.delete(meeting.id);
    try {
      const { ["m:" + meeting.id]: latest } = await chrome.storage.local.get("m:" + meeting.id);
      await api("/api/meetings", { method: "POST", body: JSON.stringify(latest || meeting) });
      await markSynced(meeting.id, true);
    } catch (e) {
      await markSynced(meeting.id, false);
    }
  };
  if (immediate) return run();
  pending.set(meeting.id, setTimeout(run, 8000));
}

/* Retry anything that failed to sync (e.g. server was off). */
async function retryUnsynced() {
  const { index = [] } = await chrome.storage.local.get("index");
  for (const m of index.filter((x) => !x.synced).slice(0, 10)) {
    const { ["m:" + m.id]: full } = await chrome.storage.local.get("m:" + m.id);
    if (full) await queueSync(full, true);
  }
}
chrome.alarms && chrome.alarms.create && chrome.alarms.create("fn-retry", { periodInMinutes: 5 });
chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener((a) => a.name === "fn-retry" && retryUnsynced());

/* ---------- messages ---------- */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg.type) {
        case "fn:getSettings":
          return reply({ ok: true, settings: await getSettings() });

        case "fn:setSettings": {
          const settings = { ...(await getSettings()), ...msg.settings };
          await chrome.storage.local.set({ settings });
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "fn:settings", settings }).catch(() => {});
          return reply({ ok: true, settings });
        }

        case "fn:save":
          await saveLocal(msg.meeting);
          queueSync(msg.meeting, msg.final);
          return reply({ ok: true });

        case "fn:screenshot": {
          const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
          return reply({ ok: true, dataUrl });
        }

        case "fn:ai": {
          await saveLocal(msg.meeting);
          await api("/api/meetings", { method: "POST", body: JSON.stringify(msg.meeting) });
          await markSynced(msg.meeting.id, true);
          const out = await api(`/api/meetings/${msg.meeting.id}/ai`, {
            method: "POST",
            body: JSON.stringify({ promptId: msg.promptId, prompt: msg.prompt }),
          });
          return reply({ ok: true, text: out.text });
        }

        case "fn:openDashboard": {
          const s = await getSettings();
          const base = s.serverUrl.replace(/\/+$/, "");
          chrome.tabs.create({ url: base + (msg.meetingId ? `/#/m/${msg.meetingId}` : "/") });
          return reply({ ok: true });
        }

        case "fn:list": {
          const { index = [] } = await chrome.storage.local.get("index");
          return reply({ ok: true, index });
        }

        case "fn:get": {
          const { ["m:" + msg.id]: m } = await chrome.storage.local.get("m:" + msg.id);
          return reply({ ok: true, meeting: m });
        }

        case "fn:delete": {
          const { index = [] } = await chrome.storage.local.get("index");
          await chrome.storage.local.set({ index: index.filter((m) => m.id !== msg.id) });
          await chrome.storage.local.remove("m:" + msg.id);
          return reply({ ok: true });
        }

        case "fn:syncAll":
          await retryUnsynced();
          return reply({ ok: true });

        case "fn:audioChunk": {
          // Send audio chunks to server for transcription
          try {
            await api(`/api/meetings/${msg.meetingId}/audio`, {
              method: "POST",
              body: JSON.stringify({ audio: msg.audio }),
              headers: { "content-type": "application/json" },
            });
          } catch (e) {
            // Log but don't fail - audio transcription is best-effort
            console.log("Audio upload error:", e.message);
          }
          return reply({ ok: true });
        }

        case "fn:ping":
          return reply({ ok: true, server: await api("/api/health") });

        default:
          return reply({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      reply({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === "install") {
    await chrome.storage.local.set({ settings: DEFAULTS });
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html#welcome") });
  }
});
