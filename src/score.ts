import { baselineKey, minConfidence, peakKey } from "./baselines.ts";
import { ALGORITHM_VERSION, DEFAULT_CONFIG, type Config } from "./config.ts";
import { monthOf } from "./dates.ts";
import type { Baseline, BaselineIndex, DealResult, HostOffer, PriceBasis, Tier } from "./types.ts";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

export const NO_DATA = "Not enough local price data to compare yet";
export const TAXES = "Taxes may apply";

const dollars = (c: number) => `$${Math.floor(c / 100).toLocaleString("en-US")}.${String(c % 100).padStart(2, "0")}`;

/**
 * Score one stay on one offer. `nights` must come from checkEligibility (every night has an
 * integer rate). Money stays in integer cents; the only rounding is on the baseline total.
 */
export function scoreStay(
  offer: HostOffer, nights: string[], index: BaselineIndex, marketName: string, cfg: Config = DEFAULT_CONFIG,
): DealResult {
  const nightlyCents = nights.reduce((s, d) => s + offer.nightlyRatesCents[d]!, 0);
  const feesCents = offer.mandatoryFeesCents;
  const offerTotalCents = nightlyCents + feesCents;
  const base = {
    listingId: offer.listingId, bookingUrl: offer.bookingUrl, currency: offer.currency,
    nights: nights.length, offerTotalCents, feesCents,
    algorithmVersion: ALGORITHM_VERSION, configVersion: cfg.version,
  };

  // First basis whose baselines cover every night. Bases are never mixed within a stay.
  let basis: PriceBasis | undefined;
  let used: Baseline[] = [];
  for (const b of cfg.priceBasisPreference) {
    const found = nights.map((d) => index.baselines.get(baselineKey(offer.propertyClass, monthOf(d), b)));
    if (found.every((x) => x !== undefined)) { basis = b; used = found; break; }
  }
  if (!basis) {
    return {
      ...base, baselineTotalCents: null, dealPct: null, tier: "no_score", offSeasonPct: null,
      confidence: null, reasons: [NO_DATA, TAXES], baselineMeta: null,
    };
  }

  const exactBaseline = used.reduce((s, b) => s + b.medianCents, 0);
  const baselineTotalCents = Math.floor(exactBaseline + 0.5); // the single rounding: half-up to whole cents
  const comparable = basis === "nightly_rate" ? nightlyCents : offerTotalCents;
  const diff100 = (baselineTotalCents - comparable) * 100; // integer; compare against baseline × whole percent
  const tier: Tier =
    diff100 > baselineTotalCents * cfg.needsReviewAbovePct ? "needs_review"
    : diff100 >= baselineTotalCents * cfg.tierPct.great ? "great"
    : diff100 >= baselineTotalCents * cfg.tierPct.good ? "good"
    : "none";

  const distinct = [...new Set(used)];
  const peak = index.peaks.get(peakKey(offer.propertyClass, basis));
  const offSeasonPct = peak ? 1 - exactBaseline / nights.length / peak.medianCents : null;
  const fallback = distinct.some((b) => b.fallback);
  const confidence = minConfidence(distinct.map((b) => b.confidence));

  // Plain-language reasons for travelers.
  const months = [...new Set(nights.map(monthOf))];
  const single = months.length === 1 ? MONTHS[months[0]! - 1] : undefined;
  const homes = offer.propertyClass.bedrooms === 0 ? "studios" : `${offer.propertyClass.bedrooms}-bedroom homes`;
  const typical = single ? `typical ${single} prices for ${homes} in ${marketName}` : `typical prices for ${homes} in ${marketName} on these dates`;
  const reasons: string[] = [];
  if (tier === "needs_review") {
    reasons.push("We are double-checking how this price compares with local data");
  } else if (tier === "great" || tier === "good") {
    reasons.push(`${Math.floor(diff100 / baselineTotalCents)}% below ${typical}`);
  } else {
    const above = Math.round(-diff100 / baselineTotalCents);
    reasons.push(above >= 1 ? `${above}% above ${typical}` : `About in line with ${typical}`);
  }
  if (tier !== "needs_review" && offSeasonPct !== null && peak && !months.includes(peak.month)) {
    const pct = Math.floor(offSeasonPct * 100 + 1e-9);
    if (pct >= cfg.minOffSeasonPctToMention) {
      reasons.push(`Prices here are usually ${pct}% lower ${single ? `in ${single}` : "on these dates"} than in ${MONTHS[peak.month - 1]}`);
    }
  }
  if (fallback) reasons.push(`Typical price estimated from similar-size homes in ${marketName}`);
  if (confidence === "low") reasons.push("Limited local data, so treat this comparison as a rough guide");
  if (basis === "nightly_rate" && feesCents > 0) {
    reasons.push(`Compared on nightly rates; the total also includes ${dollars(feesCents)} in mandatory fees`);
  }
  reasons.push(TAXES);

  return {
    ...base,
    baselineTotalCents,
    dealPct: tier === "needs_review" ? null : 1 - comparable / baselineTotalCents,
    tier, offSeasonPct, confidence, reasons,
    baselineMeta: {
      sampleSize: distinct.reduce((s, b) => s + b.sampleSize, 0),
      sources: [...new Set(distinct.flatMap((b) => b.sources))].sort(),
      dataThrough: distinct.map((b) => b.newestObservedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!,
      priceBasis: basis,
      ...(fallback ? { fallback: "adjacent_bedrooms" } : {}),
    },
  };
}
