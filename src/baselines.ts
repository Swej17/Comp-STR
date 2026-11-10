import { DEFAULT_CONFIG, type Config } from "./config.ts";
import { DAY_MS } from "./dates.ts";
import type { Baseline, BaselineIndex, BaselineObservation, Confidence, PriceBasis, PropertyClass } from "./types.ts";

const LEVELS: readonly Confidence[] = ["low", "medium", "high"];
export const confRank = (c: Confidence): number => LEVELS.indexOf(c);
export const minConfidence = (cs: Confidence[]): Confidence =>
  cs.reduce((a, b) => (confRank(a) <= confRank(b) ? a : b));
const downgrade = (c: Confidence): Confidence => LEVELS[Math.max(0, confRank(c) - 1)]!;

const classKey = (pc: PropertyClass) => `${pc.market}|${pc.propertyType}|${pc.bedrooms}`;
export const baselineKey = (pc: PropertyClass, month: number, basis: PriceBasis) => `${classKey(pc)}|${month}|${basis}`;
export const peakKey = (pc: PropertyClass, basis: PriceBasis) => `${classKey(pc)}|${basis}`;

const BASES: readonly PriceBasis[] = ["nightly_rate", "nightly_incl_mandatory_fees"];

// Bad rows are dropped, never coerced: a missing price is unknown, not zero.
function isValid(o: BaselineObservation): boolean {
  const pc = o.propertyClass;
  return (
    o.currency === "USD" &&
    Number.isSafeInteger(o.nightlyPriceCents) && o.nightlyPriceCents > 0 &&
    Number.isInteger(o.month) && o.month >= 1 && o.month <= 12 &&
    BASES.includes(o.priceBasis) &&
    LEVELS.includes(o.confidence) &&
    typeof o.source === "string" && o.source !== "" &&
    !Number.isNaN(Date.parse(o.observedAt)) &&
    typeof pc?.market === "string" && pc.propertyType === "entire_home" &&
    Number.isInteger(pc.bedrooms) && pc.bedrooms >= 0
  );
}

/** Linear-interpolation quantile (same as Excel QUARTILE.INC / R type 7). `sorted` must be ascending. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = sorted[Math.floor(pos)]!;
  const hi = sorted[Math.ceil(pos)]!;
  return lo + (hi - lo) * (pos - Math.floor(pos));
}

function summarize(
  obs: BaselineObservation[], pc: PropertyClass, month: number, priceBasis: PriceBasis,
  nowMs: number, cfg: Config, fallback: boolean,
): Baseline | undefined {
  if (obs.length < cfg.minSampleSize) return undefined;
  const prices = obs.map((o) => o.nightlyPriceCents).sort((a, b) => a - b);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const fence = cfg.iqrMultiplier * (q3 - q1);
  const kept = obs.filter((o) => o.nightlyPriceCents >= q1 - fence && o.nightlyPriceCents <= q3 + fence);
  if (kept.length < cfg.minSampleSize) return undefined;

  const k = kept.map((o) => o.nightlyPriceCents).sort((a, b) => a - b);
  const mid = k.length >> 1;
  const medianCents = k.length % 2 ? k[mid]! : (k[mid - 1]! + k[mid]!) / 2;

  const dates = kept.map((o) => o.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  const oldest = dates[0]!;
  const sampleConf: Confidence =
    kept.length >= cfg.sampleConfidence.high ? "high" : kept.length >= cfg.sampleConfidence.medium ? "medium" : "low";
  let confidence = minConfidence([sampleConf, ...kept.map((o) => o.confidence)]);
  if (nowMs - Date.parse(oldest) > cfg.maxBaselineAgeDays * DAY_MS) confidence = downgrade(confidence);
  if (fallback) confidence = downgrade(confidence);

  return {
    propertyClass: pc, month, priceBasis, medianCents,
    sampleSize: kept.length,
    sources: [...new Set(kept.map((o) => o.source))].sort(),
    oldestObservedAt: oldest,
    newestObservedAt: dates.at(-1)!,
    confidence,
    ...(fallback ? { fallback: "adjacent_bedrooms" as const } : {}),
  };
}

/**
 * Build every monthly baseline the observations support, per (class, month, price basis).
 * Falls back to pooled bedrooms ±1 in the same market, type, month and basis — never further.
 */
export function buildBaselines(
  observations: BaselineObservation[], now: string, cfg: Config = DEFAULT_CONFIG,
): BaselineIndex {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new Error("now must be an ISO date or timestamp");

  const groups = new Map<string, BaselineObservation[]>();
  const classes = new Map<string, PropertyClass>(); // observed classes and their ±1 bedroom neighbours
  for (const o of observations) {
    if (!isValid(o)) continue;
    const key = baselineKey(o.propertyClass, o.month, o.priceBasis);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
    const { market, propertyType, bedrooms } = o.propertyClass;
    for (const b of [bedrooms - 1, bedrooms, bedrooms + 1]) {
      if (b >= 0) classes.set(classKey({ market, propertyType, bedrooms: b }), { market, propertyType, bedrooms: b });
    }
  }

  const baselines = new Map<string, Baseline>();
  const peaks = new Map<string, Baseline>();
  for (const pc of classes.values()) {
    for (const basis of BASES) {
      for (let month = 1; month <= 12; month++) {
        const at = (bedrooms: number) => groups.get(baselineKey({ ...pc, bedrooms }, month, basis)) ?? [];
        const b =
          summarize(at(pc.bedrooms), pc, month, basis, nowMs, cfg, false) ??
          summarize([...at(pc.bedrooms - 1), ...at(pc.bedrooms), ...at(pc.bedrooms + 1)], pc, month, basis, nowMs, cfg, true);
        if (!b) continue;
        baselines.set(baselineKey(pc, month, basis), b);
        const pk = peakKey(pc, basis);
        if (b.medianCents > (peaks.get(pk)?.medianCents ?? -1)) peaks.set(pk, b); // ties keep the earlier month
      }
    }
  }
  return { baselines, peaks };
}
