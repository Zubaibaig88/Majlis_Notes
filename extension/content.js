/*
 * Majlis Notes – content script.
 * Runs inside the meeting tab. Reads live captions through the adapter,
 * builds the transcript, and shows the floating Majlis Notes panel.
 */
(function () {
  if (window.__majlisLoaded) return;
  window.__majlisLoaded = true;

  const adapter = (window.MajlisAdapters || []).find((a) => a.match && a.match.call(a)) ||
    (window.MajlisAdapters || []).find((a) => a.id === "meet");
  if (!adapter) return;

  /* ---------- helpers ---------- */
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pad = (n) => String(n).padStart(2, "0");
  const fmtOffset = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return (h ? h + ":" : "") + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  const commonPrefix = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };

  /* ---------- state ---------- */
  let settings = {};
  let meeting = null;
  let paused = false;
  let notInCallSince = 0;
  let lastCaptionAt = 0;
  let captionTries = 0;
  const seenByEl = new WeakMap(); // caption element -> { entryId, seen, speaker }
  const dirty = new Set();
  let saveTimer = null;

  /* ---------- transcript merging ---------- */
  function mergeText(entry, seen, now) {
    if (now === seen) return;
    if (now.startsWith(seen)) {
      entry.text += now.slice(seen.length);
      return;
    }
    const p = commonPrefix(seen, now);
    if (p > 0 && p >= Math.min(10, seen.length * 0.5)) {
      // Platform corrected some words (the start of the block is unchanged).
      entry.text = entry.text.slice(0, entry.text.length - (seen.length - p)) + now.slice(p);
      return;
    }
    // Platform dropped older words from the start of the caption block.
    // Find the longest end of `seen` that is the start of `now`, on word edges.
    const max = Math.min(seen.length, now.length);
    for (let k = max; k >= 2; k--) {
      const head = now.slice(0, k);
      if (!seen.endsWith(head)) continue;
      const startsOnWord = seen.length === k || /\s/.test(seen[seen.length - k - 1]);
      const endsOnWord = now.length === k || /\s/.test(now[k]);
      if (startsOnWord && endsOnWord) {
        entry.text += now.slice(k);
        return;
      }
    }
    // No overlap found (we missed some updates). Never throw away what we
    // already have — just add the new words after it.
    entry.text += " … " + now;
  }

  function scan() {
    if (!meeting || paused) return;
    const root = adapter.captionRoot();
    if (!root) {
      setStatus(Date.now() - lastCaptionAt > 8000 ? "nocaptions" : "live");
      if (settings.autoCaptions !== false && captionTries < 8) {
        captionTries++;
        adapter.enableCaptions();
      }
      return;
    }
    const blocks = adapter.blocks(root);
    if (blocks.length) lastCaptionAt = Date.now();
    setStatus("live");
    for (const b of blocks) {
      let rec = seenByEl.get(b.el);
      if (rec && rec.speaker !== b.speaker && b.speaker !== "Speaker") rec = null;
      if (!rec) {
        const last = meeting.entries[meeting.entries.length - 1];
        // Same speaker, same text already captured (block re-rendered) -> reuse.
        if (last && last.speaker === b.speaker && last.text.endsWith(b.text)) {
          seenByEl.set(b.el, { entryId: last.id, seen: b.text, speaker: b.speaker });
          continue;
        }
        const entry = {
          id: uid(),
          speaker: b.speaker,
          text: b.text,
          t: Date.now() - meeting.startMs,
          at: new Date().toISOString(),
          highlight: false,
          note: "",
        };
        meeting.entries.push(entry);
        seenByEl.set(b.el, { entryId: entry.id, seen: b.text, speaker: b.speaker });
        dirty.add(entry.id);
      } else if (rec.seen !== b.text) {
        const entry = meeting.entries.find((e) => e.id === rec.entryId);
        if (entry) {
          mergeText(entry, rec.seen, b.text);
          entry.text = entry.text.replace(/\s+/g, " ").trim();
          dirty.add(entry.id);
        }
        rec.seen = b.text;
      }
    }
    if (dirty.size) {
      renderDirty();
      scheduleSave();
    }
  }

  /* ---------- meeting lifecycle ---------- */
  function startMeeting() {
    meeting = {
      id: uid(),
      platform: adapter.id,
      platformName: adapter.name,
      title: adapter.title(),
      url: location.href.split("?")[0],
      startedAt: new Date().toISOString(),
      startMs: Date.now(),
      endedAt: null,
      entries: [],
      screenshots: [],
      participants: [],
      tags: [],
      notes: "",
    };
    paused = false;
    captionTries = 0;
    lastCaptionAt = Date.now();
    buildPanel();
    adapter.enableCaptions();
    scheduleSave();
  }

  function endMeeting() {
    if (!meeting) return;
    meeting.endedAt = new Date().toISOString();
    saveNow(true);
    setStatus("ended");
    meeting = null;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(false), 1500);
  }
  function saveNow(final) {
    if (!meeting) return;
    const parts = adapter.participants();
    const fromSpeakers = meeting.entries.map((e) => e.speaker).filter((s) => s && s !== "Speaker" && !s.startsWith("📷"));
    meeting.participants = Array.from(new Set([...meeting.participants, ...parts, ...fromSpeakers]));
    if (!meeting.title || /^Meet\b/.test(meeting.title)) meeting.title = adapter.title();
    send({ type: "fn:save", meeting: JSON.parse(JSON.stringify(meeting)), final });
  }

  /* ---------- panel UI ---------- */
  let host, shadow, ui = {};

  function buildPanel() {
    if (host) {
      host.style.display = settings.showPanel === false ? "none" : "";
      ui.list.innerHTML = "";
      return;
    }
    host = document.createElement("div");
    host.id = "majlis-host";
    host.style.cssText = "all:initial;position:fixed;top:72px;right:16px;z-index:2147483646;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <link rel="stylesheet" href="${chrome.runtime.getURL("panel.css")}">
      <div class="fn-panel" part="panel">
        <header class="fn-head">
          <span class="fn-logo">م</span>
          <div class="fn-titlewrap">
            <div class="fn-title" title="Click to rename"></div>
            <div class="fn-sub"><span class="fn-dot"></span><span class="fn-status">Starting…</span> · <span class="fn-timer">00:00</span></div>
          </div>
          <button class="fn-icon fn-min" title="Minimize">–</button>
        </header>
        <div class="fn-tools">
          <button data-act="pause" title="Pause / resume">⏸ Pause</button>
          <button data-act="shot" title="Take a screenshot of the meeting">📷 Shot</button>
          <button data-act="copy" title="Copy transcript">⧉ Copy</button>
          <button data-act="ai" title="AI summary">✦ Summary</button>
          <button data-act="more" title="More">⋯</button>
        </div>
        <div class="fn-menu" hidden>
          <button data-act="download">⬇ Download .txt</button>
          <button data-act="tell">📣 Tell others I'm transcribing</button>
          <button data-act="captions">💬 Turn on captions</button>
          <button data-act="dashboard">↗ Open dashboard</button>
          <button data-act="new">↻ Start a new transcript</button>
        </div>
        <div class="fn-search"><input type="search" placeholder="Search transcript…"></div>
        <div class="fn-hint" hidden></div>
        <ol class="fn-list"></ol>
        <div class="fn-ai" hidden>
          <div class="fn-ai-head"><b>AI notes</b><button class="fn-icon fn-ai-close">×</button></div>
          <div class="fn-ai-prompts">
            <button data-prompt="summary">Summary</button>
            <button data-prompt="actions">Action items</button>
            <button data-prompt="decisions">Decisions</button>
            <button data-prompt="email">Follow-up email</button>
          </div>
          <div class="fn-ai-body"></div>
        </div>
        <footer class="fn-foot"><span class="fn-count">0 lines</span><span class="fn-saved"></span></footer>
      </div>
      <button class="fn-pill" hidden><span class="fn-dot"></span> Majlis Notes <span class="fn-timer">00:00</span></button>
    `;
    document.documentElement.appendChild(host);
    const $ = (s) => shadow.querySelector(s);
    ui = {
      panel: $(".fn-panel"),
      pill: $(".fn-pill"),
      title: $(".fn-title"),
      status: $(".fn-status"),
      dots: shadow.querySelectorAll(".fn-dot"),
      timers: shadow.querySelectorAll(".fn-timer"),
      list: $(".fn-list"),
      search: $(".fn-search input"),
      hint: $(".fn-hint"),
      menu: $(".fn-menu"),
      ai: $(".fn-ai"),
      aiBody: $(".fn-ai-body"),
      count: $(".fn-count"),
      saved: $(".fn-saved"),
      pauseBtn: shadow.querySelector("[data-act='pause']"),
    };
    if (settings.showPanel === false) host.style.display = "none";
    if (settings.startMinimized) toggleMin(true);

    ui.title.textContent = meeting ? meeting.title : adapter.name;
    ui.title.addEventListener("click", () => {
      if (!meeting) return;
      const v = prompt("Meeting name", meeting.title);
      if (v && v.trim()) {
        meeting.title = v.trim();
        ui.title.textContent = meeting.title;
        scheduleSave();
      }
    });
    $(".fn-min").addEventListener("click", () => toggleMin(true));
    ui.pill.addEventListener("click", () => toggleMin(false));
    $(".fn-ai-close").addEventListener("click", () => (ui.ai.hidden = true));
    shadow.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => onAction(b.dataset.act)));
    shadow.querySelectorAll("[data-prompt]").forEach((b) => b.addEventListener("click", () => runAI(b.dataset.prompt)));
    ui.search.addEventListener("input", applySearch);
    ui.list.addEventListener("click", onListClick);
    makeDraggable($(".fn-head"));
  }

  function toggleMin(min) {
    ui.panel.hidden = min;
    ui.pill.hidden = !min;
  }

  function makeDraggable(handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button") || e.target.closest(".fn-title")) return;
      drag = true;
      sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      host.style.left = Math.max(0, ox + e.clientX - sx) + "px";
      host.style.top = Math.max(0, oy + e.clientY - sy) + "px";
      host.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (drag = false));
  }

  function setStatus(s) {
    if (!ui.status) return;
    const map = {
      live: ["Live", "live"],
      paused: ["Paused", "paused"],
      nocaptions: ["Waiting for captions", "warn"],
      ended: ["Saved", "ended"],
    };
    const [label, cls] = map[s] || [s, ""];
    ui.status.textContent = label;
    ui.dots.forEach((d) => (d.className = "fn-dot " + cls));
    ui.hint.hidden = s !== "nocaptions";
    if (s === "nocaptions") {
      ui.hint.innerHTML =
        adapter.id === "teams"
          ? "Turn on live captions in Teams: <b>More (…) → Language and speech → Turn on live captions</b>."
          : adapter.id === "zoom"
          ? "Turn on captions in Zoom: click <b>CC / Show captions</b> in the bottom bar."
          : "No captions yet. Click <b>CC</b> in Meet (or press <b>c</b>). Majlis Notes reads the captions to build the transcript.";
    }
  }

  function lineHTML(e) {
    return `
      <div class="fn-meta"><b class="fn-spk">${esc(e.speaker)}</b><span class="fn-time">${fmtOffset(e.t)}</span>
        <span class="fn-acts"><button class="fn-icon" data-line="hl" title="Highlight">★</button><button class="fn-icon" data-line="note" title="Add note">✎</button></span>
      </div>
      <div class="fn-text">${esc(e.text)}</div>
      ${e.note ? `<div class="fn-note">📝 ${esc(e.note)}</div>` : ""}`;
  }

  function renderDirty() {
    if (!ui.list) return;
    const nearBottom = ui.list.scrollHeight - ui.list.scrollTop - ui.list.clientHeight < 60;
    for (const id of dirty) {
      const e = meeting.entries.find((x) => x.id === id);
      if (!e) continue;
      let li = ui.list.querySelector(`li[data-id="${id}"]`);
      if (!li) {
        li = document.createElement("li");
        li.dataset.id = id;
        ui.list.appendChild(li);
      }
      li.className = e.highlight ? "hl" : "";
      li.innerHTML = lineHTML(e);
    }
    dirty.clear();
    applySearch();
    ui.count.textContent = meeting.entries.length + " lines";
    if (nearBottom) ui.list.scrollTop = ui.list.scrollHeight;
  }

  function renderAll() {
    if (!ui.list || !meeting) return;
    ui.list.innerHTML = "";
    meeting.entries.forEach((e) => dirty.add(e.id));
    renderDirty();
  }

  function applySearch() {
    const term = (ui.search.value || "").toLowerCase().trim();
    ui.list.querySelectorAll("li").forEach((li) => {
      li.hidden = term && !li.textContent.toLowerCase().includes(term);
    });
  }

  function onListClick(ev) {
    const btn = ev.target.closest("[data-line]");
    if (!btn || !meeting) return;
    const li = btn.closest("li");
    const e = meeting.entries.find((x) => x.id === li.dataset.id);
    if (!e) return;
    if (btn.dataset.line === "hl") e.highlight = !e.highlight;
    if (btn.dataset.line === "note") {
      const v = prompt("Note for this line", e.note || "");
      if (v === null) return;
      e.note = v.trim();
    }
    dirty.add(e.id);
    renderDirty();
    scheduleSave();
  }

  function transcriptText(m) {
    const head = `${m.title}\n${new Date(m.startedAt).toLocaleString()} · ${m.platformName}\n\n`;
    return head + m.entries.map((e) => `[${fmtOffset(e.t)}] ${e.speaker}: ${e.text}${e.note ? `\n    Note: ${e.note}` : ""}`).join("\n");
  }

  function flash(msg) {
    if (!ui.saved) return;
    ui.saved.textContent = msg;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => (ui.saved.textContent = ""), 2500);
  }

  async function onAction(act) {
    if (act !== "more") ui.menu.hidden = true;
    if (act === "more") return (ui.menu.hidden = !ui.menu.hidden);
    if (act === "new") {
      endMeeting();
      startMeeting();
      return flash("New transcript started");
    }
    if (act === "captions") {
      adapter.enableCaptions();
      return flash(adapter.id === "meet" ? "Asked Meet to turn on captions" : "Turn on captions in the meeting app");
    }
    if (act === "dashboard") return send({ type: "fn:openDashboard", meetingId: meeting && meeting.id });
    if (!meeting) return flash("No meeting running");
    if (act === "pause") {
      paused = !paused;
      ui.pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
      setStatus(paused ? "paused" : "live");
      return;
    }
    if (act === "copy") {
      await navigator.clipboard.writeText(transcriptText(meeting));
      return flash("Copied");
    }
    if (act === "download") {
      const blob = new Blob([transcriptText(meeting)], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (meeting.title || "meeting").replace(/[^\w\- ]+/g, "").slice(0, 60) + ".txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return;
    }
    if (act === "shot") {
      host.style.visibility = "hidden";
      await new Promise((r) => setTimeout(r, 120));
      const res = await send({ type: "fn:screenshot" });
      host.style.visibility = "";
      if (!res.ok) return flash("Screenshot failed");
      meeting.screenshots.push({ id: uid(), t: Date.now() - meeting.startMs, at: new Date().toISOString(), dataUrl: res.dataUrl });
      meeting.entries.push({
        id: uid(), speaker: "📷 Screenshot", text: `Screenshot #${meeting.screenshots.length}`,
        t: Date.now() - meeting.startMs, at: new Date().toISOString(), highlight: true, note: "", screenshot: meeting.screenshots.length - 1,
      });
      dirty.add(meeting.entries[meeting.entries.length - 1].id);
      renderDirty();
      scheduleSave();
      return flash("Screenshot saved");
    }
    if (act === "tell") {
      const msg = settings.notifyMessage || "Hi all — I'm using Majlis Notes to transcribe this meeting so I can focus on the conversation.";
      const ok = await adapter.sendChat(msg);
      if (!ok) {
        await navigator.clipboard.writeText(msg);
        return flash("Message copied — paste it in the chat");
      }
      return flash("Sent to meeting chat");
    }
    if (act === "ai") {
      ui.ai.hidden = false;
      return runAI("summary");
    }
  }

  async function runAI(promptId) {
    if (!meeting) return;
    saveNow(false);
    ui.ai.hidden = false;
    ui.aiBody.innerHTML = `<div class="fn-muted">Thinking…</div>`;
    const res = await send({ type: "fn:ai", meeting: JSON.parse(JSON.stringify(meeting)), promptId });
    if (!res.ok) {
      ui.aiBody.innerHTML = `<div class="fn-err">${esc(res.error || "Could not reach the Majlis Notes server. Check Settings in the extension.")}</div>`;
      return;
    }
    ui.aiBody.innerHTML = `<div class="fn-md">${simpleMarkdown(res.text)}</div><button class="fn-copyai">⧉ Copy</button>`;
    ui.aiBody.querySelector(".fn-copyai").addEventListener("click", () => {
      navigator.clipboard.writeText(res.text);
      flash("Copied");
    });
  }

  function simpleMarkdown(md) {
    return esc(md)
      .replace(/^### (.*)$/gm, "<h4>$1</h4>")
      .replace(/^## (.*)$/gm, "<h3>$1</h3>")
      .replace(/^# (.*)$/gm, "<h3>$1</h3>")
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/^\s*[-*] \[ \] (.*)$/gm, "<li>☐ $1</li>")
      .replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>")
      .replace(/^\s*\d+\. (.*)$/gm, "<li>$1</li>")
      .replace(/\n{2,}/g, "<br><br>")
      .replace(/\n/g, "<br>");
  }

  /* ---------- timers & wiring ---------- */
  setInterval(() => {
    if (!ui.timers || !meeting) return;
    ui.timers.forEach((t) => (t.textContent = fmtOffset(Date.now() - meeting.startMs)));
  }, 1000);

  function tick() {
    if (settings.enabled === false) return;
    const inCall = adapter.inCall();
    if (inCall) {
      notInCallSince = 0;
      if (!meeting && settings.autoStart !== false) startMeeting();
    } else if (meeting) {
      if (!notInCallSince) notInCallSince = Date.now();
      if (Date.now() - notInCallSince > 6000) endMeeting();
    }
    scan();
  }

  // Throttle (not debounce): captions change many times a second, and a
  // debounce would never fire while someone keeps talking.
  let scanQueued = false;
  const observer = new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, 200);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === "fn:start") {
      if (!meeting) startMeeting();
      else toggleMin(false);
      reply({ ok: true });
    } else if (msg.type === "fn:stop") {
      endMeeting();
      reply({ ok: true });
    } else if (msg.type === "fn:status") {
      reply({ ok: true, running: !!meeting, platform: adapter.name, title: meeting && meeting.title, lines: meeting ? meeting.entries.length : 0 });
    } else if (msg.type === "fn:settings") {
      settings = msg.settings || settings;
      if (host) host.style.display = settings.showPanel === false ? "none" : "";
      reply({ ok: true });
    }
    return true;
  });

  window.addEventListener("pagehide", () => meeting && saveNow(true));
  document.addEventListener("visibilitychange", () => meeting && document.visibilityState === "hidden" && saveNow(false));

  send({ type: "fn:getSettings" }).then((res) => {
    settings = (res && res.settings) || {};
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(tick, 1500);
    tick();
  });

  // Expose for testing.
  window.__majlis = { mergeText, get meeting() { return meeting; }, renderAll };
})();
