/**
 * Turning a list of transactions into the bars of a chart.
 *
 * A "bucket" is one bar. The weekly charts use a bucket per day and the
 * four-week chart uses a bucket per rolling week, but the arithmetic is the
 * same either way — only the boundaries handed in differ.
 */

import type { Transaction } from "./monzo.js";
import type { SpendBucket } from "./money-back.js";

/** Which bucket a timestamp falls in, or -1 if it predates them all. */
export function bucketIndex(created: string, bucketStarts: Date[]): number {
  const at = Date.parse(created);
  // Walk backwards to find the newest boundary at or before this transaction.
  for (let i = bucketStarts.length - 1; i >= 0; i--) {
    if (at >= bucketStarts[i].getTime()) return i;
  }
  return -1;
}

/** Totals per bucket, oldest first. Amounts stay signed, as Monzo sends. */
export function bucketTotals(
  transactions: Transaction[],
  bucketStarts: Date[]
): number[] {
  const totals = new Array(bucketStarts.length).fill(0);

  for (const tx of transactions) {
    const i = bucketIndex(tx.created, bucketStarts);
    if (i >= 0) totals[i] += tx.amount;
  }

  return totals;
}

/**
 * How one transaction divides across Monzo's categories, as `[name, amount]`
 * pairs that always sum back to the transaction's own amount.
 *
 * Newer transactions carry a `categories` map because Monzo lets a single
 * payment be split across several categories. Older ones only have the single
 * `category` field, and a few have neither — Monzo files those under
 * "general", so we do too rather than inventing an "uncategorised" bucket the
 * app never shows.
 */
export function categoryShares(t: Transaction): [string, number][] {
  const split = Object.entries(t.categories ?? {});
  if (split.length > 0) {
    return split.map(([name, amount]) => [name.toLowerCase(), amount]);
  }

  const name = (t.category ?? t.merchant?.category ?? "general").toLowerCase();
  return [[name, t.amount]];
}

/** Amount assigned to one Monzo category, respecting split transactions. */
export function amountForCategory(t: Transaction, category: string): number {
  return categoryShares(t)
    .filter(([name]) => name === category)
    .reduce((sum, [, amount]) => sum + amount, 0);
}

/**
 * The same per-bucket totals, but split by Monzo category and shaped so
 * `applyMoneyBack` can adjust them exactly as it adjusts card/transfer/flex —
 * a refund lands back on the category of the purchase it reverses.
 *
 * Buckets come back biggest-spending first, which is also the order refunds
 * with no matching purchase are absorbed in.
 */
export function bucketByCategory(
  transactions: Transaction[],
  bucketStarts: Date[]
): [string, SpendBucket][] {
  const buckets = new Map<string, SpendBucket>();

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

  const total = (bucket: SpendBucket) =>
    bucket.daily.reduce((sum, amount) => sum + amount, 0);

  // Spending is negative, so ascending order puts the biggest spend first.
  return [...buckets].sort(([, a], [, b]) => total(a) - total(b));
}

/** Per-bucket category totals as plain objects, dropping empty categories. */
export function categoryRows(
  buckets: [string, SpendBucket][],
  bucketCount: number
): Record<string, number>[] {
  return Array.from({ length: bucketCount }, (_, i) => {
    const row: Record<string, number> = {};
    for (const [category, bucket] of buckets) {
      if (bucket.daily[i] !== 0) row[category] = bucket.daily[i];
    }
    return row;
  });
}

/** Whole-period totals per category, for ranking and the widget legends. */
export function totalByCategory(
  rows: Record<string, number>[]
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    for (const [category, amount] of Object.entries(row)) {
      totals[category] = (totals[category] ?? 0) + amount;
    }
  }
  return totals;
}
