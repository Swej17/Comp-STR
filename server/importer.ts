// Turns a dropped CSV file into validated observations or host offers. All-or-nothing:
// any bad row rejects the whole file with a readable list of problems.
import { fromAirbnbPrice } from "../src/config.ts";
import { isDate, stayNights } from "../src/dates.ts";
import type { BaselineObservation, Confidence, HostOffer, PriceBasis } from "../src/types.ts";
import { parseCsv } from "./csv.ts";

export class ImportError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`${problems.length} problem(s) in file`);
    this.problems = problems;
  }
}

export type Parsed =
  | { kind: "observations"; observations: BaselineObservation[]; marketNames: Map<string, string> }
  | { kind: "offers"; offers: HostOffer[]; marketNames: Map<string, string> };

export const OBSERVATION_COLUMNS = ["market", "bedrooms", "month", "nightly_price_usd", "price_basis", "source", "observed_at", "confidence"];
export const OFFER_COLUMNS = [
  "listing_id", "host_id", "market", "bedrooms", "max_guests", "pets_allowed", "amenities_yes", "amenities_no",
  "available_from", "available_to", "rate_from", "rate_to", "nightly_rate_usd", "mandatory_fees_usd",
  "min_nights", "max_nights", "booking_url", "opted_in_at", "expires_at",
];
// Optional in both: market_name, property_type. Optional for offers: updated_at (blank = time of import).
const RATE_COLUMNS = ["rate_from", "rate_to", "nightly_rate_usd"];
const LISTING_COLUMNS = [...OFFER_COLUMNS.filter((c) => !RATE_COLUMNS.includes(c)), "market_name", "property_type", "updated_at", "prices_from", "title", "town", "description", "bathrooms"];
// title, town, description, bathrooms (optional): what travelers see. Without a title the site shows "3-bedroom home".
const halves: P<number> = (s) => (/^\d+(\.5)?$/.test(s) ? Number(s) : undefined);
// prices_from (optional): "airbnb" = the rates and fees are the host's Airbnb prices; we list the
// lower price that nets the host the same at our fee. Blank or "direct" = use the prices as given.
const isAirbnbLink = (url: string) => /(^|\.)airbnb\.[a-z.]+$/i.test(new URL(url).hostname);

/** "$1,299.50" → 129950. Parsed as text, so a float never touches money. */
export function dollarsToCents(s: string): number | undefined {
  const m = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const cents = Number(m[1]!.replaceAll(",", "")) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

type P<T> = (s: string) => T | undefined; // undefined = invalid; null is a legitimate "unknown"
const whole: P<number> = (s) => (/^\d+$/.test(s) ? Number(s) : undefined);
const positive: P<number> = (s) => { const n = whole(s); return n ? n : undefined; };
const text: P<string> = (s) => (s !== "" ? s : undefined);
const instant: P<string> = (s) => (s !== "" && !Number.isNaN(Date.parse(s)) ? s : undefined);
const date: P<string> = (s) => (isDate(s) ? s : undefined);
const oneOf = <T extends string>(...vals: T[]): P<T> => (s) => (vals.includes(s as T) ? (s as T) : undefined);
const entireHome: P<"entire_home"> = (s) => (s === "" || s === "entire_home" ? "entire_home" : undefined);
const yesNoBlank: P<boolean | null> = (s) => {
  const v = s.toLowerCase();
  return ["yes", "y", "true"].includes(v) ? true : ["no", "n", "false"].includes(v) ? false : ["", "unknown"].includes(v) ? null : undefined;
};
const webLink: P<string> = (s) => {
  try { return ["http:", "https:"].includes(new URL(s).protocol) ? s : undefined; } catch { return undefined; }
};
const items = (s: string) => s.split(";").map((x) => x.trim().toLowerCase()).filter(Boolean);

type Rec = { row: number; get: (col: string) => string };

export function parseImport(csvText: string, importedAt: string): Parsed {
  let rows: string[][];
  try { rows = parseCsv(csvText); } catch (e) { throw new ImportError([(e as Error).message]); }
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const kind = header.includes("listing_id") ? "offers" : header.includes("nightly_price_usd") ? "observations" : null;
  if (!kind) {
    throw new ImportError(["Can't tell what this file is. Offer files need a listing_id column; price files need a nightly_price_usd column."]);
  }
  const problems = (kind === "offers" ? OFFER_COLUMNS : OBSERVATION_COLUMNS)
    .filter((c) => !header.includes(c)).map((c) => `Missing column "${c}"`);
  if (problems.length) throw new ImportError(problems);

  const records: Rec[] = [];
  rows.slice(1).forEach((r, i) => {
    if (r.every((f) => f.trim() === "")) return;
    const row = i + 2; // spreadsheet row number; the header is row 1
    if (r.length !== header.length) { problems.push(`Row ${row}: has ${r.length} values but the header has ${header.length}`); return; }
    records.push({ row, get: (c) => (r[header.indexOf(c)] ?? "").trim() });
  });
  if (!records.length && !problems.length) problems.push("The file has no data rows");

  const need = <T>(rec: Rec, col: string, parse: P<T>, rule: string): T => {
    const v = parse(rec.get(col));
    if (v === undefined) problems.push(`Row ${rec.row}: ${col} ${rule} (got "${rec.get(col)}")`);
    return v as T; // only used if no problems were found
  };
  const marketNames = new Map<string, string>();
  const noteName = (rec: Rec, market: string | undefined) => {
    if (market && rec.get("market_name")) marketNames.set(market, rec.get("market_name"));
  };

  if (kind === "observations") {
    const observations = records.map((rec): BaselineObservation => {
      const market = need(rec, "market", text, "is required");
      noteName(rec, market);
      return {
        propertyClass: {
          market,
          propertyType: need(rec, "property_type", entireHome, "must be entire_home or blank"),
          bedrooms: need(rec, "bedrooms", whole, "must be a whole number (0 = studio)"),
        },
        month: need(rec, "month", (s) => { const m = positive(s); return m && m <= 12 ? m : undefined; }, "must be 1–12"),
        nightlyPriceCents: need(rec, "nightly_price_usd", (s) => dollarsToCents(s) || undefined, "must be a dollar amount above 0"),
        currency: "USD",
        priceBasis: need(rec, "price_basis", oneOf<PriceBasis>("nightly_rate", "nightly_incl_mandatory_fees"), "must be nightly_rate or nightly_incl_mandatory_fees"),
        source: need(rec, "source", text, "is required"),
        observedAt: need(rec, "observed_at", instant, "must be a date"),
        confidence: need(rec, "confidence", oneOf<Confidence>("high", "medium", "low"), "must be high, medium or low"),
      };
    });
    if (problems.length) throw new ImportError(problems);
    return { kind, observations, marketNames };
  }

  // Offers: one row per rate period; a listing may span several rows with identical listing details.
  const listings = new Map<string, { offer: HostOffer; signature: string; fromAirbnb: boolean }>();
  for (const rec of records) {
    const id = need(rec, "listing_id", text, "is required");
    if (id === undefined) continue;
    const signature = LISTING_COLUMNS.map((c) => rec.get(c)).join("\u0000");
    let entry = listings.get(id);
    if (!entry) {
      const yes = items(rec.get("amenities_yes"));
      const no = items(rec.get("amenities_no"));
      const both = yes.filter((a) => no.includes(a));
      if (both.length) problems.push(`Row ${rec.row}: ${both.join(", ")} listed in both amenities_yes and amenities_no`);
      const market = need(rec, "market", text, "is required");
      noteName(rec, market);
      const offer: HostOffer = {
        listingId: id,
        hostId: need(rec, "host_id", text, "is required"),
        propertyClass: {
          market,
          propertyType: need(rec, "property_type", entireHome, "must be entire_home or blank"),
          bedrooms: need(rec, "bedrooms", whole, "must be a whole number (0 = studio)"),
        },
        maxGuests: need(rec, "max_guests", positive, "must be a whole number above 0"),
        petsAllowed: need(rec, "pets_allowed", yesNoBlank, "must be yes, no, or blank if unknown"),
        amenities: Object.fromEntries([...yes.map((a) => [a, true]), ...no.map((a) => [a, false])]),
        availableFrom: need(rec, "available_from", date, "must be a date like 2027-03-01"),
        availableTo: need(rec, "available_to", date, "must be a date like 2027-03-01"),
        nightlyRatesCents: {},
        mandatoryFeesCents: need(rec, "mandatory_fees_usd", dollarsToCents, "must be a dollar amount (0 if none)"),
        currency: "USD",
        minNights: need(rec, "min_nights", positive, "must be a whole number above 0"),
        maxNights: need(rec, "max_nights", (s) => (s === "" ? null : positive(s)), "must be a whole number, or blank for no limit"),
        bookingUrl: need(rec, "booking_url", webLink, "must be an http:// or https:// link"),
        optedInAt: need(rec, "opted_in_at", (s) => (s === "" ? null : instant(s)), "must be a date, or blank if the host has not opted in"),
        updatedAt: rec.get("updated_at") === "" ? importedAt : need(rec, "updated_at", instant, "must be a date"),
        expiresAt: need(rec, "expires_at", instant, "must be a date"),
      };
      if (rec.get("title")) {
        offer.details = {
          title: rec.get("title").slice(0, 120),
          town: rec.get("town").slice(0, 80),
          description: rec.get("description").slice(0, 2_000),
          bathrooms: need(rec, "bathrooms", (s) => (s === "" ? null : halves(s)), "must be a number like 2 or 1.5, or blank"),
        };
      }
      const fromAirbnb = need(rec, "prices_from", (s) => (s === "airbnb" ? true : s === "" || s === "direct" ? false : undefined), "must be airbnb, direct, or blank") === true;
      if (fromAirbnb && offer.bookingUrl && isAirbnbLink(offer.bookingUrl)) {
        problems.push(`Row ${rec.row}: booking_url must be the host's direct booking page when prices_from is airbnb (on Airbnb, guests would pay the Airbnb price)`);
      }
      entry = { offer, signature, fromAirbnb };
      listings.set(id, entry);
    } else if (entry.signature !== signature) {
      problems.push(`Row ${rec.row}: listing ${id} details differ from its earlier row (only ${RATE_COLUMNS.join(", ")} may change between rows)`);
    }

    const from = need(rec, "rate_from", date, "must be a date like 2027-03-01");
    const to = need(rec, "rate_to", date, "must be a date like 2027-03-01");
    const rate = need(rec, "nightly_rate_usd", dollarsToCents, "must be a dollar amount");
    if (from === undefined || to === undefined || rate === undefined) continue;
    const nights = from < to ? stayNights(from, to, 1000) : null;
    if (!nights) { problems.push(`Row ${rec.row}: rate_from must be before rate_to (rate_to is the first night NOT at this rate), at most 1000 nights`); continue; }
    const rates = entry.offer.nightlyRatesCents;
    const clash = nights.find((d) => Object.hasOwn(rates, d));
    if (clash) { problems.push(`Row ${rec.row}: listing ${id} already has a rate for ${clash} from another row`); continue; }
    for (const d of nights) rates[d] = rate;
  }
  if (problems.length) throw new ImportError(problems);
  for (const { offer: o, fromAirbnb } of listings.values()) {
    if (!fromAirbnb) continue;
    o.airbnbPrice = { nightlyRatesCents: o.nightlyRatesCents, mandatoryFeesCents: o.mandatoryFeesCents };
    o.nightlyRatesCents = Object.fromEntries(Object.entries(o.nightlyRatesCents).map(([d, c]) => [d, fromAirbnbPrice(c)]));
    o.mandatoryFeesCents = fromAirbnbPrice(o.mandatoryFeesCents);
  }
  return { kind, offers: [...listings.values()].map((e) => e.offer), marketNames };
}
