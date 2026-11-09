import { Store, Stroke, Rect, paintStroke, rectsOverlap } from "./store";

/** Tile backing size in device pixels. */
export const TILE = 512;
export const MIN_LEVEL = -6;
export const MAX_LEVEL = 3;

interface Tile {
	key: string;
	L: number; tx: number; ty: number;
	rect: Rect;
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	ready: boolean;
	/** strokes still to draw while rendering */
	job: Stroke[] | null;
	jobIndex: number;
	lastUsed: number;
}

export interface TileStats {
	cached: number;
	rendersDone: number;
	renderMs: number;
	strokesDrawn: number;
	queue: number;
}

export function tileWorldSize(L: number) { return TILE / Math.pow(2, L); }

export class TileCache {
	private tiles = new Map<string, Tile>();
	private pool: HTMLCanvasElement[] = [];
	private frame = 0;
	maxTiles = 120;
	stats: TileStats = { cached: 0, rendersDone: 0, renderMs: 0, strokesDrawn: 0, queue: 0 };

	constructor(private store: Store) {}

	static key(L: number, tx: number, ty: number) { return L + ":" + tx + ":" + ty; }

	get(L: number, tx: number, ty: number): Tile | undefined {
		return this.tiles.get(TileCache.key(L, tx, ty));
	}

	beginFrame() { this.frame++; }

	touch(t: Tile) { t.lastUsed = this.frame; }

	private alloc(L: number, tx: number, ty: number): Tile {
		const canvas = this.pool.pop() ?? document.createElement("canvas");
		canvas.width = TILE; canvas.height = TILE;
		const ctx = canvas.getContext("2d")!;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, TILE, TILE);
		const ws = tileWorldSize(L);
		const t: Tile = {
			key: TileCache.key(L, tx, ty), L, tx, ty,
			rect: { x0: tx * ws, y0: ty * ws, x1: (tx + 1) * ws, y1: (ty + 1) * ws },
			canvas, ctx, ready: false, job: null, jobIndex: 0, lastUsed: this.frame,
		};
		this.tiles.set(t.key, t);
		return t;
	}

	private setTileTransform(t: Tile) {
		const s = Math.pow(2, t.L);
		t.ctx.setTransform(s, 0, 0, s, -t.rect.x0 * s, -t.rect.y0 * s);
	}

	private padRect(t: Tile): Rect {
		return t.rect;
	}

	/** Start (or restart) rendering a tile. */
	request(L: number, tx: number, ty: number): Tile {
		let t = this.get(L, tx, ty);
		if (!t) t = this.alloc(L, tx, ty);
		if (!t.ready && !t.job) this.startJob(t);
		return t;
	}

	private startJob(t: Tile) {
		t.ctx.setTransform(1, 0, 0, 1, 0, 0);
		t.ctx.clearRect(0, 0, TILE, TILE);
		t.job = this.store.query(this.padRect(t));
		t.jobIndex = 0;
		t.ready = false;
	}

	/** Advance render jobs for the given tiles (in priority order) until deadline. */
	work(order: Tile[], deadline: number): boolean {
		let didWork = false;
		const t0 = performance.now();
		for (const t of order) {
			if (!t.job) continue;
			this.setTileTransform(t);
			const job = t.job;
			while (t.jobIndex < job.length) {
				const s = job[t.jobIndex++];
				paintStroke(t.ctx, s);
				this.stats.strokesDrawn++;
				didWork = true;
				if ((t.jobIndex & 15) === 0 && performance.now() > deadline) break;
			}
			if (t.jobIndex >= job.length) {
				t.job = null; t.ready = true; this.stats.rendersDone++;
			}
			if (performance.now() > deadline) break;
		}
		this.stats.renderMs += performance.now() - t0;
		return didWork;
	}

	/** Render a tile fully right now. */
	renderNow(t: Tile) {
		this.startJob(t);
		this.work([t], Infinity);
	}

	/** Draw a new stroke into every cached tile it touches (cheap, additive). */
	addStroke(s: Stroke) {
		for (const t of this.tiles.values()) {
			if (!rectsOverlap(t.rect, s.bbox)) continue;
			if (t.job) { t.job.push(s); continue; }
			this.setTileTransform(t);
			paintStroke(t.ctx, s);
		}
	}

	/** Strokes were removed/changed in rect. Visible tiles get re-rendered now; others are dropped. */
	invalidate(r: Rect, isVisible: (t: Tile) => boolean) {
		for (const t of [...this.tiles.values()]) {
			if (!rectsOverlap(t.rect, r)) continue;
			if (isVisible(t)) this.renderNow(t);
			else this.drop(t);
		}
	}

	drop(t: Tile) {
		this.tiles.delete(t.key);
		this.pool.push(t.canvas);
		if (this.pool.length > 8) {
			const c = this.pool.shift()!;
			c.width = 1; c.height = 1; // free memory (iOS keeps canvas backing otherwise)
		}
	}

	clear() { for (const t of [...this.tiles.values()]) this.drop(t); }

	evict() {
		if (this.tiles.size <= this.maxTiles) return;
		const list = [...this.tiles.values()].filter((t) => t.lastUsed < this.frame);
		list.sort((a, b) => a.lastUsed - b.lastUsed);
		let n = this.tiles.size - this.maxTiles;
		for (const t of list) { if (n-- <= 0) break; this.drop(t); }
	}

	pendingJobs(): Tile[] {
		const out: Tile[] = [];
		for (const t of this.tiles.values()) if (t.job) out.push(t);
		return out;
	}

	size() { return this.tiles.size; }
}

export type { Tile };
