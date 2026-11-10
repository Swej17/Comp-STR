import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { buildBaselines, search, type HostOffer, type SearchQuery, type SortOrder } from "../src/index.ts";
import { cls, flat, HOST_OFFERS, LAKE, LAKE_NAME, NOW, obs, offer, query, rates, syntheticObservations } from "./fixtures.ts";

// March 3-bedroom baseline $200/night (high confidence); 2-bedroom $200 from only 25 rows (low confidence).
const IDX = buildBaselines([...obs(cls(LAKE, 3), 3, flat(20_000)), ...obs(cls(LAKE, 2), 3, flat(20_000, 25))], NOW);
const at = (id: string, nightly: number, over: Partial<HostOffer> = {}) =>
  offer({ listingId: id, nightlyRatesCents: rates("2027-03-01", "2027-04-01", nightly), ...over });
const run = (offers: HostOffer[], q: Partial<SearchQuery> = {}) =>
  search({ offers, baselines: IDX, query: query(q), marketName: LAKE_NAME });
const ids = (offers: HostOffer[], q: Partial<SearchQuery> = {}) => run(offers, q).results.map((r) => r.listingId);

const MIX = [
  at("E-review", 7_000), // 65% below → needs_review
  at("D-above", 22_000), // above typical → none
  at("C-unscored", 5_000, { propertyClass: cls(LAKE, 5) }), // no 5-bedroom data
  at("B-good", 17_000),
  at("A-great", 14_000),
];

test("best_deal: deals first, needs_review and unscored after, by total", () => {
  const res = run(MIX);
  assert.deepEqual(res.results.map((r) => r.listingId), ["A-great", "B-good", "D-above", "C-unscored", "E-review"]);
  assert.deepEqual(res.results.map((r) => r.tier), ["great", "good", "none", "no_score", "needs_review"]);
  assert.equal(res.configVersion, "2026-11-09.1");
  assert.ok(res.results.every((r) => r.configVersion === res.configVersion && r.algorithmVersion === res.algorithmVersion));
});

test("explicit price sorts override deal ranking completely", () => {
  assert.deepEqual(ids(MIX, { sort: "price_asc" }), ["C-unscored", "E-review", "A-great", "B-good", "D-above"]);
  assert.deepEqual(ids(MIX, { sort: "price_desc" }), ["D-above", "B-good", "A-great", "E-review", "C-unscored"]);
});

test("ties are deterministic: confidence (high first), then listingId", () => {
  const tied = [at("T-c", 15_000), at("T-a", 15_000), at("T-b", 15_000)];
  for (const sort of ["best_deal", "price_asc", "price_desc"] as const) {
    assert.deepEqual(ids(tied, { sort }), ["T-a", "T-b", "T-c"]);
    assert.deepEqual(ids([...tied].reverse(), { sort }), ["T-a", "T-b", "T-c"]);
  }
  const sameDeal = [at("A-low", 15_000, { propertyClass: cls(LAKE, 2) }), at("Z-high", 15_000)];
  assert.deepEqual(ids(sameDeal), ["Z-high", "A-low"]);
});

test("pagination: walking every page returns each eligible result exactly once", () => {
  const offers: HostOffer[] = [];
  for (let i = 0; i < 37; i++) {
    const id = `P-${String(i).padStart(2, "0")}`;
    const bedrooms = i % 7 === 0 ? 5 : 3; // some unscored
    offers.push(at(id, 6_000 + (i % 9) * 2_000, { propertyClass: cls(LAKE, bedrooms) })); // many ties
  }
  offers.push(at("P-gone", 10_000, { optedInAt: null }));

  for (const sort of ["best_deal", "price_asc", "price_desc"] as SortOrder[]) {
    const all = ids(offers, { sort, pageSize: 50 });
    const walked: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = run(offers, { sort, pageSize: 5, ...(cursor ? { cursor } : {}) });
      assert.ok(res.results.length <= 5);
      walked.push(...res.results.map((r) => r.listingId));
      cursor = res.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    assert.equal(pages, 8, sort);
    assert.equal(walked.length, 37, sort);
    assert.equal(new Set(walked).size, 37, `${sort}: duplicates`);
    assert.deepEqual(walked, all, `${sort}: pages differ from one full listing`);
  }

  assert.equal(run(offers, { pageSize: 1000 }).results.length, 37);
  assert.equal(run(offers, { pageSize: 0 }).results.length, 1);
  assert.equal(run(offers).results.length, 20);
  const first = run(offers, { pageSize: 5 }).nextCursor!;
  assert.throws(() => run(offers, { cursor: first, sort: "price_asc" }), /Invalid cursor/);
  assert.throws(() => run(offers, { cursor: "not-a-cursor" }), /Invalid cursor/);
});

test("duplicate listing ids collapse to the most recently updated record", () => {
  const res = run([at("DUP", 15_000), at("DUP", 14_000, { updatedAt: "2026-11-08T00:00:00Z" })]);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0]!.offerTotalCents, 3 * 14_000 + 12_000);
});

test("synthetic hosts: opted-out host never appears, reasons are traveler-ready", () => {
  const baselines = buildBaselines(syntheticObservations(), NOW);
  const res = search({ offers: HOST_OFFERS, baselines, query: query({ pets: true }), marketName: LAKE_NAME });
  assert.deepEqual(res.excluded, [
    { listingId: "PL-04", reason: "pets_not_allowed" },
    { listingId: "PL-06", reason: "not_opted_in" },
  ]);
  assert.equal(res.results[0]!.listingId, "PL-01");
  assert.ok(res.results.every((r) => r.bookingUrl.startsWith("https://example.com/") && r.reasons.at(-1) === "Taxes may apply"));
});

test("purity: never reads the clock and returns identical output for identical input", () => {
  const RealDate = Date;
  class NoClock extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) throw new Error("clock read: new Date()");
      super(...(args as [number]));
    }
    static override now(): number { throw new Error("clock read: Date.now()"); }
  }
  const offers = [...MIX, ...HOST_OFFERS];
  const before = JSON.stringify(offers);
  globalThis.Date = NoClock as DateConstructor;
  let a, b;
  try {
    const baselines = buildBaselines(syntheticObservations(), NOW);
    a = search({ offers, baselines, query: query(), marketName: LAKE_NAME });
    b = search({ offers, baselines, query: query(), marketName: LAKE_NAME });
  } finally {
    globalThis.Date = RealDate;
  }
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(offers), before, "inputs must not be mutated");

  const src = new URL("../src/", import.meta.url);
  for (const f of readdirSync(src)) {
    const code = readFileSync(new URL(f, src), "utf8");
    assert.doesNotMatch(code, /Date\.now|new Date\(\)|Math\.random|performance\.now|node:fs|fetch\(/, f);
  }
});
