export type Currency = "USD";
export type Confidence = "high" | "medium" | "low";
export type PropertyType = "entire_home"; // v1 supports whole homes only
export type PriceBasis = "nightly_rate" | "nightly_incl_mandatory_fees";
export type SortOrder = "best_deal" | "price_asc" | "price_desc";
export type Tier = "great" | "good" | "none" | "needs_review" | "no_score";

export type PropertyClass = {
  market: string; // e.g. "poconos-lake-harmony"
  propertyType: PropertyType;
  bedrooms: number; // 0 = studio
};

export type BaselineObservation = {
  propertyClass: PropertyClass;
  month: number; // 1–12, the month the night falls in
  nightlyPriceCents: number; // integer cents
  currency: Currency;
  priceBasis: PriceBasis;
  source: string; // e.g. "inside-airbnb-2026-q2"
  observedAt: string; // ISO date
  confidence: Confidence;
};

export type HostOffer = {
  listingId: string;
  hostId: string;
  propertyClass: PropertyClass;
  maxGuests: number;
  petsAllowed: boolean | null; // null = unknown
  amenities: Record<string, boolean | null>; // null = unknown
  availableFrom: string; // first available night, YYYY-MM-DD
  availableTo: string; // exclusive end, YYYY-MM-DD
  nightlyRatesCents: Record<string, number>; // date -> integer cents
  mandatoryFeesCents: number; // cleaning etc., per stay
  currency: Currency;
  minNights: number;
  maxNights: number | null; // null = no maximum
  bookingUrl: string;
  optedInAt: string | null;
  updatedAt: string;
  expiresAt: string;
};

export type SearchQuery = {
  market: string;
  checkIn: string; // YYYY-MM-DD, property-local
  checkOut: string; // exclusive
  guests: number;
  bedroomsMin?: number;
  pets?: boolean;
  requiredAmenities?: string[];
  maxTotalCents?: number;
  sort?: SortOrder;
  cursor?: string;
  pageSize?: number;
  now: string; // injected "today"; its first 10 chars are taken as the property-local date
};

/** One computed monthly baseline. Absent from the index = unavailable. */
export type Baseline = {
  propertyClass: PropertyClass;
  month: number;
  priceBasis: PriceBasis;
  medianCents: number; // can end in .5 (even sample); rounded once, on the stay total
  sampleSize: number; // after outlier trimming
  sources: string[];
  oldestObservedAt: string;
  newestObservedAt: string;
  confidence: Confidence;
  fallback?: "adjacent_bedrooms";
};

export type BaselineIndex = {
  baselines: Map<string, Baseline>; // key: baselineKey()
  peaks: Map<string, Baseline>; // key: peakKey(); highest available monthly baseline
};

export type DealResult = {
  listingId: string;
  bookingUrl: string;
  currency: Currency;
  nights: number;
  offerTotalCents: number; // nightly rates + mandatory fees, before taxes
  feesCents: number;
  baselineTotalCents: number | null;
  dealPct: number | null; // ratio, e.g. 0.32; null for no_score and needs_review
  tier: Tier;
  offSeasonPct: number | null;
  confidence: Confidence | null;
  reasons: string[];
  baselineMeta: {
    sampleSize: number;
    sources: string[];
    dataThrough: string;
    priceBasis: PriceBasis;
    fallback?: string;
  } | null;
  algorithmVersion: string;
  configVersion: string;
};

export type SearchResponse = {
  results: DealResult[];
  nextCursor: string | null;
  totalEligible: number;
  excluded: { listingId: string; reason: string }[]; // internal debugging only, never show travelers
  algorithmVersion: string;
  configVersion: string;
};
