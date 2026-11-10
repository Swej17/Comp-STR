import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineKey, buildBaselines, peakKey, type BaselineObservation, type PriceBasis, type PropertyClass } from "../src/index.ts";
import { cls, flat, LAKE, NOW, obs, RIDGE, syntheticObservations } from "./fixtures.ts";

const get = (o: BaselineObservation[], pc: PropertyClass, month: number, basis: PriceBasis = "nightly_rate") =>
  buildBaselines(o, NOW).baselines.get(baselineKey(pc, month, basis));

test("baseline is the median after dropping IQR outliers", () => {
  const prices = [...Array.from({ length: 20 }, (_, i) => 10_000 + i), 900_000, 900_000, 900_000];
  const b = get(obs(cls(), 3, prices), cls(), 3)!;
  assert.equal(b.sampleSize, 20); // the three 900_000 rows were trimmed
  assert.equal(b.medianCents, 10_009.5); // untrimmed median would be 10_011
  assert.equal(b.fallback, undefined);
  assert.deepEqual(b.sources, ["synthetic-survey-a"]);
});

test("below minimum sample falls back to pooled bedrooms ±1, one confidence step lower", () => {
  const o = [
    ...obs(cls(LAKE, 2), 3, flat(10_000, 15)),
    ...obs(cls(LAKE, 3), 3, flat(12_000, 10)),
    ...obs(cls(LAKE, 4), 3, flat(14_000, 15)),
  ];
  const b = get(o, cls(LAKE, 3), 3)!;
  assert.equal(b.fallback, "adjacent_bedrooms");
  assert.equal(b.sampleSize, 40);
  assert.equal(b.medianCents, 12_000);
  assert.equal(b.confidence, "low"); // sample 40 → medium, fallback → low
});

test("baseline is unavailable when the fallback is still too small", () => {
  const o = [...obs(cls(LAKE, 2), 3, flat(10_000, 5)), ...obs(cls(LAKE, 3), 3, flat(12_000, 5))];
  assert.equal(get(o, cls(LAKE, 3), 3), undefined);
});

test("never falls back across markets or price bases", () => {
  const o = [
    ...obs(cls(RIDGE, 3), 3, flat(20_000)), // plenty in the other market
    ...obs(cls(LAKE, 3), 3, flat(20_000), { priceBasis: "nightly_incl_mandatory_fees" }), // plenty on the other basis
    ...obs(cls(LAKE, 3), 3, flat(12_000, 5)),
  ];
  assert.equal(get(o, cls(LAKE, 3), 3, "nightly_rate"), undefined);
  assert.ok(get(o, cls(RIDGE, 3), 3));
});

test("confidence is the lowest of observations, sample size and data age", () => {
  assert.equal(get(obs(cls(), 3, flat(10_000, 60)), cls(), 3)!.confidence, "high");
  assert.equal(get(obs(cls(), 3, flat(10_000, 30)), cls(), 3)!.confidence, "medium");
  assert.equal(get(obs(cls(), 3, flat(10_000, 20)), cls(), 3)!.confidence, "low");
  const oneMedium = [...obs(cls(), 3, flat(10_000, 59)), ...obs(cls(), 3, [10_000], { confidence: "medium" })];
  assert.equal(get(oneMedium, cls(), 3)!.confidence, "medium");
  const stale = obs(cls(), 3, flat(10_000, 60), { observedAt: "2025-01-01" }); // > 400 days before NOW
  assert.equal(get(stale, cls(), 3)!.confidence, "medium");
});

test("invalid observations are dropped, never treated as zero", () => {
  const bad = [NaN, 0, -5, 100.5, undefined as unknown as number];
  assert.equal(get(obs(cls(), 3, [...flat(10_000, 19), ...bad]), cls(), 3), undefined);
});

test("peak month is the highest available monthly baseline (synthetic July)", () => {
  const idx = buildBaselines(syntheticObservations(), NOW);
  assert.equal(idx.peaks.get(peakKey(cls(LAKE, 3), "nightly_rate"))!.month, 7);
  assert.equal(idx.peaks.get(peakKey(cls(RIDGE, 2), "nightly_incl_mandatory_fees"))!.month, 7);
  assert.equal(idx.peaks.get(peakKey(cls(RIDGE, 2), "nightly_rate")), undefined);
});
