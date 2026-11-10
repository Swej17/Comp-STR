# Market Scope — deal algorithm

Shows travelers where a Northeast US vacation-rental stay is a genuine value compared with that
market's normal price for the same month, then links to the host's own booking page.
Market Scope never takes bookings or payments.

The repo has two parts:

- **`src/`: the pure algorithm.** Inputs in, results out. No database, network, clock or randomness.
- **`server/`: the app that runs it automatically.** Imports data files you drop in a folder,
  keeps them in SQLite, rebuilds baselines when price data changes, and serves the traveler search
  page and API. Runs on your computer with **no runtime dependencies** (Node 24's built-in
  `node:sqlite` and `node:http`).

## Run the app

Needs [Node.js 24](https://nodejs.org/) or newer.

```bash
npm install
npm run sample-data   # optional: writes fake sample CSVs into data/inbox
npm start             # http://localhost:3000
```

Then open <http://localhost:3000>. Leave it running; it checks `data/inbox/` every 5 seconds.

### Feeding it data

Drop `.csv` files into **`data/inbox/`** (Excel → *Save As → CSV UTF-8* works). The app works out
which kind of file it is from the columns:

- **Imported** files move to `data/imported/`.
- **Rejected** files move to `data/failed/` with a `.errors.txt` that lists every problem by
  spreadsheet row. Nothing from a rejected file is imported. Fix it and drop it in again.
- The same file twice is skipped. Files still being copied in are left until they stop changing.

**Price observations** (one row per observed nightly price; builds the "typical price" baselines):

| column | example | notes |
|---|---|---|
| `market` | `poconos-lake-harmony` | id used everywhere |
| `market_name` | `Lake Harmony` | optional, shown to travelers |
| `bedrooms` | `3` | 0 = studio |
| `month` | `3` | 1–12, the month the night falls in |
| `nightly_price_usd` | `189.00` | |
| `price_basis` | `nightly_rate` | or `nightly_incl_mandatory_fees` |
| `source` | `inside-airbnb-2026-q2` | **a new file replaces all earlier rows from the same source** |
| `observed_at` | `2026-06-01` | |
| `confidence` | `high` | `high` / `medium` / `low` |

**Host offers** (only opted-in hosts; one row per rate period, so a listing can span several rows):

| column | example | notes |
|---|---|---|
| `listing_id`, `host_id` | `LH-12`, `host-7` | a new file replaces earlier records for the same listing |
| `market`, `market_name` | | as above (`market_name` optional) |
| `bedrooms`, `max_guests` | `3`, `8` | |
| `pets_allowed` | `yes` | `yes` / `no` / blank = unknown (unknown never matches a pets search) |
| `amenities_yes`, `amenities_no` | `hot_tub;wifi` | `;`-separated; anything not listed is unknown |
| `available_from`, `available_to` | `2026-12-01`, `2027-06-01` | `available_to` is the first unavailable night |
| `rate_from`, `rate_to`, `nightly_rate_usd` | `2027-03-01`, `2027-04-01`, `150` | `rate_to` is the first night *not* at this rate; periods can't overlap |
| `mandatory_fees_usd` | `120` | per stay; `0` if none |
| `min_nights`, `max_nights` | `2`, blank | blank max = no limit |
| `booking_url` | `https://…` | the host's own booking page; must be http(s) |
| `opted_in_at` | `2026-10-01` | **blank = not opted in, never shown**. To remove a listing, re-send it blank |
| `updated_at` | | optional; blank = time of import (offers go stale after 14 days) |
| `expires_at` | `2027-01-31` | |

Settings (environment variables): `PORT` (3000), `HOST` (127.0.0.1, so it's only reachable from this
computer), `MARKET_SCOPE_DATA` (`./data`), `MARKET_SCOPE_TZ` (`America/New_York`, the "today" for check-in rules).

### API

- `GET /api/search?market=&checkIn=YYYY-MM-DD&checkOut=&guests=` plus optional `bedroomsMin`, `pets=true`,
  `amenities=hot_tub,wifi`, `maxTotal` (dollars), `sort` (`best_deal` | `price_asc` | `price_desc`), `pageSize`, `cursor`.
  Returns `results` (each `DealResult` plus `bedrooms` and `maxGuests`), `nextCursor`, `totalEligible`, `marketName`.
  Exclusion reasons stay internal.
- `GET /api/markets`: areas that have at least one host offer.
- `GET /api/status`: row counts and the last 20 imports with any problems.

## Develop

```bash
npm test           # node:test, runs the .ts files directly (no build step)
npm run typecheck  # tsc --noEmit, strict mode
```

GitHub Actions runs both on every push and pull request (`.github/workflows/test.yml`).

## Using the algorithm directly

```ts
import { buildBaselines, search } from "./src/index.ts";

const baselines = buildBaselines(observations, "2026-11-09"); // do this when observation data changes
const page = search({ offers, baselines, query, marketName: "Lake Harmony" });
// page.results: DealResult[]; page.nextCursor: pass back as query.cursor for the next page
// page.excluded: [{ listingId, reason }] for internal debugging only — never show travelers
```

| File | What it does |
|---|---|
| `src/config.ts` | Every threshold, in one versioned object (`DEFAULT_CONFIG`) |
| `src/baselines.ts` | Seasonal baselines, fallback, confidence, peak month |
| `src/eligibility.ts` | Filters, with the first failing reason |
| `src/score.ts` | Deal %, tier, seasonal context, traveler-facing reasons |
| `src/search.ts` | Filter → score → rank → cursor pagination |
| `src/dates.ts` | Calendar-date helpers (night counting) |
| `server/` | The app: inbox import, SQLite, baseline refresh, API, traveler page |
| `test/` | Synthetic fixtures + 35 tests (`test-output.txt` is the latest run) |

## Rules for money and dates

- **Money is integer cents** in USD. Offer prices are sums of integers, so they are exact.
- **The only rounding** is on the stay's baseline total. A monthly median of an even-sized sample
  can land on a half cent (e.g. 10,000.5). We keep that exact (half cents are exact in
  JavaScript numbers) and round the *stay total* once, half-up, to whole cents.
  Example: two nights at a 10,000.5¢ baseline = 20,001¢ (rounding each night first would give 20,002¢).
- **Dates** are property-local `YYYY-MM-DD`. A stay is `[checkIn, checkOut)`; nights are counted
  by stepping calendar dates, so daylight-saving changes never alter the count. Each night uses the
  baseline for its own month.
- **Unknown is not zero.** A missing or `null` value never counts as 0, false or a pass. Bad
  observation rows are dropped, not coerced.
- **`now` is injected.** Its first 10 characters are taken as "today" in property-local terms.

## 1. Seasonal baselines

For each (market, property type, bedrooms, month, price basis):

1. Drop invalid rows (non-integer or non-positive price, bad month, unknown basis/confidence, unparseable date).
2. Compute Q1 and Q3 (linear interpolation, same as Excel `QUARTILE.INC`) and drop prices outside
   **[Q1 − 1.5·IQR, Q3 + 1.5·IQR]** (`iqrMultiplier`).
3. **Baseline = median** of what's left.
4. If fewer than **20** rows remain (`minSampleSize`), **fallback**: pool the same market, type,
   month and basis for bedrooms −1, same and +1, then repeat steps 2–3. Marked
   `fallback: "adjacent_bedrooms"`, confidence one step lower. Still under 20 → **unavailable**.
   Never pools across markets, property types or price bases.
5. **Confidence** = the lowest of: every row's own confidence; sample size (≥ 50 high, ≥ 30 medium,
   otherwise low — `sampleConfidence`); and data age (if the *oldest* row used is over **400 days**
   old — `maxBaselineAgeDays` — one step lower).
6. **Peak month** = the month with the highest available baseline for that class and basis
   (ties keep the earlier month).

Each baseline records its median, trimmed sample size, sources, oldest/newest dates, confidence and fallback flag.

## 2. Deal scoring

- **Offer total** = sum of nightly rates + mandatory fees (before taxes).
- **Price basis.** Config `priceBasisPreference` (default: fee-inclusive first, then nightly rate).
  A stay uses the **first basis that has a baseline for every night**. Bases are never mixed,
  so if March only has nightly-rate data and April only has fee-inclusive data, a stay spanning both gets **no score**.
  - `nightly_rate`: compares nightly rates only; fees are reported separately in the reasons.
  - `nightly_incl_mandatory_fees`: compares the full offer total.
- **Baseline total** = sum of each night's month baseline, rounded once (see above).
- **dealPct** = 1 − comparable offer ÷ baseline total (a ratio; shown as a whole percent, rounded *down* so we never overstate a discount).
- **Tiers** (decided with whole-number math, so boundaries are exact):
  - `needs_review`: discount **above 60%** (`needsReviewAbovePct`). Usually a data error. `dealPct` is set to `null` and the reason makes no deal claim.
  - `great`: ≥ **25%** · `good`: ≥ **15%** (`tierPct`) · `none`: anything less, including above-typical prices.
  - `no_score`: any night lacks a baseline on the chosen basis → "Not enough local price data to compare yet".
- **Seasonal context**: offSeasonPct = 1 − (stay's average nightly baseline ÷ peak-month baseline).
  Mentioned only if ≥ **10%** (`minOffSeasonPctToMention`) and the stay doesn't include the peak month.
- **Confidence** = the lowest confidence among the baselines used.

Every result ends with "Taxes may apply". Results using a fallback or low-confidence baseline say so.

## 3. Eligibility (before any scoring)

All must pass; the first failure is recorded in `excluded`:
`not_opted_in` (no `optedInAt` or it's after now) · `expired` (`expiresAt` ≤ now) ·
`stale` (`updatedAt` over **14 days** old — `maxOfferAgeDays`) · `wrong_market` ·
`unsupported_property_type` · `too_few_bedrooms` · `invalid_dates` (malformed or checkIn ≥ checkOut) ·
`check_in_in_past` · `outside_availability` (stay not inside `[availableFrom, availableTo)`) ·
`stay_too_long` (over **90 nights** — `maxStayNights`) · `missing_rate` (any night missing or not integer cents) ·
`invalid_price` (fees unknown / not USD) · `below_min_nights` · `above_max_nights` · `too_many_guests` ·
`pets_not_allowed` (`null` fails) · `missing_amenity` (`null` or absent fails) · `over_budget`.

## 4. Ranking and pagination

- `best_deal` (default): scored offers by dealPct (highest first), then confidence (high first), then `listingId`.
  After them, `no_score` and `needs_review` offers by offer total (lowest first), then `listingId`.
- `price_asc` / `price_desc`: offer total only, ties by `listingId` (ascending).
- `listingId` compares by code units, not locale, so the order is the same on every machine.
- If the same `listingId` appears twice, the most recently updated record wins.
- **Cursor** = opaque base64url of the last result's sort key + listing ID, tied to the sort order
  (a cursor from another sort is rejected). The next page starts strictly after that key, so
  there are no duplicates or gaps. Page size default **20**, max **50**, min 1.

## Changes from the original spec types

- Added `currency: "USD"` to `BaselineObservation`, `HostOffer` and `DealResult`.
- `baselineMeta` also reports the `priceBasis` used.
- `search` takes a prebuilt `BaselineIndex` (from `buildBaselines`) and an optional `marketName` for display text.
- The search response wraps results with `nextCursor`, `totalEligible` and `excluded`.

## Assumptions

1. Host offers carry provenance through `updatedAt` and the host is the source. There is no per-field source or confidence on offer numbers.
2. The bedroom fallback pools bedrooms −1, same, +1 together, rather than using just one neighbour.
3. Data age uses the **oldest** observation in the baseline (the stricter choice).
4. `needs_review` offers stay visible in the unscored tail (the host opted in) and are never shown as deals.
5. `now`'s date part is the property-local "today". Callers in other time zones should pass a local timestamp.
6. Listing IDs are compared as plain strings.

## Open questions for the team

1. **Thresholds** (20-row minimum, 15/25/60%, 400 and 14 days) are reasonable starting points, not tuned. They need calibrating against real data.
2. **One low-confidence row** drops the whole baseline to low (spec: "lowest of"). Would a majority or weighted rule be better?
3. **High fees on the `nightly_rate` basis:** a listing with a cheap rate and a large cleaning fee can score as a deal. Should we prefer fee-inclusive data, or penalize fees above the market norm?
4. **Long stays:** capped at 90 nights. Monthly stays usually have their own discounts. Should stays over 28–30 nights have a separate baseline?
5. **Observation weighting:** every row counts the same regardless of source or age. Should newer data count more?
6. **Ranking at scale:** each search scores the whole market in memory. That's fine for thousands of offers; beyond that, move ranking into the store.
7. Should **`none` tier above-typical** listings show the "X% above typical" text, or stay neutral to avoid embarrassing hosts?
