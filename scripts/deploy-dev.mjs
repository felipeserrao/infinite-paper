// Build a test version and copy it into an Obsidian vault's plugin folder.
//
// The version gets a readable name: "<next>-<goal>[+<goal>…].<n>", e.g. "1.1.0-unlink-box.3".
//   <next>  the version in CHANGELOG.md's "## Unreleased (next: X)" heading
//   <goal>  what the work is for, in a few words (--part "unlink box:gtd-42"; repeat for a build
//           that combines several pieces of work). On the "dev" branch it defaults to the goal
//           branches merged into dev and not yet into main.
//   <n>     counts test builds in that folder: one more than the build it replaces
// Only the copied manifest gets this name; the repo's manifest keeps the last released version.
// The same details (number, date, parts, commit) are built into main.js and shown at the bottom
// of the plugin's settings tab.
//
// Usage:
//   node scripts/deploy-dev.mjs <plugin folder> --part "<goal>[:<who>]" [--part …] [--log <file.md>]
//                               [--dry-run] [--no-build]
//   <plugin folder> can also come from INFINITE_PAPER_PLUGIN_DIR.
//   --log appends one line per build to a markdown file.
import { execSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const values = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]] : []));
const taken = new Set(argv.flatMap((a, i) => (a === "--part" || a === "--log" ? [i + 1] : [])));
const dir = argv.find((a, i) => !a.startsWith("--") && !taken.has(i)) ?? process.env.INFINITE_PAPER_PLUGIN_DIR;
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();

let parts = values("--part").map((p) => {
	const [goal, who] = p.split(":").map((s) => s.trim());
	return { goal, who: who || "" };
});
// On the shared test branch "dev", the parts default to the goal branches merged into dev but not
// yet into main. A branch's session comes from `git config branch.<name>.session <who>`.
if (!parts.length && sh("git rev-parse --abbrev-ref HEAD") === "dev") {
	parts = sh("git for-each-ref --merged dev --no-merged main --format='%(refname:short)' refs/heads")
		.split("\n").filter((b) => b && b !== "dev" && b !== "main")
		.map((b) => {
			let who = "";
			try { who = sh(`git config branch.${b}.session`); } catch { /* not set */ }
			return { goal: b.replace(/-/g, " "), who };
		});
}
if (!parts.length || parts.some((p) => !p.goal)) throw new Error('give the goal: --part "unlink box[:session]"');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const next = /^## Unreleased \(next: ([^)]+)\)/m.exec(readFileSync("CHANGELOG.md", "utf8"))?.[1];
if (!next) throw new Error('CHANGELOG.md needs a "## Unreleased (next: X.Y.Z)" heading');
if (!dir || !existsSync(dir)) throw new Error(`plugin folder not found: ${dir ?? "(none given)"}`);

let prev = 0;
try { prev = Number(/^\d+\.\d+\.\d+-(?!dev\.)[^.]+\.(\d+)$/.exec(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version)?.[1] ?? 0); } catch { /* first build */ }
const n = prev + 1;
const version = `${next}-${parts.map((p) => slug(p.goal)).join("+")}.${n}`;
const now = new Date(), pad = (x) => String(x).padStart(2, "0");
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const branch = sh("git rev-parse --abbrev-ref HEAD"), commit = sh("git rev-parse --short HEAD");
const dirty = sh("git status --porcelain --untracked-files=no") !== "";
const build = { n, version, date, parts, branch, commit, dirty };

if (flag("--dry-run")) { console.log(JSON.stringify(build, null, 2)); process.exit(0); }
if (!flag("--no-build")) {
	execSync("npm run build", { stdio: "inherit", env: { ...process.env, INFINITE_PAPER_BUILD: JSON.stringify(build) } });
}
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
for (const f of ["main.js", "styles.css"]) copyFileSync(f, join(dir, f));

const who = parts.map((p) => p.goal + (p.who ? ` (${p.who})` : "")).join(", ");
for (const log of values("--log")) {
	appendFileSync(log, `- ${date} · \`${version}\` · ${who} · ${branch}@${commit}${dirty ? " + uncommitted changes" : ""}\n`);
}
console.log(`deployed ${version} -> ${dir}`);
