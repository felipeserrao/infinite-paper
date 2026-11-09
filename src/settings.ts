import { AbstractInputSuggest, App, PluginSettingTab, Setting, TFolder, moment, normalizePath } from "obsidian";
import type InfinitePaperPlugin from "./main";

// Not in the public typings, but long-standing and widely used: the "Files and links" attachment setting.
declare module "obsidian" { interface Vault { getConfig?(key: string): unknown } }

/** where new drawings (and drawings converted from tldraw) are created — same choices as the tldraw plugin */
export type DestinationMethod = "default-folder" | "colocate" | "attachments-folder";

export interface InkSettings {
	destinationMethod: DestinationMethod;
	/** used by "default-folder"; "" = vault root */
	defaultFolder: string;
	/** used by "colocate": subfolder of the active note's folder ("" = same folder) */
	colocationSubfolder: string;
	newFilePrefix: string;
	newFileTimeFormat: string;
	/** length of the vertical "page line" the toolbar button drops, in canvas units */
	pageLineLength: number;
	/** zoom (in %) the zoom chip's ⌂ button jumps to */
	preferredZoom: number;
	/** open tldraw notes in Ink (read-only; the first edit makes an Ink copy) instead of the tldraw plugin */
	openTldrawInInk: boolean;
	/** show the developer tools: smoothness tests, performance overlay, compare/stress-test commands */
	devMode: boolean;
	/** shape of each line in a drawing's link list; {{link}} is replaced by [[target]] */
	linkLineTemplate: string;
}

export const DEFAULT_SETTINGS: InkSettings = {
	destinationMethod: "default-folder",
	defaultFolder: "",
	colocationSubfolder: "",
	newFilePrefix: "iPaper ",
	newFileTimeFormat: "YYYY-MM-DD h.mmA",
	pageLineLength: 6500,
	preferredZoom: 70,
	openTldrawInInk: false,
	devMode: false,
	linkLineTemplate: "- {{link}}",
};

/** the plugin's current settings, for code (like the view) that has no handle on the plugin */
export const live: { settings: InkSettings } = { settings: { ...DEFAULT_SETTINGS } };

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: HTMLInputElement, private onPick: (v: string) => void) { super(app, input); }
	getSuggestions(q: string): TFolder[] {
		const lq = q.toLowerCase();
		return this.app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path.toLowerCase().includes(lq))
			.slice(0, 50);
	}
	renderSuggestion(f: TFolder, el: HTMLElement) { el.setText(f.path === "/" ? "/" : f.path); }
	selectSuggestion(f: TFolder) {
		const v = f.path === "/" ? "" : f.path;
		this.input.value = v; this.onPick(v); this.close();
	}
}

export class InkSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: InfinitePaperPlugin) { super(app, plugin); }

	display() {
		const { containerEl: el } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		el.empty();
		el.addClass("infinite-paper-settings");

		new Setting(el).setName("New files").setHeading();
		new Setting(el)
			.setName("Save new drawings in")
			.setDesc("Also used for drawings converted from tldraw.")
			.addDropdown((d) => d
				.addOption("default-folder", "A fixed folder")
				.addOption("colocate", "Same folder as the current note")
				.addOption("attachments-folder", "Obsidian's attachment folder (Files and links)")
				.setValue(s.destinationMethod)
				.onChange(async (v) => { s.destinationMethod = v as DestinationMethod; await save(); this.display(); }));

		if (s.destinationMethod === "default-folder") {
			new Setting(el)
				.setName("Folder")
				.setDesc("Leave empty for the vault root. Created if it doesn't exist.")
				.addText((t) => {
					t.setPlaceholder("e.g. Notes").setValue(s.defaultFolder)
						.onChange(async (v) => { s.defaultFolder = v.trim(); await save(); });
					new FolderSuggest(this.app, t.inputEl, (v) => { s.defaultFolder = v; void save(); });
				});
		}
		if (s.destinationMethod === "colocate") {
			new Setting(el)
				.setName("Subfolder")
				.setDesc("Optional subfolder inside the current note's folder. With no note open, the vault root is used.")
				.addText((t) => t.setPlaceholder("e.g. ink").setValue(s.colocationSubfolder)
					.onChange(async (v) => { s.colocationSubfolder = v.trim(); await save(); }));
		}

		new Setting(el)
			.setName("File name prefix")
			.addText((t) => t.setValue(s.newFilePrefix).onChange(async (v) => { s.newFilePrefix = v; await save(); }));
		const fmt = new Setting(el)
			.setName("Date format")
			.setDesc(`Moment.js format. Example: ${s.newFilePrefix}${moment().format(s.newFileTimeFormat)}`);
		fmt.addText((t) => t.setValue(s.newFileTimeFormat).onChange(async (v) => {
			s.newFileTimeFormat = v || DEFAULT_SETTINGS.newFileTimeFormat; await save();
			fmt.setDesc(`Moment.js format. Example: ${s.newFilePrefix}${moment().format(s.newFileTimeFormat)}`);
		}));

		new Setting(el).setName("tldraw notes").setHeading();
		new Setting(el)
			.setName("Open tldraw notes in Infinite Paper")
			.setDesc("tldraw notes open here read-only. The first time you write, erase or move ink in one, a new Infinite Paper note is made (named and placed as above) and you keep writing there. The tldraw note itself is never changed, and the banner at the top has \"Open in tldraw\" to use the tldraw plugin instead.")
			.addToggle((t) => t.setValue(s.openTldrawInInk).onChange(async (v) => { s.openTldrawInInk = v; await save(); }));

		new Setting(el).setName("Links").setHeading();
		new Setting(el)
			.setName("Link line")
			.setDesc("How each link is written in the drawing's link list (what backlinks and the graph see). {{link}} becomes [[note]]. Examples: - {{link}}, - [ ] {{link}}, - {{link}} #ref")
			.addText((t) => t.setPlaceholder("- {{link}}").setValue(s.linkLineTemplate).onChange(async (v) => {
				s.linkLineTemplate = v.includes("{{link}}") ? v : "- {{link}}"; await save();
			}));

		new Setting(el).setName("Page lines").setHeading();
		new Setting(el)
			.setName("Page line length")
			.setDesc("Length of the vertical line the toolbar's page-line button adds, in canvas units (at 100% zoom, 1 unit = 1 px).")
			.addText((t) => t.setValue(String(s.pageLineLength)).onChange(async (v) => {
				const n = Number(v);
				if (n > 0) { s.pageLineLength = n; await save(); }
			}));

		new Setting(el).setName("Zoom").setHeading();
		new Setting(el)
			.setName("Preferred zoom (%)")
			.setDesc("The ⌂ button in the bottom-left zoom chip jumps to this zoom with one tap.")
			.addText((t) => t.setValue(String(s.preferredZoom)).onChange(async (v) => {
				const n = Number(v);
				if (n >= 5 && n <= 800) { s.preferredZoom = n; await save(); }
			}));

		new Setting(el).setName("Advanced").setHeading();
		new Setting(el)
			.setName("Developer mode")
			.setDesc("Shows the smoothness tests and performance overlay in the toolbar's More menu, plus the Dev commands (compare with tldraw, synthetic stroke stress tests).")
			.addToggle((t) => t.setValue(s.devMode).onChange(async (v) => { s.devMode = v; await save(); }));
	}
}

/** folder (no trailing slash, "" = root) that a new drawing should go in */
export function destinationFolder(app: App, s: InkSettings, activePath?: string): string {
	if (s.destinationMethod === "colocate") {
		const parent = activePath ? activePath.split("/").slice(0, -1).join("/") : "";
		return normalizePath([parent, s.colocationSubfolder].filter(Boolean).join("/")).replace(/^\/$/, "");
	}
	if (s.destinationMethod === "attachments-folder") {
		const cfg = (app.vault.getConfig?.("attachmentFolderPath") as string | undefined) || "/";
		const parent = activePath ? activePath.split("/").slice(0, -1).join("/") : "";
		if (cfg === "/" || cfg === "") return "";
		if (cfg === "./") return parent;
		if (cfg.startsWith("./")) return normalizePath([parent, cfg.slice(2)].filter(Boolean).join("/"));
		return normalizePath(cfg);
	}
	return s.defaultFolder ? normalizePath(s.defaultFolder).replace(/^\/$/, "") : "";
}
