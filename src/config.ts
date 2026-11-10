import type { PriceBasis } from "./types.ts";

export const ALGORITHM_VERSION = "1.0.0";

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
   * Host fees as whole percents. A host who sends their Airbnb price is listed at the price that
   * nets them the same: price × (100 − airbnb) ÷ (100 − marketScope).
   */
  readonly hostFeePct: { readonly marketScope: number; readonly airbnb: number };
};

export const DEFAULT_CONFIG: Config = Object.freeze({
  version: "2026-11-10.1",
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
  hostFeePct: { marketScope: 8, airbnb: 15 },
});

/** The price that leaves the host the same take-home at Market Scope's fee as at Airbnb's. Half-up to whole cents. */
export const fromAirbnbPrice = (cents: number, cfg: Config = DEFAULT_CONFIG): number =>
  Math.round((cents * (100 - cfg.hostFeePct.airbnb)) / (100 - cfg.hostFeePct.marketScope));
