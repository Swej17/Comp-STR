import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { scanInbox } from "./inbox.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = process.env.MARKET_SCOPE_DATA ?? join(root, "data");
const dirs = { inbox: join(dataDir, "inbox"), imported: join(dataDir, "imported"), failed: join(dataDir, "failed") };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const log = (m: string) => console.log(`[${new Date().toLocaleString()}] ${m}`);
const db = openDb(join(dataDir, "market-scope.db"));
const app = createApp({
  db,
  timeZone: process.env.MARKET_SCOPE_TZ ?? "America/New_York", // property-local "today" for Northeast US markets
  now: () => new Date(),
  publicDir: join(root, "server", "public"),
  log,
});

const tick = () => {
  try {
    if (scanInbox(db, dirs, new Date(), 2_000, log)) app.rebuild();
  } catch (e) {
    log(`Inbox scan failed: ${(e as Error).message}`);
  }
};
try { scanInbox(db, dirs, new Date(), 2_000, log); } catch (e) { log(`Inbox scan failed: ${(e as Error).message}`); }
app.rebuild();
setInterval(tick, 5_000);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1"; // local only; set HOST=0.0.0.0 to share on your network
createServer(app.handler).listen(port, host, () => {
  log(`Market Scope is running at http://localhost:${port}`);
  log(`Drop CSV files into ${dirs.inbox}`);
});
