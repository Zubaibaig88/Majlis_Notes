/*
 * Majlis Notes server tests — run: npm test
 * Starts the server on a spare port with a temp data folder and checks the API.
 */
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "majlis-test-"));
process.env.MAJLIS_DATA = dir;
process.env.MAJLIS_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "";
const { server } = require("./server");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, opts = {}, token = "test-token") => {
    const res = await fetch(base + p, { ...opts, headers: { "content-type": "application/json", "x-majlis-token": token, ...(opts.headers || {}) } });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text(), headers: res.headers };
  };
  let n = 0;
  const ok = (name) => console.log(`  ✓ ${name}`) || n++;

  assert.equal((await call("/api/health", {}, "")).status, 200); ok("health is open");
  assert.equal((await call("/api/meetings", {}, "wrong")).status, 401); ok("wrong key is refused");

  const meeting = {
    id: "11111111-aaaa-bbbb-cccc-000000000001",
    title: "Weekly Traction",
    platform: "meet",
    platformName: "Google Meet",
    startedAt: new Date(Date.now() - 3600e3).toISOString(),
    entries: [
      { id: "e1", speaker: "Zubair Baig", text: "Good morning everyone, let's review the SLA numbers.", t: 1000, highlight: false, note: "" },
      { id: "e2", speaker: "Mansour", text: "On-time delivery in Riyadh is at ninety two percent.", t: 9000, highlight: true, note: "" },
      { id: "e3", speaker: "Zubair Baig", text: "مرحبا، we need the Hafar Al Batin outlet proposal by Thursday.", t: 18000, highlight: false, note: "" },
      { id: "e4", speaker: "📷 Screenshot", text: "Screenshot #1", t: 20000, highlight: true, note: "", screenshot: 0 },
    ],
    screenshots: [{ id: "s1", t: 20000, dataUrl: PNG }],
    participants: ["Zubair Baig", "Mansour"],
  };
  let r = await call("/api/meetings", { method: "POST", body: JSON.stringify(meeting) });
  assert.equal(r.status, 200); ok("save meeting");

  r = await call("/api/meetings/" + meeting.id);
  assert.equal(r.body.meeting.entries.length, 4);
  assert.ok(r.body.meeting.screenshots[0].url.startsWith("/shots/"));
  assert.ok(!r.body.meeting.screenshots[0].dataUrl); ok("screenshot moved to an image file");
  const shot = await fetch(base + r.body.meeting.screenshots[0].url);
  assert.equal(shot.headers.get("content-type"), "image/png"); ok("screenshot is served");

  r = await call("/api/meetings/" + meeting.id, { method: "PATCH", body: JSON.stringify({ title: "Weekly Traction – Oct", tags: ["aymakan", "traction"], folder: "Aymakan", renameSpeaker: { from: "Mansour", to: "Mansour (CEO)" } }) });
  assert.equal(r.body.meeting.entries[1].speaker, "Mansour (CEO)"); ok("rename speaker everywhere");

  // Extension re-sends an older copy: server edits must survive, new lines must be added.
  const again = JSON.parse(JSON.stringify(meeting));
  again.entries.push({ id: "e5", speaker: "Mansour", text: "Agreed, Thursday works.", t: 25000, highlight: false, note: "" });
  again.endedAt = new Date().toISOString();
  delete again.screenshots[0].dataUrl;
  await call("/api/meetings", { method: "POST", body: JSON.stringify(again) });
  r = await call("/api/meetings/" + meeting.id);
  const m = r.body.meeting;
  assert.equal(m.title, "Weekly Traction – Oct");
  assert.deepEqual(m.tags, ["aymakan", "traction"]);
  assert.equal(m.entries.length, 5);
  assert.equal(m.entries[1].speaker, "Mansour (CEO)");
  assert.ok(m.screenshots[0].url); ok("merge keeps dashboard edits and adds new lines");

  r = await call("/api/meetings?q=hafar");
  assert.equal(r.body.meetings.length, 1);
  assert.ok(r.body.meetings[0].hit.line.includes("Hafar")); ok("search inside transcripts");
  r = await call("/api/meetings?tag=traction");
  assert.equal(r.body.meetings.length, 1); ok("filter by tag");
  r = await call("/api/meetings?q=nothing-like-this");
  assert.equal(r.body.meetings.length, 0); ok("search with no match");

  r = await call(`/api/meetings/${meeting.id}/comments`, { method: "POST", body: JSON.stringify({ entryId: "e2", text: "Check Jeddah too" }) });
  assert.equal(r.body.comments.length, 1); ok("comment on a line");

  r = await call(`/api/meetings/${meeting.id}/ai`, { method: "POST", body: JSON.stringify({ promptId: "summary" }) });
  assert.equal(r.status, 400);
  assert.ok(/ANTHROPIC_API_KEY/.test(r.body.error)); ok("clear message when AI key is missing");

  r = await call("/api/prompts", { method: "POST", body: JSON.stringify({ name: "Traction notes", icon: "T", kit: "Aymakan", text: "List KPIs with status." }) });
  const pid = r.body.prompt.id;
  r = await call("/api/prompts");
  assert.ok(r.body.prompts.some((p) => p.id === pid) && r.body.prompts.some((p) => p.id === "summary")); ok("custom prompts");
  await call("/api/prompts/" + pid, { method: "DELETE" });

  r = await call(`/api/meetings/${meeting.id}/share`, { method: "POST", body: JSON.stringify({ transcript: true, ai: true }) });
  const sid = r.body.shareId;
  r = await call("/api/share/" + sid, {}, "");
  assert.equal(r.status, 200);
  assert.equal(r.body.meeting.entries.length, 5);
  assert.ok(!("note" in r.body.meeting.entries[0])); ok("public share link (no key needed, no private notes)");
  const page = await fetch(base + "/s/" + sid);
  assert.ok((await page.text()).includes("shared meeting")); ok("share page served");
  await call(`/api/meetings/${meeting.id}/share`, { method: "POST", body: JSON.stringify({ off: true }) });
  assert.equal((await call("/api/share/" + sid, {}, "")).status, 404); ok("turn off share link");

  for (const f of ["txt", "md", "doc", "srt", "json"]) {
    r = await call(`/api/meetings/${meeting.id}/export?format=${f}`);
    assert.equal(r.status, 200);
    assert.ok(String(r.headers.get("content-disposition")).includes("." + f));
  }
  r = await call(`/api/meetings/${meeting.id}/export?format=srt`);
  assert.ok(r.body.includes("00:00:01,000 --> 00:00:09,000")); ok("export txt / md / doc / srt / json");

  r = await call("/api/stats");
  assert.equal(r.body.meetings, 1);
  assert.deepEqual(r.body.folders, ["Aymakan"]); ok("stats, folders and tags");

  r = await call("/api/settings", { method: "PUT", body: JSON.stringify({ slackWebhook: "http://not-https" }) });
  assert.equal(r.status, 400); ok("webhooks must be https");

  r = await call("/api/upload", { method: "POST", headers: { "content-type": "audio/mpeg", "x-filename": "call.mp3" }, body: "abc" });
  assert.equal(r.status, 400);
  assert.ok(/DEEPGRAM_API_KEY|OPENAI_API_KEY/.test(r.body.error)); ok("clear message when upload key is missing");

  assert.equal((await call("/api/meetings/../../etc/passwd")).status, 404);
  assert.equal((await call("/api/meetings/bad id!")).status, 400); ok("bad ids refused");
  assert.equal((await fetch(base + "/../server.js")).status, 404); ok("cannot read server files");

  r = await call("/api/meetings/" + meeting.id, { method: "DELETE" });
  assert.equal((await call("/api/meetings/" + meeting.id)).status, 404); ok("delete meeting");

  console.log(`\n  All ${n} checks passed.\n`);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => {
  console.error("\n  ✗ FAILED:", e.message, "\n", e.stack);
  process.exit(1);
});
