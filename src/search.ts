import { confRank } from "./baselines.ts";
import { ALGORITHM_VERSION, DEFAULT_CONFIG, type Config } from "./config.ts";
import { checkEligibility } from "./eligibility.ts";
import { scoreStay } from "./score.ts";
import type { BaselineIndex, DealResult, HostOffer, SearchQuery, SearchResponse, SortOrder } from "./types.ts";

export type SearchInput = {
  offers: HostOffer[];
  baselines: BaselineIndex;
  query: SearchQuery;
  marketName?: string; // display name for reasons, e.g. "Lake Harmony"; defaults to the market id
  marketNames?: Record<string, string>; // per-market display names, for searches spanning markets
};

// g: 0 = ranked by deal, 1 = unscored tail (best_deal only); p: dealPct; c: confidence rank; t: offer total.
type Key = { g: number; p: number; c: number; t: number; id: string };

function sortKey(r: DealResult, sort: SortOrder): Key {
  return {
    g: sort === "best_deal" && r.dealPct === null ? 1 : 0,
    p: r.dealPct ?? 0,
    c: r.confidence ? confRank(r.confidence) : -1,
    t: r.offerTotalCents,
    id: r.listingId,
  };
}

function compare(a: Key, b: Key, sort: SortOrder): number {
  const byId = a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // code-unit order, not locale: same everywhere
  if (sort === "price_asc") return a.t - b.t || byId;
  if (sort === "price_desc") return b.t - a.t || byId;
  if (a.g !== b.g) return a.g - b.g;
  if (a.g === 0) return b.p - a.p || b.c - a.c || byId;
  return a.t - b.t || byId;
}

const encodeCursor = (sort: SortOrder, k: Key) =>
  Buffer.from(JSON.stringify([sort, k.g, k.p, k.c, k.t, k.id])).toString("base64url");

function decodeCursor(cursor: string, sort: SortOrder): Key {
  try {
    const [s, g, p, c, t, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (s === sort && typeof id === "string" && [g, p, c, t].every(Number.isFinite)) return { g, p, c, t, id };
  } catch { /* fall through */ }
  throw new Error("Invalid cursor for this sort order");
}

/**
 * Filter → score → rank → page. Pure: no clock, I/O or randomness; `query.now` is the only "today".
 * shortcut: scores and sorts every offer in the market per call; fine to a few thousand offers, move ranking into the store beyond that.
 */
export function search(input: SearchInput, cfg: Config = DEFAULT_CONFIG): SearchResponse {
  const q = input.query;
  if (Number.isNaN(Date.parse(q.now))) throw new Error("query.now must be an ISO date or timestamp");
  const sort: SortOrder = q.sort ?? "best_deal";

  // One record per listing: the most recently updated wins, so pages can never repeat a listing.
  const latest = new Map<string, HostOffer>();
  for (const o of input.offers) {
    const prev = latest.get(o.listingId);
    if (!prev || Date.parse(o.updatedAt) > Date.parse(prev.updatedAt)) latest.set(o.listingId, o);
  }

  const excluded: SearchResponse["excluded"] = [];
  const ranked: { r: DealResult; k: Key }[] = [];
  for (const o of latest.values()) {
    const e = checkEligibility(o, q, cfg);
    if (!e.ok) { excluded.push({ listingId: o.listingId, reason: e.reason }); continue; }
    const market = o.propertyClass.market; // each home is compared with its own market's baselines
    const r = scoreStay(o, e.nights, input.baselines, input.marketNames?.[market] ?? input.marketName ?? market, cfg);
    ranked.push({ r, k: sortKey(r, sort) });
  }
  ranked.sort((a, b) => compare(a.k, b.k, sort));

  const size = Number.isFinite(q.pageSize)
    ? Math.min(cfg.pageSize.max, Math.max(1, Math.floor(q.pageSize!)))
    : cfg.pageSize.default;
  let start = 0;
  if (q.cursor !== undefined) {
    const after = decodeCursor(q.cursor, sort);
    start = ranked.findIndex((x) => compare(x.k, after, sort) > 0);
    if (start < 0) start = ranked.length;
  }
  const page = ranked.slice(start, start + size);
  const more = start + size < ranked.length;

  return {
    results: page.map((x) => x.r),
    nextCursor: more ? encodeCursor(sort, page.at(-1)!.k) : null,
    totalEligible: ranked.length,
    excluded,
    algorithmVersion: ALGORITHM_VERSION,
    configVersion: cfg.version,
  };
}
