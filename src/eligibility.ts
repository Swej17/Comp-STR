import { DEFAULT_CONFIG, type Config } from "./config.ts";
import { DAY_MS, isDate, stayNights } from "./dates.ts";
import type { HostOffer, SearchQuery } from "./types.ts";

export type Eligibility = { ok: true; nights: string[]; offerTotalCents: number } | { ok: false; reason: string };

const isCents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Every rule must pass; returns the first failing reason. Unknown values (null, undefined,
 * unparseable) always fail. Comparisons are written as !(x ok) so NaN fails too.
 */
/** Whether an offer may be shown at all (any dates): opted in, not expired, fresh. Null = listable. */
export function unlistableReason(o: HostOffer, nowIso: string, cfg: Config = DEFAULT_CONFIG): string | null {
  const now = Date.parse(nowIso);
  if (!o.optedInAt || !(Date.parse(o.optedInAt) <= now)) return "not_opted_in";
  if (!(Date.parse(o.expiresAt) > now)) return "expired";
  if (!(now - Date.parse(o.updatedAt) <= cfg.maxOfferAgeDays * DAY_MS)) return "stale";
  return null;
}

export function checkEligibility(o: HostOffer, q: SearchQuery, cfg: Config = DEFAULT_CONFIG): Eligibility {
  const fail = (reason: string): Eligibility => ({ ok: false, reason });
  const today = q.now.slice(0, 10);

  const unlistable = unlistableReason(o, q.now, cfg);
  if (unlistable) return fail(unlistable);
  if (o.propertyClass.market !== q.market) return fail("wrong_market");
  if (o.propertyClass.propertyType !== "entire_home") return fail("unsupported_property_type");
  if (q.bedroomsMin !== undefined && !(o.propertyClass.bedrooms >= q.bedroomsMin)) return fail("too_few_bedrooms");
  if (!isDate(q.checkIn) || !isDate(q.checkOut) || q.checkIn >= q.checkOut) return fail("invalid_dates");
  if (!(q.checkIn >= today)) return fail("check_in_in_past");
  if (!isDate(o.availableFrom) || !isDate(o.availableTo) || q.checkIn < o.availableFrom || q.checkOut > o.availableTo) {
    return fail("outside_availability");
  }
  const nights = stayNights(q.checkIn, q.checkOut, cfg.maxStayNights);
  if (!nights) return fail("stay_too_long");
  if (!nights.every((d) => Object.hasOwn(o.nightlyRatesCents, d) && isCents(o.nightlyRatesCents[d]))) return fail("missing_rate");
  if (o.currency !== "USD" || !isCents(o.mandatoryFeesCents)) return fail("invalid_price");
  if (!(nights.length >= o.minNights)) return fail("below_min_nights");
  if (o.maxNights !== null && !(nights.length <= o.maxNights)) return fail("above_max_nights");
  if (!(q.guests <= o.maxGuests)) return fail("too_many_guests");
  if (q.pets && o.petsAllowed !== true) return fail("pets_not_allowed");
  if (q.requiredAmenities?.some((a) => o.amenities?.[a] !== true)) return fail("missing_amenity");
  const offerTotalCents = nights.reduce((s, d) => s + o.nightlyRatesCents[d]!, 0) + o.mandatoryFeesCents;
  if (q.maxTotalCents !== undefined && !(offerTotalCents <= q.maxTotalCents)) return fail("over_budget");
  return { ok: true, nights, offerTotalCents };
}
