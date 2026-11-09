/** Synthetic handwriting: pages of lines of cursive-ish words, laid out in a grid of pages. */
function rng(seed: number) {
	return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

export function synthStrokes(n: number, seed = 42, originY = 0) {
	const r = rng(seed);
	const out: { color: string; size: number; pts: Float32Array }[] = [];
	const PAGE_W = 1400, PAGE_H = 2000, LINE = 46, MARGIN = 60, COLS = 6;
	let page = 0, line = 0;
	const pageOrigin = () => [(page % COLS) * (PAGE_W + 200), originY + Math.floor(page / COLS) * (PAGE_H + 200)];
	let [ox, oy] = pageOrigin();
	let x = ox + MARGIN;
	while (out.length < n) {
		const strokesInWord = 1 + Math.floor(r() * 4);
		for (let k = 0; k < strokesInWord && out.length < n; k++) {
			const w = 12 + r() * 50;
			const baseY = oy + MARGIN + line * LINE + 30;
			const pts: number[] = [];
			const nPts = Math.max(6, Math.round(w / 2.2) + Math.floor(r() * 10));
			const freq = 1 + r() * 3, amp = 6 + r() * 10, phase = r() * Math.PI * 2;
			const loop = r() * 4;
			for (let i = 0; i < nPts; i++) {
				const t = i / (nPts - 1);
				const a = t * Math.PI * 2 * freq + phase;
				pts.push(
					x + t * w + Math.cos(a) * loop + (r() - 0.5) * 0.6,
					baseY - Math.abs(Math.sin(a)) * amp + (r() - 0.5) * 0.6,
				);
			}
			out.push({ color: r() < 0.08 ? "#e03131" : "#1e1e1e", size: 4.5, pts: new Float32Array(pts) });
			x += w + 3 + r() * 4;
		}
		x += 14 + r() * 10;
		if (x > ox + PAGE_W - MARGIN) {
			line++;
			if (MARGIN + (line + 1) * LINE > PAGE_H - MARGIN) { line = 0; page++; [ox, oy] = pageOrigin(); }
			x = ox + MARGIN;
		}
	}
	return out;
}
