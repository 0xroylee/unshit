// Draws the "how unshit works" diagram: a circuit board in 2.5D, isometric at 30 degrees like the logo. The host is a
// chip with one pin per step of a run; you, your agent, the Codex App Server sessions, GitHub, GitLab and Grep, the
// local project and the run directory are wired to the pins of the steps they take part in. No dependencies.
// Usage: node docs/images/how-it-works.mjs
// Writes, next to this script, how-it-works-{light,dark}.svg (Chinese labels) and how-it-works-en-{light,dark}.svg
// (English labels), and warns when a label overlaps another label, the board or a part.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = dirname(fileURLToPath(import.meta.url));

const STEPS = [
  { zh: "提问", en: "Ask" },
  { zh: "批准 brief", en: "Approve the brief" },
  { zh: "本地项目", en: "Local project" },
  { zh: "搜索与预览", en: "Search and preview" },
  { zh: "筛选参考", en: "Screen references" },
  { zh: "固定读取", en: "Pinned reads" },
  { zh: "生成计划", en: "Plan" },
  { zh: "独立复核", en: "Independent review" },
  { zh: "保存结果", en: "Save" },
];

// The steps each party is wired to. Your pins in `switches` pass through that switch; `leads` traces are dashed.
const WIRING = {
  you: [1, 2, 4],
  switches: { 2: "S1", 4: "S2" },
  local: 3,
  save: 9,
  planning: [1, 5, 6, 7, 8],
  review: [8],
  network: [4, 5, 6],
  leads: [4],
};

const TEXT = {
  en: {
    title: "How unshit works",
    desc: "A circuit board drawn in 2.5D. The unshit host is a chip whose pins are the nine steps of a run: 1 Ask, 2 Approve the brief, 3 Local project, 4 Search and preview, 5 Screen references, 6 Pinned reads, 7 Plan, 8 Independent review, 9 Save. You reach the host in the terminal, or through your agent (Claude Code or Codex) over JSONL on stdin and stdout. Your answers go to step 1, and switches S1 and S2 at steps 2 and 4 stay open until you approve. The Codex planning session is wired to steps 1, 5, 6, 7 and 8, and a review session that is new for each review to step 8; both sit under a shield: tools off, no network, read-only. GitHub, GitLab and Grep are wired to steps 4, 5 and 6: search hits are leads, and reads at a pinned commit are evidence. Step 3 reads the local project with credentials redacted, and step 9 writes .unshit/<run-id>/. Six lines from the host feed an AND chip that lights Ready: brief approved, no material gap, no blocking or material finding, no open decision, no validation issue, and Codex did not ask for Draft. Otherwise the plan is Draft.",
    host: "unshit host",
    you: "you",
    agent: "your agent",
    agentNote: ["Claude Code or Codex", "with the unshit skill"],
    chat: "chat",
    terminal: "terminal",
    jsonl: [[{ mono: "--agent" }, ": JSONL on stdin and stdout"], [{ mono: "input_request" }, " out"], [{ mono: "input_response" }, " in"]],
    switchNote: "S1 and S2 stay open until you approve",
    local: "local project",
    localNote: "credentials redacted",
    network: "GitHub · GitLab · Grep",
    networkNote: "host-built queries · no token to Grep",
    taps: ["4 search hits: leads only", "5 tree at a pinned commit", "6 evidence: SHA-256, lines"],
    codex: "Codex App Server",
    codexNote: ["tools off · no network · read-only", "replies are JSON that the host checks", "new review session for each review"],
    planning: "planning session",
    review: "review session",
    save: ".unshit/<run-id>/",
    saveNote: "plan.md · manifest · sources",
    ready: "Ready",
    draft: "otherwise Draft",
    and: "AND",
    conditions: ["brief approved", "no material gap", "no blocking or material finding", "no open decision", "no validation issue", "Codex did not ask for Draft"],
  },
  zh: {
    title: "unshit 的工作原理",
    desc: "以 2.5D 绘制的电路板。unshit host 是一颗芯片，引脚是一次运行的九个步骤：1 提问，2 批准 brief，3 本地项目，4 搜索与预览，5 筛选参考，6 固定读取，7 生成计划，8 独立复核，9 保存结果。你在终端里，或者通过你的 agent（Claude Code 或 Codex）经 stdin 与 stdout 上的 JSONL 接到 host。你的回答接到步骤 1；步骤 2 和 4 上的开关 S1、S2 在你批准之前保持断开。Codex 的规划 session 接到步骤 1、5、6、7、8，每次复核都新开的复核 session 接到步骤 8；两者都在屏蔽罩里：关闭工具、无网络、只读。GitHub、GitLab 和 Grep 接到步骤 4、5、6：搜索结果只是线索，固定提交的读取才是证据。步骤 3 读取本地项目并先遮蔽凭证，步骤 9 写入 .unshit/<run-id>/。host 引出六条线接到 AND 芯片，全部成立才点亮 Ready：brief 已批准、没有重大缺口、没有阻断或重大问题、没有待决的业务决定、校验全部通过、Codex 没有要求 Draft。否则计划是 Draft。",
    host: "unshit host",
    you: "你",
    agent: "你的 agent",
    agentNote: ["Claude Code 或 Codex", "装有 unshit skill"],
    chat: "聊天",
    terminal: "终端",
    jsonl: [[{ mono: "--agent" }, "：stdin 与 stdout 上的 JSONL"], ["发出 ", { mono: "input_request" }], ["收回 ", { mono: "input_response" }]],
    switchNote: "你批准之前，S1 和 S2 保持断开",
    local: "本地项目",
    localNote: "凭证先遮蔽",
    network: "GitHub · GitLab · Grep",
    networkNote: "查询由 host 构造 · Grep 不带 token",
    taps: ["4 搜索结果：只是线索", "5 固定提交的文件树", "6 证据：SHA-256 与行号"],
    codex: "Codex App Server",
    codexNote: ["关闭工具 · 无网络 · 只读", "回答是 host 校验的 JSON", "每次复核都新开复核 session"],
    planning: "规划 session",
    review: "复核 session",
    save: ".unshit/<run-id>/",
    saveNote: "plan.md · manifest · 源码快照",
    ready: "Ready",
    draft: "否则 Draft",
    and: "AND",
    conditions: ["brief 已批准", "没有重大缺口", "没有阻断或重大问题", "没有待决的业务决定", "校验全部通过", "Codex 没有要求 Draft"],
  },
};
const LANGUAGES = { zh: "", en: "-en" };

const THEMES = {
  light: { plate: "#ffffff", hi: "#232327", edge: "#a4a4ac", mid: "#c3c3c9", lo: "#e0e0e4", title: "#232327", text: "#6e6e78", line: "#a4a4ac" },
  dark: { plate: "#0d1117", hi: "#fafafa", edge: "#a1a1aa", mid: "#52525b", lo: "#27272a", title: "#f0f0f3", text: "#a1a1aa", line: "#71717a" },
};

const W = 900;
const H = 580;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const UNIT = 10.2; // one board unit, in SVG units
const ORIGIN = [392, 126];
// x runs right and down, y runs left and down, z runs up, as in logo.mjs.
const P = (x, y, z = 0) => [ORIGIN[0] + (x - y) * COS * UNIT, ORIGIN[1] + (x + y) * SIN * UNIT - z * UNIT];
const n = (value) => Number(value.toFixed(1));
const esc = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The board and its parts, in board units. The host's back faces the network and Codex, its front faces you.
const HOST = { x: 9, y: 8, w: 21.6, d: 14, h: 0.9 };
const pinX = (step) => HOST.x + 1.4 + (step - 1) * 2.35;
const BACK = HOST.y;
const FRONT = HOST.y + HOST.d;
const LEG = 0.6;
const REVIEW_BUS = 6.6;
const PLANNING_BUS = 5.0;
const NET = { y: 1.0, face: 3.0 };
const HINGE = FRONT + 1.3;
const CONTACT = FRONT + 2.6;
const YOU_BUS = FRONT + 3.6;
const EDGE = FRONT + 5.4;
const BOARD = { x: 45, y: EDGE + 2.6, t: 0.5 };
const HEADER = { x: 0.4, w: 2.4 };
const TERMINAL = { y: 9.6, tap: 5.2 };
const AGENT_HEADER = { y: 13.6, tap: 4.0 };
const CODEX = { x: 33.6, w: 9.6 };
const CONDITIONS = TEXT.en.conditions.length;
const AND = { x: 32.6, y: 12.4, w: 3.2, d: 1.2 + (CONDITIONS - 1) * 1.16, h: 0.8 };
const conditionY = (index) => AND.y + 0.6 + index * 1.16;
const LED = [39, AND.y + AND.d / 2];
const YOU = { x: -14, y: 4.4, w: 3.4, d: 3.4 };
const AGENT = { x: -12.4, y: AGENT_HEADER.y - 0.8, w: 7, d: 3.6 };

// Approximate text width, for the overlap check.
function widthOf(value, size) {
  const runs = typeof value === "string" ? [[value, false]] : value.map((run) => (typeof run === "string" ? [run, false] : [run.mono, true]));
  let width = 0;
  for (const [chars, mono] of runs) for (const ch of chars) width += mono ? 0.6 * size : ch.codePointAt(0) > 0x2e80 ? size : /[A-Z]/.test(ch) ? 0.68 * size : /[iljtf.,·:;' ]/.test(ch) ? 0.32 * size : 0.56 * size;
  return width;
}

// Even-odd test of a point against a polygon.
function inside([x, y], polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function diagram(themeName, language) {
  const t = THEMES[themeName];
  const L = TEXT[language];
  const out = [];
  const labels = [];
  const solids = [];
  const pts = (points) => points.map((point) => P(...point)).map(([x, y]) => `${n(x)} ${n(y)}`).join(" L");
  const face = (points, stroke) => out.push(`<path d="M${pts(points)} Z" fill="${t.plate}" stroke="${stroke}" stroke-width="0.9" stroke-linejoin="round"/>`);
  const line = (points, { color = t.line, dash } = {}) => out.push(`<path d="M${pts(points)}" fill="none" stroke="${color}" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
  // The three visible faces of a box: x = x1, y = y1 and the top.
  const box = (x0, y0, z0, w, d, h, { top = t.mid, solid = true } = {}) => {
    const [x1, y1, z1] = [x0 + w, y0 + d, z0 + h];
    face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], t.edge);
    face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], t.edge);
    face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], top);
    if (solid) solids.push([[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y1, z1]].map((point) => P(...point)));
  };
  // A horizontal circle projects to an ellipse with axes sqrt(2)*r*cos30 and sqrt(2)*r*sin30.
  const ellipse = (x, y, r, { fill = t.plate, stroke = t.edge } = {}) => {
    const [cx, cy] = P(x, y, 0);
    out.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(Math.SQRT2 * r * COS * UNIT)}" ry="${n(Math.SQRT2 * r * SIN * UNIT)}" fill="${fill}" stroke="${stroke}" stroke-width="0.9"/>`);
  };
  const runs = (value) => (typeof value === "string" ? esc(value) : value.map((run) => (typeof run === "string" ? esc(run) : `<tspan font-family="${MONO}">${esc(run.mono)}</tspan>`)).join(""));
  const attrs = ({ size = 11, weight = 400, anchor = "start", color = t.text, mono = false }) => `font-size="${size}"${weight === 400 ? "" : ` font-weight="${weight}"`}${anchor === "start" ? "" : ` text-anchor="${anchor}"`} fill="${color}"${mono ? ` font-family="${MONO}"` : ""}`;
  // A flat label; value is a string, or a list of strings and { mono } runs.
  const text = (x, y, value, options = {}) => {
    const size = options.size ?? 11;
    const width = widthOf(options.mono ? [{ mono: value }] : value, size);
    const left = options.anchor === "end" ? x - width : options.anchor === "middle" ? x - width / 2 : x;
    labels.push({ value: typeof value === "string" ? value : value.map((run) => run.mono ?? run).join(""), x0: left, y0: y - size * 0.8, x1: left + width, y1: y + size * 0.25 });
    out.push(`<text x="${n(x)}" y="${n(y)}" ${attrs(options)}>${runs(value)}</text>`);
  };
  const block = (x, y, lines, options = {}) => lines.forEach((value, index) => text(x, y + index * 14, value, options));
  // Text printed on a top face: "-y" reads right and up, "+x" reads right and down.
  const printed = (x, y, z, value, { axis = "-y", ...options } = {}) => {
    const [px, py] = P(x, y, z);
    const m = axis === "-y" ? [COS, -SIN, COS, SIN] : [COS, SIN, -COS, SIN];
    out.push(`<text transform="matrix(${m.map((v) => Number(v.toFixed(4))).join(" ")} ${n(px)} ${n(py)})" ${attrs(options)}>${runs(value)}</text>`);
  };
  const leader = (points) => out.push(`<path d="M${points.map(([x, y]) => `${n(x)} ${n(y)}`).join(" L")}" fill="none" stroke="${t.mid}" stroke-width="0.9"/>`);
  // A leg leaves a face at height 0.45, runs out by (dx, dy) and drops to the board.
  const leg = (x, y, dx, dy) => line([[x, y, 0.45], [x + dx, y + dy, 0.45], [x + dx, y + dy, 0]], { color: t.edge });

  // A trace along y at x. It takes a dot where three or more trace ends meet on a bus it is wired to, and passes on the
  // bottom layer, between two vias, under a bus it crosses without being wired to it.
  const trace = (x, y0, y1, buses, { step, dash } = {}) => {
    const direction = Math.sign(y1 - y0);
    let from = y0;
    for (const bus of buses.filter((b) => (b.y - y0) * (b.y - y1) <= 0 && x >= b.x0 && x <= b.x1).sort((a, b) => direction * (a.y - b.y))) {
      if (bus.steps.includes(step)) {
        const ends = 1 + (bus.y !== y1 ? 1 : 0) + (x > bus.x0 ? 1 : 0) + (x < bus.x1 ? 1 : 0);
        if (ends >= 3) ellipse(x, bus.y, 0.2, { fill: t.line, stroke: "none" });
        continue;
      }
      if (x === bus.x0 || x === bus.x1) continue;
      line([[x, from], [x, bus.y - direction * 0.8]], { dash });
      line([[x, bus.y - direction * 0.8], [x, bus.y + direction * 0.8]], { color: t.mid, dash: "1 2" });
      ellipse(x, bus.y - direction * 0.8, 0.32);
      ellipse(x, bus.y + direction * 0.8, 0.32);
      from = bus.y + direction * 0.8;
    }
    line([[x, from], [x, y1]], { dash });
  };

  // Off the board, behind its left end: you, chat, the terminal cable, your agent and its ribbon.
  box(YOU.x, YOU.y, -BOARD.t, YOU.w, YOU.d, 0.4, { top: t.hi });
  printed(YOU.x + 1.15, YOU.y + YOU.d - 0.8, -BOARD.t + 0.4, L.you, { weight: 600, color: t.title });
  line([[YOU.x + 2.5, YOU.y + YOU.d, -0.3], [YOU.x + 2.5, AGENT.y, -0.3]]);
  line([[YOU.x + YOU.w, YOU.y + YOU.d / 2, -0.3], [-1.6, YOU.y + YOU.d / 2, -0.3], [-1.6, TERMINAL.y + 1.2, -0.3], [HEADER.x, TERMINAL.y + 1.2, 0.5]]);
  box(AGENT.x, AGENT.y, -BOARD.t, AGENT.w, AGENT.d, 1.2);
  printed(AGENT.x + 0.8, AGENT.y + AGENT.d / 2 + 0.55, -BOARD.t + 1.2, L.agent, { axis: "+x", weight: 600, color: t.title });
  for (const dy of [-0.45, 0, 0.45]) line([[AGENT.x + AGENT.w, AGENT_HEADER.y + 1.2 + dy, 0.2], [HEADER.x, AGENT_HEADER.y + 1.2 + dy, 0.5]], { color: t.edge });

  // The board, with a grid of dots every 2 units.
  box(0, 0, -BOARD.t, BOARD.x, BOARD.y, BOARD.t, { top: t.edge, solid: false });
  const board = [[0, 0, 0], [BOARD.x, 0, 0], [BOARD.x, 0, -BOARD.t], [BOARD.x, BOARD.y, -BOARD.t], [0, BOARD.y, -BOARD.t], [0, BOARD.y, 0]].map((point) => P(...point));
  const grid = [];
  for (let x = 2; x < BOARD.x; x += 2) for (let y = 2; y < BOARD.y; y += 2) {
    const [gx, gy] = P(x, y, 0);
    grid.push(`M${n(gx - 0.6)} ${n(gy)} h1.2`);
  }
  out.push(`<path d="${grid.join(" ")}" stroke="${t.lo}" stroke-width="0.9" stroke-linecap="round"/>`);

  // Back traces: the Codex sessions and the network.
  const backBuses = [
    { y: REVIEW_BUS, x0: pinX(Math.min(...WIRING.review)), x1: CODEX.x, steps: WIRING.review },
    { y: PLANNING_BUS, x0: pinX(Math.min(...WIRING.planning)), x1: CODEX.x, steps: WIRING.planning },
  ];
  for (const bus of backBuses) line([[bus.x0, bus.y], [bus.x1, bus.y]]);
  const backPins = [...new Set([...WIRING.planning, ...WIRING.review, ...WIRING.network])];
  for (const step of backPins) {
    const end = WIRING.network.includes(step) ? NET.face : Math.min(...backBuses.filter((bus) => bus.steps.includes(step)).map((bus) => bus.y));
    trace(pinX(step), BACK - LEG, end, backBuses, { step, dash: WIRING.leads.includes(step) ? "2 3" : undefined });
  }

  // Front traces: the terminal and agent headers to your pins, the local project and the run directory.
  const youBus = { y: YOU_BUS, x0: AGENT_HEADER.tap, x1: pinX(Math.max(...WIRING.you)), steps: WIRING.you };
  line([[HEADER.x + HEADER.w, AGENT_HEADER.y + 1.2], [youBus.x0, AGENT_HEADER.y + 1.2], [youBus.x0, youBus.y], [youBus.x1, youBus.y]]);
  line([[HEADER.x + HEADER.w, TERMINAL.y + 1.2], [TERMINAL.tap, TERMINAL.y + 1.2], [TERMINAL.tap, youBus.y]]);
  ellipse(TERMINAL.tap, youBus.y, 0.2, { fill: t.line, stroke: "none" });
  for (const step of WIRING.you) {
    if (!WIRING.switches[step]) { trace(pinX(step), FRONT + LEG, youBus.y, [youBus], { step }); continue; }
    line([[pinX(step), FRONT + LEG], [pinX(step), HINGE]]);
    trace(pinX(step), CONTACT, youBus.y, [youBus], { step });
  }
  trace(pinX(WIRING.local), FRONT + LEG, EDGE, [youBus]);
  trace(pinX(WIRING.save), FRONT + LEG, EDGE - 0.6, [youBus]);

  // Ready: one trace per condition from the host's right end to an AND chip, then to an LED.
  for (let index = 0; index < CONDITIONS; index += 1) line([[HOST.x + HOST.w + LEG, conditionY(index)], [AND.x - LEG, conditionY(index)]]);
  line([[AND.x + AND.w + LEG, LED[1]], [LED[0], LED[1]]]);

  // Parts on the board, back to front.
  const network = WIRING.network.map(pinX);
  box(Math.min(...network) - 1.3, NET.y, 0, Math.max(...network) - Math.min(...network) + 2.6, NET.face - NET.y, 1.3);
  for (const x of network) leg(x, NET.face, 0, 0);
  for (const step of backPins) leg(pinX(step), BACK, 0, -LEG);
  box(HEADER.x, TERMINAL.y, 0, HEADER.w, 2.4, 1.0);
  box(HEADER.x, AGENT_HEADER.y, 0, HEADER.w, 2.4, 1.0);
  box(CODEX.x, 2.6, 0, CODEX.w, 3.0, 0.9);
  printed(CODEX.x + 0.8, 4.6, 0.9, L.planning, { axis: "+x", color: t.title });
  box(CODEX.x, 6.1, 0, CODEX.w, 2.2, 0.9);
  printed(CODEX.x + 0.8, 7.65, 0.9, L.review, { axis: "+x", color: t.title });
  for (let index = 0; index < CONDITIONS; index += 1) leg(AND.x, conditionY(index), -LEG, 0);
  box(HOST.x, HOST.y, 0, HOST.w, HOST.d, HOST.h, { top: t.edge });
  printed(HOST.x + 0.7, BACK + 1.25, HOST.h, L.host, { axis: "+x", weight: 600, color: t.title });
  STEPS.forEach((step, index) => printed(pinX(index + 1) + 0.4, FRONT - 0.8, HOST.h, [{ mono: String(index + 1) }, ` ${step[language]}`], { size: 11.5, color: t.title }));
  for (let index = 0; index < CONDITIONS; index += 1) leg(HOST.x + HOST.w, conditionY(index), LEG, 0);
  for (const step of [...WIRING.you, WIRING.local, WIRING.save]) leg(pinX(step), FRONT, 0, LEG);
  box(AND.x, AND.y, 0, AND.w, AND.d, AND.h);
  printed(AND.x + 1.9, AND.y + AND.d - 2.2, AND.h, L.and, { mono: true, size: 10, color: t.title });
  leg(AND.x + AND.w, LED[1], LEG, 0);
  // The LED: a short cylinder with a dome.
  {
    const [cx, base] = P(LED[0], LED[1], 0);
    const rx = Math.SQRT2 * 0.75 * COS * UNIT;
    const ry = Math.SQRT2 * 0.75 * SIN * UNIT;
    const top = base - UNIT;
    out.push(`<path d="M${n(cx - rx)} ${n(top)} V${n(base)} A${n(rx)} ${n(ry)} 0 0 0 ${n(cx + rx)} ${n(base)} V${n(top)} A${n(rx)} ${n(rx)} 0 0 0 ${n(cx - rx)} ${n(top)} Z" fill="${t.plate}" stroke="${t.edge}" stroke-width="0.9" stroke-linejoin="round"/>`);
    out.push(`<path d="M${n(cx - rx)} ${n(top)} A${n(rx)} ${n(ry)} 0 0 0 ${n(cx + rx)} ${n(top)}" fill="none" stroke="${t.mid}" stroke-width="0.9"/>`);
    solids.push([[cx - rx, top - rx], [cx + rx, top - rx], [cx + rx, base + ry], [cx - rx, base + ry]]);
  }
  // Knife switches, open: the blade rises from the hinge post toward the contact post.
  for (const [step, name] of Object.entries(WIRING.switches)) {
    const x = pinX(Number(step));
    box(x - 0.4, HINGE - 0.4, 0, 0.8, 0.8, 0.7);
    line([[x, HINGE, 0.7], [x, HINGE + 1.0, 2.7]], { color: t.hi });
    box(x - 0.4, CONTACT - 0.4, 0, 0.8, 0.8, 0.7);
    printed(x + 0.7, CONTACT + 1.1, 0, name, { axis: "+x", mono: true, size: 10, color: t.title });
  }
  box(pinX(WIRING.local) - 1.5, EDGE, 0, 3, BOARD.y + 0.4 - EDGE, 1.0);
  box(pinX(WIRING.save) - 1.8, EDGE - 0.6, 0, 3.6, BOARD.y + 1 - EDGE, 0.6);
  box(pinX(WIRING.save) - 1.3, BOARD.y - 1.2, 0.22, 2.6, 2.8, 0.12);
  // The shield over the Codex sessions: a dashed can.
  {
    const [x0, y0, x1, y1, z1] = [CODEX.x - 1.2, 1.4, CODEX.x + CODEX.w + 0.8, 9.0, 2.4];
    const edges = [[[x1, y0, 0], [x1, y0, z1]], [[x1, y1, 0], [x1, y1, z1]], [[x0, y1, 0], [x0, y1, z1]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], [[x1, y0, 0], [x1, y1, 0], [x0, y1, 0]]];
    for (const edge of edges) line(edge, { color: t.mid, dash: "4 3" });
    solids.push([[x0, y0, z1], [x1, y0, z1], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y1, z1]].map((point) => P(...point)));
  }

  // Labels, off the board.
  const you = P(YOU.x, YOU.y, -BOARD.t + 0.4);
  text(you[0] - 24, you[1] - 20, L.switchNote);
  const chat = P(YOU.x + 2.5, (YOU.y + YOU.d + AGENT.y) / 2, -0.3);
  text(chat[0] + 8, chat[1] + 8, L.chat);
  const terminal = P(-4, YOU.y + YOU.d / 2, -0.3);
  text(terminal[0] + 4, terminal[1] - 8, L.terminal);
  const agent = P(AGENT.x, AGENT.y + AGENT.d, -BOARD.t);
  block(agent[0] - 8, agent[1] + 14, L.agentNote, { anchor: "end" });
  block(14, agent[1] + 50, L.jsonl);

  const net = P(Math.min(...network) - 1.3, NET.y, 1.3);
  text(net[0] - 14, net[1] - 88, L.network, { size: 13, weight: 600, color: t.title });
  text(net[0] - 14, net[1] - 72, L.networkNote);
  block(net[0] - 14, net[1] - 52, L.taps);
  leader([[net[0] + 26, net[1] - 20], [net[0] + 26, net[1] - 3]]);

  const can = P(CODEX.x + CODEX.w + 0.8, 1.4, 2.4);
  text(W - 214, can[1] - 96, L.codex, { size: 13, weight: 600, color: t.title });
  block(W - 214, can[1] - 80, L.codexNote);
  leader([[can[0] - 20, can[1] - 38], [can[0] - 20, can[1] - 6]]);

  const led = P(LED[0], LED[1], 1.6);
  text(led[0] + 70, led[1] + 62, L.ready, { size: 15, weight: 600, color: t.title });
  text(led[0] + 70, led[1] + 78, L.draft);
  leader([[led[0] + 8, led[1] + 8], [led[0] + 64, led[1] + 57]]);
  block(led[0] + 70, led[1] + 98, L.conditions);

  const save = P(pinX(WIRING.save), BOARD.y + 1.6, 0);
  text(save[0] - 6, save[1] + 30, L.save, { mono: true, size: 12, color: t.title, anchor: "end" });
  text(save[0] - 6, save[1] + 45, L.saveNote, { anchor: "end" });

  const local = P(pinX(WIRING.local), BOARD.y + 0.4, 0);
  text(local[0] - 10, local[1] + 30, L.local, { size: 13, weight: 600, color: t.title, anchor: "end" });
  text(local[0] - 10, local[1] + 45, L.localNote, { anchor: "end" });

  // Each label must stay on the canvas, off the board and the parts, and clear of the other labels.
  const samples = (label) => [0, 1, 2, 3, 4].flatMap((i) => [label.y0, label.y1].map((y) => [label.x0 + ((label.x1 - label.x0) * i) / 4, y]));
  labels.forEach((label, index) => {
    const where = `${language} ${themeName}: "${label.value}"`;
    if (label.x0 < 4 || label.x1 > W - 4 || label.y0 < 4 || label.y1 > H - 4) console.warn(`${where} leaves the canvas`);
    if (samples(label).some((point) => inside(point, board) || solids.some((solid) => inside(point, solid)))) console.warn(`${where} overlaps the board or a part`);
    for (const other of labels.slice(index + 1)) if (label.x0 < other.x1 && other.x0 < label.x1 && label.y0 < other.y1 && other.y0 < label.y1) console.warn(`${where} overlaps "${other.value}"`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="${FONT}">
<title id="t">${esc(L.title)}</title>
<desc id="d">${esc(L.desc)}</desc>
${themeName === "dark" ? `<rect width="${W}" height="${H}" fill="${t.plate}"/>\n` : ""}${out.join("\n")}
</svg>
`;
}

for (const [language, suffix] of Object.entries(LANGUAGES)) for (const themeName of Object.keys(THEMES)) {
  const svg = diagram(themeName, language);
  await writeFile(join(outDir, `how-it-works${suffix}-${themeName}.svg`), svg);
  console.log(`${language} ${themeName}: ${(svg.length / 1024).toFixed(0)} KB`);
}
