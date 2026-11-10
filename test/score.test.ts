import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBaselines, DEFAULT_CONFIG, scoreStay, stayNights, type DealResult, type HostOffer } from "../src/index.ts";
import { NO_DATA, TAXES } from "../src/score.ts";
import { cls, flat, LAKE_NAME, NOW, obs, offer, rates, syntheticObservations } from "./fixtures.ts";

const nightsOf = (a: string, b: string) => stayNights(a, b, 90)!;
const at = (o: HostOffer, a: string, b: string, idx: ReturnType<typeof buildBaselines>, cfg = DEFAULT_CONFIG) =>
  scoreStay(o, nightsOf(a, b), idx, LAKE_NAME, cfg);
const moneyFields = (r: DealResult) => [r.offerTotalCents, r.feesCents, r.baselineTotalCents];

test("multi-month stay: March nights use March baseline, April nights use April", () => {
  const idx = buildBaselines([...obs(cls(), 3, flat(30_000)), ...obs(cls(), 4, flat(20_000))], NOW);
  const nights = nightsOf("2027-03-30", "2027-04-03");
  assert.deepEqual(nights, ["2027-03-30", "2027-03-31", "2027-04-01", "2027-04-02"]);
  const r = scoreStay(offer({ mandatoryFeesCents: 0 }), nights, idx, LAKE_NAME);
  assert.equal(r.nights, 4);
  assert.equal(r.baselineTotalCents, 2 * 30_000 + 2 * 20_000);
  assert.match(r.reasons[0]!, /on these dates$/);
});

test("night counts are calendar dates, unaffected by DST changes", () => {
  assert.equal(nightsOf("2027-03-13", "2027-03-15").length, 2); // US spring forward 2027-03-14
  assert.equal(nightsOf("2026-10-31", "2026-11-02").length, 2); // US fall back 2026-11-01
  assert.equal(nightsOf("2027-12-30", "2028-01-02").length, 3);
});

test("money: integer cents, rounded once (half-up) on the baseline total", () => {
  const idx = buildBaselines(obs(cls(), 3, [...flat(10_000, 10), ...flat(10_001, 10)]), NOW); // median 10_000.5
  const o = offer({ mandatoryFeesCents: 0, minNights: 1 });
  assert.equal(at(o, "2027-03-10", "2027-03-11", idx).baselineTotalCents, 10_001); // 10_000.5 → 10_001
  assert.equal(at(o, "2027-03-10", "2027-03-12", idx).baselineTotalCents, 20_001); // per-night rounding would give 20_002
  assert.equal(at(o, "2027-03-10", "2027-03-13", idx).baselineTotalCents, 30_002); // 30_001.5 → 30_002
  for (const r of [at(o, "2027-03-10", "2027-03-13", idx)]) {
    for (const v of moneyFields(r)) assert.ok(Number.isSafeInteger(v), `${v} is not integer cents`);
  }
});

test("fees on each price basis", () => {
  const o = offer({ nightlyRatesCents: rates("2027-03-01", "2027-04-01", 10_000), mandatoryFeesCents: 6_000 });

  const rateIdx = buildBaselines(obs(cls(), 3, flat(12_000)), NOW);
  const r1 = at(o, "2027-03-10", "2027-03-13", rateIdx);
  assert.equal(r1.offerTotalCents, 36_000);
  assert.equal(r1.feesCents, 6_000);
  assert.equal(r1.baselineTotalCents, 36_000);
  assert.equal(r1.baselineMeta!.priceBasis, "nightly_rate");
  assert.equal(r1.tier, "good"); // compares 30_000 rates to 36_000 → 16.7% below
  assert.ok(r1.reasons.includes("Compared on nightly rates; the total also includes $60.00 in mandatory fees"));

  const feeIdx = buildBaselines(obs(cls(), 3, flat(12_000), { priceBasis: "nightly_incl_mandatory_fees" }), NOW);
  const r2 = at(o, "2027-03-10", "2027-03-13", feeIdx);
  assert.equal(r2.baselineMeta!.priceBasis, "nightly_incl_mandatory_fees");
  assert.equal(r2.dealPct, 0); // full 36_000 vs 36_000
  assert.equal(r2.tier, "none");
  assert.ok(r2.reasons.at(-1) === TAXES);
});

test("price basis: mismatched bases give no_score, never a comparison", () => {
  const mixed = buildBaselines([
    ...obs(cls(), 3, flat(30_000)),
    ...obs(cls(), 4, flat(30_000), { priceBasis: "nightly_incl_mandatory_fees" }),
  ], NOW);
  const r = at(offer(), "2027-03-30", "2027-04-03", mixed);
  assert.equal(r.tier, "no_score");
  assert.equal(r.dealPct, null);
  assert.equal(r.baselineTotalCents, null);
  assert.deepEqual(r.reasons, [NO_DATA, TAXES]);

  const onlyFees = { ...DEFAULT_CONFIG, priceBasisPreference: ["nightly_incl_mandatory_fees"] as const };
  const rateOnly = buildBaselines(obs(cls(), 3, flat(30_000)), NOW);
  assert.equal(at(offer(), "2027-03-10", "2027-03-13", rateOnly, onlyFees).tier, "no_score");
});

test("tiers: exact boundaries at 15%, 25%, 60%; above typical is never a deal", () => {
  const idx = buildBaselines(obs(cls(), 3, flat(10_000)), NOW);
  const tierAt = (cents: number) =>
    at(offer({ minNights: 1, mandatoryFeesCents: 0, nightlyRatesCents: { "2027-03-10": cents } }), "2027-03-10", "2027-03-11", idx);
  const cases: [number, string][] = [
    [8_501, "none"], [8_500, "good"], [7_501, "good"], [7_500, "great"],
    [4_000, "great"], [3_999, "needs_review"], [10_000, "none"], [11_000, "none"],
  ];
  for (const [cents, tier] of cases) assert.equal(tierAt(cents).tier, tier, `${cents} cents`);

  assert.match(tierAt(8_500).reasons[0]!, /^15% below typical March prices for 3-bedroom homes in Pine Lake$/);
  const above = tierAt(11_000);
  assert.ok(above.dealPct! < 0);
  assert.equal(above.reasons[0], "10% above typical March prices for 3-bedroom homes in Pine Lake");
  const review = tierAt(3_999);
  assert.equal(review.dealPct, null);
  assert.ok(!review.reasons.some((s) => /below|lower/.test(s)), "needs_review must not read as a deal");
});

test("synthetic market: reason wording and seasonal context", () => {
  const idx = buildBaselines(syntheticObservations(), NOW);
  const r = at(offer({ nightlyRatesCents: rates("2027-03-01", "2027-04-01", 12_500) }), "2027-03-10", "2027-03-13", idx);
  assert.equal(r.tier, "great");
  assert.match(r.reasons[0]!, /^\d+% below typical March prices for 3-bedroom homes in Pine Lake$/);
  assert.match(r.reasons[1]!, /^Prices here are usually \d+% lower in March than in July$/);
  assert.ok(r.offSeasonPct! > 0.4 && r.offSeasonPct! < 0.6);
  assert.equal(r.confidence, "medium"); // 40 obs per month → medium sample band
  assert.equal(r.baselineMeta!.sampleSize, 40); // the 1¢ and $99,999.99 junk rows were trimmed
  assert.deepEqual(r.baselineMeta!.sources, ["synthetic-survey-a", "synthetic-vendor-b"]);
});
