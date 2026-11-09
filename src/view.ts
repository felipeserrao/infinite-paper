import { exp, saveExp, expLabel, EXP_DEFAULTS, EXP_TLDRAW, Exp } from "./exp";
import { Menu, MenuPositionDef, Notice, TextFileView, WorkspaceLeaf, sanitizeHTMLToDom, setIcon } from "obsidian";
import { InkEngine, Tool } from "./engine";
import type { LinkInfo, Stroke } from "./store";
import { addBacklinks, joinMarkdown, parseBacklinks, setBacklinks, splitMarkdown } from "./mdformat";
import { NotePicker } from "./picker";
import { live } from "./settings";
import { importTldraw, isTldrawMarkdown } from "./tldraw-import";
import type InfinitePaperPlugin from "./main";

export const VIEW_TYPE = "infinite-paper";

/** `[[a/b|alias]]` -> `a/b` */
function lineTarget(raw: string) { return raw.replace(/^\[\[|\]\]$/g, "").split("|")[0]; }

/** replace an element's content with a fixed SVG icon (no innerHTML) */
function setSvg(el: HTMLElement, markup: string) { el.empty(); el.append(sanitizeHTMLToDom(markup)); }

const COLORS: [string, string][] = [["#1e1e1e", "Black"], ["#e03131", "Red"]];
const SIZES: [string, number][] = [["S", 3], ["M", 4.5], ["L", 6], ["XL", 11]];

export class InkView extends TextFileView {
	engine!: InkEngine;
	private stage!: HTMLElement;
	private perfEl!: HTMLElement;
	private perfTimer = 0;
	private ro?: ResizeObserver;
	private buttons = new Map<string, HTMLElement>();
	private selBar!: HTMLElement;
	private zoomLabel!: HTMLElement;
	private zoomPreset!: HTMLElement;
	private writingTimer = 0;
	private saveAction?: HTMLElement;

	private setDirty(d: boolean) { this.saveAction?.toggleClass("ink-unsaved", d); }

	async save(clear?: boolean) {
		if (this.tldraw) return; // a tldraw note is shown read-only: never written
		await super.save(clear);
		this.setDirty(false);
	}
	private loading = false;

	constructor(leaf: WorkspaceLeaf, private readonly owner: InfinitePaperPlugin) { super(leaf); }

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return this.file?.basename ?? "Infinite Paper"; }
	getIcon() { return "pen-tool"; }

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("infinite-paper-view");
		this.stage = this.contentEl.createDiv({ cls: "ink-stage" });
		this.engine = new InkEngine(this.stage);
		this.stage.addEventListener("pointerdown", () => { this.closeMenus(); if (this.linksPopOpen) this.toggleLinksPop(false); }, { capture: true });
		this.engine.onChange = () => { if (!this.loading && !this.tldraw) { this.setDirty(true); this.requestSave(); } };
		this.engine.onEdit = () => {
			if (this.loading || !this.tldraw || this.discarding) return;
			// read-only: a stray tap leaves no mark and makes no copy; real writing, erasing or moving does
			const s = this.engine.lastPenStroke;
			if (s && this.engine.isTap(s)) {
				this.discarding = true;
				window.setTimeout(() => { try { this.engine.undo(); } finally { this.discarding = false; } }, 0);
				return;
			}
			this.copyOnEdit();
		};
		// Save lives in the view header, next to the tab's "…" menu.
		this.saveAction = this.addAction("save", "Save (saves automatically ~2 s after each change)", async () => {
			await this.save();
			new Notice("Saved");
		});
		this.addAction("file-text", "Open as markdown (edit links and tags)", () => this.openAsMarkdown());
		// palm guard lives in the header, next to Save (also in the rail's "…" menu)
		this.touchAction = this.addAction("hand-metal", "Palm guard on: only the pen draws (tap to let touch draw)", () => this.toggleTouch());
		this.engine.onViewChange = () => this.updateOverlays();
		// (0.9.4–0.9.8 faded the toolbars while writing; removed in 0.9.9: it flickered on every word)
		// links open in a new tab
		this.engine.onLinkOpen = (target) => this.app.workspace.openLinkText(target, this.file?.path ?? "", true);
		this.buildToolbar();
		this.buildZoom();
		this.buildSelectionBar();
		this.linksPop = this.contentEl.createDiv({ cls: "ink-linkpop is-hidden" });
		this.linksAction = this.addAction("link", "Links in this drawing", () => this.toggleLinksPop());
		this.linksAction.addClass("ink-links-action");
		this.engine.onLinksChanged = (removed) => this.syncLinkLines(removed);
		this.engine.onSelectionChange = () => this.renderSelBar();
		this.banner = this.contentEl.createDiv({ cls: "ink-banner is-hidden" });
		this.perfEl = this.contentEl.createDiv({ cls: "ink-perf is-hidden" });
		this.ro = new ResizeObserver(() => this.engine.resize(this.stage.clientWidth, this.stage.clientHeight));
		this.ro.observe(this.stage);

		this.scope?.register(["Mod"], "z", () => { this.engine.undo(); return false; });
		this.scope?.register(["Mod", "Shift"], "z", () => { this.engine.redo(); return false; });
		this.scope?.register([], "Delete", () => { this.deleteSelection(); return false; });
		this.scope?.register([], "Backspace", () => { this.deleteSelection(); return false; });
		this.scope?.register([], "Escape", () => { this.engine.clearSelection(); return false; });
	}

	async onClose() {
		this.ro?.disconnect();
		window.clearInterval(this.perfTimer);
		this.engine?.destroy();
	}

	/** markdown part above the data block (frontmatter, links, tags); kept as written */
	private mdHeader = "";
	private isMarkdown() { return this.file?.extension === "md"; }

	getViewData(): string {
		if (this.tldraw) return this.tldraw.raw;
		const data = this.engine.serialize();
		return this.isMarkdown() ? joinMarkdown(this.mdHeader, data) : data;
	}

	setViewData(data: string, clear: boolean): void {
		this.loading = true;
		this.tldraw = null;
		try {
			if (this.isMarkdown() && isTldrawMarkdown(data)) {
				const r = importTldraw(data);
				this.tldraw = { raw: data, skipped: r.skipped, copying: false };
				this.engine.loadStrokes(r.strokes, r.camera);
			} else if (this.isMarkdown()) {
				const { header, data: json } = splitMarkdown(data);
				this.mdHeader = header;
				this.engine.load(json);
			} else this.engine.load(data);
		} catch (e) {
			new Notice(`Can't show this note: ${(e as Error)?.message ?? e}`, 0);
		} finally { this.loading = false; this.renderBanner(); this.renderLinks(); }
	}

	// ---------- tldraw notes: read-only, the first edit makes an Ink copy ----------
	private discarding = false;
	private tldraw: null | { raw: string; skipped: Record<string, number>; copying: boolean } = null;
	private banner!: HTMLElement;
	private plugin() { return this.owner; }

	/** a compact, translucent note under the toolbar: what this view is, what an edit does, and the options */
	private bannerClosed = new Set<string>();
	private renderBanner() {
		const b = this.banner;
		if (!b) return;
		b.empty();
		const file = this.file;
		if (!this.tldraw || !file || this.bannerClosed.has(file.path)) { b.addClass("is-hidden"); return; }
		b.removeClass("is-hidden");
		const plugin = this.plugin();
		const text = b.createDiv({ cls: "ink-banner-text" });
		text.createEl("strong", { text: "tldraw note, read-only. " });
		const copies = plugin.findInkCopies(file);
		if (copies.length) {
			// already copied: point to the copy, and say plainly that writing here would make another one
			text.appendText(copies.length === 1 ? "Already copied to " : `Already copied ${copies.length} times, newest: `);
			const a = text.createEl("a", { text: copies[0].basename, href: "#" });
			a.addEventListener("click", (e) => { e.preventDefault(); this.leaf.setViewState({ type: VIEW_TYPE, state: { file: copies[0].path }, active: true }); });
			text.appendText(". Writing here makes another copy; this note stays unchanged.");
		} else {
			text.appendText(`Writing makes a new Infinite Paper note (${plugin.previewCopyPath(file)}); this note stays unchanged.`);
		}
		const skipped = Object.entries(this.tldraw.skipped).map(([t, n]) => `${n} ${t}`);
		if (skipped.length) text.createDiv({ cls: "ink-banner-sub", text: `Not shown: ${skipped.join(", ")}.` });
		const btns = b.createDiv({ cls: "ink-banner-btns" });
		const mk = (label: string, fn: () => void) => {
			const el = btns.createEl("button", { text: label });
			el.addEventListener("click", (e) => { e.preventDefault(); fn(); });
		};
		mk("Open in tldraw", () => plugin.openInTldraw(file, this.leaf));
		mk("Make copy", () => this.copyOnEdit());
		const x = btns.createEl("button", { cls: "ink-banner-x", attr: { "aria-label": "Hide" } });
		setIcon(x, "x");
		x.addEventListener("click", (e) => { e.preventDefault(); this.bannerClosed.add(file.path); this.renderBanner(); });
	}

	/** tab "…" menu: switch between Ink, tldraw and the original */
	onPaneMenu(menu: Menu, source: string) {
		super.onPaneMenu(menu, source);
		const file = this.file;
		if (!file) return;
		const plugin = this.plugin();
		if (this.tldraw) {
			menu.addItem((i) => i.setSection("action").setTitle("Open in tldraw").setIcon("pencil").onClick(() => plugin.openInTldraw(file, this.leaf)));
			menu.addItem((i) => i.setSection("action").setTitle("Make Infinite Paper copy now").setIcon("copy-plus").onClick(() => this.copyOnEdit()));
		} else {
			const orig = plugin.originalOf(file);
			if (orig) menu.addItem((i) => i.setSection("action").setTitle("Open the tldraw original").setIcon("pencil").onClick(() => plugin.openInTldraw(orig, this.app.workspace.getLeaf(true))));
		}
	}

	/** make the Ink copy (with whatever is on the canvas now) and switch this tab to it */
	private async copyOnEdit() {
		const t = this.tldraw, src = this.file;
		if (!t || t.copying || !src) return;
		t.copying = true;
		try {
			const file = await this.plugin().makeInkCopy(src, () => this.engine.serialize());
			if (!file) { t.copying = false; return; }
			const tool = this.engine.tool;
			// by view type: the new file's frontmatter may not be indexed yet
			await this.leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
			if (tool !== "pen") this.setTool(tool);
		} catch (e) {
			t.copying = false;
			new Notice(`Couldn't make the Infinite Paper copy: ${(e as Error)?.message ?? e}`, 0);
		}
	}

	clear(): void { this.engine?.clearAll(); }

	// ---------- links to notes ----------
	// A link box is a 🔗 rectangle on the canvas; each target also has a `- [[target]]` line in the header
	// (Obsidian indexes the header, so backlinks and the graph see it). Finger tap / Cmd-click opens a box;
	// a pencil tap (or a lasso tap) selects it: drag to move, corner handle to resize, the bar to open / change / delete.

	/** pick a note (or name a new one); null if cancelled */
	private async pickNote(placeholder: string): Promise<LinkInfo | null> {
		if (!this.file) return null;
		const picked = await new NotePicker(this.app, { createLabel: "Create note", placeholder }).pick();
		if (!picked || !this.file) return null;
		return picked.type === "file"
			? { target: this.app.metadataCache.fileToLinktext(picked.file, this.file.path), label: picked.file.basename }
			: { target: picked.target, label: picked.displayName };
	}

	private readOnlyNotice() {
		if (!this.tldraw) return false;
		new Notice("This tldraw note is read-only. Make a copy first.");
		return true;
	}

	/**
	 * "Insert link to Obsidian note": with ink selected, a box is drawn around it (the handwriting is the label);
	 * otherwise a 🔗 box goes where the pointer was.
	 */
	async insertLink() {
		if (this.readOnlyNotice() || !this.file) return;
		const sel = this.engine.selection.length > 0 && !this.engine.selectedLinkBox();
		const at = this.engine.insertionPoint(); // before the picker takes focus
		const link = await this.pickNote(sel ? "Link the selection to a note…" : "Link to a note…");
		if (!link) return;
		if (sel && this.engine.selection.length) this.engine.linkSelection(link);
		else this.engine.insertLink(link, at);
		this.addBacklinks([`[[${link.target}]]`]);
	}

	/** selection bar "Change": point the selected box at another note */
	private async changeSelectedLink() {
		const box = this.engine.selectedLinkBox();
		if (!box || this.readOnlyNotice()) return;
		const link = await this.pickNote("Change link to…");
		if (!link || link.target === box.link!.target) return;
		const cur = this.engine.selectedLinkBox() === box ? box : null;
		if (!cur) return;
		this.engine.relink([box], link); // the old note's line goes with its last box (syncLinkLines)
	}

	/** delete the selection; a note whose last box went also loses its header line */
	deleteSelection() { this.engine.deleteSelection(); }

	/** add `- [[x]]` lines to this drawing's header (markdown drawings only); saved with the next save */
	addBacklinks(links: string[]) {
		if (!this.isMarkdown() || this.tldraw) return;
		const next = addBacklinks(this.mdHeader, links);
		if (next === this.mdHeader) return;
		this.mdHeader = next;
		this.setDirty(true); this.requestSave();
		this.renderLinks();
	}

	/**
	 * Header lines follow the boxes: every box has its line, and when a box goes (delete, eraser, undo of a create,
	 * change of note) its note's line goes too unless another box still points there. Lines with no box that
	 * were never touched (e.g. imported from tldraw) stay. Removals are checked after the current edit finishes:
	 * a recolour removes and re-adds the same box, and must not reorder the list.
	 */
	private pendingGone = new Set<string>();
	private syncLinkLines(removed: string[]) {
		if (this.loading || this.tldraw) return;
		this.addBacklinks([...new Set(this.engine.linkBoxes().map((b) => `[[${b.link!.target}]]`))]);
		if (removed.length) {
			const first = this.pendingGone.size === 0;
			for (const t of removed) this.pendingGone.add(t);
			if (first) window.setTimeout(() => {
				const gone = [...this.pendingGone];
				this.pendingGone.clear();
				this.pruneLinkLines(gone);
			}, 0);
		}
		this.renderLinks();
	}

	/** drop the header lines of these targets when no box points at them any more */
	private pruneLinkLines(targets: string[]) {
		if (!targets.length || !this.isMarkdown() || this.tldraw) return;
		const still = new Set(this.engine.linkBoxes().map((b) => b.link!.target));
		const drop = new Set(targets.filter((t) => !still.has(t)));
		if (!drop.size) return;
		const cur = parseBacklinks(this.mdHeader);
		const next = cur.filter((l) => !drop.has(lineTarget(l)));
		if (next.length !== cur.length) this.commitLinks(next);
	}

	private commitLinks(next: string[]) {
		this.mdHeader = setBacklinks(this.mdHeader, next);
		this.setDirty(true); this.requestSave();
		this.renderLinks();
	}

	// ---------- Links panel: a 🔗 button in the view header opens it ----------
	private linksAction?: HTMLElement;
	private linksPop!: HTMLElement;
	private linksPopOpen = false;
	/** which box "show on page" jumps to next, per target */
	private locateIdx = new Map<string, number>();

	private toggleLinksPop(open = !this.linksPopOpen) {
		this.linksPopOpen = open;
		this.renderLinks();
	}

	private renderLinks() {
		const show = this.isMarkdown() && !this.tldraw;
		const lines = show ? parseBacklinks(this.mdHeader) : [];
		if (this.linksAction) {
			this.linksAction.toggleClass("is-hidden", !show);
			this.linksAction.querySelector(".ink-action-badge")?.remove();
			if (lines.length) this.linksAction.createSpan({ cls: "ink-action-badge", text: String(lines.length) });
			this.linksAction.toggleClass("is-active", this.linksPopOpen && show);
		}
		const el = this.linksPop;
		if (!el) return;
		el.empty();
		el.toggleClass("is-hidden", !show || !this.linksPopOpen);
		if (!show || !this.linksPopOpen) return;

		const boxes = new Map<string, Stroke[]>();
		for (const b of this.engine.linkBoxes()) {
			const k = b.link!.target, a = boxes.get(k);
			if (a) a.push(b); else boxes.set(k, [b]);
		}
		const iconBtn = (parent: HTMLElement, icon: string, label: string, fn: (b: HTMLElement) => void) => {
			const b = parent.createEl("button", { cls: "ink-btn", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
			return b;
		};

		const head = el.createDiv({ cls: "ink-linkpop-head" });
		head.createSpan({ cls: "ink-linkpop-title", text: lines.length ? `Links (${lines.length})` : "Links" });
		iconBtn(head, "plus", "Add a link box", async () => {
			if (this.readOnlyNotice()) return;
			const [w, h] = this.engine.viewSize();
			const at = this.engine.toWorld(w / 2, h / 2);
			const link = await this.pickNote("Link to a note…");
			if (!link) return;
			this.engine.insertLink(link, at);
			this.addBacklinks([`[[${link.target}]]`]);
		});
		iconBtn(head, "x", "Close", () => this.toggleLinksPop(false));

		if (!lines.length) {
			el.createDiv({ cls: "ink-linkpop-empty", text: "No links yet. Lasso some writing and tap 🔗 Link, or use + to drop a box." });
			return;
		}
		const list = el.createDiv({ cls: "ink-linkpop-list" });
		lines.forEach((raw, i) => {
			const target = lineTarget(raw);
			const inner = raw.replace(/^\[\[|\]\]$/g, "");
			const alias = inner.includes("|") ? inner.split("|").slice(1).join("|") : "";
			const slash = target.lastIndexOf("/");
			const name = alias || target.slice(slash + 1);
			const mine = boxes.get(target) ?? [];

			const row = list.createDiv({ cls: "ink-linkpop-row" });
			const open = row.createEl("button", { cls: "ink-linkpop-open", attr: { "aria-label": `Open ${target}` } });
			open.createDiv({ cls: "ink-linkpop-name", text: name });
			const sub = [slash > 0 ? target.slice(0, slash) : "", mine.length ? `${mine.length} box${mine.length === 1 ? "" : "es"} on the page` : "no box on the page"].filter(Boolean).join(" · ");
			open.createDiv({ cls: "ink-linkpop-sub", text: sub });
			open.addEventListener("click", (e) => {
				e.preventDefault();
				if (target && this.file) this.app.workspace.openLinkText(target, this.file.path, true);
			});
			if (mine.length) iconBtn(row, "locate", "Show on page", () => {
				const k = (this.locateIdx.get(target) ?? -1) + 1;
				this.locateIdx.set(target, k);
				this.engine.focusLink(mine[k % mine.length]);
			});
			iconBtn(row, "more-vertical", "More", (b) => {
				const r = b.getBoundingClientRect();
				this.toggleMenu("link-row", (m) => {
					m.addItem((it) => it.setTitle("Change note…").setIcon("pencil").onClick(async () => {
						const link = await this.pickNote("Change link to…");
						if (!link || link.target === target) return;
						const cur = parseBacklinks(this.mdHeader);
						const next = `[[${link.target}]]`;
						const k = cur.indexOf(raw); if (k < 0) return;
						if (cur.includes(next)) cur.splice(k, 1); else cur[k] = next;
						this.commitLinks(cur);
						const bx = this.engine.linkBoxes().filter((s) => s.link!.target === target);
						if (bx.length) this.engine.relink(bx, link);
					}));
					m.addItem((it) => it.setTitle(mine.length ? `Remove link and its ${mine.length} box${mine.length === 1 ? "" : "es"}` : "Remove link").setIcon("trash-2").onClick(() => {
						const bx = this.engine.linkBoxes().filter((s) => s.link!.target === target);
						if (bx.length) this.engine.removeStrokesUndoable(bx);
						this.commitLinks(parseBacklinks(this.mdHeader).filter((l) => lineTarget(l) !== target));
					}));
				}, { x: r.right, y: r.bottom + 4, left: true });
			});
		});
	}

	async openAsMarkdown() {
		if (!this.file || !this.isMarkdown()) { new Notice("Only markdown drawings can be opened as markdown."); return; }
		await this.save();
		const leaf = this.leaf as WorkspaceLeaf & { __inkRaw?: boolean };
		leaf.__inkRaw = true;
		try { await leaf.setViewState({ type: "markdown", state: { file: this.file.path } }); }
		finally { leaf.__inkRaw = false; }
	}

	// ---------- menus: our canvas swallows taps, so close menus ourselves ----------
	private openMenu: { key: string; menu: Menu } | null = null;
	private lastMenuHide = { key: "", at: 0 };

	private toggleMenu(key: string, build: (m: Menu) => void, pos: MenuPositionDef) {
		if (this.openMenu?.key === key) { this.openMenu.menu.hide(); return; }
		// Obsidian may already have hidden it on pointerdown of this same button: don't reopen
		if (this.lastMenuHide.key === key && performance.now() - this.lastMenuHide.at < 350) return;
		this.openMenu?.menu.hide();
		const m = new Menu();
		build(m);
		m.onHide(() => {
			document.body.removeClass("infinite-paper-menu-open");
			if (this.openMenu?.menu === m) this.openMenu = null;
			this.lastMenuHide = { key, at: performance.now() };
		});
		this.openMenu = { key, menu: m };
		document.body.addClass("infinite-paper-menu-open"); // compact menu styling, see styles.css
		m.showAtPosition(pos);
	}

	closeMenus() { this.openMenu?.menu.hide(); }

	private btn(parent: HTMLElement, key: string, label: string, icon: string | null, onClick: () => void) {
		const b = parent.createEl("button", { cls: "ink-btn", attr: { "aria-label": label } });
		if (icon) setIcon(b, icon); else b.setText(label);
		b.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
		this.buttons.set(key, b);
		return b;
	}

	private touchAction!: HTMLElement;
	private toggleTouch() {
		const on = this.engine.touchDraws = !this.engine.touchDraws;
		this.touchAction.toggleClass("is-active", on);
		setIcon(this.touchAction, on ? "pointer" : "hand-metal");
		this.touchAction.setAttribute("aria-label", on ? "Touch draws: tap to turn the palm guard back on" : "Palm guard on: only the pen draws (tap to let touch draw)");
	}

	private setTool(t: Tool) {
		if (this.handOn) this.setHand(false);
		this.engine.tool = t;
		if (t !== "lasso") this.engine.clearSelection();
		if (t === "pen" || t === "eraser") this.penMode = t;
		this.renderSplits();
	}

	// ---- hand: tap = stays on (pen/finger pan, zoom fixed); hold = pans only while held
	private handOn = false;
	private handBtn!: HTMLElement;
	private setHand(on: boolean) {
		this.handOn = on;
		this.engine.panMode = on;
		this.handBtn.toggleClass("is-active", on);
		this.renderSplits();
	}
	private buildHand(parent: HTMLElement) {
		const b = this.handBtn = this.btn(parent, "hand", "Hand: move the page (tap to keep on, hold to move while held)", "hand", () => {});
		let timer = 0, held = false;
		b.addEventListener("pointerdown", () => {
			held = false;
			timer = window.setTimeout(() => { held = true; this.engine.panMode = true; b.addClass("is-active"); }, 250);
		});
		const release = () => {
			window.clearTimeout(timer);
			if (held) { this.engine.panMode = this.handOn; b.toggleClass("is-active", this.handOn); }
		};
		b.addEventListener("pointerup", release); b.addEventListener("pointercancel", release);
		b.addEventListener("contextmenu", (e) => e.preventDefault());
		b.addEventListener("click", () => {
			if (held) { held = false; return; } // that was a hold, not a tap
			this.setHand(!this.handOn);
			if (this.handOn) this.engine.clearSelection();
		});
	}

	// ---- split buttons: two modes per button; first tap selects it, tapping again while selected switches mode
	private penMode: "pen" | "eraser" = "pen";
	private splits: { b: HTMLElement; mode: () => 0 | 1; active: () => boolean }[] = [];

	private splitBtn(parent: HTMLElement, key: string, label: string, halves: [(el: HTMLElement) => void, (el: HTMLElement) => void],
		mode: () => 0 | 1, active: () => boolean, onClick: () => void) {
		const b = this.btn(parent, key, label, null, onClick);
		b.empty(); b.addClass("ink-split");
		halves.forEach((fill, i) => fill(b.createSpan({ cls: "ink-half " + (i ? "is-b" : "is-a") }).createSpan({ cls: "ink-half-in" })));
		b.createSpan({ cls: "ink-split-line" });
		this.splits.push({ b, mode, active });
		return b;
	}

	private renderSplits() {
		for (const { b, mode, active } of this.splits) {
			const m = mode();
			b.toggleClass("is-idle", !active());
			if (this.penNib) this.penNib.setAttribute("fill", this.engine.color);
			b.querySelectorAll(".ink-half").forEach((h, i) => { h.toggleClass("is-on", i === m); h.toggleClass("is-off", i !== m); });
		}
	}

	private sizeLabel = "M";
	private penNib: SVGElement | null = null;

	/** drop a page line (length from settings) and switch to lasso so it can be dragged into place */
	addPageLine() {
		this.engine.addPageLine(live.settings.pageLineLength);
		this.setTool("lasso");
	}

	private setSize(label: string) {
		const sz = SIZES.find(([l]) => l === label)![1];
		if (this.engine.restyleSelection({ size: sz })) { this.sizeLabel = label; this.renderSplits(); return; } // resize the selected ink instead
		this.engine.size = sz; this.sizeLabel = label; this.setTool("pen");
		// L / XL live in the "more" menu: mark the menu button while one of them is the size
		this.buttons.get("more")?.toggleClass("is-active", label === "L" || label === "XL");
	}

	private colorIdx = 0;
	private setColor(idx: number) {
		const c = COLORS[idx][0];
		this.colorIdx = idx;
		// with ink selected: recolour it and keep the selection; otherwise pick the pen colour
		if (this.engine.restyleSelection({ color: c })) { this.renderSplits(); return; }
		this.engine.color = c; this.setTool("pen");
	}

	private buildToolbar() {
		// Two clusters (Linea/Procreate-style): drawing tools as a 2-column block top-right,
		// actions as a small row bottom-right (thumb reach). Pairs sit side by side.
		const bar = this.contentEl.createDiv({ cls: "ink-toolbar" });
		const acts = this.contentEl.createDiv({ cls: "ink-actions" });
		const icon = (name: string) => (el: HTMLElement) => setIcon(el, name);
		const svg = (inner: string) => (el: HTMLElement) => setSvg(el, `<svg viewBox="0 0 24 24">${inner}</svg>`);
		// pen drawn with its nib in the current ink colour
		const pen = (el: HTMLElement) => {
			svg(`<path d="M17 3l4 4L8 20l-5 1 1-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path class="ink-nib" d="M4 16l4 4-5 1z" stroke="none"/>`)(el);
			this.penNib = el.querySelector(".ink-nib");
		};
		const scribble = (c: string) => svg(`<path d="M3 15c3-7 6 3 9-3s6 4 9-2" fill="none" stroke="${c}" stroke-width="3.2" stroke-linecap="round"/>`);
		const weight = (w: number) => svg(`<path d="M4 16c4-8 8 4 16-6" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`);
		const isPen = () => !this.handOn && (this.engine.tool === "pen" || this.engine.tool === "eraser");
		const isLasso = () => !this.handOn && this.engine.tool === "lasso";
		this.splitBtn(bar, "pen", "Pen / eraser (tap again to switch)", [pen, icon("eraser")],
			() => (this.penMode === "pen" ? 0 : 1), isPen,
			() => this.setTool(isPen() ? (this.penMode === "pen" ? "eraser" : "pen") : this.penMode)).addClass("is-tool");
		this.splitBtn(bar, "lasso", "Lasso / box select (tap again to switch)", [icon("lasso"), icon("square-dashed")],
			() => (this.engine.boxSelect ? 1 : 0), isLasso,
			() => { if (isLasso()) this.engine.boxSelect = !this.engine.boxSelect; this.setTool("lasso"); }).addClass("is-tool");
		this.splitBtn(bar, "color", "Colour: black / red (tap again to switch)", [scribble(COLORS[0][0]), scribble(COLORS[1][0])],
			() => (this.colorIdx ? 1 : 0), () => true,
			() => this.setColor(this.engine.tool === "pen" || this.engine.selection.length ? 1 - this.colorIdx : this.colorIdx));
		this.splitBtn(bar, "size", "Size: S / M (tap again to switch)", [weight(1.6), weight(3.6)],
			() => (this.sizeLabel === "S" ? 0 : 1), () => this.sizeLabel === "S" || this.sizeLabel === "M",
			() => this.setSize(this.sizeLabel === "S" || this.sizeLabel === "M"
				? (this.engine.tool === "pen" || this.engine.selection.length ? (this.sizeLabel === "S" ? "M" : "S") : this.sizeLabel)
				: "S"));
		this.buildHand(acts);
		this.btn(acts, "undo", "Undo", "undo-2", () => this.engine.undo());
		this.btn(acts, "pageline", "Add page line", "separator-vertical", () => this.addPageLine());
		const more = this.btn(acts, "more", "More", "more-horizontal", () => {
			const r = more.getBoundingClientRect();
			this.toggleMenu("more", (m) => {
				m.addItem((i) => i.setTitle("Redo").setIcon("redo-2").onClick(() => this.engine.redo()));
				m.addSeparator();
				for (const l of ["L", "XL"]) m.addItem((i) => i.setTitle(`Size ${l}`).setChecked(this.engine.size === SIZES.find(([x]) => x === l)![1]).onClick(() => this.setSize(l)));
				m.addSeparator();
				m.addItem((i) => i.setTitle("Insert link to note").setIcon("link").onClick(() => this.insertLink()));
				m.addItem((i) => i.setTitle("Touch draws (palm guard off)").setIcon("hand-metal").setChecked(this.engine.touchDraws).onClick(() => this.toggleTouch()));
				if (!live.settings.devMode) return;
				m.addSeparator();
				m.addItem((i) => i.setTitle("Performance overlay").setIcon("gauge").setChecked(!this.perfEl.hasClass("is-hidden")).onClick(() => this.togglePerf()));
				m.addSeparator();
				m.addItem((i) => i.setTitle("Smoothness tests (vs tldraw, developer mode)").setDisabled(true));
				const flag = (k: keyof Exp, title: string) => m.addItem((i) => i.setTitle(title).setChecked(!!exp[k]).onClick(() => this.setExp({ [k]: !exp[k] } as Partial<Exp>)));
				flag("crisp", "1 Sharp ink when still");
				flag("rafBatch", "2 Draw once per frame");
				flag("fps60", "2b Cap at 60 fps (tldraw)");
				flag("desync", "3 Low-latency canvas (ours)");
				flag("tlFilter", "4 tldraw point filter");
				flag("centerline", "5 Round-pen centerline (tldraw)");
				flag("noCoalesced", "7 Ignore extra pen samples (tldraw on iPad)");
				flag("tlPoints", "8 tldraw point smoothing (with 5)");
				flag("tlCurve", "9 tldraw curve shape (with 5)");
				m.addItem((i) => i.setTitle(`6 Smoothing ${exp.streamline} → ${this.nextStreamline()}`).onClick(() => this.setExp({ streamline: this.nextStreamline() })));
				m.addItem((i) => i.setTitle("All tldraw-like").setIcon("check-check").onClick(() => this.setExp(EXP_TLDRAW)));
				m.addItem((i) => i.setTitle("Reset to ours").setIcon("rotate-ccw").onClick(() => this.setExp(EXP_DEFAULTS)));
			}, { x: r.right, y: r.top - 4, left: true }); // bottom-right: open up and to the left
		});

		this.renderSplits();
	}

	/** zoom chip, bottom-left: [padlock] [split number]. Zooming itself is pinch / ctrl-scroll.
	 *  Split number: large = current zoom, small faded = where a tap takes you (preferred, or back). */
	private zoomLockBtn!: HTMLElement;
	private zoomBack = 1; // zoom to return to when tapping while at the preferred zoom
	private buildZoom() {
		const z = this.contentEl.createDiv({ cls: "ink-zoom" });
		const LOCK_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/></svg>`;
		const LOCK_SHUT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>`;
		// padlock: always visible; open + faded = unlocked, closed on dark = zoom frozen (pinch only pans)
		this.zoomLockBtn = z.createEl("button", { cls: "ink-btn ink-zoom-lockbtn", attr: { "aria-label": "Freeze zoom" } });
		setSvg(this.zoomLockBtn, LOCK_OPEN);
		this.zoomLockBtn.addEventListener("click", () => {
			const on = this.engine.zoomLocked = !this.engine.zoomLocked;
			this.zoomLockBtn.toggleClass("is-locked", on);
			setSvg(this.zoomLockBtn, on ? LOCK_SHUT : LOCK_OPEN);
			this.zoomLockBtn.setAttribute("aria-label", on ? "Zoom frozen: tap to unfreeze" : "Freeze zoom");
		});
		// split number: tap = go to preferred; tap again while there = back to where you were
		this.zoomLabel = z.createEl("button", { cls: "ink-btn ink-zoom-split", attr: { "aria-label": "Go to preferred zoom (tap again to go back)" } });
		this.zoomLabel.createSpan({ cls: "ink-zoom-big" });
		this.zoomLabel.createSpan({ cls: "ink-zoom-small" });
		this.zoomLabel.createSpan({ cls: "ink-zoom-diag" });
		this.zoomPreset = this.zoomLabel;
		this.zoomLabel.addEventListener("click", () => {
			if (this.longPressed) { this.longPressed = false; return; }
			const pref = live.settings.preferredZoom / 100;
			if (Math.round(this.engine.cam.z * 100) === live.settings.preferredZoom) this.engine.setZoom(this.zoomBack);
			else { this.zoomBack = this.engine.cam.z; this.engine.setZoom(pref); }
		});
		this.onLongPress(this.zoomLabel, () => {
			const r = this.zoomLabel.getBoundingClientRect();
			this.toggleMenu("zoom", (m) => {
				m.addItem((i) => i.setTitle("Fit page").setIcon("maximize").onClick(() => this.engine.zoomToFit()));
				for (const p of [50, 100]) m.addItem((i) => i.setTitle(`${p}%`).onClick(() => this.engine.setZoom(p / 100)));
				m.addSeparator();
				m.addItem((i) => i.setTitle(`Set ${Math.round(this.engine.cam.z * 100)}% as preferred`).setIcon("home").onClick(async () => {
					live.settings.preferredZoom = Math.round(this.engine.cam.z * 100);
					await this.plugin().saveSettings();
					this.lastZoomText = ""; this.updateOverlays();
				}));
			}, { x: r.left, y: r.top - 4 });
		});
	}

	private longPressed = false;
	/** ~450 ms press opens a menu; the click that follows is swallowed */
	private onLongPress(el: HTMLElement, fn: () => void) {
		let t = 0;
		const cancel = () => window.clearTimeout(t);
		el.addEventListener("pointerdown", () => { cancel(); this.longPressed = false; t = window.setTimeout(() => { this.longPressed = true; fn(); }, 450); });
		el.addEventListener("pointerup", cancel); el.addEventListener("pointerleave", cancel); el.addEventListener("pointercancel", cancel);
		el.addEventListener("contextmenu", (e) => e.preventDefault());
	}

	isReadOnlyTldraw() { return !!this.tldraw; }

	private buildSelectionBar() {
		this.selBar = this.contentEl.createDiv({ cls: "ink-selbar is-hidden" });
		this.renderSelBar();
	}

	/**
	 * Selection bar, above the selection:
	 * - a link box (pencil tap): Open · Change · Delete
	 * - ink (lasso): Link · Move… · Copy… · Delete
	 */
	private renderSelBar() {
		const bar = this.selBar;
		if (!bar) return;
		bar.empty();
		const btn = (icon: string, text: string | null, label: string, fn: (b: HTMLElement) => void) => {
			const b = bar.createEl("button", { cls: "ink-btn" + (text ? " has-text" : ""), attr: { "aria-label": label } });
			setIcon(b, icon);
			if (text) b.createSpan({ text });
			b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(b); });
			return b;
		};
		const box = this.engine.selectedLinkBox();
		if (box) {
			btn("external-link", "Open", `Open ${box.link!.label}`, () => this.engine.onLinkOpen(box.link!.target));
			btn("pencil", "Change", "Point this box at another note", () => this.changeSelectedLink());
		} else if (this.engine.selection.length) {
			const p = this.plugin();
			btn("link", "Link", "Link the selection to a note", () => this.insertLink());
			const transfer = (mode: "move" | "copy") => (b: HTMLElement) => {
				const r = b.getBoundingClientRect();
				this.toggleMenu(mode, (m) => {
					m.addItem((i) => i.setTitle("To a new drawing").setIcon("file-plus").onClick(() => p.transferSelection(this, mode, true)));
					m.addItem((i) => i.setTitle("To a drawing…").setIcon("folder-input").onClick(() => p.transferSelection(this, mode, false)));
				}, { x: r.left, y: r.bottom + 4 });
			};
			btn("folder-input", "Move…", "Move the selection to another drawing", transfer("move"));
			btn("copy", "Copy…", "Copy the selection to another drawing", transfer("copy"));
		}
		btn("trash-2", null, "Delete selection", () => this.deleteSelection());
		this.updateOverlays();
	}

	/** zoom label + selection bar position. A text update and one transform: no canvas work. */
	private lastZoomText = "";
	private updateOverlays() {
		const t = Math.round(this.engine.cam.z * 100) + "%";
		const pref = live.settings.preferredZoom;
		const atPref = Math.round(this.engine.cam.z * 100) === pref;
		const small = (atPref ? Math.round(this.zoomBack * 100) : pref) + "";
		const key = t + "|" + small;
		if (key !== this.lastZoomText) {
			this.zoomLabel.querySelector(".ink-zoom-big")!.textContent = t.replace("%", "");
			this.zoomLabel.querySelector(".ink-zoom-small")!.textContent = small;
			this.zoomLabel.toggleClass("is-current", atPref);
			this.lastZoomText = key;
		}
		const b = this.engine.selectionScreenBox();
		const hide = !b || this.engine.isMovingSelection();
		this.selBar.toggleClass("is-hidden", hide);
		if (b && !hide) {
			const w = this.stage.clientWidth, bw = this.selBar.offsetWidth || 88;
			const x = Math.max(8, Math.min(w - bw - 8, (b.x0 + b.x1) / 2 - bw / 2));
			const y = b.y0 - 52 < 8 ? b.y1 + 8 : b.y0 - 52; // below the box if there's no room above (toolbar)
			this.selBar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
		}
	}

	private nextStreamline() {
		const steps = [0.62, 0.64, 0.5, 0.4, 0.3, 0.75];
		return steps[(steps.indexOf(exp.streamline) + 1) % steps.length] ?? 0.62;
	}

	setExp(patch: Partial<Exp>) {
		Object.assign(exp, patch);
		saveExp();
		this.engine.applyExp();
		new Notice(`${expLabel()}`, 2000);
	}

	togglePerf(force?: boolean) {
		const show = force ?? this.perfEl.hasClass("is-hidden");
		this.perfEl.toggleClass("is-hidden", !show);
		window.clearInterval(this.perfTimer);
		if (!show) return;
		const fmt = (n: number) => n.toFixed(1);
		const render = () => {
			const s = this.engine.stats();
			this.perfEl.setText(
				`strokes ${s.strokes}  zoom ${s.zoom.toFixed(2)}  level ${s.level}\n` +
				`pen→pixels  avg ${fmt(s.inputAvg)} ms  max ${fmt(s.inputMax)} ms\n` +
				`compose     avg ${fmt(s.composeAvg)} ms  max ${fmt(s.composeMax)} ms\n` +
				`frame gap   avg ${fmt(s.gapAvg)} ms  max ${fmt(s.gapMax)} ms (pan/zoom)\n` +
				`tiles cached ${s.tilesCached}  queued ${s.tilesQueued}  rendered ${s.tilesRendered} (${fmt(s.tileMs)} ms, ${s.strokesDrawn} fills)\n` +
				`load ${fmt(s.loadMs)} ms  save ${fmt(s.saveMs)} ms  file ${(s.fileBytes / 1e6).toFixed(2)} MB\n` +
				`— writing [${expLabel()}]\n` +
				`pen events/s ${s.evtRate.toFixed(0)}  draws/s ${s.drawRate.toFixed(0)}\n` +
				`draw gap    avg ${fmt(s.drawGapAvg)} ms  max ${fmt(s.drawGapMax)} ms\n` +
				`event→drawn avg ${fmt(s.latAvg)} ms  max ${fmt(s.latMax)} ms\n` +
				`ink trails pen avg ${fmt(s.tailAvg)} px  max ${fmt(s.tailMax)} px\n` +
				`sharp redraw ${fmt(s.crispMs)} ms (${s.crispStrokes} strokes)`
			);
		};
		render();
		this.perfTimer = window.setInterval(render, 500);
		this.perfEl.onclick = () => this.engine.resetPerf();
	}
}
