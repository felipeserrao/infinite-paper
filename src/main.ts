import { Notice, Platform, Plugin, ViewState, TAbstractFile, TFile, TFolder, WorkspaceLeaf, normalizePath, moment } from "obsidian";
import { CONVERTED_KEY, DEFAULT_HEADER, FM_KEY, addBacklinks, joinMarkdown, splitMarkdown } from "./mdformat";
import { NotePicker } from "./picker";
import { DEFAULT_SETTINGS, InkSettingTab, InkSettings, destinationFolder, live } from "./settings";
import { importTldraw } from "./tldraw-import";
import { compareWithTldraw, nodeRequire } from "./compare";
import { loadExp, type Exp } from "./exp";
import { Rect, Store, Stroke, appendRows, dataText, strokeRow } from "./store";
import { InkView, VIEW_TYPE } from "./view";
import { synthStrokes } from "./synth";

/** device kind for the load diagnostic (developer mode) */
function deviceLabel() {
	return Platform.isIosApp ? "iOS/iPadOS" : Platform.isAndroidApp ? "Android" : Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "other";
}

export default class InfinitePaperPlugin extends Plugin {
	settings: InkSettings = { ...DEFAULT_SETTINGS };
	/** load diagnostics, kept in data.json next to the settings (developer mode only) */
	private diag: Record<string, unknown> = {};

	async loadSettings() {
		const d = (await this.loadData()) as { settings?: Partial<InkSettings> } | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(d?.settings ?? {}) };
		live.settings = this.settings;
	}

	async saveSettings() {
		await this.saveData({ settings: this.settings, diag: this.settings.devMode ? this.diag : undefined });
	}

	private async saveDiag(diag: Record<string, unknown>) {
		this.diag = diag;
		await this.saveSettings();
	}

	async onload() {
		await this.loadSettings();
		loadExp(this.app);
		try {
			this.setup();
		} catch (e) {
			const msg = "Infinite Paper onload error: " + String((e as Error)?.message ?? e) + "\n" + ((e as Error)?.stack ?? "");
			console.error(msg);
			new Notice(msg, 0);
			if (this.settings.devMode) await this.saveDiag({ loadError: msg, device: deviceLabel(), at: new Date().toISOString() });
			throw e;
		}
		if (this.settings.devMode) await this.saveDiag({ loadedOk: this.manifest.version, device: deviceLabel(), at: new Date().toISOString() });
	}

	private setup() {
		this.registerView(VIEW_TYPE, (leaf) => new InkView(leaf, this));

		this.routeMarkdownDrawings();
		this.addSettingTab(new InkSettingTab(this.app, this));

		this.addRibbonIcon("notebook-pen", "New Infinite Paper note", () => this.newDrawing());

		this.addCommand({
			id: "open-as-drawing",
			name: "Open this note as drawing",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				const leaf = this.app.workspace.getMostRecentLeaf();
				if (!f || !leaf || !this.isInkMarkdown(f) || leaf.view.getViewType() === VIEW_TYPE) return false;
				if (!checking) void leaf.setViewState({ type: VIEW_TYPE, state: { file: f.path } });
				return true;
			},
		});
		this.addCommand({
			id: "open-as-markdown",
			name: "Open this drawing as markdown",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(InkView);
				if (!v || v.file?.extension !== "md") return false;
				if (!checking) void v.openAsMarkdown();
				return true;
			},
		});
		this.addCommand({
			id: "convert-from-tldraw",
			name: "Make a drawing from this tldraw note",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !this.isTldrawMarkdown(f)) return false;
				if (!checking) void this.convertFromTldraw(f);
				return true;
			},
		});
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || !this.isTldrawMarkdown(file)) return;
			menu.addItem((i) => i.setTitle("Open in Infinite Paper (read-only)").setIcon("notebook-pen").onClick(() =>
				this.app.workspace.getLeaf(false).setViewState({ type: VIEW_TYPE, state: { file: file.path, inkReadOnly: true } })));
			menu.addItem((i) => i.setTitle("Open in tldraw").setIcon("pencil").onClick(() => this.openInTldraw(file, this.app.workspace.getLeaf(false))));
			menu.addItem((i) => i.setTitle("Make an Infinite Paper copy").setIcon("copy-plus").onClick(() => this.convertFromTldraw(file)));
		}));
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || !this.isInkMarkdown(file)) return;
			menu.addItem((i) => i.setTitle("Open as drawing").setIcon("notebook-pen").onClick(() =>
				this.app.workspace.getLeaf(false).setViewState({ type: VIEW_TYPE, state: { file: file.path } })));
		}));
		this.addCommand({
			id: "open-in-tldraw",
			name: "Open this tldraw note in tldraw",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !this.isTldrawMarkdown(f)) return false;
				if (!checking) void this.openInTldraw(f, this.app.workspace.getLeaf(false));
				return true;
			},
		});
		this.addCommand({
			id: "dev-compare-tldraw",
			name: "Dev: compare this tldraw note with tldraw's own render",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!this.settings.devMode || !Platform.isDesktopApp || !f || !this.isTldrawMarkdown(f)) return false;
				if (!checking) void this.compareWithTldraw(f);
				return true;
			},
		});
		this.addCommand({ id: "new-drawing", name: "New drawing", callback: () => this.newDrawing() });
		this.addCommand({
			id: "insert-link-to-note",
			name: "Insert link to note",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(InkView);
				if (!v) return false;
				if (!checking) void v.insertLink();
				return true;
			},
		});
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => { void this.renameLinkBoxes(f, oldPath); }));
		// move/copy the selection to a new or an existing drawing
		const transfer = (id: string, name: string, mode: "move" | "copy", toNew: boolean) => this.addCommand({
			id, name,
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(InkView);
				if (!v || !v.engine.selection.length) return false;
				if (!checking) void this.transferSelection(v, mode, toNew);
				return true;
			},
		});
		transfer("move-selection-to-drawing", "Move selection to drawing", "move", false);
		transfer("copy-selection-to-drawing", "Copy selection to drawing", "copy", false);
		transfer("move-selection-to-new-drawing", "Move selection to new drawing", "move", true);
		transfer("copy-selection-to-new-drawing", "Copy selection to new drawing", "copy", true);
		this.addCommand({
			id: "add-page-line",
			name: "Add page line",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(InkView);
				if (!v) return false;
				if (!checking) v.addPageLine();
				return true;
			},
		});

		this.addCommand({
			id: "toggle-perf",
			name: "Toggle performance overlay",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(InkView);
				if (!this.settings.devMode || !v) return false;
				if (!checking) v.togglePerf();
				return true;
			},
		});

		this.addCommand({
			id: "dev-add-100k",
			name: "Dev: add 100k more synthetic strokes (stacks each run)",
			checkCallback: (checking) => {
				const v = this.app.workspace.getActiveViewOfType(InkView);
				if (!this.settings.devMode || !v) return false;
				if (!checking) {
					const t0 = performance.now();
					const st = v.engine.store;
					let maxY = -Infinity;
					for (const s of st.strokes.values()) if (s.bbox.y1 > maxY) maxY = s.bbox.y1;
					const originY = maxY === -Infinity ? 0 : Math.ceil(maxY) + 400;
					v.engine.addMany(synthStrokes(100000, 1000 + st.strokes.size, originY));
					v.togglePerf(true);
					new Notice(`Now ${st.strokes.size.toLocaleString()} strokes (+100k in ${(performance.now() - t0).toFixed(0)} ms)`);
				}
				return true;
			},
		});

		for (const n of [20000, 30000, 50000]) {
			this.addCommand({
				id: `dev-fill-${n / 1000}k`,
				name: `Dev: fill current drawing with ${n / 1000}k synthetic strokes`,
				checkCallback: (checking) => {
					const v = this.app.workspace.getActiveViewOfType(InkView);
					if (!this.settings.devMode || !v) return false;
					if (!checking) {
						const t0 = performance.now();
						const strokes = synthStrokes(n);
						v.engine.clearAll();
						v.engine.addMany(strokes);
						v.engine.setZoom(0.5);
						v.togglePerf(true);
						new Notice(`Added ${n} strokes in ${(performance.now() - t0).toFixed(0)} ms`);
					}
					return true;
				},
			});
		}
	}

	/**
	 * Move or copy the selected ink (and link boxes) to another drawing:
	 * - new drawing: same positions, opens in a new tab
	 * - existing drawing: placed 250 px right of its content, top-aligned; it isn't opened
	 * - move: the source gets a "🔗 target" box where the ink was (one undo step) and a `[[target]]` backlink line
	 * The target is written first; the source changes only if that worked.
	 */
	async transferSelection(view: InkView, mode: "move" | "copy", toNew: boolean) {
		const e = view.engine, src = view.file;
		const sel = [...e.selection], b = e.selectionBounds();
		if (!src || !sel.length || !b) { new Notice("Select ink with the lasso first."); return; }
		if (view.isReadOnlyTldraw()) { new Notice("This tldraw note is read-only. Make a copy first."); return; }
		let dest: { file: TFile } | { name?: string } = {};
		if (!toNew) {
			const p = await new NotePicker(this.app, {
				filter: (f) => f !== src && this.isInkMarkdown(f),
				createLabel: "Create drawing", placeholder: "Select or create a drawing…",
			}).pick();
			if (!p) return;
			dest = p.type === "file" ? { file: p.file } : { name: p.target };
		}
		const links = [...new Set(sel.filter((s) => s.link).map((s) => `[[${s.link!.target}]]`))];
		let target: TFile;
		try {
			if ("file" in dest) { target = dest.file; await this.appendToDrawing(target, sel, links); }
			else target = await this.drawingFrom(sel, b, links, view, dest.name);
		} catch (err) {
			console.error("Infinite Paper: transfer failed", err);
			new Notice(`Couldn't ${mode} the selection: ${(err as Error)?.message ?? err}`, 0);
			return;
		}
		if (mode === "move") {
			const lt = this.app.metadataCache.fileToLinktext(target, src.path);
			const size = Math.min(Math.max(b.x1 - b.x0, b.y1 - b.y0, 160), 400);
			e.replaceWithLink(sel, { target: lt, label: target.basename }, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], size);
			view.addBacklinks([`[[${lt}]]`]);
		}
		if (!("file" in dest)) await this.app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE, state: { file: target.path }, active: true });
		new Notice(`${mode === "move" ? "moved" : "copied"} ${sel.length} item${sel.length === 1 ? "" : "s"} to ${target.basename}.`);
	}

	/** a new drawing holding these strokes at their positions, camera on them at the source's zoom */
	private async drawingFrom(strokes: Stroke[], b: Rect, links: string[], view: InkView, name?: string): Promise<TFile> {
		let path: string;
		const parts = name?.split("/") ?? [];
		const base = parts.pop();
		const folder = parts.join("/");
		if (base && folder && this.app.vault.getAbstractFileByPath(folder) instanceof TFolder) path = this.uniquePath(`${folder}/${base}`, "md");
		else path = await this.nextDrawingPath(view.file?.path, base);
		const [w, h] = view.engine.viewSize(), z = view.engine.cam.z;
		const cam = { z, x: w / 2 - ((b.x0 + b.x1) / 2) * z, y: h / 2 - ((b.y0 + b.y1) / 2) * z };
		const header = links.length ? addBacklinks(DEFAULT_HEADER, links) : DEFAULT_HEADER;
		return this.app.vault.create(path, joinMarkdown(header, dataText(cam, b, strokes.map((s) => strokeRow(s)))));
	}

	/** add strokes to an existing drawing: into its open view (undoable there) or, if closed, by appending rows to the file */
	private async appendToDrawing(file: TFile, strokes: Stroke[], links: string[]) {
		const sb = strokes.reduce((r, s) => ({ x0: Math.min(r.x0, s.bbox.x0), y0: Math.min(r.y0, s.bbox.y0), x1: Math.max(r.x1, s.bbox.x1), y1: Math.max(r.y1, s.bbox.y1) }),
			{ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
		const MARGIN = 250;
		const place = (t: Rect | null): [number, number] => [(t ? t.x1 + MARGIN : MARGIN) - sb.x0, (t ? t.y0 : MARGIN) - sb.y0];
		const open = this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view as InkView).find((v) => v.file === file && !v.isReadOnlyTldraw());
		if (open) {
			const [dx, dy] = place(open.engine.contentBounds());
			open.engine.addFrom(strokes, dx, dy);
			open.addBacklinks(links);
			await open.save();
			return;
		}
		await this.app.vault.process(file, (text) => {
			const { header, data } = splitMarkdown(text);
			return joinMarkdown(links.length ? addBacklinks(header, links) : header, appendRows(data, strokes, place));
		});
	}

	/**
	 * A linked note was renamed: Obsidian fixes the [[ ]] backlink lines itself; this fixes the link boxes in the
	 * drawing data. Only drawings whose text names the old target are read; only their link rows (one per line) are parsed.
	 */
	private async renameLinkBoxes(f: TAbstractFile, oldPath: string) {
		if (!(f instanceof TFile)) return;
		const oldName = oldPath.split("/").pop()!;
		const olds = new Set([oldPath, oldName]);
		if (/\.md$/i.test(oldPath)) { olds.add(oldPath.slice(0, -3)); olds.add(oldName.slice(0, -3)); }
		const oldLabels = new Set([oldName, oldName.replace(/\.md$/i, "")]);
		for (const d of this.app.vault.getMarkdownFiles()) {
			if (!this.isInkMarkdown(d)) continue;
			const text = await this.app.vault.cachedRead(d);
			if (![...olds].some((o) => text.includes(`"link":${JSON.stringify(o)}`))) continue;
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
				const v = leaf.view as InkView;
				if (v.file === d) await v.save(); // flush, then the view reloads from the rewritten file
			}
			const target = this.app.metadataCache.fileToLinktext(f, d.path);
			await this.app.vault.process(d, (t) => t.split("\n").map((line) => {
				if (!line.includes('"link":')) return line;
				const comma = line.endsWith(",");
				try {
					const row = JSON.parse(comma ? line.slice(0, -1) : line) as unknown[];
					const x = row[3] as { link?: string; label?: string } | undefined;
					if (!x || !x.link || !olds.has(x.link)) return line;
					x.link = target;
					if (x.label && oldLabels.has(x.label)) x.label = f.basename;
					return JSON.stringify(row) + (comma ? "," : "");
				} catch { return line; }
			}).join("\n"));
		}
	}

	isTldrawMarkdown(f: TFile) {
		return f.extension === "md" && !!this.app.metadataCache.getFileCache(f)?.frontmatter?.["tldraw-file"];
	}

	isInkMarkdown(f: TFile) {
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
		return f.extension === "md" && !!fm?.[FM_KEY];
	}

	/**
	 * Notes with `infinite-paper: true` in frontmatter open in the drawing view instead of the editor
	 * (same approach as Excalidraw). With "Open tldraw notes in Infinite Paper" on, tldraw notes do too, read-only
	 * (also when the tldraw plugin has already switched them to its own view). A leaf flagged __inkRaw,
	 * or a state carrying inkBypass, is let through untouched.
	 */
	private routeMarkdownDrawings() {
		const proto = WorkspaceLeaf.prototype;
		const orig = Reflect.get(proto, "setViewState") as (this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>;
		const tldrawTypes = ["markdown", "tldraw-view", "tldraw-read-only"];
		// which view a note should really open in (an arrow function, so `this` is the plugin)
		const route = (leaf: WorkspaceLeaf & { __inkRaw?: boolean }, state: ViewState): ViewState => {
			const path = state.state?.file;
			if (typeof path !== "string" || leaf.__inkRaw || state.state?.inkBypass) return state;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return state;
			if (state.type === "markdown" && this.isInkMarkdown(f)) return { ...state, type: VIEW_TYPE };
			// a tldraw note always opens itself (read-only here); its copies are linked from the banner
			if (this.settings.openTldrawInInk && tldrawTypes.includes(state.type) && this.isTldrawMarkdown(f)) return { ...state, type: VIEW_TYPE };
			return state;
		};
		proto.setViewState = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
			return orig.call(this, route(this, state), eState);
		};
		this.register(() => { proto.setViewState = orig; });
	}

	/** open a tldraw note in the tldraw plugin's own view, past our routing */
	async openInTldraw(file: TFile, leaf: WorkspaceLeaf) {
		await leaf.setViewState({ type: "tldraw-view", state: { file: file.path, manuallyTriggered: true, inkBypass: true }, active: true });
	}

	/** Infinite Paper copies already made from this tldraw note (frontmatter `paper-converted-from: "[[note]]"`) */
	findInkCopies(src: TFile): TFile[] {
		const out: TFile[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fmv = this.app.metadataCache.getFileCache(f)?.frontmatter; const v: unknown = fmv?.[CONVERTED_KEY];
			if (typeof v !== "string") continue;
			const target = this.app.metadataCache.getFirstLinkpathDest(v.replace(/^\[\[|\]\]$/g, "").split("|")[0], f.path);
			if (target === src) out.push(f);
		}
		return out.sort((a, b) => b.stat.ctime - a.stat.ctime);
	}

	/** dev: render the note in tldraw and in Ink, diff them; images + stats.json go to outDir (default: system temp) */
	async compareWithTldraw(f: TFile, outDir?: string, scale = 1, override?: Partial<Exp>) {
		const req = nodeRequire;
		const dir = outDir ?? req("path").join(req("os").tmpdir(), "ink-compare", f.basename);
		new Notice(`Comparing "${f.basename}" with tldraw…`);
		const st = await compareWithTldraw(this.app, f, dir, scale, override);
		new Notice(`${st.mismatchPct}% of ink pixels differ, worst ${st.maxDist} px off (99% within ${st.p99Dist} px).\n${dir}`, 15000);
		return st;
	}

	/** for an Ink copy: the tldraw note it was made from */
	originalOf(f: TFile): TFile | null {
		const fmv = this.app.metadataCache.getFileCache(f)?.frontmatter; const v: unknown = fmv?.[CONVERTED_KEY];
		if (typeof v !== "string") return null;
		return this.app.metadataCache.getFirstLinkpathDest(v.replace(/^\[\[|\]\]$/g, "").split("|")[0], f.path);
	}

	/** the path the next new drawing gets: settings folder + prefix + date format (or `name`, for copies) */
	async nextDrawingPath(activePath?: string, name?: string) {
		const folder = await this.targetFolder(activePath);
		name = name ?? (`${this.settings.newFilePrefix}${moment().format(this.settings.newFileTimeFormat)}`.trim() || "iPaper");
		return this.uniquePath(folder ? `${folder}/${name}` : name, "md");
	}

	/**
	 * Name for a copy of a tldraw note: prefix + the note's title + the date (and time) it was written, in the
	 * date format from settings. tldraw names its notes "<title> YYYY-MM-DD h.mmA"; the last date in the name is
	 * taken as when it was written, and it and anything after it (sync-conflict marks like " 2" or " (0)", broken
	 * times) are dropped from the title. A bare "Tldraw" title (untitled note) is dropped. No date in the name:
	 * the file's creation date and time. A date without a readable time: date only.
	 *   "Physics 2 2026-07-29 7.57PM"        -> "iPaper Physics 2 2026-07-29 7.57PM"
	 *   "Tldraw 2025-10-11 6.12PM"           -> "iPaper 2025-10-11 6.12PM"
	 *   "Lecture 4 2025-08-28 1 2.33PM"      -> "iPaper Lecture 4 2025-08-28"
	 */
	copyName(src: TFile): string {
		const fmt = this.settings.newFileTimeFormat;
		let title = src.basename, when = moment(src.stat.ctime), hasTime = true;
		const re = /(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2})[.:](\d{2})\s*([AaPp][Mm]))?/g;
		let m: RegExpExecArray | null, lastMatch: RegExpExecArray | null = null;
		while ((m = re.exec(src.basename))) lastMatch = m;
		if (lastMatch) {
			when = moment(lastMatch[1], "YYYY-MM-DD", true);
			hasTime = !!lastMatch[2];
			if (hasTime) when.hour((+lastMatch[2] % 12) + (/p/i.test(lastMatch[4]) ? 12 : 0)).minute(+lastMatch[3]);
			title = src.basename.slice(0, lastMatch.index);
		}
		title = title.trim();
		if (/^tldraw$/i.test(title)) title = "";
		// date only: keep the leading tokens of the format that have no time parts in them
		const dateFmt = fmt.split(/\s+/).filter((t, i, a) => !a.slice(0, i + 1).some((x) => /[HhkmsSAa]/.test(x))).join(" ") || "YYYY-MM-DD";
		const stamp = when.isValid() ? when.format(hasTime ? fmt : dateFmt) : "";
		const safe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, " ");
		return safe(`${this.settings.newFilePrefix}${[title, stamp].filter(Boolean).join(" ")}`).replace(/\s+/g, " ").trim() || "iPaper";
	}

	/** where a copy would go and what it would be called, for the banner (no folder is created) */
	previewCopyPath(src: TFile) {
		const folder = destinationFolder(this.app, this.settings, src.path);
		const name = this.copyName(src);
		return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
	}

	/** folder for a new drawing per the settings, created if missing */
	private async targetFolder(activePath?: string) {
		const folder = destinationFolder(this.app, this.settings, activePath);
		if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
			await this.app.vault.createFolder(folder).catch(() => {});
		}
		return folder;
	}

	uniquePath(base: string, ext: string) {
		let path = normalizePath(`${base}.${ext}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${base} ${i}.${ext}`);
		return path;
	}

	async newDrawing() {
		const path = await this.nextDrawingPath(this.app.workspace.getActiveFile()?.path);
		const file = await this.app.vault.create(path, joinMarkdown(DEFAULT_HEADER, ""));
		await this.app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}

	/**
	 * Make a new Ink note from a tldraw note; the tldraw note is never changed.
	 * Named and placed like any new drawing (settings). The header links back to the original and lists
	 * what couldn't be converted plus any text from the drawing. `data` (the view's current ink) is read
	 * right before writing, so ink drawn while the copy is being made isn't lost.
	 */
	async makeInkCopy(src: TFile, data?: () => string): Promise<TFile | null> {
		let r;
		try {
			r = importTldraw(await this.app.vault.read(src));
		} catch (e) {
			new Notice(`Can't read ${src.name}: ${(e as Error)?.message ?? e}`, 0);
			return null;
		}
		const path = await this.nextDrawingPath(src.path, this.copyName(src));
		const link = this.app.fileManager.generateMarkdownLink(src, path);
		const lines = [`Infinite Paper copy of the tldraw note ${link}, made ${moment().format("YYYY-MM-DD HH:mm")}. The tldraw note was not changed.`];
		const skipped = Object.entries(r.skipped).map(([t, n]) => `${n} ${t}`);
		if (skipped.length) lines.push("", `Not converted: ${skipped.join(", ")}.`);
		for (const w of r.warnings) lines.push("", `Note: ${w}.`);
		if (r.body) lines.push("", r.body);
		if (r.texts.length) {
			lines.push("", "## Text from the tldraw drawing", "");
			for (const t of r.texts) lines.push("- " + t.split("\n").join("\n  "));
		}
		let header = `---\n${FM_KEY}: true\n${CONVERTED_KEY}: "[[${this.app.metadataCache.fileToLinktext(src, path)}]]"\n---\n\n${lines.join("\n")}\n\n`;
		if (r.backlinks.length) {
			// the same note can appear as "tldraw/Name" in the list and "Name" on the box: keep one per note
			const seen = new Set<string>();
			const uniq = r.backlinks.filter((l) => {
				const t = l.slice(2, -2).split("|")[0];
				const k = this.app.metadataCache.getFirstLinkpathDest(t, src.path)?.path ?? t;
				if (seen.has(k)) return false;
				seen.add(k); return true;
			});
			header = addBacklinks(header, uniq);
		}

		const fromImport = () => {
			const st = new Store();
			for (const s of r.strokes) st.add(st.create(s.color, s.size, s.pts, s.link));
			return st.serialize(r.camera ?? { x: 0, y: 0, z: 1 });
		};
		const file = await this.app.vault.create(path, joinMarkdown(header, data ? data() : fromImport()));
		new Notice(`Made an Infinite Paper copy of "${src.basename}" → ${file.path}\nThe tldraw note is unchanged.` + (skipped.length ? `\nNot converted: ${skipped.join(", ")}` : ""), 10000);
		return file;
	}

	/** command / file menu: make the copy and open it */
	async convertFromTldraw(src: TFile) {
		const file = await this.makeInkCopy(src);
		if (file) await this.app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}
}
