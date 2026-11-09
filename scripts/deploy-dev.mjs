// Build, then copy a dev build into an Obsidian vault's plugin folder with a dev version stamp.
// The stamp is "<next>-dev.<commit>[.dirty]", where <next> comes from the CHANGELOG's
// "## Unreleased (next: X)" heading. Only the copied manifest is stamped; the repo's manifest
// keeps the last released version.
//
// Usage: node scripts/deploy-dev.mjs <vault>/.obsidian/plugins/infinite-paper [--dry-run] [--no-build]
//        (or set INFINITE_PAPER_PLUGIN_DIR)
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), noBuild = args.includes("--no-build");
const dir = args.find((a) => !a.startsWith("--")) ?? process.env.INFINITE_PAPER_PLUGIN_DIR;
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();

const next = /^## Unreleased \(next: ([^)]+)\)/m.exec(readFileSync("CHANGELOG.md", "utf8"))?.[1];
if (!next) throw new Error('CHANGELOG.md needs a "## Unreleased (next: X.Y.Z)" heading');
const dirty = sh("git status --porcelain --untracked-files=no") !== "";
const version = `${next}-dev.${sh("git rev-parse --short HEAD")}${dirty ? ".dirty" : ""}`;

if (dry) { console.log(version); process.exit(0); }
if (!dir || !existsSync(dir)) throw new Error(`plugin folder not found: ${dir ?? "(none given)"}`);
if (!noBuild) execSync("npm run build", { stdio: "inherit" });
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
for (const f of ["main.js", "styles.css"]) copyFileSync(f, join(dir, f));
console.log(`deployed ${version} -> ${dir}`);
