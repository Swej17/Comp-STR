// Synthetic data only: fake markets, fake listings, example.com URLs.
import { stayNights } from "../src/index.ts";
import type { BaselineObservation, HostOffer, PropertyClass, SearchQuery } from "../src/index.ts";

export const NOW = "2026-11-09T12:00:00Z";
export const LAKE = "fake-pine-lake";
export const RIDGE = "fake-ridge-valley";
export const LAKE_NAME = "Pine Lake";

export const cls = (market = LAKE, bedrooms = 3): PropertyClass => ({ market, propertyType: "entire_home", bedrooms });

export const flat = (cents: number, n = 60): number[] => Array<number>(n).fill(cents);

export function obs(
  pc: PropertyClass, month: number, prices: number[], over: Partial<BaselineObservation> = {},
): BaselineObservation[] {
  return prices.map((p) => ({
    propertyClass: pc, month, nightlyPriceCents: p, currency: "USD", priceBasis: "nightly_rate",
    source: "synthetic-survey-a", observedAt: "2026-06-01", confidence: "high", ...over,
  }));
}

export function rates(from: string, to: string, cents: number): Record<string, number> {
  return Object.fromEntries(stayNights(from, to, 10_000)!.map((d) => [d, cents]));
}

export function offer(over: Partial<HostOffer> = {}): HostOffer {
  const id = over.listingId ?? "L-001";
  return {
    listingId: id,
    hostId: `H-${id}`,
    propertyClass: cls(),
    maxGuests: 8,
    petsAllowed: true,
    amenities: { hot_tub: true, wifi: true, fireplace: null },
    availableFrom: "2026-11-01",
    availableTo: "2027-12-31",
    nightlyRatesCents: rates("2026-11-01", "2027-12-31", 15_000),
    mandatoryFeesCents: 12_000,
    currency: "USD",
    minNights: 2,
    maxNights: 14,
    bookingUrl: `https://example.com/book/${id}`,
    optedInAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
    expiresAt: "2027-01-31T00:00:00Z",
    ...over,
  };
}

export const query = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  market: LAKE, checkIn: "2027-03-10", checkOut: "2027-03-13", guests: 4, now: NOW, ...over,
});

// Clear summer peak (July), low March. Index 0 = January.
export const SEASON = [0.6, 0.6, 0.5, 0.55, 0.7, 0.95, 1.0, 0.97, 0.75, 0.7, 0.6, 0.75];

function seeded(seed: number): () => number { // mulberry32, deterministic
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 12 months × 1–4 bedrooms × 2 markets × 40 observations. Pine Lake on nightly_rate, Ridge Valley fee-inclusive. */
export function syntheticObservations(): BaselineObservation[] {
  const rand = seeded(42);
  const out: BaselineObservation[] = [];
  const markets = [[LAKE, 1, "nightly_rate"], [RIDGE, 0.85, "nightly_incl_mandatory_fees"]] as const;
  for (const [market, factor, priceBasis] of markets) {
    for (let bedrooms = 1; bedrooms <= 4; bedrooms++) {
      for (let month = 1; month <= 12; month++) {
        for (let i = 0; i < 40; i++) {
          const cents = Math.round((12_000 + 8_000 * bedrooms) * SEASON[month - 1]! * factor * (0.85 + 0.3 * rand()));
          out.push(...obs(cls(market, bedrooms), month, [cents], {
            priceBasis, source: i % 2 ? "synthetic-survey-a" : "synthetic-vendor-b",
            observedAt: `2026-0${1 + (i % 9)}-15`,
          }));
        }
      }
    }
  }
  out.push(...obs(cls(LAKE, 3), 3, [1, 9_999_999])); // data-entry junk the trimming must drop
  return out;
}

/** A handful of Pine Lake hosts for March. 3-bedroom March baseline is about $180/night. */
export const HOST_OFFERS: HostOffer[] = [
  offer({ listingId: "PL-01", nightlyRatesCents: rates("2026-11-01", "2027-12-31", 12_500) }),
  offer({ listingId: "PL-02", nightlyRatesCents: rates("2026-11-01", "2027-12-31", 15_000) }),
  offer({ listingId: "PL-03", nightlyRatesCents: rates("2026-11-01", "2027-12-31", 19_500) }),
  offer({ listingId: "PL-04", propertyClass: cls(LAKE, 2), petsAllowed: null, nightlyRatesCents: rates("2026-11-01", "2027-12-31", 11_000) }),
  offer({ listingId: "PL-05", propertyClass: cls(LAKE, 4), nightlyRatesCents: rates("2026-11-01", "2027-12-31", 21_000) }),
  offer({ listingId: "PL-06", optedInAt: null }),
];
