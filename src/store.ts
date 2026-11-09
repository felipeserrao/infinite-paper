import { getStroke, getStrokePoints } from "perfect-freehand";
import { exp } from "./exp";

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
	/** cached encoded form for saving */
	enc?: string;
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
export function freehandOptions(size: number, last: boolean) {
	return {
		size,
		thinning: 0,
		streamline: exp.streamline,
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

export function strokeOutline(pts: ArrayLike<number>, size: number, last: boolean): number[][] {
	return getStroke(toInput(pts, size), freehandOptions(size, last));
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
export function centerlinePath(pts: ArrayLike<number>, size: number, last: boolean): Path2D {
	const P = exp.tlPoints
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
	if (!s.path) s.path = outlineToPath(strokeOutline(s.pts, s.size, true));
	return s.path;
}

/** draw a finished stroke in the current mode (ctx transform already set to world) */
export function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
	if (s.link) { paintLink(ctx, s); return; }
	if (exp.centerline) {
		if (!s.cpath) s.cpath = centerlinePath(s.pts, s.size, true);
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
		for (const ch of Array.from(l) as string[]) { if (c && ctx.measureText(c + ch).width > maxW) { res.push(c); c = ch; } else c += ch; }
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

// ---------- encoding: quantized (1/4 px), delta, zigzag varint, base64 ----------
const Q = 4;

function writeVar(out: number[], v: number) {
	let z = v >= 0 ? v * 2 : -v * 2 - 1;
	while (z >= 0x80) { out.push((z & 0x7f) | 0x80); z = Math.floor(z / 128); }
	out.push(z);
}

export function encodePoints(pts: Float32Array): string {
	const out: number[] = [];
	let px = 0, py = 0;
	for (let i = 0; i < pts.length; i += 2) {
		const qx = Math.round(pts[i] * Q), qy = Math.round(pts[i + 1] * Q);
		writeVar(out, qx - px); writeVar(out, qy - py);
		px = qx; py = qy;
	}
	let bin = "";
	for (let i = 0; i < out.length; i += 4096) bin += String.fromCharCode.apply(null, out.slice(i, i + 4096));
	return btoa(bin);
}

export function decodePoints(b64: string): Float32Array {
	const bin = atob(b64);
	const vals: number[] = [];
	let z = 0, mul = 1;
	for (let i = 0; i < bin.length; i++) {
		const c = bin.charCodeAt(i);
		z += (c & 0x7f) * mul;
		if (c & 0x80) { mul *= 128; continue; }
		vals.push(z % 2 === 0 ? z / 2 : -(z + 1) / 2);
		z = 0; mul = 1;
	}
	const pts = new Float32Array(vals.length);
	let px = 0, py = 0;
	for (let i = 0; i + 1 < vals.length; i += 2) {
		px += vals[i]; py += vals[i + 1];
		pts[i] = px / Q; pts[i + 1] = py / Q;
	}
	return pts;
}

// ---------- spatial grid ----------
const CELL = 256;

export class Store {
	strokes = new Map<number, Stroke>();
	private cells = new Map<string, Set<number>>();
	private nextId = 1;
	private stampCounter = 1;

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

	clear() { this.strokes.clear(); this.cells.clear(); }

	// ---------- file ----------
	serialize(camera: { x: number; y: number; z: number }): string {
		const rows: string[] = [];
		// in creation (paint) order: moving or restyling re-adds strokes, which puts them last in the Map
		const all = [...this.strokes.values()].sort((a, b) => a.id - b.id);
		for (const s of all) {
			if (!s.enc) s.enc = encodePoints(s.pts);
			rows.push(rowJSON(s.color, s.size, s.enc, s.link));
		}
		return dataText(camera, unionBBox(all), rows);
	}

	load(text: string): { x: number; y: number; z: number } | null {
		this.clear();
		if (!text.trim()) return null;
		const data = JSON.parse(text);
		for (const [color, size, enc, extra] of data.strokes as [string, number, string, { link?: string; label?: string; frame?: number }?][]) {
			const pts = decodePoints(enc);
			const link: LinkInfo | undefined = extra?.link ? { target: extra.link, label: extra.label ?? extra.link } : undefined;
			if (link && extra?.frame) link.frame = true;
			const s = this.create(color, size, pts, link);
			s.enc = enc;
			this.add(s);
		}
		return data.camera ?? null;
	}
}

function rowJSON(color: string, size: number, enc: string, link?: LinkInfo) {
	if (!link) return JSON.stringify([color, size, enc]);
	return JSON.stringify([color, size, enc, link.frame ? { link: link.target, label: link.label, frame: 1 } : { link: link.target, label: link.label }]);
}

/** one stroke as a saved row, shifted by (dx, dy) */
export function strokeRow(s: Stroke, dx = 0, dy = 0): string {
	let enc = s.enc;
	if (!enc || dx || dy) {
		const p = new Float32Array(s.pts.length);
		for (let i = 0; i < p.length; i += 2) { p[i] = s.pts[i] + dx; p[i + 1] = s.pts[i + 1] + dy; }
		enc = encodePoints(p);
	}
	return rowJSON(s.color, s.size, enc, s.link);
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
 * The data block. One stroke per line (renames and appends work line by line). `bounds` (content extent, since v0.8.1)
 * lets ink be added to a closed drawing without decoding its strokes.
 */
export function dataText(camera: { x: number; y: number; z: number }, bounds: Rect | null, rows: string[]): string {
	const b = bounds ? `,"bounds":${JSON.stringify({ x0: Math.round(bounds.x0), y0: Math.round(bounds.y0), x1: Math.round(bounds.x1), y1: Math.round(bounds.y1) })}` : "";
	return `{"type":"infinite-paper","version":1,"camera":${JSON.stringify(camera)}${b},"strokes":[\n${rows.join(",\n")}\n]}\n`;
}

/**
 * Add rows to a saved data block, as text: existing rows are kept verbatim and never decoded, unless the
 * block has no `bounds` (saved before v0.8.1), in which case it is loaded once to measure it.
 * `place` gets the target's content bounds and returns the offset for the new rows' strokes.
 */
export function appendRows(data: string, strokes: Stroke[], place: (target: Rect | null) => [number, number]): string {
	const k = data.indexOf('"strokes":[');
	let camera = { x: 0, y: 0, z: 1 }, bounds: Rect | null = null, body = "";
	if (k >= 0) {
		const meta = JSON.parse(data.slice(0, k) + '"_":0}');
		camera = meta.camera ?? camera;
		body = data.slice(k + '"strokes":['.length, data.lastIndexOf("]")).replace(/^\s+|\s+$/g, "");
		if (meta.bounds) bounds = meta.bounds;
		else if (body) { const st = new Store(); st.load(data); bounds = unionBBox(st.strokes.values()); }
	}
	const [dx, dy] = place(bounds);
	const rows = strokes.map((s) => strokeRow(s, dx, dy));
	const moved = unionBBox(strokes)!;
	const nb = { x0: moved.x0 + dx, y0: moved.y0 + dy, x1: moved.x1 + dx, y1: moved.y1 + dy };
	const all = bounds ? { x0: Math.min(bounds.x0, nb.x0), y0: Math.min(bounds.y0, nb.y0), x1: Math.max(bounds.x1, nb.x1), y1: Math.max(bounds.y1, nb.y1) } : nb;
	return dataText(camera, all, body ? [body, ...rows] : rows);
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
