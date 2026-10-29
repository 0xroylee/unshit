# DESIGN.md

The visual and writing style of the unshit site (`docs/index.html`), its diagrams (`docs/images/`), and the pages that each run writes (`preview.html` and `stack.html`). Follow it when you change either, or when you add a page or a figure. The values below are the ones in the code. If you change a value, change it here and in the code in the same commit.

## Principles

- Thin lines carry the structure. There are no decorative fills, shadows, gradients or glows. As in Hairline's rules, the stroke is the only highlight.
- Greys only. Emphasis comes from a darker (or, in dark mode, brighter) stroke or from text weight, never from a colour.
- Content first: one idea per block and plenty of white space. Numbers and file names stay visible instead of being hidden behind icons.
- English and simplified Chinese are equal. Every visible string exists in both languages.
- Static first. The site loads no third-party script, font or style, and the diagrams are static SVG.

## Colour tokens

Site tokens are CSS custom properties in `docs/index.html`. Dark mode follows `prefers-color-scheme`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#0d1117` | Page background. The dark value is GitHub's dark canvas, so diagram plates blend in. |
| `--text` | `#232327` | `#f0f0f3` | Body text and headings (15.66:1 and 16.64:1 on `--bg`) |
| `--muted` | `#6e6e78` | `#a1a1aa` | Secondary text, nav, captions (5.04:1 and 7.38:1 on `--bg`) |
| `--line` | `#e0e0e4` | `#27272a` | Section dividers, card borders, grid lines |
| `--line-strong` | `#c3c3c9` | `#52525b` | Buttons, the install box, code blocks, notes |
| `--hi` | `#232327` | `#fafafa` | The emphasis stroke: primary button border, selected language |

Diagram tokens are in `THEMES` in `docs/images/how-it-works.mjs`. They keep the names of Hairline's `--hairline-*` properties.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| plate | `#ffffff` | `#0d1117` | Fill of the board and the parts; must equal the background |
| hi | `#232327` | `#fafafa` | The lit strokes: the "you" tile and the blades of S1 and S2 |
| edge | `#a4a4ac` | `#a1a1aa` | Silhouettes: the board, the sides of parts, legs, the ribbon and the host's top face |
| mid | `#c3c3c9` | `#52525b` | Other top faces, leaders, the Codex shield and bottom-layer traces |
| lo | `#e0e0e4` | `#27272a` | What recedes: the board's grid |
| title | `#232327` | `#f0f0f3` | Step names, part names and callout titles |
| text | `#6e6e78` | `#a1a1aa` | Captions |
| line | `#a4a4ac` | `#71717a` | Traces, cables and joints |

Text stays at WCAG AA contrast (4.5:1) or better. Line colours are decoration, never the only way to tell two things apart.

## Lines and shapes

- Every border, divider and connector is 0.9px, the same as Hairline's `--hairline-stroke`.
- Diagram traces and cables are solid, 0.9px, with no arrowheads. Dashed lines mark only the search-hit trace (`2 3`), the Codex shield (`4 3`) and traces on the board's bottom layer (`1 2`). A small filled dot marks a joint where three or more trace ends meet.
- Radius:
  - `999px`: pills, such as buttons and the language switch.
  - `12px`: cards.
  - `10px`: boxes, such as the install command, code blocks and notes.
  - `5px`: inline code.
- Code blocks and boxes have a border and no background fill.

## Typography

- Text font: `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
- Code font: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
- Headings and buttons use sentence case.

| Role | Size and line height | Weight | Tracking |
| --- | --- | --- | --- |
| H1 (hero) | `clamp(34px, 5.4vw, 56px)` / 1.12 | 650 | -0.025em |
| H2 (section) | 30px | 650 | -0.015em |
| H3 (card, step) | 16 to 17px | 620 | normal |
| Lede | 18px, `--muted` | 400 | normal |
| Body | 16px / 1.65 | 400 | normal |
| Small text, notes, lists in cards | 14 to 15px | 400 | normal |
| Labels, buttons, switch | 13 to 15px | 400 | normal |
| Step numbers | 12px code font, `--muted` | 400 | normal |
| Diagram step names, printed on the host | 11.5px | 400 | normal |
| Diagram part names, printed on parts | 11px; S1, S2 and AND 10px code font | 400; 600 for you, your agent and the host | normal |
| Diagram callout titles | 13px; Ready 15px; the run directory 12px code font | 600; 400 for the run directory | normal |
| Diagram captions | 11px | 400 | normal |

## Layout

- The content column is at most 980px wide, with 24px side padding. The stack page is the exception: it fills the width of the window (see Stack page).
- Sections are separated by a 0.9px `--line` border. Their padding is 72px top and bottom; the hero has 96px and 72px.
- Grids:

  | Grid | Columns | Gap |
  | --- | --- | --- |
  | Steps | 3 | none; cells share borders |
  | Cards | 3 | 20px |
  | Two-column blocks | 2 | 28px |
- Text widths: the H1 is at most 760px, ledes at most 680 to 720px, and the install box at most 780px.
- Below 820px:
  - Every grid becomes one column.
  - The nav hides; the language switch stays.
  - Section padding drops to 56px, and the hero to 64px and 56px.

## Components

- **Header:** a 60px bar with the brand, the nav links and the language switch.
  - Nav links are `--muted` and turn `--text` on hover.
  - The switch is a pill group; the selected language gets an inset `--hi` stroke.
- **Hero:** H1, lede, install box, note, buttons.
  - The install box holds the command and a Copy button, divided by a 0.9px line.
  - The primary button has a `--hi` border, the secondary one a `--line-strong` border.
- **Step grid:** each cell has a two-digit number in code font, the title with its actor tag (Codex, you, host), and one or two sentences.
- **Note box:** a 0.9px `--line-strong` border and 10px radius, for rules the reader must not miss, such as when a plan is Ready.
- **Card:** a 0.9px `--line` border, 12px radius and 24px padding, with an H3 and `--muted` text.
- **Docs list:** rows divided by `--line`, with language links right-aligned.
- **Footer:** 14px `--muted` text with the credits.

## Figures and diagrams

- Drawings follow Hairline's rules (`@lucasmarkes/hairline`, MIT, © Lucas Marques): isometric at 30°, opaque plates in the background colour, grey strokes and few lit strokes. The logo (see Logo), the bricks of the stack page (see Stack page) and the circuit diagram are drawn this way. Do not mix in another illustration style. Do not add colour, shadows or gradients.
- The circuit diagram (`docs/images/how-it-works.mjs`):
  - It is 900 by 580. One board unit is 10.2; x runs right and down, y left and down, z up, as in the logo.
  - The board is a plate 0.5 units thick with a grid of dots every 2 units. The host is a chip in the middle with one pin per step, in run order; the step names are printed on its top face.
  - `WIRING` says which steps each party is wired to: you and your agent sit off the board's left end and reach it through the terminal and `--agent` headers; the Codex planning and review sessions sit under a dashed shield; GitHub, GitLab and Grep share one connector; the local project and the run directory sit at the front edge; an AND chip with one input per readiness condition drives the Ready LED.
  - S1 and S2 are knife switches with the blade up. Traces run along the board's axes; a trace that crosses another without joining it passes on the bottom layer between two vias.
  - Text on a part is printed on its top face. Every other label is flat and sits off the board, next to its part or joined to it by a leader. The script warns when a label overlaps another label, the board or a part.
- Never edit the SVG files by hand. Generate them with `node docs/images/how-it-works.mjs`: four variants (Chinese and English labels, each in light and dark), shown with `<picture>` and `prefers-color-scheme`.

## Stack page

`stack.html`, which `renderStackHtml` in `src/report.ts` writes for each run, shows the plan as a tower of toy bricks: one brick per entity of the data model, at the bottom, then one per module, in the plan's order.

- **Bricks.** The logo's 2×4 brick (`brickDrawing` in `src/stack.ts`): isometric at 30°, 1.2 pitches high, eight studs, a pitch of 32px. Plates fill with the background colour; faces use `edge`, the top face and the stud tops `mid`, both 0.9px. A brick with no cited source is dashed (`2 3`).
- **Tower.** At rest, each brick sits 1.2 pitches above the one below it, so the studs of a lower brick are covered. The number and name of each brick sit to the right of its right face, outside the drawing.
- **Open.** Hovering a brick, focusing it with Tab or pressing it opens it: every brick above lifts by 96px in 180ms (no movement under `prefers-reduced-motion`), the open brick takes the `hi` stroke, and its name is underlined. With script, the last brick opened stays open until another one opens, and Escape closes it; without script, a brick is open while it is hovered or focused.
- **Layout.** A full-width viewer, an exception to the 980px column: the 60px header, then two columns as tall as the rest of the window. The left one (at least 440px, 40%) holds the plan title and the tower; the right one scrolls on its own and holds the open brick's detail, at most 700px wide. Below 820px the columns stack, the page scrolls, and the drawing scales to 0.75 while the labels keep their size.
- **Detail text.** Module name 30px; what it does 18px; claims and new-design reasons 16px/1.65 in `--text`; file paths 15px in the code font; labels and commit hashes in `--muted`.

The step page `preview.html` keeps the 980px column. Both pages use the site's colour tokens and its language switch.

## Logo

The mark is a stack of toy bricks with a poop on top: a 2×2 brick on the left half of a 2×4 brick, and the poop on the 2×2. The bricks stand for parts that already exist and were checked. The poop stands for the invented code that unshit is meant to replace. The lit stroke is the curled tip of the poop.

- **Construction** (`docs/images/logo.mjs`):
  - Isometric at 30°.
  - Bricks: one stud pitch is 14 units, a brick is 1.2 pitches high, and a stud has a radius of 0.3 and a height of 0.2 pitches.
  - Poop: three soft tiers, each an ellipse whose lower half shows below the tier above, shifted left and right for the swirl. A curled tip sits on top.
  - Opaque plates in the background colour, with `edge` for silhouettes, `mid` for inner lines and `hi` for the tip.
  - The stroke is 1.1 units.
- **Files.** Never edit these by hand; regenerate them with `node docs/images/logo.mjs`.
  - `logo-light.svg` and `logo-dark.svg` hold the mark; pick between them with `<picture>`.
  - `favicon.svg` is a single 2×2 brick with the poop, with heavier lines (2.2 units) and darker greys. It switches theme through `prefers-color-scheme` inside the SVG.
- **Sizes:**
  - The full mark at 48px or larger: the README shows it at 96px, the site hero at 112px.
  - Below 48px, use the favicon drawing: the site header at 26px, and the browser tab.
- **Don't:**
  - Colour it, give the poop a face, fill faces with grey, add shadows, or rotate it.
  - Put text inside it.
  - Draw the poop without the bricks.
- **With the name:** set "unshit" in the text font, weight 650, next to the mark with a 10px gap, as the site header does.

## Language

- Every visible string on the site, and on the pages each run writes, has an English element (`lang="en"`) and a Chinese element (`lang="zh-CN"`). CSS shows the pair that matches `html[data-lang]`.
- The page shows English unless `?lang=zh` or a saved choice asks for Chinese. Without script it shows English.
- Chinese text is simplified Chinese. Product terms stay in English in both languages: brief, host, Codex, Ready, Draft, `plan.md`.
- The two versions say the same thing. Change both in the same commit.

## Voice

- Use plain words and specific facts. Prefer numbers to adjectives: "at most 12 requests a run", not "a few requests".
- Say what the code does, and nothing it does not guarantee.
- State limits plainly, for example "read, not run" or "the host does not check this".
- Use short sentences. Do not use em dashes, hype words or exclamation marks.

## Accessibility

- Each diagram `<img>` has alt text in the page language that lists the nine steps. Each SVG has a `<title>` and a `<desc>` in the language of its labels.
- Controls are real `<button>` and `<a>` elements. The language switch has an `aria-label`.
- Colour and line weight are never the only signal; there is always text.

## Checks for a visual change

1. Serve `docs/` at `/unshit/` (as GitHub Pages does) and render the page in Chrome in four setups: English desktop, Chinese at 390px, the dark scheme, and Chinese from the browser locale.
2. In each setup, check that there is no horizontal overflow, no console error or failed request, and that the expected language and diagram variant loaded.
3. Regenerate the diagrams. When no label changed, the existing SVGs must come out byte-identical, and the script prints no overlap warning.
