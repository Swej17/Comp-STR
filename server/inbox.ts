import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordImport, saveMarketNames, saveObservations, saveOffers, tx, wasImported, type Db } from "./db.ts";
import { ImportError, parseImport } from "./importer.ts";

export type Dirs = { inbox: string; imported: string; failed: string };

/**
 * Import every finished CSV in the inbox, oldest name first. Good files move to imported/,
 * bad files to failed/ with a .errors.txt next to them. Returns true if price observations changed.
 */
export function scanInbox(db: Db, dirs: Dirs, now: Date, minAgeMs = 2_000, log: (m: string) => void = console.log): boolean {
  let observationsChanged = false;
  const names = readdirSync(dirs.inbox).filter((n) => n.toLowerCase().endsWith(".csv")).sort();
  for (const name of names) {
    const path = join(dirs.inbox, name);
    const at = now.toISOString();
    const stamped = `${at.replace(/[:.]/g, "-")}-${name}`;
    let content: string;
    try {
      if (now.getTime() - statSync(path).mtimeMs < minAgeMs) continue; // still being copied in
      content = readFileSync(path, "utf8");
    } catch {
      continue; // locked (e.g. open in Excel) or gone; try again next scan
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    try {
      if (wasImported(db, sha256)) {
        recordImport(db, { file: name, sha256, kind: null, rows: 0, status: "duplicate", problems: null, importedAt: at });
        renameSync(path, join(dirs.imported, stamped));
        log(`Skipped ${name}: identical to a file already imported`);
        continue;
      }
      const parsed = parseImport(content, at);
      const rows = parsed.kind === "observations" ? parsed.observations.length : parsed.offers.length;
      tx(db, () => {
        if (parsed.kind === "observations") saveObservations(db, parsed.observations);
        else saveOffers(db, parsed.offers);
        saveMarketNames(db, parsed.marketNames);
        recordImport(db, { file: name, sha256, kind: parsed.kind, rows, status: "imported", problems: null, importedAt: at });
      });
      if (parsed.kind === "observations") observationsChanged = true;
      renameSync(path, join(dirs.imported, stamped));
      log(`Imported ${name}: ${rows} ${parsed.kind === "offers" ? "listings" : "price observations"}`);
    } catch (e) {
      const problems = e instanceof ImportError ? e.problems : [`Unexpected error: ${(e as Error).message}`];
      const shown = problems.length > 200 ? [...problems.slice(0, 200), `…and ${problems.length - 200} more`] : problems;
      try {
        recordImport(db, { file: name, sha256, kind: null, rows: 0, status: "failed", problems: shown.slice(0, 5).join("\n"), importedAt: at });
        renameSync(path, join(dirs.failed, stamped));
        writeFileSync(join(dirs.failed, `${stamped}.errors.txt`),
          `Nothing from ${name} was imported. Fix these, then drop the file in the inbox again:\n\n${shown.join("\n")}\n`);
      } catch (moveError) {
        log(`Could not move ${name} to failed/: ${(moveError as Error).message}`);
      }
      log(`Rejected ${name}: ${problems.length} problem(s), see failed/${stamped}.errors.txt`);
    }
  }
  return observationsChanged;
}
