import { h, set, GET, POST, PATCH, DEL, act, toast, modal, field, toggle, select, rel, num, stagePill, PROVIDER_STATUS } from './ui.js';
import { S, live } from './state.js';
import { accountPill } from './pages-main.js';

// ============================== Follow-ups ==============================
export function followups() {
  const st = { tab: 'pending', rows: [], campaign: null };
  const TABS = [['pending', 'Waiting for approval'], ['approved', 'Queued to send'], ['sent', 'Sent'], ['skipped', 'Skipped'], ['failed', 'Failed']];
  const tabs = h('div.tabs', { role: 'tablist' });
  const listBox = h('div.card');
  const campBox = h('div.card');
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Follow-ups'), h('p', {}, 'People who showed interest and went quiet. The agent drafts a personal nudge; you decide what goes out. Sends are spaced out, capped per day and paused during quiet hours.'))),
    h('div.stack', {}, campBox, h('div', {}, tabs, listBox)));

  const drawTabs = () => set(tabs, ...TABS.map(([id, label]) => h(`button${st.tab === id ? '.on' : ''}`, { role: 'tab', 'aria-selected': st.tab === id, onclick: () => { st.tab = id; drawTabs(); load(); } }, label)));

  function drawCampaign() {
    const c = st.campaign || {};
    const days = h('input', { type: 'number', min: 1, max: 3650, value: 90 });
    const limit = h('input', { type: 'number', min: 1, max: 2000, value: 200 });
    const account = select([['', 'All numbers'], ...S.accounts.map((a) => [a.id, a.name])], '', null);
    const again = h('input', { type: 'checkbox', style: 'accent-color:var(--orange)' });
    const start = h('button.btn.dark', { onclick: () => act(start, async () => { st.campaign = await POST('/api/campaign', { sinceDays: days.value, limit: limit.value, accountId: account.value || null, reanalyze: again.checked }); drawCampaign(); }) }, 'Start review');
    const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
    set(campBox, 
      h('header', {}, h('h2', {}, 'Review past conversations'), c.running ? h('span.pill.hot', {}, h('i.dia.hot.live'), 'Reading') : null),
      h('div.pad.stack', {},
        h('p', {}, 'The agent reads your stored chats, marks who bought and who did not, and drafts a follow-up for interested people who never purchased. Every draft lands in “Waiting for approval”. Nothing is sent until you approve it.'),
        c.running
          ? h('div.stack', {}, h('div.bar', {}, h('i', { style: `width:${pct}%` })), h('div.row', {}, h('div.grow', {}, `${num(c.done)} of ${num(c.total)} read · ${num(c.drafted)} drafts · ${num(c.failed)} failed`), h('button.btn.sm', { onclick: () => POST('/api/campaign', { cancel: true }) }, 'Stop')))
          : h('div.stack', {},
            c.startedAt ? h(`div.note${c.failed && !c.drafted ? '.bad' : ''}`, {}, `Last review: ${num(c.done)} chats read, ${num(c.drafted)} follow-ups drafted${c.failed ? `, ${num(c.failed)} failed (${c.error})` : ''}.`) : null,
            h('div.row.wrap', { style: 'align-items:flex-end' },
              h('div', { style: 'width:190px' }, field('Number', account)),
              h('div', { style: 'width:150px' }, field('Active in the last (days)', days)),
              h('div', { style: 'width:130px' }, field('Max chats', limit)),
              h('label.row', { style: 'height:36px;font-size:13px' }, again, 'Re-read chats already reviewed'),
              h('div.grow'), start))));
  }

  function drawList() {
    if (!st.rows.length) {
      return set(listBox, h('div.empty', {}, h('b', {}, { pending: 'Nothing waiting for you', approved: 'Queue is empty', sent: 'No follow-ups sent yet', skipped: 'Nothing skipped', failed: 'No failures' }[st.tab]),
        st.tab === 'pending' ? 'Drafts appear here when a lead goes quiet, or after you run a review above.' : ''));
    }
    const editable = st.tab === 'pending' || st.tab === 'approved';
    const bulk = st.tab === 'pending' && h('header', {}, h('span', {}, `${st.rows.length} drafts`),
      h('div.row', {}, h('button.btn.sm', { onclick: (e) => confirm(`Skip all ${st.rows.length} drafts?`) && act(e.target, () => POST('/api/followups/bulk', { action: 'skip', ids: st.rows.map((r) => r.id) })) }, 'Skip all'),
        h('button.btn.sm.primary', { onclick: (e) => confirm(`Approve all ${st.rows.length} follow-ups? They will be sent gradually.`) && act(e.target, () => POST('/api/followups/bulk', { action: 'approve', ids: st.rows.map((r) => r.id) }), 'Approved. Sending gradually.') }, 'Approve all')));
    set(listBox, bulk || '', ...st.rows.map((f) => {
      const text = h('textarea', { value: f.text, disabled: !editable, 'aria-label': `Follow-up for ${f.title}` });
      const save = (status, msg) => (e) => act(e.target, () => PATCH(`/api/followups/${f.id}`, { text: text.value, status }), msg);
      return h('div.fu', {},
        h('div', {}, h('a', { href: `#/inbox/${f.chat_id}`, style: 'text-decoration:none' }, h('b', {}, f.title)), h('div.row', { style: 'margin-top:6px' }, stagePill(f.stage)),
          h('div.why', {}, `${f.account_name} · last heard ${rel(f.last_in_at)}`)),
        h('div', {}, text, h('div.why', {}, f.error ? h('span', { style: 'color:var(--danger)' }, f.error) : f.reason || f.summary || '')),
        h('div.row', {}, editable ? [h('button.btn.sm', { onclick: save('skipped') }, 'Skip'), st.tab === 'pending' ? h('button.btn.sm.primary', { onclick: save('approved', 'Queued') }, 'Approve') : h('button.btn.sm', { onclick: save('pending') }, 'Hold')] : h('span.muted', {}, f.sent_at ? rel(f.sent_at) : '')));
    }));
  }
  const load = async () => { st.rows = await GET(`/api/followups?status=${st.tab}`); drawList(); };
  live.on('followups', () => load().catch(() => {}));
  live.on('campaign', (c) => { st.campaign = c; drawCampaign(); });
  drawTabs();
  GET('/api/campaign').then((c) => { st.campaign = c; drawCampaign(); });
  load().catch((e) => toast(e.message, true));
  return el;
}

// ============================== Numbers ==============================
const MODES = [['new_only', 'New leads only'], ['all', 'Everyone who messages'], ['manual', 'Only chats I switch on']];

export function numbers() {
  const box = h('div.card');
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Numbers'), h('p', {}, 'Link as many WhatsApp numbers as you need. Normal and Business app numbers link by QR; the official Business Cloud API connects with a token.')),
      h('button.btn.primary', { onclick: addNumber }, 'Link a number')),
    h('div.stack', {}, box,
      h('div.note.warn', {}, h('b', {}, 'About QR-linked numbers. '), 'Linking by QR uses WhatsApp Web, which WhatsApp does not officially allow for automation. Human-like pacing and reply caps lower the risk of a restriction but cannot remove it. Keep follow-ups relevant and low-volume, and use the Cloud API for numbers you cannot afford to lose.')));

  function draw() {
    const list = S.accounts;
    if (!list.length) return set(box, h('div.empty', {}, h('b', {}, 'No number linked yet'), 'Link your first number to start receiving chats here.', h('div', {}, h('button.btn.primary', { onclick: addNumber }, 'Link a number'))));
    set(box, ...list.map((a) => {
      const s = a.status;
      const call = (path, body, msg) => (e) => act(e.target, () => POST(`/api/accounts/${a.id}/${path}`, body), msg);
      const linking = s.state === 'qr' || s.state === 'pairing';
      const live = ['connected', 'connecting', 'qr', 'pairing'].includes(s.state);
      const actions = a.type === 'qr'
        ? [!live && h('button.btn.sm.primary', { onclick: call('connect') }, 'Show QR'),
          !live && h('button.btn.sm', { onclick: () => pairDialog(a) }, 'Use a code instead'),
          live && h('button.btn.sm', { onclick: call('disconnect', {}, 'Paused. The phone stays linked.') }, s.state === 'connected' ? 'Pause' : 'Cancel'),
          s.state === 'connected' && h('button.btn.sm', { onclick: (e) => confirm('Unlink this device from WhatsApp? You will need to scan again.') && call('disconnect', { logout: true }, 'Unlinked')(e) }, 'Unlink')]
        : [h('button.btn.sm', { onclick: () => cloudDialog(a) }, 'Edit connection'), s.state !== 'connected' && h('button.btn.sm.primary', { onclick: call('connect') }, 'Retry')];
      return h('div', { style: 'border-bottom:1px solid var(--line)' },
        h('div.acct', { style: 'border:0' },
          h('div', {}, h('div.row', {}, h('h3', {}, a.name), accountPill(a)),
            h('div.muted', {}, a.type === 'qr' ? 'WhatsApp app (QR link)' : 'Business Cloud API', s.me ? ` · +${s.me}` : '', ` · ${num(a.chats)} chats`),
            s.error ? h('div', { style: 'color:var(--danger);font-size:12.5px;margin-top:4px' }, s.error) : null),
          h('div.row.wrap', { style: 'justify-content:flex-end' },
            h('div', { style: 'width:200px' }, select(MODES, a.replyMode, (v) => act(null, () => PATCH(`/api/accounts/${a.id}`, { replyMode: v }), 'Saved'), { 'aria-label': 'Who the agent answers', title: 'Who the agent answers on this number' })),
            actions,
            h('button.btn.sm.ghost.danger', { onclick: (e) => confirm(`Remove ${a.name} and all its stored chats?`) && act(e.target, () => DEL(`/api/accounts/${a.id}`), 'Removed') }, 'Remove'))),
        linking ? h('div.pad', { style: 'border-top:1px solid var(--line)' }, h('div.qrbox', {},
          s.state === 'qr' ? h('img', { src: s.qr, alt: 'QR code to link WhatsApp', style: 'padding:0' }) : h('div.ph', {}, h('div', {}, h('div.code', {}, s.pairingCode), 'Pairing code')),
          h('div', {}, h('h2', {}, s.state === 'qr' ? 'Scan with the phone that has this number' : 'Enter this code on the phone'),
            h('ol', {}, h('li', {}, 'Open WhatsApp on the phone.'), h('li', {}, 'Settings, then Linked devices, then Link a device.'), h('li', {}, s.state === 'qr' ? 'Point the camera at this code. It refreshes by itself.' : 'Choose “Link with phone number instead” and type the code.')),
            h('p.muted', { style: 'margin-top:10px' }, 'After linking, existing chats sync in the background so the agent can read past conversations.')))) : null,
        a.type === 'cloud' ? h('div.pad', { style: 'border-top:1px solid var(--line);display:grid;gap:6px' },
          h('div.kv', {}, 'Webhook URL (paste into Meta)', h('b.mono', {}, `${location.origin}/webhook/cloud/${a.id}`)),
          h('div.kv', {}, 'Verify token', h('b.mono', {}, a.cloud.verifyToken)),
          h('div.kv', {}, 'Follow-up template (used after 24h)', h('b', {}, a.cloud.template || 'Not set')),
          !a.cloud.hasSecret ? h('div.note.warn', {}, 'No app secret saved, so incoming webhooks are not signature-checked. Add it under “Edit connection”.') : null) : null);
    }));
  }

  function addNumber() {
    const st = { type: 'qr' };
    const name = h('input', { type: 'text', placeholder: 'e.g. Sales line' });
    const mode = select(MODES, 'new_only', null);
    const cloud = cloudFields({});
    const typeBtns = h('div.presets');
    const cloudBox = h('div.stack.hide', {}, cloud.el);
    const drawType = () => {
      set(typeBtns, ...[['qr', 'WhatsApp app', 'Scan a QR · normal or Business app'], ['cloud', 'Business Cloud API', 'Official · token from Meta']].map(([id, t, d]) => h(`button${st.type === id ? '.on' : ''}`, { type: 'button', onclick: () => { st.type = id; drawType(); } }, t, h('small', {}, d))));
      cloudBox.classList.toggle('hide', st.type !== 'cloud');
    };
    drawType();
    modal('Link a number', [typeBtns, field('Name', name, 'Only you see this.'), field('Who should the agent answer?', mode, '“New leads only” leaves your existing contacts alone. Recommended for a personal number.'), cloudBox],
      (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => {
        const { id } = await POST('/api/accounts', { name: name.value, type: st.type, replyMode: mode.value, cloud: cloud.read() });
        if (st.type === 'qr') await POST(`/api/accounts/${id}/connect`);
        close();
      }) }, st.type === 'qr' ? 'Continue' : 'Connect')]);
  }
  function cloudFields(c) {
    const f = {
      phoneNumberId: h('input', { type: 'text', value: c.phoneNumberId || '' }), accessToken: h('input', { type: 'password', placeholder: c.hasToken ? 'Saved. Leave blank to keep.' : '' }),
      appSecret: h('input', { type: 'password', placeholder: c.hasSecret ? 'Saved. Leave blank to keep.' : '' }), template: h('input', { type: 'text', value: c.template || '' }), templateLang: h('input', { type: 'text', value: c.templateLang || 'en' }),
    };
    return {
      el: [h('div.grid2', {}, field('Phone number ID', f.phoneNumberId), field('Access token', f.accessToken, 'Permanent system-user token')),
        h('div.grid2', {}, field('App secret', f.appSecret, 'Verifies that webhooks really come from Meta'), h('div.grid2', {}, field('Follow-up template', f.template, 'Approved template name'), field('Language', f.templateLang)))],
      read: () => Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value.trim()]).filter(([k, v]) => v || k === 'template')),
    };
  }
  function cloudDialog(a) {
    const cloud = cloudFields(a.cloud);
    modal(`Edit ${a.name}`, cloud.el, (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => { await PATCH(`/api/accounts/${a.id}`, { cloud: cloud.read() }); close(); }, 'Saved') }, 'Save and reconnect')]);
  }
  function pairDialog(a) {
    const phone = h('input', { type: 'text', inputmode: 'numeric', placeholder: '923001234567' });
    modal('Link with a code', [field('Phone number of this WhatsApp account', phone, 'Country code first, digits only, no + or spaces.')],
      (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => { await POST(`/api/accounts/${a.id}/connect`, { pairPhone: phone.value }); close(); }) }, 'Get code')]);
  }

  live.on('accounts', draw);
  GET('/api/accounts').then((a) => { S.accounts = a; draw(); });
  return el;
}

// ============================== Models ==============================
export function models() {
  let presets = [];
  const box = h('div.card');
  const netBox = h('div');
  async function checkNetwork() {
    const rows = await POST('/api/providers/check');
    if (!rows.length) return set(netBox, h('div.note', {}, 'Turn on at least one model first.'));
    const bad = rows.filter((r) => !r.ok);
    set(netBox, h(`div.note${bad.length ? '.bad' : ''}`, {},
      h('b', {}, bad.length ? `This server cannot reach ${bad.length} of ${rows.length} providers. ` : 'This server can reach every provider. '),
      rows.map((r) => h('div', { style: 'margin-top:4px' }, `${r.name}: `, r.ok ? `reachable in ${(r.ms / 1000).toFixed(1)}s${r.keyOk ? ', key accepted' : [400, 401, 403].includes(r.status) ? ', but the API key was rejected' : ''}` : r.error)),
      bad.length ? h('div', { style: 'margin-top:6px' }, 'If every provider fails the same way, the problem is this computer\'s internet, firewall, VPN or antivirus, not the keys.') : null));
  }
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Models'), h('p', {}, 'The agent uses the first model that is ready. When one hits its rate limit, runs out of quota or goes down, the next one takes over within the same reply, and it comes back by itself when the limit resets.')),
      h('div.row', {}, h('button.btn', { onclick: (e) => act(e.target, checkNetwork) }, 'Check connection'), h('button.btn.primary', { onclick: () => edit(null) }, 'Add a model'))),
    h('div.stack', {}, netBox, box));

  const limitBar = (label, remaining, limit) => {
    if (remaining == null) return null;
    const pct = limit ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : null;
    return h('div', {}, h('div.kv', {}, label, h('b', {}, limit ? `${num(remaining)} / ${num(limit)}` : num(remaining))), pct != null ? h(`div.bar${pct < 15 ? '.low' : ''}`, {}, h('i', { style: `width:${pct}%` })) : null);
  };

  function draw() {
    const list = S.providers;
    if (!list.length) return set(box, h('div.empty', {}, h('b', {}, 'No model connected'), 'Add at least one. Groq is the fastest and has a free tier. Add a second from another provider and you get automatic failover.', h('div', {}, h('button.btn.primary', { onclick: () => edit(null) }, 'Add a model'))));
    const active = list.find((p) => p.status === 'ready');
    const move = (i, d) => (e) => { const ids = list.map((p) => p.id); [ids[i], ids[i + d]] = [ids[i + d], ids[i]]; act(e.target, () => POST('/api/providers/reorder', { ids })); };
    set(box, ...list.map((p, i) => {
      const [label, tone] = PROVIDER_STATUS[p.status] || [p.status, 'warn'];
      const u = p.usage;
      return h(`div.prov${p === active ? '.active' : ''}${p.enabled ? '' : '.off'}`, {},
        h('div.ord', {}, String(i + 1).padStart(2, '0')),
        h('div', {}, h('div.row.wrap', {}, h('h3', {}, p.name), h(`span.pill${tone ? `.${tone}` : ''}`, {}, p === active ? 'Serving now' : label), p.cooldownUntil ? h('span.muted', { style: 'font-size:12px' }, `back ${rel(p.cooldownUntil)}`) : null),
          h('div.mono.muted', { style: 'margin-top:4px;overflow-wrap:anywhere' }, p.model || 'no model chosen', p.keyHint ? ` · key ${p.keyHint}` : '')),
        h('div.meta', {},
          limitBar('Requests left', p.limits?.reqRemaining, p.limits?.reqLimit), limitBar('Tokens left', p.limits?.tokRemaining, p.limits?.tokLimit),
          p.dailyLimit ? limitBar('Your daily cap', Math.max(0, p.dailyLimit - u.requests), p.dailyLimit) : null,
          p.balance ? h('div.kv', {}, 'Balance', h('b', {}, p.balance.label)) : null,
          !p.limits && !p.balance && !p.dailyLimit ? h('span', {}, 'This provider does not report remaining quota. Limits are detected when they hit.') : null),
        h('div.meta', {}, h('div.kv', {}, 'Today', h('b', {}, `${num(u.requests)} calls`)), h('div.kv', {}, 'Tokens', h('b', {}, `${num(u.tokens_in + u.tokens_out)}`)), h('div.kv', {}, 'Speed', h('b', {}, p.lastLatencyMs ? `${(p.lastLatencyMs / 1000).toFixed(1)}s` : '—'))),
        h('div.row', {},
          h('button.btn.sm.ghost', { disabled: i === 0, onclick: move(i, -1), 'aria-label': `Move ${p.name} up` }, 'Up'),
          h('button.btn.sm.ghost', { disabled: i === list.length - 1, onclick: move(i, 1), 'aria-label': `Move ${p.name} down` }, 'Down'),
          h('button.btn.sm', { onclick: (e) => act(e.target, async () => { const r = await POST(`/api/providers/${p.id}/test`); toast(`${p.name} answered in ${(r.latencyMs / 1000).toFixed(1)}s`); }) }, 'Test'),
          h('button.btn.sm', { onclick: () => edit(p) }, 'Edit'),
          toggle(p.enabled, (on) => act(null, () => PATCH(`/api/providers/${p.id}`, { enabled: on })), `Use ${p.name}`)),
        p.lastError && p.status !== 'ready' ? h('div.err', {}, p.lastError.message, ' ', h('button.linkbtn', { style: 'color:var(--orange-text);text-decoration:underline', onclick: () => act(null, () => PATCH(`/api/providers/${p.id}`, { reset: true }), 'Back in the chain') }, 'Try again now')) : null);
    }));
  }

  function edit(p) {
    const st = { preset: p?.preset || 'groq' };
    const cur = () => presets.find((x) => x.id === st.preset) || {};
    const name = h('input', { type: 'text' }), key = h('input', { type: 'password', autocomplete: 'off' }), url = h('input', { type: 'text' });
    const model = h('input', { type: 'text', list: 'model-list', autocomplete: 'off' });
    const datalist = h('datalist', { id: 'model-list' });
    const cap = h('input', { type: 'number', min: 0, placeholder: 'No cap', value: p?.dailyLimit || '' });
    const keyHint = h('small');
    const grid = h('div.presets');
    const urlField = field('Base URL', url, 'OpenAI-compatible endpoint. Change it only if your provider says so.');
    const fill = (fresh) => {
      const c = cur();
      set(grid, ...presets.map((x) => h(`button${x.id === st.preset ? '.on' : ''}`, { type: 'button', onclick: () => { st.preset = x.id; fill(true); } }, x.name, h('small', {}, x.note || (x.free ? 'Free tier available' : x.id === 'custom' ? 'Any compatible API' : 'Paid')))));
      if (fresh) { name.value = c.name || ''; url.value = c.baseUrl || ''; model.value = c.model || ''; set(datalist, ...(c.models || []).map((m) => h('option', { value: m }))); }
      urlField.classList.toggle('hide', c.kind === 'anthropic');
      set(keyHint, p ? `Saved key ${p.keyHint || '(none)'}. Leave blank to keep it. ` : '', c.keyUrl ? h('a', { href: c.keyUrl, target: '_blank', rel: 'noopener' }, 'Get a key') : '', c.noKey ? 'No key needed for a local server.' : '');
    };
    const body = () => ({ preset: st.preset, name: name.value, apiKey: key.value, baseUrl: url.value, model: model.value, dailyLimit: Number(cap.value) || 0 });
    const loadBtn = h('button.btn', { type: 'button', onclick: () => act(loadBtn, async () => {
      const { models: list } = p && !key.value ? await GET(`/api/providers/${p.id}/models`) : await POST('/api/providers/models', body());
      set(datalist, ...list.map((m) => h('option', { value: m })));
      toast(`${list.length} models found. Start typing in the model box to pick one.`);
      model.focus();
    }) }, 'Load models');
    if (p) { name.value = p.name; url.value = p.baseUrl || ''; model.value = p.model; }
    fill(!p);
    modal(p ? `Edit ${p.name}` : 'Add a model', [
      !p && h('div', {}, h('label.f', {}, 'Provider'), grid),
      h('div.grid2', {}, field('Name', name), h('label.f', {}, 'API key', key, keyHint)),
      urlField,
      h('div.row', { style: 'align-items:flex-end' }, h('div.grow', {}, field('Model', model, 'Suggested IDs can go out of date. “Load models” asks the provider for the current list.')), h('div', { style: 'padding-bottom:22px' }, loadBtn)),
      field('Your own daily cap (requests)', cap, 'Optional. Handy for free tiers with a known daily allowance: the agent moves on before the provider cuts you off.'),
      h('p.muted', { style: 'font-size:12.5px' }, 'Keys are encrypted on this server and never shown again.'),
    ], (close) => [
      p && h('button.btn.ghost.danger', { style: 'margin-right:auto', onclick: (e) => confirm(`Remove ${p.name}?`) && act(e.target, async () => { await DEL(`/api/providers/${p.id}`); close(); }) }, 'Remove'),
      h('button.btn', { onclick: close }, 'Cancel'),
      h('button.btn.primary', { onclick: (e) => act(e.target, async () => {
        const id = p ? (await PATCH(`/api/providers/${p.id}`, body()), p.id) : (await POST('/api/providers', body())).id;
        close();
        try { const r = await POST(`/api/providers/${id}/test`); toast(`Connected. ${r.model} answered in ${(r.latencyMs / 1000).toFixed(1)}s.`); } catch (err) { toast(`Saved, but the test call failed: ${err.message}`, true); }
      }) }, p ? 'Save and test' : 'Add and test'),
    ]);
  }

  live.on('providers', draw);
  Promise.all([GET('/api/presets'), GET('/api/providers')]).then(([pr, list]) => { presets = pr; S.providers = list; draw(); });
  const tick = setInterval(() => (el.isConnected ? draw() : clearInterval(tick)), 15000); // keep "back in 2m" fresh
  return el;
}
