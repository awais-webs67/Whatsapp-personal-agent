// WhatsApp Web session (QR scan or pairing code). Works with both normal and Business app numbers.
// This is an unofficial protocol client: WhatsApp can restrict numbers that automate through it.
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, getContentType,
  isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, jidNormalizedUser,
} from 'baileys';
import { DATA_DIR } from '../db.js';

const logger = pino({ level: 'silent' });
// Optional outbound proxy for the WhatsApp connection (must allow WebSocket upgrades).
const PROXY = process.env.WA_PROXY || '';
const proxyAgent = () => (PROXY ? new HttpsProxyAgent(PROXY) : undefined);
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage', 'editedMessage'];
const LABELS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'voice note', documentMessage: 'document', stickerMessage: 'sticker', locationMessage: 'location', contactMessage: 'contact' };

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const w = WRAPPERS.find((k) => m[k]?.message);
    if (!w) break;
    m = m[w].message;
  }
  return m;
}

const digits = (jid) => (jid && /@(s\.whatsapp\.net|c\.us)$/.test(jid) ? jid.split('@')[0].split(':')[0] : null);

/** Baileys message -> our neutral shape, or null for things we don't track (groups, reactions...). */
export function toNeutral(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || !msg.message) return null;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return null;
  const content = unwrap(msg.message);
  const type = getContentType(content);
  if (!type || ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage'].includes(type)) return null;
  const body = content[type];
  const caption = typeof body === 'string' ? body : body?.text || body?.caption || '';
  const label = LABELS[type];
  const text = label ? `[${label}]${caption ? ` ${caption}` : ''}` : caption;
  if (!text) return null;
  return {
    jid: jidNormalizedUser(jid),
    phone: digits(jid) || digits(msg.key.remoteJidAlt) || digits(msg.key.senderPn),
    name: msg.key.fromMe ? null : msg.pushName || null,
    waId: msg.key.id,
    fromMe: !!msg.key.fromMe,
    text,
    type: label ? 'media' : 'text',
    ts: Number(msg.messageTimestamp || 0) * 1000 || Date.now(),
    raw: { key: msg.key },
  };
}

export class QrConnector {
  /** @param {{id:number}} account  @param {{onStatus,onMessages,onContacts}} hooks */
  constructor(account, hooks) {
    this.account = account;
    this.hooks = hooks;
    this.dir = path.join(DATA_DIR, 'sessions', String(account.id));
    this.sock = null;
    this.stopped = false;
    this.retries = 0;
    this.lastKeys = new Map(); // jid -> last inbound message key (for read receipts)
    this.pairPhone = null;
  }

  async start({ pairPhone = null } = {}) {
    this.stopped = false;
    this.pairPhone = pairPhone ? String(pairPhone).replace(/\D/g, '') : null;
    await this.#open();
  }

  async #open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    this.hooks.onStatus({ state: 'connecting' });
    const sock = makeWASocket({
      auth: state, logger,
      agent: proxyAgent(), fetchAgent: proxyAgent(),
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,        // pull existing chats so the agent can read past conversations
      markOnlineOnConnect: false,   // keep phone notifications working
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    let pairingRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (sock !== this.sock) return;
      if (qr) {
        if (this.pairPhone && !pairingRequested && !sock.authState.creds.registered) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(this.pairPhone);
            this.hooks.onStatus({ state: 'pairing', pairingCode: code?.match(/.{1,4}/g)?.join('-') || code });
          } catch (e) {
            this.hooks.onStatus({ state: 'error', error: `Pairing code failed: ${e.message}` });
          }
        } else if (!this.pairPhone) {
          this.hooks.onStatus({ state: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320, color: { dark: '#191F24', light: '#FFFFFF' } }) });
        }
      }
      if (connection === 'open') {
        this.retries = 0;
        this.pairPhone = null;
        this.hooks.onStatus({ state: 'connected', me: digits(jidNormalizedUser(sock.user?.id)) || sock.user?.id, pushName: sock.user?.name || null });
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (this.stopped) return;
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(this.dir, { recursive: true, force: true });
          this.sock = null;
          this.hooks.onStatus({ state: 'logged_out', error: 'Logged out from the phone. Link the device again.' });
          return;
        }
        // 515 right after pairing is expected: WhatsApp asks the client to reconnect.
        const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 2000 * 2 ** this.retries++);
        this.hooks.onStatus({ state: 'connecting', error: code === DisconnectReason.restartRequired ? null : `Connection dropped (${code ?? 'unknown'}), retrying` });
        setTimeout(() => { if (!this.stopped) this.#open().catch((e) => this.hooks.onStatus({ state: 'error', error: e.message })); }, delay);
      }
    });

    const forward = (msgs, live) => {
      const out = [];
      for (const m of msgs) {
        const n = toNeutral(m);
        if (!n) continue;
        if (!n.fromMe) this.lastKeys.set(n.jid, m.key);
        out.push(n);
      }
      if (out.length) this.hooks.onMessages(out, { live });
    };
    sock.ev.on('messages.upsert', ({ messages, type }) => forward(messages, type === 'notify'));
    sock.ev.on('messaging-history.set', ({ messages = [], contacts = [] }) => {
      this.#contacts(contacts);
      forward(messages, false);
    });
    sock.ev.on('contacts.upsert', (c) => this.#contacts(c));
  }

  #contacts(contacts) {
    const list = contacts
      .map((c) => ({ jid: c.id && jidNormalizedUser(c.id), phone: digits(c.id) || digits(c.phoneNumber), name: c.name || c.notify || c.verifiedName || null }))
      .filter((c) => c.jid && c.name && !isJidGroup(c.jid));
    if (list.length) this.hooks.onContacts(list);
  }

  #need() {
    if (!this.sock?.user) throw new Error('WhatsApp is not connected');
    return this.sock;
  }

  async sendText(jid, text) {
    const sent = await this.#need().sendMessage(jid, { text });
    return sent?.key?.id || null;
  }
  async typing(jid, on) {
    const sock = this.#need();
    if (on) await sock.sendPresenceUpdate('available').catch(() => {});
    await sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid).catch(() => {});
  }
  async markRead(jid) {
    const key = this.lastKeys.get(jid);
    if (key) await this.#need().readMessages([key]).catch(() => {});
  }
  async idle() {
    await this.sock?.sendPresenceUpdate('unavailable').catch(() => {});
  }

  async stop({ logout = false } = {}) {
    this.stopped = true;
    const sock = this.sock;
    this.sock = null;
    if (!sock) { if (logout) fs.rmSync(this.dir, { recursive: true, force: true }); return; }
    if (logout) {
      await sock.logout().catch(() => {});
      fs.rmSync(this.dir, { recursive: true, force: true });
    } else {
      sock.end(undefined);
    }
  }
}
