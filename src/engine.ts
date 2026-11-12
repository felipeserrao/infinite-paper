import { Store, Stroke, Rect, LinkInfo, LINK_BOX, LINK_BORDER, compactPoints, computeBBox, centerlinePath, getPath, hitStroke, outlineToPath, paintStroke, pointInPoly, strokeOutline, tailLag } from "./store";
import { live } from "./settings";
import { exp } from "./exp";
import { TileCache, Tile, TILE, MIN_LEVEL, MAX_LEVEL, tileWorldSize } from "./tiles";

export type Tool = "pen" | "eraser" | "lasso";

export interface Camera { x: number; y: number; z: number; }

type UndoEntry =
	| { type: "add"; strokes: Stroke[] }
	| { type: "remove"; strokes: Stroke[] }
	| { type: "move"; strokes: Stroke[]; dx: number; dy: number }
	| { type: "style"; strokes: Stroke[]; from: { color: string; size: number }[]; to: { color: string; size: number }[] }
	| { type: "swap"; removed: Stroke[]; added: Stroke[] };

const MIN_ZOOM = 0.03, MAX_ZOOM = 6;
const ZOOM_IDLE_MS = 140;
/** two-finger gesture thresholds, in screen px (tldraw's): spread to start zooming, midpoint travel to start panning, spread to turn a pan into a zoom */
const PINCH_ZOOM_PX = 24, PINCH_PAN_PX = 16, PAN_TO_ZOOM_PX = 64;
/** palm guards for finger panning: a one-finger pan starts after this many screen px; touches this soon after the pen are ignored */
const PAN_START_PX = 10, PALM_COOLDOWN_MS = 500;
const FRAME_BUDGET_MS = 7;
/** eraser reach, in screen px (the ring around the eraser icon shows it) */
const ERASER_PX = 8;
const TRAIL_POINTS = 24;
const HINT_COLOR = "#3b82f6", GUIDE_COLOR = "#3b82f6";

class Ring {
	private a: number[] = [];
	constructor(private n = 120) {}
	push(v: number) { this.a.push(v); if (this.a.length > this.n) this.a.shift(); }
	avg() { return this.a.length ? this.a.reduce((x, y) => x + y, 0) / this.a.length : 0; }
	max() { return this.a.length ? Math.max(...this.a) : 0; }
	clear() { this.a = []; }
}

export class InkEngine {
	store = new Store();
	tiles = new TileCache(this.store);
	cam: Camera = { x: 0, y: 0, z: 1 };

	tool: Tool = "pen";
	color = "#1e1e1e";
	size = 4.5;
	touchDraws = false;
	/** setting "Pen mode": once the pen touches the page, one finger stops moving it (two fingers still pan and zoom) */
	penOnly: () => boolean = () => false;
	/** pen mode is on right now (entered by the pen, left with exitPenMode) */
	penMode = false;
	onPenModeChange: (on: boolean) => void = () => {};
	/** a pointer the browser calls a pen touched the page (the view remembers that this device has a pen) */
	onPenSeen: () => void = () => {};
	/** one finger started panning with touch drawing off (the view may hint at "Touch draws" for finger or rubber-tip stylus users) */
	onFingerPan: () => void = () => {};
	/** the tool to go back to after a stroke made with the pen's eraser end or side button */
	private toolBeforeEraser: Tool | null = null;

	onChange: () => void = () => {};
	/** ink was added, removed or moved (not camera moves) */
	onEdit: () => void = () => {};
	/** the pen stroke being added, while onEdit runs for it (lets the view tell a tap from writing) */
	lastPenStroke: Stroke | null = null;
	onSelectionChange: (n: number) => void = () => {};
	/** called whenever the camera or selection box moves (cheap: UI only) */
	onViewChange: () => void = () => {};
	/** pen/eraser down or up: the view fades its toolbars while you write */
	onWriting: (on: boolean) => void = () => {};
	/** a link box was opened: finger tap (iPad) or Cmd/Ctrl+click (desktop) */
	onLinkOpen: (target: string) => void = () => {};
	/** last pen down/up (ms): finger/palm taps right around pen use don't open links */
	private lastPenAt = 0;
	/** pen went down on a link box: no ink until it moves; lifted in place = select the box */
	private penTap: null | { sx: number; sy: number; box: Stroke } = null;
	/** link boxes were added or removed (the view keeps the header's [[ ]] lines in step) */
	onLinksChanged: (removed: string[]) => void = () => {};

	private root: HTMLElement;
	private ink: HTMLCanvasElement; private inkCtx: CanvasRenderingContext2D;
	private overlay: HTMLCanvasElement; private overlayCtx: CanvasRenderingContext2D;
	private live: HTMLCanvasElement; private liveCtx: CanvasRenderingContext2D;
	private cssW = 1; private cssH = 1; private dpr = 1;

	private undoStack: UndoEntry[] = [];
	private redoStack: UndoEntry[] = [];

	// input state
	private drawPointer: number | null = null;
	private drawPointerType = "";
	private touches = new Map<number, { x: number; y: number }>();
	/**
	 * Touch gesture. Two fingers start "unsure" and become a pan or a zoom (tldraw's rule): a drag pans with
	 * the zoom held still, so fingers drifting apart while scrolling don't zoom. sx/sy: start midpoint; d: start spread.
	 */
	private gesture: null | { kind: "pan" | "pinch"; mode: "unsure" | "pan" | "zoom"; sx: number; sy: number; d: number; cam: Camera; wx: number; wy: number } = null;
	private mousePan: null | { id: number; x: number; y: number; cam: Camera } = null;
	/** one-finger touch that may turn out to be a tap (opens a link box) */
	private tap: null | { id: number; x: number; y: number; t: number } = null;
	/** last pointer position on the canvas (CSS px): where "Insert link" puts the box */
	private lastPointer: [number, number] | null = null;

	// pen
	private livePts: number[] = [];
	private liveDirty: Rect | null = null;

	// eraser
	private erased: Stroke[] = [];
	/** eraser icon position (CSS px) while erasing or hovering, null = hidden */
	private eraserAt: [number, number] | null = null;
	/** recent eraser positions (CSS px, x,y pairs): the grey trail behind it */
	private eraserTrail: number[] = [];

	// lasso / selection
	private lassoPts: number[] = [];
	/** lasso being drawn: the strokes it would pick if the pen lifted now (painted blue) */
	private hint: Stroke[] = [];
	private hintAt = 0;
	/** how long the last hint took (ms): big pages check less often so the lasso stays smooth */
	private hintMs = 0;
	/** lasso tool in box mode: drag a rectangle instead of drawing a free loop */
	boxSelect = false;
	/** zoom frozen: pinch and ctrl-wheel only pan; buttons (setZoom) still work */
	zoomLocked = false;
	/** hand: pen, mouse and one finger pan; no drawing, no pinch zoom */
	panMode = false;
	selection: Stroke[] = [];
	private selBox: Rect | null = null;
	private moving: null | { sx: number; sy: number; dx: number; dy: number } = null;
	/** dragging a selected link box's corner handle: (ax, ay) is the fixed top-left corner */
	private resizing: null | { box: Stroke; ax: number; ay: number; x: number; y: number; ghost: Stroke } = null;

	// frame loop
	private raf = 0;
	private lastZoomAt = 0;
	private visibleTiles: Tile[] = [];

	// perf
	perf = {
		inputMs: new Ring(), composeMs: new Ring(), frameGap: new Ring(), lastFrameAt: 0,
		loadMs: 0, saveMs: 0, fileBytes: 0, interacting: false,
		// writing smoothness
		evtRate: new Ring(30), drawRate: new Ring(30), drawGap: new Ring(), latency: new Ring(), tail: new Ring(),
		strokeEvts: 0, strokeDraws: 0, strokeStart: 0, lastDrawAt: 0, crispMs: 0, crispStrokes: 0,
	};

	constructor(root: HTMLElement) {
		this.root = root;
		const mk = (cls: string) => { const c = root.createEl("canvas", { cls }); return c; };
		this.ink = mk("ink-layer");
		this.overlay = mk("ink-overlay");
		this.live = mk("ink-live");
		this.inkCtx = this.ink.getContext("2d")!;
		this.overlayCtx = this.overlay.getContext("2d")!;
		this.liveCtx = this.live.getContext("2d", { desynchronized: exp.desync } as CanvasRenderingContext2DSettings)!;
		this.liveDesync = exp.desync;
		this.bindInput();
	}

	private liveDesync = true;

	/** Experiments changed: drop cached paths/tiles; context options are fixed per canvas, so swap the live canvas if needed. */
	applyExp() {
		for (const s of this.store.strokes.values()) { s.path = undefined; s.cpath = undefined; }
		this.tiles.clear();
		this.crisp.valid = false; this.crisp.key = ""; this.crisp.job = null;
		if (exp.desync !== this.liveDesync) {
			const c = createEl("canvas");
			c.className = "ink-live";
			c.width = this.live.width; c.height = this.live.height;
			c.style.width = this.live.style.width; c.style.height = this.live.style.height;
			this.live.replaceWith(c);
			this.live = c;
			this.liveCtx = c.getContext("2d", { desynchronized: exp.desync } as CanvasRenderingContext2DSettings)!;
			this.liveDesync = exp.desync;
			this.bindInput();
		}
		this.resetPerf();
		this.requestFrame();
	}

	destroy() { window.cancelAnimationFrame(this.raf); this.tiles.clear(); }

	resize(w: number, h: number) {
		this.dpr = window.devicePixelRatio || 1;
		this.cssW = Math.max(1, w); this.cssH = Math.max(1, h);
		this.crisp.canvas.width = Math.round(this.cssW * this.dpr); this.crisp.canvas.height = Math.round(this.cssH * this.dpr);
		this.crisp.valid = false; this.crisp.key = ""; this.crisp.job = null;
		for (const c of [this.ink, this.overlay, this.live]) {
			c.width = Math.round(this.cssW * this.dpr);
			c.height = Math.round(this.cssH * this.dpr);
			c.style.width = this.cssW + "px"; c.style.height = this.cssH + "px";
		}
		this.drawOverlay();
		this.requestFrame();
	}

	// ---------- coordinates ----------
	/** a stroke smaller than ~6 screen px: a tap or a dot, not writing */
	isTap(s: Stroke) {
		const b = s.bbox, pad = s.size;
		return Math.max(b.x1 - b.x0 - 2 * pad, b.y1 - b.y0 - 2 * pad) * this.cam.z < 6;
	}

	toWorld(sx: number, sy: number): [number, number] {
		return [(sx - this.cam.x) / this.cam.z, (sy - this.cam.y) / this.cam.z];
	}
	private local(e: PointerEvent | WheelEvent): [number, number] {
		const r = this.live.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}
	private worldView(): Rect {
		const [x0, y0] = this.toWorld(0, 0);
		const [x1, y1] = this.toWorld(this.cssW, this.cssH);
		return { x0, y0, x1, y1 };
	}
	private setWorldTransform(ctx: CanvasRenderingContext2D, dx = 0, dy = 0) {
		const s = this.dpr * this.cam.z;
		ctx.setTransform(s, 0, 0, s, this.dpr * (this.cam.x + dx * this.cam.z), this.dpr * (this.cam.y + dy * this.cam.z));
	}

	// ---------- load / save ----------
	load(text: string) {
		const t0 = performance.now();
		this.tiles.clear();
		this.undoStack = []; this.redoStack = [];
		this.clearSelection();
		const cam = this.store.load(text);
		if (cam) this.cam = cam;
		this.perf.loadMs = performance.now() - t0;
		this.perf.fileBytes = text.length;
		this.drawOverlay();
		this.requestFrame();
	}

	serialize(): string {
		const t0 = performance.now();
		const s = this.store.serialize(this.cam);
		this.perf.saveMs = performance.now() - t0;
		this.perf.fileBytes = s.length;
		return s;
	}

	clearAll() { this.store.clear(); this.tiles.clear(); this.undoStack = []; this.redoStack = []; this.clearSelection(); this.requestFrame(); }

	/** replace everything with these strokes (e.g. read from a tldraw note); no undo, no change events */
	loadStrokes(strokes: { color: string; size: number; pts: Float32Array; link?: LinkInfo }[], cam: Camera | null) {
		const t0 = performance.now();
		this.store.clear(); this.tiles.clear();
		this.undoStack = []; this.redoStack = [];
		this.clearSelection();
		for (const s of strokes) this.store.add(this.store.create(s.color, s.size, s.pts, s.link));
		if (cam) this.cam = { ...cam };
		this.perf.loadMs = performance.now() - t0;
		this.drawOverlay();
		this.requestFrame();
	}

	/** bulk insert (synthetic test) */
	addMany(strokes: { color: string; size: number; pts: Float32Array }[]) {
		for (const s of strokes) this.store.add(this.store.create(s.color, s.size, s.pts));
		this.tiles.clear();
		this.undoStack = []; this.redoStack = [];
		this.requestFrame();
		this.onChange();
	}

	// ---------- frame / compose ----------
	requestFrame() {
		if (this.raf) return;
		this.raf = window.requestAnimationFrame((ts) => { this.raf = 0; this.frame(ts); });
	}

	// ---------- crisp: exact-resolution vector render of the view once the camera is still ----------
	private crisp = { canvas: createEl("canvas"), ctx: null as CanvasRenderingContext2D | null, key: "", valid: false, job: null as Stroke[] | null, idx: 0, changedAt: 0, t: 0 };
	private camKey() { return `${this.cam.x},${this.cam.y},${this.cam.z},${this.cssW},${this.cssH}`; }

	/** returns true if more crisp work is pending */
	private crispWork(start: number): boolean {
		const c = this.crisp;
		if (!exp.crisp || c.valid) return false;
		if (performance.now() - c.changedAt < 150) return true;
		if (!c.ctx) c.ctx = c.canvas.getContext("2d")!;
		const ctx = c.ctx;
		if (!c.job) {
			const v = this.worldView(), pad = 20 / this.cam.z;
			c.job = this.store.query({ x0: v.x0 - pad, y0: v.y0 - pad, x1: v.x1 + pad, y1: v.y1 + pad });
			c.idx = 0; c.t = 0;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
		}
		this.setWorldTransform(ctx);
		const t0 = performance.now(), deadline = start + FRAME_BUDGET_MS;
		while (c.idx < c.job.length) {
			paintStroke(ctx, c.job[c.idx++]);
			if ((c.idx & 15) === 0 && performance.now() > deadline) break;
		}
		c.t += performance.now() - t0;
		if (c.idx < c.job.length) return true;
		this.perf.crispMs = c.t; this.perf.crispStrokes = c.job.length;
		c.job = null; c.valid = true;
		this.compose(false);
		return false;
	}

	private zooming() { return performance.now() - this.lastZoomAt < ZOOM_IDLE_MS; }

	targetLevel() {
		const zd = this.cam.z * this.dpr;
		const L = Math.ceil(Math.log2(zd) - 0.2);
		return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, L));
	}

	private frame(ts: number) {
		const start = performance.now();
		if (this.perf.interacting && this.perf.lastFrameAt) this.perf.frameGap.push(ts - this.perf.lastFrameAt);
		this.perf.lastFrameAt = this.perf.interacting ? ts : 0;

		this.compose(true);
		let more = false;
		if (exp.crisp && !this.crisp.valid && !this.zooming() && !this.visibleTiles.some((t) => !t.ready)) more = this.crispWork(start);
		if (!this.zooming()) {
			const deadline = start + FRAME_BUDGET_MS;
			const order = this.visibleTiles.filter((t) => !t.ready);
			if (order.length) { this.tiles.work(order, deadline); more = true; }
			else {
				// prefetch a coarser level as zoom-out fallback
				const pre = this.requestLevel(this.targetLevel() - 2, false);
				const pend = pre.filter((t) => !t.ready);
				if (pend.length) { this.tiles.work(pend, deadline); more = true; }
			}
		} else more = true;
		this.tiles.evict();
		this.tiles.stats.cached = this.tiles.size();
		this.tiles.stats.queue = this.visibleTiles.filter((t) => !t.ready).length;
		if (more) this.requestFrame();
	}

	private tileRange(L: number) {
		const ws = tileWorldSize(L);
		const v = this.worldView();
		return { ws, tx0: Math.floor(v.x0 / ws), tx1: Math.floor(v.x1 / ws), ty0: Math.floor(v.y0 / ws), ty1: Math.floor(v.y1 / ws) };
	}

	private requestLevel(L: number, sortByCenter: boolean): Tile[] {
		if (L < MIN_LEVEL) return [];
		const r = this.tileRange(L);
		const out: Tile[] = [];
		for (let ty = r.ty0; ty <= r.ty1; ty++) for (let tx = r.tx0; tx <= r.tx1; tx++) {
			const t = this.tiles.request(L, tx, ty);
			this.tiles.touch(t);
			out.push(t);
		}
		if (sortByCenter) {
			const cx = (r.tx0 + r.tx1) / 2, cy = (r.ty0 + r.ty1) / 2;
			out.sort((a, b) => (a.tx - cx) ** 2 + (a.ty - cy) ** 2 - ((b.tx - cx) ** 2 + (b.ty - cy) ** 2));
		}
		return out;
	}

	/** Copy tiles onto the ink layer. Never renders strokes itself (except via fallback copies). */
	compose(allowRequests: boolean) {
		const t0 = performance.now();
		this.tiles.beginFrame();
		const ctx = this.inkCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.ink.width, this.ink.height);
		ctx.imageSmoothingEnabled = true;
		const L = this.targetLevel();
		const r = this.tileRange(L);
		const zd = this.cam.z * this.dpr;
		const req = allowRequests && !this.zooming();
		const visible: Tile[] = [];
		const toDev = (wx: number, wy: number) => [Math.round((wx * this.cam.z + this.cam.x) * this.dpr), Math.round((wy * this.cam.z + this.cam.y) * this.dpr)];

		for (let ty = r.ty0; ty <= r.ty1; ty++) for (let tx = r.tx0; tx <= r.tx1; tx++) {
			const [dx0, dy0] = toDev(tx * r.ws, ty * r.ws);
			const [dx1, dy1] = toDev((tx + 1) * r.ws, (ty + 1) * r.ws);
			const dw = dx1 - dx0, dh = dy1 - dy0;
			let t = this.tiles.get(L, tx, ty);
			if (!t && req) t = this.tiles.request(L, tx, ty);
			if (t) { this.tiles.touch(t); visible.push(t); }
			if (t && t.ready) { ctx.drawImage(t.canvas, dx0, dy0, dw, dh); continue; }
			// fallback: coarser parent, stretched
			let drew = false;
			for (let k = 1; k <= 4 && L - k >= MIN_LEVEL; k++) {
				const f = 1 << k;
				const px = Math.floor(tx / f), py = Math.floor(ty / f);
				const p = this.tiles.get(L - k, px, py);
				if (p && p.ready) {
					const sub = TILE / f;
					ctx.drawImage(p.canvas, (tx - px * f) * sub, (ty - py * f) * sub, sub, sub, dx0, dy0, dw, dh);
					this.tiles.touch(p); drew = true; break;
				}
			}
			// fallback: finer children
			for (let k = 1; k <= 2 && L + k <= MAX_LEVEL; k++) {
				const f = 1 << k;
				let found = 0;
				for (let cy = 0; cy < f; cy++) for (let cx = 0; cx < f; cx++) {
					const c = this.tiles.get(L + k, tx * f + cx, ty * f + cy);
					if (!c || !c.ready) continue;
					const cdx0 = dx0 + Math.round((cx * dw) / f), cdy0 = dy0 + Math.round((cy * dh) / f);
					const cdx1 = dx0 + Math.round(((cx + 1) * dw) / f), cdy1 = dy0 + Math.round(((cy + 1) * dh) / f);
					ctx.drawImage(c.canvas, cdx0, cdy0, cdx1 - cdx0, cdy1 - cdy0);
					this.tiles.touch(c); found++;
				}
				if (found || drew) break;
			}
		}
		this.visibleTiles = visible;
		if (exp.crisp) {
			const k = this.camKey();
			if (k !== this.crisp.key) { this.crisp.key = k; this.crisp.valid = false; this.crisp.job = null; this.crisp.changedAt = performance.now(); }
			else if (this.crisp.valid) {
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.clearRect(0, 0, this.ink.width, this.ink.height);
				ctx.drawImage(this.crisp.canvas, 0, 0);
			}
		}
		this.perf.composeMs.push(performance.now() - t0);
		void zd;
	}

	private isTileVisible = (t: Tile) => this.visibleTiles.includes(t);

	// ---------- overlay (selection) ----------
	private drawOverlay() {
		this.drawOverlayInner();
		this.onViewChange();
	}

	/** selection box in CSS px, or null */
	selectionScreenBox(): Rect | null {
		if (!this.selection.length || !this.selBox) return null;
		const dx = this.moving?.dx ?? 0, dy = this.moving?.dy ?? 0, b = this.selBox, z = this.cam.z;
		return { x0: (b.x0 + dx) * z + this.cam.x, y0: (b.y0 + dy) * z + this.cam.y, x1: (b.x1 + dx) * z + this.cam.x, y1: (b.y1 + dy) * z + this.cam.y };
	}

	isMovingSelection() { return !!this.moving; }

	zoomBy(f: number) { this.setZoom(this.cam.z * f); }

	zoomToFit() {
		let r: Rect | null = null;
		for (const s of this.store.strokes.values()) {
			if (!r) r = { ...s.bbox };
			else { r.x0 = Math.min(r.x0, s.bbox.x0); r.y0 = Math.min(r.y0, s.bbox.y0); r.x1 = Math.max(r.x1, s.bbox.x1); r.y1 = Math.max(r.y1, s.bbox.y1); }
		}
		if (!r) { this.cam = { x: 0, y: 0, z: 1 }; this.camChanged(true); return; }
		const pad = 40;
		const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min((this.cssW - 2 * pad) / (r.x1 - r.x0), (this.cssH - 2 * pad) / (r.y1 - r.y0))));
		this.cam = { z, x: this.cssW / 2 - ((r.x0 + r.x1) / 2) * z, y: this.cssH / 2 - ((r.y0 + r.y1) / 2) * z };
		this.camChanged(true);
		this.scheduleCamSave();
	}

	private drawOverlayInner() {
		const ctx = this.overlayCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
		if (this.hint.length) {
			this.setWorldTransform(ctx);
			for (const s of this.hint) this.paintTinted(ctx, s, HINT_COLOR);
		}
		if (this.erased.length) {
			// strokes the eraser has touched stay faintly visible until the pen lifts
			this.setWorldTransform(ctx);
			ctx.globalAlpha = 0.25;
			for (const s of this.erased) paintStroke(ctx, s);
			ctx.globalAlpha = 1;
		}
		if (!this.selection.length || !this.selBox) return;
		if (this.moving && live.settings.moveGuides) this.drawGuides();
		const dx = this.moving?.dx ?? 0, dy = this.moving?.dy ?? 0;
		if (this.moving) {
			this.setWorldTransform(ctx, dx, dy);
			for (const s of this.selection) paintStroke(ctx, s);
		}
		if (this.resizing) { this.setWorldTransform(ctx); paintStroke(ctx, this.resizing.ghost); }
		const lb = this.selectedLinkBox();
		if (lb) {
			// resize handle: bottom-right corner of the box (ink selections have none: it got in the way of moving)
			const r = this.resizing ? { x1: this.resizing.x, y1: this.resizing.y } : rectOf(lb);
			const hx = (r.x1 + dx) * this.cam.z + this.cam.x, hy = (r.y1 + dy) * this.cam.z + this.cam.y;
			ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
			ctx.beginPath(); ctx.arc(hx, hy, 9, 0, Math.PI * 2);
			ctx.fillStyle = "#ffffff"; ctx.fill();
			ctx.lineWidth = 2; ctx.strokeStyle = "#3b82f6"; ctx.stroke();
		}
		this.setWorldTransform(ctx, dx, dy);
		const b = this.selBox;
		ctx.lineWidth = 1.5 / this.cam.z;
		ctx.setLineDash([6 / this.cam.z, 4 / this.cam.z]);
		ctx.strokeStyle = "#3b82f6";
		ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
		ctx.setLineDash([]);
	}

	/** a stroke painted in one colour (lasso hint) */
	private paintTinted(ctx: CanvasRenderingContext2D, s: Stroke, color: string) {
		if (s.link) {
			const r = rectOf(s);
			ctx.lineWidth = 3 / this.cam.z; ctx.strokeStyle = color;
			ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
		} else if (exp.centerline) {
			if (!s.cpath) s.cpath = centerlinePath(s.pts, s.size, true, s.smooth);
			ctx.strokeStyle = color; ctx.lineWidth = s.size; ctx.lineCap = "round"; ctx.lineJoin = "round";
			ctx.stroke(s.cpath);
		} else {
			ctx.fillStyle = color;
			ctx.fill(getPath(s));
		}
	}

	/**
	 * Alignment guides while dragging a selection (setting "Alignment guides when moving"):
	 * moving up/down shows horizontal lines through its top and bottom edges, moving sideways vertical
	 * lines through its left and right edges, across the whole view, to line it up with other writing.
	 */
	private drawGuides() {
		const m = this.moving!, b = this.selBox!, z = this.cam.z;
		const ax = Math.abs(m.dx * z), ay = Math.abs(m.dy * z);
		if (Math.max(ax, ay) < 4) return;
		const ctx = this.overlayCtx;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.lineWidth = 1;
		ctx.setLineDash([6, 5]);
		ctx.strokeStyle = GUIDE_COLOR;
		const line = (x0: number, y0: number, x1: number, y1: number) => {
			// half-pixel offset: a crisp 1 px line
			ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5); ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5); ctx.stroke();
		};
		const sx = (x: number) => (x + m.dx) * z + this.cam.x, sy = (y: number) => (y + m.dy) * z + this.cam.y;
		const showH = ay >= ax / 2, showV = ax >= ay / 2;
		// the main direction is solid-ish; the other only shows (fainter) on a diagonal drag
		if (showH) {
			ctx.globalAlpha = ay >= ax ? 0.9 : 0.45;
			line(0, sy(b.y0), this.cssW, sy(b.y0)); line(0, sy(b.y1), this.cssW, sy(b.y1));
		}
		if (showV) {
			ctx.globalAlpha = ax > ay ? 0.9 : 0.45;
			line(sx(b.x0), 0, sx(b.x0), this.cssH); line(sx(b.x1), 0, sx(b.x1), this.cssH);
		}
		ctx.globalAlpha = 1;
		ctx.setLineDash([]);
	}

	// ---------- live layer ----------
	private clearLive() {
		const ctx = this.liveCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.live.width, this.live.height);
		this.liveDirty = null;
	}

	private liveRaf = 0;
	private oldestPending = 0;

	/** pen moved: draw now, or once per frame (exp.rafBatch / exp.fps60) */
	private scheduleLive() {
		if (!(exp.rafBatch || exp.fps60)) { this.drawLiveStroke(); return; }
		if (this.liveRaf) return;
		const tick = () => {
			this.liveRaf = 0;
			if (this.drawPointer === null || this.tool !== "pen") return;
			if (exp.fps60 && performance.now() - this.perf.lastDrawAt < 15) { this.liveRaf = window.requestAnimationFrame(tick); return; }
			this.drawLiveStroke();
		};
		this.liveRaf = window.requestAnimationFrame(tick);
	}

	private drawLiveStroke() {
		const t0 = performance.now();
		const ctx = this.liveCtx;
		const pts = this.livePts;
		// clear previous bounds only
		if (this.liveDirty) {
			const d = this.liveDirty;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
		}
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		this.setWorldTransform(ctx);
		if (exp.centerline) {
			for (let i = 0; i < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
			const h = this.size; x0 -= h; y0 -= h; x1 += h; y1 += h;
			ctx.strokeStyle = this.color; ctx.lineWidth = this.size; ctx.lineCap = "round"; ctx.lineJoin = "round";
			ctx.stroke(centerlinePath(pts, this.size, false));
		} else {
			const outline = strokeOutline(pts, this.size, false);
			for (const p of outline) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
			ctx.fillStyle = this.color;
			ctx.fill(outlineToPath(outline));
		}
		const s = this.dpr * this.cam.z;
		this.liveDirty = {
			x0: Math.floor(x0 * s + this.cam.x * this.dpr) - 4, y0: Math.floor(y0 * s + this.cam.y * this.dpr) - 4,
			x1: Math.ceil(x1 * s + this.cam.x * this.dpr) + 4, y1: Math.ceil(y1 * s + this.cam.y * this.dpr) + 4,
		};
		const now = performance.now();
		this.perf.inputMs.push(now - t0);
		if (this.oldestPending) { this.perf.latency.push(now - this.oldestPending); this.oldestPending = 0; }
		if (this.perf.lastDrawAt && this.perf.strokeDraws) this.perf.drawGap.push(now - this.perf.lastDrawAt);
		this.perf.lastDrawAt = now;
		this.perf.strokeDraws++;
		if (pts.length >= 4) this.perf.tail.push(tailLag(pts, this.size) * this.cam.z);
	}

	/** the eraser icon at the pen tip, its reach as a ring, and a short grey trail (live layer, screen px) */
	private drawEraser() {
		const ctx = this.liveCtx;
		this.clearLive();
		this.live.style.cursor = this.eraserAt ? "none" : "";
		if (!this.eraserAt) return;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		const t = this.eraserTrail;
		if (t.length >= 4) {
			ctx.lineCap = "round"; ctx.lineJoin = "round";
			ctx.strokeStyle = "rgba(128, 128, 128, 0.35)";
			ctx.lineWidth = 6;
			ctx.beginPath(); ctx.moveTo(t[0], t[1]);
			for (let i = 2; i < t.length; i += 2) ctx.lineTo(t[i], t[i + 1]);
			ctx.stroke();
		}
		const [x, y] = this.eraserAt;
		ctx.beginPath(); ctx.arc(x, y, ERASER_PX, 0, Math.PI * 2);
		ctx.fillStyle = "rgba(255, 255, 255, 0.5)"; ctx.fill();
		ctx.lineWidth = 1.5; ctx.strokeStyle = "#6b7280"; ctx.stroke();
		// a little eraser, tilted, up and to the right of the tip so the pen's own body doesn't hide it
		ctx.save();
		ctx.translate(x + ERASER_PX + 3, y - ERASER_PX - 3);
		ctx.rotate(-Math.PI / 4);
		const w = 24, h = 12;
		const rr = (x0: number, w0: number) => {
			ctx.beginPath();
			if (typeof ctx.roundRect === "function") ctx.roundRect(x0, -h / 2, w0, h, 2.5); else ctx.rect(x0, -h / 2, w0, h);
		};
		rr(0, w); ctx.fillStyle = "#ffffff"; ctx.fill();
		rr(0, w * 0.4); ctx.fillStyle = "#f472b6"; ctx.fill();
		rr(0, w); ctx.lineWidth = 1.5; ctx.strokeStyle = "#374151"; ctx.stroke();
		ctx.beginPath(); ctx.moveTo(w * 0.4, -h / 2); ctx.lineTo(w * 0.4, h / 2); ctx.stroke();
		ctx.restore();
	}

	/** the view switched tools: hide the eraser icon until the pointer moves again */
	toolChanged() {
		if (!this.eraserAt || this.drawPointer !== null) return;
		this.eraserAt = null; this.eraserTrail = [];
		this.drawEraser();
	}

	private drawLasso() {
		const ctx = this.liveCtx;
		this.clearLive();
		if (this.lassoPts.length < 4) return;
		this.setWorldTransform(ctx);
		ctx.beginPath();
		ctx.moveTo(this.lassoPts[0], this.lassoPts[1]);
		for (let i = 2; i < this.lassoPts.length; i += 2) ctx.lineTo(this.lassoPts[i], this.lassoPts[i + 1]);
		if (this.boxSelect) ctx.closePath();
		ctx.lineWidth = 1.5 / this.cam.z;
		ctx.setLineDash([5 / this.cam.z, 4 / this.cam.z]);
		ctx.strokeStyle = "#3b82f6";
		ctx.stroke();
		ctx.setLineDash([]);
	}

	// ---------- input ----------
	private bindInput() {
		const el = this.live;
		el.addEventListener("pointerdown", (e) => this.onDown(e));
		el.addEventListener("pointermove", (e) => this.onMove(e));
		el.addEventListener("pointerup", (e) => this.onUp(e, false));
		el.addEventListener("pointercancel", (e) => this.onUp(e, true));
		el.addEventListener("pointerleave", () => { if (this.drawPointer === null && this.eraserAt) { this.eraserAt = null; this.drawEraser(); } });
		el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		const stop = (e: TouchEvent) => { e.preventDefault(); e.stopPropagation(); };
		el.addEventListener("touchstart", stop, { passive: false });
		el.addEventListener("touchmove", stop, { passive: false });
		el.addEventListener("contextmenu", (e) => e.preventDefault());
	}

	private capture(id: number) { try { this.live.setPointerCapture(id); } catch { /* synthetic or already-ended pointer */ } }

	private onDown(e: PointerEvent) {
		e.preventDefault();
		// preventDefault stops the mousedown Obsidian's menus listen for to close on an outside click:
		// with a menu open, this tap closes it (and draws nothing), like a click anywhere else
		const menu = this.root.doc.body.querySelector(".menu");
		if (menu) { this.live.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); return; }
		const [x, y] = this.local(e);
		const isTouch = e.pointerType === "touch";
		this.lastPointer = [x, y];
		if (!isTouch && e.pointerType !== "mouse") { this.lastPenAt = performance.now(); this.tap = null; }

		if (e.pointerType === "mouse" && e.button === 0 && (e.metaKey || e.ctrlKey)) {
			const l = this.linkAt(x, y);
			if (l) { this.onLinkOpen(l.link!.target); return; }
		}
		if (this.panMode && !isTouch && (e.pointerType !== "mouse" || e.button === 0)) {
			// hand: the pen (or mouse) drags the page; reuses the mouse-pan path
			this.mousePan = { id: e.pointerId, x, y, cam: { ...this.cam } };
			this.capture(e.pointerId);
			this.perf.interacting = true;
			return;
		}
		if (isTouch) {
			if (this.drawPointer !== null && this.drawPointerType !== "touch") return; // palm guard
			if (!this.touchDraws) {
				// a palm landing as the pen lifts between words never moves the page
				// (no contact-size check: on iPad a fingertip can report as wide as a palm, which blocked all panning)
				if (performance.now() - this.lastPenAt < PALM_COOLDOWN_MS) return;
			}
			this.tap = this.touches.size === 0 ? { id: e.pointerId, x, y, t: performance.now() } : null;
			this.touches.set(e.pointerId, { x, y });
			this.capture(e.pointerId);
			// with touch drawing on, a finger on a link box pans/taps instead of drawing
			if (this.touchDraws && !this.panMode && this.touches.size === 1 && this.drawPointer === null && !this.linkAt(x, y)) {
				this.startDraw(e, x, y);
				return;
			}
			if (this.drawPointerType === "touch" && this.drawPointer !== null) this.cancelDraw();
			this.startGesture();
			return;
		}
		if (e.pointerType === "mouse" && (e.button === 1 || e.button === 2)) {
			this.mousePan = { id: e.pointerId, x, y, cam: { ...this.cam } };
			this.capture(e.pointerId);
			this.perf.interacting = true;
			return;
		}
		if (e.pointerType === "mouse" && e.button !== 0) return;
		// pen (or mouse left): cancel any finger gesture
		this.touches.clear(); this.gesture = null;
		if (e.pointerType === "pen") this.onPenSeen();
		if (e.pointerType === "pen" && !this.penMode && !this.touchDraws && this.penOnly()) { this.penMode = true; this.onPenModeChange(true); }
		if (this.drawPointer !== null) return;
		this.capture(e.pointerId);
		// eraser end (Surface, Wacom) or side button held (S Pen, Surface barrel): erase for this stroke only
		if (e.pointerType === "pen" && (e.buttons & (32 | 2)) && this.tool !== "eraser") {
			this.toolBeforeEraser = this.tool;
			this.tool = "eraser";
		}
		this.startDraw(e, x, y);
	}

	private startGesture() {
		const pts = [...this.touches.values()];
		if (pts.length === 0) { this.gesture = null; this.perf.interacting = false; return; }
		// pen mode: one finger does nothing (a tap still opens a link box); two fingers pan and zoom
		if (pts.length < 2 && this.inPenMode() && !this.panMode) { this.gesture = null; this.perf.interacting = false; return; }
		this.perf.interacting = true;
		const sx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
		const sy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
		const d = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
		const [wx, wy] = this.toWorld(sx, sy);
		const kind = pts.length >= 2 ? "pinch" : "pan";
		this.gesture = { kind, mode: "unsure", sx, sy, d, cam: { ...this.cam }, wx, wy };
	}

	private onMove(e: PointerEvent) {
		if (this.mousePan && e.pointerId === this.mousePan.id) {
			const [x, y] = this.local(e);
			this.cam.x = this.mousePan.cam.x + (x - this.mousePan.x);
			this.cam.y = this.mousePan.cam.y + (y - this.mousePan.y);
			this.camChanged(false);
			return;
		}
		if (this.touches.has(e.pointerId) && this.drawPointer !== e.pointerId) {
			const [x, y] = this.local(e);
			this.touches.set(e.pointerId, { x, y });
			if (this.tap && (this.tap.id !== e.pointerId || Math.hypot(x - this.tap.x, y - this.tap.y) > 10)) this.tap = null;
			this.updateGesture();
			return;
		}
		if (e.pointerId !== this.drawPointer) {
			if (e.pointerType === "mouse" && this.drawPointer === null) this.lastPointer = this.local(e); // hover
			// mouse, or a pencil that reports hover (iPad M2 and later): the eraser icon follows it
			if (this.drawPointer === null && e.pointerType !== "touch" && this.tool === "eraser" && !this.panMode) {
				this.eraserAt = this.local(e); this.eraserTrail = [];
				this.drawEraser();
			}
			return;
		}
		const evs = !exp.noCoalesced && e.getCoalescedEvents ? e.getCoalescedEvents() : [];
		const list = evs.length ? evs : [e];
		const r = this.live.getBoundingClientRect();
		if (!this.oldestPending) this.oldestPending = list[0].timeStamp || e.timeStamp;
		this.perf.strokeEvts += list.length;
		for (const ev of list) this.drawMove(ev.clientX - r.left, ev.clientY - r.top);
		this.drawMoveEnd();
	}

	private updateGesture() {
		const g = this.gesture;
		if (!g) return;
		const pts = [...this.touches.values()];
		const sx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
		const sy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
		// one finger: pan only once it has really moved, so a resting palm or fingertip doesn't nudge the page
		if (g.kind === "pan" && g.mode === "unsure") {
			if (Math.hypot(sx - g.sx, sy - g.sy) <= PAN_START_PX) return;
			g.mode = "pan";
			if (!this.touchDraws && !this.panMode) this.onFingerPan();
		}
		let z = g.cam.z;
		if (g.kind === "pinch" && pts.length >= 2 && g.d > 0) {
			const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
			const canZoom = !this.zoomLocked && !this.panMode;
			const spread = Math.abs(d - g.d);
			if (g.mode === "unsure") {
				if (canZoom && spread > PINCH_ZOOM_PX) g.mode = "zoom";
				else if (Math.hypot(sx - g.sx, sy - g.sy) > PINCH_PAN_PX) g.mode = "pan";
				else return; // not decided yet: the view holds still
			} else if (g.mode === "pan" && canZoom && spread > PAN_TO_ZOOM_PX) {
				// a deliberate pinch during a pan: zoom from here, without a jump
				g.mode = "zoom"; g.cam = { ...this.cam }; g.d = d;
				[g.wx, g.wy] = this.toWorld(sx, sy);
			}
			if (g.mode === "zoom" && canZoom) z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, g.cam.z * (d / g.d)));
		}
		this.cam.z = z;
		this.cam.x = sx - g.wx * z;
		this.cam.y = sy - g.wy * z;
		this.camChanged(g.mode === "zoom");
	}

	private onUp(e: PointerEvent, cancelled: boolean) {
		if (e.pointerType === "pen") this.lastPenAt = performance.now();
		if (this.mousePan && e.pointerId === this.mousePan.id) { this.mousePan = null; this.perf.interacting = false; this.onChange(); return; }
		if (this.touches.has(e.pointerId) && this.drawPointer !== e.pointerId) {
			const tap = this.tap;
			this.tap = null;
			if (tap && tap.id === e.pointerId && !cancelled && performance.now() - tap.t < 500) {
				const l = this.linkAt(tap.x, tap.y);
				const penNear = this.drawPointer !== null || performance.now() - this.lastPenAt < 800 || tap.t - this.lastPenAt < 800;
				if (l && !penNear) this.onLinkOpen(l.link!.target);
			}
			this.touches.delete(e.pointerId);
			this.startGesture(); // re-anchor with remaining fingers
			if (!this.gesture) this.onChange(); // camera saved
			return;
		}
		if (e.pointerId !== this.drawPointer) return;
		this.touches.delete(e.pointerId);
		if (cancelled) this.cancelDraw();
		else this.endDraw();
		if (this.toolBeforeEraser) { this.tool = this.toolBeforeEraser; this.toolBeforeEraser = null; }
	}

	private inPenMode() { return this.penMode && !this.touchDraws && this.penOnly(); }

	/** leave pen mode: one finger pans again, until the pen next touches the page */
	exitPenMode() { if (!this.penMode) return; this.penMode = false; this.onPenModeChange(false); }

	private onWheel(e: WheelEvent) {
		e.preventDefault();
		const [x, y] = this.local(e);
		if (e.ctrlKey || e.metaKey) {
			if (this.zoomLocked) return;
			const [wx, wy] = this.toWorld(x, y);
			const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.cam.z * Math.exp(-e.deltaY * 0.01)));
			this.cam.z = z; this.cam.x = x - wx * z; this.cam.y = y - wy * z;
			this.camChanged(true);
		} else {
			this.cam.x -= e.deltaX; this.cam.y -= e.deltaY;
			this.camChanged(false);
		}
		this.scheduleCamSave();
	}

	private camSaveTimer = 0;
	private scheduleCamSave() {
		window.clearTimeout(this.camSaveTimer);
		this.camSaveTimer = window.setTimeout(() => this.onChange(), 1000);
	}

	private camChanged(zoom: boolean) {
		if (zoom) this.lastZoomAt = performance.now();
		// overlay + live depend on camera
		this.drawOverlay();
		if (this.drawPointer === null) this.clearLive();
		this.requestFrame();
	}

	setZoom(z: number) {
		const cx = this.cssW / 2, cy = this.cssH / 2;
		const [wx, wy] = this.toWorld(cx, cy);
		this.cam.z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
		this.cam.x = cx - wx * this.cam.z; this.cam.y = cy - wy * this.cam.z;
		this.camChanged(true);
		this.scheduleCamSave();
	}

	// ---------- tools ----------
	private startDraw(e: PointerEvent, x: number, y: number) {
		this.drawPointer = e.pointerId;
		this.drawPointerType = e.pointerType;
		const [wx, wy] = this.toWorld(x, y);
		// a selection (lasso, or a link box picked with a pencil tap): handle = resize, inside = move
		if (this.tool !== "eraser" && this.selection.length && this.selBox) {
			const box = this.selectedLinkBox();
			if (box && this.onHandle(box, x, y)) { this.beginResize(box); return; }
			const b = this.selBox;
			if (wx >= b.x0 && wx <= b.x1 && wy >= b.y0 && wy <= b.y1) { this.beginMove(wx, wy); return; }
			this.clearSelection();
		}
		if (this.tool !== "lasso") this.onWriting(true);
		if (this.tool === "pen") {
			this.livePts = [wx, wy];
			this.lastRecorded = [wx, wy]; this.mergeNext = false;
			this.perf.strokeEvts = 0; this.perf.strokeDraws = 0; this.perf.strokeStart = performance.now(); this.oldestPending = 0;
			this.clearLive();
			const box = e.pointerType !== "touch" ? this.linkAtWorld(wx, wy) : null;
			this.penTap = box ? { sx: x, sy: y, box } : null;
			if (!box) this.drawLiveStroke();
		} else if (this.tool === "eraser") {
			this.erased = [];
			this.eraserAt = [x, y]; this.eraserTrail = [x, y];
			this.eraseAt(wx, wy);
			this.drawEraser();
		} else {
			this.lassoPts = [wx, wy];
		}
	}

	private drawMove(x: number, y: number) {
		const [wx, wy] = this.toWorld(x, y);
		if (this.resizing) {
			const r = this.resizing;
			r.x = Math.max(r.ax + MIN_LINK, wx); r.y = Math.max(r.ay + MIN_LINK, wy);
			r.ghost = this.ghostBox(r.box, r.ax, r.ay, r.x, r.y);
			this.selBox = r.ghost.bbox;
			return;
		}
		if (this.moving) { this.moving.dx = wx - this.moving.sx; this.moving.dy = wy - this.moving.sy; return; }
		if (this.tool === "pen") {
			// on a link box: ink starts only once the pen really moves (writing inside a box still works)
			if (this.penTap && Math.hypot(x - this.penTap.sx, y - this.penTap.sy) > 6) this.penTap = null;
			const n = this.livePts.length;
			if (exp.tlFilter) {
				// tldraw: round to 0.01; a point < 1 screen px from the last recorded one replaces it instead of adding
				const rx = Math.round(wx * 100) / 100, ry = Math.round(wy * 100) / 100;
				if (this.mergeNext && n >= 4) { this.livePts[n - 2] = rx; this.livePts[n - 1] = ry; }
				else this.livePts.push(rx, ry);
				if (Math.hypot(wx - this.lastRecorded[0], wy - this.lastRecorded[1]) >= 1 / this.cam.z) { this.lastRecorded = [wx, wy]; this.mergeNext = false; }
				else this.mergeNext = true;
			} else if (this.livePts[n - 2] !== wx || this.livePts[n - 1] !== wy) this.livePts.push(wx, wy);
		} else if (this.tool === "eraser") {
			this.eraserAt = [x, y];
			this.eraserTrail.push(x, y);
			if (this.eraserTrail.length > 2 * TRAIL_POINTS) this.eraserTrail.splice(0, this.eraserTrail.length - 2 * TRAIL_POINTS);
			this.eraseAt(wx, wy);
		} else if (this.boxSelect) {
			const sx = this.lassoPts[0], sy = this.lassoPts[1];
			this.lassoPts = [sx, sy, wx, sy, wx, wy, sx, wy];
		} else {
			this.lassoPts.push(wx, wy);
		}
	}

	private mergeNext = false;
	private lastRecorded: [number, number] = [0, 0];

	private drawMoveEnd() {
		if (this.moving || this.resizing) this.drawOverlay();
		else if (this.tool === "pen") { if (!this.penTap) this.scheduleLive(); }
		else if (this.tool === "lasso") { this.drawLasso(); this.updateHint(); }
		else if (this.tool === "eraser") this.drawEraser();
	}

	private cancelDraw() {
		this.onWriting(false);
		this.penTap = null;
		if (this.tool === "eraser" || this.moving || this.resizing) this.endDraw();
		this.drawPointer = null; this.drawPointerType = "";
		this.livePts = []; this.lassoPts = [];
		this.clearHint();
		this.eraserTrail = []; this.eraserAt = null;
		this.clearLive();
	}

	private endDraw() {
		const tool = this.tool, ptype = this.drawPointerType;
		this.onWriting(false);
		this.drawPointer = null; this.drawPointerType = "";
		if (this.resizing) { this.endResize(); return; }
		if (this.moving) { this.endMove(); return; }
		if (tool === "pen") {
			window.cancelAnimationFrame(this.liveRaf); this.liveRaf = 0;
			const dur = (performance.now() - this.perf.strokeStart) / 1000;
			if (dur > 0.15) { this.perf.evtRate.push(this.perf.strokeEvts / dur); this.perf.drawRate.push(this.perf.strokeDraws / dur); }
			// pencil tap on a link box: select it (tldraw: the pen edits, a finger opens); no dot
			const tapped = this.penTap?.box ?? null;
			this.penTap = null;
			if (tapped) {
				this.livePts = [];
				this.clearLive();
				this.selectLink(tapped);
				return;
			}
			if (this.livePts.length >= 2) {
				const raw = new Float32Array(this.livePts);
				// compact ink: keep the smoothed, simplified line instead of every pen sample
				const s = live.settings.compactInk
					? Object.assign(this.store.create(this.color, this.size, compactPoints(raw, this.size)), { smooth: true })
					: this.store.create(this.color, this.size, raw);
				this.lastPenStroke = s;
				try { this.addStrokes([s]); } finally { this.lastPenStroke = null; }
				this.push({ type: "add", strokes: [s] });
			}
			this.livePts = [];
			// addStrokes composed the ink layer in this same task, so clearing live now can't flicker
			this.clearLive();
		} else if (tool === "eraser") {
			if (this.erased.length) this.push({ type: "remove", strokes: this.erased });
			this.erased = [];
			this.drawOverlay();
			// the icon stays only for a hovering mouse; a pen that hovers brings it back on its own
			this.eraserTrail = [];
			if (ptype !== "mouse") this.eraserAt = null;
			this.drawEraser();
		} else {
			this.finishLasso();
			this.clearLive();
		}
	}

	private union(strokes: Stroke[]): Rect | null {
		if (!strokes.length) return null;
		const r = { ...strokes[0].bbox };
		for (const s of strokes) {
			if (s.bbox.x0 < r.x0) r.x0 = s.bbox.x0; if (s.bbox.y0 < r.y0) r.y0 = s.bbox.y0;
			if (s.bbox.x1 > r.x1) r.x1 = s.bbox.x1; if (s.bbox.y1 > r.y1) r.y1 = s.bbox.y1;
		}
		return r;
	}

	private addStrokes(strokes: Stroke[]) {
		for (const s of strokes) { this.store.add(s); this.tiles.addStroke(s); }
		if (exp.crisp && this.crisp.ctx) {
			if (this.crisp.valid) { this.setWorldTransform(this.crisp.ctx); for (const s of strokes) paintStroke(this.crisp.ctx, s); }
			else if (this.crisp.job) this.crisp.job.push(...strokes);
		}
		this.compose(false); this.requestFrame();
		this.onChange(); this.onEdit();
		if (!this.moving && !this.resizing && strokes.some((s) => s.link)) this.onLinksChanged([]);
	}

	private removeStrokes(strokes: Stroke[]) {
		for (const s of strokes) this.store.remove(s);
		this.crisp.valid = false; this.crisp.job = null; this.crisp.changedAt = 0;
		const r = this.union(strokes);
		if (r) this.tiles.invalidate(r, this.isTileVisible);
		this.compose(false); this.requestFrame();
		this.onChange(); this.onEdit();
		const gone = strokes.filter((s) => s.link).map((s) => s.link!.target);
		if (gone.length) this.onLinksChanged(gone);
	}

	private eraseAt(wx: number, wy: number) {
		const rad = ERASER_PX / this.cam.z;
		const cands = this.store.query({ x0: wx - rad, y0: wy - rad, x1: wx + rad, y1: wy + rad });
		const hit = cands.filter((s) => hitStroke(s, wx, wy, rad));
		if (!hit.length) return;
		this.erased.push(...hit);
		this.removeStrokes(hit);
		this.drawOverlay();
	}

	private polyBounds(poly: number[]): Rect {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (let i = 0; i < poly.length; i += 2) {
			x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]); y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]);
		}
		return { x0, y0, x1, y1 };
	}

	/** a lasso this small is a tap (picks the link box under it), not a loop */
	private isLassoTap(poly: number[], r: Rect) { return poly.length < 6 || Math.max(r.x1 - r.x0, r.y1 - r.y0) * this.cam.z < 6; }

	/** while the lasso is drawn: show which strokes it would pick (tldraw shows the same), checked a few times a second */
	private updateHint() {
		const now = performance.now();
		if (now - this.hintAt < Math.max(40, this.hintMs * 4)) return;
		this.hintAt = now;
		let poly = this.lassoPts;
		const r = this.polyBounds(poly);
		let next: Stroke[] = [];
		if (!this.isLassoTap(poly, r)) {
			// a coarser loop (at most ~80 corners) is plenty for a preview; lifting the pen uses the full one
			const k = Math.max(1, Math.ceil(poly.length / 160));
			if (k > 1) { const p: number[] = []; for (let i = 0; i < poly.length; i += 2 * k) p.push(poly[i], poly[i + 1]); poly = p; }
			next = this.strokesInPoly(poly, r);
		}
		this.hintMs = performance.now() - now;
		if (next.length === this.hint.length && next.every((s, i) => s === this.hint[i])) return;
		this.hint = next;
		this.drawOverlay();
	}

	private clearHint() { if (this.hint.length) { this.hint = []; this.drawOverlay(); } }

	private finishLasso() {
		const poly = this.lassoPts;
		this.lassoPts = [];
		this.hint = [];
		if (!poly.length) { this.drawOverlay(); return; }
		const r = this.polyBounds(poly);
		// a tap with the lasso: pick the link box under it
		if (this.isLassoTap(poly, r)) {
			this.drawOverlay();
			const l = this.linkAtWorld(poly[0], poly[1]);
			if (l) this.selectLink(l);
			return;
		}
		this.setSelection(this.strokesInPoly(poly, r));
	}

	/** strokes inside a lasso: link boxes by their centre, ink when at least half its points are in */
	private strokesInPoly(poly: number[], r: Rect): Stroke[] {
		const sel: Stroke[] = [];
		for (const s of this.store.query(r)) {
			if (s.link) {
				if (pointInPoly((s.bbox.x0 + s.bbox.x1) / 2, (s.bbox.y0 + s.bbox.y1) / 2, poly)) sel.push(s);
				continue;
			}
			let inside = 0, total = 0;
			const step = Math.max(2, Math.floor(s.pts.length / 40) * 2);
			for (let i = 0; i < s.pts.length; i += step) { total++; if (pointInPoly(s.pts[i], s.pts[i + 1], poly)) inside++; }
			if (inside / total >= 0.5) sel.push(s);
		}
		return sel;
	}

	private setSelection(sel: Stroke[]) {
		this.selection = sel;
		this.selBox = this.union(sel);
		this.drawOverlay();
		this.onSelectionChange(sel.length);
	}

	clearSelection() { if (this.selection.length || this.selBox) this.setSelection([]); }

	private beginMove(wx: number, wy: number) {
		this.moving = { sx: wx, sy: wy, dx: 0, dy: 0 };
		// lift strokes off the tiles; they ride on the overlay while dragging
		for (const s of this.selection) this.store.remove(s);
		this.crisp.valid = false; this.crisp.job = null; this.crisp.changedAt = 0;
		const r = this.union(this.selection);
		if (r) this.tiles.invalidate(r, this.isTileVisible);
		this.compose(false);
		this.drawOverlay();
	}

	private endMove() {
		const m = this.moving!;
		this.moving = null;
		for (const s of this.selection) this.store.translate(s, m.dx, m.dy);
		this.addStrokes(this.selection);
		if (m.dx || m.dy) this.push({ type: "move", strokes: [...this.selection], dx: m.dx, dy: m.dy });
		this.setSelection(this.selection);
	}

	/**
	 * Page line: a straight vertical stroke `length` long, for splitting the canvas into columns ("pages").
	 * Placed at the middle of the view, its top level with the top of the existing ink, and left selected
	 * (lasso tool) so it can be dragged straight into place. Returns the stroke.
	 */
	addPageLine(length: number): Stroke {
		const v = this.worldView();
		let top = Infinity;
		for (const s of this.store.strokes.values()) if (s.bbox.y0 < top) top = s.bbox.y0 + s.size;
		if (!isFinite(top)) top = v.y0 + 40 / this.cam.z;
		const x = (v.x0 + v.x1) / 2;
		const n = Math.max(2, Math.ceil(length / 20) + 1), pts = new Float32Array(n * 2);
		for (let i = 0; i < n; i++) { pts[i * 2] = x; pts[i * 2 + 1] = top + (length * i) / (n - 1); }
		const s = this.store.create(this.color, this.size, pts);
		this.addStrokes([s]);
		this.push({ type: "add", strokes: [s] });
		this.tool = "lasso";
		this.setSelection([s]);
		return s;
	}

	selectionBounds(): Rect | null { return this.selection.length ? this.union(this.selection) : null; }
	contentBounds(): Rect | null { return this.union([...this.store.strokes.values()]); }
	viewSize(): [number, number] { return [this.cssW, this.cssH]; }

	/** "move selection to drawing": the strokes leave, a link box takes their place; one undo step */
	replaceWithLink(strokes: Stroke[], link: LinkInfo, center: [number, number], size: number): Stroke {
		this.clearSelection();
		const h = size / 2, [cx, cy] = center;
		const box = this.store.create(this.color, LINK_BORDER, new Float32Array([cx - h, cy - h, cx + h, cy + h]), { ...link });
		this.removeStrokes(strokes);
		this.addStrokes([box]);
		this.push({ type: "swap", removed: strokes, added: [box] });
		return box;
	}

	/** ink brought in from another drawing, shifted by (dx, dy); undoable */
	addFrom(strokes: Stroke[], dx: number, dy: number): Stroke[] {
		const out = strokes.map((s) => {
			const p = new Float32Array(s.pts.length);
			for (let i = 0; i < p.length; i += 2) { p[i] = s.pts[i] + dx; p[i + 1] = s.pts[i + 1] + dy; }
			const n = this.store.create(s.color, s.size, p, s.link && { ...s.link });
			if (s.smooth) n.smooth = true;
			return n;
		});
		this.addStrokes(out);
		this.push({ type: "add", strokes: out });
		return out;
	}

	/** compact ink for every stroke not compact yet (one undo step); returns how many were changed */
	compactAll(): number {
		const old = [...this.store.strokes.values()].filter((s) => !s.link && !s.smooth).sort((a, b) => a.id - b.id);
		if (!old.length) return 0;
		this.clearSelection();
		const added = old.map((s) => Object.assign(this.store.create(s.color, s.size, compactPoints(s.pts, s.size)), { smooth: true }));
		this.removeStrokes(old);
		this.addStrokes(added);
		this.push({ type: "swap", removed: old, added });
		this.tiles.clear();
		this.requestFrame();
		return old.length;
	}

	/** the topmost link box under a screen point, or null */
	linkAt(sx: number, sy: number): Stroke | null {
		const [wx, wy] = this.toWorld(sx, sy);
		const hits = this.store.query({ x0: wx - 1, y0: wy - 1, x1: wx + 1, y1: wy + 1 });
		for (let i = hits.length - 1; i >= 0; i--) {
			const s = hits[i], b = s.bbox;
			if (s.link && wx >= b.x0 && wx <= b.x1 && wy >= b.y0 && wy <= b.y1) return s;
		}
		return null;
	}

	/** the topmost link box at a world point, or null */
	linkAtWorld(wx: number, wy: number): Stroke | null {
		const hits = this.store.query({ x0: wx - 1, y0: wy - 1, x1: wx + 1, y1: wy + 1 });
		for (let i = hits.length - 1; i >= 0; i--) {
			const s = hits[i], r = s.link && rectOf(s);
			if (r && wx >= r.x0 && wx <= r.x1 && wy >= r.y0 && wy <= r.y1) return s;
		}
		return null;
	}

	/** select a link box together with the ink inside it (a framed word moves with its frame) */
	selectLink(box: Stroke) {
		const r = rectOf(box);
		const inner = this.store.query(r).filter((s) => s !== box && !s.link
			&& s.bbox.x0 >= r.x0 && s.bbox.x1 <= r.x1 && s.bbox.y0 >= r.y0 && s.bbox.y1 <= r.y1);
		this.setSelection([box, ...inner]);
	}

	/** the selection is one link box (plus the ink inside it): that box, else null */
	selectedLinkBox(): Stroke | null {
		const links = this.selection.filter((s) => s.link);
		if (links.length !== 1) return null;
		const box = links[0], r = rectOf(box);
		const ok = this.selection.every((s) => s === box || (s.bbox.x0 >= r.x0 && s.bbox.x1 <= r.x1 && s.bbox.y0 >= r.y0 && s.bbox.y1 <= r.y1));
		return ok ? box : null;
	}

	/** all link boxes in the drawing */
	linkBoxes(): Stroke[] {
		const out: Stroke[] = [];
		for (const s of this.store.strokes.values()) if (s.link) out.push(s);
		// boxes lifted off the page while being dragged or resized still count
		if (this.moving) for (const s of this.selection) if (s.link && !this.store.strokes.has(s.id)) out.push(s);
		if (this.resizing) out.push(this.resizing.box);
		return out;
	}

	/** screen point near the box's resize handle */
	private onHandle(box: Stroke, sx: number, sy: number) {
		const r = rectOf(box);
		return Math.hypot(r.x1 * this.cam.z + this.cam.x - sx, r.y1 * this.cam.z + this.cam.y - sy) <= 24;
	}

	private ghostBox(box: Stroke, x0: number, y0: number, x1: number, y1: number): Stroke {
		const pts = new Float32Array([x0, y0, x1, y1]);
		return { ...box, pts, bbox: computeBBox(pts, box.size), lines: undefined };
	}

	private beginResize(box: Stroke) {
		const r = rectOf(box);
		this.resizing = { box, ax: r.x0, ay: r.y0, x: r.x1, y: r.y1, ghost: this.ghostBox(box, r.x0, r.y0, r.x1, r.y1) };
		this.store.remove(box);
		this.crisp.valid = false; this.crisp.job = null; this.crisp.changedAt = 0;
		this.tiles.invalidate(box.bbox, this.isTileVisible);
		this.compose(false);
		this.drawOverlay();
	}

	private endResize() {
		const r = this.resizing!;
		this.resizing = null;
		const o = rectOf(r.box);
		if (o.x1 === r.x && o.y1 === r.y) { this.addStrokes([r.box]); this.setSelection(this.selection); return; }
		const nb = this.store.create(r.box.color, r.box.size, new Float32Array([r.ax, r.ay, r.x, r.y]), { ...r.box.link! });
		this.addStrokes([nb]);
		this.push({ type: "swap", removed: [r.box], added: [nb] });
		this.selectLink(nb);
	}

	/** "make smaller / bigger": scale the selection about its top-left corner, as if written at another zoom (undoable) */
	scaleSelection(k: number): boolean {
		const b = this.selBox;
		if (!this.selection.length || !b) return false;
		return this.scaleStrokes(this.selection, k, b.x0, b.y0);
	}

	/** replace strokes with copies scaled by k about (ax, ay); pen width scales too, a link box keeps its border. One undo step; the copies stay selected. */
	private scaleStrokes(strokes: Stroke[], k: number, ax: number, ay: number): boolean {
		// a link box can't shrink below the smallest box a drag allows
		for (const s of strokes) if (s.link) { const r = rectOf(s); if (Math.min(r.x1 - r.x0, r.y1 - r.y0) * k < MIN_LINK) return false; }
		const added = strokes.map((s) => {
			const p = new Float32Array(s.pts.length);
			for (let i = 0; i < p.length; i += 2) { p[i] = ax + (s.pts[i] - ax) * k; p[i + 1] = ay + (s.pts[i + 1] - ay) * k; }
			return this.store.create(s.color, s.link ? s.size : s.size * k, p, s.link && { ...s.link });
		});
		this.removeStrokes(strokes);
		this.addStrokes(added);
		this.push({ type: "swap", removed: strokes, added });
		this.setSelection(added);
		return true;
	}

	/** point link boxes at another note (one undo step); returns the new boxes, the selection follows */
	relink(boxes: Stroke[], link: LinkInfo): Stroke[] {
		if (!boxes.length) return [];
		const added = boxes.map((b) => this.store.create(b.color, b.size, new Float32Array(b.pts), { ...link, frame: b.link?.frame }));
		const sel = this.selection;
		this.removeStrokes(boxes);
		this.addStrokes(added);
		this.push({ type: "swap", removed: boxes, added });
		const i = boxes.findIndex((b) => sel.includes(b));
		if (i >= 0) this.selectLink(added[i]);
		return added;
	}

	/** a link box drawn around the selected ink (the handwriting is the label); one undo step; stays selected */
	linkSelection(link: LinkInfo): Stroke | null {
		const b = this.union(this.selection);
		if (!b) return null;
		const pad = 18, top = 34; // room for the caption
		const box = this.store.create(this.color, LINK_BORDER, new Float32Array([b.x0 - pad, b.y0 - top, b.x1 + pad, b.y1 + pad]), { ...link, frame: true });
		this.addStrokes([box]);
		this.push({ type: "add", strokes: [box] });
		this.selectLink(box);
		return box;
	}

	/** pan so the stroke is in the middle of the view, then select it */
	focusLink(box: Stroke) {
		const r = rectOf(box);
		this.cam.x = this.cssW / 2 - ((r.x0 + r.x1) / 2) * this.cam.z;
		this.cam.y = this.cssH / 2 - ((r.y0 + r.y1) / 2) * this.cam.z;
		this.camChanged(false);
		this.scheduleCamSave();
		this.selectLink(box);
	}

	/** tldraw's insertion point: the last pointer position on the canvas if it's in view, else the middle of the view */
	insertionPoint(): [number, number] {
		const p = this.lastPointer;
		if (p && p[0] >= 0 && p[1] >= 0 && p[0] <= this.cssW && p[1] <= this.cssH) return this.toWorld(p[0], p[1]);
		return this.toWorld(this.cssW / 2, this.cssH / 2);
	}

	/** add a link box (undoable) centered on (cx, cy), `size` wide and tall; defaults: tldraw's 240 at the insertion point */
	insertLink(link: LinkInfo, at?: [number, number], size = LINK_BOX): Stroke {
		const [cx, cy] = at ?? this.insertionPoint();
		const h = size / 2;
		const s = this.store.create(this.color, LINK_BORDER, new Float32Array([cx - h, cy - h, cx + h, cy + h]), { ...link });
		this.addStrokes([s]);
		this.push({ type: "add", strokes: [s] });
		return s;
	}

	/** change colour and/or size of the selected strokes (undoable); returns false with nothing selected */
	restyleSelection(patch: { color?: string; size?: number }): boolean {
		const sel = this.selection;
		if (!sel.length) return false;
		const from = sel.map((s) => ({ color: s.color, size: s.size }));
		const to = sel.map((s) => ({ color: patch.color ?? s.color, size: patch.size ?? s.size }));
		this.setStyles(sel, to);
		this.push({ type: "style", strokes: [...sel], from, to });
		this.setSelection(sel);
		return true;
	}

	private setStyles(strokes: Stroke[], styles: { color: string; size: number }[]) {
		this.removeStrokes(strokes);
		strokes.forEach((s, i) => {
			const st = styles[i];
			if (st.size !== s.size && !s.link) { s.size = st.size; s.bbox = computeBBox(s.pts, s.size); s.path = undefined; s.cpath = undefined; }
			s.color = st.color;
		});
		this.addStrokes(strokes);
	}

	/** remove these strokes as one undo step */
	removeStrokesUndoable(strokes: Stroke[]) {
		if (!strokes.length) return;
		this.setSelection(this.selection.filter((s) => !strokes.includes(s)));
		this.removeStrokes(strokes);
		this.push({ type: "remove", strokes });
	}

	/** remove the selected link box but keep the ink inside it, still selected */
	unlinkSelection() {
		const box = this.selectedLinkBox();
		if (!box) return;
		const inner = this.selection.filter((s) => s !== box);
		this.removeStrokes([box]);
		this.push({ type: "remove", strokes: [box] });
		this.setSelection(inner);
	}

	deleteSelection() {
		if (!this.selection.length) return;
		const sel = this.selection;
		this.removeStrokes(sel);
		this.push({ type: "remove", strokes: sel });
		this.setSelection([]);
	}

	// ---------- undo ----------
	private push(e: UndoEntry) { this.undoStack.push(e); this.redoStack = []; if (this.undoStack.length > 300) this.undoStack.shift(); }

	undo() {
		const e = this.undoStack.pop(); if (!e) return;
		this.clearSelection();
		this.apply(e, true); this.redoStack.push(e);
	}
	redo() {
		const e = this.redoStack.pop(); if (!e) return;
		this.clearSelection();
		this.apply(e, false); this.undoStack.push(e);
	}
	private apply(e: UndoEntry, inverse: boolean) {
		if (e.type === "add") inverse ? this.removeStrokes(e.strokes) : this.addStrokes(e.strokes);
		else if (e.type === "remove") inverse ? this.addStrokes(e.strokes) : this.removeStrokes(e.strokes);
		else if (e.type === "style") this.setStyles(e.strokes, inverse ? e.from : e.to);
		else if (e.type === "swap") {
			this.removeStrokes(inverse ? e.added : e.removed);
			this.addStrokes(inverse ? e.removed : e.added);
		}
		else {
			this.removeStrokes(e.strokes);
			const k = inverse ? -1 : 1;
			for (const s of e.strokes) this.store.translate(s, e.dx * k, e.dy * k);
			this.addStrokes(e.strokes);
		}
	}

	stats() {
		const ts = this.tiles.stats;
		return {
			strokes: this.store.strokes.size,
			zoom: this.cam.z,
			level: this.targetLevel(),
			inputAvg: this.perf.inputMs.avg(), inputMax: this.perf.inputMs.max(),
			composeAvg: this.perf.composeMs.avg(), composeMax: this.perf.composeMs.max(),
			gapAvg: this.perf.frameGap.avg(), gapMax: this.perf.frameGap.max(),
			tilesCached: ts.cached, tilesQueued: ts.queue, tilesRendered: ts.rendersDone, tileMs: ts.renderMs, strokesDrawn: ts.strokesDrawn,
			loadMs: this.perf.loadMs, saveMs: this.perf.saveMs, fileBytes: this.perf.fileBytes,
			evtRate: this.perf.evtRate.avg(), drawRate: this.perf.drawRate.avg(),
			drawGapAvg: this.perf.drawGap.avg(), drawGapMax: this.perf.drawGap.max(),
			latAvg: this.perf.latency.avg(), latMax: this.perf.latency.max(), tailAvg: this.perf.tail.avg(), tailMax: this.perf.tail.max(),
			crispMs: this.perf.crispMs, crispStrokes: this.perf.crispStrokes,
		};
	}

	resetPerf() {
		this.perf.inputMs.clear(); this.perf.composeMs.clear(); this.perf.frameGap.clear();
		for (const r of [this.perf.evtRate, this.perf.drawRate, this.perf.drawGap, this.perf.latency, this.perf.tail]) r.clear();
		this.tiles.stats.rendersDone = 0; this.tiles.stats.renderMs = 0; this.tiles.stats.strokesDrawn = 0;
	}
}

const MIN_LINK = 80;

/** a link box's rectangle (its two stored corners, in any order) */
function rectOf(s: Stroke): Rect {
	const p = s.pts;
	return { x0: Math.min(p[0], p[2]), y0: Math.min(p[1], p[3]), x1: Math.max(p[0], p[2]), y1: Math.max(p[1], p[3]) };
}
