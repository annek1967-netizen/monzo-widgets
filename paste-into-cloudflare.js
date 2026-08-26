// Built from src/ by npm run bundle. Do not edit.

// src/monzo.ts
var API = "https://api.monzo.com";
async function getAccessToken(env) {
  const cached = await env.MONZO.get("access_token");
  if (cached) return cached;
  const refreshToken = await env.MONZO.get("refresh_token");
  if (!refreshToken) {
    throw new Error(
      "No refresh token stored. Run the one-time auth step (see SETUP.md)."
    );
  }
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.MONZO_CLIENT_ID,
      client_secret: env.MONZO_CLIENT_SECRET,
      refresh_token: refreshToken
    })
  });
  if (!res.ok) {
    throw new Error(
      `Token refresh failed (${res.status}). You may need to re-authenticate: ${await res.text()}`
    );
  }
  const token = await res.json();
  if (token.refresh_token) {
    await env.MONZO.put("refresh_token", token.refresh_token);
  }
  await env.MONZO.put("access_token", token.access_token, {
    expirationTtl: Math.max(60, token.expires_in - 60)
  });
  return token.access_token;
}
async function api(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Monzo ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}
async function listAccounts(env) {
  const { accounts } = await api(env, "/accounts");
  return accounts.filter((a) => !a.closed);
}
async function getBalance(env, accountId) {
  return api(env, `/balance?account_id=${accountId}`);
}
async function listPots(env, accountId) {
  const { pots } = await api(
    env,
    `/pots?current_account_id=${accountId}`
  );
  return pots.filter((pot) => !pot.deleted);
}
var PAGE_SIZE = 100;
var MAX_PAGES = 10;
async function listTransactions(env, accountId, since) {
  const all = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      account_id: accountId,
      "expand[]": "merchant",
      limit: String(PAGE_SIZE),
      // `since` takes either a timestamp or a transaction id; the id form is
      // what lets us walk forward through the pages.
      since: cursor ?? since.toISOString()
    });
    const { transactions } = await api(
      env,
      `/transactions?${params}`
    );
    all.push(...transactions);
    if (transactions.length < PAGE_SIZE) break;
    cursor = transactions[transactions.length - 1].id;
  }
  return all;
}
function spendDayLabel(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short"
  }).format(date);
}
function recentSpendDays(count, now = /* @__PURE__ */ new Date()) {
  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(
      startOfCalendarDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1e3))
    );
  }
  return days;
}
function recentMonzoSpendDays(count, now = /* @__PURE__ */ new Date()) {
  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(
      startOfSpendDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1e3))
    );
  }
  return days;
}
function weekStarts(count, now, startOf) {
  const weeks = [];
  for (let i = count - 1; i >= 0; i--) {
    const daysBack = i * 7 + 6;
    weeks.push(startOf(new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1e3)));
  }
  return weeks;
}
function recentSpendWeeks(count, now = /* @__PURE__ */ new Date()) {
  return weekStarts(count, now, startOfCalendarDay);
}
function recentMonzoSpendWeeks(count, now = /* @__PURE__ */ new Date()) {
  return weekStarts(count, now, startOfSpendDay);
}
function spendWeekLabel(start) {
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1e3);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short"
  }).format(end);
}
function startOfCalendarDay(now = /* @__PURE__ */ new Date()) {
  const asUTC = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const asLondon = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/London" })
  );
  const offset = asLondon.getTime() - asUTC.getTime();
  const shifted = new Date(now.getTime() + offset);
  shifted.setUTCHours(0, 0, 0, 0);
  let start = new Date(shifted.getTime() - offset);
  if (start > now) start = new Date(start.getTime() - 24 * 60 * 60 * 1e3);
  return start;
}
function startOfSpendDay(now = /* @__PURE__ */ new Date()) {
  const asUTC = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const asLondon = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/London" })
  );
  const offset = asLondon.getTime() - asUTC.getTime();
  const shifted = new Date(now.getTime() + offset);
  shifted.setUTCHours(4, 0, 0, 0);
  let start = new Date(shifted.getTime() - offset);
  if (start > now) start = new Date(start.getTime() - 24 * 60 * 60 * 1e3);
  return start;
}

// src/money-back.ts
var DEFAULT_OPTIONS = {
  splitRepayments: "original",
  unlinkedIncoming: "ignore",
  cardRefunds: "original"
};
function isCardPayment(t) {
  return t.scheme === "mastercard";
}
function dayIndex(created, dayStarts) {
  const at = Date.parse(created);
  for (let i = dayStarts.length - 1; i >= 0; i--) {
    if (at >= dayStarts[i].getTime()) return i;
  }
  return -1;
}
function creditDay(buckets, dayIdx, amount) {
  let left = amount;
  for (const bucket of buckets) {
    if (left <= 0) return;
    const spent = -bucket.daily[dayIdx];
    if (spent <= 0) continue;
    const used = Math.min(spent, left);
    bucket.daily[dayIdx] += used;
    left -= used;
  }
}
function applyMoneyBack(credits, buckets, dayStarts, requestedOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...requestedOptions };
  for (const credit of credits) {
    const isP2P = credit.scheme === "p2p_payment" || credit.scheme === "monzo_to_monzo";
    if (isP2P) {
      const originalId = credit.metadata?.original_transaction_id;
      if (originalId && options.splitRepayments === "ignore") continue;
      const original = originalId ? buckets.flatMap(
        (bucket) => bucket.debits.map((debit) => ({ bucket, debit }))
      ).find(({ debit }) => debit.id === originalId) : void 0;
      if (original) {
        const i2 = dayIndex(original.debit.created, dayStarts);
        if (i2 >= 0) {
          original.bucket.daily[i2] = Math.min(
            0,
            original.bucket.daily[i2] + credit.amount
          );
        }
      }
      if (!originalId && options.unlinkedIncoming === "received") {
        const i2 = dayIndex(credit.created, dayStarts);
        if (i2 >= 0) creditDay(buckets, i2, credit.amount);
      }
      continue;
    }
    if (!isCardPayment(credit)) {
      if (options.unlinkedIncoming === "received") {
        const i2 = dayIndex(credit.created, dayStarts);
        if (i2 >= 0) creditDay(buckets, i2, credit.amount);
      }
      continue;
    }
    if (options.cardRefunds === "ignore") continue;
    if (options.cardRefunds === "received") {
      const i2 = dayIndex(credit.created, dayStarts);
      if (i2 >= 0) creditDay(buckets, i2, credit.amount);
      continue;
    }
    const name = credit.merchant?.name;
    const candidates = name ? buckets.flatMap(
      (bucket) => bucket.debits.filter(
        (d) => d.merchant?.name === name && Date.parse(d.created) <= Date.parse(credit.created)
      ).map((d) => ({ bucket, debit: d }))
    ) : [];
    if (candidates.length > 0) {
      const exact = candidates.filter((c) => -c.debit.amount === credit.amount);
      const pool = exact.length ? exact : candidates;
      const best = pool.reduce(
        (a, b) => Date.parse(a.debit.created) >= Date.parse(b.debit.created) ? a : b
      );
      const i2 = dayIndex(best.debit.created, dayStarts);
      if (i2 >= 0) {
        best.bucket.daily[i2] = Math.min(
          0,
          best.bucket.daily[i2] + credit.amount
        );
        continue;
      }
    }
    if (!isCardPayment(credit)) continue;
    const i = dayIndex(credit.created, dayStarts);
    if (i >= 0) creditDay(buckets, i, credit.amount);
  }
}

// src/buckets.ts
function bucketIndex(created, bucketStarts) {
  const at = Date.parse(created);
  for (let i = bucketStarts.length - 1; i >= 0; i--) {
    if (at >= bucketStarts[i].getTime()) return i;
  }
  return -1;
}
function bucketTotals(transactions, bucketStarts) {
  const totals = new Array(bucketStarts.length).fill(0);
  for (const tx of transactions) {
    const i = bucketIndex(tx.created, bucketStarts);
    if (i >= 0) totals[i] += tx.amount;
  }
  return totals;
}
function categoryShares(t) {
  const split = Object.entries(t.categories ?? {});
  if (split.length > 0) {
    return split.map(([name2, amount]) => [name2.toLowerCase(), amount]);
  }
  const name = (t.category ?? t.merchant?.category ?? "general").toLowerCase();
  return [[name, t.amount]];
}
function amountForCategory(t, category) {
  return categoryShares(t).filter(([name]) => name === category).reduce((sum, [, amount]) => sum + amount, 0);
}
function bucketByCategory(transactions, bucketStarts) {
  const buckets = /* @__PURE__ */ new Map();
  for (const tx of transactions) {
    const i = bucketIndex(tx.created, bucketStarts);
    if (i < 0) continue;
    for (const [category, amount] of categoryShares(tx)) {
      if (amount === 0) continue;
      let bucket = buckets.get(category);
      if (!bucket) {
        bucket = { debits: [], daily: new Array(bucketStarts.length).fill(0) };
        buckets.set(category, bucket);
      }
      bucket.debits.push(tx);
      bucket.daily[i] += amount;
    }
  }
  const total = (bucket) => bucket.daily.reduce((sum, amount) => sum + amount, 0);
  return [...buckets].sort(([, a], [, b]) => total(a) - total(b));
}
function categoryRows(buckets, bucketCount) {
  return Array.from({ length: bucketCount }, (_, i) => {
    const row = {};
    for (const [category, bucket] of buckets) {
      if (bucket.daily[i] !== 0) row[category] = bucket.daily[i];
    }
    return row;
  });
}
function totalByCategory(rows) {
  const totals = {};
  for (const row of rows) {
    for (const [category, amount] of Object.entries(row)) {
      totals[category] = (totals[category] ?? 0) + amount;
    }
  }
  return totals;
}

// src/index.ts
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const configured = await withSettings(env);
    try {
      switch (url.pathname) {
        case "/":
          return await handleHome(url, configured);
        case "/setup":
          return await handleSetup(request, env, configured);
        case "/auth":
          return await handleAuthStart(request, url, configured);
        case "/auth/callback":
          return await handleAuthCallback(url, configured);
        case "/summary":
          return await handleSummary(request, url, configured);
        case "/week":
          return await handleWeek(request, url, configured);
        case "/weeks":
          return await handleWeeks(request, url, configured);
        case "/pots":
          return await handlePots(request, url, configured);
        case "/accounts":
          return await handleAccounts(request, configured);
        case "/version":
          return handleVersion();
        case "/diagnose":
          return await handleDiagnose(request, url, configured);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};
var SETTINGS_KEY = "service_settings";
async function withSettings(env) {
  let stored = {};
  try {
    stored = await env.MONZO.get(SETTINGS_KEY, "json") ?? {};
  } catch {
  }
  return {
    ...env,
    MONZO_CLIENT_ID: env.MONZO_CLIENT_ID || stored.clientId || "",
    MONZO_CLIENT_SECRET: env.MONZO_CLIENT_SECRET || stored.clientSecret || "",
    WIDGET_KEY: env.WIDGET_KEY || stored.widgetKey || ""
  };
}
function isConfigured(env) {
  return Boolean(
    env.MONZO_CLIENT_ID && env.MONZO_CLIENT_SECRET && env.WIDGET_KEY
  );
}
async function handleSetup(request, env, configured) {
  if (request.method !== "POST") return json({ error: "Not found" }, 404);
  if (!sameOrigin(request)) {
    return setupResult("Open this Worker's own setup page and try again.", false);
  }
  const form = await request.formData();
  const clientId = String(form.get("client_id") ?? "").trim();
  const clientSecret = String(form.get("client_secret") ?? "").trim();
  const widgetKey = String(form.get("widget_key") ?? "").trim();
  if (isConfigured(configured)) {
    const current = String(form.get("current_key") ?? "");
    if (!current || !safeEqual(current, configured.WIDGET_KEY)) {
      return setupResult("That widget password is not right.", false);
    }
  }
  if (!clientId || !clientSecret || !widgetKey) {
    return setupResult("Fill in all three boxes.", false);
  }
  if (widgetKey.length < 16) {
    return setupResult("Make the widget password at least 16 characters.", false);
  }
  if (env.MONZO_CLIENT_ID || env.MONZO_CLIENT_SECRET || env.WIDGET_KEY) {
    return setupResult(
      "This service was set up from the command line. Change it there with wrangler secret put.",
      false
    );
  }
  await env.MONZO.put(
    SETTINGS_KEY,
    JSON.stringify({ clientId, clientSecret, widgetKey })
  );
  return setupResult("Saved. Carry on with the next step.", true);
}
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}
function setupResult(message, ok) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monzo Widgets</title>
<style>
  :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  body { margin: 0; background: #001e3a; color: #f7f5f2; }
  main { max-width: 34rem; margin: auto; padding: 2rem 1.25rem; }
  p { padding: .9rem 1rem; border-radius: .8rem; background: ${ok ? "#164c3d" : "#6b3410"}; }
  a { display: block; margin-top: 1rem; color: #69d2ae; }
</style></head><body><main>
<p>${escapeHtml(message)}</p>
<a href="/">Back to setup</a>
</main></body></html>`,
    {
      status: ok ? 200 : 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      }
    }
  );
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
var WORKER_VERSION = 2;
function handleVersion() {
  return new Response(
    JSON.stringify({ service: "monzo-widgets", version: WORKER_VERSION }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}
var RAW_BASE = "https://raw.githubusercontent.com/alixkyle/monzo-widgets/main";
var INSTALLER_URL = `${RAW_BASE}/widget/money-installer.js`;
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
async function fetchText(url) {
  try {
    const res = await fetch(url, {
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
async function handleHome(url, env) {
  const callback = `${url.origin}/auth/callback`;
  const [connected, installerSource] = await Promise.all([
    env.MONZO.get("refresh_token").then(Boolean),
    fetchText(INSTALLER_URL)
  ]);
  const ready = isConfigured(env);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Monzo Widgets</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    body { margin: 0; background: #001e3a; color: #f7f5f2; }
    main { max-width: 34rem; margin: auto; padding: 2rem 1.25rem 4rem; }
    .mark { width: 2rem; height: .25rem; background: #ff4f40; border-radius: 1rem; }
    h1 { font-size: 2rem; margin: 1rem 0 .5rem; }
    p { color: #b7c4d1; line-height: 1.5; }
    .status { margin-top: 1.25rem; padding: .8rem 1rem; border-radius: .8rem; background: ${connected ? "#164c3d" : "#173d60"}; color: #f7f5f2; }
    .step { margin-top: 1rem; padding: 1rem; background: #082b4b; border-radius: 1rem; }
    .step-number { display: inline-grid; place-items: center; width: 1.7rem; height: 1.7rem; margin-right: .45rem; border-radius: 50%; background: #ff4f40; color: white; font-weight: 800; }
    h2 { display: inline; font-size: 1.05rem; }
    label { display: block; font-size: .8rem; font-weight: 700; color: #8fa3b8; margin-bottom: .5rem; }
    .copy-row { display: flex; gap: .5rem; margin-top: .75rem; }
    input, button, a.button { box-sizing: border-box; width: 100%; border: 0; border-radius: .7rem; padding: .9rem; font: inherit; }
    input { background: #f7f5f2; color: #001e3a; }
    .copy-row input { min-width: 0; font-size: .78rem; }
    .copy-row button { width: auto; white-space: nowrap; }
    form input { margin-bottom: .75rem; }
    textarea { box-sizing: border-box; width: 100%; height: 7rem; margin: .75rem 0; border: 0; border-radius: .7rem; padding: .7rem; background: #f7f5f2; color: #001e3a; font-family: ui-monospace, Menlo, monospace; font-size: .7rem; white-space: pre; }
    button, a.button { display: block; background: #ff4f40; color: white; font-weight: 700; text-align: center; text-decoration: none; }
    button.copied { background: #4bb78f; }
    a { color: #69d2ae; }
    small { display: block; color: #8fa3b8; line-height: 1.45; margin-top: .65rem; }
  </style>
</head>
<body>
<main>
  <div class="mark"></div>
  <h1>Monzo Widgets</h1>
  <p>Your private widget service is running. Complete these five steps in order.</p>
  <div class="status">${connected ? "\u2713 Monzo is connected" : ready ? "Monzo is not connected yet" : "Not set up yet"}</div>

  <section class="step">
    <span class="step-number">1</span><h2>Set up this service</h2>
    ${ready ? `<p>\u2713 Done. To change these, fill the form in again with your current
    widget password.</p>` : `<p>Take the Client ID and Client secret from your
    <a href="https://developers.monzo.com/">Monzo developer page</a>. Invent the
    widget password yourself \u2014 it is what stops anyone else reading your bank
    data from this address.</p>`}
    <form action="/setup" method="post">
      ${ready ? `<label for="current-key">CURRENT WIDGET PASSWORD</label>
      <input id="current-key" name="current_key" type="password" autocomplete="current-password" required>` : ""}
      <label for="client-id">MONZO CLIENT ID</label>
      <input id="client-id" name="client_id" required autocomplete="off" spellcheck="false" placeholder="oauth2client_...">
      <label for="client-secret">MONZO CLIENT SECRET</label>
      <input id="client-secret" name="client_secret" type="password" required autocomplete="off" placeholder="mnzconf...">
      <label for="widget-key">WIDGET PASSWORD</label>
      <input id="widget-key" name="widget_key" required autocomplete="off" spellcheck="false" placeholder="At least 16 characters">
      <button type="submit">Save</button>
    </form>
    <small>Write the widget password down. You will need it again in step 3 and
    on your iPhone.</small>
  </section>

  <section class="step">
    <span class="step-number">2</span><h2>Copy the Monzo return address</h2>
    <div class="copy-row">
      <input id="return-address" value="${callback}" readonly>
      <button type="button" data-copy="return-address">Copy</button>
    </div>
    <small>This is called the Redirect URL in Monzo.</small>
  </section>

  <section class="step">
    <span class="step-number">3</span><h2>Save it in Monzo</h2>
    <p>Open your <a href="https://developers.monzo.com/">Monzo developer page</a>, replace the temporary <strong>example.com</strong> Redirect URL, then save.</p>
  </section>

  <section class="step">
    <span class="step-number">4</span><h2>Connect Monzo</h2>
    <form action="/auth" method="post">
      <label for="key">WIDGET PASSWORD</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required placeholder="The widget password from step 1">
      <button type="submit">Connect Monzo</button>
    </form>
  </section>

  <section class="step">
    <span class="step-number">5</span><h2>Install the iPhone widgets</h2>
    ${installerSource ? `<p>After Monzo is connected, copy the installer and paste it into Scriptable.</p>
    <textarea id="installer-source" readonly>${escapeHtml(installerSource)}</textarea>
    <button type="button" data-copy="installer-source">Copy installer script</button>
    <small>Then open Scriptable, tap the blue <strong>+</strong> at the top right,
    paste, and name the script <strong>Monzo Installer</strong>. Run it with the
    triangular play button.</small>` : `<p>The installer could not be loaded just now. Open this link, copy everything,
    then paste it into a new Scriptable script.</p>
    <a class="button" href="${INSTALLER_URL}">Open iPhone installer</a>`}
  </section>

  <small>Service version ${WORKER_VERSION}. The widgets keep themselves up to
  date; this service only needs replacing if a widget ever says so.</small>
  <script nonce="${nonce}">
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const input = document.getElementById(button.dataset.copy);
        try {
          await navigator.clipboard.writeText(input.value);
        } catch {
          input.select();
          document.execCommand("copy");
        }
        button.textContent = "Copied";
        button.classList.add("copied");
      });
    });
  <\/script>
</main>
</body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": (
          // auth.monzo.com must be listed: browsers apply form-action to the
          // whole redirect chain, so 'self' alone silently blocks the 302 that
          // /auth issues towards Monzo and the button appears to do nothing.
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self' https://auth.monzo.com; base-uri 'none'; frame-ancestors 'none'`
        ),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      }
    }
  );
}
function isCurrentAccount(account) {
  return account.type === "uk_retail" || account.type === "uk_retail_joint";
}
function accountLabel(account, accounts) {
  const kind = account.type === "uk_retail_joint" ? "Joint account" : "Personal account";
  const sameKind = accounts.filter((a) => a.type === account.type);
  return sameKind.length > 1 ? `${kind} \u2014 ${account.description}` : kind;
}
function pickAccount(accounts, wanted) {
  const current = accounts.filter(isCurrentAccount);
  const choice = wanted?.trim();
  if (!choice) return current[0];
  if (choice === "joint") {
    return current.find((a) => a.type === "uk_retail_joint");
  }
  if (choice === "personal") {
    return current.find((a) => a.type === "uk_retail");
  }
  return current.find((a) => a.id === choice);
}
var NO_ACCOUNT = "No matching current account. Open Monzo Settings on your iPhone and choose the account again.";
async function handleAccounts(request, env) {
  if (!authorised(request, env)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const accounts = await listAccounts(env);
  const current = accounts.filter(isCurrentAccount);
  return json({
    accounts: current.map((account) => ({
      id: account.id,
      type: account.type,
      label: accountLabel(account, current),
      joint: account.type === "uk_retail_joint"
    })),
    defaultId: current[0]?.id ?? null
  });
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
function authorised(request, env) {
  if (!env.WIDGET_KEY) return false;
  const header = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const key = header;
  if (!key) return false;
  return safeEqual(key, env.WIDGET_KEY);
}
async function handleAuthStart(request, url, env) {
  if (request.method !== "POST" || !sameOrigin(request)) {
    return json({ error: "Open the Monzo Widgets setup page and try again." }, 400);
  }
  let key = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!key) {
    const form = await request.formData();
    const submitted = form.get("key");
    if (typeof submitted === "string") key = submitted;
  }
  if (!key || !env.WIDGET_KEY || !safeEqual(key, env.WIDGET_KEY)) {
    return json({ error: "Incorrect widget password" }, 401);
  }
  const redirectUri = `${url.origin}/auth/callback`;
  const state = crypto.randomUUID();
  await env.MONZO.put("oauth_state", state, { expirationTtl: 600 });
  const authUrl = new URL("https://auth.monzo.com/");
  authUrl.searchParams.set("client_id", env.MONZO_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
async function handleAuthCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = await env.MONZO.get("oauth_state");
  if (!state || !expectedState || !safeEqual(state, expectedState)) {
    return json({ error: "This connection link expired. Return to the Monzo Widgets page and try again." }, 400);
  }
  await env.MONZO.delete("oauth_state");
  if (!code) return json({ error: "Missing code" }, 400);
  const res = await fetch("https://api.monzo.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.MONZO_CLIENT_ID,
      client_secret: env.MONZO_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      code
    })
  });
  if (!res.ok) return json({ error: await res.text() }, 400);
  const token = await res.json();
  if (!token.refresh_token) {
    return json(
      {
        error: "Monzo did not return a refresh token. Your OAuth client must be set to 'Confidential' in the Monzo developer portal."
      },
      400
    );
  }
  await env.MONZO.put("refresh_token", token.refresh_token);
  await env.MONZO.put("access_token", token.access_token, {
    expirationTtl: Math.max(60, token.expires_in - 60)
  });
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Monzo connected</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    body { margin: 0; background: #001e3a; color: #f7f5f2; }
    main { max-width: 32rem; margin: auto; padding: 3rem 1.25rem; text-align: center; }
    .tick { display: grid; place-items: center; width: 4rem; height: 4rem; margin: auto; border-radius: 50%; background: #4bb78f; font-size: 2rem; }
    p { color: #b7c4d1; line-height: 1.5; }
    a { display: block; margin-top: 1rem; padding: .9rem; border-radius: .7rem; background: #ff4f40; color: white; font-weight: 700; text-decoration: none; }
  </style>
</head>
<body>
<main>
  <div class="tick">\u2713</div>
  <h1>Monzo is connected</h1>
  <p>Approve the access request in the Monzo app, then continue with the iPhone installer.</p>
  <a href="https://raw.githubusercontent.com/alixkyle/monzo-widgets/main/widget/money-installer.js">Open iPhone installer</a>
  <a href="${url.origin}">Return to setup</a>
</main>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
var DAYS = 7;
function spendOnly(transactions) {
  return transactions.filter((t) => t.amount < 0 && !t.decline_reason);
}
function transactionCategories(t) {
  return [
    t.category,
    t.merchant?.category,
    ...Object.keys(t.categories ?? {})
  ].flatMap((category) => category ? [category.toLowerCase()] : []);
}
function hasAnyWeekCategory(t, categories) {
  return transactionCategories(t).some((category) => categories.has(category));
}
function isMoneyBack(t) {
  return t.amount > 0 && (isCardPayment(t) || t.scheme === "p2p_payment" || t.scheme === "monzo_to_monzo");
}
var TRANSFER_WINDOW = 3 * 24 * 60 * 60 * 1e3;
function withoutInternalTransfers(retailTx, flexTx) {
  const flexCredits = flexTx.filter((t) => t.amount > 0);
  return retailTx.filter((r) => {
    if ((r.description ?? "").startsWith("pot_")) return false;
    return !flexCredits.some(
      (f) => f.amount === -r.amount && Math.abs(Date.parse(f.created) - Date.parse(r.created)) < TRANSFER_WINDOW
    );
  });
}
async function handlePots(request, url, env) {
  if (!authorised(request, env)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const accounts = await listAccounts(env);
  const main = pickAccount(accounts, url.searchParams.get("account"));
  if (!main) return json({ error: NO_ACCOUNT }, 404);
  const flexAccount = accounts.find((a) => a.type === "uk_monzo_flex");
  const [balance, pots, flexBalance] = await Promise.all([
    getBalance(env, main.id),
    listPots(env, main.id),
    flexAccount ? getBalance(env, flexAccount.id).catch(() => null) : Promise.resolve(null)
  ]);
  return new Response(
    JSON.stringify({
      currency: balance.currency,
      currentBalance: balance.balance,
      totalBalance: balance.total_balance,
      flexBalance: flexBalance?.balance ?? null,
      pots: pots.map((pot) => ({
        id: pot.id,
        name: pot.name,
        balance: pot.balance
      })),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}
function readSpendOptions(url) {
  const names = (value, fallback = "") => new Set(
    (value ?? fallback).split(",").map((category) => category.trim().toLowerCase()).filter(Boolean)
  );
  const cardRefundParam = url.searchParams.get("cardRefunds");
  const outgoingTransferParam = url.searchParams.get("outgoingTransfers");
  return {
    account: url.searchParams.get("account"),
    categoryFilter: names(url.searchParams.get("categories")),
    excludedCategories: names(url.searchParams.get("exclude"), "bills,savings"),
    includeFlex: url.searchParams.get("includeFlex") !== "false",
    useMonzoDay: url.searchParams.get("dayStart") === "monzo",
    splitRepayments: url.searchParams.get("splitRepayments") === "ignore" ? "ignore" : "original",
    unlinkedIncoming: url.searchParams.get("unlinkedIncoming") === "received" ? "received" : "ignore",
    cardRefunds: cardRefundParam === "received" || cardRefundParam === "ignore" ? cardRefundParam : "original",
    outgoingTransfers: outgoingTransferParam === "exclude" || outgoingTransferParam === "spending" ? outgoingTransferParam : "include"
  };
}
async function loadSpending(env, options, bucketStarts, reference) {
  const accounts = await listAccounts(env);
  const retail = pickAccount(accounts, options.account);
  if (!retail) return null;
  const flexAccount = accounts.find((a) => a.type === "uk_monzo_flex");
  const since = bucketStarts[0];
  const until = (options.useMonzoDay ? startOfSpendDay : startOfCalendarDay)(
    new Date(reference.getTime() + 24 * 60 * 60 * 1e3)
  ).getTime();
  const inWindow = (t) => Date.parse(t.created) < until;
  const [retailAll, flexAll, balance, flexBalance] = await Promise.all([
    listTransactions(env, retail.id, since),
    flexAccount ? listTransactions(env, flexAccount.id, since).catch(() => []) : Promise.resolve([]),
    getBalance(env, retail.id),
    flexAccount ? getBalance(env, flexAccount.id).catch(() => null) : Promise.resolve(null)
  ]);
  const retailTx = retailAll.filter(inWindow);
  const flexTx = flexAll.filter(inWindow);
  const retailReal = options.categoryFilter.size ? retailTx.filter((t) => hasAnyWeekCategory(t, options.categoryFilter)) : withoutInternalTransfers(retailTx, flexTx).filter(
    (t) => !hasAnyWeekCategory(t, options.excludedCategories)
  );
  const flexReal = !options.includeFlex ? [] : options.categoryFilter.size ? flexTx.filter((t) => hasAnyWeekCategory(t, options.categoryFilter)) : flexTx.filter((t) => !hasAnyWeekCategory(t, options.excludedCategories));
  const cardSpend = spendOnly(retailReal).filter(isCardPayment);
  const allTransferSpend = spendOnly(retailReal).filter(
    (t) => !isCardPayment(t)
  );
  const nonSpendingTransferCategories = /* @__PURE__ */ new Set([
    "income",
    "transfers",
    "savings"
  ]);
  const transferSpend = options.categoryFilter.size ? allTransferSpend : options.outgoingTransfers === "exclude" ? [] : options.outgoingTransfers === "spending" ? allTransferSpend.filter(
    (t) => !hasAnyWeekCategory(t, nonSpendingTransferCategories)
  ) : allTransferSpend;
  const flexSpend = spendOnly(flexReal);
  const cardDaily = bucketTotals(cardSpend, bucketStarts);
  const transferDaily = bucketTotals(transferSpend, bucketStarts);
  const flexDaily = bucketTotals(flexSpend, bucketStarts);
  const categorySpend = spendOnly([...retailReal, ...flexReal]);
  const billsDaily = bucketTotals(
    categorySpend.map((t) => ({ ...t, amount: amountForCategory(t, "bills") })).filter((t) => t.amount !== 0),
    bucketStarts
  );
  const savingsDaily = bucketTotals(
    categorySpend.map((t) => ({ ...t, amount: amountForCategory(t, "savings") })).filter((t) => t.amount !== 0),
    bucketStarts
  );
  const categoryBuckets = bucketByCategory(
    [...cardSpend, ...transferSpend, ...flexSpend],
    bucketStarts
  );
  const incomingForAdjustment = [...retailReal, ...flexReal].filter(
    (t) => isMoneyBack(t) || options.unlinkedIncoming === "received" && t.amount > 0 && retailReal.some((retailTransaction) => retailTransaction.id === t.id)
  );
  const moneyBackOptions = {
    splitRepayments: options.splitRepayments,
    unlinkedIncoming: options.unlinkedIncoming,
    cardRefunds: options.cardRefunds
  };
  applyMoneyBack(
    incomingForAdjustment,
    [
      { debits: cardSpend, daily: cardDaily },
      { debits: flexSpend, daily: flexDaily },
      { debits: transferSpend, daily: transferDaily }
    ],
    bucketStarts,
    moneyBackOptions
  );
  applyMoneyBack(
    incomingForAdjustment,
    categoryBuckets.map(([, bucket]) => bucket),
    bucketStarts,
    moneyBackOptions
  );
  return {
    currency: balance.currency,
    balance: balance.balance,
    flexBalance: flexBalance ? flexBalance.balance : null,
    hasFlex: Boolean(flexAccount),
    card: cardDaily,
    transfers: transferDaily,
    flex: flexDaily,
    bills: billsDaily,
    savings: savingsDaily,
    categories: categoryRows(categoryBuckets, bucketStarts.length)
  };
}
function spendingBucket(spending, options, i) {
  return {
    card: spending.card[i],
    transfers: spending.transfers[i],
    flex: spending.flex[i],
    bills: spending.bills[i],
    savings: spending.savings[i],
    categories: spending.categories[i],
    total: options.categoryFilter.size ? spending.bills[i] + spending.savings[i] : spending.card[i] + spending.transfers[i] + spending.flex[i]
  };
}
function spendingResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
async function handleWeek(request, url, env) {
  if (!authorised(request, env)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const options = readSpendOptions(url);
  const weeksAgo = Math.min(
    52,
    Math.max(0, Number(url.searchParams.get("weeks")) || 0)
  );
  const reference = new Date(Date.now() - weeksAgo * DAYS * 24 * 60 * 60 * 1e3);
  const dayStarts = options.useMonzoDay ? recentMonzoSpendDays(DAYS, reference) : recentSpendDays(DAYS, reference);
  const spending = await loadSpending(env, options, dayStarts, reference);
  if (!spending) return json({ error: NO_ACCOUNT }, 404);
  const days = dayStarts.map((start, i) => ({
    date: start.toISOString(),
    label: spendDayLabel(start),
    ...spendingBucket(spending, options, i)
  }));
  return spendingResponse({
    currency: spending.currency,
    days,
    weekTotal: days.reduce((s, d) => s + d.total, 0),
    categoryTotals: totalByCategory(spending.categories),
    hasFlex: spending.hasFlex,
    weeksAgo,
    // Balances are always current — they aren't rewound for past weeks.
    balance: spending.balance,
    flexBalance: spending.flexBalance,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
var DEFAULT_WEEK_COUNT = 4;
var MAX_WEEK_COUNT = 12;
async function handleWeeks(request, url, env) {
  if (!authorised(request, env)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const options = readSpendOptions(url);
  const count = Math.min(
    MAX_WEEK_COUNT,
    Math.max(
      1,
      Number(url.searchParams.get("count")) || DEFAULT_WEEK_COUNT
    )
  );
  const reference = /* @__PURE__ */ new Date();
  const weekStarts2 = options.useMonzoDay ? recentMonzoSpendWeeks(count, reference) : recentSpendWeeks(count, reference);
  const spending = await loadSpending(env, options, weekStarts2, reference);
  if (!spending) return json({ error: NO_ACCOUNT }, 404);
  const weeks = weekStarts2.map((start, i) => ({
    start: start.toISOString(),
    label: spendWeekLabel(start),
    latest: i === weekStarts2.length - 1,
    ...spendingBucket(spending, options, i)
  }));
  return spendingResponse({
    currency: spending.currency,
    weeks,
    periodTotal: weeks.reduce((s, w) => s + w.total, 0),
    categoryTotals: totalByCategory(spending.categories),
    hasFlex: spending.hasFlex,
    balance: spending.balance,
    flexBalance: spending.flexBalance,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function handleDiagnose(request, url, env) {
  if (!authorised(request, env)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const accounts = await listAccounts(env);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1e3);
  const report = [];
  for (const account of accounts) {
    const entry = {
      type: account.type,
      description: account.description
    };
    try {
      const b = await getBalance(env, account.id);
      entry.balance = b.balance;
      entry.spendToday = b.spend_today;
    } catch (e) {
      entry.balanceError = e.message.slice(0, 120);
    }
    for (const windowDays of [7, 30, 89]) {
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1e3);
      try {
        const tx = await listTransactions(env, account.id, since);
        entry[`window${windowDays}d`] = {
          count: tx.length,
          newest: tx.length ? tx[tx.length - 1].created : null,
          recent: tx.slice(-5).map((t) => ({
            created: t.created,
            amount: t.amount,
            declined: Boolean(t.decline_reason),
            name: (t.merchant?.name ?? t.description ?? "").slice(0, 24)
          }))
        };
      } catch (e) {
        entry[`window${windowDays}d`] = {
          error: e.message.slice(0, 160)
        };
      }
    }
    report.push(entry);
  }
  const retail = accounts.find((a) => a.type === "uk_retail");
  const flex = accounts.find((a) => a.type === "uk_monzo_flex");
  let overlap = "not checked";
  if (retail && flex) {
    const [retailTx, flexTx] = await Promise.all([
      listTransactions(env, retail.id, weekAgo),
      listTransactions(env, flex.id, weekAgo)
    ]);
    const WINDOW = 14 * 24 * 60 * 60 * 1e3;
    const near = (a, b) => Math.abs(Date.parse(a.created) - Date.parse(b.created)) < WINDOW;
    const flexPurchases = flexTx.filter((t) => t.amount < 0);
    const duplicated = flexPurchases.filter(
      (f) => retailTx.some((r) => r.amount === f.amount && near(r, f))
    );
    const creditedBack = flexPurchases.filter(
      (f) => retailTx.some((r) => r.amount === -f.amount && near(r, f))
    );
    const flexRepayments = flexTx.filter((t) => t.amount > 0);
    const retailToFlex = retailTx.filter(
      (r) => r.amount < 0 && /flex/i.test(`${r.merchant?.name ?? ""} ${r.description ?? ""}`)
    );
    const incomingP2P = retailTx.filter(
      (t) => t.amount > 0 && (t.scheme === "p2p_payment" || t.scheme === "monzo_to_monzo")
    );
    const linkedSplits = incomingP2P.filter(
      (t) => t.metadata?.original_transaction_id
    );
    const retailIds = new Set(retailTx.map((t) => t.id));
    overlap = {
      flexPurchases: flexPurchases.length,
      duplicatedOnRetail: duplicated.length,
      duplicatedTotal: duplicated.reduce((s, t) => s + t.amount, 0),
      creditedBackOnRetail: creditedBack.length,
      flexRepayments: flexRepayments.length,
      flexRepaymentTotal: flexRepayments.reduce((s, t) => s + t.amount, 0),
      retailPaymentsToFlex: retailToFlex.length,
      retailPaymentsToFlexTotal: retailToFlex.reduce((s, t) => s + t.amount, 0),
      retailToFlexNames: retailToFlex.slice(0, 5).map((r) => `${r.created.slice(0, 10)} ${r.amount} ${r.merchant?.name ?? r.description}`),
      splitRepayments: {
        incomingP2P: incomingP2P.length,
        withOriginalTransactionId: linkedSplits.length,
        originalInWindow: linkedSplits.filter(
          (t) => retailIds.has(t.metadata.original_transaction_id)
        ).length
      },
      excludedAsTransfers: retailTx.filter((t) => t.amount < 0 && !t.decline_reason).length - spendOnly(withoutInternalTransfers(retailTx, flexTx)).length,
      // Scheme counts only — enough to spot a new payment type appearing
      // without exposing individual transactions.
      schemes: withoutInternalTransfers(retailTx, flexTx).filter((t) => !t.decline_reason).reduce((counts, t) => {
        const key = `${t.scheme ?? "unknown"}:${t.amount < 0 ? "out" : "in"}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {})
    };
  }
  return json({ accounts: report, overlap });
}
async function handleSummary(request, url, env) {
  if (!authorised(request, env)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const accounts = await listAccounts(env);
  const main = pickAccount(accounts, url.searchParams.get("account"));
  if (!main) return json({ error: NO_ACCOUNT }, 404);
  const useMonzoDay = url.searchParams.get("dayStart") === "monzo";
  const since = useMonzoDay ? startOfSpendDay() : startOfCalendarDay();
  const [balance, transactions] = await Promise.all([
    getBalance(env, main.id),
    listTransactions(env, main.id, since)
  ]);
  const flexAccount = accounts.find((a) => a.type === "uk_monzo_flex");
  let flex = null;
  if (flexAccount) {
    try {
      const flexBalance = await getBalance(env, flexAccount.id);
      flex = { balance: flexBalance.balance };
    } catch {
      flex = null;
    }
  }
  const spending = transactions.filter(
    (t) => !t.decline_reason && t.amount !== 0 && !(t.description ?? "").startsWith("pot_")
  ).map((t) => ({
    id: t.id,
    created: t.created,
    amount: t.amount,
    name: t.merchant?.name ?? t.description,
    category: t.merchant?.category ?? null
  })).sort((a, b) => b.created.localeCompare(a.created));
  return new Response(
    JSON.stringify({
      currency: balance.currency,
      // All amounts are in minor units (pennies), as Monzo returns them.
      spentToday: useMonzoDay ? balance.spend_today : spending.filter((t) => t.amount < 0).reduce((sum, t) => sum + t.amount, 0),
      balance: balance.balance,
      totalBalance: balance.total_balance,
      flex,
      transactions: spending,
      since: since.toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}
export {
  index_default as default
};
