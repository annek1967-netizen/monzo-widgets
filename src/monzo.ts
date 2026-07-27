/**
 * Monzo API client.
 *
 * The only genuinely tricky part is token handling: Monzo access tokens last
 * ~6 hours, and every refresh returns a NEW refresh token that invalidates the
 * old one. So the new one must be persisted immediately or the whole setup
 * locks itself out and needs re-authenticating by hand.
 */

const API = "https://api.monzo.com";

export interface Env {
  MONZO: KVNamespace;
  MONZO_CLIENT_ID: string;
  MONZO_CLIENT_SECRET: string;
  WIDGET_KEY: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/**
 * Return a usable access token, refreshing if the cached one has expired.
 * The refreshed token is written back to KV before it's used, so a crash
 * mid-request can't lose it.
 */
export async function getAccessToken(env: Env): Promise<string> {
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
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Token refresh failed (${res.status}). You may need to re-authenticate: ${await res.text()}`
    );
  }

  const token = (await res.json()) as TokenResponse;

  // Persist the rotated refresh token first — losing it is unrecoverable.
  if (token.refresh_token) {
    await env.MONZO.put("refresh_token", token.refresh_token);
  }

  // Expire our cache a minute early to avoid racing Monzo's own expiry.
  await env.MONZO.put("access_token", token.access_token, {
    expirationTtl: Math.max(60, token.expires_in - 60),
  });

  return token.access_token;
}

async function api<T>(env: Env, path: string): Promise<T> {
  const token = await getAccessToken(env);
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Monzo ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export interface Account {
  id: string;
  type: string;
  description: string;
  closed?: boolean;
}

export interface Balance {
  balance: number;
  total_balance: number;
  spend_today: number;
  currency: string;
}

export interface Pot {
  id: string;
  name: string;
  balance: number;
  currency: string;
  deleted: boolean;
}

export interface Transaction {
  id: string;
  created: string;
  amount: number;
  currency: string;
  description: string;
  notes?: string;
  decline_reason?: string;
  /** e.g. "mastercard" for card payments, "p2p_payment" for sending money. */
  scheme?: string;
  /** Monzo's own category, e.g. "eating_out". Present without a merchant. */
  category?: string;
  /** Newer split-category form: category name -> amount in minor units. */
  categories?: Record<string, number>;
  /** Monzo links bill-split repayments to the purchase through this metadata. */
  metadata?: {
    original_transaction_id?: string;
    tab_id?: string;
    [key: string]: string | undefined;
  };
  counterparty?: { name?: string; user_id?: string } | null;
  merchant?: { name?: string; logo?: string; category?: string } | null;
}

export async function listAccounts(env: Env): Promise<Account[]> {
  const { accounts } = await api<{ accounts: Account[] }>(env, "/accounts");
  return accounts.filter((a) => !a.closed);
}

export async function getBalance(env: Env, accountId: string): Promise<Balance> {
  return api<Balance>(env, `/balance?account_id=${accountId}`);
}

export async function listPots(env: Env, accountId: string): Promise<Pot[]> {
  const { pots } = await api<{ pots: Pot[] }>(
    env,
    `/pots?current_account_id=${accountId}`
  );
  return pots.filter((pot) => !pot.deleted);
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * All transactions since `since`, oldest first.
 *
 * Monzo pages this endpoint and defaults to 30 per response, returning the
 * OLDEST matching transactions first. Without following the pages, a busy
 * week silently stops partway through and recent days look empty.
 */
export async function listTransactions(
  env: Env,
  accountId: string,
  since: Date
): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      account_id: accountId,
      "expand[]": "merchant",
      limit: String(PAGE_SIZE),
      // `since` takes either a timestamp or a transaction id; the id form is
      // what lets us walk forward through the pages.
      since: cursor ?? since.toISOString(),
    });

    const { transactions } = await api<{ transactions: Transaction[] }>(
      env,
      `/transactions?${params}`
    );

    all.push(...transactions);
    if (transactions.length < PAGE_SIZE) break;
    cursor = transactions[transactions.length - 1].id;
  }

  return all;
}

/** Short weekday label ("Mon") for a spend day, in UK time. */
export function spendDayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
  }).format(date);
}

/**
 * The last `count` UK calendar-day boundaries, oldest first. Each is recomputed
 * rather than stepping back a fixed 24 hours, so a clock change doesn't shift
 * every earlier day by an hour.
 */
export function recentSpendDays(count: number, now = new Date()): Date[] {
  const days: Date[] = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(
      startOfCalendarDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1000))
    );
  }
  return days;
}

/** The last `count` Monzo 04:00 spend-day boundaries, oldest first. */
export function recentMonzoSpendDays(count: number, now = new Date()): Date[] {
  const days: Date[] = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(
      startOfSpendDay(new Date(now.getTime() - i * 24 * 60 * 60 * 1000))
    );
  }
  return days;
}

/**
 * The starts of the last `count` rolling seven-day blocks, oldest first.
 *
 * Blocks are counted back from today rather than snapped to Mondays, so the
 * final one covers exactly the same "last 7 days" the weekly chart shows and
 * the two widgets never disagree about this week's total.
 */
function weekStarts(
  count: number,
  now: Date,
  startOf: (date: Date) => Date
): Date[] {
  const weeks: Date[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const daysBack = i * 7 + 6;
    weeks.push(startOf(new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)));
  }
  return weeks;
}

/** The last `count` seven-day blocks on UK calendar days, oldest first. */
export function recentSpendWeeks(count: number, now = new Date()): Date[] {
  return weekStarts(count, now, startOfCalendarDay);
}

/** The last `count` seven-day blocks on Monzo 04:00 days, oldest first. */
export function recentMonzoSpendWeeks(count: number, now = new Date()): Date[] {
  return weekStarts(count, now, startOfSpendDay);
}

/**
 * A rolling week is named by the day it ends on ("6 Jul"), since it has no
 * week-commencing Monday to point at.
 */
export function spendWeekLabel(start: Date): string {
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
  }).format(end);
}

/** Midnight at the start of the current Europe/London calendar day. */
export function startOfCalendarDay(now = new Date()): Date {
  const asUTC = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const asLondon = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/London" })
  );
  const offset = asLondon.getTime() - asUTC.getTime();

  const shifted = new Date(now.getTime() + offset);
  shifted.setUTCHours(0, 0, 0, 0);

  let start = new Date(shifted.getTime() - offset);
  if (start > now) start = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  return start;
}

/**
 * Start of Monzo's "spend day", which begins around 04:00 UK time rather than
 * midnight. Matching it keeps our transaction list consistent with the
 * `spend_today` figure Monzo reports.
 */
export function startOfSpendDay(now = new Date()): Date {
  const asUTC = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const asLondon = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/London" })
  );
  const offset = asLondon.getTime() - asUTC.getTime();

  const shifted = new Date(now.getTime() + offset);
  shifted.setUTCHours(4, 0, 0, 0);

  let start = new Date(shifted.getTime() - offset);
  if (start > now) start = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  return start;
}
