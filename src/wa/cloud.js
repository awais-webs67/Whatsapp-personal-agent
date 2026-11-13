// Official WhatsApp Business Cloud API (Meta). No ban risk, but:
//  - history before the webhook was connected is not available;
//  - free-form messages are only allowed within 24h of the customer's last message,
//    after that Meta requires a pre-approved template.
import crypto from 'node:crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';
const DAY = 24 * 60 * 60 * 1000;

export class CloudConnector {
  /** config: { phoneNumberId, accessToken, appSecret, verifyToken, template, templateLang } */
  constructor(account, hooks, config) {
    this.account = account;
    this.hooks = hooks;
    this.config = config;
    this.lastInbound = new Map(); // jid -> { id, ts }
  }

  async start() {
    const { phoneNumberId, accessToken } = this.config;
    if (!phoneNumberId || !accessToken) return this.hooks.onStatus({ state: 'error', error: 'Phone number ID and access token are required' });
    this.hooks.onStatus({ state: 'connecting' });
    try {
      const info = await this.#api('GET', `/${phoneNumberId}?fields=display_phone_number,verified_name`);
      this.hooks.onStatus({ state: 'connected', me: String(info.display_phone_number || '').replace(/\D/g, ''), pushName: info.verified_name || null });
    } catch (e) {
      this.hooks.onStatus({ state: 'error', error: e.message });
    }
  }
  async stop() { this.hooks.onStatus({ state: 'disconnected' }); }

  async #api(method, path, body) {
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.config.accessToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `Graph API ${res.status}`);
    return json;
  }

  /** Meta signs every webhook body with the app secret. */
  verifySignature(rawBody, header) {
    if (!this.config.appSecret) return true; // not configured: accept (the dashboard warns about this)
    const expected = `sha256=${crypto.createHmac('sha256', this.config.appSecret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(String(header || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  handleWebhook(payload) {
    const out = [];
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== String(this.config.phoneNumberId)) continue;
        const names = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) {
          const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title
            || (m[m.type]?.caption ? `[${m.type}] ${m[m.type].caption}` : `[${m.type === 'audio' ? 'voice note' : m.type}]`);
          const ts = Number(m.timestamp) * 1000 || Date.now();
          this.lastInbound.set(m.from, { id: m.id, ts });
          out.push({ jid: m.from, phone: m.from, name: names.get(m.from) || null, waId: m.id, fromMe: false, text, type: m.type === 'text' ? 'text' : 'media', ts });
        }
      }
    }
    if (out.length) this.hooks.onMessages(out, { live: true });
  }

  /** `lastInAt` comes from the database so the 24h rule survives restarts. */
  windowOpen(lastInAt) { return !!lastInAt && Date.now() - lastInAt < DAY; }

  async sendText(jid, text, { lastInAt } = {}) {
    if (!this.windowOpen(lastInAt ?? this.lastInbound.get(jid)?.ts)) return this.sendTemplate(jid);
    const res = await this.#api('POST', `/${this.config.phoneNumberId}/messages`, { messaging_product: 'whatsapp', to: jid, type: 'text', text: { body: text, preview_url: false } });
    return res.messages?.[0]?.id || null;
  }

  async sendTemplate(jid) {
    const { template, templateLang } = this.config;
    if (!template) throw new Error('Outside the 24-hour window: Meta only allows an approved template here. Set a follow-up template on this number.');
    const res = await this.#api('POST', `/${this.config.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', to: jid, type: 'template', template: { name: template, language: { code: templateLang || 'en' } },
    });
    return res.messages?.[0]?.id || null;
  }

  async typing(jid, on) {
    const last = this.lastInbound.get(jid);
    if (!on || !last) return;
    await this.#api('POST', `/${this.config.phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: last.id, typing_indicator: { type: 'text' } }).catch(() => {});
  }
  async markRead(jid) {
    const last = this.lastInbound.get(jid);
    if (last) await this.#api('POST', `/${this.config.phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: last.id }).catch(() => {});
  }
  async idle() {}
}
