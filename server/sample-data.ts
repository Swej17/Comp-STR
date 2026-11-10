// Writes synthetic sample CSVs (fake markets, fake hosts, example.com links) so you can try the app.
// Run: npm run sample-data   (then start the app; the files import automatically)
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays } from "../src/dates.ts";
import { LAKE, RIDGE, SEASON, syntheticObservations } from "../test/fixtures.ts";
import { localIso } from "./app.ts";
import { toCsv } from "./csv.ts";
import { OBSERVATION_COLUMNS, OFFER_COLUMNS } from "./importer.ts";

const NAMES: Record<string, string> = { [LAKE]: "Pine Lake", [RIDGE]: "Ridge Valley" };
const usd = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const monthStart = (date: string, plus: number) => {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + plus;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
};

// price factor vs. the market's typical price: below 1 = a deal
const LISTINGS = [
  { id: "PL-101", market: LAKE, bedrooms: 3, guests: 8, pets: "yes", yes: "hot_tub;wifi;fireplace", no: "", factor: 0.7, fees: 15_000 },
  { id: "PL-102", market: LAKE, bedrooms: 3, guests: 6, pets: "no", yes: "wifi", no: "hot_tub", factor: 0.84, fees: 12_000 },
  { id: "PL-103", market: LAKE, bedrooms: 2, guests: 4, pets: "", yes: "wifi;lake_access", no: "", factor: 0.78, fees: 9_000 },
  { id: "PL-104", market: LAKE, bedrooms: 4, guests: 10, pets: "yes", yes: "hot_tub;wifi;game_room", no: "", factor: 1.05, fees: 20_000 },
  { id: "PL-105", market: LAKE, bedrooms: 1, guests: 2, pets: "no", yes: "wifi;fireplace", no: "", factor: 0.9, fees: 6_000 },
  { id: "PL-106", market: LAKE, bedrooms: 5, guests: 12, pets: "yes", yes: "hot_tub;wifi", no: "", factor: 1, fees: 25_000 }, // no 5-bedroom data → estimated from 4-bedroom homes
  { id: "PL-107", market: LAKE, bedrooms: 7, guests: 14, pets: "no", yes: "hot_tub;wifi", no: "", factor: 0.8, fees: 30_000 }, // nothing comparable → unscored
  { id: "RV-201", market: RIDGE, bedrooms: 2, guests: 6, pets: "yes", yes: "wifi;ski_storage", no: "", factor: 0.72, fees: 0 },
  { id: "RV-202", market: RIDGE, bedrooms: 3, guests: 8, pets: "no", yes: "hot_tub;wifi", no: "", factor: 0.95, fees: 0 },
  { id: "RV-203", market: RIDGE, bedrooms: 4, guests: 10, pets: "", yes: "wifi", no: "", factor: 0.8, fees: 0 },
];

export function sampleCsvs(today: string): { observations: string; offers: string } {
  const observations = toCsv([
    [...OBSERVATION_COLUMNS, "market_name"],
    ...syntheticObservations().map((o) => [
      o.propertyClass.market, o.propertyClass.bedrooms, o.month, usd(o.nightlyPriceCents),
      o.priceBasis, o.source, o.observedAt, o.confidence, NAMES[o.propertyClass.market]!,
    ]),
  ]);

  const end = monthStart(today, 12);
  const rows: (string | number)[][] = [[...OFFER_COLUMNS, "market_name"]];
  for (const l of LISTINGS) {
    const marketFactor = l.market === LAKE ? 1 : 0.85;
    for (let k = 0; k < 12; k++) {
      const from = k === 0 ? today : monthStart(today, k);
      const month = Number(from.slice(5, 7));
      const nightly = Math.round((12_000 + 8_000 * l.bedrooms) * SEASON[month - 1]! * marketFactor * l.factor);
      rows.push([
        l.id, `host-${l.id}`, l.market, l.bedrooms, l.guests, l.pets, l.yes, l.no,
        today, end, from, monthStart(today, k + 1), usd(nightly), usd(l.fees),
        2, 21, `https://example.com/book/${l.id}`, today, addDays(today, 60), NAMES[l.market]!,
      ]);
    }
  }
  return { observations, offers: toCsv(rows) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inbox = join(fileURLToPath(new URL("..", import.meta.url)), "data", "inbox");
  mkdirSync(inbox, { recursive: true });
  const { observations, offers } = sampleCsvs(localIso(new Date(), "America/New_York").slice(0, 10));
  writeFileSync(join(inbox, "sample-1-observations.csv"), observations);
  writeFileSync(join(inbox, "sample-2-offers.csv"), offers);
  console.log(`Wrote sample files to ${inbox}`);
}
