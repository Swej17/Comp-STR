import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEligibility, type HostOffer, type SearchQuery } from "../src/index.ts";
import { offer, query, rates, RIDGE } from "./fixtures.ts";

const reason = (o: HostOffer, q: SearchQuery) => {
  const e = checkEligibility(o, q);
  return e.ok ? "ok" : e.reason;
};

test("baseline offer and query are eligible", () => {
  const e = checkEligibility(offer(), query());
  assert.ok(e.ok);
  assert.equal(e.offerTotalCents, 3 * 15_000 + 12_000);
  assert.equal(reason(offer(), query({ checkIn: "2026-11-09", checkOut: "2026-11-11" })), "ok"); // check-in today
});

test("unknowns: null is never a pass and missing is never zero", () => {
  assert.equal(reason(offer({ petsAllowed: null }), query({ pets: true })), "pets_not_allowed");
  assert.equal(reason(offer({ petsAllowed: false }), query({ pets: true })), "pets_not_allowed");
  assert.equal(reason(offer({ petsAllowed: null }), query()), "ok"); // pets not requested
  assert.equal(reason(offer(), query({ requiredAmenities: ["fireplace"] })), "missing_amenity"); // fireplace: null
  assert.equal(reason(offer(), query({ requiredAmenities: ["sauna"] })), "missing_amenity"); // not listed at all
  assert.equal(reason(offer(), query({ requiredAmenities: ["hot_tub", "wifi"] })), "ok");

  const gap = rates("2027-03-01", "2027-04-01", 15_000);
  delete gap["2027-03-11"];
  assert.equal(reason(offer({ nightlyRatesCents: gap }), query()), "missing_rate");
  assert.equal(reason(offer({ nightlyRatesCents: { ...gap, "2027-03-11": 150.5 } }), query()), "missing_rate");
  assert.equal(reason(offer({ mandatoryFeesCents: undefined as unknown as number }), query()), "invalid_price");
});

test("each eligibility rule excludes the offer with its reason", () => {
  const cases: [string, HostOffer, SearchQuery, string][] = [
    ["not opted in", offer({ optedInAt: null }), query(), "not_opted_in"],
    ["opted in after now", offer({ optedInAt: "2026-11-10T00:00:00Z" }), query(), "not_opted_in"],
    ["expired", offer({ expiresAt: "2026-11-09T12:00:00Z" }), query(), "expired"],
    ["stale", offer({ updatedAt: "2026-10-20T00:00:00Z" }), query(), "stale"],
    ["wrong market", offer(), query({ market: RIDGE }), "wrong_market"],
    ["too few bedrooms", offer(), query({ bedroomsMin: 4 }), "too_few_bedrooms"],
    ["empty stay", offer(), query({ checkOut: "2027-03-10" }), "invalid_dates"],
    ["impossible date", offer(), query({ checkIn: "2027-02-30", checkOut: "2027-03-02" }), "invalid_dates"],
    ["past check-in", offer(), query({ checkIn: "2026-11-08", checkOut: "2026-11-11" }), "check_in_in_past"],
    ["ends after availability", offer({ availableTo: "2027-03-12" }), query(), "outside_availability"],
    ["starts before availability", offer({ availableFrom: "2027-03-11" }), query(), "outside_availability"],
    ["too long", offer({ maxNights: null }), query({ checkIn: "2027-01-01", checkOut: "2027-06-01" }), "stay_too_long"],
    ["min nights", offer({ minNights: 4 }), query(), "below_min_nights"],
    ["max nights", offer({ maxNights: 2 }), query(), "above_max_nights"],
    ["too many guests", offer(), query({ guests: 9 }), "too_many_guests"],
    ["over budget", offer(), query({ maxTotalCents: 56_999 }), "over_budget"],
  ];
  for (const [name, o, q, want] of cases) assert.equal(reason(o, q), want, name);

  // Boundaries that must pass.
  assert.equal(reason(offer({ availableTo: "2027-03-13" }), query()), "ok"); // availableTo is exclusive, like checkOut
  assert.equal(reason(offer({ minNights: 3, maxNights: 3 }), query()), "ok");
  assert.equal(reason(offer(), query({ guests: 8, maxTotalCents: 57_000 })), "ok");
});
