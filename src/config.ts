import type { Platform, PriceBasis } from "./types.ts";

export const ALGORITHM_VERSION = "1.1.0";

export type Config = {
  readonly version: string;
  /** Minimum observations (after outlier trimming) for a monthly baseline. */
  readonly minSampleSize: number;
  /** Trimmed sample size at or above `high` → high confidence, at or above `medium` → medium, else low. */
  readonly sampleConfidence: { readonly high: number; readonly medium: number };
  /** If the oldest observation used is older than this, confidence drops one step. */
  readonly maxBaselineAgeDays: number;
  /** Outlier fences: [Q1 − k·IQR, Q3 + k·IQR]. */
  readonly iqrMultiplier: number;
  /** Whole percents. Tier is decided with integer math so boundaries are exact. */
  readonly tierPct: { readonly great: number; readonly good: number };
  /** A discount strictly above this (whole percent) is flagged needs_review. */
  readonly needsReviewAbovePct: number;
  /** Only mention the off-season context when it is at least this many percent. */
  readonly minOffSeasonPctToMention: number;
  /** Bases to try, in order. A stay uses the first basis that covers every night; bases never mix. */
  readonly priceBasisPreference: readonly PriceBasis[];
  readonly maxOfferAgeDays: number;
  /** Hard cap on stay length; longer searches are rejected (open question: monthly stays). */
  readonly maxStayNights: number;
  readonly pageSize: { readonly default: number; readonly max: number };
  /**
   * Host fees in percent, charged on nightly rate + cleaning/mandatory fees (not taxes) on every platform.
   * Reference figures: Triad Vacation Rentals fee breakdown, updated 2026-10-16. Airbnb host-only
   * fee; Vrbo's single commission for bookings from 2026-10-29 (includes payment processing);
   * Booking.com's typical US commission (contracts range 10–25%, plus 1.1–3.1% if using its payments).
   */
  readonly hostFeePct: { readonly marketScope: number } & { readonly [P in Platform]: number };
  /** Our price is always at least this many percent under the platform price, whatever the fees. */
  readonly minUnderMarketPct: number;
};

export const DEFAULT_CONFIG: Config = Object.freeze({
  version: "2026-11-10.3",
  minSampleSize: 20,
  sampleConfidence: { high: 50, medium: 30 },
  maxBaselineAgeDays: 400,
  iqrMultiplier: 1.5,
  tierPct: { great: 25, good: 15 },
  needsReviewAbovePct: 60,
  minOffSeasonPctToMention: 10,
  priceBasisPreference: ["nightly_incl_mandatory_fees", "nightly_rate"] as PriceBasis[],
  maxOfferAgeDays: 14,
  maxStayNights: 90,
  pageSize: { default: 20, max: 50 },
  hostFeePct: { marketScope: 8, airbnb: 15.5, vrbo: 12, booking_com: 15 },
  minUnderMarketPct: 1,
});

/**
 * Market Scope's price for a price the host charges on `platform`: the price that leaves the host
 * the same take-home at our fee, capped so it is always at least `minUnderMarketPct` under the
 * platform price. Half-up to whole cents. E.g. $150 on Airbnb → $150 × 84.5 ÷ 92 = $137.77.
 */
export function fromPlatformPrice(cents: number, platform: Platform, cfg: Config = DEFAULT_CONFIG): number {
  const hostNeutral = (cents * (100 - cfg.hostFeePct[platform])) / (100 - cfg.hostFeePct.marketScope);
  const ceiling = (cents * (100 - cfg.minUnderMarketPct)) / 100;
  return Math.round(Math.min(hostNeutral, ceiling));
}
