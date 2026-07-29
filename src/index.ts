import {
  Env,
  Account,
  listAccounts,
  getBalance,
  listPots,
  listTransactions,
  startOfSpendDay,
  startOfCalendarDay,
  recentSpendDays,
  recentMonzoSpendDays,
  recentSpendWeeks,
  recentMonzoSpendWeeks,
  spendDayLabel,
  spendWeekLabel,
  Transaction,
} from "./monzo.js";
import { applyMoneyBack, isCardPayment } from "./money-back.js";
import {
  amountForCategory,
  bucketByCategory,
  bucketTotals,
  categoryRows,
  totalByCategory,
} from "./buckets.js";

/**
 * Small proxy between the iPhone widget and Monzo.
 *
 * It exists so the OAuth refresh-token rotation happens in one reliable place
 * instead of inside a widget that iOS may kill mid-request.
 *
 *   GET /auth?key=...           start the one-time Monzo authorisation
 *   GET /auth/callback          Monzo redirects here; stores the refresh token
 *   GET /summary?key=...        everything the widget might want, as JSON
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/":
          return await handleHome(url, env);
        case "/auth":
          return await handleAuthStart(request, url, env);
        case "/auth/callback":
          return await handleAuthCallback(url, env);
        case "/summary":
          return await handleSummary(request, url, env);
        case "/week":
          return await handleWeek(request, url, env);
        case "/weeks":
          return await handleWeeks(request, url, env);
        case "/pots":
          return await handlePots(request, url, env);
        case "/accounts":
          return await handleAccounts(request, url, env);
        case "/version":
          return handleVersion();
        case "/diagnose":
          return await handleDiagnose(request, url, env);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Bump this whenever the widgets start needing something older Workers do not
 * serve. Each user runs their own copy of this Worker and updates it on their
 * own schedule, so a widget can easily be newer than the Worker it is talking
 * to. Without a version to compare, that shows up as a bare 404 from a route
 * that simply did not exist yet, which tells the user nothing.
 *
 *   1  the original /summary, /week and /pots widgets
 *   2  adds /weeks, plus category breakdowns on /week
 */
const WORKER_VERSION = 2;

/**
 * Deliberately unauthenticated: the installer needs to tell "your Worker is
 * old" apart from "your widget key is wrong", and it cannot do that if the
 * version check is itself behind the key. Nothing here is private — the
 * landing page already identifies this as a Monzo Widgets Worker.
 */
function handleVersion(): Response {
  return new Response(
    JSON.stringify({ service: "monzo-widgets", version: WORKER_VERSION }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}

const RAW_BASE = "https://raw.githubusercontent.com/alixkyle/monzo-widgets/main";
const INSTALLER_URL = `${RAW_BASE}/widget/money-installer.js`;
const WORKFLOW_URL = `${RAW_BASE}/worker/.github/workflows/sync-upstream.yml`;
const UPSTREAM_SOURCE_URL = `${RAW_BASE}/worker/src/index.ts`;
const WORKFLOW_PATH = ".github/workflows/sync-upstream.yml";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Safari cannot reliably "Save to Files" a raw file into Scriptable's iCloud
 * folder, and the same is true of adding a file to GitHub on a phone, so the
 * page offers both the installer and the update workflow as copyable text.
 * Returns null when GitHub is unreachable; each caller then degrades to a
 * plain link rather than showing an empty box.
 */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * The newest WORKER_VERSION published upstream, read from the source itself so
 * there is only ever one number to bump.
 *
 * Returns null when GitHub is unreachable or the constant cannot be found, and
 * the page then says nothing about freshness rather than claiming a Worker is
 * out of date on the strength of a failed request.
 */
async function fetchLatestVersion(): Promise<number | null> {
  const source = await fetchText(UPSTREAM_SOURCE_URL);
  if (!source) return null;
  const match = source.match(/^const WORKER_VERSION = (\d+);/m);
  return match ? Number(match[1]) : null;
}

async function handleHome(url: URL, env: Env): Promise<Response> {
  const callback = `${url.origin}/auth/callback`;
  const [connected, installerSource, workflowSource, latestVersion] =
    await Promise.all([
      env.MONZO.get("refresh_token").then(Boolean),
      fetchText(INSTALLER_URL),
      fetchText(WORKFLOW_URL),
      fetchLatestVersion(),
    ]);
  const behind = latestVersion !== null && latestVersion > WORKER_VERSION;
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
    .version { margin: .75rem 0; padding: .7rem .9rem; border-radius: .7rem; font-size: .85rem; font-weight: 700; }
    .version.fresh { background: #164c3d; color: #d7f2e7; }
    .version.stale { background: #6b3410; color: #ffe2c9; }
  </style>
</head>
<body>
<main>
  <div class="mark"></div>
  <h1>Monzo Widgets</h1>
  <p>Your private widget service is running. Complete these five steps in order.</p>
  <div class="status">${connected ? "✓ Monzo is connected" : "Monzo is not connected yet"}</div>

  <section class="step">
    <span class="step-number">1</span><h2>Copy the Monzo return address</h2>
    <div class="copy-row">
      <input id="return-address" value="${callback}" readonly>
      <button type="button" data-copy="return-address">Copy</button>
    </div>
    <small>This is called the Redirect URL in Monzo.</small>
  </section>

  <section class="step">
    <span class="step-number">2</span><h2>Save it in Monzo</h2>
    <p>Open your <a href="https://developers.monzo.com/">Monzo developer page</a>, replace the temporary <strong>example.com</strong> Redirect URL, then save.</p>
  </section>

  <section class="step">
    <span class="step-number">3</span><h2>Connect Monzo</h2>
    <form action="/auth" method="post">
      <label for="key">WIDGET PASSWORD</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required placeholder="The WIDGET_KEY saved during deployment">
      <button type="submit">Connect Monzo</button>
    </form>
  </section>

  <section class="step">
    <span class="step-number">4</span><h2>Install the iPhone widgets</h2>
    ${
      installerSource
        ? `<p>After Monzo is connected, copy the installer and paste it into Scriptable.</p>
    <textarea id="installer-source" readonly>${escapeHtml(installerSource)}</textarea>
    <button type="button" data-copy="installer-source">Copy installer script</button>
    <small>Then open Scriptable, tap the blue <strong>+</strong> at the top right,
    paste, and name the script <strong>Monzo Installer</strong>. Run it with the
    triangular play button.</small>`
        : `<p>The installer could not be loaded just now. Open this link, copy everything,
    then paste it into a new Scriptable script.</p>
    <a class="button" href="${INSTALLER_URL}">Open iPhone installer</a>`
    }
  </section>

  <section class="step">
    <span class="step-number">5</span><h2>Turn on automatic updates</h2>
    <div class="version ${behind ? "stale" : "fresh"}">${
      latestVersion === null
        ? `Running version ${WORKER_VERSION}. The latest version could not be checked just now.`
        : behind
          ? `Update available — this service is on version ${WORKER_VERSION}, the latest is ${latestVersion}.`
          : `✓ Up to date (version ${WORKER_VERSION})`
    }</div>
    <p>When you deployed this, GitHub made your own copy of the project. Adding
    the file below to that copy keeps this service updating itself, so new
    widgets always have something that understands them.</p>
    ${
      workflowSource
        ? `<textarea id="workflow-source" readonly>${escapeHtml(workflowSource)}</textarea>
    <button type="button" data-copy="workflow-source">Copy the auto-update file</button>
    <small>Then open your copy of <strong>monzo-widgets</strong> on github.com,
    tap <strong>Add file → Create new file</strong>, name it exactly
    <strong>${WORKFLOW_PATH}</strong>, paste, and commit. Check the
    <strong>Actions</strong> tab afterwards and tap the enable button if one
    appears — GitHub keeps new workflows switched off until you approve them.
    <br><br>Already added it? Then there is nothing to do; it updates once a
    day on its own.</small>`
        : `<p>The file could not be loaded just now.</p>
    <a class="button" href="${WORKFLOW_URL}">Open the auto-update file</a>`
    }
  </section>
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
  </script>
</main>
</body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          // auth.monzo.com must be listed: browsers apply form-action to the
          // whole redirect chain, so 'self' alone silently blocks the 302 that
          // /auth issues towards Monzo and the button appears to do nothing.
          `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self' https://auth.monzo.com; base-uri 'none'; frame-ancestors 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}

function isCurrentAccount(account: Account): boolean {
  return account.type === "uk_retail" || account.type === "uk_retail_joint";
}

/** "Joint account", or the Monzo description when there are several of a kind. */
function accountLabel(account: Account, accounts: Account[]): string {
  const kind =
    account.type === "uk_retail_joint" ? "Joint account" : "Personal account";
  const sameKind = accounts.filter((a) => a.type === account.type);
  return sameKind.length > 1 ? `${kind} — ${account.description}` : kind;
}

/**
 * Which current account the widgets read.
 *
 * `wanted` is an account id, or "personal"/"joint" so a widget can be pinned to
 * a kind of account without knowing its id. With nothing chosen, this falls
 * back to the first current account Monzo returns — for anyone holding a joint
 * account that is usually, but not always, the personal one.
 *
 * An unresolvable choice returns undefined rather than falling back, so a stale
 * id surfaces as an error instead of quietly showing the wrong account's money.
 */
function pickAccount(
  accounts: Account[],
  wanted: string | null
): Account | undefined {
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

const NO_ACCOUNT =
  "No matching current account. Open Monzo Settings on your iPhone and choose " +
  "the account again.";

/** Lets Monzo Settings show a picker without hard-coding account ids. */
async function handleAccounts(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (!authorised(request, url, env)) {
    return json({ error: "Unauthorised" }, 401);
  }

  const accounts = await listAccounts(env);
  const current = accounts.filter(isCurrentAccount);
  return json({
    accounts: current.map((account) => ({
      id: account.id,
      type: account.type,
      label: accountLabel(account, current),
      joint: account.type === "uk_retail_joint",
    })),
    defaultId: current[0]?.id ?? null,
  });
}

/** Compares without leaking which character differed via response timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The endpoint is publicly addressable, so every request must carry the key.
 * Prefer the Authorization header — query strings end up in browser history
 * and logs. The `?key=` form exists only for the one-time browser auth flow,
 * where headers can't be set.
 */
function authorised(request: Request, url: URL, env: Env): boolean {
  // A missing or misconfigured secret must deny everything, never allow.
  if (!env.WIDGET_KEY) return false;

  const header = request.headers
    .get("Authorization")
    ?.replace(/^Bearer\s+/i, "");
  const key = header || url.searchParams.get("key");
  if (!key) return false;

  return safeEqual(key, env.WIDGET_KEY);
}

async function handleAuthStart(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  let key = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!key && request.method === "POST") {
    const form = await request.formData();
    const submitted = form.get("key");
    if (typeof submitted === "string") key = submitted;
  }
  key ||= url.searchParams.get("key") ?? undefined;
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

async function handleAuthCallback(url: URL, env: Env): Promise<Response> {
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
      code,
    }),
  });

  if (!res.ok) return json({ error: await res.text() }, 400);

  const token = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!token.refresh_token) {
    return json(
      {
        error:
          "Monzo did not return a refresh token. Your OAuth client must be " +
          "set to 'Confidential' in the Monzo developer portal.",
      },
      400
    );
  }

  await env.MONZO.put("refresh_token", token.refresh_token);
  await env.MONZO.put("access_token", token.access_token, {
    expirationTtl: Math.max(60, token.expires_in - 60),
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
  <div class="tick">✓</div>
  <h1>Monzo is connected</h1>
  <p>Approve the access request in the Monzo app, then continue with the iPhone installer.</p>
  <a href="https://raw.githubusercontent.com/alixkyle/monzo-widgets/main/widget/money-installer.js">Open iPhone installer</a>
  <a href="${url.origin}">Return to setup</a>
</main>
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const DAYS = 7;

/** Spending only: drop refunds and declines. */
function spendOnly(transactions: Transaction[]): Transaction[] {
  return transactions.filter((t) => t.amount < 0 && !t.decline_reason);
}

/**
 * Card payments are purchases. Everything else leaving the account is a
 * transfer to a person — Monzo tags "Digs" and "Parking" as monzo_to_monzo
 * even though they read like purchases, so the scheme is the reliable signal
 * rather than whether a merchant record exists.
 */
function transactionCategories(t: Transaction): string[] {
  return [
    t.category,
    t.merchant?.category,
    ...Object.keys(t.categories ?? {}),
  ].flatMap((category) => (category ? [category.toLowerCase()] : []));
}

function hasAnyWeekCategory(t: Transaction, categories: Set<string>): boolean {
  return transactionCategories(t).some((category) => categories.has(category));
}

/**
 * Money back that should reduce spending: card refunds, and friends paying
 * back their share. Wages and other income use different schemes (bacs,
 * payport_faster_payments) and are deliberately excluded.
 */
function isMoneyBack(t: Transaction): boolean {
  return (
    t.amount > 0 &&
    (isCardPayment(t) ||
      t.scheme === "p2p_payment" ||
      t.scheme === "monzo_to_monzo")
  );
}

const TRANSFER_WINDOW = 3 * 24 * 60 * 60 * 1000;

/**
 * Removes money moved between the user's own accounts, which isn't spending.
 *
 * A Flex repayment is the important case: the purchase already counted on the
 * Flex account when it was made, so counting the repayment too charges it
 * twice. Repayments are identified by a matching credit on the Flex side
 * rather than by name, since a real merchant could be called "Flex".
 */
function withoutInternalTransfers(
  retailTx: Transaction[],
  flexTx: Transaction[]
): Transaction[] {
  const flexCredits = flexTx.filter((t) => t.amount > 0);

  return retailTx.filter((r) => {
    // Money into a savings pot is saving, not spending.
    if ((r.description ?? "").startsWith("pot_")) return false;

    return !flexCredits.some(
      (f) =>
        f.amount === -r.amount &&
        Math.abs(Date.parse(f.created) - Date.parse(r.created)) <
          TRANSFER_WINDOW
    );
  });
}

async function handlePots(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (!authorised(request, url, env)) {
    return json({ error: "Unauthorised" }, 401);
  }

  const accounts = await listAccounts(env);
  const main = pickAccount(accounts, url.searchParams.get("account"));
  if (!main) return json({ error: NO_ACCOUNT }, 404);
  const flexAccount = accounts.find((a) => a.type === "uk_monzo_flex");

  const [balance, pots, flexBalance] = await Promise.all([
    getBalance(env, main.id),
    listPots(env, main.id),
    flexAccount
      ? getBalance(env, flexAccount.id).catch(() => null)
      : Promise.resolve(null),
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
        balance: pot.balance,
      })),
      updatedAt: new Date().toISOString(),
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}

interface SpendOptions {
  account: string | null;
  categoryFilter: Set<string>;
  excludedCategories: Set<string>;
  includeFlex: boolean;
  useMonzoDay: boolean;
  splitRepayments: "original" | "ignore";
  unlinkedIncoming: "ignore" | "received";
  cardRefunds: "original" | "received" | "ignore";
  outgoingTransfers: "include" | "exclude" | "spending";
}

/** Every option the spending charts share, defaulted the same way for both. */
function readSpendOptions(url: URL): SpendOptions {
  const names = (value: string | null, fallback = "") =>
    new Set(
      (value ?? fallback)
        .split(",")
        .map((category) => category.trim().toLowerCase())
        .filter(Boolean)
    );

  const cardRefundParam = url.searchParams.get("cardRefunds");
  const outgoingTransferParam = url.searchParams.get("outgoingTransfers");

  return {
    account: url.searchParams.get("account"),
    categoryFilter: names(url.searchParams.get("categories")),
    excludedCategories: names(url.searchParams.get("exclude"), "bills,savings"),
    includeFlex: url.searchParams.get("includeFlex") !== "false",
    useMonzoDay: url.searchParams.get("dayStart") === "monzo",
    splitRepayments:
      url.searchParams.get("splitRepayments") === "ignore"
        ? "ignore"
        : "original",
    unlinkedIncoming:
      url.searchParams.get("unlinkedIncoming") === "received"
        ? "received"
        : "ignore",
    cardRefunds:
      cardRefundParam === "received" || cardRefundParam === "ignore"
        ? cardRefundParam
        : "original",
    outgoingTransfers:
      outgoingTransferParam === "exclude" ||
      outgoingTransferParam === "spending"
        ? outgoingTransferParam
        : "include",
  };
}

interface Spending {
  currency: string;
  balance: number;
  flexBalance: number | null;
  hasFlex: boolean;
  card: number[];
  transfers: number[];
  flex: number[];
  bills: number[];
  savings: number[];
  categories: Record<string, number>[];
}

/**
 * Totals every bucket in `bucketStarts`, which may be days or whole weeks —
 * the arithmetic is identical either way, only the boundaries differ.
 *
 * Returns null when there is no current account to read.
 */
async function loadSpending(
  env: Env,
  options: SpendOptions,
  bucketStarts: Date[],
  reference: Date
): Promise<Spending | null> {
  const accounts = await listAccounts(env);
  const retail = pickAccount(accounts, options.account);
  if (!retail) return null;
  const flexAccount = accounts.find((a) => a.type === "uk_monzo_flex");

  const since = bucketStarts[0];
  // Anything after this window would otherwise land on the final bucket, since
  // bucketing assigns to the newest boundary at or before the timestamp.
  const until = (options.useMonzoDay ? startOfSpendDay : startOfCalendarDay)(
    new Date(reference.getTime() + 24 * 60 * 60 * 1000)
  ).getTime();
  const inWindow = (t: Transaction) => Date.parse(t.created) < until;

  // Flex is summed in because it carries real spending that never appears on
  // the current account — verified as non-overlapping via /diagnose.
  const [retailAll, flexAll, balance, flexBalance] = await Promise.all([
    listTransactions(env, retail.id, since),
    flexAccount
      ? listTransactions(env, flexAccount.id, since).catch(() => [])
      : Promise.resolve([] as Transaction[]),
    getBalance(env, retail.id),
    flexAccount
      ? getBalance(env, flexAccount.id).catch(() => null)
      : Promise.resolve(null),
  ]);

  const retailTx = retailAll.filter(inWindow);
  const flexTx = flexAll.filter(inWindow);
  // A category-filtered chart shows the selected transactions as Monzo
  // reports them, including savings-pot transfers. The normal chart removes
  // those movements, then excludes bills and savings altogether.
  const retailReal = options.categoryFilter.size
    ? retailTx.filter((t) => hasAnyWeekCategory(t, options.categoryFilter))
    : withoutInternalTransfers(retailTx, flexTx).filter(
        (t) => !hasAnyWeekCategory(t, options.excludedCategories)
      );
  const flexReal = !options.includeFlex
    ? []
    : options.categoryFilter.size
      ? flexTx.filter((t) => hasAnyWeekCategory(t, options.categoryFilter))
      : flexTx.filter((t) => !hasAnyWeekCategory(t, options.excludedCategories));

  const cardSpend = spendOnly(retailReal).filter(isCardPayment);
  const allTransferSpend = spendOnly(retailReal).filter(
    (t) => !isCardPayment(t)
  );
  const nonSpendingTransferCategories = new Set([
    "income",
    "transfers",
    "savings",
  ]);
  const transferSpend = options.categoryFilter.size
    ? allTransferSpend
    : options.outgoingTransfers === "exclude"
      ? []
      : options.outgoingTransfers === "spending"
        ? allTransferSpend.filter(
            (t) => !hasAnyWeekCategory(t, nonSpendingTransferCategories)
          )
        : allTransferSpend;
  const flexSpend = spendOnly(flexReal);

  const cardDaily = bucketTotals(cardSpend, bucketStarts);
  const transferDaily = bucketTotals(transferSpend, bucketStarts);
  const flexDaily = bucketTotals(flexSpend, bucketStarts);
  const categorySpend = spendOnly([...retailReal, ...flexReal]);
  const billsDaily = bucketTotals(
    categorySpend
      .map((t) => ({ ...t, amount: amountForCategory(t, "bills") }))
      .filter((t) => t.amount !== 0),
    bucketStarts
  );
  const savingsDaily = bucketTotals(
    categorySpend
      .map((t) => ({ ...t, amount: amountForCategory(t, "savings") }))
      .filter((t) => t.amount !== 0),
    bucketStarts
  );
  // Built from the same transactions the card/transfer/flex totals use, so
  // the two breakdowns of a bar always add up to the same number.
  const categoryBuckets = bucketByCategory(
    [...cardSpend, ...transferSpend, ...flexSpend],
    bucketStarts
  );

  // Refunds and friends' repayments belong to the day of the original
  // purchase, not the day the money arrived — otherwise paying you back on
  // Friday makes Friday look cheap and leaves Tuesday overstated.
  const incomingForAdjustment = [...retailReal, ...flexReal].filter(
    (t) =>
      isMoneyBack(t) ||
      (options.unlinkedIncoming === "received" &&
        t.amount > 0 &&
        retailReal.some((retailTransaction) => retailTransaction.id === t.id))
  );
  const moneyBackOptions = {
    splitRepayments: options.splitRepayments,
    unlinkedIncoming: options.unlinkedIncoming,
    cardRefunds: options.cardRefunds,
  };
  applyMoneyBack(
    incomingForAdjustment,
    [
      { debits: cardSpend, daily: cardDaily },
      { debits: flexSpend, daily: flexDaily },
      { debits: transferSpend, daily: transferDaily },
    ],
    bucketStarts,
    moneyBackOptions
  );
  // The category totals are a separate view of the same money, so they need
  // the same adjustment applied over their own arrays.
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
    categories: categoryRows(categoryBuckets, bucketStarts.length),
  };
}

/**
 * One bar of a chart. Shared so the daily and weekly endpoints can never
 * drift apart over what a bar's total means.
 */
function spendingBucket(spending: Spending, options: SpendOptions, i: number) {
  return {
    card: spending.card[i],
    transfers: spending.transfers[i],
    flex: spending.flex[i],
    bills: spending.bills[i],
    savings: spending.savings[i],
    categories: spending.categories[i],
    total: options.categoryFilter.size
      ? spending.bills[i] + spending.savings[i]
      : spending.card[i] + spending.transfers[i] + spending.flex[i],
  };
}

function spendingResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function handleWeek(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (!authorised(request, url, env)) {
    return json({ error: "Unauthorised" }, 401);
  }

  const options = readSpendOptions(url);

  // `weeks=1` is the week before last, and so on, so several widgets can sit
  // in a stack and be swiped between.
  const weeksAgo = Math.min(
    52,
    Math.max(0, Number(url.searchParams.get("weeks")) || 0)
  );
  const reference = new Date(Date.now() - weeksAgo * DAYS * 24 * 60 * 60 * 1000);

  const dayStarts = options.useMonzoDay
    ? recentMonzoSpendDays(DAYS, reference)
    : recentSpendDays(DAYS, reference);

  const spending = await loadSpending(env, options, dayStarts, reference);
  if (!spending) return json({ error: NO_ACCOUNT }, 404);

  const days = dayStarts.map((start, i) => ({
    date: start.toISOString(),
    label: spendDayLabel(start),
    ...spendingBucket(spending, options, i),
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
    updatedAt: new Date().toISOString(),
  });
}

const DEFAULT_WEEK_COUNT = 4;
const MAX_WEEK_COUNT = 12;

/**
 * The same figures as /week, bucketed into whole rolling weeks instead of
 * days, so one widget can show a month at a glance.
 */
async function handleWeeks(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (!authorised(request, url, env)) {
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
  const reference = new Date();

  const weekStarts = options.useMonzoDay
    ? recentMonzoSpendWeeks(count, reference)
    : recentSpendWeeks(count, reference);

  const spending = await loadSpending(env, options, weekStarts, reference);
  if (!spending) return json({ error: NO_ACCOUNT }, 404);

  const weeks = weekStarts.map((start, i) => ({
    start: start.toISOString(),
    label: spendWeekLabel(start),
    latest: i === weekStarts.length - 1,
    ...spendingBucket(spending, options, i),
  }));

  return spendingResponse({
    currency: spending.currency,
    weeks,
    periodTotal: weeks.reduce((s, w) => s + w.total, 0),
    categoryTotals: totalByCategory(spending.categories),
    hasFlex: spending.hasFlex,
    balance: spending.balance,
    flexBalance: spending.flexBalance,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Reports what each account actually returns, so we can decide empirically
 * whether Flex data is usable rather than trusting its documentation. Returns
 * counts and totals only — never transaction detail or tokens.
 */
async function handleDiagnose(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (!authorised(request, url, env)) {
    return json({ error: "Unauthorised" }, 401);
  }

  const accounts = await listAccounts(env);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const report = [];
  for (const account of accounts) {
    const entry: Record<string, unknown> = {
      type: account.type,
      description: account.description,
    };

    try {
      const b = await getBalance(env, account.id);
      entry.balance = b.balance;
      entry.spendToday = b.spend_today;
    } catch (e) {
      entry.balanceError = (e as Error).message.slice(0, 120);
    }

    // Try several windows: if a wider `since` surfaces newer transactions,
    // the problem is our query, not Monzo's data.
    for (const windowDays of [7, 30, 89]) {
      const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
      try {
        const tx = await listTransactions(env, account.id, since);
        entry[`window${windowDays}d`] = {
          count: tx.length,
          newest: tx.length ? tx[tx.length - 1].created : null,
          recent: tx.slice(-5).map((t) => ({
            created: t.created,
            amount: t.amount,
            declined: Boolean(t.decline_reason),
            name: (t.merchant?.name ?? t.description ?? "").slice(0, 24),
          })),
        };
      } catch (e) {
        entry[`window${windowDays}d`] = {
          error: (e as Error).message.slice(0, 160),
        };
      }
    }

    report.push(entry);
  }

  // If flexing a purchase leaves a copy on the current account, summing the two
  // would double-count. Look for same-amount pairs close together in time.
  const retail = accounts.find((a) => a.type === "uk_retail");
  const flex = accounts.find((a) => a.type === "uk_monzo_flex");
  let overlap: unknown = "not checked";

  if (retail && flex) {
    const [retailTx, flexTx] = await Promise.all([
      listTransactions(env, retail.id, weekAgo),
      listTransactions(env, flex.id, weekAgo),
    ]);

    const WINDOW = 14 * 24 * 60 * 60 * 1000;
    const near = (a: Transaction, b: Transaction) =>
      Math.abs(Date.parse(a.created) - Date.parse(b.created)) < WINDOW;

    const flexPurchases = flexTx.filter((t) => t.amount < 0);

    // Same purchase appearing on both accounts.
    const duplicated = flexPurchases.filter((f) =>
      retailTx.some((r) => r.amount === f.amount && near(r, f))
    );

    // Flexing after the fact should credit the current account back. If that
    // credit exists, the retail side nets to zero and only Flex should count.
    const creditedBack = flexPurchases.filter((f) =>
      retailTx.some((r) => r.amount === -f.amount && near(r, f))
    );

    // Repayments move money current-account -> Flex. Counting those as
    // spending would charge the same purchase twice, once buying and once
    // paying it off.
    const flexRepayments = flexTx.filter((t) => t.amount > 0);
    const retailToFlex = retailTx.filter(
      (r) =>
        r.amount < 0 &&
        /flex/i.test(`${r.merchant?.name ?? ""} ${r.description ?? ""}`)
    );
    const incomingP2P = retailTx.filter(
      (t) =>
        t.amount > 0 &&
        (t.scheme === "p2p_payment" || t.scheme === "monzo_to_monzo")
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
      retailToFlexNames: retailToFlex
        .slice(0, 5)
        .map((r) => `${r.created.slice(0, 10)} ${r.amount} ${r.merchant?.name ?? r.description}`),
      splitRepayments: {
        incomingP2P: incomingP2P.length,
        withOriginalTransactionId: linkedSplits.length,
        originalInWindow: linkedSplits.filter((t) =>
          retailIds.has(t.metadata!.original_transaction_id!)
        ).length,
      },
      excludedAsTransfers:
        retailTx.filter((t) => t.amount < 0 && !t.decline_reason).length -
        spendOnly(withoutInternalTransfers(retailTx, flexTx)).length,
      // Scheme counts only — enough to spot a new payment type appearing
      // without exposing individual transactions.
      schemes: withoutInternalTransfers(retailTx, flexTx)
        .filter((t) => !t.decline_reason)
        .reduce<Record<string, number>>((counts, t) => {
          const key = `${t.scheme ?? "unknown"}:${t.amount < 0 ? "out" : "in"}`;
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {}),
    };
  }

  return json({ accounts: report, overlap });
}

async function handleSummary(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (!authorised(request, url, env)) {
    return json({ error: "Unauthorised" }, 401);
  }

  const accounts = await listAccounts(env);
  const main = pickAccount(accounts, url.searchParams.get("account"));
  if (!main) return json({ error: NO_ACCOUNT }, 404);

  const useMonzoDay = url.searchParams.get("dayStart") === "monzo";
  const since = useMonzoDay ? startOfSpendDay() : startOfCalendarDay();
  const [balance, transactions] = await Promise.all([
    getBalance(env, main.id),
    listTransactions(env, main.id, since),
  ]);

  // Flex is a separate account and its transaction feed is unreliable, so we
  // only surface its balance — and tolerate it being unavailable entirely.
  const flexAccount = accounts.find((a) => a.type === "uk_monzo_flex");
  let flex: { balance: number } | null = null;
  if (flexAccount) {
    try {
      const flexBalance = await getBalance(env, flexAccount.id);
      flex = { balance: flexBalance.balance };
    } catch {
      flex = null;
    }
  }

  // Declined, zero-value, and savings-pot movements are noise on a spending
  // widget. Use the same UK calendar-day window as the weekly widgets.
  const spending = transactions
    .filter(
      (t) =>
        !t.decline_reason &&
        t.amount !== 0 &&
        !(t.description ?? "").startsWith("pot_")
    )
    .map((t) => ({
      id: t.id,
      created: t.created,
      amount: t.amount,
      name: t.merchant?.name ?? t.description,
      category: t.merchant?.category ?? null,
    }))
    .sort((a, b) => b.created.localeCompare(a.created));

  return new Response(
    JSON.stringify({
      currency: balance.currency,
      // All amounts are in minor units (pennies), as Monzo returns them.
      spentToday: useMonzoDay
        ? balance.spend_today
        : spending
            .filter((t) => t.amount < 0)
            .reduce((sum, t) => sum + t.amount, 0),
      balance: balance.balance,
      totalBalance: balance.total_balance,
      flex,
      transactions: spending,
      since: since.toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}
