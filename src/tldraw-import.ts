/**
 * Read a tldraw-plugin note (```json !!!_START_OF_TLDRAW_DATA… block) and turn its freehand
 * `draw` shapes into Infinite Paper strokes. Other shapes are counted, and any text they carry
 * is returned so it can go into the new note's markdown.
 *
 * Mapping (from tldraw 3.15 DrawShapeUtil):
 *   width   = STROKE_SIZES[size] + 1, times scale  → s 3, m 4.5, l 6, xl 11 (same as our S/M/L/XL)
 *   color   = tldraw light-mode palette "solid" value
 *   points  = shape-local; world = parent transforms ∘ (rotate(rotation) then translate(x, y))
 *   camera  = tldraw screen = (world + cam) * z;  ours: screen = world * z + cam  → ours = tl * z
 * Fills, dash styles and pen pressure are dropped (most tldraw ink was solid with pressure off anyway).
 */
import { decompressFromBase64 } from "lz-string";

const START = "!!!_START_OF_TLDRAW_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!";
const END = "!!!_END_OF_TLDRAW_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!";

const STROKE_SIZES: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 };
export const TL_COLORS: Record<string, string> = {
	black: "#1d1d1d", blue: "#4465e9", green: "#099268", grey: "#9fa8b2",
	"light-blue": "#4ba1f1", "light-green": "#4cb05e", "light-red": "#f87777", "light-violet": "#e085f4",
	orange: "#e16919", red: "#e03131", violet: "#ae3ec9", yellow: "#f1ac4b", white: "#ffffff",
};

export interface ImportedStroke { color: string; size: number; pts: Float32Array; link?: { target: string; label: string }; }
export interface TldrawImport {
	strokes: ImportedStroke[];
	camera: { x: number; y: number; z: number } | null;
	/** markdown that sat above the tldraw data (frontmatter and backlink markers removed) */
	body: string;
	/** text found in non-ink shapes (text, geo labels, notes, arrows), in drawing order */
	texts: string[];
	/** shapes that were not converted, by type */
	skipped: Record<string, number>;
	/** non-fatal problems, e.g. a damaged data block that was recovered */
	warnings: string[];
	/** backlink lines (`[[x]]`) found in the tldraw note's header, in order */
	backlinks: string[];
}

export function isTldrawMarkdown(text: string) {
	return text.includes(START);
}

/** the decompressed tldraw store snapshot ({ store/records, schema }) */
function readSnapshot(block: string, warnings: string[]): any {
	let d: any;
	try {
		d = JSON.parse(block);
	} catch {
		// seen once: two compressed payloads spliced together; the first one is intact
		const m = block.match(/"payload":\s*"([^"]+)"/);
		if (!m) throw new Error("tldraw data is not valid JSON");
		warnings.push("data block was damaged; recovered the first compressed payload");
		d = { raw: { compressed: true, payload: m[1] } };
	}
	// current plugin: { meta, raw: {compressed, payload} | snapshot }; older: { compressed, payload } at top level
	let raw = d.raw ?? d;
	if (raw.compressed) {
		const json = decompressFromBase64(raw.payload);
		if (!json) throw new Error("could not decompress tldraw data");
		raw = JSON.parse(json);
	}
	return raw;
}

function richTextToString(node: any): string {
	if (!node) return "";
	if (typeof node.text === "string") return node.text;
	if (!Array.isArray(node.content)) return "";
	const parts = node.content.map(richTextToString);
	return node.type === "doc" ? parts.join("\n") : parts.join("");
}

type M = [number, number, number, number, number, number]; // a b c d e f (x' = a x + c y + e)
const mul = (p: M, q: M): M => [
	p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
	p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
	p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
];
const local = (s: any): M => {
	const r = s.rotation || 0, c = Math.cos(r), n = Math.sin(r);
	return [c, n, -n, c, s.x || 0, s.y || 0];
};

/**
 * Width Ink should use for a tldraw draw stroke. Solid style: width = STROKE_SIZES + 1. "draw" (sketchy) style
 * drawn with a pen: perfect-freehand realPressureSettings — size 1 + sw * 1.2, thinning 0.62, PEN_EASING — whose
 * radius is size * easing(0.5 - thinning * (0.5 - pressure)). Ink has no pressure, so we use the stroke's mean
 * pressure (pencil strokes here record one constant value). Simulated pressure (mouse) averages out to about sw.
 */
/** IEEE half-precision float at `o` (little-endian); DataView.getFloat16 isn't available everywhere yet */
function f16(dv: DataView, o: number): number {
	const h = dv.getUint16(o, true), e = (h >> 10) & 31, f = h & 1023, sign = h & 32768 ? -1 : 1;
	if (e === 0) return sign * f * 2 ** -24;
	if (e === 31) return f ? NaN : sign * Infinity;
	return sign * (1 + f / 1024) * 2 ** (e - 15);
}

function b64Bytes(b64: string): DataView {
	const bin = atob(b64), u = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
	return new DataView(u.buffer);
}

type Pt = { x: number; y: number; z?: number };

/**
 * A draw segment's points, in any of tldraw's encodings:
 * - `points: [{x, y, z}]`: older tldraw (what earlier versions of the tldraw plugin write);
 * - `points: "<base64>"`: absolute Float16 x, y, z per point (short-lived intermediate format);
 * - `path: "<base64>"`: current tldraw (official plugin 1.2x+): first point as 3 Float32, then Float16 deltas;
 *   these shapes also carry `scaleX` / `scaleY` in props.
 * Returns null for an encoding we don't know.
 */
function segmentPoints(seg: any, p: any): Pt[] | null {
	let pts: Pt[];
	if (Array.isArray(seg.points)) pts = seg.points;
	else if (typeof seg.path === "string" || typeof seg.points === "string") {
		const delta = typeof seg.path === "string";
		const dv = b64Bytes(delta ? seg.path : seg.points);
		pts = [];
		if (delta) {
			if (dv.byteLength < 12) return [];
			let x = dv.getFloat32(0, true), y = dv.getFloat32(4, true), z = dv.getFloat32(8, true);
			pts.push({ x, y, z });
			for (let o = 12; o + 6 <= dv.byteLength; o += 6) { x += f16(dv, o); y += f16(dv, o + 2); z += f16(dv, o + 4); pts.push({ x, y, z }); }
		} else {
			for (let o = 0; o + 6 <= dv.byteLength; o += 6) pts.push({ x: f16(dv, o), y: f16(dv, o + 2), z: f16(dv, o + 4) });
		}
	} else return null;
	const sx = p.scaleX ?? 1, sy = p.scaleY ?? 1;
	return sx === 1 && sy === 1 ? pts : pts.map((q) => ({ x: q.x * sx, y: q.y * sy, z: q.z }));
}

function drawStrokeWidth(p: any): number {
	const sw = ((STROKE_SIZES[p.size] ?? 2) + 1) * (p.scale || 1);
	if (p.dash !== "draw" || !p.isPen) return sw;
	let sum = 0, n = 0;
	for (const seg of p.segments || []) for (const q of segmentPoints(seg, p) ?? []) if (typeof q.z === "number") { sum += q.z; n++; }
	const z = n ? sum / n : 0.5;
	const t = 0.5 - 0.62 * (0.5 - z);
	const ease = t * 0.65 + Math.sin((t * Math.PI) / 2) * 0.35;
	return 2 * (1 + sw * 1.2) * ease;
}

const apply = (m: M, pts: number[]) => {
	const out: number[] = [];
	for (let i = 0; i < pts.length; i += 2) out.push(m[0] * pts[i] + m[2] * pts[i + 1] + m[4], m[1] * pts[i] + m[3] * pts[i + 1] + m[5]);
	return out;
};

/** straight segments as many points (≤ 20 units apart): the ink smoothing would otherwise round a 2-point line's ends */
function densify(pl: number[]): number[] {
	const out = [pl[0], pl[1]];
	for (let i = 2; i < pl.length; i += 2) {
		const x0 = pl[i - 2], y0 = pl[i - 1], x1 = pl[i], y1 = pl[i + 1];
		const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 20));
		for (let k = 1; k <= n; k++) out.push(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
	}
	return out;
}

/** geo shape in its local box. Each straight side is its own stroke so corners stay sharp. */
function geoPolylines(p: any): number[][] {
	const w = p.w ?? 0, h = (p.h ?? 0) + (p.growY ?? 0);
	const sides = (poly: number[]) => {
		const out: number[][] = [];
		for (let i = 0; i < poly.length; i += 2) {
			const j = (i + 2) % poly.length;
			out.push([poly[i], poly[i + 1], poly[j], poly[j + 1]]);
		}
		return out;
	};
	const ellipse = () => {
		const pl: number[] = [];
		for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pl.push(w / 2 + (Math.cos(a) * w) / 2, h / 2 + (Math.sin(a) * h) / 2); }
		return [pl];
	};
	const regular = (n: number, inner = 0) => {
		const pl: number[] = [], k = inner ? n * 2 : n;
		for (let i = 0; i < k; i++) {
			const a = -Math.PI / 2 + (i / k) * Math.PI * 2, r = inner && i % 2 ? inner : 1;
			pl.push(w / 2 + (Math.cos(a) * w * r) / 2, h / 2 + (Math.sin(a) * h * r) / 2);
		}
		return sides(pl);
	};
	const o = Math.min(w * 0.38, h * 0.38);
	switch (p.geo) {
		case "ellipse": case "oval": case "cloud": case "heart": return ellipse();
		case "triangle": return sides([w / 2, 0, w, h, 0, h]);
		case "diamond": return sides([w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]);
		case "rhombus": case "rhombus-2": return sides([o, 0, w, 0, w - o, h, 0, h]);
		case "trapezoid": return sides([o, 0, w - o, 0, w, h, 0, h]);
		case "pentagon": return regular(5);
		case "hexagon": return regular(6);
		case "octagon": return regular(8);
		case "star": return regular(5, 0.5);
		case "x-box": return [...sides([0, 0, w, 0, w, h, 0, h]), [0, 0, w, h], [w, 0, 0, h]];
		case "check-box": return [...sides([0, 0, w, 0, w, h, 0, h]), [w * 0.25, h * 0.52, w * 0.45, h * 0.7, w * 0.75, h * 0.3]];
		case "arrow-right": return sides([0, h * 0.25, w * 0.6, h * 0.25, w * 0.6, 0, w, h / 2, w * 0.6, h, w * 0.6, h * 0.75, 0, h * 0.75]);
		case "arrow-left": return sides([w, h * 0.25, w * 0.4, h * 0.25, w * 0.4, 0, 0, h / 2, w * 0.4, h, w * 0.4, h * 0.75, w, h * 0.75]);
		case "arrow-up": return sides([w * 0.25, h, w * 0.25, h * 0.4, 0, h * 0.4, w / 2, 0, w, h * 0.4, w * 0.75, h * 0.4, w * 0.75, h]);
		case "arrow-down": return sides([w * 0.25, 0, w * 0.25, h * 0.6, 0, h * 0.6, w / 2, h, w, h * 0.6, w * 0.75, h * 0.6, w * 0.75, 0]);
		default: return sides([0, 0, w, 0, w, h, 0, h]); // rectangle and anything unknown
	}
}

type Terminal = { point: [number, number]; box: number[]; clip: boolean; anchor: { x: number; y: number } } | null;

/** where the segment from `from` to the box centre `to` crosses the box outline (box = 4 corners) */
function clipToBox(from: [number, number], to: [number, number], box: number[]): [number, number] {
	let best = 1;
	for (let i = 0; i < 8; i += 2) {
		const ax = box[i], ay = box[i + 1], bx = box[(i + 2) % 8], by = box[(i + 3) % 8];
		const d = (to[0] - from[0]) * (by - ay) - (to[1] - from[1]) * (bx - ax);
		if (!d) continue;
		const t = ((ax - from[0]) * (by - ay) - (ay - from[1]) * (bx - ax)) / d;
		const u = ((ax - from[0]) * (to[1] - from[1]) - (ay - from[1]) * (to[0] - from[0])) / d;
		if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) best = t;
	}
	return [from[0] + (to[0] - from[0]) * best, from[1] + (to[1] - from[1]) * best];
}

/** arrow body (straight, arc or elbow) plus arrowheads, in page space */
function arrowPolylines(s: any, m: M, terminal: (side: "start" | "end") => Terminal): number[][] {
	const p = s.props;
	const tS = terminal("start"), tE = terminal("end");
	let a = (tS?.point ?? apply(m, [p.start.x, p.start.y])) as [number, number];
	let b = (tE?.point ?? apply(m, [p.end.x, p.end.y])) as [number, number];
	if (tS?.clip) a = clipToBox(b, a, tS.box);
	if (tE?.clip) b = clipToBox(a, b, tE.box);
	const sw = (STROKE_SIZES[p.size] ?? 2) * (p.scale || 1);

	let body: number[];
	if (p.kind === "elbow") {
		// orthogonal route; exit direction from the anchor's edge when attached, else the longer axis
		const dir = (t: Terminal) => !t ? null : t.anchor.x === 0 || t.anchor.x === 1 ? "h" : t.anchor.y === 0 || t.anchor.y === 1 ? "v" : null;
		const horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
		const ds = dir(tS) ?? (horiz ? "h" : "v"), de = dir(tE) ?? (horiz ? "h" : "v");
		const mid = p.elbowMidPoint ?? 0.5;
		if (ds === "h" && de === "h") { const x = a[0] + (b[0] - a[0]) * mid; body = [a[0], a[1], x, a[1], x, b[1], b[0], b[1]]; }
		else if (ds === "v" && de === "v") { const y = a[1] + (b[1] - a[1]) * mid; body = [a[0], a[1], a[0], y, b[0], y, b[0], b[1]]; }
		else if (ds === "v") body = [a[0], a[1], a[0], b[1], b[0], b[1]];
		else body = [a[0], a[1], b[0], a[1], b[0], b[1]];
	} else if (Math.abs(p.bend || 0) > 8 * (p.scale || 1)) {
		// arc through the middle handle: tldraw puts it at med + per(u) * -bend, per(x, y) = (y, -x)
		const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
		const c: [number, number] = [(a[0] + b[0]) / 2 - uy * p.bend, (a[1] + b[1]) / 2 + ux * p.bend];
		body = arcThrough(a, c, b);
	} else body = [a[0], a[1], b[0], b[1]];

	const out = [body];
	const head = (tip: [number, number], prev: [number, number], kind: string | undefined) => {
		if (!kind || kind === "none") return;
		const len = Math.max(sw, Math.min(sw * 3, Math.hypot(tip[0] - prev[0], tip[1] - prev[1]) / 5)); // tldraw: clamp(len / 5, sw, 3 sw)
		const ang = Math.atan2(prev[1] - tip[1], prev[0] - tip[0]);
		const wing = (d: number) => [tip[0] + Math.cos(ang + d) * len, tip[1] + Math.sin(ang + d) * len];
		const l = wing(Math.PI / 6), r = wing(-Math.PI / 6);
		if (kind === "triangle") out.push([...l, tip[0], tip[1], ...r, ...l]);
		else out.push([...l, tip[0], tip[1]], [tip[0], tip[1], ...r]);
	};
	const n = body.length;
	head([body[n - 2], body[n - 1]], [body[n - 4], body[n - 3]], p.arrowheadEnd);
	head([body[0], body[1]], [body[2], body[3]], p.arrowheadStart);
	return out;
}

/** circular arc a → c → b, sampled */
function arcThrough(a: [number, number], c: [number, number], b: [number, number]): number[] {
	const d = 2 * (a[0] * (c[1] - b[1]) + c[0] * (b[1] - a[1]) + b[0] * (a[1] - c[1]));
	if (Math.abs(d) < 1e-9) return [a[0], a[1], b[0], b[1]];
	const sq = (q: number[]) => q[0] * q[0] + q[1] * q[1];
	const ox = (sq(a) * (c[1] - b[1]) + sq(c) * (b[1] - a[1]) + sq(b) * (a[1] - c[1])) / d;
	const oy = (sq(a) * (b[0] - c[0]) + sq(c) * (a[0] - b[0]) + sq(b) * (c[0] - a[0])) / d;
	const r = Math.hypot(a[0] - ox, a[1] - oy);
	const ang = (q: number[]) => Math.atan2(q[1] - oy, q[0] - ox);
	let t0 = ang(a), t1 = ang(b);
	const tc = ang(c);
	// go the way that passes through c
	const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
	const ccw = norm(tc - t0) < norm(t1 - t0);
	let sweep = ccw ? norm(t1 - t0) : -norm(t0 - t1);
	const n = Math.max(8, Math.ceil((Math.abs(sweep) * r) / 10));
	const out: number[] = [];
	for (let i = 0; i <= n; i++) { const t = t0 + (sweep * i) / n; out.push(ox + Math.cos(t) * r, oy + Math.sin(t) * r); }
	return out;
}

export function importTldraw(text: string): TldrawImport {
	const i = text.indexOf(START);
	if (i < 0) throw new Error("not a tldraw note");
	const j = text.indexOf(END, i);
	const open = text.lastIndexOf("```", i);
	const block = text.slice(i + START.length, j < 0 ? undefined : j);
	const warnings: string[] = [];

	const snap = readSnapshot(block, warnings);
	const records: any[] = snap.records ?? Object.values(snap.store ?? snap.document?.store ?? {});

	const shapes = new Map<string, any>();
	const children = new Map<string, any[]>();
	let page: string | null = null;
	let camera: TldrawImport["camera"] = null;
	for (const r of records) {
		if (r.typeName === "shape") {
			shapes.set(r.id, r);
			let a = children.get(r.parentId);
			if (!a) children.set(r.parentId, (a = []));
			a.push(r);
		} else if (r.typeName === "page" && !page) page = r.id;
		else if (r.typeName === "instance" && r.currentPageId) page = r.currentPageId;
	}
	for (const r of records) {
		if (r.typeName === "camera" && (!page || r.id === "camera:" + page)) {
			const z = r.z || 1;
			camera = { x: r.x * z, y: r.y * z, z };
		}
	}

	const strokes: ImportedStroke[] = [];
	const texts: string[] = [];
	const skipped: Record<string, number> = {};
	const skip = (t: string) => (skipped[t] = (skipped[t] || 0) + 1);

	// page transform of any shape (for arrows attached to other shapes)
	const pageM = new Map<string, M>();
	const pageTransform = (id: string): M => {
		const hit = pageM.get(id);
		if (hit) return hit;
		const sh = shapes.get(id);
		if (!sh) return [1, 0, 0, 1, 0, 0];
		const m = mul(shapes.has(sh.parentId) ? pageTransform(sh.parentId) : [1, 0, 0, 1, 0, 0], local(sh));
		pageM.set(id, m);
		return m;
	};
	const bindings = new Map<string, any>(); // `${arrowId}:${start|end}` -> binding props + target
	for (const r of records) {
		if (r.typeName === "binding" && r.type === "arrow" && r.props?.terminal) bindings.set(`${r.fromId}:${r.props.terminal}`, { ...r.props, toId: r.toId });
	}

	/** outline strokes (tldraw's geo/line/arrow width: STROKE_SIZES, no +1) */
	const outline = (p: any, polylines: number[][]) => {
		const size = (STROKE_SIZES[p.size] ?? 2) * (p.scale || 1);
		const color = TL_COLORS[p.color] ?? TL_COLORS.black;
		for (const pl of polylines) if (pl.length >= 4) strokes.push({ color, size, pts: new Float32Array(densify(pl)) });
	};

	const backlinks: string[] = [];
	const linkOf = (s: any): { target: string; label: string } | null => {
		const p = s.props || {};
		const t = (typeof p.text === "string" ? p.text : richTextToString(p.richText)).trim();
		const m = t.match(/^🔗\s*(.+)$/u);
		const meta = s.meta?.obsidianLink;
		if (meta?.type === "wiki" && meta.target) return { target: String(meta.target), label: m ? m[1].trim() : String(meta.target).split("/").pop()! };
		return m ? { target: m[1].trim(), label: m[1].trim() } : null;
	};
	// depth-first in tldraw's paint order (fractional index strings sort with plain string comparison)
	const byIndex = (a: any, b: any) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
	const roots = [...children.entries()].filter(([pid]) => !shapes.has(pid));
	const visit = (s: any, parent: M) => {
		const m = mul(parent, local(s));
		const p = s.props || {};
		if (s.type === "draw" || s.type === "highlight") {
			const pts: number[] = [];
			for (const seg of p.segments || []) {
				const sp = segmentPoints(seg, p);
				if (!sp) { warnings.push(`stroke ${s.id}: unsupported point encoding`); continue; }
				for (const q of sp) pts.push(m[0] * q.x + m[2] * q.y + m[4], m[1] * q.x + m[3] * q.y + m[5]);
			}
			if (pts.length >= 2) {
				const size = drawStrokeWidth(p);
				strokes.push({ color: TL_COLORS[p.color] ?? TL_COLORS.black, size, pts: new Float32Array(pts) });
			}
			if (s.type === "highlight") skip("highlight (converted as ink)");
		} else if (s.type === "geo" && linkOf(s)) {
			// a link box ("🔗 Note" + meta.obsidianLink): an Infinite Paper link box, not ink
			const l = linkOf(s)!, c = apply(m, [0, 0, p.w ?? 240, (p.h ?? 240) + (p.growY ?? 0)]);
			strokes.push({ color: TL_COLORS[p.color] ?? TL_COLORS.black, size: 3.5, pts: new Float32Array(c), link: l });
			if (!backlinks.includes(`[[${l.target}]]`)) backlinks.push(`[[${l.target}]]`);
			for (const ch of (children.get(s.id) || []).sort(byIndex)) visit(ch, m);
			return;
		} else if (s.type === "geo") {
			outline(p, geoPolylines(p).map((pl) => apply(m, pl)));
		} else if (s.type === "line") {
			const pts: number[] = []; for (const q of Object.values(p.points || {}).sort(byIndex) as { x: number; y: number }[]) pts.push(q.x, q.y);
			outline(p, [apply(m, pts)]);
		} else if (s.type === "arrow") {
			outline(p, arrowPolylines(s, m, (side) => {
				const b = bindings.get(`${s.id}:${side}`);
				const target = b && shapes.get(b.toId);
				if (!target) return null;
				const tp = target.props || {}, w = tp.w ?? 0, h = (tp.h ?? 0) + (tp.growY ?? 0);
				const a = b.isPrecise ? b.normalizedAnchor : { x: 0.5, y: 0.5 };
				const tm = pageTransform(target.id);
				return { point: apply(tm, [a.x * w, a.y * h]) as [number, number], box: apply(tm, [0, 0, w, 0, w, h, 0, h]), clip: !b.isPrecise, anchor: a };
			}));
		} else if (s.type !== "group") {
			skip(s.type);
		}
		let t = (typeof p.text === "string" ? p.text : richTextToString(p.richText)).trim();
		// tldraw-plugin link boxes: "🔗 Note name" -> a real wikilink
		const link = t.match(/^🔗\s*(.+)$/u);
		if (link) t = `[[${link[1].trim()}]]`;
		if (t) texts.push(t);
		if (s.type === "frame" && p.name) texts.push(String(p.name));
		for (const c of (children.get(s.id) || []).sort(byIndex)) visit(c, m);
	};
	// the current page keeps its coordinates (so the camera matches); other pages are stacked below it
	const pages = records.filter((r) => r.typeName === "page").sort(byIndex).map((r) => r.id as string);
	const order = page ? [page, ...pages.filter((p) => p !== page)] : pages;
	for (const [pid] of roots) if (!order.includes(pid)) order.push(pid);
	let bottom = -Infinity, left = Infinity;
	for (const pid of order) {
		const list = roots.find(([p]) => p === pid)?.[1];
		if (!list) continue;
		const first = strokes.length;
		for (const s of list.sort(byIndex)) visit(s, [1, 0, 0, 1, 0, 0]);
		let y0 = Infinity, y1 = -Infinity, x0 = Infinity;
		for (let k = first; k < strokes.length; k++) {
			const p = strokes[k].pts;
			for (let n = 0; n < p.length; n += 2) { if (p[n] < x0) x0 = p[n]; if (p[n + 1] < y0) y0 = p[n + 1]; if (p[n + 1] > y1) y1 = p[n + 1]; }
		}
		if (first === strokes.length) continue;
		if (bottom > -Infinity) {
			const dx = left - x0, dy = bottom + 400 - y0;
			for (let k = first; k < strokes.length; k++) {
				const p = strokes[k].pts;
				for (let n = 0; n < p.length; n += 2) { p[n] += dx; p[n + 1] += dy; }
			}
			y1 += dy;
			warnings.push(`page ${pid} placed below the current page`);
		} else left = x0;
		bottom = Math.max(bottom, y1);
	}

	// markdown above the data block, without frontmatter and the tldraw backlink markers
	let body = text.slice(0, open < 0 ? i : open);
	body = body.replace(/^---\n[\s\S]*?\n---\n?/, "");
	for (const blk of body.match(/<!-- TLDRAW_BACKLINKS_START -->[\s\S]*?<!-- TLDRAW_BACKLINKS_END -->/g) ?? [])
		for (const line of blk.split("\n")) {
			const l = line.replace(/^\s*- \[.\]\s*/, "").trim();
			if (/^\[\[.+\]\]$/.test(l) && !backlinks.includes(l)) backlinks.push(l);
		}
	body = body.replace(/<!-- TLDRAW_BACKLINKS_START -->[\s\S]*?<!-- TLDRAW_BACKLINKS_END -->/g, "").trim();

	return { strokes, camera, body, texts, skipped, warnings, backlinks };
}
