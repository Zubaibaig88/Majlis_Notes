/* Shared helpers for the dashboard and the shared-link page. */
const FN = (() => {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const fmtOffset = (ms) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600);
    return (h ? h + ":" : "") + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
  };
  const fmtDuration = (ms) => {
    const m = Math.round((ms || 0) / 60000);
    if (m < 1) return "< 1 min";
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + (m % 60 ? (m % 60) + " min" : "");
  };
  const PALETTE = ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f", "#c2410c", "#0f766e"];
  const colorFor = (name) => {
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
  const initials = (name) =>
    String(name || "?")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";

  /* Small, safe Markdown renderer (headings, bold, lists, checkboxes). */
  function md(src) {
    const lines = esc(src).split(/\r?\n/);
    let html = "", inList = false;
    const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*(.+?)\*(?=\W|$)/g, "$1<i>$2</i>").replace(/`(.+?)`/g, "<code>$1</code>");
    for (const raw of lines) {
      const l = raw.trimEnd();
      let m;
      if ((m = l.match(/^\s*[-*] \[( |x)\] (.*)$/i))) {
        if (!inList) (html += "<ul>"), (inList = true);
        html += `<li class="todo">${m[1].trim() ? "☑" : "☐"} ${inline(m[2])}</li>`;
      } else if ((m = l.match(/^\s*(?:[-*•]|\d+[.)]) (.*)$/))) {
        if (!inList) (html += "<ul>"), (inList = true);
        html += `<li>${inline(m[1])}</li>`;
      } else {
        if (inList) (html += "</ul>"), (inList = false);
        if ((m = l.match(/^(#{1,4}) (.*)$/))) html += `<h3>${inline(m[2])}</h3>`;
        else if (l.trim()) html += `<p>${inline(l)}</p>`;
      }
    }
    if (inList) html += "</ul>";
    return html;
  }

  function speakerStats(entries) {
    const words = {}, turns = {};
    let total = 0;
    for (const e of entries || []) {
      if (!e.speaker || e.speaker.startsWith("📷")) continue;
      const n = (String(e.text).match(/\S+/g) || []).length;
      words[e.speaker] = (words[e.speaker] || 0) + n;
      turns[e.speaker] = (turns[e.speaker] || 0) + 1;
      total += n;
    }
    return Object.keys(words)
      .map((s) => ({ speaker: s, words: words[s], turns: turns[s], pct: total ? Math.round((words[s] / total) * 100) : 0 }))
      .sort((a, b) => b.words - a.words);
  }

  return { esc, fmtOffset, fmtDuration, colorFor, initials, md, speakerStats };
})();
