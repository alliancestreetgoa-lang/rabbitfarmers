/**
 * Server-rendered admin console. No build step, no framework, no bundle — it is
 * an internal tool used by one or two people and it should stay that way.
 */

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const rupees = (paise) =>
  paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN')}`;

/** Timestamps as 'YYYY-MM-DD HH:MM'. UTC, and labelled as such where it shows. */
const when = (ts) =>
  ts == null ? '—' : new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

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
  nav a{margin-right:16px;font:13px/1 ui-monospace,monospace;letter-spacing:.06em;
    text-transform:uppercase}
  nav a[aria-current]{color:var(--ink);text-decoration:none;border-bottom:2px solid var(--ink);
    padding-bottom:3px}
  .bar{background:var(--rule);height:9px;min-width:1px}
  .quiet{background:var(--surface);border:1px solid var(--rule);padding:14px 16px;
    color:var(--muted);font-size:14.5px}
  form.rowform{display:flex;gap:6px;align-items:center;margin:0}
  form.rowform input{padding:5px 8px;font-size:13px;max-width:170px}
  form.rowform button{padding:5px 10px;font-size:13px}
  pre{background:var(--surface);border:1px solid var(--rule);padding:14px;overflow-x:auto;
    font:12.5px/1.5 ui-monospace,monospace}
  details summary{cursor:pointer;color:var(--accent);font-size:13.5px}
  details form{display:flex;flex-direction:column;gap:6px;margin-top:8px;min-width:230px}
  details form input,details form select{font-size:13px;padding:6px 8px}
  details form button{font-size:13px;padding:6px 10px}
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

/**
 * The two screens, and only the ones this admin can open.
 *
 * A link to a page that answers 403 is worse than no link: it teaches whoever
 * is on the support rota that the console is broken, and they stop trusting the
 * next thing it tells them.
 */
function nav(here, admin) {
  const links = [['/admin/farms', 'Farms', 'farms', true]];
  if (['superadmin', 'billing'].includes(admin?.role)) {
    links.push(['/admin/billing', 'Billing', 'billing', true]);
  }
  return `<nav style="display:inline">${links
    .map(([href, label, key]) =>
      `<a href="${href}"${here === key ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('')}</nav>`;
}

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
      <div class="muted">${nav('farms', admin)}${esc(admin?.full_name ?? '')} · ${esc(admin?.role ?? '')}
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

/* ---------------------------------------------------------------- billing -- */

const payPill = (status) => {
  const cls = { paid: 'ok', created: 'warn', failed: 'crit',
    cancelled: 'crit', refunded: 'warn' }[status] ?? 'warn';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
};

const EXCEPTION_LABEL = {
  paid_but_locked_out: 'Paid, still locked out',
  paid_no_invoice: 'No invoice',
  webhook_failed: 'Webhook failed',
  unattributed_payment: 'Unattributed payment',
  amount_mismatch: 'Wrong amount',
  refund_failed: 'Refund failed',
  refund_stuck: 'Refund not settled',
  abandoned_link: 'Link never paid',
};

const refundPill = (status) => {
  const cls = { processed: 'ok', created: 'warn', failed: 'crit', cancelled: 'crit' }[status] ?? '';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
};

/**
 * The refund form, on the payment it reverses.
 *
 * Folded away behind a disclosure rather than laid out in the row: it is four
 * fields, it is rarely the reason somebody opened this page, and an always-open
 * refund form next to every payment is an invitation to a mis-click that costs
 * a farmer their subscription.
 *
 * The kind is the first field and it is spelled out in words, because it is the
 * decision — money back because they are leaving takes the days with it, money
 * back as an apology does not, and the difference is invisible in the number.
 */
function refundForm(p) {
  const left = p.refundable_paise ?? 0;
  return `
    <details>
      <summary>Refund${left < p.amount_paise ? ` (${rupees(left)} left)` : ''}</summary>
      <form method="post" action="/admin/billing/payments/${esc(p.id)}/refund">
        <select name="kind">
          <option value="cancellation">They are leaving — take the days back</option>
          <option value="goodwill">Goodwill — they keep their subscription</option>
        </select>
        <input name="amount_paise" type="number" min="1" max="${left}"
               placeholder="Paise (blank = all ${rupees(left)})">
        ${p.gateway !== 'razorpay'
          ? '<input name="reference" placeholder="UTR of the money you sent back">' : ''}
        <input name="reason" placeholder="Reason (required)" required>
        <button type="submit">Refund ${rupees(left)}</button>
      </form>
    </details>`;
}

/**
 * The money screen.
 *
 * Ordered by what somebody has to do rather than by what is pleasant to look
 * at: the things that have gone wrong first, then the farms to talk to this
 * week, then the ledger, then the totals. Revenue is the last thing on the page
 * because it is the one number that never needs anybody to act.
 */
const mailPill = (status) => {
  const cls = { sent: 'ok', queued: 'warn', failed: 'crit',
    suppressed: 'crit', expired: 'crit' }[status] ?? '';
  return `<span class="pill ${cls}">${esc(status)}</span>`;
};

export function renderBilling({ summary, revenue, exceptions, renewals, payments,
                                fy, months, refunds = [], emailHealth, emails = [],
                                filters, admin }) {
  const s = summary ?? {};
  const r = revenue ?? {};
  const f = filters ?? {};

  /* Everything that has gone wrong with money, worst first. */
  const exceptionRows = exceptions.map((x) => `
    <tr>
      <td><span class="pill ${x.severity === 1 ? 'crit' : x.severity === 2 ? 'warn' : ''}">
            ${esc(EXCEPTION_LABEL[x.kind] ?? x.kind)}</span></td>
      <td>${x.farm_id
            ? `<a href="/admin/farms/${esc(x.farm_id)}">${esc(x.farm_name)}</a>`
            : '<span class="muted">no farm</span>'}</td>
      <td>${esc(x.detail)}</td>
      <td class="num">${when(x.at)}</td>
      <td>${['webhook_failed', 'unattributed_payment'].includes(x.kind) ? `
        <form class="rowform" method="post" action="/admin/billing/webhooks/${esc(x.ref)}/replay">
          <input name="reason" placeholder="Reason" required>
          <button type="submit">Replay</button>
        </form>
        <div class="muted" style="margin-top:4px">
          <a href="/admin/billing/webhooks/${esc(x.ref)}">payload</a></div>` : ''}</td>
    </tr>`).join('');

  /* Who to ring this week. */
  const STAGE = {
    trial_ending: 'trial ends', trial_over: 'trial over',
    ending_soon: 'renews', in_grace: 'in grace', lapsed: 'lapsed',
  };
  const renewalRows = renewals.map((x) => `
    <tr>
      <td><a href="/admin/farms/${esc(x.farm_id)}">${esc(x.farm_name)}</a>
          <div class="muted">${esc(x.owner_name ?? '')} · ${esc(x.owner_phone ?? '')}</div></td>
      <td><span class="pill ${
        x.stage === 'lapsed' || x.stage === 'trial_over' ? 'crit'
          : x.stage === 'in_grace' ? 'warn' : 'ok'}">
            ${esc(STAGE[x.stage] ?? x.kind)}</span></td>
      ${/*
        Two dates, because they are up to a month apart and mean different
        things: the money was due on one, and the farm stops being able to
        record on the other. Phoning about the first is the job.
      */ ''}
      <td class="num">${esc(x.due_on)}
          <div class="muted">${x.days_left < 0 ? `${-x.days_left}d overdue` : `in ${x.days_left}d`}</div>
          ${x.covered_days_left != null && x.days_left < 0
            ? `<div class="muted">${x.covered_days_left >= 0
                ? `works for ${x.covered_days_left} more days`
                : `read-only since ${esc(x.covered_until)}`}</div>` : ''}</td>
      <td class="num">${rupees(x.renewal_paise)}
          <div class="muted">${esc(x.billing_period ?? '')}</div></td>
      <td>${statusPill(x.status)}${x.access === 'read_only'
            ? ' <span class="pill crit">locked out</span>' : ''}</td>
      <td>${x.has_open_link ? '<span class="pill warn">link open</span>' : ''}
          <div class="muted">${seen(x.days_since_activity)}</div></td>
    </tr>`).join('');

  const refundRows = refunds.map((r) => `
    <tr>
      <td class="num">${when(r.created_at)}
          ${r.processed_at ? `<div class="muted">back ${when(r.processed_at)}</div>` : ''}</td>
      <td><a href="/admin/farms/${esc(r.farm_id)}">${esc(r.farm_name)}</a>
          <div class="muted">${esc(r.requested_by_name ?? '')}</div></td>
      <td class="num">${rupees(r.amount_paise)}
          <div class="muted">of ${rupees(r.payment_paise)}</div></td>
      <td><span class="pill ${r.kind === 'goodwill' ? 'ok' : 'warn'}">${esc(r.kind)}</span>
          <div class="muted">${r.days_removed == null ? ''
            : r.days_removed ? `${r.days_removed} days back` : 'kept their days'}</div></td>
      <td>${refundPill(r.status)}
          ${r.failed_reason ? `<div class="muted">${esc(r.failed_reason)}</div>` : ''}</td>
      <td>${r.credit_note_number ? `<code>${esc(r.credit_note_number)}</code>` : '—'}
          <div class="muted">${esc(r.reason)}</div></td>
      <td>${r.status === 'created' ? `
        <form class="rowform" method="post" action="/admin/billing/refunds/${esc(r.id)}/settle">
          <input name="reason" placeholder="Reason" required>
          <button type="submit">Settled</button>
        </form>` : ''}</td>
    </tr>`).join('');

  const paymentRows = payments.map((p) => `
    <tr>
      <td class="num">${when(p.created_at)}
          ${p.paid_at ? `<div class="muted">paid ${when(p.paid_at)}</div>` : ''}</td>
      <td><a href="/admin/farms/${esc(p.farm_id)}">${esc(p.farm_name)}</a>
          ${p.gateway !== 'razorpay' ? `<div class="muted">${esc(p.gateway)}</div>` : ''}</td>
      <td class="num">${rupees(p.amount_paise)}
          <div class="muted">${esc(p.billing_period)} · ${p.covers_days}d</div>
          ${p.refunded_paise ? `<div class="muted">−${rupees(p.refunded_paise)} refunded</div>` : ''}</td>
      <td>${payPill(p.status)}
          ${p.failed_reason ? `<div class="muted">${esc(p.failed_reason)}</div>` : ''}</td>
      <td>${p.invoice_number
            ? `<code>${esc(p.invoice_number)}</code>
               <div class="muted">${rupees(p.subtotal_paise)} + ${rupees(p.tax_paise)} GST</div>`
            : (p.status === 'paid'
                ? '<span class="pill crit">missing</span>' : '<span class="muted">—</span>')}</td>
      <td class="muted">${esc(p.gateway_payment_id ?? p.gateway_link_id ?? '')}</td>
    </tr>`).join('');

  /*
   * Twelve months, drawn. The number is in the row already; the bar is there so
   * that a month where collections halved is visible without reading any of
   * them.
   */
  const peak = Math.max(1, ...months.map((m) => Number(m.total_paise)));
  const monthRows = months.map((m) => `
    <tr>
      <td class="num">${esc(String(m.month).slice(0, 7))}</td>
      <td style="width:55%"><div class="bar" style="width:${
        Math.round((Math.max(0, Number(m.total_paise)) / peak) * 100)}%;
        background:${m.total_paise ? 'var(--accent)' : 'var(--rule)'}"></div></td>
      <td class="num">${rupees(m.total_paise)}</td>
      <td class="num muted">${m.refunded_paise ? `−${rupees(m.refunded_paise)}` : ''}</td>
      <td class="num muted">${m.invoices}</td>
    </tr>`).join('');

  const fyRows = fy.map((y) => `
    <tr>
      <td class="num">${esc(y.financial_year)}</td>
      <td class="num">${y.invoices}
          ${y.credit_notes ? `<div class="muted">${y.credit_notes} credit notes</div>` : ''}</td>
      <td class="num">${rupees(y.taxable_paise)}
          ${y.credit_notes ? `<div class="muted">−${rupees(y.credited_taxable_paise)}</div>` : ''}</td>
      <td class="num">${rupees(y.tax_paise)}
          ${y.credit_notes ? `<div class="muted">−${rupees(y.credited_tax_paise)}</div>` : ''}</td>
      <td class="num">${rupees(y.net_total_paise)}
          ${y.credit_notes ? `<div class="muted">${rupees(y.total_paise)} billed</div>` : ''}</td>
      <td class="muted"><code>${esc(y.first_number)}</code> → <code>${esc(y.last_number)}</code>
          ${y.credit_notes
            ? `<div><code>${esc(y.first_credit_note)}</code> → <code>${esc(y.last_credit_note)}</code></div>`
            : ''}</td>
    </tr>`).join('');

  return page('Billing — Rabbitry admin', `
    <header>
      <h1>Billing</h1>
      <div class="muted">${nav('billing', admin)}${esc(admin?.full_name ?? '')} · ${esc(admin?.role ?? '')}
        · <form method="post" action="/admin/logout" style="display:inline">
            <button class="ghost" type="submit" style="padding:2px 8px">Sign out</button>
          </form></div>
    </header>

    <div class="cards">
      <div class="card"><div class="n">${rupees(s.collected_month_paise)}</div>
        <div class="k">Collected this month</div></div>
      <div class="card"><div class="n">${rupees(s.collected_fy_paise)}</div>
        <div class="k">This financial year</div></div>
      <div class="card"><div class="n">${rupees(r.mrr_paise)}</div><div class="k">MRR</div></div>
      <div class="card"><div class="n">${rupees(s.tax_fy_paise)}</div>
        <div class="k">GST collected, FY</div></div>
      <div class="card"><div class="n">${s.due_14d ?? 0}</div><div class="k">Due in 14 days</div></div>
      <div class="card"><div class="n">${rupees(s.refunded_fy_paise)}</div>
        <div class="k">Refunded, FY${s.refunds_in_flight
          ? ` · ${s.refunds_in_flight} pending` : ''}</div></div>
      <div class="card"><div class="n">${s.locked_out ?? 0}</div><div class="k">Locked out</div></div>
    </div>

    <h2>Needs attention</h2>
    ${exceptions.length ? `<div class="tw"><table>
      <thead><tr><th>What</th><th>Farm</th><th>Detail</th><th>When</th><th></th></tr></thead>
      <tbody>${exceptionRows}</tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">
      A replay runs the stored delivery through the same code the live webhook
      does. It is safe to press twice — a payment that has already been applied
      is not applied again.</p>`
    : `<div class="quiet">Nothing. Every payment taken has an invoice and a farm
        that can use it, and no delivery is stuck.</div>`}

    <h2>Renewals and trials, next fortnight</h2>
    ${renewals.length ? `<div class="tw"><table>
      <thead><tr><th>Farm</th><th></th><th>Due</th><th>Renewal</th><th>Status</th><th></th></tr></thead>
      <tbody>${renewalRows}</tbody>
    </table></div>` : '<div class="quiet">Nothing due in the next fortnight.</div>'}

    <h2>Payments</h2>
    <form class="inline" method="get" action="/admin/billing">
      <input name="q" value="${esc(f.q ?? '')}" placeholder="Farm, invoice or gateway id">
      <select name="status">
        <option value="">Any status</option>
        ${['created', 'paid', 'failed', 'cancelled', 'refunded']
          .map((v) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${v}</option>`)
          .join('')}
      </select>
      <input name="from" type="date" value="${esc(f.from ?? '')}">
      <input name="to" type="date" value="${esc(f.to ?? '')}">
      <button type="submit">Filter</button>
    </form>
    <div class="tw"><table>
      <thead><tr><th>Made</th><th>Farm</th><th>Amount</th><th>Status</th>
        <th>Invoice</th><th>Gateway ref</th></tr></thead>
      <tbody>${paymentRows || '<tr><td colspan="6" class="muted">No payments match.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">Most recent hundred. Times are UTC.</p>

    <h2>Refunds</h2>
    ${refunds.length ? `<div class="tw"><table>
      <thead><tr><th>Asked</th><th>Farm</th><th>Amount</th><th>Kind</th><th>Status</th>
        <th>Credit note and reason</th><th></th></tr></thead>
      <tbody>${refundRows}</tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">
      A refund is asked for here and settles when the money has actually gone —
      Razorpay's normal speed is five to seven working days, and nothing about a
      farm's access changes until then. “Settled” is for the one Razorpay's own
      dashboard shows as done when no webhook ever arrived.</p>`
    : '<div class="quiet">No refunds. Long may it last.</div>'}

    ${/*
      Email, on the money screen rather than a screen of its own, because every
      message this system sends is about money and the person who cares that a
      receipt bounced is already here.
    */ ''}
    <h2>Email</h2>
    ${(() => {
      const e = emailHealth ?? {};
      const rows = emails.map((m) => `
        <tr>
          <td class="num">${when(m.created_at)}
              ${m.sent_at ? `<div class="muted">sent ${when(m.sent_at)}</div>` : ''}</td>
          <td><a href="/admin/farms/${esc(m.farm_id)}">${esc(m.farm_name)}</a>
              <div class="muted">${esc(m.to_email)}${
                m.address_suppressed ? ' · <strong>suppressed</strong>' : ''}</div></td>
          <td><code>${esc(m.kind)}</code></td>
          <td>${mailPill(m.status)}
              ${m.attempts > 1 ? `<div class="muted">${m.attempts} attempts</div>` : ''}</td>
          <td class="muted">${esc(m.subject ?? m.last_error ?? '')}</td>
        </tr>`).join('');

      return `<div class="cards">
        <div class="card"><div class="n">${e.sent_7d ?? 0}</div><div class="k">Sent, 7 days</div></div>
        <div class="card"><div class="n">${e.queued ?? 0}</div><div class="k">Queued${
          e.stuck ? ` · ${e.stuck} stuck` : ''}</div></div>
        <div class="card"><div class="n">${e.failed_7d ?? 0}</div><div class="k">Failed, 7 days</div></div>
        <div class="card"><div class="n">${e.suppressed ?? 0}</div>
          <div class="k">Addresses suppressed</div></div>
      </div>
      ${rows ? `<div class="tw"><table>
        <thead><tr><th>Queued</th><th>Farm</th><th>Kind</th><th>Status</th>
          <th>Subject</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<div class="quiet">No email has been queued yet.</div>'}
      <p class="muted" style="margin-top:10px">
        Four messages and no more: a week before a renewal, on the day, when it
        has lapsed, and a receipt. An address that hard-bounces or reports spam
        is suppressed and never written to again — that list is what protects
        the receipts, so nothing in the send path can go around it.</p>`;
    })()}

    <h2>Collected by month</h2>
    <div class="tw"><table style="min-width:0">
      <thead><tr><th>Month</th><th></th><th>Collected</th><th class="num">Invoices</th></tr></thead>
      <tbody>${monthRows}</tbody>
    </table></div>

    <h2>For the GST return</h2>
    ${fy.length ? `<div class="tw"><table>
      <thead><tr><th>Financial year</th><th class="num">Invoices</th><th>Taxable</th>
        <th>GST</th><th>Total</th><th>Series</th></tr></thead>
      <tbody>${fyRows}</tbody>
    </table></div>
    <p class="muted" style="margin-top:10px">
      Prices are GST-inclusive, so taxable value is the total less 18%. The
      series must be consecutive within a financial year: the count and the two
      numbers either end of it should agree.</p>`
    : '<div class="quiet">No paid invoices yet.</div>'}`);
}

/** One stored delivery, payload and all — the other half of a reconciliation. */
export function renderWebhook({ webhook: w }) {
  return page(`Webhook ${w.id}`, `
    <header>
      <h1>Webhook delivery</h1>
      <div class="muted"><a href="/admin/billing">← Billing</a></div>
    </header>

    <div class="tw"><table style="min-width:0"><tbody>
      <tr><td>Event</td><td><code>${esc(w.event)}</code></td></tr>
      <tr><td>Id</td><td><code>${esc(w.id)}</code></td></tr>
      <tr><td>Received</td><td class="num">${when(w.received_at)} UTC</td></tr>
      <tr><td>Processed</td><td class="num">${when(w.processed_at)}</td></tr>
      <tr><td>Result</td><td>${w.errored
        ? `<span class="pill crit">${esc(w.result)}</span>` : esc(w.result ?? '—')}</td></tr>
      <tr><td>Farm</td><td>${w.farm_id
        ? `<a href="/admin/farms/${esc(w.farm_id)}">${esc(w.farm_name)}</a>`
        : '<span class="muted">not attributed to any farm</span>'}</td></tr>
      <tr><td>Link</td><td><code>${esc(w.link_id ?? '—')}</code></td></tr>
      <tr><td>Payment</td><td><code>${esc(w.payment_id ?? '—')}</code></td></tr>
    </tbody></table></div>

    <form method="post" action="/admin/billing/webhooks/${esc(w.id)}/replay"
          class="inline" style="margin-top:18px">
      <input name="reason" placeholder="Reason (required)" required style="min-width:280px">
      <button type="submit">Replay this delivery</button>
    </form>

    <h2>What Razorpay sent</h2>
    <pre>${esc(JSON.stringify(w.payload, null, 2))}</pre>`);
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

export function renderFarm({ farm, audit, subscription, payments = [], admin }) {
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

  /*
   * This farm's money, on this farm's page, for every admin including support.
   * "Did my payment go through" is the call support takes, and the platform-wide
   * screen they are not allowed into is no help with it.
   */
  const paymentRows = payments.map((p) => `
    <tr>
      <td class="num">${when(p.created_at)}</td>
      <td class="num">${rupees(p.amount_paise)}
          <div class="muted">${esc(p.billing_period)}${
            p.gateway !== 'razorpay' ? ` · ${esc(p.gateway)}` : ''}</div>
          ${p.refunded_paise
            ? `<div class="muted">−${rupees(p.refunded_paise)} back</div>` : ''}</td>
      <td>${payPill(p.status)}
          ${p.failed_reason ? `<div class="muted">${esc(p.failed_reason)}</div>` : ''}</td>
      <td>${p.invoice_number
            ? `<code>${esc(p.invoice_number)}</code>
               <div class="muted">${esc(p.period_start ?? '')} → ${esc(p.period_end ?? '')}</div>`
            : '<span class="muted">—</span>'}
          ${p.credit_note_number
            ? `<div class="muted">credit note <code>${esc(p.credit_note_number)}</code></div>`
            : ''}</td>
      <td class="muted">${esc(p.gateway_payment_id ?? p.gateway_link_id ?? '')}</td>
      ${/*
        The refund lives on the payment it reverses, because that is how a
        person thinks about it: "give them back the ₹999 they paid in April",
        not "make a refund and then say which payment it was against".
      */ ''}
      <td>${canBill && p.refundable_paise > 0 ? refundForm(p) : ''}</td>
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

    <h2>Payments</h2>
    <div class="tw"><table style="min-width:620px">
      <thead><tr><th>Made</th><th>Amount</th><th>Status</th><th>Invoice</th>
        <th>Gateway ref</th><th></th></tr></thead>
      <tbody>${paymentRows
        || '<tr><td colspan="6" class="muted">Nothing paid yet.</td></tr>'}</tbody>
    </table></div>

    ${/*
      Money that arrived by UPI or bank transfer. `activate` above moves the
      period and leaves no payment row and no invoice, which is how the GST
      return ends up short of a real ₹999 — this records the money as money.
    */ ''}
    ${canBill ? `
    <div class="action" style="max-width:520px;margin-top:14px">
      <h3>Record a payment taken outside Razorpay</h3>
      <p>UPI to your phone, a bank transfer, cash. Extends the period and issues
         a real invoice number, by the same rules a card payment would.</p>
      <form method="post" action="/admin/farms/${esc(farm.farm_id)}/record_payment">
        <select name="billing_period">
          <option value="yearly">One year</option>
          <option value="monthly">One month</option>
        </select>
        <input name="amount_paise" type="number" min="1"
               placeholder="Amount in paise (blank = their price)">
        <input name="reference" placeholder="UTR or reference">
        <input name="reason" placeholder="Reason (required)" required>
        <button type="submit">Record payment</button>
      </form>
    </div>` : ''}

    <h2>Audit trail</h2>
    <div class="tw"><table style="min-width:620px">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Reason</th></tr></thead>
      <tbody>${auditRows || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}</tbody>
    </table></div>
    ${subscription?.gateway_subscription_id
      ? `<p class="muted">Razorpay: <code>${esc(subscription.gateway_subscription_id)}</code></p>` : ''}`);
}
