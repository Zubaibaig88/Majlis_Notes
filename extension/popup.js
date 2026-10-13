const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(res || { ok: false })));
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const fmtOffset = (ms) => { const s = Math.floor(ms / 1000); return pad(Math.floor(s / 60)) + ":" + pad(s % 60); };

if (location.hash) document.body.classList.add("page");
if (location.hash === "#welcome") $("#welcome").hidden = false;

function showTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll("section").forEach((s) => s.classList.toggle("on", s.id === name));
  if (name === "history") loadHistory();
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
if (location.hash === "#settings") showTab("settings");

/* ---------- Now ---------- */
async function loadNow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const card = $("#nowCard");
  if (!tab || !/meet\.google\.com|teams\.(microsoft|live)\.com|zoom\.us/.test(tab.url || "")) {
    card.innerHTML = `<b>No meeting in this tab</b><div class="muted">Open a Google Meet, Teams or Zoom web meeting. Majlis Notes will start when you join.</div>`;
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "fn:status" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      card.innerHTML = `<b>Reload the meeting tab</b><div class="muted">Majlis Notes was installed after this tab opened.</div>`;
      return;
    }
    card.innerHTML = res.running
      ? `<b>● Transcribing</b><div class="muted">${esc(res.title)} · ${res.lines} lines</div>
         <div class="row" style="margin-top:10px"><button class="btn" id="show">Show panel</button><button class="btn" id="stop">Stop &amp; save</button></div>`
      : `<b>${esc(res.platform)}</b><div class="muted">Not transcribing right now.</div>
         <div class="row" style="margin-top:10px"><button class="btn primary" id="start">Start transcribing</button></div>`;
    const go = (type) => chrome.tabs.sendMessage(tab.id, { type }, () => setTimeout(loadNow, 400));
    $("#start") && $("#start").addEventListener("click", () => go("fn:start"));
    $("#show") && $("#show").addEventListener("click", () => go("fn:start"));
    $("#stop") && $("#stop").addEventListener("click", () => go("fn:stop"));
  });
}
$("#openDash").addEventListener("click", () => send({ type: "fn:openDashboard" }));

/* ---------- History ---------- */
async function loadHistory() {
  const { index = [] } = await send({ type: "fn:list" });
  $("#histCount").textContent = index.length + " meetings on this computer";
  const list = $("#list");
  if (!index.length) {
    list.innerHTML = `<li class="empty muted">No transcripts yet.</li>`;
    return;
  }
  list.innerHTML = index
    .map(
      (m) => `<li class="m" data-id="${m.id}">
      <b>${esc(m.title)}</b>
      <span class="muted">${new Date(m.startedAt).toLocaleString()} · ${m.lines} lines</span>
      <span class="badge ${m.synced ? "" : "no"}">${m.synced ? "Synced" : "Not synced"}</span>
      <div class="row"><button class="btn" data-a="open">Open</button><button class="btn" data-a="copy">Copy</button><button class="btn" data-a="txt">.txt</button><button class="btn" data-a="del">Delete</button></div>
    </li>`
    )
    .join("");
}
$("#list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-a]");
  if (!b) return;
  const id = b.closest("li").dataset.id;
  if (b.dataset.a === "open") return send({ type: "fn:openDashboard", meetingId: id });
  if (b.dataset.a === "del") {
    if (!confirm("Delete this transcript from this computer? (The server copy stays.)")) return;
    await send({ type: "fn:delete", id });
    return loadHistory();
  }
  const { meeting: m } = await send({ type: "fn:get", id });
  if (!m) return;
  const text = `${m.title}\n${new Date(m.startedAt).toLocaleString()}\n\n` + m.entries.map((x) => `[${fmtOffset(x.t)}] ${x.speaker}: ${x.text}`).join("\n");
  if (b.dataset.a === "copy") {
    await navigator.clipboard.writeText(text);
    b.textContent = "Copied";
  } else {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    chrome.downloads.download({ url, filename: (m.title || "meeting").replace(/[^\w\- ]+/g, "").slice(0, 60) + ".txt" });
  }
});
$("#syncAll").addEventListener("click", async () => {
  $("#syncAll").textContent = "Syncing…";
  await send({ type: "fn:syncAll" });
  $("#syncAll").textContent = "⟳ Sync now";
  loadHistory();
});

/* ---------- Settings ---------- */
const FIELDS = ["serverUrl", "token", "notifyMessage"];
const CHECKS = ["enabled", "autoStart", "autoCaptions", "showPanel", "startMinimized"];
async function loadSettings() {
  const { settings } = await send({ type: "fn:getSettings" });
  FIELDS.forEach((f) => ($("#" + f).value = settings[f] || ""));
  CHECKS.forEach((f) => ($("#" + f).checked = settings[f] !== false && !!settings[f]));
}
function readSettings() {
  const s = {};
  FIELDS.forEach((f) => (s[f] = $("#" + f).value.trim()));
  CHECKS.forEach((f) => (s[f] = $("#" + f).checked));
  return s;
}
$("#save").addEventListener("click", async () => {
  await send({ type: "fn:setSettings", settings: readSettings() });
  $("#msg").textContent = "Saved ✓";
});
$("#test").addEventListener("click", async () => {
  await send({ type: "fn:setSettings", settings: readSettings() });
  $("#msg").textContent = "Testing…";
  const res = await send({ type: "fn:ping" });
  $("#msg").textContent = res.ok
    ? `Connected ✓ — AI is ${res.server.ai ? "ready" : "not set up (add ANTHROPIC_API_KEY on the server)"}`
    : "Could not connect: " + (res.error || "unknown error");
});

loadNow();
loadSettings();
