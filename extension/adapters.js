/*
 * Majlis Notes – platform adapters.
 * Each adapter knows how to find live captions on one meeting platform
 * and read them as { el, speaker, text } blocks.
 *
 * Meeting apps change their page code often. If captions stop being picked
 * up, update the selectors in the adapter below — that is the only place
 * that needs fixing.
 */
(function () {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const q = (root, sels) => {
    for (const s of sels) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const qa = (root, sels) => {
    for (const s of sels) {
      const list = root.querySelectorAll(s);
      if (list.length) return Array.from(list);
    }
    return [];
  };
  const clickByLabel = (re) => {
    const btns = document.querySelectorAll("button, [role='button']");
    for (const b of btns) {
      const label = (b.getAttribute("aria-label") || b.getAttribute("data-tooltip") || b.textContent || "").trim();
      if (re.test(label)) {
        b.click();
        return true;
      }
    }
    return false;
  };

  /* ---------------- Google Meet ---------------- */
  const meet = {
    id: "meet",
    name: "Google Meet",
    match: () => location.hostname === "meet.google.com" && /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname),
    inCall: () =>
      !!document.querySelector("[aria-label*='Leave call' i], [aria-label*='مغادرة' i], [jsname='CQylAd']"),
    captionRoot: () =>
      q(document, [
        "div[role='region'][aria-label*='aption' i]",
        "div[role='region'][aria-label*='الترجمة' i]",
        "div[jsname='dsyhDe']",
        "div.a4cQT",
        "div[jscontroller='KPn5nb']",
      ]),
    blocks(root) {
      let items = qa(root, ["div.nMcdL", "div[jsname='tgaKEf']", "div.TBMuR"]);
      if (!items.length) {
        // Fallback: any child that contains an image (speaker avatar) + text.
        items = Array.from(root.querySelectorAll("div")).filter(
          (d) => d.querySelector("img") && clean(d.textContent).length > 0 && d.children.length >= 2
        );
        items = items.filter((d) => !items.some((o) => o !== d && d.contains(o)));
      }
      return items
        .map((el) => {
          const nameEl = q(el, ["div.KcIKyf", "span.NWpY1d", "div.zs7s8d", ".adE6rb", "[data-participant-id] span"]);
          const textEl = q(el, ["div.bh44bd", "div.ygicle", "span.iTTPOb", "div.VbkSUe"]);
          let speaker = clean(nameEl && nameEl.textContent);
          let text = clean(textEl && textEl.textContent);
          if (!text) {
            const full = clean(el.textContent);
            text = speaker && full.startsWith(speaker) ? clean(full.slice(speaker.length)) : full;
          }
          return { el, speaker: speaker || "Speaker", text };
        })
        .filter((b) => b.text);
    },
    enableCaptions() {
      if (this.captionRoot()) return true;
      return clickByLabel(/turn on captions|captions \(c\)|تشغيل الترجمة/i);
    },
    title() {
      const t = q(document, ["div[jsname='r4nke']", "div.u6vdEc", "[data-meeting-title]"]);
      const code = (location.pathname.match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/) || [""])[0];
      return clean(t && t.textContent) || (document.title.replace(/^Meet\s*-\s*/i, "").trim() || "Google Meet " + code);
    },
    participants() {
      const names = new Set();
      document.querySelectorAll("[data-participant-id] [data-self-name], [data-participant-id] .zWGUib, div[data-requested-participant-id] .XEazBc").forEach((n) => {
        const v = clean(n.textContent);
        if (v && v.length < 60) names.add(v);
      });
      return Array.from(names);
    },
    async sendChat(message) {
      const openChat = () => clickByLabel(/chat with everyone|in-call messages|الدردشة/i);
      let box = document.querySelector("textarea[aria-label*='message' i], textarea[jsname='YPqjbf'], textarea");
      if (!box) {
        openChat();
        await new Promise((r) => setTimeout(r, 900));
        box = document.querySelector("textarea[aria-label*='message' i], textarea[jsname='YPqjbf'], textarea");
      }
      if (!box) return false;
      box.focus();
      box.value = message;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return clickByLabel(/^send( a)? message|^send$|إرسال/i);
    },
  };

  /* ---------------- Microsoft Teams (web) ---------------- */
  const teams = {
    id: "teams",
    name: "Microsoft Teams",
    match: () => /teams\.(microsoft|live)\.com$/.test(location.hostname),
    inCall: () => !!document.querySelector("#hangup-button, [data-tid='hangup-main-btn'], button[aria-label*='Leave' i]"),
    captionRoot: () =>
      q(document, [
        "[data-tid='closed-caption-renderer-wrapper']",
        "[data-tid='closed-captions-renderer']",
        "[data-tid='closed-caption-v2-window-wrapper']",
      ]),
    blocks(root) {
      return Array.from(root.querySelectorAll("[data-tid='closed-caption-text']"))
        .map((textEl) => {
          let el = textEl;
          let author = null;
          for (let i = 0; i < 6 && el && !author; i++) {
            el = el.parentElement;
            if (el) author = el.querySelector("[data-tid='author']");
          }
          return { el: el || textEl, speaker: clean(author && author.textContent) || "Speaker", text: clean(textEl.textContent) };
        })
        .filter((b) => b.text);
    },
    enableCaptions() {
      // Teams needs: More (…) → Language and speech → Turn on live captions.
      return !!this.captionRoot();
    },
    title: () => clean(document.title.replace(/\|.*$/, "")) || "Teams meeting",
    participants: () => [],
    sendChat: async () => false,
  };

  /* ---------------- Zoom (web client) ---------------- */
  const zoom = {
    id: "zoom",
    name: "Zoom",
    match: () => /zoom\.us$/.test(location.hostname) && /\/wc\//.test(location.pathname),
    inCall: () => !!document.querySelector(".footer__leave-btn, button[aria-label*='Leave' i]"),
    captionRoot: () =>
      q(document, [".live-transcription-subtitle__box", "#live-transcription-subtitle", ".lt-full-transcript__list"]),
    blocks(root) {
      const active = q(document, [
        ".speaker-active-container__video-frame .video-avatar__avatar-footer",
        ".speaker-bar-container__video-frame--active .video-avatar__avatar-footer",
      ]);
      const speaker = clean(active && active.textContent) || "Speaker";
      return qa(root, [".live-transcription-subtitle__item", ".lt-full-transcript__item", "span"])
        .map((el) => ({ el, speaker, text: clean(el.textContent) }))
        .filter((b) => b.text);
    },
    enableCaptions() {
      if (this.captionRoot()) return true;
      return clickByLabel(/show captions|closed caption|^cc$/i);
    },
    title: () => clean(document.title) || "Zoom meeting",
    participants: () => [],
    sendChat: async () => false,
  };

  window.MajlisAdapters = [meet, teams, zoom];
})();
