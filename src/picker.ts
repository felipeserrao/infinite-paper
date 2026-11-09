import { App, SuggestModal, TAbstractFile, TFile, TFolder, moment } from "obsidian";

/**
 * Note picker (insert link / pick a drawing):
 * - empty query: files in the active note's folder, newest first
 * - "folder/": that folder's files
 * - otherwise: every matching file in the vault by path, newest first
 * - first row: "Create …: <query> YYYY-MM-DD h.mmA" (nothing is written; a link to it creates the note when opened)
 */
export type PickedNote =
	| { type: "file"; file: TFile }
	| { type: "create"; target: string; displayName: string };

export class NotePicker extends SuggestModal<PickedNote> {
	private resolve?: (v: PickedNote | null) => void;
	private done = false;

	constructor(app: App, private opts: { filter?: (f: TFile) => boolean; createLabel?: string; placeholder: string }) {
		super(app);
		this.setPlaceholder(opts.placeholder);
	}

	pick(): Promise<PickedNote | null> {
		return new Promise((res) => { this.resolve = res; this.done = false; this.open(); });
	}

	private ok(f: TFile) { return !this.opts.filter || this.opts.filter(f); }
	private recent(files: TFile[]) {
		return [...files].sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0) || a.path.localeCompare(b.path));
	}
	private folderFiles(folder: TFolder) {
		return this.recent(folder.children.filter((c: TAbstractFile): c is TFile => c instanceof TFile && this.ok(c)));
	}
	private activeFolder() { return this.app.workspace.getActiveFile()?.parent ?? undefined; }
	private norm(q: string) {
		let v = q.trim();
		if (v.startsWith("[[") && v.endsWith("]]")) v = v.slice(2, -2).trim();
		return v.replace(/\.md$/i, "").replace(/\\+/g, "/").replace(/^\/*/, "");
	}
	private folderFromQuery(q: string): TFolder | undefined {
		if (!q.endsWith("/")) return undefined;
		const path = this.norm(q).replace(/\/$/, "");
		if (!path) return this.app.vault.getRoot();
		const abs = this.app.vault.getAbstractFileByPath(path);
		if (abs instanceof TFolder) return abs;
		const af = this.activeFolder();
		const rel = af ? this.app.vault.getAbstractFileByPath(`${af.path}/${path}`.replace(/\/+/g, "/")) : null;
		return rel instanceof TFolder ? rel : undefined;
	}
	private createRow(q: string, existing: TFile[]): PickedNote | undefined {
		if (!this.opts.createLabel || !q || q.endsWith("/")) return undefined;
		const t = this.norm(q);
		const parts = t.split("/"), base = parts.pop();
		if (!base) return undefined;
		const displayName = `${base} ${moment().format("YYYY-MM-DD h.mmA")}`;
		const target = [...parts, displayName].filter(Boolean).join("/");
		if (existing.some((f) => f.path.replace(/\.md$/i, "").toLowerCase() === target.toLowerCase())) return undefined;
		return { type: "create", target, displayName };
	}

	getSuggestions(query: string): PickedNote[] {
		const q = query.trim();
		const folder = this.folderFromQuery(q);
		let files: TFile[];
		if (folder) files = this.folderFiles(folder);
		else if (!q) { const af = this.activeFolder(); files = af ? this.folderFiles(af) : []; }
		else {
			const lq = q.toLowerCase();
			files = this.recent(this.app.vault.getFiles().filter((f) => this.ok(f) && f.path.toLowerCase().includes(lq)));
		}
		const out: PickedNote[] = files.slice(0, 200).map((file) => ({ type: "file", file }));
		const c = this.createRow(q, files);
		if (c) out.unshift(c);
		return out;
	}

	renderSuggestion(s: PickedNote, el: HTMLElement) {
		if (s.type === "file") { el.setText(s.file.path); return; }
		el.createSpan({ text: `${this.opts.createLabel}: ${s.target}`, cls: "mod-cta" });
	}

	onChooseSuggestion(s: PickedNote) { this.done = true; this.resolve?.(s); }
	onClose() { window.setTimeout(() => { if (!this.done) this.resolve?.(null); }, 0); }
}
