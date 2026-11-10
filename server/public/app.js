/* global L */
const $ = (sel) => document.querySelector(sel);
const form = $("#search");
const statusEl = $("#status");
const grid = $("#results");
const more = $("#more");
const listView = $("#list-view");
const detailView = $("#detail-view");
const clearDates = $("#clear-dates");
const autoSearch = $("#auto-search");
const searchArea = $("#search-area");
const submit = form.querySelector("button[type=submit]");
const TIER_LABEL = { great: "Great value", good: "Good value" };
let config = { markets: [], approxRadiusM: 500, tiles: null };
let cursor = null;
let map = null;
let pins = new Map(); // listingId -> Leaflet marker

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (c) => "$" + Math.round(c / 100).toLocaleString("en-US");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const AMENITY_NAMES = { ev_charger: "EV charger", wifi: "Wi-Fi" };
const amenityName = (a) => AMENITY_NAMES[a] ?? a.charAt(0).toUpperCase() + a.slice(1).replaceAll("_", " ");
const specs = (h) => [
  h.bedrooms === 0 ? "Studio" : plural(h.bedrooms, "bedroom"),
  h.bathrooms != null ? plural(h.bathrooms, "bath") : null,
  `sleeps ${h.maxGuests}`,
].filter(Boolean).join(" · ");
/** Whole percent under the platform price, rounded down so we never overstate it. */
const underPct = (ours, theirs) => Math.floor((1 - ours / theirs) * 100 + 1e-9);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- generated illustration (no photos: every sample home is fictional) ----------
const SVG = "http://www.w3.org/2000/svg";
let artCount = 0;
function svg(tag, attrs, parent) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}
function seededRandom(text) {
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function homeArt(h) {
  const r = seededRandom(h.listingId);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const id = `sky${++artCount}`;
  const art = svg("svg", { viewBox: "0 0 320 200", class: "art", role: "img", "aria-label": `Illustration of ${h.title}` });
  const [top, bottom] = pick([["#9fd3ea", "#e4f4fa"], ["#f3c79b", "#fbe9d6"], ["#b9c8ec", "#eceffa"], ["#c4e3bd", "#eef7ea"], ["#e8b9c4", "#f9e6ea"]]);
  const grad = svg("linearGradient", { id, x1: "0", y1: "0", x2: "0", y2: "1" }, svg("defs", {}, art));
  svg("stop", { offset: "0", "stop-color": top }, grad);
  svg("stop", { offset: "1", "stop-color": bottom }, grad);
  svg("rect", { width: "320", height: "200", fill: `url(#${id})` }, art);
  svg("circle", { cx: String(40 + r() * 240), cy: String(30 + r() * 20), r: "14", fill: "#fff6d6", opacity: "0.9" }, art);
  if (h.amenities.includes("mountain_view") || h.amenities.includes("ski_storage") || h.listingId.startsWith("RV")) {
    svg("polygon", { points: "0,140 70,60 130,130 190,50 260,125 320,70 320,150 0,150", fill: "#8b9bb4" }, art);
    svg("polygon", { points: "175,68 190,50 205,68 197,64 190,70 183,64", fill: "#ffffff", opacity: "0.85" }, art);
  }
  svg("path", { d: `M0 ${150 - r() * 20} Q 90 ${110 + r() * 20} 180 ${140 - r() * 10} T 320 ${130 + r() * 15} V200 H0Z`, fill: pick(["#7fa86b", "#6d9a5d", "#8bb17a"]) }, art);
  const lake = h.amenities.includes("lake_access") || /lake/i.test(h.title);
  svg("rect", { x: "0", y: "172", width: "320", height: "28", fill: lake ? "#6fa9cf" : "#5f8a50" }, art);
  const treeColor = pick(["#2f5d3a", "#3b6b45", "#2a4f35"]);
  for (let i = 0, n = 3 + Math.floor(r() * 4); i < n; i++) {
    const x = i % 2 ? 230 + r() * 80 : 10 + r() * 70;
    const s = 0.7 + r() * 0.6;
    svg("polygon", { points: `${x},${172 - 70 * s} ${x - 18 * s},${172} ${x + 18 * s},${172}`, fill: treeColor }, art);
  }
  const w = 70 + Math.min(h.bedrooms, 6) * 12;
  const x = 160 - w / 2 + (r() - 0.5) * 30;
  const body = pick(["#b5653f", "#8a5a3c", "#d9c7a7", "#6f7f5e", "#a33b3b", "#4f6d8a", "#e8e0cf"]);
  const roof = pick(["#3b3b3b", "#5a2e22", "#2f4a3a", "#47505c"]);
  if (/a-frame/i.test(h.title)) {
    svg("polygon", { points: `${x},172 ${x + w / 2},${172 - w * 0.9} ${x + w},172`, fill: roof }, art);
    svg("polygon", { points: `${x + w * 0.18},172 ${x + w / 2},${172 - w * 0.65} ${x + w * 0.82},172`, fill: body }, art);
    svg("rect", { x: String(x + w / 2 - 9), y: String(172 - w * 0.35), width: "18", height: "16", fill: "#ffd98a" }, art);
  } else {
    const wallTop = 172 - 52;
    svg("rect", { x: String(x), y: String(wallTop), width: String(w), height: "52", fill: body }, art);
    svg("polygon", { points: `${x - 10},${wallTop} ${x + w / 2},${wallTop - 36} ${x + w + 10},${wallTop}`, fill: roof }, art);
    svg("rect", { x: String(x + w - 26), y: String(wallTop - 30), width: "10", height: "18", fill: "#6b5a4e" }, art);
    for (let wx = x + 10; wx < x + w - 30; wx += 26) svg("rect", { x: String(wx), y: String(wallTop + 12), width: "14", height: "14", fill: "#ffd98a" }, art);
    svg("rect", { x: String(x + w - 24), y: String(172 - 30), width: "14", height: "30", fill: roof }, art);
  }
  return art;
}

// ---------- prices ----------
function priceBlock(h) {
  const box = el("div", "price");
  if (h.offerTotalCents !== undefined) {
    box.append(el("strong", "", money(h.offerTotalCents)), el("span", "per", ` for ${plural(h.nights, "night")}`));
    if (h.platformTotalCents) box.append(el("s", "was", `${money(h.platformTotalCents)} on ${h.platformName}`));
  } else {
    box.append(el("span", "per", "from "), el("strong", "", dollars(h.fromNightlyCents)), el("span", "per", " / night"));
    if (h.fromPlatformNightlyCents) box.append(el("s", "was", `${dollars(h.fromPlatformNightlyCents)} on ${h.platformName}`));
  }
  return box;
}
const savingsBadge = (h) => {
  const ours = h.offerTotalCents ?? h.fromNightlyCents;
  const theirs = h.offerTotalCents !== undefined ? h.platformTotalCents : h.fromPlatformNightlyCents;
  return theirs ? el("span", "badge save", `${underPct(ours, theirs)}% less than ${h.platformName}`) : null;
};

// ---------- list + map ----------
function card(h) {
  const li = el("li", "card");
  li.dataset.id = h.listingId;
  const link = el("a", "card-link");
  link.href = `#/home/${encodeURIComponent(h.listingId)}`;
  const media = el("div", "media");
  media.append(homeArt(h));
  const badges = el("div", "badges");
  if (TIER_LABEL[h.tier]) badges.append(el("span", `badge ${h.tier}`, TIER_LABEL[h.tier]));
  const save = savingsBadge(h);
  if (save) badges.append(save);
  media.append(badges);
  link.append(media);
  const body = el("div", "card-body");
  body.append(el("h2", "", h.title), el("p", "town", h.town), el("p", "specs", specs(h)), priceBlock(h));
  if (h.reasons) body.append(el("p", "reason", h.reasons[0]));
  else if (h.feesCents > 0) body.append(el("p", "fees", `+ ${money(h.feesCents)} cleaning & fees per stay`));
  link.append(body);
  li.append(link);
  const highlight = (on) => pins.get(h.listingId)?.getElement()?.classList.toggle("active", on);
  li.addEventListener("mouseenter", () => highlight(true));
  li.addEventListener("mouseleave", () => highlight(false));
  return li;
}

function addPin(h) {
  if (!h.location) return;
  const label = el("span", "pin-label", dollars(h.offerTotalCents ?? h.fromNightlyCents));
  const marker = L.marker([h.location.lat, h.location.lng], {
    icon: L.divIcon({ className: "pin", html: label, iconSize: null }),
    title: h.title,
    keyboard: true,
  });
  marker.on("click", () => { location.hash = `#/home/${encodeURIComponent(h.listingId)}`; });
  marker.on("mouseover", () => grid.querySelector(`[data-id="${CSS.escape(h.listingId)}"]`)?.classList.add("active"));
  marker.on("mouseout", () => grid.querySelector(`[data-id="${CSS.escape(h.listingId)}"]`)?.classList.remove("active"));
  marker.addTo(map);
  pins.set(h.listingId, marker);
}

function bboxParam() {
  const b = map.getBounds();
  const r = (n) => n.toFixed(5);
  return [r(b.getWest()), r(b.getSouth()), r(b.getEast()), r(b.getNorth())].join(",");
}

async function run(append) {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (v !== "" && k !== "area") p.set(k, v);
  p.set("bbox", bboxParam());
  const dated = p.has("checkIn") && p.has("checkOut");
  if (p.has("checkIn") !== p.has("checkOut")) { statusEl.textContent = "Pick both check-in and check-out, or neither to see every home."; return; }
  if (append && cursor) p.set("cursor", cursor);
  searchArea.hidden = true;
  submit.disabled = more.disabled = true;
  statusEl.textContent = "Loading homes…";
  try {
    const res = await fetch(`/api/${dated ? "search" : "listings"}?${p}`);
    const body = await res.json();
    if (!res.ok) { statusEl.textContent = body.error; return; }
    if (!append) {
      grid.replaceChildren();
      for (const m of pins.values()) m.remove();
      pins = new Map();
    }
    const homes = dated ? body.results : body.listings;
    for (const h of homes) { grid.append(card(h)); addPin(h); }
    cursor = dated ? body.nextCursor : null;
    more.hidden = !cursor;
    const n = dated ? body.totalEligible : body.total;
    statusEl.textContent = n === 0
      ? "No homes in this part of the map. Zoom out, move the map, or try other dates."
      : dated
        ? `${plural(n, "home")} in this map area for your dates`
        : `${plural(n, "home")} in this map area. Add dates to see totals and how each compares with typical prices.`;
    clearDates.hidden = !dated;
  } catch {
    statusEl.textContent = "Couldn't reach Market Scope. Is the app still running?";
  } finally {
    submit.disabled = more.disabled = false;
  }
}

let moveTimer = null;
function onMapMoved() {
  if (!autoSearch.checked) { searchArea.hidden = false; return; }
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => run(false), 350);
}

function setUpMap() {
  map = L.map("map", { zoomControl: true, scrollWheelZoom: true });
  L.tileLayer(config.tiles.url, { attribution: config.tiles.attribution, maxZoom: 18 }).addTo(map);
  map.on("moveend", onMapMoved);
  map.on("dragstart zoomstart", () => { form.area.value = ""; });
}

function fitArea(id) {
  const m = config.markets.find((x) => x.id === id) ?? config.markets.find((x) => x.bounds);
  if (!m?.bounds) { map.setView([41.03, -75.56], 11); return; }
  map.fitBounds([[m.bounds.south, m.bounds.west], [m.bounds.north, m.bounds.east]]);
  form.area.value = m.id;
}

// ---------- detail view ----------
async function quote(home, out, f) {
  const p = new URLSearchParams({ market: home.market, checkIn: f.checkIn.value, checkOut: f.checkOut.value, guests: f.guests.value, pageSize: "50" });
  out.replaceChildren(el("p", "muted", "Checking…"));
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`/api/search?${p}`);
    const body = await res.json();
    if (!res.ok) { out.replaceChildren(el("p", "error", body.error)); return; }
    const r = body.results.find((x) => x.listingId === home.listingId);
    if (r) {
      const box = el("div", "quote-result");
      box.append(priceBlock(r));
      const badges = el("div", "badges inline");
      if (TIER_LABEL[r.tier]) badges.append(el("span", `badge ${r.tier}`, TIER_LABEL[r.tier]));
      const save = savingsBadge(r);
      if (save) badges.append(save);
      const ul = el("ul", "reasons");
      for (const reason of r.reasons) ul.append(el("li", "", reason));
      box.append(badges, ul);
      out.replaceChildren(box);
      return;
    }
    if (!body.nextCursor) break;
    p.set("cursor", body.nextCursor);
  }
  out.replaceChildren(el("p", "error", `Not available for those dates. Stays here are ${home.minNights}${home.maxNights ? `–${home.maxNights}` : "+"} nights; try other dates.`));
}

async function showDetail(id) {
  listView.hidden = true;
  detailView.hidden = false;
  detailView.replaceChildren(el("p", "status", "Loading…"));
  window.scrollTo(0, 0);
  const res = await fetch(`/api/listings/${encodeURIComponent(id)}`);
  const h = await res.json();
  const back = el("a", "back", "← Back to the map");
  back.href = "#/";
  if (!res.ok) { detailView.replaceChildren(back, el("p", "error", h.error)); return; }

  const hero = el("div", "hero-art");
  hero.append(homeArt(h));
  const head = el("div", "detail-head");
  head.append(el("h1", "", h.title), el("p", "town", `${h.town} · ${specs(h)}`));

  const about = el("div", "about");
  if (h.description) about.append(el("p", "", h.description));
  if (h.amenities.length) {
    const chips = el("ul", "chips");
    for (const a of h.amenities) chips.append(el("li", "", amenityName(a)));
    if (h.petsAllowed === true) chips.append(el("li", "", "Pets welcome"));
    about.append(el("h2", "", "What's here"), chips);
  }

  const table = el("table", "prices");
  table.append(el("caption", "", `Average price per night${h.feesCents ? `, plus ${money(h.feesCents)} cleaning & fees per stay` : ""}`));
  const thead = el("thead");
  const hr = el("tr");
  for (const t of ["Month", h.platformName ? `On ${h.platformName}` : null, "On Market Scope", h.platformName ? "You save" : null].filter(Boolean)) hr.append(el("th", "", t));
  thead.append(hr);
  const tbody = el("tbody");
  for (const m of h.months) {
    const tr = el("tr");
    tr.append(el("th", "", m.month));
    if (h.platformName) tr.append(el("td", "was-cell", m.platformNightlyCents ? dollars(m.platformNightlyCents) : "—"));
    tr.append(el("td", "now-cell", dollars(m.nightlyCents)));
    if (h.platformName) tr.append(el("td", "", m.platformNightlyCents ? dollars(m.platformNightlyCents - m.nightlyCents) : "—"));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const tableWrap = el("div", "table-wrap");
  tableWrap.append(table);

  const where = el("div", "mini-map");
  const whereNote = el("p", "muted small", "Approximate location. The host shares the exact address after you book.");

  const side = el("aside", "booking");
  side.append(el("p", "label", "Starting at"), priceBlock(h));
  const qf = el("form", "quote");
  qf.setAttribute("aria-label", "Check your dates");
  const field = (label, name, type, value) => {
    const l = el("label", "", label);
    const i = el("input");
    i.type = type; i.name = name; i.required = true;
    if (value) i.value = value;
    if (type === "date") i.min = isoDate(new Date());
    if (type === "number") { i.min = "1"; i.max = String(h.maxGuests); }
    l.append(i);
    return l;
  };
  qf.append(
    field("Check-in", "checkIn", "date", form.checkIn.value),
    field("Check-out", "checkOut", "date", form.checkOut.value),
    field("Guests", "guests", "number", form.guests.value),
    el("button", "", "Check price"),
  );
  const out = el("div", "quote-out");
  out.setAttribute("role", "status");
  qf.addEventListener("submit", (e) => { e.preventDefault(); quote(h, out, qf); });
  const book = el("a", "book", "Book on the host's site");
  book.href = h.bookingUrl;
  book.target = "_blank";
  book.rel = "noopener noreferrer";
  side.append(qf, out, book, el("p", "muted small", "You book and pay on the host's own site. Taxes may apply."));

  const layout = el("div", "detail");
  const main = el("div", "detail-main");
  main.append(head, about, el("h2", "", "Prices by month"), tableWrap);
  if (h.location) main.append(el("h2", "", "Where you'll be"), where, whereNote);
  layout.append(main, side);
  detailView.replaceChildren(back, hero, layout);

  if (h.location && config.tiles) {
    const small = L.map(where, { scrollWheelZoom: false }).setView([h.location.lat, h.location.lng], 13);
    L.tileLayer(config.tiles.url, { attribution: config.tiles.attribution, maxZoom: 16 }).addTo(small);
    L.circle([h.location.lat, h.location.lng], { radius: h.approxRadiusM, className: "approx-area" }).addTo(small);
  }
  if (qf.checkIn.value && qf.checkOut.value) quote(h, out, qf);
}

// ---------- routing & setup ----------
function route() {
  const m = /^#\/home\/(.+)$/.exec(location.hash);
  if (m) return showDetail(decodeURIComponent(m[1]));
  detailView.hidden = true;
  listView.hidden = false;
  map?.invalidateSize();
}

async function init() {
  form.checkIn.min = form.checkOut.min = isoDate(new Date());
  form.checkIn.addEventListener("change", () => {
    form.checkOut.min = form.checkIn.value;
    if (form.checkOut.value && form.checkOut.value <= form.checkIn.value) form.checkOut.value = "";
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); run(false); });
  form.area.addEventListener("change", () => { if (form.area.value) fitArea(form.area.value); });
  clearDates.addEventListener("click", () => { form.checkIn.value = form.checkOut.value = ""; run(false); });
  more.addEventListener("click", () => run(true));
  searchArea.addEventListener("click", () => run(false));
  autoSearch.addEventListener("change", () => { if (autoSearch.checked) run(false); });
  window.addEventListener("hashchange", route);

  try {
    config = await (await fetch("/api/markets")).json();
  } catch {
    statusEl.textContent = "Couldn't reach Market Scope. Is the app running?";
    return;
  }
  const fees = config.hostFeePct;
  if (fees) {
    $("#lede").textContent = `Hosts pay us ${fees.marketScope}% instead of ${fees.vrbo}–${fees.airbnb}% on Airbnb, Vrbo or Booking.com, so they list here for less. You book directly with the host.`;
  }
  for (const m of config.markets) form.area.append(new Option(m.name, m.id));
  setUpMap();
  if (!config.markets.length) statusEl.textContent = "No homes yet. Add data files to the inbox folder and refresh.";
  fitArea(config.markets[0]?.id); // the map's first moveend runs the first search
  route();
}
init();
