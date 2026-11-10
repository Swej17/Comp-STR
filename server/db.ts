import { DatabaseSync } from "node:sqlite";
import type { BaselineObservation, HostOffer } from "../src/types.ts";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, sha256 TEXT NOT NULL, kind TEXT, rows INTEGER,
  status TEXT NOT NULL, problems TEXT, imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_sha ON imports (sha256);
CREATE TABLE IF NOT EXISTS observations (
  source TEXT NOT NULL, market TEXT NOT NULL, property_type TEXT NOT NULL, bedrooms INTEGER NOT NULL,
  month INTEGER NOT NULL, price_cents INTEGER NOT NULL, price_basis TEXT NOT NULL,
  observed_at TEXT NOT NULL, confidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_source ON observations (source);
CREATE TABLE IF NOT EXISTS offers (listing_id TEXT PRIMARY KEY, market TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS offers_market ON offers (market);
CREATE TABLE IF NOT EXISTS markets (id TEXT PRIMARY KEY, name TEXT NOT NULL);
`;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; ${SCHEMA}`);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** A file's observations replace every earlier observation from the same source(s). */
export function saveObservations(db: Db, rows: BaselineObservation[]): void {
  const del = db.prepare("DELETE FROM observations WHERE source = ?");
  for (const s of new Set(rows.map((r) => r.source))) del.run(s);
  const ins = db.prepare(`INSERT INTO observations
    (source, market, property_type, bedrooms, month, price_cents, price_basis, observed_at, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    const pc = r.propertyClass;
    ins.run(r.source, pc.market, pc.propertyType, pc.bedrooms, r.month, r.nightlyPriceCents, r.priceBasis, r.observedAt, r.confidence);
  }
}

export function loadObservations(db: Db): BaselineObservation[] {
  return db.prepare("SELECT * FROM observations").all().map((r) => ({
    propertyClass: { market: String(r.market), propertyType: "entire_home", bedrooms: Number(r.bedrooms) },
    month: Number(r.month),
    nightlyPriceCents: Number(r.price_cents),
    currency: "USD",
    priceBasis: r.price_basis as BaselineObservation["priceBasis"],
    source: String(r.source),
    observedAt: String(r.observed_at),
    confidence: r.confidence as BaselineObservation["confidence"],
  }));
}

/** A file's offers replace earlier records with the same listing_id. */
export function saveOffers(db: Db, offers: HostOffer[]): void {
  const up = db.prepare(`INSERT INTO offers (listing_id, market, data) VALUES (?, ?, ?)
    ON CONFLICT (listing_id) DO UPDATE SET market = excluded.market, data = excluded.data`);
  for (const o of offers) up.run(o.listingId, o.propertyClass.market, JSON.stringify(o));
}

export const loadOffers = (db: Db, market: string): HostOffer[] =>
  db.prepare("SELECT data FROM offers WHERE market = ?").all(market).map((r) => JSON.parse(String(r.data)) as HostOffer);

export const loadAllOffers = (db: Db): HostOffer[] =>
  db.prepare("SELECT data FROM offers").all().map((r) => JSON.parse(String(r.data)) as HostOffer);

export const marketNames = (db: Db): Record<string, string> =>
  Object.fromEntries(db.prepare("SELECT id, name FROM markets").all().map((r) => [String(r.id), String(r.name)]));

export function loadOffer(db: Db, listingId: string): HostOffer | undefined {
  const row = db.prepare("SELECT data FROM offers WHERE listing_id = ?").get(listingId);
  return row ? (JSON.parse(String(row.data)) as HostOffer) : undefined;
}

export function saveMarketNames(db: Db, names: Map<string, string>): void {
  const up = db.prepare("INSERT INTO markets (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name");
  for (const [id, name] of names) up.run(id, name);
}

/** Markets that have at least one host offer, with display names. */
export const listMarkets = (db: Db): { id: string; name: string }[] =>
  db.prepare(`SELECT DISTINCT o.market AS id, COALESCE(m.name, o.market) AS name
    FROM offers o LEFT JOIN markets m ON m.id = o.market ORDER BY name`).all()
    .map((r) => ({ id: String(r.id), name: String(r.name) }));

export const marketName = (db: Db, id: string): string =>
  String(db.prepare("SELECT name FROM markets WHERE id = ?").get(id)?.name ?? id);

export type ImportRecord = { file: string; sha256: string; kind: string | null; rows: number; status: "imported" | "duplicate" | "failed"; problems: string | null; importedAt: string };

export function recordImport(db: Db, r: ImportRecord): void {
  db.prepare("INSERT INTO imports (file, sha256, kind, rows, status, problems, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(r.file, r.sha256, r.kind, r.rows, r.status, r.problems, r.importedAt);
}

export const wasImported = (db: Db, sha256: string): boolean =>
  db.prepare("SELECT 1 FROM imports WHERE sha256 = ? AND status = 'imported'").get(sha256) !== undefined;

export function status(db: Db) {
  const count = (sql: string) => Number(db.prepare(sql).get()?.n ?? 0);
  return {
    observations: count("SELECT COUNT(*) AS n FROM observations"),
    offers: count("SELECT COUNT(*) AS n FROM offers"),
    recentImports: db.prepare("SELECT file, kind, rows, status, problems, imported_at AS importedAt FROM imports ORDER BY id DESC LIMIT 20").all(),
  };
}
