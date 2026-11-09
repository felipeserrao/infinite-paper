import esbuild from "esbuild";
import { builtinModules } from "node:module";
const prod = process.argv[2] === "production";
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  // If the module itself throws while loading, fall back to a stub plugin that reports the error.
  banner: { js: "try {" },
  footer: { js: `} catch (e) {
  const o = require("obsidian");
  const msg = "Infinite Paper failed to load: " + (e && e.message) + "\\n" + (e && e.stack);
  console.error(msg);
  module.exports = class extends o.Plugin { async onload() { new o.Notice(msg, 0); } };
}` },
});
if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
