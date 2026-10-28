// Draws the unshit logo: a 2x2 brick on the left half of a 2x4 brick, with a poop on top, in the hairline style (isometric 30 degrees, opaque plates, grey strokes, one lit stroke on the poop's tip).
// No dependencies.
// Usage: node docs/images/logo.mjs
// Writes logo-light.svg, logo-dark.svg (the mark) and favicon.svg (one 2x2 brick with the poop, heavier lines, light
// and dark through prefers-color-scheme) next to this script.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = dirname(fileURLToPath(import.meta.url));
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const PITCH = 14; // one stud pitch, in SVG units
const BRICK_HEIGHT = 1.2; // in pitches
const STUD_RADIUS = 0.3;
const STUD_HEIGHT = 0.2;

const THEMES = {
  light: { plate: "#ffffff", hi: "#232327", edge: "#a4a4ac", mid: "#c3c3c9" },
  dark: { plate: "#0d1117", hi: "#fafafa", edge: "#a1a1aa", mid: "#52525b" },
};

// x runs right and down, y runs left and down, z runs up.
const project = (x, y, z) => [(x - y) * COS * PITCH, (x + y) * SIN * PITCH - z * PITCH];
const f = (value) => Number(value.toFixed(2)).toString();

function polygon(points, bounds) {
  const projected = points.map((point) => project(...point));
  for (const [X, Y] of projected) bounds.push([X, Y]);
  return `M${projected.map(([X, Y]) => `${f(X)} ${f(Y)}`).join(" L")} Z`;
}

// The three visible faces of a box; the top face may be the lit stroke.
function brick(x0, y0, z0, width, depth, bounds, litTop) {
  const x1 = x0 + width;
  const y1 = y0 + depth;
  const z1 = z0 + BRICK_HEIGHT;
  const right = polygon([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], bounds);
  const left = polygon([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], bounds);
  const top = polygon([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], bounds);
  return [
    { d: right, fill: "plate", stroke: "edge" },
    { d: left, fill: "plate", stroke: "edge" },
    { d: top, fill: "plate", stroke: litTop ? "hi" : "mid" },
  ];
}

// A stud: a short cylinder; a horizontal circle projects to an ellipse with axes sqrt(2)*r*cos30 and sqrt(2)*r*sin30.
function stud(cx, cy, z, bounds) {
  const rx = Math.SQRT2 * STUD_RADIUS * COS * PITCH;
  const ry = Math.SQRT2 * STUD_RADIUS * SIN * PITCH;
  const [X, top] = project(cx, cy, z + STUD_HEIGHT);
  const bottom = top + STUD_HEIGHT * PITCH;
  bounds.push([X - rx, top - ry], [X + rx, bottom + ry]);
  return [
    { d: `M${f(X - rx)} ${f(top)} A${f(rx)} ${f(ry)} 0 0 1 ${f(X + rx)} ${f(top)} L${f(X + rx)} ${f(bottom)} A${f(rx)} ${f(ry)} 0 0 1 ${f(X - rx)} ${f(bottom)} Z`, fill: "plate", stroke: "edge" },
    { d: `M${f(X - rx)} ${f(top)} A${f(rx)} ${f(ry)} 0 0 0 ${f(X + rx)} ${f(top)}`, fill: "none", stroke: "mid" },
  ];
}

// Studs on a top face, back to front, leaving out the cells that `covered` returns true for.
function studs(x0, y0, width, depth, z, bounds, covered = () => false) {
  const cells = [];
  for (let i = 0; i < width; i += 1) for (let j = 0; j < depth; j += 1) if (!covered(x0 + i, y0 + j)) cells.push([x0 + i + 0.5, y0 + j + 0.5]);
  cells.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  return cells.flatMap(([x, y]) => stud(x, y, z, bounds));
}

// The poop: three soft tiers, each an ellipse whose lower half shows below the tier above, shifted left and right for
// the swirl, and a curled tip whose outline is the lit stroke. Sizes and offsets are in pitches from the point where
// it sits.
function poop(cx, cy, z0, bounds) {
  const [X, Y] = project(cx, cy, z0);
  const tiers = [[1.25, 0.714, 0, -0.429], [0.929, 0.586, -0.107, -1.107], [0.614, 0.457, 0.107, -1.679]];
  const shapes = tiers.map(([rx, ry, dx, dy]) => {
    const [ex, ey, erx, ery] = [X + dx * PITCH, Y + dy * PITCH, rx * PITCH, ry * PITCH];
    bounds.push([ex - erx, ey - ery], [ex + erx, ey + ery]);
    return { d: `M${f(ex - erx)} ${f(ey)} A${f(erx)} ${f(ery)} 0 1 1 ${f(ex + erx)} ${f(ey)} A${f(erx)} ${f(ery)} 0 1 1 ${f(ex - erx)} ${f(ey)} Z`, fill: "plate", stroke: "edge" };
  });
  const [tx, ty, w, h, lean] = [X + 0.107 * PITCH, Y - 1.964 * PITCH, 0.393 * PITCH, 0.821 * PITCH, 0.25 * PITCH];
  bounds.push([tx - w, ty], [tx + w, ty], [tx + lean, ty - h]);
  shapes.push({
    d: `M${f(tx - w)} ${f(ty)} C ${f(tx - w)} ${f(ty - h * 0.55)}, ${f(tx + lean - w * 0.2)} ${f(ty - h * 0.7)}, ${f(tx + lean)} ${f(ty - h)} C ${f(tx + lean + w * 0.45)} ${f(ty - h * 0.72)}, ${f(tx + w)} ${f(ty - h * 0.45)}, ${f(tx + w)} ${f(ty)} Z`,
    fill: "plate",
    stroke: "hi",
  });
  return shapes;
}

function mark() {
  const bounds = [];
  const shapes = [
    ...brick(0, 0, 0, 4, 2, bounds, false),
    ...studs(0, 0, 4, 2, BRICK_HEIGHT, bounds, (x) => x < 2),
    ...brick(0, 0, BRICK_HEIGHT, 2, 2, bounds, false),
    ...poop(1, 1, 2 * BRICK_HEIGHT, bounds),
  ];
  return { shapes, bounds };
}

function favicon() {
  const bounds = [];
  const shapes = [...brick(0, 0, 0, 2, 2, bounds, false), ...poop(1, 1, BRICK_HEIGHT, bounds)];
  return { shapes, bounds };
}

// A square viewBox around the drawing, with a margin of `pad` of its larger side.
function viewBox(bounds, pad) {
  const xs = bounds.map(([X]) => X);
  const ys = bounds.map(([, Y]) => Y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const side = Math.max(maxX - minX, maxY - minY) * (1 + 2 * pad);
  return `${f((minX + maxX) / 2 - side / 2)} ${f((minY + maxY) / 2 - side / 2)} ${f(side)} ${f(side)}`;
}

function markSvg(theme) {
  const t = THEMES[theme];
  const { shapes, bounds } = mark();
  const paths = shapes.map((s) => `<path d="${s.d}" fill="${s.fill === "none" ? "none" : t[s.fill]}" stroke="${t[s.stroke]}"/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(bounds, 0.04)}" width="128" height="128" role="img" aria-labelledby="t" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round">
<title id="t">unshit</title>
${paths}
</svg>
`;
}

function faviconSvg() {
  const { shapes, bounds } = favicon();
  const css = (t) => `.plate{fill:${t.plate}}.hi{stroke:${t.hi}}.edge{stroke:${t.edge}}.mid{stroke:${t.mid}}`;
  // Heavier strokes and darker greys than the mark, so the brick reads at 16 to 32 pixels.
  const light = { plate: "#ffffff", hi: "#232327", edge: "#6e6e78", mid: "#a4a4ac" };
  const dark = { plate: "#0d1117", hi: "#fafafa", edge: "#a1a1aa", mid: "#71717a" };
  const paths = shapes.map((s) => `<path d="${s.d}" class="${s.fill === "none" ? "" : "plate "}${s.stroke}"${s.fill === "none" ? ' fill="none"' : ""}/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(bounds, 0.06)}" width="32" height="32" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
<style>${css(light)}@media (prefers-color-scheme: dark){${css(dark)}}</style>
${paths}
</svg>
`;
}

for (const theme of Object.keys(THEMES)) await writeFile(join(outDir, `logo-${theme}.svg`), markSvg(theme));
await writeFile(join(outDir, "favicon.svg"), faviconSvg());
console.log("wrote logo-light.svg, logo-dark.svg, favicon.svg");
