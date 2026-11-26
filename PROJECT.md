# AivraSol Agent Desk: full project guide

This file explains everything about the project: what it does, how it is built, where each piece lives,
how data flows, how to run, test and deploy it, and the rules the owner works by. Read it before changing
anything. It is written so another AI coding tool (Antigravity, Cursor, Claude Code…) or a new developer
can continue the work without the earlier chat history.

---

## 1. What the product is

A self-hosted **WhatsApp sales agent with a dashboard that works like an ads manager**.

- A business links one or more WhatsApp numbers: by QR code (WhatsApp Web / Baileys), or with the
  official WhatsApp Business **Cloud API** (Meta token).
- Leads usually come from Meta click-to-WhatsApp ads. The AI answers them, follows up with people who
  go quiet, and hands a chat to the owner when needed.
- **Everything is organised in campaigns**, like Meta Ads Manager. Each campaign has its own:
  - numbers
  - knowledge (brand, products and prices, FAQs, policies, rules, writing style, files)
  - settings (auto reply, reply speed, voice notes, pictures, follow-up timing, gap, quiet hours,
    daily limit, labels, end date)
  - people, messages, tasks, test chat, command chat and history.
- The owner controls everything from the dashboard **or by plain-language commands** (Roman Urdu,
  English or Urdu) on the Command page, inside a campaign's Command tab, or from WhatsApp's
  "Message yourself" chat.
- There are also cold **email campaigns** from the owner's own SMTP mailbox (warm-up, office hours,
  unsubscribe, stop on reply). Cold outreach is by email only, never WhatsApp.

The owner runs AivraSol and SellMeTools.com (Pakistan). The live server is Oracle Cloud Always Free,
reached through sslip.io with Caddy for HTTPS.

---

## 2. Tech stack

- **Runtime:** Node.js 22, ES modules (`"type": "module"`). No build step, no framework.
- **Server:** Express 5 (`src/server.js`). Server-sent events at `/api/events` push live updates to the
  dashboard.
- **Database:** built-in `node:sqlite` (`DatabaseSync`), one file per workspace (`data/app.db`).
  Schema and migrations live in `src/db.js`; new columns are added with `ALTER TABLE` in a try loop.
- **WhatsApp:**
  - `baileys` 7 for QR or pairing-code numbers (`src/wa/baileys.js`).
  - The Cloud API through webhooks (`src/wa/cloud.js`).
  - Both feed one neutral message format into `src/wa/manager.js`.
- **AI:** any OpenAI-compatible provider, plus Anthropic. There is a failover router with
  per-purpose chains and cooldowns (`src/llm/`).
- **Email:**
  - `nodemailer` sends (SMTP).
  - `imapflow` reads replies (IMAP).
  - Domain checks use `dns.promises`.
- **UI:**
  - Plain JS modules in `public/`, built with a tiny `h()` helper (`public/ui.js`). No React.
  - Icons are Lucide (`lucide-static`), served at `/icons` and drawn as CSS masks by `ico(name)`.
- **Tests:** `node --test` (`test/*.test.js`), about 95 tests, roughly 70 s. They use a fake LLM
  server, a fake WhatsApp connector and a fake SMTP server.
- **Hosting:**
  - PM2 keeps the app running; Caddy provides HTTPS.
  - Cron runs `deploy/auto-update.sh` every 5 minutes (git pull of `main`, then `npm ci`, then
    restart).
  - Cron runs `deploy/backup.mjs` nightly at 03:20.

---

## 3. Run, test, deploy

```bash
npm install
npm start            # starts the hub (src/hub.js): login page plus one workspace process per account
npm run single       # one workspace only (src/server.js), handy for development
npm test             # all tests
```

**Demo data for UI work:** start with `DATA_DIR=/some/folder PORT=3557 node src/hub.js`, create the admin
on first open, then log in.

**Important environment variables:**

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | Where the hub listens |
| `DATA_DIR` / `DB_PATH` | Where databases, WhatsApp sessions and uploads live (default `./data`) |
| `APP_SECRET` | Key that encrypts saved API keys and passwords; keep it stable |
| `WORKSPACE_PORT_BASE`, `HUB_TOKEN` | Hub to workspace forwarding |
| `WEBHOOK_PREFIX` | e.g. `/w/u3`; public paths of a workspace behind the hub |
| `SHARED_AI_URL`, `SHARED_AI_KEY` | Optional AI shared by the hub with client workspaces |
| `WA_PROXY` | Optional proxy for Baileys |
| `KNOWLEDGE_DIR` | Folder of `.md`/`.txt` loaded as saved knowledge at start |
| `DNS_ORDER` | DNS result order (ipv4first on some clouds) |

**Deploy:** see `deploy/ORACLE.md`.
- `deploy/setup-server.sh` installs Node, PM2, Caddy and cron, and sets up the auto-update and backup
  jobs.
- **Every push to `main` goes live within about 5 minutes.**

---

## 4. Folder map

```
src/
  hub.js                 multi-account hub: login, clients (admin), forwards /w/:key/* to each workspace
  server.js              one workspace: every /api route, SSE, startup (start())
  core.js                event bus (emit), activity log, settings (DEFAULT_SETTINGS, getSettings,
                         saveSettings), PACING presets, encryption, quiet-hours helpers
  db.js                  SQLite schema, migrations, get/all/run/update helpers
  csv.js                 parseCsv, toCsv, normPhone (03xx -> 923xx)
  wa/
    manager.js           connectors per number, ingest of messages, statusOf, sendText, labels
                         (onLabel, onLabelChat, findLabels, applyLabel, removeLabel, deleteLabel,
                          refreshLabels, labelsList)
    baileys.js           QR/pairing connector (Baileys); voice and picture download; label events;
                         refreshLabels() re-reads labels from WhatsApp
    cloud.js             WhatsApp Cloud API connector (webhook in, Graph API out)
  llm/
    catalog.js           provider presets (Groq, Gemini, OpenAI, OpenRouter, DeepSeek, …)
    client.js            one call to one provider; error explanations; /v1 fixups; model lists
    router.js            complete(): failover chain per purpose, cooldowns, outOfModels, nextReadyAt
  agent/
    pipeline.js          live customer message -> campaign -> reply (debounce, typing, bubbles)
    brain.js             buildSystem() (the prompt), decide() (reply/followup/analyze JSON),
                         customer profile card, price stripping in link mode
    campaigns.js         campaign model: AUTO_FIELDS, configOf, matchCampaign, assignCampaign,
                         updateAuto, createAuto, statsOf, campaignContext, withCampaign, humanFor,
                         mediaFor, deliveryOf, endCampaigns
    campaign-knowledge.js  per-campaign knowledge (KNOW fields), knowledgeOf, saveKnowledge,
                         copyKnowledge, knowledgeSettings (merges into the prompt), saveSourceBlock
    campaign-edit.js     updateCampaign(): one way to change any campaign kind, with history
    campaign-command.js  commands typed inside a campaign: quick orders without a model
                         (status, pause, resume, gap, switches) and the campaign brief for the model
    members.js           bring existing chats into a campaign (preview, then add)
    jobs.js              progress for work inside a campaign (labels, adding people)
    commander.js         the command agent: TOOLS (actions), confirmation gate (Haan/Nahi),
                         threads, campaign threads, facts lines under replies
    intent.js            fast intent parsing without a model (switches, gaps, times, help…)
    followups.js         drafting and sending follow-ups and one-time batches (runCampaign),
                         pacing slots, quiet hours, daily caps, whyNotSending
    tasks.js             tasks table: createTask, taskView (progress), controlTask, scheduler tick
    task-log.js          taskEvent(): step-by-step log of each campaign or task
    labeling.js          findChats (filters), label/unlabel chats with previews
    learn.js             learn from chats, from a website, from the WhatsApp profile (per campaign)
    voice.js             voice notes -> text (Whisper on Groq/OpenAI); pictures -> description
                         (vision model)
    score.js             lead score 0-100: hot / warm / cold (no AI)
    reports.js, watchdog.js (health problems + campaign end dates), updates.js (notify owner),
    tags.js, shortcuts.js, chat-commands.js, knowledge.js, knowledge-files.js, website.js
  email/index.js         email mailboxes, lists, campaigns, sending, replies, unsubscribe, domain check
public/
  index.html, app.css    shell and all styles (design tokens at the top of app.css)
  ui.js                  h(), set(), ico(), GET/POST/PUT/PATCH/DEL, act(), toast(), modal(), field(),
                         toggle(), stagePill(), leadPill()
  state.js               shared state S and live event subscriptions
  app.js                 sidebar, routes, health bar, badges, phone bottom bar and "More" sheet
  pages-campaigns.js     Campaigns table (home page), campaign page with all its tabs, wizard
  pages-main.js          Inbox (filters by number and campaign, chat, customer card)
  pages-ops.js           Numbers, Approvals, AI models
  pages-command.js       Command page (conversations with the agent)
  pages-email.js         Email: mailboxes, contact lists
  pages-config.js        Account page, Activity, Compare models
  pages-reports.js       Reports
  pages-hub.js           Clients (admin, hub mode)
test/                    agent.test.js (most), hub.test.js, knowledge.test.js
deploy/                  setup-server.sh, auto-update.sh, backup.mjs, ORACLE.md
knowledge/               saved shop knowledge (.md) loaded at start
scripts/                 fetch-shop.mjs (refresh product list from a shop page)
```

---

## 5. The campaign model (most important idea)

Campaigns are rows in the `tasks` table, where `kind` gives the type:

| kind | What it is |
|---|---|
| `auto` | **Always on.** New leads join it when they first write, by its Audience rules: ad title words (`adText`), Meta ad IDs (`adIds`), words in their first message (`keywords`), an existing WhatsApp label (`labels`), numbers (`accountIds`), `priority`. One **default** campaign (`params.isDefault`) takes every lead nobody else takes. |
| `batch` | **One-time.** Reads chats matching filters and writes a personal message for each, sent with a gap. |
| `email` | **Cold email** sequence to imported contact lists. |
| `scheduled` | Repeats a command on a schedule (e.g. a daily report). |
| `analysis` | Reads chats and learns from them. |
| `job` | Work inside a campaign (labels, adding people) with done/total progress. |

**Tasks inside a campaign.** `tasks.parent_id` links a task to its campaign. Work started from a
campaign's Command tab (a batch, a schedule, a label job) becomes a child task:
- It shows in that campaign's **Tasks** tab with live progress: phase, done of total, next message.
- It is hidden from the main Campaigns table.
- It uses the campaign's knowledge and rules (`campaignContext` and `knowledgeSettings` follow
  `parent_id`).

**Settings of an `auto` campaign** are in `tasks.params` (validated by `clean` in `campaigns.js`):

| Group | Fields |
|---|---|
| Follow-up timing | `steps` (hours of silence before each follow-up), `gapMin`/`gapMax` (minutes between sends), `approval`, `night`, `followups`, `templateFallback` |
| Replies | `autoReply`, `replySpeed` (instant/fast/natural), `voice`, `images` (true/false/null = standard) |
| Delivery | `quietStart`/`quietEnd` (own quiet hours), `dailyCap` (own daily limit), `endsAt` (pauses itself) |
| Labels | `label` (put on each lead) |

The default campaign keeps `steps`, gap and approval in account settings (`settings.followup`) for
backward compatibility.

**Knowledge per campaign** (`campaign-knowledge.js`, `KNOW` list):
- Fields: brand, persona, goal, about, offer (products and prices), faqs, policies, examples, tone,
  language, purchaseSignal, instructions, memory, learned, learnedWeb, format, followupStyle, links,
  prices (quote/link), shopLink, offTopic.
- The default campaign's knowledge **is** `settings.business` (older installs keep everything).
- A new campaign starts as a **copy** of the default campaign's knowledge (`startKnowledge` in
  server.js), then is fully its own.
- At prompt time, `knowledgeSettings()` replaces each account field with the campaign's own value
  when set, so an empty field falls back to the default.
- Files uploaded to a campaign (`params.files`) are added to every prompt (trimmed by relevance).

**Where a lead's settings come from:** `campaignOf(chat)` is the lead's campaign.
- `humanFor(chat)` gives reply pacing.
- `mediaFor(chat)` decides voice and pictures.
- `deliveryOf(taskId)` gives quiet hours and the daily cap.
- `withCampaign(settings, taskId)` gives the knowledge.

**Account-level only** (Account page):
- the master switch (`autopilot`), background reading, token saver
- number safety: messages per day per number, AI replies per hour, how long to stay quiet after the
  owner replies, default quiet hours, time zone
- notifications and password.

---

## 6. Message flow

1. **A customer writes.** `wa/manager.ingest` stores the message.
   - Voice notes go to `voice.queueVoice`; pictures go to `queueImage`.
   - Then `pipeline.onCustomer` runs.
2. **The lead joins a campaign.** `assignCampaign` puts the lead in a campaign by its rules, and puts
   the campaign's WhatsApp label on them.
3. **The agent answers,** unless one of these stops it: autopilot off, the campaign's auto reply off,
   the number's mode, the owner replied by hand (handoff), or the hourly cap. Answering works like
   this:
   - `decide(chatId, 'reply')` builds the prompt (`buildSystem`) with the campaign's knowledge and
     calls the model chain.
   - The model returns JSON: messages, stage, summary, profile and handoff.
   - `humanSend` sends the bubbles with read receipt, typing and gaps.
4. **Follow-ups are scheduled and sent.**
   - `scheduleNextFollowup` sets `next_followup_at` from the campaign's steps.
   - `followups.draftDue` writes the follow-up when it is due; `sendApproved` sends it.
   - Sending respects campaign gap slots, quiet hours, daily caps and approval.
5. **One-time campaigns** (`runCampaign`) read each matching chat, write a message, and queue them
   with a gap. Their progress is in `campaign` (reading done/total, current chat). They resume after
   a restart (`resumeBatch`).

---

## 7. Commands

`commander.handleCommand(text, { threadId, campaignId, chatId, scheduled })`:
- Commands run one at a time.
- Each conversation (thread) remembers its own history.
- A campaign has its own thread (`campaignThread(id)`).

How a command is handled, in order:

1. **Pending confirmation.** If the last answer asked "Kar dun? Haan / Nahi", the reply runs or
   cancels that action.
2. **Inside a campaign:** `campaignQuick` handles status, pause/resume, gap, start later, follow-ups,
   auto reply, night and approval **without a model**.
3. **Quick intents** (`intent.quickIntent`) without a model.
4. **Otherwise the command model** picks tools one JSON step at a time (up to `MAX_STEPS`).
   `systemPrompt` lists all tools and adds the campaign brief inside a campaign. The brief says that
   all chats are searchable and that "is product" means the campaign's keywords and ad words.

Main tools (`TOOLS` in commander.js):

| Area | Tools |
|---|---|
| Look | stats, find_chats (all chats: words anywhere in the messages, ad title, hours/days, stages, campaign; counts per stage, hot leads), read_chat, count_targets |
| Sending | start_followups, stop_followups, send_message, remind |
| Tasks and campaigns | schedule_task, list_tasks, pause_task, resume_task, remove_task, update_task, create_campaign, add_to_campaign |
| Knowledge | show_knowledge, edit_knowledge, remember (inside a campaign it is that campaign's memory), learn |
| Labels | list_labels, refresh_labels, label_chats, remove_label |
| Settings and help | change_settings, update_chat, help, show_format |

**Safety rules built in:**
- `gate()` asks for **Haan / Nahi** before label_chats, remove_label, remove_task, add_to_campaign and
  stop_followups. It first shows exactly how many chats and which label.
- Labels always use the **existing** label (exact name first, then same words in any order). A new
  label is made only with `create_new: true`. If none is found, labels are re-read from WhatsApp first.
- The model is told to report only what results show, and that "undo" never means deleting.
- The facts line under each reply (`withFacts`) states what really happened.

---

## 8. WhatsApp labels

- **Sync:**
  - `wa_labels` holds the labels per number.
  - A label on a chat is also a tag in `chats.tags`, as `labelTag(name)`, e.g. "Flow Google" becomes
    `flow-google`.
  - Events come from Baileys `labels.edit` and `labels.association`.
- **Labels arrive only when a number is first linked.** `refreshLabels()` resets the app-state sync
  version and re-reads them. It runs:
  - automatically on connect when no labels are known (once a day at most),
  - from the "Load labels" button on Numbers,
  - from the `refresh_labels` command.
- Labels exist only on WhatsApp Business app numbers linked by QR.

---

## 9. Email campaigns (`src/email/index.js`)

- **Mailboxes:**
  - Presets for Gmail, Outlook, Zoho, Hostinger, or custom SMTP/IMAP.
  - Passwords are encrypted and never returned. A footer (business name and address) is required.
- **Domain check:** SPF, DKIM (selector), DMARC and MX.
- **Lists:** CSV import or export. Anyone unsubscribed or bounced is kept and never emailed again.
- **Sending pace and limits:**
  - Warm-up: 10 a day, plus 5 a day up to the limit.
  - Office hours and weekdays, with a random gap per mailbox.
- **Message format:**
  - Plain text, with List-Unsubscribe plus a one-click POST.
  - Unsubscribe links use HMAC tokens at `/u/:token`.
- **Stopping:** a 5xx bounce stops that contact; a reply (IMAP) stops the sequence.
- **Writing:** AI writes JSON `{subject, body}` per person, or a template with spintax and `{first_name}`.

---

### Email agent (`src/email/agent.js`)
- **Address checks:** syntax, throw-away domains and the domain's mail server (MX). Invalid addresses are never sent;
  shared inboxes (info@…) are marked risky. Runs after each import and from "Check addresses".
- **Finding addresses:** a CSV row with only a website is kept (`status = no_email`). The agent reads the site
  (home, /contact, /about) and picks the best address on the same domain.
- **Research:** before the first email, the contact's website is read once (`email_contacts.research`) and one true
  detail goes in the first line.
- **Spam check:** `spamCheck()` flags spam words, several links, capitals, exclamation marks, emojis, long text and
  prices. An AI email with issues is written once more; what is left is shown on the message (`spam_note`).
- **Replies:** IMAP replies are parsed (`mailparser`) and sorted by AI into interested, question, not_now,
  not_interested, unsubscribe, wrong_person, out_of_office or other (`email_replies`).
  - Away and "later" replies put the next email back in line on the named day.
  - Unsubscribe, not interested and wrong person stop the contact for good.
  - Interested and questions get a drafted answer; the owner edits it and sends it in the same thread from the
    Email page, which also shows a WhatsApp link when the person gave a number.

## 10. Dashboard

**Sidebar:**

| Group | Pages |
|---|---|
| Manage | Campaigns (home), Inbox, Numbers, Command, Approvals |
| Assets | Email, AI models |
| Insights | Reports, Activity |
| Account | Account |
| Admin (hub admin only) | Clients |

The sidebar foot holds the "Agent" master switch, the "Read chats" switch, and the signed-in user with
sign out. On phones there is a bottom bar (Campaigns, Inbox, Numbers, Command) plus a "More" sheet.

**Campaigns page:** account KPIs (new leads, messages in, AI replies, need you, sales). Below, a table
of campaigns with on/off switches, delivery status, numbers, people, sent, replied, bought and reply
rate. It has filters and search, and "Create campaign" opens the wizard.

**Campaign page:** a hero with status and numbers, then these tabs:

| Tab | What it shows |
|---|---|
| Overview | Live panel (now, next message, running tasks, latest steps), how it works, switches |
| Tasks | Child tasks with live progress |
| Knowledge | Sections with a side menu; learn from its chats, website or profile; files; copy from another campaign |
| Settings | Campaign basics, Audience, Replies, Follow-ups and sending, Labels |
| People | Who is in it and why; add existing chats; label all; CSV export/import; open in Inbox |
| Messages | What it wrote, filtered by status, with the reason for each |
| Test | Chat as a lead of this campaign; see its instructions |
| Command | Commands for this campaign only |
| Log | Every step and every settings change |

Old addresses still work: `#/overview` and `#/tasks` go to Campaigns; `#/knowledge` goes to the default
campaign's Knowledge tab.

**Inbox:** `#/inbox/n<numberId>` shows one number's chats, `#/inbox/c<campaignId>` one campaign's chats,
`#/inbox/<chatId>` opens a chat. Filters include hot leads, needs you, unread and stage. Each chat shows
its lead score.

**Design rules used** (from Anthropic's frontend-design skill):
- sentence case, not all-caps labels
- labels and numbers only where they carry information
- one accent colour (orange) on a dark sidebar and light content
- motion only to show change (live dot, new log line)
- visible keyboard focus and reduced-motion support
- layout works down to phone width

---

## 11. Data model (main tables)

| Table | Holds |
|---|---|
| `accounts` | WhatsApp numbers (type qr/cloud, config, reply_mode, self_jid) |
| `chats` | One per customer per number: stage, summary, profile (JSON card), tags, campaign_id, ad_id/ad_title, next_followup_at, followup_count, needs_human, paused_until… |
| `messages` | Every message (from_me, by = customer/ai/owner/followup, type, text, ts) |
| `followups` | Messages to send or sent: kind auto/campaign/reminder, status pending/approved/sent/skipped/failed, due_at, task_id |
| `tasks` | Campaigns and tasks (kind, status, params JSON, parent_id, thread_id, schedule, last_result) |
| `task_events` | Step log per task. `campaign_changes` holds settings history per campaign |
| `commands`, `command_threads` | Command conversations (kinds: chat, whatsapp, tasks, `campaign:<id>`) |
| `providers` | AI models (encrypted keys, priority, use_for, limits) |
| `wa_labels` | WhatsApp labels per number |
| `email_accounts`, `email_contacts`, `email_sends` | Email |
| `settings`, `logs` | Key/value (`app` = settings JSON, flags such as `knowledgeSplit2`) and the activity log |

---

## 12. Working rules for this repo (from the owner)

- **Always work on `main` and push to `main`.** The server auto-deploys from it.
- **Commit as the owner:** `git -c user.name=awais-webs67 -c user.email=freelancerguru12@gmail.com commit …`
- **Never add AI attribution** (no Co-Authored-By or "Generated with" lines) to commits.
- **Talk to the owner in simple Roman Urdu.** Keep explanations short.
- **Never build** WhatsApp group-number scraping or cold WhatsApp messaging: it is spam and gets numbers
  banned. Cold outreach is email only. Do not spoof clients to get around provider limits.
- **Never ask for or handle private keys or secrets in chat.** The SSH key that was once shared should be
  rotated.
- **Placeholders and examples must not name real third-party products** (e.g. Canva); use neutral text.
- **Big or permanent actions must be confirmed** (Haan / Nahi). The agent must never claim work it did
  not do.
- **Run `npm test` before pushing.** Add a test for each new behaviour in `test/agent.test.js`.

---

## 13. Ideas not built yet

- **Lead Finder:** businesses by category and city via the Google Places API, e.g. "no website" leads
  for website offers. Export them or feed them into email lists.
- **MCP server:** lets Claude, ChatGPT or other agents control campaigns. It needs token auth,
  read-only and action scopes, and the same approval and pace limits.
- **Quick replies:** price list or bank details in one click.
- **Sale value per purchase:** revenue per ad or campaign in Reports.
- **Best time to send:** learned from when people reply.
- **Real-world checks still to do:** labels on the live number, voice notes and pictures, ad referral
  data, real SMTP/IMAP sending, and the domain check on real domains.
