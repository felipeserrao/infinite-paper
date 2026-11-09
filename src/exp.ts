/**
 * Smoothness experiments: each switch copies one thing tldraw does differently.
 * Saved per device (localStorage) so each device can differ. Shown only in developer mode.
 */
export interface Exp {
	/** finished ink re-rendered as vectors at exact screen resolution once the camera is still */
	crisp: boolean;
	/** draw the live stroke once per frame instead of on every pen event */
	rafBatch: boolean;
	/** cap live drawing at ~60 fps (tldraw's fpsThrottle) */
	fps60: boolean;
	/** live canvas in low-latency ("desynchronized") mode — our current default */
	desync: boolean;
	/** tldraw point filter: merge points < 1 screen px apart, round to 0.01, strip start/end points within size/3 */
	tlFilter: boolean;
	/** draw strokes as a smoothed centerline with a round pen, instead of a filled outline */
	centerline: boolean;
	/** use only the main pen event, not getCoalescedEvents() extra samples (tldraw does this on iOS) */
	noCoalesced: boolean;
	/** centerline only: tldraw's own point smoothing (its copy of freehand) — repeats the last point so the line
	 *  catches up to the pen, and skips only the first few points; instead of the perfect-freehand package's */
	tlPoints: boolean;
	/** centerline only: tldraw's curve shape — each curve's control point mirrors the previous one (SVG "T") */
	tlCurve: boolean;
	/** streamline (how much the ink trails the pen); tldraw uses 0.64 for finished solid strokes (0.62 is its pen-pressure variant) */
	streamline: number;
}

export const EXP_DEFAULTS: Exp = { crisp: false, rafBatch: false, fps60: false, desync: true, tlFilter: false, centerline: false, noCoalesced: false, tlPoints: false, tlCurve: false, streamline: 0.62 };
export const EXP_TLDRAW: Partial<Exp> = { crisp: true, rafBatch: true, fps60: true, desync: false, tlFilter: true, centerline: true, noCoalesced: true, tlPoints: true, tlCurve: true, streamline: 0.64 };

const KEY = "infinite-paper-exp";

export const exp: Exp = (() => {
	try { return { ...EXP_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...EXP_DEFAULTS }; }
})();

export function saveExp() { localStorage.setItem(KEY, JSON.stringify(exp)); }

export function expLabel() {
	const on: string[] = [];
	if (exp.crisp) on.push("crisp");
	if (exp.rafBatch || exp.fps60) on.push(exp.fps60 ? "60fps" : "per-frame");
	if (!exp.desync) on.push("sync-canvas");
	if (exp.tlFilter) on.push("tl-filter");
	if (exp.centerline) on.push("centerline");
	if (exp.noCoalesced) on.push("no-coalesced");
	if (exp.tlPoints) on.push("tl-points");
	if (exp.tlCurve) on.push("tl-curve");
	if (exp.streamline !== 0.62) on.push("streamline " + exp.streamline);
	return on.length ? on.join(" ") : "baseline";
}
