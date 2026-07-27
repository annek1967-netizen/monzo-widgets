import type { Transaction } from "./monzo.js";

export type SpendBucket = {
  debits: Transaction[];
  daily: number[];
};

export type MoneyBackOptions = {
  splitRepayments: "original" | "ignore";
  unlinkedIncoming: "ignore" | "received";
  cardRefunds: "original" | "received" | "ignore";
};

const DEFAULT_OPTIONS: MoneyBackOptions = {
  splitRepayments: "original",
  unlinkedIncoming: "ignore",
  cardRefunds: "original",
};

export function isCardPayment(t: Transaction): boolean {
  return t.scheme === "mastercard";
}

/** Which spend-day a timestamp falls in, or -1 if outside the window. */
function dayIndex(created: string, dayStarts: Date[]): number {
  const at = Date.parse(created);
  for (let i = dayStarts.length - 1; i >= 0; i--) {
    if (at >= dayStarts[i].getTime()) return i;
  }
  return -1;
}

/** Reduces a day's totals without ever turning spending into income. */
function creditDay(
  buckets: SpendBucket[],
  dayIdx: number,
  amount: number
): void {
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

/**
 * Credits refunds and linked bill-split repayments against the day the
 * original purchase happened, falling back to the day a card refund arrived.
 *
 * Monzo identifies a bill-split repayment with
 * `metadata.original_transaction_id`. Unlinked P2P money is deliberately
 * ignored because it could be unrelated income. Card refunds do not carry
 * that split link, so they continue to match by merchant and amount.
 */
export function applyMoneyBack(
  credits: Transaction[],
  buckets: SpendBucket[],
  dayStarts: Date[],
  requestedOptions: Partial<MoneyBackOptions> = {}
): void {
  const options = { ...DEFAULT_OPTIONS, ...requestedOptions };

  for (const credit of credits) {
    const isP2P =
      credit.scheme === "p2p_payment" ||
      credit.scheme === "monzo_to_monzo";

    if (isP2P) {
      const originalId = credit.metadata?.original_transaction_id;
      if (originalId && options.splitRepayments === "ignore") continue;

      const original = originalId
        ? buckets
            .flatMap((bucket) =>
              bucket.debits.map((debit) => ({ bucket, debit }))
            )
            .find(({ debit }) => debit.id === originalId)
        : undefined;

      if (original) {
        const i = dayIndex(original.debit.created, dayStarts);
        if (i >= 0) {
          original.bucket.daily[i] = Math.min(
            0,
            original.bucket.daily[i] + credit.amount
          );
        }
      }

      if (!originalId && options.unlinkedIncoming === "received") {
        const i = dayIndex(credit.created, dayStarts);
        if (i >= 0) creditDay(buckets, i, credit.amount);
      }

      // Never guess for an unlinked payment unless explicitly requested.
      continue;
    }

    if (!isCardPayment(credit)) {
      if (options.unlinkedIncoming === "received") {
        const i = dayIndex(credit.created, dayStarts);
        if (i >= 0) creditDay(buckets, i, credit.amount);
      }
      continue;
    }

    if (options.cardRefunds === "ignore") continue;
    if (options.cardRefunds === "received") {
      const i = dayIndex(credit.created, dayStarts);
      if (i >= 0) creditDay(buckets, i, credit.amount);
      continue;
    }

    const name = credit.merchant?.name;
    const candidates = name
      ? buckets.flatMap((bucket) =>
          bucket.debits
            .filter(
              (d) =>
                d.merchant?.name === name &&
                Date.parse(d.created) <= Date.parse(credit.created)
            )
            .map((d) => ({ bucket, debit: d }))
        )
      : [];

    if (candidates.length > 0) {
      const exact = candidates.filter((c) => -c.debit.amount === credit.amount);
      const pool = exact.length ? exact : candidates;
      const best = pool.reduce((a, b) =>
        Date.parse(a.debit.created) >= Date.parse(b.debit.created) ? a : b
      );

      const i = dayIndex(best.debit.created, dayStarts);
      if (i >= 0) {
        best.bucket.daily[i] = Math.min(
          0,
          best.bucket.daily[i] + credit.amount
        );
        continue;
      }
    }

    // Card refunds without a merchant match reduce spending on their arrival
    // day. P2P repayments have already been handled by their explicit link.
    if (!isCardPayment(credit)) continue;

    const i = dayIndex(credit.created, dayStarts);
    if (i >= 0) creditDay(buckets, i, credit.amount);
  }
}
