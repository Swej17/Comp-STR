const form = document.getElementById("search");
const statusEl = document.getElementById("status");
const list = document.getElementById("results");
const more = document.getElementById("more");
const submit = form.querySelector("button[type=submit]");
const TIER_LABEL = { great: "Great value", good: "Good value" };
let cursor = null;

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };
const money = (cents) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(r) {
  const li = el("li", "card");
  const head = el("div", "card-head");
  const home = r.bedrooms === 0 ? "Studio" : `${r.bedrooms}-bedroom home`;
  head.append(el("h2", "", `${home} · sleeps ${r.maxGuests}`));
  if (TIER_LABEL[r.tier]) head.append(el("span", `badge ${r.tier}`, TIER_LABEL[r.tier]));
  li.append(head);

  const price = el("p", "price");
  price.append(el("strong", "", money(r.offerTotalCents)), ` for ${r.nights} night${r.nights === 1 ? "" : "s"}`);
  if (r.feesCents > 0) price.append(el("span", "muted", ` · includes ${money(r.feesCents)} in fees`));
  li.append(price);

  const reasons = el("ul", "reasons");
  for (const reason of r.reasons) reasons.append(el("li", "", reason));
  li.append(reasons);

  const book = el("a", "book", "View and book on the host's site");
  book.href = r.bookingUrl;
  book.target = "_blank";
  book.rel = "noopener noreferrer";
  li.append(book);
  return li;
}

async function run(append) {
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (v !== "") params.set(k, v);
  if (append && cursor) params.set("cursor", cursor);
  submit.disabled = more.disabled = true;
  statusEl.textContent = "Searching…";
  try {
    const res = await fetch(`/api/search?${params}`);
    const body = await res.json();
    if (!res.ok) { statusEl.textContent = body.error; return; }
    if (!append) list.replaceChildren();
    for (const r of body.results) list.append(card(r));
    cursor = body.nextCursor;
    more.hidden = !cursor;
    const n = body.totalEligible;
    statusEl.textContent = n === 0
      ? "No homes match these dates and filters. Try other dates or fewer filters."
      : `${n} home${n === 1 ? "" : "s"} available in ${body.marketName}`;
  } catch {
    statusEl.textContent = "Couldn't reach Market Scope. Is the app still running?";
  } finally {
    submit.disabled = more.disabled = false;
  }
}

async function init() {
  form.checkIn.min = form.checkOut.min = isoDate(new Date());
  form.checkIn.value = plusDays(14);
  form.checkOut.value = plusDays(17);
  form.checkIn.addEventListener("change", () => {
    form.checkOut.min = form.checkIn.value;
    if (form.checkOut.value <= form.checkIn.value) {
      const d = new Date(`${form.checkIn.value}T12:00`); d.setDate(d.getDate() + 2); form.checkOut.value = isoDate(d);
    }
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); run(false); });
  more.addEventListener("click", () => run(true));

  try {
    const { markets } = await (await fetch("/api/markets")).json();
    for (const m of markets) form.market.append(new Option(m.name, m.id));
    if (markets.length) run(false);
    else statusEl.textContent = "No areas yet. Add data files to the inbox folder and refresh.";
  } catch {
    statusEl.textContent = "Couldn't reach Market Scope. Is the app running?";
  }
}
init();
