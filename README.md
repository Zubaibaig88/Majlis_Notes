# Majlis Notes (مجلس)

Live meeting transcripts and AI notes — your own version of a Tactiq-style tool.
No bot joins your call. Majlis Notes reads the live captions in your browser.

It has two parts:

| Part | What it does |
|---|---|
| **Chrome extension** (`extension/`) | Runs inside Google Meet, Teams (web) and Zoom (web). Shows the live transcript in a side panel with speaker names, highlights, notes, screenshots and AI summary. |
| **Server + dashboard** (`server/`) | Stores all meetings, runs the AI prompts with Claude, makes share links, transcribes uploaded recordings, and gives you a web dashboard. No npm packages needed. |

---

## 1. Start the server (5 minutes)

You need **Node.js 18 or newer** (https://nodejs.org).

```bash
cd server
cp .env.example .env        # on Windows: copy .env.example .env
```

Open `.env` and fill in:

- `MAJLIS_TOKEN` — any long secret, for example `fn-7f3k9-zubair-2026-x81`. You will type the same value in the extension and the dashboard.
- `ANTHROPIC_API_KEY` — your Claude API key from https://console.anthropic.com (for AI summaries).
- *(optional)* `DEEPGRAM_API_KEY` — to transcribe uploaded recordings with speaker names and Arabic. Or use `OPENAI_API_KEY` (Whisper) instead.

Then run:

```bash
node server.js
```

Open **http://localhost:8787** — this is your dashboard. Enter your access key when asked.

To check everything works: `npm test` (23 checks).

## 2. Install the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `extension` folder
4. Pin Majlis Notes (puzzle icon → pin)
5. Click the Majlis Notes icon → **Settings** → enter the server address (`http://localhost:8787`) and your access key → **Test connection**

## 3. Use it

1. Join a Google Meet call. Majlis Notes starts by itself and turns on captions for you.
2. The panel shows the live transcript. You can:
   - **★** highlight a line, **✎** add a note to a line
   - **📷 Shot** — save a screenshot into the transcript (for slides)
   - **⏸ Pause** / resume
   - **⧉ Copy** or **⋯ → Download .txt**
   - **✦ Summary** — summary, action items, decisions or follow-up email
   - **⋯ → Tell others** — posts a note in the Meet chat that you are transcribing
3. When the call ends, the meeting is saved, an AI summary is made, and (if set up) it is sent to Slack / your webhook.
4. Open the dashboard for everything else.

**Teams (web):** turn on captions yourself — More (…) → Language and speech → Turn on live captions.
**Zoom (web client):** click CC / Show captions.

## Dashboard features

**Meetings & Organization:**
- All meetings, grouped by date, with search across titles, transcripts and AI notes
- Stats: meetings this week, hours in meetings, words transcribed
- **Spaces** — collections to organize meetings by project, client, or team
- Folders and tags for additional organization
- Filter meetings by space, folder, or tag

**Meeting Detail Page (Tactiq-style):**
- **Tabbed interface**: Transcript, AI, Notes & Comments
- **Right sidebar** with meeting metadata, speaker stats, and space selector
- Full transcript with speaker filtering, highlights, word corrections
- **Who talked most** — visual talk-time per speaker
- **Comment & Notes** — add comments with timestamps, keep private notes (AI reads them)
- Screenshots integrated into transcript

**AI & Analysis:**
- 10 built-in AI prompts (summary, action items, decisions, follow-up email, minutes, Q&A, sales call, interview scorecard, highlights, **summary in Arabic**)
- **Your own prompts**, grouped in kits
- **Ask anything** about a meeting — custom questions and follow-ups
- AI notes with copy and delete options

**Integration & Sharing:**
- **Google Calendar sync** — auto-add meetings to your calendar (configure in Settings)
- Share links (pick transcript and/or AI notes; turn off any time)
- Export: Word (.doc), Markdown (Notion/Obsidian), .txt, subtitles (.srt), JSON, or copy straight into Google Docs
- Send to Slack, any webhook (Zapier / Make / n8n), or email
- Upload a recording (MP3, M4A, WAV, MP4…) to get a transcript and summary

**UI & Experience:**
- Light and dark mode, works on phone
- Modern Tactiq-inspired design with clean grid layout
- Real-time search and filtering

## Where data lives

- On your computer: each transcript is also kept inside the extension (so nothing is lost if the server is off; it syncs later — see **History → Sync now**).
- On the server: `server/data/` — one JSON file per meeting, screenshots in `data/shots/`. Back up this folder.

## Putting it online (so it works away from your laptop)

Any host that runs Node works (Render, Railway, Fly.io, a small VPS, etc.):
1. Upload the `server` folder, set the same `.env` values as environment variables.
2. Keep `data/` on a persistent disk.
3. Use **https** and a strong `MAJLIS_TOKEN`.
4. Put the new address in the extension Settings.

## Good to know

- Majlis Notes reads the meeting app's captions. Meet, Teams and Zoom change their page code from time to time. If captions stop being picked up, only `extension/adapters.js` needs updating.
- Caption quality (including Arabic) depends on the meeting app. Set the caption language in Meet to Arabic for Arabic meetings.
- Tell people when you transcribe. Recording or transcribing calls can need consent under local law and company policy.

## Recently added (v2)

- [x] **Tactiq-style redesign** — modern grid layout with tabbed interface and sidebar
- [x] **Spaces/Collections** — organize meetings by project, client, or team
- [x] **Google Calendar integration** — auto-sync meetings to your calendar with OAuth
- [x] **Comment threads** — add timestamped comments to meetings
- [x] **Space filtering** — quickly find meetings by space in sidebar
- [x] **Enhanced UI** — Tactiq-inspired design with improved visual hierarchy

## Plan for future versions

- [ ] Login for a team (several users, shared meetings)
- [ ] Direct Google Docs / Notion / HubSpot connections (today: via webhook)
- [ ] Calendar event enrichment: fetch meeting details from Google Calendar
- [ ] Own audio capture (so it works even when captions are off) and mixed Arabic/English speech-to-text
- [ ] Mobile app for iOS/Android
- [ ] Publish to the Chrome Web Store
