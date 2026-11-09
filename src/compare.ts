/**
 * Dev check: does Ink show a tldraw note the same way tldraw does?
 *
 * tldraw exports the page as a PNG (its own renderer); Ink paints the strokes it imported from the same note
 * over the exact same area and scale (our renderer, current smoothness switches). Each pixel is "ink" when it is
 * dark/saturated enough. We report pixels only one side has, and how far each such pixel is from the nearest
 * ink on the other side (chamfer distance transform) — "no line more than N px off" is the useful bar, since
 * anti-aliasing alone makes a perfect pixel match impossible.
 *
 * Writes into outDir: overlay.png (black both, red only tldraw, blue only Ink), overview.png (downscaled),
 * worst-N.png crops, tldraw.png, ink.png, stats.json. Desktop only (uses fs).
 */
import { App, TFile, WorkspaceLeaf } from "obsidian";
import { Store, paintStroke } from "./store";
import { importTldraw } from "./tldraw-import";
import { exp, expLabel, Exp } from "./exp";

const PAD = 32;

export interface CompareStats {
	note: string; width: number; height: number; scale: number; inkMode: string;
	tldrawShapes: number; inkStrokes: number;
	inkPxTldraw: number; inkPxInk: number; onlyTldraw: number; onlyInk: number;
	/** share of all ink pixels (union) that only one side has */
	mismatchPct: number;
	/** how far mismatched pixels are from the other side's ink, in px at this scale */
	distHist: Record<string, number>; maxDist: number; p99Dist: number;
	notShownByInk: Record<string, number>;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined, ms: number): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() > end) throw new Error("timed out");
		await sleep(100);
	}
}

/** the few Node APIs used here (desktop Obsidian only), typed without needing @types/node */
interface NodeFs { mkdirSync(path: string, opts: { recursive: boolean }): void; writeFileSync(path: string, data: Uint8Array | string): void }
interface NodePath { join(...parts: string[]): string }
interface NodeOs { tmpdir(): string }
interface NodeRequire { (m: "fs"): NodeFs; (m: "path"): NodePath; (m: "os"): NodeOs }
export const nodeRequire = (window as unknown as { require: NodeRequire }).require;

/** the parts of tldraw's editor this check uses */
interface TldrawEditor {
	getCurrentPageShapeIds(): Set<string>;
	getShapesPageBounds(ids: string[]): { x: number; y: number; w: number; h: number };
	toImage(ids: string[], opts: { format: "png"; background: boolean; padding: number; scale: number }): Promise<{ blob: Blob; width: number; height: number }>;
}

function toPng(c: HTMLCanvasElement): Promise<Uint8Array> {
	return new Promise((res, rej) => c.toBlob((b) => {
		if (!b) { rej(new Error("toBlob failed")); return; }
		b.arrayBuffer().then((buf) => res(new Uint8Array(buf)), rej);
	}, "image/png"));
}

/** 1 where the pixel is ink: dark, or clearly coloured (red/blue pens) */
function mask(d: Uint8ClampedArray, n: number): Uint8Array {
	const m = new Uint8Array(n);
	for (let i = 0, j = 0; i < n; i++, j += 4) {
		const r = d[j], g = d[j + 1], b = d[j + 2], a = d[j + 3];
		if (a < 128) continue;
		const lum = 0.299 * r + 0.587 * g + 0.114 * b;
		const sat = Math.max(r, g, b) - Math.min(r, g, b);
		if (lum < 140 || sat > 90) m[i] = 1;
	}
	return m;
}

/** chamfer 3-4 distance to the nearest set pixel, in units of 1/3 px (Uint16, capped) */
function distance(m: Uint8Array, w: number, h: number): Uint16Array {
	const INF = 65000, d = new Uint16Array(w * h);
	for (let i = 0; i < d.length; i++) d[i] = m[i] ? 0 : INF;
	const relax = (i: number, j: number, c: number) => { const v = d[j] + c; if (v < d[i]) d[i] = v; };
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = y * w + x;
		if (!d[i]) continue;
		if (x > 0) relax(i, i - 1, 3);
		if (y > 0) { relax(i, i - w, 3); if (x > 0) relax(i, i - w - 1, 4); if (x < w - 1) relax(i, i - w + 1, 4); }
	}
	for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
		const i = y * w + x;
		if (!d[i]) continue;
		if (x < w - 1) relax(i, i + 1, 3);
		if (y < h - 1) { relax(i, i + w, 3); if (x < w - 1) relax(i, i + w + 1, 4); if (x > 0) relax(i, i + w - 1, 4); }
	}
	return d;
}

export async function compareWithTldraw(app: App, file: TFile, outDir: string, scale = 1, override?: Partial<Exp>): Promise<CompareStats> {
	const prev = { ...exp };
	if (override) Object.assign(exp, override); // this run only, not saved
	try { return await run(app, file, outDir, scale); } finally { Object.assign(exp, prev); }
}

async function run(app: App, file: TFile, outDir: string, scale: number): Promise<CompareStats> {
	const fs = nodeRequire("fs");
	const path = nodeRequire("path");
	fs.mkdirSync(outDir, { recursive: true });

	// 1. tldraw's own render, from its view
	const leaf: WorkspaceLeaf = app.workspace.getLeaf("tab");
	let tl: { blob: Blob; width: number; height: number }, bounds: { x: number; y: number; w: number; h: number }, nShapes: number;
	try {
		await leaf.setViewState({ type: "tldraw-view", state: { file: file.path, manuallyTriggered: true, inkBypass: true }, active: true });
		const view = leaf.view as unknown as { getEditor?: () => TldrawEditor | undefined };
		const editor = await waitFor(() => view.getEditor?.(), 15000);
		await waitFor(() => editor.getCurrentPageShapeIds().size > 0 || null, 15000);
		await sleep(500);
		const ids = [...editor.getCurrentPageShapeIds()];
		nShapes = ids.length;
		const b = editor.getShapesPageBounds(ids);
		bounds = { x: b.x, y: b.y, w: b.w, h: b.h };
		tl = await editor.toImage(ids, { format: "png", background: true, padding: PAD, scale });
	} finally {
		leaf.detach();
	}

	// 2. Ink's render of the same area
	const r = importTldraw(await app.vault.read(file));
	const bmp = await createImageBitmap(tl.blob); // its real pixel size (tldraw reports fractional sizes)
	const W = bmp.width, H = bmp.height;
	const inkC = createEl("canvas"); inkC.width = W; inkC.height = H;
	const ictx = inkC.getContext("2d")!;
	ictx.fillStyle = "#fff"; ictx.fillRect(0, 0, W, H);
	// image width = (bounds.w + 2 PAD) * scale; derive the exact factor from it in case tldraw rounded
	const sx = W / (bounds.w + 2 * PAD), sy = H / (bounds.h + 2 * PAD);
	ictx.setTransform(sx, 0, 0, sy, -(bounds.x - PAD) * sx, -(bounds.y - PAD) * sy);
	const st = new Store();
	for (const s of r.strokes) paintStroke(ictx, st.create(s.color, s.size, s.pts));
	ictx.setTransform(1, 0, 0, 1, 0, 0);

	const tlC = createEl("canvas"); tlC.width = W; tlC.height = H;
	const tctx = tlC.getContext("2d")!;
	tctx.drawImage(bmp, 0, 0);

	// 3. diff
	const n = W * H;
	const mT = mask(tctx.getImageData(0, 0, W, H).data, n);
	const mI = mask(ictx.getImageData(0, 0, W, H).data, n);
	const dT = distance(mT, W, H), dI = distance(mI, W, H);
	const hist: Record<string, number> = { "≤1": 0, "1–2": 0, "2–3": 0, "3–5": 0, "5–10": 0, ">10": 0 };
	const dists: number[] = [];
	let inT = 0, inI = 0, onlyT = 0, onlyI = 0, maxD = 0;
	const ov = tctx.createImageData(W, H), o = ov.data;
	const TILE = 512, tw = Math.ceil(W / TILE), th = Math.ceil(H / TILE), tileBad = new Float64Array(tw * th);
	for (let i = 0; i < n; i++) {
		const a = mT[i], b = mI[i];
		inT += a; inI += b;
		let c = [255, 255, 255];
		if (a && b) c = [40, 40, 40];
		else if (a || b) {
			const dpx = (a ? dI[i] : dT[i]) / 3; // distance to the other side's ink
			if (a) { onlyT++; c = [230, 40, 40]; } else { onlyI++; c = [40, 90, 230]; }
			if (dpx > maxD) maxD = dpx;
			if (dists.length < 2e6) dists.push(dpx);
			hist[dpx <= 1 ? "≤1" : dpx <= 2 ? "1–2" : dpx <= 3 ? "2–3" : dpx <= 5 ? "3–5" : dpx <= 10 ? "5–10" : ">10"]++;
			if (dpx > 1.5) tileBad[Math.floor((i % W) / TILE) + Math.floor(i / W / TILE) * tw] += dpx;
		}
		o[i * 4] = c[0]; o[i * 4 + 1] = c[1]; o[i * 4 + 2] = c[2]; o[i * 4 + 3] = 255;
	}
	dists.sort((x, y) => x - y);
	const union = inT + inI - (inT - onlyT);

	const ovC = createEl("canvas"); ovC.width = W; ovC.height = H;
	ovC.getContext("2d")!.putImageData(ov, 0, 0);
	fs.writeFileSync(path.join(outDir, "overlay.png"), await toPng(ovC));
	fs.writeFileSync(path.join(outDir, "tldraw.png"), await toPng(tlC));
	fs.writeFileSync(path.join(outDir, "ink.png"), await toPng(inkC));
	const k = Math.min(1, 1400 / Math.max(W, H));
	const sm = createEl("canvas"); sm.width = Math.round(W * k); sm.height = Math.round(H * k);
	const smx = sm.getContext("2d")!; smx.imageSmoothingQuality = "high"; smx.drawImage(ovC, 0, 0, sm.width, sm.height);
	fs.writeFileSync(path.join(outDir, "overview.png"), await toPng(sm));
	// the three tiles with the most off-by-more-than-1.5px ink, at full resolution
	const order = [...tileBad.keys()].sort((a, b) => tileBad[b] - tileBad[a]).slice(0, 3).filter((t) => tileBad[t] > 0);
	const worst: { file: string; x: number; y: number; score: number }[] = [];
	for (const [j, t] of order.entries()) {
		const x = (t % tw) * TILE, y = Math.floor(t / tw) * TILE;
		const c = createEl("canvas"); c.width = Math.min(TILE, W - x) * 2 + 8; c.height = Math.min(TILE, H - y);
		const cx = c.getContext("2d")!; cx.fillStyle = "#ccc"; cx.fillRect(0, 0, c.width, c.height);
		const cw = Math.min(TILE, W - x);
		cx.drawImage(ovC, x, y, cw, c.height, 0, 0, cw, c.height);   // left: overlay
		cx.drawImage(tlC, x, y, cw, c.height, cw + 8, 0, cw, c.height); // right: tldraw alone
		const name = `worst-${j + 1}.png`;
		fs.writeFileSync(path.join(outDir, name), await toPng(c));
		worst.push({ file: name, x, y, score: Math.round(tileBad[t]) });
	}

	const stats: CompareStats = {
		note: file.path, width: W, height: H, scale, inkMode: expLabel() + (exp.centerline ? "" : " (filled outline)"),
		tldrawShapes: nShapes, inkStrokes: r.strokes.length,
		inkPxTldraw: inT, inkPxInk: inI, onlyTldraw: onlyT, onlyInk: onlyI,
		mismatchPct: union ? Math.round(((onlyT + onlyI) / union) * 10000) / 100 : 0,
		distHist: hist, maxDist: Math.round(maxD * 10) / 10,
		p99Dist: dists.length ? Math.round(dists[Math.floor(dists.length * 0.99)] * 10) / 10 : 0,
		notShownByInk: r.skipped,
	};
	fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify({ ...stats, worst }, null, 2));
	return stats;
}
