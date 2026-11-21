# AivraSol Agent Desk

A self-hosted WhatsApp sales agent. Customers who reach you from ads get answered by an AI
that knows your products, writes like you, replies at a human pace, and follows up with
people who showed interest but never bought. You watch and steer everything from a web dashboard.

## What it does

- **Several numbers, two ways to connect.** Normal or Business app numbers link by QR code or
  pairing code. Official WhatsApp Business Cloud API numbers connect with a Meta token.
- **Any model, automatic switching.** Claude, ChatGPT, Gemini, Grok, OpenRouter, DeepSeek, GLM,
  Qwen, LongCat, AgentRouter, Groq, Cerebras, Mistral, GitHub Models, NVIDIA, SambaNova, Together,
  Ollama, or any OpenAI-compatible endpoint. Models form an ordered chain: when one hits a rate
  limit, runs out of quota, or goes down, the next one answers the same message, and the first
  rejoins when its limit resets. Remaining quota is shown live where the provider reports it.
- **Human pacing.** Waits for the customer to finish typing, marks read, shows "typing…" for a
  realistic time, splits long answers into bubbles, and caps replies per hour.
- **Learns from your chats.** "Learn from my chats" reads conversations you answered yourself and
  writes down what you offer, the prices you quote and how you sound. The result is editable.
- **Commands in plain language.** On the Command page, or in WhatsApp's "Message yourself" chat on a
  linked phone, tell the agent what to do: "check the last 5 days and follow up every 5 minutes with
  people who did not buy", "who needs me today?", "remember: 10% off this week". Bulk sends are
  confirmed with you first; daily caps, quiet hours and opt-outs always apply.
- **Train it three ways.** From your own chats, from your website (give it a link), or from your
  WhatsApp Business profile and catalogue. Each fills an editable text box on the Knowledge page.
- **Tasks.** Every job you give the agent (a follow-up batch, or "every 30 minutes…", "daily at 21:00…")
  shows on the Tasks page with its progress, and can be paused, resumed, run now or removed.
- **Saved shop knowledge.** `knowledge/*.md` is loaded at start, so the agent knows the shop even when
  the website cannot be opened from this computer. Refresh the product list with
  `node scripts/fetch-shop.mjs https://yourshop.com/shop`.
- **Urdu.** Replies in Urdu script (اردو) when the customer writes in it, or always, if you choose.
- **More than sales.** Set the agent's job to sales, support, bookings, a personal assistant, or your own.
- **Reads old chats.** After a QR link, past conversations sync in. "Review past conversations"
  classifies each one and drafts a follow-up for interested people who did not buy.
- **Follow-ups you control.** Drafts wait for approval by default. Sending is spaced out, capped
  per day, and paused during quiet hours. Customers who ask to stop are never followed up.
- **Hands over when it should.** Refunds, complaints, and anything not in your knowledge go to
  you. When you reply from your phone, the agent steps back.
- **Live test.** Chat with the agent as a customer, or run one prompt across several models side
  by side, without touching WhatsApp.

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000, create the admin account (username and password), then:

1. **Models**: add at least one API key (two or more for failover).
2. **Knowledge**: products, prices, FAQs, and a few of your real replies.
3. **Live test**: check the answers.
4. **Numbers**: link a number.

Everything is stored in `./data` (SQLite database, WhatsApp sessions, encryption key).

**Accounts for other businesses.** On the **Clients** page the admin creates accounts. Each one gets its own
dashboard with its own WhatsApp numbers, chats, knowledge and models, running as a separate process with its own
folder (`data/tenants/u<id>/`), so nobody sees anyone else's data. The admin can lend them the admin's own AI
models with a daily request limit (the keys never leave the admin's workspace), or they add their own keys.
The admin can open any client's dashboard to help them. Each account uses about 150 MB of memory.
`npm run single` runs one dashboard without accounts, the way it worked before.

**Your own files.** Knowledge page → Upload files: `.md`, `.txt` or `.docx` (price lists, FAQs, policies, scripts).
They are kept in `data/knowledge/` and read into the agent's knowledge; for each reply only the paragraphs that
match the customer's question go to the model, so long files do not cost many tokens. Remove a file to forget it.

**Shortcuts in Command.** Teach the agent your own words once: `jab main "report" kahun to pichle 1 din ki stats aur
pending follow-ups batao` (or `when I say "report", ...`). Then `report` runs the whole instruction. `shortcuts` lists
them, `report wala shortcut hatao` removes one.

**All models together.** Customer replies use your models in the order you set and switch when one fails. Batch work
(reading many chats, follow-up batches) takes turns over every ready model, so each one's limit lasts longer.
Several keys of one provider can be added as separate models, but Groq counts limits per account (organization),
so two keys from the same Groq account share one limit.

**Tags and your customer list.** Put your own labels on chats (Inbox → Tags, or `/tag vip` inside the chat on
WhatsApp). Then in Command: `vip tag walon ko follow-up bhejo`. Inbox → "Download customers (CSV)" gives your
customers (people who messaged you; groups are left out) with number, stage, tags and summary, for Excel or Google Sheets.

**Follow-ups in your words.** Knowledge page → "Your follow-up message": write one example the way you would send it,
and "Links it may share" (website, channels). Every follow-up is written like your example, with what that customer
asked about filled in.

**Campaigns.** Every follow-up flow is a campaign with its own settings, log and history (Campaigns page).
- *Automatic campaigns* run all the time. A new lead joins one by its entry rules (the Meta ad it came from,
  words in its first message, the number) and gets that campaign's reply instructions, follow-up steps
  (e.g. 2 h, 1 day, 3 days), gap between follow-ups, approval and night setting. Everyone else joins the
  default campaign, whose timings are the ones in Settings.
- *One-time tasks* message people already in your chats (from Command or the Campaigns page).
- Every change is recorded with who made it (dashboard or Command). Settings only holds the per-number
  safety limits (daily cap, quiet hours, one batch message per person per day), which apply to all campaigns.
- In Command: `naya campaign: jo canva ad se aayein ...`, `campaign 4 mein gap 5 to 7 minute kar do`, `campaign 4 rok do`.

**Prices that change.** On the Knowledge page, "When a customer asks the price" → "Send the product link" makes the
agent never write a price or stock (prices are removed from everything it reads, and a price that still slips
into a reply is caught); it sends the product's link, where the website shows the current price.
See `.env.example` for options. Put the dashboard behind HTTPS before exposing it to the internet.

## Things to know before going live

- **QR-linked numbers can be restricted by WhatsApp.** Linking by QR uses the WhatsApp Web
  protocol through an unofficial library ([Baileys](https://github.com/WhiskeySockets/Baileys)),
  which WhatsApp's terms do not allow for automation. Pacing and caps lower the risk; nothing
  removes it. Use the Cloud API for a number you cannot afford to lose.
- **Cloud API rules.** Free-form replies are only allowed within 24 hours of the customer's last
  message. After that, Meta requires an approved template; set one per number for follow-ups.
  History from before the webhook was connected is not available.
- **"New leads only" is the default for QR numbers**, so friends and existing contacts on a
  personal number are not auto-answered. Change it per number, or per chat in the Inbox.
- **The agent does not pretend to be human.** It writes naturally, but if a customer sincerely
  asks whether they are talking to a bot, it says it is an AI assistant and offers a person.
- **Model IDs change.** The suggested model names may be out of date; use "Load models" to fetch
  the provider's current list. Base URLs are editable for the same reason.
- Voice notes and images arrive as `[voice note]` / `[image]` placeholders; the agent sees that
  one was sent but not its content.

## Run it on a server

On any Ubuntu server (Oracle Cloud Always Free, a Hostinger VPS, …), clone the project and run
`bash deploy/setup-server.sh agent.yourdomain.com`. It installs Node.js, keeps the agent running with PM2 and
adds HTTPS with Caddy. Step by step for Oracle: [deploy/ORACLE.md](deploy/ORACLE.md).

## Tests

```bash
npm test
```

The suite runs the real pipeline against a fake model server and a fake WhatsApp connector:
failover and quota handling, paced replies, handoff, opt-out, follow-up approval, and the
past-chat review.

## Layout

```
src/hub.js             accounts: sign-in, one workspace process per account, shared AI with daily limits
src/server.js          one workspace: HTTP API, live events, Cloud API webhook
src/llm/               provider presets, unified client, failover router
src/wa/                QR connector, Cloud API connector, account manager
src/agent/             prompt + decisions, live reply pipeline, follow-ups, owner commands, learning
public/                dashboard (no build step)
```
