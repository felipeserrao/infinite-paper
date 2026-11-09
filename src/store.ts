import { getStroke, getStrokePoints } from "perfect-freehand";
import { exp } from "./exp";
import { deflateSync, inflateSync } from "fflate";

export interface Rect { x0: number; y0: number; x1: number; y1: number; }

export interface Stroke {
	id: number;
	color: string;
	size: number;
	/** world points, interleaved x,y */
	pts: Float32Array;
	bbox: Rect;
	/** cached outline, built lazily */
	path?: Path2D;
	/** cached centerline (exp.centerline), built lazily */
	cpath?: Path2D;
	/** cached encoded points for saving (varints, see encodePointBytes) */
	enc?: Uint8Array;
	/** which saved chunk this stroke belongs to (assigned on first save) */
	chunk?: number;
	/** compact ink: pts are already smoothed and simplified (drawn without streamline, saved at 1 px) */
	smooth?: boolean;
	/** query dedupe stamp */
	stamp: number;
	/** a link box instead of ink: pts = two opposite corners, size = border width */
	link?: LinkInfo;
	/** wrapped label lines, built lazily (label never changes in place) */
	lines?: string[];
}

export interface LinkInfo {
	/** wikilink text, as in [[target]] */
	target: string;
	/** shown after the 🔗 */
	label: string;
	/** drawn around handwriting: the ink is the label, the note name is a small caption at the top */
	frame?: boolean;
}

/** tldraw's link box: 240 x 240, label centered */
export const LINK_BOX = 240;
export const LINK_BORDER = 3.5;
const LINK_FONT = 24;

// tldraw's pen settings with pressure off (solidRealPressureSettings).
export function freehandOptions(size: number, last: boolean, smooth = false) {
	return {
		size,
		thinning: 0,
		streamline: smooth ? 0 : exp.streamline,
		smoothing: 0.62,
		simulatePressure: false,
		last,
	};
}

export function outlineToPath(outline: number[][]): Path2D {
	const p = new Path2D();
	const n = outline.length;
	if (n < 2) return p;
	// quadratic midpoints, same as perfect-freehand's recommended SVG path
	p.moveTo(outline[0][0], outline[0][1]);
	for (let i = 0; i < n; i++) {
		const a = outline[i], b = outline[(i + 1) % n];
		p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
	}
	p.closePath();
	return p;
}

function rawInput(pts: ArrayLike<number>): number[][] {
	const input: number[][] = [];
	for (let i = 0; i < pts.length; i += 2) input.push([pts[i], pts[i + 1], 0.5]);
	return input;
}

function rawPoints(pts: ArrayLike<number>): number[][] {
	const out: number[][] = [];
	for (let i = 0; i < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
	return out;
}

/** compact ink: points within this distance (world units) of the smoothed line are dropped */
export const COMPACT_TOLERANCE = 0.5;

function simplify(p: number[][], e: number): number[][] {
	if (p.length < 3) return p;
	const a = p[0], b = p[p.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
	let dm = 0, k = 0;
	for (let i = 1; i < p.length - 1; i++) {
		const d = L ? Math.abs(dy * (p[i][0] - a[0]) - dx * (p[i][1] - a[1])) / L : Math.hypot(p[i][0] - a[0], p[i][1] - a[1]);
		if (d > dm) { dm = d; k = i; }
	}
	return dm > e ? simplify(p.slice(0, k + 1), e).slice(0, -1).concat(simplify(p.slice(k), e)) : [a, b];
}

/**
 * Compact ink: the stroke's smoothed line (what is drawn on screen), points within COMPACT_TOLERANCE of it
 * dropped, rounded to whole units. Drawn with streamline off, it looks the same within about 1 px.
 */
export function compactPoints(pts: ArrayLike<number>, size: number): Float32Array {
	const P = getStrokePoints(toInput(pts, size), freehandOptions(size, true)).map((p) => p.point);
	if (!P.length) return Float32Array.from(pts);
	const S = simplify(P, COMPACT_TOLERANCE);
	const out: number[] = [];
	for (const [x, y] of S) {
		const rx = Math.round(x), ry = Math.round(y);
		if (out.length && out[out.length - 2] === rx && out[out.length - 1] === ry) continue;
		out.push(rx, ry);
	}
	if (out.length === 2) out.push(out[0], out[1]); // a dot keeps two points
	return Float32Array.from(out);
}

/** world points -> perfect-freehand input; with exp.tlFilter, strip start/end points within size/3 like tldraw's freehand */
function toInput(pts: ArrayLike<number>, size: number): number[][] {
	const input: number[][] = [];
	for (let i = 0; i < pts.length; i += 2) input.push([pts[i], pts[i + 1], 0.5]);
	if (exp.tlFilter && input.length > 2) {
		const r2 = (size / 3) ** 2, d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
		while (input.length > 2 && d2(input[1], input[0]) <= r2) input.splice(1, 1);
		while (input.length > 2 && d2(input[input.length - 2], input[input.length - 1]) <= r2) input.splice(input.length - 2, 1);
	}
	return input;
}

export function strokeOutline(pts: ArrayLike<number>, size: number, last: boolean, smooth = false): number[][] {
	return getStroke(smooth ? rawInput(pts) : toInput(pts, size), freehandOptions(size, last, smooth));
}

/**
 * tldraw's own point smoothing (tldraw 3.15 shared/freehand/getStrokePoints), switch 8. Differences from the
 * perfect-freehand package: the last point is repeated so the smoothed line catches up to the pen, and only the
 * first few points (i < 4) are skipped while the stroke is shorter than `size`. Trimming points within size/3
 * of the start/end is tldraw's too, but stays under switch 4 (tlFilter) so it can be tested on its own.
 */
export function tlStrokePoints(pts: ArrayLike<number>, size: number, streamline: number, last: boolean, trimEnds: boolean): number[][] {
	const n = pts.length >> 1;
	if (n === 0) return [];
	const t = 0.15 + (1 - streamline) * 0.85;
	const P: number[][] = [];
	for (let i = 0; i < n; i++) P.push([pts[i * 2], pts[i * 2 + 1]]);
	if (trimEnds) {
		const r2 = (size / 3) ** 2, d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
		while (P.length > 1 && d2(P[1], P[0]) <= r2) P.splice(1, 1);
		const end = P.pop()!;
		while (P.length && d2(P[P.length - 1], end) <= r2) P.pop();
		P.push(end);
	}
	// tldraw: isComplete is true for any stroke without simulated pressure, so the last point is always repeated
	const end = P[P.length - 1];
	if (streamline > 0) P.push([end[0], end[1]]);
	const out: number[][] = [P[0]];
	let prev = P[0], total = 0;
	for (let i = 1, m = P.length; i < m; i++) {
		const q = P[i];
		const pt = !t || (last && i === m - 1) ? [q[0], q[1]] : [prev[0] + (q[0] - prev[0]) * t, prev[1] + (q[1] - prev[1]) * t];
		if (pt[0] === prev[0] && pt[1] === prev[1]) continue;
		total += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
		if (i < 4 && total < size) continue;
		out.push(pt); prev = pt;
	}
	return out;
}

/** round-pen centerline (switch 5). Points: perfect-freehand, or tldraw's with switch 8. Curves: through the
 *  midpoints with each sample point as control, or tldraw's mirrored controls with switch 9. */
export function centerlinePath(pts: ArrayLike<number>, size: number, last: boolean, smooth = false): Path2D {
	const P = smooth ? rawPoints(pts) : exp.tlPoints
		? tlStrokePoints(pts, size, exp.streamline, last, exp.tlFilter)
		: getStrokePoints(toInput(pts, size), freehandOptions(size, last)).map((p) => p.point);
	const path = new Path2D();
	const n = P.length;
	if (n === 0) return path;
	if (n === 1) { path.moveTo(P[0][0], P[0][1]); path.lineTo(P[0][0] + 0.01, P[0][1]); return path; }
	path.moveTo(P[0][0], P[0][1]);
	if (exp.tlCurve) {
		// M p0 Q p1 mid(p1,p2) T mid(p2,p3) … L last; T's control mirrors the previous control through the current point
		if (n === 2) { path.lineTo(P[1][0], P[1][1]); return path; }
		let cx = P[1][0], cy = P[1][1];
		let ex = (P[1][0] + P[2][0]) / 2, ey = (P[1][1] + P[2][1]) / 2;
		path.quadraticCurveTo(cx, cy, ex, ey);
		for (let i = 2; i < n - 1; i++) {
			cx = 2 * ex - cx; cy = 2 * ey - cy;
			ex = (P[i][0] + P[i + 1][0]) / 2; ey = (P[i][1] + P[i + 1][1]) / 2;
			path.quadraticCurveTo(cx, cy, ex, ey);
		}
		path.lineTo(P[n - 1][0], P[n - 1][1]);
		return path;
	}
	if (n < 4) { for (let i = 1; i < n; i++) path.lineTo(P[i][0], P[i][1]); return path; }
	path.quadraticCurveTo(P[1][0], P[1][1], (P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2);
	for (let i = 2; i < n - 1; i++) path.quadraticCurveTo(P[i][0], P[i][1], (P[i][0] + P[i + 1][0]) / 2, (P[i][1] + P[i + 1][1]) / 2);
	path.lineTo(P[n - 1][0], P[n - 1][1]);
	return path;
}

/** last streamlined point vs last pen point (world units): how far the ink trails the pen */
export function tailLag(pts: ArrayLike<number>, size: number): number {
	const n = pts.length;
	if (n < 4) return 0;
	const P = getStrokePoints(toInput(pts, size), freehandOptions(size, false));
	const e = P[P.length - 1]?.point;
	return e ? Math.hypot(e[0] - pts[n - 2], e[1] - pts[n - 1]) : 0;
}

export function getPath(s: Stroke): Path2D {
	if (!s.path) s.path = outlineToPath(strokeOutline(s.pts, s.size, true, s.smooth));
	return s.path;
}

/** draw a finished stroke in the current mode (ctx transform already set to world) */
export function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
	if (s.link) { paintLink(ctx, s); return; }
	if (exp.centerline) {
		if (!s.cpath) s.cpath = centerlinePath(s.pts, s.size, true, s.smooth);
		ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = "round"; ctx.lineJoin = "round";
		ctx.stroke(s.cpath);
	} else {
		ctx.fillStyle = s.color;
		ctx.fill(getPath(s));
	}
}

/** link box: rounded rectangle + "🔗 label", wrapped to the box width. Few per drawing, painted into tiles like ink. */
function paintLink(ctx: CanvasRenderingContext2D, s: Stroke) {
	const p = s.pts;
	const x0 = Math.min(p[0], p[2]), x1 = Math.max(p[0], p[2]), y0 = Math.min(p[1], p[3]), y1 = Math.max(p[1], p[3]);
	const w = x1 - x0, h = y1 - y0;
	ctx.lineWidth = s.size; ctx.strokeStyle = s.color; ctx.lineJoin = "round";
	ctx.beginPath();
	if (typeof ctx.roundRect === "function") ctx.roundRect(x0, y0, w, h, 12); else ctx.rect(x0, y0, w, h);
	ctx.stroke();
	if (s.link!.frame) {
		// caption: note name, small, top-left inside the border, one line cut to the box width
		const f = 16;
		ctx.font = `600 ${f}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
		if (!s.lines) s.lines = wrapText(ctx, "🔗 " + s.link!.label, Math.max(40, w - 20)).slice(0, 1);
		ctx.fillStyle = s.color; ctx.textAlign = "left"; ctx.textBaseline = "top";
		ctx.fillText(s.lines[0] ?? "", x0 + 10, y0 + 8);
		return;
	}
	ctx.font = `${LINK_FONT}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
	if (!s.lines) s.lines = wrapText(ctx, "🔗 " + s.link!.label, w - 24);
	const lh = LINK_FONT * 1.3, top = y0 + h / 2 - ((s.lines.length - 1) * lh) / 2;
	ctx.fillStyle = s.color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
	s.lines.forEach((line, i) => ctx.fillText(line, x0 + w / 2, top + i * lh));
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
	const out: string[] = [];
	let cur = "";
	for (const word of text.split(/\s+/)) {
		const next = cur ? cur + " " + word : word;
		if (!cur || ctx.measureText(next).width <= maxW) { cur = next; continue; }
		out.push(cur); cur = word;
	}
	if (cur) out.push(cur);
	// a single long word: cut it so it stays inside the box
	const res: string[] = [];
	for (const l of out) {
		if (ctx.measureText(l).width <= maxW) { res.push(l); continue; }
		let c = "";
		for (const ch of Array.from(l)) { if (c && ctx.measureText(c + ch).width > maxW) { res.push(c); c = ch; } else c += ch; }
		if (c) res.push(c);
	}
	return res;
}

export function computeBBox(pts: Float32Array, size: number): Rect {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let i = 0; i < pts.length; i += 2) {
		const x = pts[i], y = pts[i + 1];
		if (x < x0) x0 = x; if (x > x1) x1 = x;
		if (y < y0) y0 = y; if (y > y1) y1 = y;
	}
	const pad = size;
	return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export function rectsOverlap(a: Rect, b: Rect) {
	return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

// ---------- encoding: quantized (1/4 px), delta, zigzag varint ----------
const Q = 4;

function writeVar(out: number[], v: number) {
	let z = v >= 0 ? v * 2 : -v * 2 - 1;
	while (z >= 0x80) { out.push((z & 0x7f) | 0x80); z = Math.floor(z / 128); }
	out.push(z);
}

/** unsigned varint */
function writeU(out: number[], z: number) {
	while (z >= 0x80) { out.push((z & 0x7f) | 0x80); z = Math.floor(z / 128); }
	out.push(z);
}

function readU(b: Uint8Array, at: { i: number }): number {
	let z = 0, mul = 1;
	for (;;) {
		const c = b[at.i++];
		z += (c & 0x7f) * mul;
		if (!(c & 0x80)) return z;
		mul *= 128;
	}
}

/** units per world unit when saving: 4 (1/4 px), or 1 for compact ink */
export function quantOf(s: { smooth?: boolean }) { return s.smooth ? 1 : Q; }

/** zigzag varint */
function readS(b: Uint8Array, at: { i: number }): number {
	const z = readU(b, at);
	return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
}

export function encodePointBytes(pts: Float32Array, q = Q): Uint8Array {
	const out: number[] = [];
	let px = 0, py = 0;
	for (let i = 0; i < pts.length; i += 2) {
		const qx = Math.round(pts[i] * q), qy = Math.round(pts[i + 1] * q);
		writeVar(out, qx - px); writeVar(out, qy - py);
		px = qx; py = qy;
	}
	return Uint8Array.from(out);
}

export function decodePointBytes(bin: Uint8Array, start = 0, end = bin.length, q = Q, sx = 0, sy = 0): Float32Array {
	const vals: number[] = [];
	let z = 0, mul = 1;
	for (let i = start; i < end; i++) {
		const c = bin[i];
		z += (c & 0x7f) * mul;
		if (c & 0x80) { mul *= 128; continue; }
		vals.push(z % 2 === 0 ? z / 2 : -(z + 1) / 2);
		z = 0; mul = 1;
	}
	const pts = new Float32Array(vals.length);
	let px = sx, py = sy;
	for (let i = 0; i + 1 < vals.length; i += 2) {
		px += vals[i]; py += vals[i + 1];
		pts[i] = px / q; pts[i + 1] = py / q;
	}
	return pts;
}

function toB64(b: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 8192)));
	return btoa(bin);
}

function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	const b = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
	return b;
}

/** version 1 rows: the points of one stroke as base64 */
export function decodePoints(b64: string): Float32Array { return decodePointBytes(fromB64(b64)); }

// ---------- chunks (version 2) ----------
/**
 * Strokes are saved in chunks of up to CHUNK strokes. A chunk is one line:
 *   {"s":[[color,size(,1)],...],"l":[{"link":..,"label":..,"frame":1}],"r":1,"d":"<base64 of deflated binary>"}
 * binary, per stroke: varint style index, varint link (0 = ink, k = l[k-1]), varint byte length, point varints.
 * A style with a third element 1 is compact ink (points smoothed, in whole units). With "r":1 (data version 3)
 * each stroke's first point is relative to the previous stroke's last point; without it, absolute.
 * A chunk only depends on its own strokes, so a save re-compresses only the chunks that changed.
 */
export const CHUNK = 2000;

type LinkRow = { link: string; label: string; frame?: number };
interface ChunkLine { s: ([string, number] | [string, number, number])[]; l?: LinkRow[]; r?: number; d: string }

function linkRow(l: LinkInfo): LinkRow { return l.frame ? { link: l.target, label: l.label, frame: 1 } : { link: l.target, label: l.label }; }

export function encodeChunk(strokes: Stroke[]): string {
	const styles: ([string, number] | [string, number, number])[] = [], styleIx = new Map<string, number>(), links: LinkRow[] = [];
	const out: number[] = [];
	const parts: Uint8Array[] = [];
	// end of the previous stroke, in world units as saved (so the decoder computes the same thing)
	let ex = 0, ey = 0;
	for (const s of strokes) {
		const q = quantOf(s);
		const key = s.color + "|" + s.size + (s.smooth ? "|c" : "");
		let si = styleIx.get(key);
		if (si === undefined) { si = styles.length; styles.push(s.smooth ? [s.color, s.size, 1] : [s.color, s.size]); styleIx.set(key, si); }
		if (!s.enc) s.enc = encodePointBytes(s.pts, q);
		// first point relative to the previous stroke's end
		const at = { i: 0 };
		const x0 = readS(s.enc, at), y0 = readS(s.enc, at);
		const head: number[] = [];
		writeVar(head, x0 - Math.round(ex * q)); writeVar(head, y0 - Math.round(ey * q));
		const rest = s.enc.subarray(at.i);
		writeU(out, si);
		if (s.link) { links.push(linkRow(s.link)); writeU(out, links.length); } else writeU(out, 0);
		writeU(out, head.length + rest.length);
		for (const v of head) out.push(v);
		parts.push(Uint8Array.from(out)); out.length = 0;
		parts.push(rest);
		const n = s.pts.length;
		if (n >= 2) { ex = Math.round(s.pts[n - 2] * q) / q; ey = Math.round(s.pts[n - 1] * q) / q; }
	}
	let n = 0; for (const p of parts) n += p.length;
	const bin = new Uint8Array(n); n = 0;
	for (const p of parts) { bin.set(p, n); n += p.length; }
	const line: ChunkLine = { s: styles, d: "" };
	if (links.length) line.l = links;
	line.r = 1;
	const head = JSON.stringify({ ...line, d: undefined });
	return head.slice(0, -1) + ',"d":' + JSON.stringify(toB64(deflateSync(bin, { level: 9 }))) + "}";
}

export function decodeChunk(line: ChunkLine, add: (color: string, size: number, pts: Float32Array, enc: Uint8Array, link: LinkInfo | undefined, smooth: boolean) => void) {
	const bin = inflateSync(fromB64(line.d));
	const at = { i: 0 };
	let ex = 0, ey = 0;
	while (at.i < bin.length) {
		const [color, size, flag] = line.s[readU(bin, at)];
		const smooth = flag === 1, q = smooth ? 1 : Q;
		const li = readU(bin, at);
		const len = readU(bin, at);
		const start = at.i, end = start + len;
		at.i = end;
		const x = li ? line.l?.[li - 1] : undefined;
		const link: LinkInfo | undefined = x?.link ? { target: x.link, label: x.label ?? x.link } : undefined;
		if (link && x?.frame) link.frame = true;
		const rel = line.r === 1;
		const bx = rel ? Math.round(ex * q) : 0, by = rel ? Math.round(ey * q) : 0;
		const pts = decodePointBytes(bin, start, end, q, bx, by);
		// the cached form is absolute (as encodePointBytes makes it)
		const enc = rel ? encodePointBytes(pts, q) : bin.slice(start, end);
		add(color, size, pts, enc, link, smooth);
		const n = pts.length;
		if (n >= 2) { ex = pts[n - 2]; ey = pts[n - 1]; }
	}
}

/** what a chunk's saved text depends on, compared by reference */
function chunkSig(strokes: Stroke[]): unknown[] {
	const sig: unknown[] = [];
	for (const s of strokes) sig.push(s, s.enc, s.color, s.size, s.smooth, s.link, s.link?.target, s.link?.label);
	return sig;
}

function sameSig(a: unknown[], b: unknown[]) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// ---------- spatial grid ----------
const CELL = 256;

export class Store {
	strokes = new Map<number, Stroke>();
	private cells = new Map<string, Set<number>>();
	private nextId = 1;
	private stampCounter = 1;
	/** saved text of each chunk, reused while its strokes are unchanged */
	private chunkCache = new Map<number, { sig: unknown[]; text: string }>();

	create(color: string, size: number, pts: Float32Array, link?: LinkInfo): Stroke {
		const s: Stroke = { id: this.nextId++, color, size, pts, bbox: computeBBox(pts, size), stamp: 0 };
		if (link) s.link = link;
		return s;
	}

	add(s: Stroke) {
		this.strokes.set(s.id, s);
		this.forCells(s.bbox, (k) => {
			let set = this.cells.get(k);
			if (!set) { set = new Set(); this.cells.set(k, set); }
			set.add(s.id);
		});
	}

	remove(s: Stroke) {
		this.strokes.delete(s.id);
		this.forCells(s.bbox, (k) => {
			const set = this.cells.get(k);
			if (set) { set.delete(s.id); if (set.size === 0) this.cells.delete(k); }
		});
	}

	/** translate in place; caller must have removed it from the store first */
	translate(s: Stroke, dx: number, dy: number) {
		for (let i = 0; i < s.pts.length; i += 2) { s.pts[i] += dx; s.pts[i + 1] += dy; }
		s.bbox = { x0: s.bbox.x0 + dx, y0: s.bbox.y0 + dy, x1: s.bbox.x1 + dx, y1: s.bbox.y1 + dy };
		s.path = undefined; s.cpath = undefined; s.enc = undefined;
	}

	private forCells(r: Rect, fn: (k: string) => void) {
		const cx0 = Math.floor(r.x0 / CELL), cx1 = Math.floor(r.x1 / CELL);
		const cy0 = Math.floor(r.y0 / CELL), cy1 = Math.floor(r.y1 / CELL);
		for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) fn(cx + "," + cy);
	}

	/** strokes whose bbox overlaps r, in id (creation) order */
	query(r: Rect): Stroke[] {
		const stamp = ++this.stampCounter;
		const out: Stroke[] = [];
		const cx0 = Math.floor(r.x0 / CELL), cx1 = Math.floor(r.x1 / CELL);
		const cy0 = Math.floor(r.y0 / CELL), cy1 = Math.floor(r.y1 / CELL);
		const nCells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
		if (nCells > this.cells.size) {
			// huge rect: scan occupied cells instead
			for (const [k, set] of this.cells) {
				const c = k.indexOf(",");
				const cx = +k.slice(0, c), cy = +k.slice(c + 1);
				if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
				this.collect(set, r, stamp, out);
			}
		} else {
			for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
				const set = this.cells.get(cx + "," + cy);
				if (set) this.collect(set, r, stamp, out);
			}
		}
		out.sort((a, b) => a.id - b.id);
		return out;
	}

	private collect(set: Set<number>, r: Rect, stamp: number, out: Stroke[]) {
		for (const id of set) {
			const s = this.strokes.get(id)!;
			if (s.stamp === stamp) continue;
			s.stamp = stamp;
			if (rectsOverlap(s.bbox, r)) out.push(s);
		}
	}

	clear() { this.strokes.clear(); this.cells.clear(); this.chunkCache.clear(); }

	// ---------- file ----------
	serialize(camera: { x: number; y: number; z: number }): string {
		// in creation (paint) order: moving or restyling re-adds strokes, which puts them last in the Map
		const all = [...this.strokes.values()].sort((a, b) => a.id - b.id);
		const groups = new Map<number, Stroke[]>();
		let open = -1;
		for (const s of all) if (s.chunk !== undefined && s.chunk > open) open = s.chunk;
		for (const s of all) {
			if (s.chunk === undefined) {
				// new strokes go to the last chunk until it is full
				if (open < 0 || (groups.get(open)?.length ?? 0) >= CHUNK) open++;
				s.chunk = open;
			}
			let g = groups.get(s.chunk);
			if (!g) { g = []; groups.set(s.chunk, g); }
			g.push(s);
		}
		const lines: string[] = [];
		const keep = new Map<number, { sig: unknown[]; text: string }>();
		for (const k of [...groups.keys()].sort((a, b) => a - b)) {
			const g = groups.get(k)!;
			for (const s of g) if (!s.enc) s.enc = encodePointBytes(s.pts, quantOf(s));
			const sig = chunkSig(g);
			let c = this.chunkCache.get(k);
			if (!c || !sameSig(c.sig, sig)) c = { sig, text: encodeChunk(g) };
			keep.set(k, c);
			lines.push(c.text);
		}
		this.chunkCache = keep;
		return dataText(camera, unionBBox(all), lines);
	}

	load(text: string): { x: number; y: number; z: number } | null {
		this.clear();
		if (!text.trim()) return null;
		const data = JSON.parse(text) as { strokes?: unknown[]; chunks?: ChunkLine[]; camera?: { x: number; y: number; z: number } };
		if ((data as { version?: number }).version !== undefined && (data as { version: number }).version > 3) throw new Error("this note was saved by a newer version of Infinite Paper; update the plugin to open it");
		if (!data.chunks && !Array.isArray(data.strokes)) throw new Error("no drawing data found");
		if (data.chunks) {
			data.chunks.forEach((line, k) => {
				const g: Stroke[] = [];
				decodeChunk(line, (color, size, pts, enc, link, smooth) => {
					const s = this.create(color, size, pts, link);
					s.enc = enc; s.chunk = k;
					if (smooth) s.smooth = true;
					this.add(s); g.push(s);
				});
				// the file already holds this chunk's text (re-encoded identically on a change only)
				this.chunkCache.set(k, { sig: chunkSig(g), text: JSON.stringify(line) });
			});
			return data.camera ?? null;
		}
		// version 1: one stroke per row [color, size, base64 points, link?]
		for (const [color, size, enc, extra] of (data.strokes ?? []) as [string, number, string, { link?: string; label?: string; frame?: number }?][]) {
			const pts = decodePoints(enc);
			const link: LinkInfo | undefined = extra?.link ? { target: extra.link, label: extra.label ?? extra.link } : undefined;
			if (link && extra?.frame) link.frame = true;
			this.add(this.create(color, size, pts, link));
		}
		return data.camera ?? null;
	}
}

/** strokes shifted by (dx, dy), as new strokes (not in any store) */
function shifted(strokes: Stroke[], dx: number, dy: number): Stroke[] {
	return strokes.map((s) => {
		const p = new Float32Array(s.pts.length);
		for (let i = 0; i < p.length; i += 2) { p[i] = s.pts[i] + dx; p[i + 1] = s.pts[i + 1] + dy; }
		const n: Stroke = { id: 0, color: s.color, size: s.size, pts: p, bbox: computeBBox(p, s.size), stamp: 0 };
		if (s.link) n.link = s.link;
		if (s.smooth) n.smooth = true;
		return n;
	});
}

/** a whole data block holding these strokes */
export function dataFor(camera: { x: number; y: number; z: number }, strokes: Stroke[]): string {
	const lines: string[] = [];
	for (let i = 0; i < strokes.length; i += CHUNK) lines.push(encodeChunk(shifted(strokes.slice(i, i + CHUNK), 0, 0)));
	return dataText(camera, unionBBox(strokes), lines);
}

export function unionBBox(strokes: Iterable<Stroke>): Rect | null {
	let r: Rect | null = null;
	for (const s of strokes) {
		const b = s.bbox;
		if (!r) r = { ...b };
		else { if (b.x0 < r.x0) r.x0 = b.x0; if (b.y0 < r.y0) r.y0 = b.y0; if (b.x1 > r.x1) r.x1 = b.x1; if (b.y1 > r.y1) r.y1 = b.y1; }
	}
	return r;
}

/**
 * The data block (version 3; 2 had chunks without "r"): one chunk per line (renames work line by line). `bounds` (content extent)
 * lets ink be added to a closed drawing without decoding its strokes.
 */
export function dataText(camera: { x: number; y: number; z: number }, bounds: Rect | null, lines: string[]): string {
	const b = bounds ? `,"bounds":${JSON.stringify({ x0: Math.round(bounds.x0), y0: Math.round(bounds.y0), x1: Math.round(bounds.x1), y1: Math.round(bounds.y1) })}` : "";
	return `{"type":"infinite-paper","version":3,"camera":${JSON.stringify(camera)}${b},"chunks":[\n${lines.join(",\n")}\n]}\n`;
}

/**
 * Add strokes to a saved data block as new chunks: existing chunks are kept verbatim and never decoded.
 * A version 1 block (or one without `bounds`) is loaded once and rewritten as version 2.
 * `place` gets the target's content bounds and returns the offset for the new strokes.
 */
export function appendRows(data: string, strokes: Stroke[], place: (target: Rect | null) => [number, number]): string {
	const k = data.indexOf('"chunks":[');
	let camera = { x: 0, y: 0, z: 1 }, bounds: Rect | null = null, body = "";
	if (k >= 0) {
		const meta = JSON.parse(data.slice(0, k) + '"_":0}') as { camera?: { x: number; y: number; z: number }; bounds?: Rect };
		camera = meta.camera ?? camera;
		body = data.slice(k + '"chunks":['.length, data.lastIndexOf("]")).replace(/^\s+|\s+$/g, "");
		bounds = meta.bounds ?? null;
	}
	if (data.trim() && (k < 0 || (body && !bounds))) {
		// version 1, or no bounds: load, add, save whole
		const st = new Store();
		const cam = st.load(data) ?? camera;
		const [dx, dy] = place(unionBBox(st.strokes.values()));
		for (const s of shifted(strokes, dx, dy)) st.add(st.create(s.color, s.size, s.pts, s.link));
		return st.serialize(cam);
	}
	const [dx, dy] = place(bounds);
	const moved = shifted(strokes, dx, dy);
	const lines: string[] = [];
	for (let i = 0; i < moved.length; i += CHUNK) lines.push(encodeChunk(moved.slice(i, i + CHUNK)));
	const nb = unionBBox(moved)!;
	const all = bounds ? { x0: Math.min(bounds.x0, nb.x0), y0: Math.min(bounds.y0, nb.y0), x1: Math.max(bounds.x1, nb.x1), y1: Math.max(bounds.y1, nb.y1) } : nb;
	return dataText(camera, all, body ? [body, ...lines] : lines);
}

export function distToSegSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
	const dx = bx - ax, dy = by - ay;
	const l2 = dx * dx + dy * dy;
	let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const x = ax + t * dx - px, y = ay + t * dy - py;
	return x * x + y * y;
}

export function hitStroke(s: Stroke, x: number, y: number, r: number): boolean {
	if (s.link) { const b = s.bbox; return x >= b.x0 - r && x <= b.x1 + r && y >= b.y0 - r && y <= b.y1 + r; }
	const rr = (r + s.size / 2) ** 2;
	const p = s.pts;
	if (p.length === 2) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= rr;
	for (let i = 0; i + 3 < p.length; i += 2) {
		if (distToSegSq(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= rr) return true;
	}
	return false;
}

export function pointInPoly(x: number, y: number, poly: number[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
		const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
