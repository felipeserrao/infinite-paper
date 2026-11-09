# Infinite Paper

Handwritten notes in Obsidian on an endless white page. Made for **iPad and other tablets, ideally with a pen** such as Apple Pencil: a notebook for studying, class notes and thinking on paper.

<p align="center">
  <img src="https://raw.githubusercontent.com/felipeserrao/infinite-paper/main/docs/writing.png" alt="Handwritten notes on iPad" width="32%">
  <img src="https://raw.githubusercontent.com/felipeserrao/infinite-paper/main/docs/selection.png" alt="Lasso selection with Link, Move and Copy" width="32%">
  <img src="https://raw.githubusercontent.com/felipeserrao/infinite-paper/main/docs/link-box.png" alt="A link box pointing to another note" width="32%">
</p>

## Why

The goal was handwriting that feels as smooth as the [tldraw plugin](https://github.com/tldraw/obsidian-plugin), and stays fast when one page holds a very large number of strokes. Infinite Paper draws the page in tiles, so writing, panning and zooming stay quick as a notebook grows.

It is **simple on purpose**. There are two colours, four pen sizes and only a few buttons, so the screen stays out of the way while you write. There are no shapes, text boxes or sticky notes; for those, use tldraw or Excalidraw.

## Features

- **Pen and eraser, black and red, four sizes.** Even-width ink, smoothed with [perfect-freehand](https://github.com/steveruizok/perfect-freehand).
- **Palm guard.** Only the pen draws, so your hand can rest on the screen. Turn it off from the header if you want your finger to draw.
- **Lasso and box select.** Drag what you selected to move it, change its colour or size, delete it, or link it to a note.
- **Links between notes, using Obsidian's own backlinks.** Put a link box on the page that opens any note. Each link is also written into the drawing's note as a normal `[[link]]`, so the backlinks panel, the graph and rename-updates all work as they do for any other note. A links panel lists every link on the page.
- **Move ink to another note and leave a link behind.** Select part of a page and move it to a new or existing drawing. Where it was, you get a link box pointing to its new home, and the new note lists the original in its backlinks. Long notes can grow into a web of connected pages without losing their thread.
- **Page lines.** One tap adds a vertical line to split the endless page into columns. You set the line's length.
- **Zoom chip.** Tap to jump to your preferred zoom and tap again to go back. A padlock freezes the zoom, so pinching only moves the page.
- **Bring your tldraw notes.** Notes made with the [tldraw plugin](https://github.com/tldraw/obsidian-plugin) can open in Infinite Paper read-only (optional). The first time you write in one, an Infinite Paper copy is made and the original is never changed. You can also make a copy with a command. Pen strokes become ink, shapes become outlines, and any text is listed in the copy's note.
- **Plain markdown files.** A drawing is a `.md` note. Tags, links and text you add to it are indexed by Obsidian like any other note (see [File format](#file-format)).

## Usage

- **New drawing:** use the ribbon icon or the command **Infinite Paper: New drawing**.
- **Toolbar (top right):** pen/eraser, lasso/box select, colour, size, and the hand for moving the page. Tap a button again to switch to its other mode.
- **Actions (bottom right):** undo, add page line, and **More** (redo, sizes L/XL, insert link, touch drawing).
- **Header:** links panel, palm guard, open as markdown, save. Drawings also save automatically about 2 seconds after each change.
- **Moving around:** pinch or two-finger drag. On desktop, scroll to move and ctrl/cmd-scroll to zoom.

### Commands

| Command | What it does |
|---|---|
| New drawing | Creates a drawing in the folder set in settings |
| Open this note as drawing / Open this drawing as markdown | Switches between the drawing and the note's text |
| Insert link to note | Adds a link box to the page |
| Add page line | Adds a vertical page line |
| Move / copy selection to drawing / to new drawing | Sends the selected ink to another drawing |
| Make a drawing from this tldraw note | Makes an Infinite Paper copy of a tldraw note |
| Open this tldraw note in tldraw | Opens it in the tldraw plugin instead |

## Settings

- **Save new drawings in:** a fixed folder, the current note's folder, or Obsidian's attachment folder.
- **File name prefix and date format:** new drawings are named like `iPaper 2026-11-08 3.45PM`.
- **Link line:** the shape of each line in a drawing's link list, with `{{link}}` standing for `[[note]]`. The default is `- {{link}}`. Other examples: `- [ ] {{link}}` or `- {{link}} #ref`.
- **Open tldraw notes in Infinite Paper:** off by default.
- **Page line length** and **preferred zoom.**
- **Developer mode:** shows a performance overlay and test tools. Most people don't need it.

## File format

A drawing is a markdown note with `infinite-paper: true` in its frontmatter. The stroke data sits at the end, inside a `%%` comment, so reading view and embeds don't show it:

````markdown
---
infinite-paper: true
---

Anything you write here (tags, links, text) is indexed by Obsidian.

%%
```infinite-paper
{ ...stroke data... }
```
%%
````

With the plugin turned off, your drawings are still ordinary notes. The text and links stay readable, and none of the data is locked in a separate file type.

## Limitations

- **No pen pressure.** Lines have an even width.
- **Two colours and four sizes, by design.**
- **Handwriting only:** no shapes, text boxes, images or PDF annotation.
- **No handwriting recognition or search inside the ink.** Text you type in the note's header is searchable.
- **Tablet first.** It works with a mouse or trackpad, but it is designed and tested for a pen on a tablet.
- **No export to PNG or SVG yet.**

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for "Infinite Paper", then install and enable it.

To install it by hand, download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into `<your vault>/.obsidian/plugins/infinite-paper/`, then enable the plugin.

## Development

```bash
npm install
npm run dev     # rebuilds main.js on every change
npm run build   # type-check and production build
```

To release, set the version in `manifest.json`, `package.json` and `versions.json`, then push a tag with the same version. The GitHub workflow builds the plugin and drafts the release.

## License

[MIT](LICENSE)
