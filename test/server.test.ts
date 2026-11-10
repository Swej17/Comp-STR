import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp, localIso } from "../server/app.ts";
import { parseCsv, toCsv } from "../server/csv.ts";
import { openDb, status } from "../server/db.ts";
import { scanInbox } from "../server/inbox.ts";
import { dollarsToCents, ImportError, OFFER_COLUMNS, parseImport } from "../server/importer.ts";
import { sampleCsvs } from "../server/sample-data.ts";

test("csv: quotes, escaped quotes, commas and newlines in fields, CRLF, BOM", () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z'), [
    ["a", "b"], ["x, y", 'say "hi"'], ["two\nlines", "z"],
  ]);
  assert.throws(() => parseCsv('a\n"open'), /never closed/);
  assert.deepEqual(parseCsv(toCsv([["a,b", 'q"', 3]])), [["a,b", 'q"', "3"]]);
});

test("dollars parse to exact cents as text", () => {
  assert.equal(dollarsToCents("$1,299.50"), 129_950);
  assert.equal(dollarsToCents("199"), 19_900);
  assert.equal(dollarsToCents("0.07"), 7);
  assert.equal(dollarsToCents("19.9"), 1_990);
  for (const bad of ["12.345", "-5", "abc", "", "1,29"]) assert.equal(dollarsToCents(bad), undefined, bad);
});

const offerRow = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    listing_id: "X-1", host_id: "h", market: "m", bedrooms: "3", max_guests: "6", pets_allowed: "",
    amenities_yes: "wifi; Hot_Tub", amenities_no: "sauna", available_from: "2027-01-01", available_to: "2027-06-01",
    rate_from: "2027-03-01", rate_to: "2027-04-01", nightly_rate_usd: "150", mandatory_fees_usd: "$120.00",
    min_nights: "2", max_nights: "", booking_url: "https://example.com/x", opted_in_at: "2026-10-01", expires_at: "2027-01-01",
  };
  return OFFER_COLUMNS.map((c) => over[c] ?? base[c]!);
};
const problemsOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof ImportError) return e.problems; throw e; }
  return [];
};

test("offers file: rows merge per listing, blanks stay unknown", () => {
  const csv = toCsv([OFFER_COLUMNS, offerRow(), offerRow({ rate_from: "2027-04-01", rate_to: "2027-04-03", nightly_rate_usd: "175.50" })]);
  const parsed = parseImport(csv, "2026-11-09T12:00:00Z");
  assert.equal(parsed.kind, "offers");
  if (parsed.kind !== "offers") return;
  const [o] = parsed.offers;
  assert.equal(parsed.offers.length, 1);
  assert.equal(o!.nightlyRatesCents["2027-03-31"], 15_000);
  assert.equal(o!.nightlyRatesCents["2027-04-02"], 17_550);
  assert.equal(o!.nightlyRatesCents["2027-04-03"], undefined); // rate_to is exclusive
  assert.equal(o!.petsAllowed, null);
  assert.equal(o!.maxNights, null);
  assert.deepEqual(o!.amenities, { wifi: true, hot_tub: true, sauna: false });
  assert.equal(o!.mandatoryFeesCents, 12_000);
  assert.equal(o!.updatedAt, "2026-11-09T12:00:00Z"); // blank updated_at = import time
});

test("offers file: bad rows reject the whole file with row-level reasons", () => {
  const problems = problemsOf(() => parseImport(toCsv([
    OFFER_COLUMNS,
    offerRow({ booking_url: "javascript:alert(1)" }),
    offerRow({ max_guests: "6", bedrooms: "4" }), // differs from row 2
    offerRow({ listing_id: "X-2", pets_allowed: "maybe", nightly_rate_usd: "12.345" }),
    offerRow({ listing_id: "X-3" }),
    offerRow({ listing_id: "X-3", rate_from: "2027-03-15", rate_to: "2027-03-20" }), // overlaps
  ]), "2026-11-09"));
  assert.ok(problems.some((p) => /^Row 2: booking_url must be an http/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /^Row 3: listing X-1 details differ/.test(p)));
  assert.ok(problems.some((p) => /^Row 4: pets_allowed/.test(p)));
  assert.ok(problems.some((p) => /^Row 4: nightly_rate_usd/.test(p)));
  assert.ok(problems.some((p) => /^Row 6: listing X-3 already has a rate for 2027-03-15/.test(p)));
  assert.deepEqual(problemsOf(() => parseImport("foo,bar\n1,2\n", "2026-11-09")).length, 1);
  assert.ok(problemsOf(() => parseImport("listing_id\nX\n", "2026-11-09")).some((p) => p === 'Missing column "host_id"'));
});

test("localIso gives the property-local date and offset", () => {
  assert.equal(localIso(new Date("2026-11-10T03:30:00Z"), "America/New_York"), "2026-11-09T22:30:00-05:00");
  assert.equal(localIso(new Date("2027-07-01T16:00:00Z"), "America/New_York"), "2027-07-01T12:00:00-04:00");
});

// End to end: files dropped in the inbox → imported → baselines rebuilt → traveler search API.
const TODAY = "2026-11-09";
let dir: string;
let server: Server;
let base: string;
const NOW = new Date("2026-11-09T17:00:00Z");

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "market-scope-"));
  const dirs = { inbox: join(dir, "inbox"), imported: join(dir, "imported"), failed: join(dir, "failed") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  const db = openDb(join(dir, "test.db"));
  const app = createApp({
    db, timeZone: "America/New_York", now: () => NOW, log: () => {},
    publicDir: fileURLToPath(new URL("../server/public/", import.meta.url)),
  });
  const { observations, offers } = sampleCsvs(TODAY);
  writeFileSync(join(dirs.inbox, "a-observations.csv"), observations);
  writeFileSync(join(dirs.inbox, "b-offers.csv"), offers);
  writeFileSync(join(dirs.inbox, "c-broken.csv"), "listing_id,host_id\nX,\n");
  writeFileSync(join(dirs.inbox, "notes.txt"), "ignored");
  const later = () => new Date(Date.now() + 1_000); // file mtimes can land a few ms after Date.now() on Windows
  const scan = () => scanInbox(db, dirs, later(), 0, () => {});
  assert.equal(scan(), true, "observations imported → baselines need a rebuild");
  app.rebuild();

  // Same content again is skipped; a file still being copied in is left alone.
  writeFileSync(join(dirs.inbox, "d-again.csv"), offers);
  writeFileSync(join(dirs.inbox, "e-copying.csv"), offers);
  assert.equal(scanInbox(db, dirs, new Date(Date.now()), 60_000, () => {}), false);
  assert.ok(existsSync(join(dirs.inbox, "d-again.csv")), "fresh files wait until they stop changing");
  const old = new Date(Date.now() - 120_000);
  utimesSync(join(dirs.inbox, "d-again.csv"), old, old);
  assert.equal(scanInbox(db, dirs, later(), 60_000, () => {}), false);

  server = createServer(app.handler).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as { __dirs?: typeof dirs; __db?: typeof db }).__dirs = dirs;
  (globalThis as { __db?: typeof db }).__db = db;
});

after(() => {
  server?.close();
  (globalThis as any).__db?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { code: res.status, body: await res.json() as any };
};
const dates = "checkIn=2027-03-10&checkOut=2027-03-13";

test("inbox: good files imported, bad file rejected with a readable reason", () => {
  const dirs = (globalThis as any).__dirs;
  assert.deepEqual(readdirSync(dirs.inbox).sort(), ["e-copying.csv", "notes.txt"]);
  assert.equal(readdirSync(dirs.imported).length, 3); // two imports + one duplicate
  const errors = readdirSync(dirs.failed).find((f: string) => f.endsWith(".errors.txt"))!;
  assert.match(readFileSync(join(dirs.failed, errors), "utf8"), /Nothing from c-broken\.csv was imported/);
  const s = status((globalThis as any).__db);
  assert.equal(s.offers, 10);
  assert.deepEqual(s.recentImports.map((r: any) => r.status), ["duplicate", "failed", "imported", "imported"]);
});

test("api: markets list with display names", async () => {
  const { code, body } = await get("/api/markets");
  assert.equal(code, 200);
  assert.deepEqual(body.markets, [{ id: "fake-pine-lake", name: "Pine Lake" }, { id: "fake-ridge-valley", name: "Ridge Valley" }]);
});

test("api: traveler search ranks deals and never leaks internal reasons", async () => {
  const { code, body } = await get(`/api/search?market=fake-pine-lake&${dates}&guests=2`);
  assert.equal(code, 200);
  assert.equal(body.excluded, undefined);
  assert.equal(body.marketName, "Pine Lake");
  const ids = body.results.map((r: any) => r.listingId);
  assert.equal(ids[0], "PL-101"); // priced 30% under typical
  assert.equal(body.results[0].tier, "great");
  assert.match(body.results[0].reasons[0], /^\d+% below typical March prices for 3-bedroom homes in Pine Lake$/);
  const five = body.results.find((r: any) => r.listingId === "PL-106"); // 5 bedrooms: pooled with 4-bedroom data
  assert.equal(five.baselineMeta.fallback, "adjacent_bedrooms");
  assert.ok(five.reasons.includes("Typical price estimated from similar-size homes in Pine Lake"));
  assert.equal(body.results.at(-1).listingId, "PL-107"); // 7 bedrooms: nothing comparable → unscored, last
  assert.equal(body.results.at(-1).tier, "no_score");
  assert.equal(body.results[0].bedrooms, 3);

  const fees = await get(`/api/search?market=fake-ridge-valley&${dates}&guests=2&pets=true`);
  assert.deepEqual(fees.body.results.map((r: any) => r.listingId), ["RV-201"]); // RV-203 pets unknown, RV-202 no
  assert.equal(fees.body.results[0].baselineMeta.priceBasis, "nightly_incl_mandatory_fees");
});

test("api: paging and filters", async () => {
  const p1 = await get(`/api/search?market=fake-pine-lake&${dates}&guests=2&pageSize=2`);
  const p2 = await get(`/api/search?market=fake-pine-lake&${dates}&guests=2&pageSize=2&cursor=${p1.body.nextCursor}`);
  assert.equal(p1.body.results.length, 2);
  assert.notDeepEqual(p1.body.results.map((r: any) => r.listingId), p2.body.results.map((r: any) => r.listingId));
  const budget = await get(`/api/search?market=fake-pine-lake&${dates}&guests=2&maxTotal=400&sort=price_asc`);
  assert.ok(budget.body.results.every((r: any) => r.offerTotalCents <= 40_000));
});

test("api: bad requests get a clear 400, unknown paths 404", async () => {
  const cases: [string, RegExp][] = [
    [`/api/search?${dates}&guests=2`, /Choose an area/],
    ["/api/search?market=fake-pine-lake&checkIn=2027-03-13&checkOut=2027-03-10&guests=2", /after check-in/],
    ["/api/search?market=fake-pine-lake&checkIn=2026-11-01&checkOut=2026-11-03&guests=2", /past/],
    [`/api/search?market=fake-pine-lake&${dates}&guests=0`, /Guests/],
    [`/api/search?market=fake-pine-lake&${dates}&guests=2&cursor=junk`, /search again/],
    [`/api/search?market=fake-pine-lake&${dates}&guests=2&sort=random`, /Sort/],
  ];
  for (const [path, msg] of cases) {
    const { code, body } = await get(path);
    assert.equal(code, 400, path);
    assert.match(body.error, msg);
  }
  assert.equal((await get("/api/nope")).code, 404);
  assert.equal((await fetch(`${base}/api/search`, { method: "POST" })).status, 405);
});

test("traveler page is served with a strict content policy", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await res.text(), /Market Scope/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});
