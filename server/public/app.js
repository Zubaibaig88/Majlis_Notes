/* Majlis Notes dashboard */
const { esc, fmtOffset, fmtDuration, colorFor, initials, md, speakerStats } = FN;
const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const state = { tag: "", folder: "", space: "", q: "", prompts: [], current: null };

/* ---------------- API ---------------- */
const getKey = () => {
  try { return localStorage.getItem("fn-key") || ""; } catch { return ""; }
};
const setKey = (k) => { try { localStorage.setItem("fn-key", k); } catch {} };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", "x-majlis-token": getKey(), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await askKey();
    return api(path, opts);
  }
  if (!res.ok) throw new Error(data.error || "Error " + res.status);
  return data;
}

let keyPrompt = null;
function askKey() {
  if (keyPrompt) return keyPrompt;
  return (keyPrompt = new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal keymodal";
    m.innerHTML = `<form class="box form"><h3>Enter your access key</h3>
      <div class="help">This is the MAJLIS_TOKEN from the server's .env file.</div>
      <input type="password" autofocus style="margin-top:12px">
      <div style="margin-top:14px;text-align:right"><button class="btn primary">Continue</button></div></form>`;
    document.body.appendChild(m);
    m.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      setKey(m.querySelector("input").value.trim());
      m.remove();
      keyPrompt = null;
      resolve();
    });
  }));
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function popMenu(anchor, items) {
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  const menu = document.createElement("div");
  menu.className = "menu";
  items.forEach(([label, fn]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => (menu.remove(), fn());
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + window.scrollY + 6 + "px";
  menu.style.left = Math.min(r.left + window.scrollX, window.innerWidth - 220) + "px";
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

const avatar = (name) => `<span class="av" style="background:${colorFor(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;
const loading = (t = "Loading…") => `<div class="loading"><span class="spin"></span>${esc(t)}</div>`;

/* ---------------- Router ---------------- */
async function router() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [, page, id] = h.split("/");
  document.querySelectorAll("[data-r]").forEach((a) => a.classList.toggle("on", a.dataset.r === (page || "home") || (page === "m" && a.dataset.r === "home")));
  window.scrollTo(0, 0);
  document.querySelectorAll(".modal:not(.keymodal), .menu, .lightbox").forEach((x) => x.remove());
  try {
    if (page === "m" && id) return await pageMeeting(id);
    if (page === "prompts") return await pagePrompts();
    if (page === "upload") return await pageUpload();
    if (page === "settings") return await pageSettings();
    return await pageHome();
  } catch (e) {
    view.innerHTML = `<div class="empty"><b>Something went wrong</b>${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", router);

/* ---------------- Sidebar ---------------- */
async function loadSidebar() {
  const s = await api("/api/stats");

  // Spaces
  const spacesList = Object.values(s.spaces || {});
  if ($("#spaces")) {
    const spacesHTML = (spacesList.length
      ? spacesList.map((sp) => `<span class="chip ${state.space === sp.id ? "on" : ""}" data-space="${esc(sp.id)}" title="${esc(sp.description || "")}">📂 ${esc(sp.name)}</span>`).join("")
      : `<span style="padding:0 10px;font-size:12px;color:#8f9ab4">No spaces yet</span>`) +
      `<button class="btn sm" id="create-space-btn" style="margin-top:8px;width:100%;font-size:12px;padding:6px">+ Create space</button>`;
    $("#spaces").innerHTML = spacesHTML;

    // Create space button handler
    const createBtn = $("#create-space-btn");
    if (createBtn) {
      createBtn.onclick = async () => {
        const name = prompt("Space name (e.g., 'Client Calls')");
        if (!name) return;
        const desc = prompt("Description (optional)", "");
        try {
          await api("/api/spaces", {
            method: "POST",
            body: JSON.stringify({ name: name.trim(), description: desc.trim() }),
          });
          toast("Space created");
          loadSidebar();
          pageHome();
        } catch (e) {
          toast("Error: " + e.message);
        }
      };
    }
  }

  // Folders
  $("#folders").innerHTML = s.folders.length
    ? s.folders.map((f) => `<span class="chip ${state.folder === f ? "on" : ""}" data-folder="${esc(f)}">📁 ${esc(f)}</span>`).join("")
    : `<span style="padding:0 10px;font-size:12px;color:#8f9ab4">No folders yet</span>`;

  // Tags
  $("#tags").innerHTML = s.tags.length
    ? s.tags.map((t) => `<span class="chip ${state.tag === t ? "on" : ""}" data-tag="${esc(t)}"># ${esc(t)}</span>`).join("")
    : `<span style="padding:0 10px;font-size:12px;color:#8f9ab4">No tags yet</span>`;
  return s;
}
document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-folder]");
  const t = e.target.closest("[data-tag]");
  const sp = e.target.closest("[data-space]");
  if (f && f.closest(".side")) (state.folder = state.folder === f.dataset.folder ? "" : f.dataset.folder), (location.hash = "#/"), router();
  if (t && t.closest(".side")) (state.tag = state.tag === t.dataset.tag ? "" : t.dataset.tag), (location.hash = "#/"), router();
  if (sp && sp.closest(".side")) (state.space = state.space === sp.dataset.space ? "" : sp.dataset.space), (location.hash = "#/"), router();
});

/* ---------------- Home ---------------- */
async function pageHome() {
  view.innerHTML = loading();
  const stats = await loadSidebar();
  view.innerHTML = `
    <div class="top">
      <h1>Meetings</h1>
      <div class="search"><input type="search" id="q" placeholder="Search titles, transcripts and AI notes…" value="${esc(state.q)}"></div>
      <a class="btn gold" href="#/upload">⬆ Upload recording</a>
    </div>
    <div class="cards">
      <div class="card stat"><div class="n">${stats.meetings}</div><div class="l">Meetings saved</div></div>
      <div class="card stat"><div class="n">${stats.thisWeek}</div><div class="l">Meetings this week</div></div>
      <div class="card stat"><div class="n">${stats.hoursWeek.toFixed(1)}</div><div class="l">Hours in meetings this week</div></div>
      <div class="card stat"><div class="n">${stats.words.toLocaleString()}</div><div class="l">Words transcribed</div></div>
    </div>
    <div id="filters"></div>
    <div id="list">${loading()}</div>`;
  const q = $("#q");
  let t;
  q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => ((state.q = q.value), loadList()), 250);
  });
  loadList();
}

async function loadList() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.tag) p.set("tag", state.tag);
  if (state.folder) p.set("folder", state.folder);
  if (state.space) p.set("space", state.space);
  const filters = [state.space && `📂 Space: ${state.space}`, state.tag && `# ${state.tag}`, state.folder && `📁 ${state.folder}`].filter(Boolean);
  $("#filters").innerHTML = filters.length
    ? `<div style="margin-bottom:10px">Showing ${filters.map((f) => `<span class="chip gold">${esc(f)}</span>`).join(" ")} <button class="btn sm" id="clearf">Clear</button></div>`
    : "";
  $("#clearf") && ($("#clearf").onclick = () => ((state.tag = state.folder = state.space = ""), pageHome()));
  const { meetings } = await api("/api/meetings?" + p);
  const list = $("#list");
  if (!list) return;
  if (!meetings.length) {
    list.innerHTML = state.q || filters.length
      ? `<div class="empty"><b>No matches</b>Try another word.</div>`
      : `<div class="empty"><b>No meetings yet</b>Install the Majlis Notes extension and join a Google Meet call, or upload a recording.</div>`;
    return;
  }
  const groups = {};
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 864e5).toDateString();
  for (const m of meetings) {
    const d = new Date(m.startedAt);
    const key = d.toDateString() === today ? "Today" : d.toDateString() === yest ? "Yesterday" : Date.now() - d < 7 * 864e5 ? "This week" : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    (groups[key] = groups[key] || []).push(m);
  }
  const term = state.q.toLowerCase();
  const mark = (s) => (term ? esc(s).replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (x) => `<mark>${x}</mark>`) : esc(s));
  list.innerHTML = Object.entries(groups)
    .map(
      ([g, ms]) => `<div class="group-title">${esc(g)}</div><div class="mlist">${ms
        .map(
          (m) => {
            const dur = fmtDuration(m.durationMs);
            const durMins = Math.round(m.durationMs / 60000);
            return `<a class="mrow" href="#/m/${m.id}">
              <div class="left">
                <div class="badge">${durMins}m</div>
                <div class="info">
                  <div class="t">${mark(m.title || "Untitled meeting")}</div>
                  <div class="meta">
                    <span>${new Date(m.startedAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                    <span>${m.platformName || "Meeting"}</span>
                    <span>${m.lines} lines</span>
                  </div>
                  <div class="attendees">
                    <span class="avatars">${m.speakers.slice(0, 4).map(avatar).join("")}${m.speakers.length > 4 ? `<span class="av" style="background:#cbd5e1">+${m.speakers.length - 4}</span>` : ""}</span>
                    ${m.hasSummary ? `<span class="chip green">✦</span>` : ""}
                    ${m.highlights ? `<span class="chip">${m.highlights} ★</span>` : ""}
                  </div>
                </div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                ${m.shareId ? `<span style="color:var(--muted);font-size:12px">🔗</span>` : ""}
              </div>
            </a>`;
          }
        )
        .join("")}</div>`
    )
    .join("");
}

/* ---------------- Meeting ---------------- */
async function pageMeeting(id) {
  view.innerHTML = loading();
  const [{ meeting: m }, { prompts }, spaces] = await Promise.all([api("/api/meetings/" + id), api("/api/prompts"), api("/api/spaces"), loadSidebar()]);
  state.current = m;
  state.prompts = prompts;
  const stats = speakerStats(m.entries);
  const dur = m.endedAt ? new Date(m.endedAt) - new Date(m.startedAt) : (m.entries[m.entries.length - 1] || {}).t || 0;
  const currentSpace = (spaces || []).find((s) => s.id === (m.spaceId || "default")) || { id: "default", name: "My Meetings" };

  view.innerHTML = `
    <div class="mpage">
      <div class="mpage-main">
        <div class="mpage-head">
          <a href="#/" class="btn sm" style="margin-bottom:10px">← All meetings</a>
          <h1 contenteditable="true" spellcheck="false" id="title">${esc(m.title || "Untitled meeting")}</h1>
          <div class="meta">
            <span>📅 ${new Date(m.startedAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}</span>
            <span>⏱ ${fmtDuration(dur)}</span>
            <span>${esc(m.platformName || "")}</span>
          </div>
          <div class="tagbox" id="tagbox"></div>
          <div class="actions">
            <button class="btn primary" id="share">🔗 ${m.shareId ? "Shared link" : "Share"}</button>
            <button class="btn" id="export">⬇ Export</button>
            <button class="btn" id="copy">⧉ Copy transcript</button>
            <button class="btn" id="push">➤ Send to…</button>
            <button class="btn" id="folder">📁 ${m.folder ? esc(m.folder) : "Move to folder"}</button>
            <button class="btn danger" id="del">Delete</button>
          </div>
        </div>

        <div class="tabs">
          <button class="tab on" data-tab="transcript">📝 Transcript</button>
          <button class="tab" data-tab="ai">✦ AI</button>
          <button class="tab" data-tab="notes">💬 Notes & Comments</button>
        </div>

        <div class="tab-content" id="tab-transcript">
          <div class="trbar">
            <input type="search" id="tq" placeholder="Search in this transcript…">
            <select id="spk"><option value="">All speakers</option>${stats.map((s) => `<option>${esc(s.speaker)}</option>`).join("")}</select>
            <label class="chip"><input type="checkbox" id="onlyhl"> ★ Highlights only</label>
          </div>
          <div class="lines" id="lines"></div>
        </div>

        <div class="tab-content" id="tab-ai" style="display:none">
          <div style="margin-bottom:16px">
            <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">Ask AI about this meeting</h3>
            <div class="prompts" id="prompts">${prompts.map((p) => `<button class="btn" data-p="${esc(p.id)}" title="${esc(p.text.slice(0, 200))}">${esc(p.icon || "◆")} ${esc(p.name)}</button>`).join("")}</div>
            <form class="ask" id="ask"><input placeholder="Ask anything about this meeting…"><button class="btn primary">Ask</button></form>
          </div>
          <div id="ai"></div>
        </div>

        <div class="tab-content" id="tab-notes" style="display:none">
          <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">📝 My Notes</h3>
          <textarea class="notes" id="notes" placeholder="Private notes — the AI reads these too." style="width:100%;min-height:120px;padding:10px;border:1px solid var(--line);border-radius:6px;font-family:inherit;font-size:14px;resize:vertical">${esc(m.notes || "")}</textarea>

          <div style="margin-top:24px">
            <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">💬 Comments</h3>
            <form id="comment-form" style="display:flex;gap:8px;margin-bottom:16px">
              <input type="text" id="comment-text" placeholder="Add a comment…" style="flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px">
              <button type="submit" class="btn primary" style="padding:8px 16px">Post</button>
            </form>
            ${(m.comments || []).length ? `<div style="display:flex;flex-direction:column;gap:12px">${m.comments.map((c) => `<div style="padding:10px;background:var(--soft);border-radius:6px;font-size:13px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><b>${esc(c.author)}</b><small style="color:var(--muted)">${new Date(c.at).toLocaleString()}</small></div><p style="margin:0">${esc(c.text)}</p></div>`).join("")}</div>` : `<p style="color:var(--muted);font-size:13px">No comments yet. Start the conversation!</p>`}
          </div>
        </div>
      </div>

      <div class="mpage-side">
        <div class="panel">
          <h6>Meeting info</h6>
          <div class="info-row">
            <b>Participants</b>
            <div style="flex:1">
              <div class="participants">
                ${(m.participants && m.participants.length ? m.participants : stats.map((s) => s.speaker)).map((p) => avatar(p)).join("")}
              </div>
              <div style="font-size:12px;color:var(--muted);margin-top:6px">${esc((m.participants && m.participants.length ? m.participants : stats.map((s) => s.speaker)).join(", ") || "—")}</div>
            </div>
          </div>
          <div class="info-row">
            <b>Platform</b>
            <span>${esc(m.platformName || "—")}</span>
          </div>
          ${m.url ? `<div class="info-row"><b>Link</b><a href="${esc(m.url)}" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:none;font-size:12px">Open meeting ↗</a></div>` : ""}
        </div>

        <div class="panel">
          <h6>Organization</h6>
          <div class="space-selector" id="space-selector">
            <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Current space</div>
            <div style="font-weight:600;color:var(--ink)">${esc(currentSpace.name)}</div>
          </div>
        </div>

        <div class="panel">
          <h6>Stats</h6>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${stats.length ? stats.slice(0, 5).map((s) => `<div class="info-row" style="margin-bottom:0"><b>${esc(s.speaker)}</b><span style="flex:1;text-align:right;color:var(--muted);font-size:12px">${s.pct}%</span></div>`).join("") : `<span class="help">No speech yet.</span>`}
          </div>
        </div>
      </div>
    </div>`;

  // Render content
  renderTags();
  renderLines();
  renderAI();

  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("on"));
      tab.classList.add("on");
      document.querySelectorAll("[id^='tab-']").forEach((t) => (t.style.display = "none"));
      $("#tab-" + tab.dataset.tab).style.display = "block";
    });
  });

  // Title editing
  const title = $("#title");
  title.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), title.blur()));
  title.addEventListener("blur", async () => {
    const v = title.textContent.trim();
    if (v && v !== m.title) {
      await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ title: v }) });
      m.title = v;
      toast("Renamed");
    }
  });

  // Notes autosave
  let nt;
  $("#notes").addEventListener("input", (e) => {
    clearTimeout(nt);
    nt = setTimeout(() => api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ notes: e.target.value }) }), 700);
  });

  // Comment submission
  const commentForm = $("#comment-form");
  if (commentForm) {
    commentForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $("#comment-text");
      const text = input.value.trim();
      if (!text) return;
      try {
        const result = await api("/api/meetings/" + m.id + "/comments", {
          method: "POST",
          body: JSON.stringify({ text, author: "Me" }),
        });
        m.comments = result.comments || [];
        input.value = "";
        // Refresh the comments display
        const commentsDiv = document.querySelectorAll("[id='tab-notes']")[0].querySelector("div:last-child");
        if (commentsDiv) {
          commentsDiv.innerHTML = `<h3 style="margin:0 0 12px;font-size:15px;font-weight:600">💬 Comments</h3>
            <form id="comment-form" style="display:flex;gap:8px;margin-bottom:16px">
              <input type="text" id="comment-text" placeholder="Add a comment…" style="flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px">
              <button type="submit" class="btn primary" style="padding:8px 16px">Post</button>
            </form>
            <div style="display:flex;flex-direction:column;gap:12px">${m.comments.map((c) => `<div style="padding:10px;background:var(--soft);border-radius:6px;font-size:13px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><b>${esc(c.author)}</b><small style="color:var(--muted)">${new Date(c.at).toLocaleString()}</small></div><p style="margin:0">${esc(c.text)}</p></div>`).join("")}</div>`;
          // Re-attach the comment form handler
          const newForm = document.querySelectorAll("[id='tab-notes']")[0].querySelector("#comment-form");
          if (newForm) newForm.addEventListener("submit", arguments.callee);
        }
        toast("Comment added");
      } catch (err) {
        toast("Error posting comment");
      }
    });
  }

  // Transcript filters
  ["tq", "spk", "onlyhl"].forEach((x) => $("#" + x).addEventListener("input", renderLines));

  // AI prompts
  $("#prompts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]");
    if (b) runAI({ promptId: b.dataset.p }, b.textContent.trim());
  });
  $("#ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#ask input");
    if (inp.value.trim()) runAI({ question: inp.value.trim() }, "Q: " + inp.value.trim());
    inp.value = "";
  });

  // Action handlers
  $("#copy").onclick = async () => {
    await navigator.clipboard.writeText(m.entries.map((e) => `[${fmtOffset(e.t)}] ${e.speaker}: ${e.text}`).join("\n"));
    toast("Transcript copied");
  };
  $("#export").onclick = (e) =>
    popMenu(e.currentTarget, [
      ["Word document (.doc)", () => download("doc")],
      ["Markdown (.md) — for Notion / Obsidian", () => download("md")],
      ["Plain text (.txt)", () => download("txt")],
      ["Subtitles (.srt)", () => download("srt")],
      ["Data (.json)", () => download("json")],
      ["Copy for Google Docs", copyRich],
    ]);
  $("#push").onclick = (e) =>
    popMenu(e.currentTarget, [
      ["Slack", () => push("slack")],
      ["Webhook (Zapier / Make / n8n)", () => push("webhook")],
      ["Email (opens your mail app)", emailIt],
    ]);
  $("#share").onclick = shareDialog;
  $("#folder").onclick = async () => {
    const v = prompt("Folder name (leave empty to remove)", m.folder || "");
    if (v === null) return;
    await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ folder: v }) });
    m.folder = v.trim();
    $("#folder").textContent = "📁 " + (m.folder || "Move to folder");
    loadSidebar();
  };

  // Space selector
  $("#space-selector").onclick = async () => {
    const spaceList = spaces || [];
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `<div class="box" style="max-width:400px">
      <h3>Select a space</h3>
      <div style="display:flex;flex-direction:column;gap:8px;margin:16px 0">
        ${spaceList.map((s) => `<button class="btn ${m.spaceId === s.id ? "primary" : ""}" data-space-id="${esc(s.id)}" style="text-align:left;background:${s.id === (m.spaceId || "default") ? "var(--primary)" : "var(--line)"};color:${s.id === (m.spaceId || "default") ? "#fff" : "var(--ink)"}">
          <strong>${esc(s.name)}</strong>
          ${s.description ? `<div style="font-size:12px;opacity:0.8">${esc(s.description)}</div>` : ""}
        </button>`).join("")}
      </div>
      <div style="text-align:right"><button class="btn" id="close-space-modal">Close</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelectorAll("[data-space-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ spaceId: btn.dataset.spaceId }) });
        m.spaceId = btn.dataset.spaceId;
        toast("Space updated");
        modal.remove();
        // Refresh the space info
        const newSpace = spaceList.find((s) => s.id === m.spaceId) || { id: "default", name: "My Meetings" };
        $("#space-selector").innerHTML = `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">Current space</div><div style="font-weight:600;color:var(--ink)">${esc(newSpace.name)}</div>`;
      });
    });
    $("#close-space-modal").onclick = () => modal.remove();
  };

  $("#del").onclick = async () => {
    if (!confirm("Delete this meeting for good? This cannot be undone.")) return;
    await api("/api/meetings/" + m.id, { method: "DELETE" });
    toast("Deleted");
    location.hash = "#/";
  };
}

function renderTags() {
  const m = state.current;
  const box = $("#tagbox");
  box.innerHTML =
    (m.tags || []).map((t) => `<span class="chip"># ${esc(t)} <span class="x" data-x="${esc(t)}">×</span></span>`).join("") +
    `<input placeholder="+ add tag" id="tagin">`;
  box.onclick = async (e) => {
    const x = e.target.closest("[data-x]");
    if (!x) return;
    m.tags = m.tags.filter((t) => t !== x.dataset.x);
    await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ tags: m.tags }) });
    renderTags();
    loadSidebar();
  };
  $("#tagin").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    m.tags = Array.from(new Set([...(m.tags || []), e.target.value.trim()]));
    await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ tags: m.tags }) });
    renderTags();
    loadSidebar();
    $("#tagin").focus();
  });
}

function renderLines() {
  const m = state.current;
  const q = ($("#tq").value || "").toLowerCase().trim();
  const spk = $("#spk").value;
  const only = $("#onlyhl").checked;
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
  const comments = (m.comments || []).filter((c) => c.entryId);
  const rows = m.entries.filter((e) => (!spk || e.speaker === spk) && (!only || e.highlight) && (!q || e.text.toLowerCase().includes(q) || e.speaker.toLowerCase().includes(q)));
  $("#lines").innerHTML = rows.length
    ? rows
        .map((e) => {
          const shot = typeof e.screenshot === "number" && m.screenshots[e.screenshot];
          const isShot = e.speaker.startsWith("📷");
          return `<div class="line ${e.highlight ? "hl" : ""}" data-id="${e.id}">
            ${isShot ? `<span class="av" style="background:#64748b;margin:0">📷</span>` : `<span class="av" style="margin:0;background:${colorFor(e.speaker)}">${esc(initials(e.speaker))}</span>`}
            <div>
              <div class="who"><b data-spk="${esc(e.speaker)}" style="color:${isShot ? "inherit" : colorFor(e.speaker)}">${esc(e.speaker)}</b><span class="ts">${fmtOffset(e.t)}</span></div>
              ${shot && shot.url ? `<img class="shot" src="${esc(shot.url)}" alt="Screenshot">` : `<div class="txt">${re ? esc(e.text).replace(re, (x) => `<mark>${x}</mark>`) : esc(e.text)}</div>`}
              ${e.note ? `<div class="note">📝 ${esc(e.note)}</div>` : ""}
              ${comments.filter((c) => c.entryId === e.id).map((c) => `<div class="cm"><b>${esc(c.author)}:</b> ${esc(c.text)}</div>`).join("")}
            </div>
            <div class="tools">
              <button class="star" data-a="hl" title="Highlight">★</button>
              <button data-a="note" title="Note">✎</button>
              <button data-a="cm" title="Comment">💬</button>
              ${isShot ? "" : `<button data-a="edit" title="Fix text">Aa</button>`}
              <button data-a="copy" title="Copy line">⧉</button>
              <button data-a="del" title="Delete line">🗑</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty">${m.entries.length ? "No lines match." : "<b>No transcript yet</b>Captions will appear here once people talk."}</div>`;
}

document.addEventListener("click", async (ev) => {
  const lines = ev.target.closest("#lines");
  if (!lines || !state.current) return;
  const m = state.current;
  const img = ev.target.closest("img.shot");
  if (img) {
    const lb = document.createElement("div");
    lb.className = "lightbox";
    lb.innerHTML = `<img src="${img.src}">`;
    lb.onclick = () => lb.remove();
    return document.body.appendChild(lb);
  }
  const spk = ev.target.closest("[data-spk]");
  if (spk) {
    const from = spk.dataset.spk;
    if (from.startsWith("📷")) return;
    const to = prompt(`Rename "${from}" everywhere in this meeting to:`, from);
    if (!to || to.trim() === from) return;
    const { meeting } = await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ renameSpeaker: { from, to } }) });
    state.current = meeting;
    return pageMeeting(m.id);
  }
  const btn = ev.target.closest("[data-a]");
  if (!btn) return;
  const row = btn.closest(".line");
  const e = m.entries.find((x) => x.id === row.dataset.id);
  const patch = async (entry) => {
    const { meeting } = await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ entry: { id: e.id, ...entry } }) });
    state.current = meeting;
    renderLines();
  };
  switch (btn.dataset.a) {
    case "hl":
      return patch({ highlight: !e.highlight });
    case "note": {
      const v = prompt("Note for this line", e.note || "");
      if (v !== null) patch({ note: v.trim() });
      return;
    }
    case "cm": {
      const v = prompt("Add a comment");
      if (!v || !v.trim()) return;
      const { comments } = await api(`/api/meetings/${m.id}/comments`, { method: "POST", body: JSON.stringify({ entryId: e.id, text: v }) });
      m.comments = comments;
      return renderLines();
    }
    case "edit": {
      const txt = row.querySelector(".txt");
      txt.textContent = e.text;
      txt.contentEditable = "true";
      txt.focus();
      txt.addEventListener("keydown", (k) => k.key === "Enter" && !k.shiftKey && (k.preventDefault(), txt.blur()));
      txt.addEventListener("blur", () => {
        txt.contentEditable = "false";
        const v = txt.textContent.trim();
        if (v && v !== e.text) patch({ text: v });
        else renderLines();
      }, { once: true });
      return;
    }
    case "copy":
      await navigator.clipboard.writeText(`${e.speaker}: ${e.text}`);
      return toast("Line copied");
    case "del": {
      if (!confirm("Delete this line?")) return;
      const { meeting } = await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ deleteEntry: e.id }) });
      state.current = meeting;
      return renderLines();
    }
  }
});

function renderAI(pendingLabel) {
  const m = state.current;
  const box = $("#ai");
  if (!box) return;
  box.innerHTML =
    (pendingLabel ? `<div class="airesult">${loading("Working on " + pendingLabel + "…")}</div>` : "") +
    ((m.ai || []).length || pendingLabel
      ? (m.ai || [])
          .map(
            (a) => `<div class="airesult" data-ai="${a.id}">
              <div class="h"><b>${esc(a.name)}</b><small>${new Date(a.createdAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</small>
              <button class="btn sm" data-ai-copy="${a.id}">⧉</button><button class="btn sm" data-ai-del="${a.id}">×</button></div>
              <div class="md">${md(a.text)}</div></div>`
          )
          .join("")
      : `<p style="color:var(--muted);font-size:13px;margin:12px 0 0">Pick a prompt above to make notes from this meeting.</p>`);
  box.onclick = async (e) => {
    const c = e.target.closest("[data-ai-copy]");
    const d = e.target.closest("[data-ai-del]");
    if (c) {
      await navigator.clipboard.writeText(m.ai.find((a) => a.id === c.dataset.aiCopy).text);
      toast("Copied");
    }
    if (d) {
      const { meeting } = await api("/api/meetings/" + m.id, { method: "PATCH", body: JSON.stringify({ deleteAi: d.dataset.aiDel }) });
      state.current = meeting;
      renderAI();
    }
  };
}

async function runAI(body, label) {
  const m = state.current;
  renderAI(label);
  try {
    await api(`/api/meetings/${m.id}/ai`, { method: "POST", body: JSON.stringify(body) });
    const { meeting } = await api("/api/meetings/" + m.id);
    state.current = meeting;
    renderAI();
  } catch (e) {
    renderAI();
    $("#ai").insertAdjacentHTML("afterbegin", `<div class="airesult" style="color:var(--red)">${esc(e.message)}</div>`);
  }
}

async function download(fmt) {
  const m = state.current;
  const res = await fetch(`/api/meetings/${m.id}/export?format=${fmt}`, { headers: { "x-majlis-token": getKey() } });
  if (!res.ok) return toast("Export failed");
  const blob = await res.blob();
  const name = (res.headers.get("content-disposition") || "").match(/filename="(.+)"/);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name ? name[1] : "meeting." + fmt;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

async function copyRich() {
  const m = state.current;
  let html = `<h1>${esc(m.title)}</h1><p>${new Date(m.startedAt).toLocaleString()}</p>`;
  for (const a of m.ai || []) html += `<h2>${esc(a.name)}</h2>${md(a.text)}`;
  html += `<h2>Transcript</h2>` + m.entries.map((e) => `<p><b>${esc(e.speaker)}</b> <small>${fmtOffset(e.t)}</small><br>${esc(e.text)}</p>`).join("");
  const plain = m.entries.map((e) => `${e.speaker}: ${e.text}`).join("\n");
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })]);
    toast("Copied — paste into a Google Doc");
  } catch {
    await navigator.clipboard.writeText(plain);
    toast("Copied as plain text");
  }
}

async function push(target) {
  try {
    const { results } = await api(`/api/meetings/${state.current.id}/push`, { method: "POST", body: JSON.stringify({ target }) });
    if (results[target] === undefined) return toast(`Set up ${target === "slack" ? "Slack" : "the webhook"} in Settings first`);
    toast(results[target] ? "Sent ✓" : "Sending failed");
  } catch (e) {
    toast(e.message);
  }
}

function emailIt() {
  const m = state.current;
  const sum = (m.ai || []).find((a) => a.promptId === "email") || (m.ai || []).find((a) => a.promptId === "summary");
  const body = sum ? sum.text.replace(/\*\*/g, "") : m.entries.slice(0, 80).map((e) => `${e.speaker}: ${e.text}`).join("\n");
  location.href = `mailto:?subject=${encodeURIComponent("Notes: " + m.title)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
}

function shareDialog() {
  const m = state.current;
  const d = document.createElement("div");
  d.className = "modal";
  const linkFor = (sid) => `${location.origin}/s/${sid}`;
  d.innerHTML = `<div class="box form">
    <h3>Share this meeting</h3>
    <div class="help">Anyone with the link can view it. No login needed.</div>
    <label class="check"><input type="checkbox" id="sT" checked> Include transcript &amp; screenshots</label>
    <label class="check"><input type="checkbox" id="sA" checked> Include AI notes</label>
    <div id="sl" style="margin-top:14px"></div>
    <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn danger" id="sOff" ${m.shareId ? "" : "hidden"}>Turn off link</button>
      <button class="btn" id="sClose">Close</button>
      <button class="btn primary" id="sOn">${m.shareId ? "Update" : "Create link"}</button>
    </div></div>`;
  document.body.appendChild(d);
  const show = () => {
    $("#sl", d).innerHTML = m.shareId ? `<input type="text" readonly value="${linkFor(m.shareId)}" onclick="this.select()">` : "";
    $("#sOff", d).hidden = !m.shareId;
    $("#sOn", d).textContent = m.shareId ? "Update" : "Create link";
  };
  show();
  $("#sClose", d).onclick = () => d.remove();
  $("#sOn", d).onclick = async () => {
    const r = await api(`/api/meetings/${m.id}/share`, { method: "POST", body: JSON.stringify({ transcript: $("#sT", d).checked, ai: $("#sA", d).checked }) });
    m.shareId = r.shareId;
    show();
    await navigator.clipboard.writeText(linkFor(m.shareId)).catch(() => {});
    toast("Link copied");
  };
  $("#sOff", d).onclick = async () => {
    await api(`/api/meetings/${m.id}/share`, { method: "POST", body: JSON.stringify({ off: true }) });
    m.shareId = null;
    show();
    toast("Link turned off");
  };
}

/* ---------------- Prompts ---------------- */
async function pagePrompts() {
  loadSidebar();
  const { prompts } = await api("/api/prompts");
  const kits = Array.from(new Set(prompts.filter((p) => p.kit).map((p) => p.kit)));
  view.innerHTML = `
    <div class="top"><h1>AI prompts</h1><button class="btn gold" id="newp">+ New prompt</button></div>
    <p style="color:var(--muted);margin-top:-8px">Prompts turn a transcript into notes. Make your own for meetings you have often — for example your weekly Traction meeting. Group them into kits.</p>
    <div class="card" id="editor" hidden></div>
    ${kits.map((k) => `<div class="group-title">Kit: ${esc(k)}</div><div class="card plist">${prompts.filter((p) => p.kit === k).map(promptRow).join("")}</div>`).join("")}
    <div class="group-title">My prompts</div>
    <div class="card plist">${prompts.filter((p) => !p.builtin && !p.kit).map(promptRow).join("") || `<p style="color:var(--muted)">None yet.</p>`}</div>
    <div class="group-title">Built-in</div>
    <div class="card plist">${prompts.filter((p) => p.builtin).map(promptRow).join("")}</div>`;
  $("#newp").onclick = () => editPrompt({});
  view.onclick = async (e) => {
    const ed = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-delp]");
    const dup = e.target.closest("[data-dup]");
    if (ed) editPrompt(prompts.find((p) => p.id === ed.dataset.edit));
    if (dup) {
      const p = prompts.find((x) => x.id === dup.dataset.dup);
      editPrompt({ name: p.name + " (my version)", icon: p.icon, text: p.text });
    }
    if (del && confirm("Delete this prompt?")) {
      await api("/api/prompts/" + del.dataset.delp, { method: "DELETE" });
      pagePrompts();
    }
  };
}
const promptRow = (p) => `<div class="p"><div class="ic">${esc(p.icon || "◆")}</div><div><b>${esc(p.name)}</b><div class="d">${esc(p.text)}</div></div>
  <div style="display:flex;gap:6px">${p.builtin ? `<button class="btn sm" data-dup="${p.id}">Copy &amp; edit</button>` : `<button class="btn sm" data-edit="${p.id}">Edit</button><button class="btn sm danger" data-delp="${p.id}">Delete</button>`}</div></div>`;

function editPrompt(p) {
  const ed = $("#editor");
  ed.hidden = false;
  ed.innerHTML = `<form class="form">
    <h3>${p.id ? "Edit prompt" : "New prompt"}</h3>
    <div style="display:grid;grid-template-columns:80px 1fr 1fr;gap:10px">
      <div><label>Icon</label><input type="text" id="pi" maxlength="2" value="${esc(p.icon || "◆")}"></div>
      <div><label>Name</label><input type="text" id="pn" required value="${esc(p.name || "")}" placeholder="e.g. Traction meeting notes"></div>
      <div><label>Kit (optional)</label><input type="text" id="pk" value="${esc(p.kit || "")}" placeholder="e.g. Aymakan"></div>
    </div>
    <label>What should the AI write?</label>
    <textarea id="pt" required placeholder="e.g. List each KPI discussed, its status (on track / off track), the owner, and the fix agreed.">${esc(p.text || "")}</textarea>
    <div style="margin-top:12px;display:flex;gap:8px"><button class="btn primary">Save</button><button type="button" class="btn" id="pc">Cancel</button></div>
  </form>`;
  ed.scrollIntoView({ behavior: "smooth" });
  $("#pc").onclick = () => (ed.hidden = true);
  $("form", ed).onsubmit = async (e) => {
    e.preventDefault();
    await api("/api/prompts", { method: "POST", body: JSON.stringify({ id: p.id, icon: $("#pi").value, name: $("#pn").value, kit: $("#pk").value, text: $("#pt").value }) });
    toast("Saved");
    pagePrompts();
  };
}

/* ---------------- Upload ---------------- */
async function pageUpload() {
  loadSidebar();
  const { env } = await api("/api/settings");
  view.innerHTML = `
    <div class="top"><h1>Upload a recording</h1></div>
    ${env.upload ? "" : `<div class="card" style="background:var(--gold-soft);margin-bottom:16px">To turn recordings into text, add <b>DEEPGRAM_API_KEY</b> (best — it knows who is speaking and supports Arabic) or <b>OPENAI_API_KEY</b> to the server <code>.env</code> file, then restart.</div>`}
    <div class="form card" style="margin-bottom:14px"><label style="margin-top:0">Meeting name (optional)</label><input type="text" id="ut" placeholder="Uses the file name if empty"></div>
    <label class="drop" id="drop"><input type="file" id="uf" accept="audio/*,video/*" hidden>
      <div style="font-size:34px">⬆</div><b>Drop an audio or video file here</b><div style="color:var(--muted)">or click to choose · MP3, M4A, WAV, MP4, WEBM · up to 200 MB</div></label>
    <div id="us" style="margin-top:16px"></div>`;
  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add("over"))));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.remove("over"))));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]));
  $("#uf").addEventListener("change", (e) => e.target.files[0] && upload(e.target.files[0]));
}

function upload(file) {
  const us = $("#us");
  us.innerHTML = `<div class="card">${loading("Uploading " + file.name + "…")}<div class="bar"><i id="up" style="width:0;background:var(--navy)"></i></div></div>`;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload?title=" + encodeURIComponent($("#ut").value.trim()));
  xhr.setRequestHeader("content-type", file.type || "audio/mpeg");
  xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
  xhr.setRequestHeader("x-majlis-token", getKey());
  xhr.upload.onprogress = (e) => {
    const bar = $("#up");
    if (bar && e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + "%";
    if (e.loaded === e.total) us.querySelector(".loading").innerHTML = `<span class="spin"></span>Turning speech into text… this can take a minute.`;
  };
  xhr.onload = () => {
    const data = JSON.parse(xhr.responseText || "{}");
    if (xhr.status === 200) location.hash = "#/m/" + data.id;
    else us.innerHTML = `<div class="card" style="color:var(--red)">${esc(data.error || "Upload failed")}</div>`;
  };
  xhr.onerror = () => (us.innerHTML = `<div class="card" style="color:var(--red)">Upload failed — is the server running?</div>`);
  xhr.send(file);
}

/* ---------------- Settings ---------------- */
async function pageSettings() {
  loadSidebar();
  const { settings: s, env } = await api("/api/settings");
  view.innerHTML = `
    <div class="top"><h1>Settings</h1></div>
    <div class="card form" style="max-width:720px">
      <h3>Status</h3>
      <p>AI notes: ${env.ai ? `<span class="chip green">On · ${esc(env.model)}</span>` : `<span class="chip gold">Off — add ANTHROPIC_API_KEY to .env</span>`}</p>
      <p>Recording upload: ${env.upload ? `<span class="chip green">On · ${esc(env.upload)}</span>` : `<span class="chip gold">Off — add DEEPGRAM_API_KEY or OPENAI_API_KEY</span>`}</p>
      <label class="check"><input type="checkbox" id="auto" ${s.autoSummary ? "checked" : ""}> Make an AI summary by itself when a meeting ends</label>

      <h3 style="margin-top:26px">Google Calendar</h3>
      <div id="calendar-status" style="margin-bottom:16px;padding:12px;background:var(--soft);border-radius:6px;border-left:3px solid var(--primary)">
        <div style="color:var(--muted);font-size:12px;margin-bottom:4px">Calendar sync status</div>
        <div id="calendar-state" style="font-weight:600">Not connected</div>
        ${s.googleCalendarId ? `<button class="btn" style="margin-top:8px;font-size:12px" id="disconnect-calendar">Disconnect</button>` : `<button class="btn primary" style="margin-top:8px;font-size:12px" id="connect-calendar">Connect to Google Calendar</button>`}
      </div>
      <label class="check"><input type="checkbox" id="auto-calendar" ${s.autoCalendar ? "checked" : ""}> Automatically add meetings to Google Calendar</label>
      <div class="help">When enabled, meetings will be created in your Google Calendar automatically.</div>

      <h3 style="margin-top:26px">Send notes to other apps</h3>
      <label>Slack incoming webhook</label>
      <input type="url" id="slack" value="${esc(s.slackWebhook || "")}" placeholder="https://hooks.slack.com/services/…">
      <div class="help">Slack → Apps → Incoming Webhooks → pick a channel → copy the URL. The summary is posted when a meeting ends.</div>
      <label>Webhook (Zapier, Make, n8n…)</label>
      <input type="url" id="hook" value="${esc(s.webhookUrl || "")}" placeholder="https://hooks.zapier.com/…">
      <div class="help">Gets the full meeting as JSON when it ends. Use it to save to Notion, Google Docs, HubSpot, Trello, Jira and more.</div>

      <h3 style="margin-top:26px">This browser</h3>
      <label>Access key</label>
      <input type="password" id="key" value="${esc(getKey())}">
      <div class="help">Saved only in this browser. Must match MAJLIS_TOKEN on the server.</div>
      <label class="check"><span>Theme</span>
        <select id="theme" style="width:auto"><option value="">Match my system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <div style="margin-top:18px"><button class="btn primary" id="save">Save settings</button></div>
    </div>`;
  let theme = "";
  try { theme = localStorage.getItem("fn-theme") || ""; } catch {}
  $("#theme").value = theme;

  // Update calendar status display
  if (s.googleCalendarId) {
    $("#calendar-state").textContent = "✓ Connected";
    $("#calendar-state").style.color = "var(--primary)";
  }

  // Google Calendar connect
  const connectBtn = $("#connect-calendar");
  if (connectBtn) {
    connectBtn.onclick = async () => {
      try {
        const { authUrl } = await api("/api/calendar/auth-url");
        window.open(authUrl, "calendar_auth", "width=500,height=600");
        // Check for connection after a delay
        setTimeout(() => location.reload(), 3000);
      } catch (e) {
        toast("Error: " + e.message);
      }
    };
  }

  // Google Calendar disconnect
  const disconnectBtn = $("#disconnect-calendar");
  if (disconnectBtn) {
    disconnectBtn.onclick = async () => {
      if (confirm("Disconnect from Google Calendar?")) {
        try {
          await api("/api/calendar/disconnect", { method: "POST" });
          toast("Disconnected");
          location.reload();
        } catch (e) {
          toast("Error: " + e.message);
        }
      }
    };
  }

  $("#save").onclick = async () => {
    setKey($("#key").value.trim());
    try { localStorage.setItem("fn-theme", $("#theme").value); } catch {}
    applyTheme();
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          slackWebhook: $("#slack").value.trim(),
          webhookUrl: $("#hook").value.trim(),
          autoSummary: $("#auto").checked,
          autoCalendar: $("#auto-calendar").checked
        })
      });
      toast("Saved ✓");
    } catch (e) {
      toast(e.message);
    }
  };
}

function applyTheme() {
  let t = "";
  try { t = localStorage.getItem("fn-theme") || ""; } catch {}
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

applyTheme();
router();
