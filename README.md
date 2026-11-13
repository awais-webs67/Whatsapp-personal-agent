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

Open http://localhost:3000, set an owner password, then:

1. **Models**: add at least one API key (two or more for failover).
2. **Knowledge**: products, prices, FAQs, and a few of your real replies.
3. **Live test**: check the answers.
4. **Numbers**: link a number.

Everything is stored in `./data` (SQLite database, WhatsApp sessions, encryption key).
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

## Tests

```bash
npm test
```

The suite runs the real pipeline against a fake model server and a fake WhatsApp connector:
failover and quota handling, paced replies, handoff, opt-out, follow-up approval, and the
past-chat review.

## Layout

```
src/server.js          HTTP API, auth, live events, Cloud API webhook
src/llm/               provider presets, unified client, failover router
src/wa/                QR connector, Cloud API connector, account manager
src/agent/             prompt + decisions, live reply pipeline, follow-ups, owner commands, learning
public/                dashboard (no build step)
```
