import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { addDays, isDate, monthOf } from "../src/dates.ts";
import {
  buildBaselines, DEFAULT_CONFIG, fromPlatformPrice, PLATFORM_NAMES, search, unlistableReason,
  type BaselineIndex, type HostOffer, type Platform, type SearchQuery, type SortOrder,
} from "../src/index.ts";

const PLATFORMS = Object.keys(PLATFORM_NAMES) as Platform[];
import { listMarkets, loadAllOffers, loadObservations, loadOffer, loadOffers, marketNames, status, type Db } from "./db.ts";
import { approxLocation, APPROX_RADIUS_M, boundsOf, inBbox, parseBbox, type LatLng } from "./geo.ts";
import { dollarsToCents } from "./importer.ts";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const bookable = (o: HostOffer, d: string) =>
  d >= o.availableFrom && d < o.availableTo && Number.isSafeInteger(o.nightlyRatesCents[d]);

/** What travelers see about a home, plus its cheapest night in the 90 days from `from`. Never the exact location. */
export function listingCard(o: HostOffer, from: string, marketDisplayName: string) {
  let cheapest: string | null = null;
  for (let i = 0, d = from; i < 90; i++, d = addDays(d, 1)) {
    if (bookable(o, d) && (cheapest === null || o.nightlyRatesCents[d]! < o.nightlyRatesCents[cheapest]!)) cheapest = d;
  }
  const home = o.propertyClass.bedrooms === 0 ? "Studio" : `${o.propertyClass.bedrooms}-bedroom home`;
  return {
    listingId: o.listingId,
    market: o.propertyClass.market,
    marketName: marketDisplayName,
    title: o.details?.title || home,
    town: o.details?.town || marketDisplayName,
    description: o.details?.description ?? "",
    bedrooms: o.propertyClass.bedrooms,
    bathrooms: o.details?.bathrooms ?? null,
    maxGuests: o.maxGuests,
    petsAllowed: o.petsAllowed,
    amenities: Object.keys(o.amenities).filter((a) => o.amenities[a] === true).sort(),
    bookingUrl: o.bookingUrl,
    location: approxLocation(o), // approximate, within APPROX_RADIUS_M
    fromNightlyCents: cheapest ? o.nightlyRatesCents[cheapest]! : null,
    feesCents: o.mandatoryFeesCents,
    // The host's price on another platform, for "was" prices and the savings badge.
    platform: o.platformPrice?.platform ?? null,
    platformName: o.platformPrice ? PLATFORM_NAMES[o.platformPrice.platform] : null,
    fromPlatformNightlyCents: cheapest ? o.platformPrice?.nightlyRatesCents[cheapest] ?? null : null,
    platformFeesCents: o.platformPrice?.mandatoryFeesCents ?? null,
  };
}

/** Average nightly price per month for the next 12 months, ours and Airbnb's (integer cents, half-up). */
function monthlyPrices(o: HostOffer, today: string) {
  const months: { month: string; nights: number; nightlyCents: number; platformNightlyCents: number | null }[] = [];
  const sums = new Map<string, { n: number; ours: number; ref: number; refKnown: boolean }>();
  for (let i = 0, d = today; i < 366; i++, d = addDays(d, 1)) {
    if (!bookable(o, d)) continue;
    const key = d.slice(0, 7);
    const s = sums.get(key) ?? sums.set(key, { n: 0, ours: 0, ref: 0, refKnown: true }).get(key)!;
    const ref = o.platformPrice?.nightlyRatesCents[d];
    s.n++;
    s.ours += o.nightlyRatesCents[d]!;
    if (ref === undefined) s.refKnown = false; else s.ref += ref;
  }
  for (const [key, s] of sums) {
    months.push({
      month: `${MONTH_NAMES[monthOf(`${key}-01`) - 1]} ${key.slice(0, 4)}`,
      nights: s.n,
      nightlyCents: Math.round(s.ours / s.n),
      platformNightlyCents: s.refKnown ? Math.round(s.ref / s.n) : null,
    });
  }
  return months.slice(0, 12);
}

/** The instant `d` as a local ISO timestamp with offset in `timeZone`, e.g. 2026-11-09T19:30:00-05:00. */
export function localIso(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const local = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  const offset = Math.round((Date.parse(`${local}Z`) - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${offset < 0 ? "-" : "+"}${hh}:${mm}`;
}

const SORTS: SortOrder[] = ["best_deal", "price_asc", "price_desc"];
// Map tiles come from OpenStreetMap: free for light use with attribution. Switch to a tile provider before real traffic.
export const TILE_HOST = "https://tile.openstreetmap.org";
const CSP = `default-src 'self'; img-src 'self' data: ${TILE_HOST}; frame-ancestors 'none'`;

function parseSearch(p: URLSearchParams, now: string): SearchQuery | string {
  const market = p.get("market") ?? "";
  const checkIn = p.get("checkIn") ?? "";
  const checkOut = p.get("checkOut") ?? "";
  const guests = Number(p.get("guests"));
  if (!market && !p.get("bbox")) return "Choose an area or move the map";
  if (!isDate(checkIn) || !isDate(checkOut)) return "Check-in and check-out must be dates";
  if (checkIn >= checkOut) return "Check-out must be after check-in";
  if (checkIn < now.slice(0, 10)) return "Check-in can't be in the past";
  if (!Number.isInteger(guests) || guests < 1 || guests > 50) return "Guests must be a whole number from 1 to 50";

  const q: SearchQuery = { checkIn, checkOut, guests, now };
  if (market) q.market = market;
  const bedrooms = p.get("bedroomsMin");
  if (bedrooms) {
    const b = Number(bedrooms);
    if (!Number.isInteger(b) || b < 0) return "Bedrooms must be a whole number";
    q.bedroomsMin = b;
  }
  if (p.get("pets") === "true") q.pets = true;
  const amenities = (p.get("amenities") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (amenities.length) q.requiredAmenities = amenities;
  const max = p.get("maxTotal");
  if (max) {
    const cents = dollarsToCents(max);
    if (cents === undefined) return "Budget must be a dollar amount";
    q.maxTotalCents = cents;
  }
  const sort = p.get("sort");
  if (sort) {
    if (!SORTS.includes(sort as SortOrder)) return `Sort must be one of ${SORTS.join(", ")}`;
    q.sort = sort as SortOrder;
  }
  const cursor = p.get("cursor");
  if (cursor) q.cursor = cursor;
  const size = p.get("pageSize");
  if (size) {
    if (!/^\d+$/.test(size)) return "pageSize must be a whole number";
    q.pageSize = Number(size);
  }
  return q;
}

export type AppOptions = { db: Db; timeZone: string; now: () => Date; publicDir: string; log?: (m: string) => void };

export function createApp({ db, timeZone, now, publicDir, log = console.log }: AppOptions) {
  let cached: { day: string; index: BaselineIndex } | undefined;
  const leaflet = (file: string) => createRequire(import.meta.url).resolve(`leaflet/dist/${file}`);
  const STATIC: Record<string, [path: string, type: string]> = {
    "/": [join(publicDir, "index.html"), "text/html; charset=utf-8"],
    "/app.js": [join(publicDir, "app.js"), "text/javascript; charset=utf-8"],
    "/app.css": [join(publicDir, "app.css"), "text/css; charset=utf-8"],
    "/vendor/leaflet.js": [leaflet("leaflet.js"), "text/javascript; charset=utf-8"],
    "/vendor/leaflet.css": [leaflet("leaflet.css"), "text/css; charset=utf-8"],
  };

  const rebuild = (nowIso = localIso(now(), timeZone)): BaselineIndex => {
    const observations = loadObservations(db);
    cached = { day: nowIso.slice(0, 10), index: buildBaselines(observations, nowIso) };
    log(`Baselines rebuilt: ${cached.index.baselines.size} monthly baselines from ${observations.length} price observations`);
    return cached.index;
  };
  // Also rebuilt on the first search of each new day, since data age affects confidence.
  const baselinesFor = (nowIso: string) => (cached?.day === nowIso.slice(0, 10) ? cached.index : rebuild(nowIso));

  /** Offers in the requested market and/or map box (box tested against the public, approximate spot). */
  function offersFor(p: URLSearchParams): HostOffer[] | string {
    const market = p.get("market") ?? "";
    const rawBbox = p.get("bbox");
    if (!market && !rawBbox) return "Choose an area or move the map";
    const box = rawBbox ? parseBbox(rawBbox) : null;
    if (typeof box === "string") return box;
    // shortcut: filters every offer in memory; fine to a few thousand homes, use SQLite's R*Tree index beyond that.
    const offers = market ? loadOffers(db, market) : loadAllOffers(db);
    return box ? offers.filter((o) => inBbox(approxLocation(o), box)) : offers;
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== "GET") return send(405, { error: "Method not allowed" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.searchParams;

      const asset = STATIC[url.pathname];
      if (asset) {
        res.writeHead(200, { "content-type": asset[1], "content-security-policy": CSP, "x-content-type-options": "nosniff" });
        return void res.end(readFileSync(asset[0]));
      }

      if (url.pathname === "/api/markets") {
        const nowIso = localIso(now(), timeZone);
        const spots = new Map<string, LatLng[]>();
        for (const o of loadAllOffers(db)) {
          const at = approxLocation(o);
          if (at && unlistableReason(o, nowIso) === null) (spots.get(o.propertyClass.market) ?? spots.set(o.propertyClass.market, []).get(o.propertyClass.market)!).push(at);
        }
        return send(200, {
          markets: listMarkets(db).map((m) => ({ ...m, bounds: boundsOf(spots.get(m.id) ?? []) })),
          // Typical savings vs each platform at the reference fees (before the guest fee Vrbo also adds).
          hostFeePct: DEFAULT_CONFIG.hostFeePct,
          savingsPct: Object.fromEntries(PLATFORMS.map((p) => [p, 100 - fromPlatformPrice(10_000, p) / 100])),
          approxRadiusM: APPROX_RADIUS_M,
          tiles: { url: `${TILE_HOST}/{z}/{x}/{y}.png`, attribution: "© OpenStreetMap contributors" },
        });
      }
      if (url.pathname === "/api/status") return send(200, { ...status(db), baselines: cached?.index.baselines.size ?? null });

      // Browse every listable home in an area or map box, cheapest upcoming night first. No dates needed.
      if (url.pathname === "/api/listings") {
        const nowIso = localIso(now(), timeZone);
        const offers = offersFor(p);
        if (typeof offers === "string") return send(400, { error: offers });
        const guests = Number(p.get("guests") || 1);
        const bedroomsMin = Number(p.get("bedroomsMin") || 0);
        if (!Number.isInteger(guests) || guests < 1 || !Number.isInteger(bedroomsMin) || bedroomsMin < 0) {
          return send(400, { error: "Guests and bedrooms must be whole numbers" });
        }
        const names = marketNames(db);
        const listings = offers
          .filter((o) => unlistableReason(o, nowIso) === null && guests <= o.maxGuests && o.propertyClass.bedrooms >= bedroomsMin)
          .filter((o) => p.get("pets") !== "true" || o.petsAllowed === true)
          .map((o) => listingCard(o, nowIso.slice(0, 10), names[o.propertyClass.market] ?? o.propertyClass.market))
          .filter((c) => c.fromNightlyCents !== null);
        const desc = p.get("sort") === "price_desc";
        listings.sort((a, b) => (desc ? b.fromNightlyCents! - a.fromNightlyCents! : a.fromNightlyCents! - b.fromNightlyCents!)
          || (a.listingId < b.listingId ? -1 : 1));
        // shortcut: returns every match in one response; add paging past a few hundred homes per map view.
        return send(200, { total: listings.length, listings });
      }

      const detail = /^\/api\/listings\/([^/]{1,200})$/.exec(url.pathname);
      if (detail) {
        const nowIso = localIso(now(), timeZone);
        const o = loadOffer(db, decodeURIComponent(detail[1]!));
        if (!o || unlistableReason(o, nowIso) !== null) return send(404, { error: "This home isn't available on Market Scope" });
        const today = nowIso.slice(0, 10);
        return send(200, {
          ...listingCard(o, today, marketNames(db)[o.propertyClass.market] ?? o.propertyClass.market),
          approxRadiusM: APPROX_RADIUS_M,
          minNights: o.minNights,
          maxNights: o.maxNights,
          months: monthlyPrices(o, today),
        });
      }

      if (url.pathname === "/api/search") {
        const nowIso = localIso(now(), timeZone);
        const q = parseSearch(p, nowIso);
        if (typeof q === "string") return send(400, { error: q });
        const offers = offersFor(p);
        if (typeof offers === "string") return send(400, { error: offers });
        const names = marketNames(db);
        let out;
        try {
          out = search({ offers, baselines: baselinesFor(nowIso), query: q, marketNames: names });
        } catch (e) {
          if ((e as Error).message.startsWith("Invalid cursor")) return send(400, { error: "That page link has expired; search again" });
          throw e;
        }
        const { excluded: _internalOnly, ...publicPart } = out; // exclusion reasons are for debugging, not travelers
        const byId = new Map(offers.map((o) => [o.listingId, o]));
        return send(200, {
          ...publicPart,
          results: publicPart.results.map((r) => {
            const o = byId.get(r.listingId)!;
            return { ...listingCard(o, q.checkIn, names[o.propertyClass.market] ?? o.propertyClass.market), ...r };
          }),
        });
      }
      send(404, { error: "Not found" });
    } catch (e) {
      log(`Request failed: ${(e as Error).stack ?? e}`);
      send(500, { error: "Something went wrong" });
    }
  }

  return { handler, rebuild };
}
