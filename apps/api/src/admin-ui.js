/**
 * Server-rendered admin console. No build step, no framework, no bundle — it is
 * an internal tool used by one or two people and it should stay that way.
 */

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const rupees = (paise) =>
  paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN')}`;

const STYLE = `
  :root {
    --ground:#F6F8F4; --surface:#fff; --ink:#1B211D; --muted:#6E7A72;
    --rule:#D3DBD2; --accent:#2C5F53; --warn:#8A6510; --warn-bg:#F5EBD3;
    --crit:#8C332B; --crit-bg:#F5DFDC; --ok-bg:#DCE9E3;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme=light]) {
      --ground:#121614; --surface:#1A201D; --ink:#E7EDE8; --muted:#8E9A92;
      --rule:#2C3531; --accent:#74B7A3; --warn:#D6AC55; --warn-bg:#33290F;
      --crit:#E08A7F; --crit-bg:#341C19; --ok-bg:#1E332D;
    }
  }
  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);margin:0;padding:0 20px 60px;
    font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;
    padding:24px 0 14px;border-bottom:2px solid var(--ink);margin-bottom:24px;flex-wrap:wrap}
  h1{font:400 24px/1.2 Georgia,serif;margin:0;letter-spacing:-.01em}
  h2{font:400 19px/1.2 Georgia,serif;margin:28px 0 10px}
  a{color:var(--accent);text-underline-offset:3px}
  .muted{color:var(--muted);font-size:14px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:0 0 22px}
  .card{background:var(--surface);border:1px solid var(--rule);padding:14px 16px}
  .card .n{font:400 30px/1 Georgia,serif;font-variant-numeric:tabular-nums}
  .card .k{font:11px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;
    color:var(--muted);margin-top:7px}
  .tw{overflow-x:auto;background:var(--surface);border:1px solid var(--rule)}
  table{border-collapse:collapse;width:100%;min-width:760px;font-size:14.5px}
  th{text-align:left;font:11px/1 ui-monospace,monospace;letter-spacing:.1em;
    text-transform:uppercase;color:var(--muted);font-weight:400;
    padding:12px 14px;border-bottom:1px solid var(--rule);white-space:nowrap}
  td{padding:11px 14px;border-bottom:1px solid var(--rule);vertical-align:top}
  tr:last-child td{border-bottom:0}
  .num{font-variant-numeric:tabular-nums;white-space:nowrap}
  .pill{display:inline-block;font:11px/1.6 ui-monospace,monospace;padding:2px 8px;border-radius:2px}
  .pill.ok{background:var(--ok-bg);color:var(--accent)}
  .pill.warn{background:var(--warn-bg);color:var(--warn)}
  .pill.crit{background:var(--crit-bg);color:var(--crit)}
  form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
  input,select,textarea{font:inherit;padding:8px 10px;border:1px solid var(--rule);
    background:var(--surface);color:var(--ink);border-radius:2px}
  input:focus-visible,select:focus-visible,button:focus-visible,textarea:focus-visible{
    outline:2px solid var(--accent);outline-offset:2px}
  button{font:inherit;padding:8px 14px;border:1px solid var(--accent);background:var(--accent);
    color:var(--ground);border-radius:2px;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent)}
  .actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
  .action{background:var(--surface);border:1px solid var(--rule);padding:14px}
  .action h3{margin:0 0 4px;font:600 14px/1.3 system-ui}
  .action p{margin:0 0 10px;font-size:13.5px;color:var(--muted)}
  .action form{display:flex;flex-direction:column;gap:8px}
  .login{max-width:340px;margin:14vh auto;background:var(--surface);
    border:1px solid var(--rule);padding:28px}
  .login form{display:flex;flex-direction:column;gap:12px}
  .err{background:var(--crit-bg);color:var(--crit);padding:10px 12px;font-size:14px;margin-bottom:14px}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

export function renderLogin(error) {
  return page('Admin sign in', `
    <div class="login">
      <h1>Rabbitry admin</h1>
      <p class="muted" style="margin:6px 0 18px">Every action here is logged.</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <form method="post" action="/admin/login">
        <input name="email" type="email" placeholder="Email" required autocomplete="username">
        <input name="password" type="password" placeholder="Password" required
               autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>
    </div>`);
}

const statusPill = (status) => {
  const cls = { active: 'ok', trialing: 'ok', past_due: 'warn', grace: 'warn',
    suspended: 'crit', cancelled: 'crit' }[status] ?? 'warn';
  return `<span class="pill ${cls}">${esc(status ?? 'none')}</span>`;
};

const seen = (days) => {
  if (days == null) return '<span class="pill crit">never</span>';
  if (days === 0) return 'today';
  if (days >= 14) return `<span class="pill crit">${days}d</span>`;
  if (days >= 7) return `<span class="pill warn">${days}d</span>`;
  return `${days}d`;
};

export function renderFarms({ farms, summary, q, status, admin }) {
  const s = summary ?? {};
  const rows = farms.map((f) => `
    <tr>
      <td><a href="/admin/farms/${esc(f.farm_id)}">${esc(f.farm_name)}</a>
          <div class="muted">${esc(f.city ?? '')}${f.state ? ', ' + esc(f.state) : ''}</div></td>
      <td>${esc(f.owner_email ?? '—')}<div class="muted">${esc(f.owner_phone ?? '')}</div></td>
      <td>${statusPill(f.status)}${f.is_grandfathered ? ' <span class="pill ok">intro price</span>' : ''}</td>
      <td class="num">${rupees(f.effective_price_paise)}${f.billing_period ? `<div class="muted">${esc(f.billing_period)}</div>` : ''}</td>
      <td class="num">${f.breeding_does ?? 0}</td>
      <td class="num">${f.staff_count ?? 0}</td>
      <td class="num">${seen(f.days_since_activity)}</td>
    </tr>`).join('');

  return page('Farms — Rabbitry admin', `
    <header>
      <h1>Farms</h1>
      <div class="muted">${esc(admin?.full_name ?? '')} · ${esc(admin?.role ?? '')}
        · <form method="post" action="/admin/logout" style="display:inline">
            <button class="ghost" type="submit" style="padding:2px 8px">Sign out</button>
          </form></div>
    </header>

    <div class="cards">
      <div class="card"><div class="n">${s.active ?? 0}</div><div class="k">Active</div></div>
      <div class="card"><div class="n">${s.trialing ?? 0}</div><div class="k">On trial</div></div>
      <div class="card"><div class="n">${s.at_risk ?? 0}</div><div class="k">At risk</div></div>
      <div class="card"><div class="n">${rupees(s.mrr_paise)}</div><div class="k">MRR</div></div>
      <div class="card"><div class="n">${s.silent_churn_risk ?? 0}</div><div class="k">Quiet 14d+</div></div>
    </div>

    <form class="inline" method="get" action="/admin/farms">
      <input name="q" value="${esc(q ?? '')}" placeholder="Farm, email, phone or city">
      <select name="status">
        <option value="">Any status</option>
        ${['trialing', 'active', 'past_due', 'grace', 'suspended', 'cancelled']
          .map((v) => `<option value="${v}"${status === v ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      <button type="submit">Search</button>
    </form>

    <div class="tw"><table>
      <thead><tr><th>Farm</th><th>Owner</th><th>Status</th><th>Pays</th>
        <th class="num">Does</th><th class="num">Staff</th><th class="num">Last seen</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">No farms match.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:14px">
      “Last seen” is the column that matters most — a farm that has written nothing
      in two weeks is churning whether or not it is still paying.</p>`);
}

/**
 * Handing a support session over to the app.
 *
 * The token goes in the URL *fragment*, not the query string. A fragment is
 * never sent to a server, so it stays out of access logs, out of the Referer
 * header and out of Netlify's edge — which matters more than usual here,
 * because this particular token opens a paying customer's farm.
 */
export function renderImpersonation({ impersonation, token, farm_name, admin }) {
  const ends = new Date(impersonation.expires_at);
  const mins = Math.max(0, Math.round((ends - Date.now()) / 60000));

  return page(`Viewing ${farm_name}`, `
    <header>
      <h1>Viewing ${esc(farm_name)}</h1>
      <div class="muted"><a href="/admin/farms">← All farms</a></div>
    </header>

    <div class="action" style="max-width:620px">
      <h3>Open the farm</h3>
      <p>Their screens, exactly as they see them. Read-only — every button that
         writes will be refused, including changing their password.</p>
      <p><a href="/#support=${esc(token)}" target="_blank" rel="noopener"
            style="font-size:18px">Open ${esc(farm_name)} in the app →</a></p>
    </div>

    <h2>What ${esc(admin.full_name)} can and cannot do</h2>
    <div class="tw"><table style="min-width:0">
      <tbody>
        <tr><td>Ends</td><td>${esc(ends.toISOString().slice(0, 16).replace('T', ' '))} UTC
            — in about ${mins} minutes</td></tr>
        <tr><td>Writes</td><td>Refused. Not a hidden button: the server says no.</td></tr>
        <tr><td>The farmer</td><td>Has been sent a notification naming you and the
            reason, and sees this session in their signed-in devices list.</td></tr>
        <tr><td>Ending early</td><td>Sign out inside the app, or the button below.</td></tr>
      </tbody>
    </table></div>

    <form method="post" action="/admin/api/impersonate/${esc(impersonation.id)}/end"
          style="margin-top:18px">
      <button type="submit">End this session now</button>
    </form>

    <p class="muted" style="margin-top:18px;max-width:620px">
      Closing the tab does not end it — the session stays live until the hour is
      up. End it when you are done; the customer can see that you did.</p>`);
}

export function renderFarm({ farm, audit, subscription, admin }) {
  const canBill = ['superadmin', 'billing'].includes(admin.role);
  const canComp = admin.role === 'superadmin';

  const action = (name, title, blurb, extra = '', enabled = true) => `
    <div class="action">
      <h3>${esc(title)}</h3><p>${esc(blurb)}</p>
      ${enabled ? `<form method="post" action="/admin/farms/${esc(farm.farm_id)}/${name}">
        ${extra}
        <input name="reason" placeholder="Reason (required)" required>
        <button type="submit">${esc(title)}</button>
      </form>` : `<p class="muted"><em>Needs a different role.</em></p>`}
    </div>`;

  const auditRows = audit.map((a) => `
    <tr>
      <td class="num">${new Date(a.at).toISOString().slice(0, 16).replace('T', ' ')}</td>
      <td>${esc(a.admin_name)}</td>
      <td><code>${esc(a.action)}</code></td>
      <td>${esc(a.reason ?? '')}</td>
    </tr>`).join('');

  return page(`${farm.farm_name} — Rabbitry admin`, `
    <header>
      <h1>${esc(farm.farm_name)}</h1>
      <div class="muted"><a href="/admin/farms">← All farms</a></div>
    </header>

    <div class="cards">
      <div class="card"><div class="n">${statusPill(farm.status)}</div><div class="k">Status</div></div>
      <div class="card"><div class="n">${rupees(farm.effective_price_paise)}</div>
        <div class="k">${esc(farm.billing_period ?? '')}</div></div>
      <div class="card"><div class="n">${farm.breeding_does ?? 0}</div><div class="k">Breeding does</div></div>
      <div class="card"><div class="n">${farm.animals ?? 0}</div><div class="k">Animals</div></div>
      <div class="card"><div class="n">${seen(farm.days_since_activity)}</div><div class="k">Last write</div></div>
    </div>

    <p class="muted">
      ${esc(farm.owner_name ?? '')} · ${esc(farm.owner_email ?? '')} · ${esc(farm.owner_phone ?? '')}<br>
      ${esc(farm.city ?? '')}${farm.state ? ', ' + esc(farm.state) : ''} ·
      joined ${new Date(farm.signed_up_at).toISOString().slice(0, 10)} ·
      email ${farm.email_verified ? 'verified' : 'unverified (by design)'}
      ${farm.trial_ends_on ? ` · trial ends ${farm.trial_ends_on}` : ''}
      ${farm.is_grandfathered ? ' · <strong>on introductory pricing</strong>' : ''}
    </p>

    <h2>Actions</h2>
    <div class="actions">
      ${action('extend_trial', 'Extend trial', 'The most common support request.',
        '<input name="days" type="number" value="15" min="1" max="90">')}
      ${action('activate', 'Activate', 'Mark paid and start a billing period.', '', canBill)}
      ${action('suspend', 'Suspend', 'Read-only. Reminders keep firing.', '', canBill)}
      ${action('cancel', 'Cancel', 'Read-only. Data kept 12 months.', '', canBill)}
      ${action('comp', 'Comp free', 'Case study, beta tester, friend.', '', canComp)}
      ${/*
        There is no email verification, so there is no reset link to send. This
        is the only way back in for someone locked out of their own farm, which
        is why it is here rather than left to a database prompt.
      */ ''}
      ${/*
        Read-only, one hour, and the farmer is told. The reason box is not a
        formality: it is the only thing that makes the audit line readable to
        the customer a year later when they ask who opened their farm.
      */ ''}
      ${action('impersonate', 'View this farm',
        'Their screens, read-only, for one hour. They are told it happened.',
        '', admin.role === 'superadmin' || admin.role === 'support')}
      ${action('reset_password', 'Reset password',
        'They are locked out. Sets a temporary one and signs every device out.',
        '', admin.role === 'superadmin' || admin.role === 'support')}
      ${/*
        The only irreversible action on this page, so it asks for the farm's
        name as well as a reason. `pattern` makes the browser refuse the wrong
        name before anything is sent, and the server checks it again — a typo
        on a tired evening should not cost a farmer their records.
      */ ''}
      ${action('delete', 'Delete farm', 'Erasure request, or created in error. Cannot be undone.',
        `<input name="confirm_name" placeholder="Type &quot;${esc(farm.farm_name)}&quot;"
                pattern="${esc(farm.farm_name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"
                title="Type the farm's name exactly" required>`, canComp)}
    </div>

    <h2>Audit trail</h2>
    <div class="tw"><table style="min-width:620px">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Reason</th></tr></thead>
      <tbody>${auditRows || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}</tbody>
    </table></div>
    ${subscription?.gateway_subscription_id
      ? `<p class="muted">Razorpay: <code>${esc(subscription.gateway_subscription_id)}</code></p>` : ''}`);
}
