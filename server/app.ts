import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { isDate } from "../src/dates.ts";
import { buildBaselines, search, type BaselineIndex, type SearchQuery, type SortOrder } from "../src/index.ts";
import { listMarkets, loadObservations, loadOffers, marketName, status, type Db } from "./db.ts";
import { dollarsToCents } from "./importer.ts";

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

const STATIC: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
const SORTS: SortOrder[] = ["best_deal", "price_asc", "price_desc"];

function parseSearch(p: URLSearchParams, now: string): SearchQuery | string {
  const market = p.get("market") ?? "";
  const checkIn = p.get("checkIn") ?? "";
  const checkOut = p.get("checkOut") ?? "";
  const guests = Number(p.get("guests"));
  if (!market) return "Choose an area";
  if (!isDate(checkIn) || !isDate(checkOut)) return "Check-in and check-out must be dates";
  if (checkIn >= checkOut) return "Check-out must be after check-in";
  if (checkIn < now.slice(0, 10)) return "Check-in can't be in the past";
  if (!Number.isInteger(guests) || guests < 1 || guests > 50) return "Guests must be a whole number from 1 to 50";

  const q: SearchQuery = { market, checkIn, checkOut, guests, now };
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

  const rebuild = (nowIso = localIso(now(), timeZone)): BaselineIndex => {
    const observations = loadObservations(db);
    cached = { day: nowIso.slice(0, 10), index: buildBaselines(observations, nowIso) };
    log(`Baselines rebuilt: ${cached.index.baselines.size} monthly baselines from ${observations.length} price observations`);
    return cached.index;
  };
  // Also rebuilt on the first search of each new day, since data age affects confidence.
  const baselinesFor = (nowIso: string) => (cached?.day === nowIso.slice(0, 10) ? cached.index : rebuild(nowIso));

  function handler(req: IncomingMessage, res: ServerResponse): void {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== "GET") return send(405, { error: "Method not allowed" });
      const url = new URL(req.url ?? "/", "http://localhost");

      const asset = STATIC[url.pathname];
      if (asset) {
        res.writeHead(200, {
          "content-type": asset[1],
          "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        });
        return void res.end(readFileSync(join(publicDir, asset[0])));
      }
      if (url.pathname === "/api/markets") return send(200, { markets: listMarkets(db) });
      if (url.pathname === "/api/status") return send(200, { ...status(db), baselines: cached?.index.baselines.size ?? null });

      if (url.pathname === "/api/search") {
        const nowIso = localIso(now(), timeZone);
        const q = parseSearch(url.searchParams, nowIso);
        if (typeof q === "string") return send(400, { error: q });
        const offers = loadOffers(db, q.market);
        const name = marketName(db, q.market);
        let out;
        try {
          out = search({ offers, baselines: baselinesFor(nowIso), query: q, marketName: name });
        } catch (e) {
          if ((e as Error).message.startsWith("Invalid cursor")) return send(400, { error: "That page link has expired; search again" });
          throw e;
        }
        const { excluded: _internalOnly, ...publicPart } = out; // exclusion reasons are for debugging, not travelers
        const byId = new Map(offers.map((o) => [o.listingId, o]));
        return send(200, {
          ...publicPart,
          marketName: name,
          results: publicPart.results.map((r) => ({
            ...r,
            bedrooms: byId.get(r.listingId)!.propertyClass.bedrooms,
            maxGuests: byId.get(r.listingId)!.maxGuests,
          })),
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
