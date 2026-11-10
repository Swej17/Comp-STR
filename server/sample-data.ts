// Writes synthetic sample CSVs so you can try the app: fictional homes, fake markets, made-up
// "Airbnb" prices and example.com links. No real listings, hosts or photos.
// Run: npm run sample-data   (then start the app; the files import automatically)
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays } from "../src/dates.ts";
import { LAKE, RIDGE, SEASON, seeded, syntheticObservations } from "../test/fixtures.ts";
import { localIso } from "./app.ts";
import { toCsv } from "./csv.ts";
import { OBSERVATION_COLUMNS, OFFER_COLUMNS } from "./importer.ts";

const NAMES: Record<string, string> = { [LAKE]: "Pine Lake", [RIDGE]: "Ridge Valley" };
const TOWNS: Record<string, string[]> = {
  [LAKE]: ["Pine Lake", "Laurel Point", "North Shore", "Fern Hollow"],
  [RIDGE]: ["Ridge Valley", "Summit Crest", "Birch Run", "Upper Falls"],
};
const usd = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const monthStart = (date: string, plus: number) => {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + plus;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
};

type Listing = {
  id: string; market: string; bedrooms: number; baths: number; guests: number; pets: string;
  yes: string; no: string; factor: number; fees: number; title: string; town: string; description: string;
  optedIn?: boolean;
};

// Hand-made homes the tests rely on. `factor` = Airbnb price vs. the area's typical price.
const FIXED: Listing[] = [
  { id: "PL-101", market: LAKE, bedrooms: 3, baths: 2, guests: 8, pets: "yes", yes: "hot_tub;wifi;fireplace", no: "", factor: 0.7, fees: 15_000, title: "Hemlock Hollow Cabin", town: "Pine Lake", description: "A log cabin under tall hemlocks with a hot tub on the back deck and a stone fireplace." },
  { id: "PL-102", market: LAKE, bedrooms: 3, baths: 2, guests: 6, pets: "no", yes: "wifi", no: "hot_tub", factor: 0.84, fees: 12_000, title: "Stillwater Cottage", town: "North Shore", description: "A quiet cottage a short walk from the boat launch, with a screened porch for rainy days." },
  { id: "PL-103", market: LAKE, bedrooms: 2, baths: 1, guests: 4, pets: "", yes: "wifi;lake_access", no: "", factor: 0.78, fees: 9_000, title: "Heron Point Lake House", town: "Laurel Point", description: "Two bedrooms right on the water with a private dock and kayaks." },
  { id: "PL-104", market: LAKE, bedrooms: 4, baths: 3, guests: 10, pets: "yes", yes: "hot_tub;wifi;game_room", no: "", factor: 1.05, fees: 20_000, title: "Black Bear Lodge", town: "Pine Lake", description: "A big family lodge with a game room, hot tub and room for ten." },
  { id: "PL-105", market: LAKE, bedrooms: 1, baths: 1, guests: 2, pets: "no", yes: "wifi;fireplace", no: "", factor: 0.9, fees: 6_000, title: "Fern Hollow Hideaway", town: "Fern Hollow", description: "A one-bedroom retreat for two with a wood stove and wooded views." },
  { id: "PL-106", market: LAKE, bedrooms: 5, baths: 3.5, guests: 12, pets: "yes", yes: "hot_tub;wifi", no: "", factor: 1, fees: 25_000, title: "Laurel Ridge Estate", town: "Laurel Point", description: "Five bedrooms on three wooded acres, made for reunions." },
  { id: "PL-107", market: LAKE, bedrooms: 7, baths: 5, guests: 14, pets: "no", yes: "hot_tub;wifi", no: "", factor: 0.8, fees: 30_000, title: "Grand Pines Manor", town: "North Shore", description: "Seven bedrooms and a great room with a two-story fireplace." },
  { id: "RV-201", market: RIDGE, bedrooms: 2, baths: 1, guests: 6, pets: "yes", yes: "wifi;ski_storage", no: "", factor: 0.72, fees: 0, title: "Summit Crest A-Frame", town: "Summit Crest", description: "A bright A-frame minutes from the lifts, with a boot room and ski storage." },
  { id: "RV-202", market: RIDGE, bedrooms: 3, baths: 2, guests: 8, pets: "no", yes: "hot_tub;wifi", no: "", factor: 0.95, fees: 0, title: "Upper Falls Chalet", town: "Upper Falls", description: "A chalet near the falls trail with a hot tub under the stars." },
  { id: "RV-203", market: RIDGE, bedrooms: 4, baths: 2.5, guests: 10, pets: "", yes: "wifi", no: "", factor: 0.8, fees: 0, title: "Birch Run Farmhouse", town: "Birch Run", description: "A restored farmhouse with a long dining table and mountain views." },
];

const FIRST = ["Cedar", "Maple", "Bluestone", "Fox Run", "Juniper", "Spruce", "Owl's Nest", "Aspen", "Brookside",
  "Pinecone", "Mossy Rock", "Willow Bend", "Hawk Hill", "Timberline", "Lantern", "Bramble", "Elk Ridge", "Cobblestone"];
const SECOND = ["Cabin", "Lodge", "Retreat", "Chalet", "Cottage", "Hideaway", "House", "A-Frame", "Camp", "Bungalow"];
const EXTRAS = ["hot_tub", "fireplace", "lake_access", "game_room", "grill", "washer", "ev_charger", "mountain_view", "ski_storage"];
const FEATURES = ["a wraparound deck", "a stone fireplace", "a fire pit for s'mores", "a screened porch", "wooded views",
  "a sunny reading nook", "a hot tub under the trees", "a big open kitchen", "a bunk room the kids will love"];

/** 30 more fictional homes, deterministic so the sample is the same every time. */
function generated(): Listing[] {
  const rand = seeded(2026);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const titles = new Set(FIXED.map((l) => l.title));
  const out: Listing[] = [];
  for (let i = 0; i < 30; i++) {
    const market = i < 18 ? LAKE : RIDGE;
    let title = "";
    while (!title || titles.has(title)) title = `${pick(FIRST)} ${pick(SECOND)}`;
    titles.add(title);
    const bedrooms = pick([1, 2, 2, 3, 3, 3, 4, 4, 5]);
    const extras = EXTRAS.filter(() => rand() < 0.35);
    const town = pick(TOWNS[market]!);
    out.push({
      id: `${market === LAKE ? "PL" : "RV"}-${300 + i}`,
      market, bedrooms, town, title,
      baths: Math.max(1, Math.round(bedrooms * 1.5) / 2),
      guests: bedrooms * 2 + (rand() < 0.5 ? 0 : 2),
      pets: pick(["yes", "no", ""]),
      yes: ["wifi", ...extras].join(";"),
      no: "",
      factor: 0.82 + Math.round(rand() * 40) / 100, // 0.82–1.22 of typical: some bargains, some pricey
      fees: (bedrooms * 30 + 50) * 100,
      description: `${title} is a ${bedrooms}-bedroom home in ${town} with ${pick(FEATURES)} and ${pick(FEATURES)}.`,
      optedIn: i !== 29, // one host hasn't opted in, so it never appears
    });
  }
  return out;
}

export function sampleCsvs(today: string): { observations: string; offers: string } {
  const observations = toCsv([
    [...OBSERVATION_COLUMNS, "market_name"],
    ...syntheticObservations().map((o) => [
      o.propertyClass.market, o.propertyClass.bedrooms, o.month, usd(o.nightlyPriceCents),
      o.priceBasis, o.source, o.observedAt, o.confidence, NAMES[o.propertyClass.market]!,
    ]),
  ]);

  const end = monthStart(today, 12);
  const rows: (string | number)[][] = [[...OFFER_COLUMNS, "market_name", "prices_from", "title", "town", "description", "bathrooms"]];
  for (const l of [...FIXED, ...generated()]) {
    const marketFactor = l.market === LAKE ? 1 : 0.85;
    for (let k = 0; k < 12; k++) {
      const from = k === 0 ? today : monthStart(today, k);
      const month = Number(from.slice(5, 7));
      const airbnbNightly = Math.round((12_000 + 8_000 * l.bedrooms) * SEASON[month - 1]! * marketFactor * l.factor);
      rows.push([
        l.id, `host-${l.id}`, l.market, l.bedrooms, l.guests, l.pets, l.yes, l.no,
        today, end, from, monthStart(today, k + 1), usd(airbnbNightly), usd(l.fees),
        2, 21, `https://example.com/book/${l.id}`, l.optedIn === false ? "" : today, addDays(today, 60), NAMES[l.market]!,
        "airbnb", l.title, l.town, `Fictional sample home. ${l.description}`, l.baths,
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
