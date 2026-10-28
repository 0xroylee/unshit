// Builds the "how unshit works" diagram from hairline figures (MIT, @lucasmarkes/hairline 0.5.1).
// Each figure is mounted in headless Chrome, its computed styles are written into attributes so the SVG needs no
// script or stylesheet, and nine of them are laid out as a numbered pipeline with captions.
// Usage: node docs/images/how-it-works.mjs <tool dir>
//   <tool dir> is any directory with `npm install @lucasmarkes/hairline playwright-core` done in it; Google Chrome
//   must be installed. Writes how-it-works-light.svg and how-it-works-dark.svg next to this script.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const [pkgDir] = process.argv.slice(2);
if (!pkgDir) throw new Error("usage: node docs/images/how-it-works.mjs <tool dir>");
const outDir = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(pkgDir, "package.json"))("playwright-core");

const STEPS = [
  { figure: "query", title: "提问", who: "Codex", lines: ["从需求提取要求与验收", "缺业务决定时先问你"] },
  { figure: "padlock", title: "批准 brief", who: "你", lines: ["你确认整份 brief", "终端输入 yes 或补答文件"] },
  { figure: "drawer", title: "本地项目", who: "", lines: ["读取目标项目的文件与脚本", "凭证先遮蔽"] },
  { figure: "loupe", title: "搜索候选", who: "", lines: ["host 构造的 GitHub 查询", "加上 Grep 代码搜索"] },
  { figure: "sieve", title: "筛选参考", who: "Codex", lines: ["元数据门槛、模型排序", "固定提交的测试与许可证检查"] },
  { figure: "branches", title: "固定读取", who: "", lines: ["按提交读取源码", "记录 SHA-256 与行号"] },
  { figure: "rebuild", title: "生成计划", who: "Codex", lines: ["按依赖排序的任务", "验收与具名错误实现"] },
  { figure: "format", title: "独立复核", who: "Codex", lines: ["新会话复核", "最多修正一次"] },
  { figure: "cabinet", title: "保存结果", who: "", lines: ["plan.md、manifest、源码快照", "Ready 或 Draft"] },
];

const THEMES = {
  light: { plate: "#ffffff", hi: "#232327", edge: "#a4a4ac", mid: "#c3c3c9", lo: "#e0e0e4", title: "#232327", text: "#6e6e78", line: "#a4a4ac" },
  dark: { plate: "#0d1117", hi: "#fafafa", edge: "#a1a1aa", mid: "#52525b", lo: "#27272a", title: "#f0f0f3", text: "#a1a1aa", line: "#71717a" },
};

const cells = Object.entries(THEMES)
  .map(([theme, t]) => `<div class="${theme}" style="--hairline-plate:${t.plate};--hairline-hi:${t.hi};--hairline-edge:${t.edge};--hairline-mid:${t.mid};--hairline-lo:${t.lo};--hairline-stroke:0.9;background:${t.plate}">
     ${STEPS.map((step) => `<div data-theme-name="${theme}" data-figure="${step.figure}" style="width:400px"></div>`).join("")}
   </div>`)
  .join("");
const page = `<!doctype html><html><body style="margin:0">${cells}
<script type="module">
import * as h from "/node_modules/@lucasmarkes/hairline/dist/index.js";
for (const el of document.querySelectorAll("[data-figure]")) h[el.dataset.figure](el, { theme: el.dataset.themeName });
window.ready = true;
</script></body></html>`;

const server = createServer(async (req, res) => {
  if (req.url === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
  try {
    const body = await readFile(normalize(join(pkgDir, decodeURIComponent(req.url))));
    res.writeHead(200, { "content-type": "text/javascript" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const tab = await browser.newPage({ viewport: { width: 900, height: 900 } });
tab.on("pageerror", (e) => console.log("pageerror", e.message));
await tab.goto(`http://127.0.0.1:${server.address().port}/`);
await tab.waitForFunction(() => window.ready === true);
await tab.waitForTimeout(1500);

// Inner markup of every figure in its 400 x 320 viewBox, with computed styles as attributes.
const figures = await tab.evaluate(() => {
  const props = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "fill-opacity", "opacity", "vector-effect"];
  const defaults = { opacity: "1", "stroke-opacity": "1", "fill-opacity": "1", "stroke-dasharray": "none" };
  const result = {};
  for (const host of document.querySelectorAll("[data-figure]")) {
    const svg = host.querySelector("svg");
    const clone = svg.cloneNode(true);
    const source = [...svg.querySelectorAll("*")];
    const target = [...clone.querySelectorAll("*")];
    source.forEach((el, index) => {
      const style = getComputedStyle(el);
      const out = target[index];
      out.removeAttribute("class");
      if (style.transform && style.transform !== "none") throw new Error(`${host.dataset.figure}: CSS transform on ${el.tagName}`);
      if (style.display === "none" || style.visibility === "hidden") out.setAttribute("display", "none");
      for (const name of props) {
        const value = style.getPropertyValue(name);
        if (value && value !== defaults[name]) out.setAttribute(name, value);
      }
    });
    result[`${host.dataset.themeName}:${host.dataset.figure}`] = clone.innerHTML;
  }
  return result;
});

const W = 900;
const COLUMN = 300;
const SCALE = 0.55;
const FIG_W = 400 * SCALE;
const FIG_H = 320 * SCALE;
const ROW = FIG_H + 86;
const H = 3 * ROW + 8;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;
const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// Snake order: row 0 left to right, row 1 right to left, row 2 left to right.
function cellOf(index) {
  const row = Math.floor(index / 3);
  const position = index % 3;
  const column = row % 2 === 0 ? position : 2 - position;
  return { row, column, x: column * COLUMN + (COLUMN - FIG_W) / 2, y: row * ROW };
}

function chevron(x, y, direction, color) {
  const d = direction === "right" ? `M${x - 5} ${y - 4} L${x} ${y} L${x - 5} ${y + 4}` : direction === "left" ? `M${x + 5} ${y - 4} L${x} ${y} L${x + 5} ${y + 4}` : `M${x - 4} ${y - 5} L${x} ${y} L${x + 4} ${y - 5}`;
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function diagram(themeName) {
  const t = THEMES[themeName];
  const parts = [];
  STEPS.forEach((step, index) => {
    const { x, y } = cellOf(index);
    parts.push(`<g transform="translate(${x.toFixed(1)} ${(y + 4).toFixed(1)}) scale(${SCALE})">${figures[`${themeName}:${step.figure}`]}</g>`);
    const cx = x + FIG_W / 2;
    const top = y + FIG_H + 22;
    const tag = step.who ? `<tspan dx="8" font-size="11" fill="${t.text}">${esc(step.who)}</tspan>` : "";
    parts.push(`<text x="${cx.toFixed(1)}" y="${top.toFixed(1)}" text-anchor="middle" font-size="15" font-weight="600" fill="${t.title}">${index + 1}  ${esc(step.title)}${tag}</text>`);
    step.lines.forEach((line, lineIndex) => {
      parts.push(`<text x="${cx.toFixed(1)}" y="${(top + 20 + lineIndex * 17).toFixed(1)}" text-anchor="middle" font-size="12.5" fill="${t.text}">${esc(line)}</text>`);
    });
  });
  // Connectors between consecutive steps.
  for (let index = 0; index < STEPS.length - 1; index += 1) {
    const a = cellOf(index);
    const b = cellOf(index + 1);
    if (a.row === b.row) {
      const y = a.y + 4 + FIG_H / 2;
      const rightward = b.column > a.column;
      const x1 = rightward ? a.x + FIG_W + 6 : a.x - 6;
      const x2 = rightward ? b.x - 6 : b.x + FIG_W + 6;
      parts.push(`<path d="M${x1.toFixed(1)} ${y.toFixed(1)} L${x2.toFixed(1)} ${y.toFixed(1)}" stroke="${t.line}" stroke-width="0.9" stroke-dasharray="2 3"/>`);
      parts.push(chevron(x2, y, rightward ? "right" : "left", t.line));
    } else {
      const x = a.x + FIG_W / 2;
      const y1 = a.y + FIG_H + 66;
      const y2 = b.y + 10;
      parts.push(`<path d="M${x.toFixed(1)} ${y1.toFixed(1)} L${x.toFixed(1)} ${y2.toFixed(1)}" stroke="${t.line}" stroke-width="0.9" stroke-dasharray="2 3"/>`);
      parts.push(chevron(x, y2, "down", t.line));
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H.toFixed(0)}" width="${W}" height="${H.toFixed(0)}" role="img" aria-labelledby="t d" font-family="${FONT}">
<title id="t">How unshit works</title>
<desc id="d">Nine steps: ask, approve the brief, read the local project, search candidates, screen references, read at pinned commits, plan, independent review, save the result.</desc>
${themeName === "dark" ? `<rect width="${W}" height="${H.toFixed(0)}" fill="${t.plate}"/>` : ""}
${parts.join("\n")}
</svg>
`;
}

await mkdir(outDir, { recursive: true });
for (const themeName of Object.keys(THEMES)) {
  const svg = diagram(themeName);
  await writeFile(join(outDir, `how-it-works-${themeName}.svg`), svg);
  console.log(`${themeName}: ${(svg.length / 1024).toFixed(0)} KB`);
}

await browser.close();
server.close();
