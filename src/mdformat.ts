/**
 * Markdown storage, Excalidraw-style:
 *
 *   ---
 *   infinite-paper: true
 *   ---
 *   (free markdown: links, tags, later OCR text — Obsidian indexes this part)
 *
 *   %%
 *   ```infinite-paper
 *   {...stroke data...}
 *   ```
 *   %%
 *
 * The data sits in a %% comment so reading view and embeds never render it.
 */
import { live } from "./settings";

export const FM_KEY = "infinite-paper";
/** frontmatter on an Infinite Paper copy of a tldraw note: link to the original */
export const CONVERTED_KEY = "paper-converted-from";
const OPEN = "%%\n```infinite-paper\n";
const CLOSE = "```\n%%\n";

export const DEFAULT_HEADER = `---\n${FM_KEY}: true\n---\n\n`;

export function splitMarkdown(text: string): { header: string; data: string } {
	const i = text.lastIndexOf(OPEN);
	if (i < 0) return { header: text.trim() ? text : DEFAULT_HEADER, data: "" };
	const start = i + OPEN.length;
	const end = text.indexOf("```", start);
	return { header: text.slice(0, i), data: end < 0 ? text.slice(start) : text.slice(start, end) };
}

export function joinMarkdown(header: string, data: string): string {
	const h = header.endsWith("\n\n") ? header : header.endsWith("\n") ? header + "\n" : header + "\n\n";
	return h + OPEN + data + (data.endsWith("\n") ? "" : "\n") + CLOSE;
}

// ---------- backlinks: every link box also gets a `- [[target]]` line in the header (the line's shape is a setting) ----------
// Obsidian indexes the header, so the backlinks panel and graph see the links. Lines are only ever added.
export const LINKS_START = "<!-- INFINITE_PAPER_LINKS_START -->";
export const LINKS_END = "<!-- INFINITE_PAPER_LINKS_END -->";

export const LINK_PLACEHOLDER = "{{link}}";
export const DEFAULT_LINK_LINE = `- ${LINK_PLACEHOLDER}`;
const WIKILINK = /\[\[[^\]\n]+\]\]/;

/** the lines between the markers that hold a [[link]] */
function blockLines(header: string): string[] {
	const i = header.indexOf(LINKS_START), j = header.indexOf(LINKS_END);
	if (i < 0 || j < i) return [];
	return header.slice(i + LINKS_START.length, j).split("\n").filter((l) => WIKILINK.test(l));
}

/** the `[[target]]` of each link line (the first wikilink on the line), in order */
export function parseBacklinks(header: string): string[] {
	return blockLines(header).map((l) => l.match(WIKILINK)![0]);
}

/** a new link line from the template in settings, e.g. "- [ ] {{link}} #ref" */
function renderLine(link: string): string {
	const t = live.settings.linkLineTemplate;
	return (t && t.includes(LINK_PLACEHOLDER) ? t : DEFAULT_LINK_LINE).replace(LINK_PLACEHOLDER, link);
}

/** write the link list; a link that already has a line keeps it as written (the user may have added text to it) */
export function setBacklinks(header: string, links: string[]): string {
	const existing = new Map<string, string>();
	for (const l of blockLines(header)) { const k = l.match(WIKILINK)![0]; if (!existing.has(k)) existing.set(k, l); }
	const block = `${LINKS_START}\n${links.map((l) => existing.get(l) ?? renderLine(l)).join("\n")}\n${LINKS_END}`;
	const i = header.indexOf(LINKS_START), j = header.indexOf(LINKS_END);
	if (i >= 0 && j > i) return header.slice(0, i) + block + header.slice(j + LINKS_END.length);
	return header.replace(/\s*$/, "") + "\n\n" + block + "\n\n";
}

/** add `[[target]]` lines that aren't there yet; returns the header unchanged if none are new */
export function addBacklinks(header: string, links: string[]): string {
	const cur = parseBacklinks(header);
	const add = links.filter((l, k) => !cur.includes(l) && links.indexOf(l) === k);
	return add.length ? setBacklinks(header, [...cur, ...add]) : header;
}
