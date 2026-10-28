import { sourceLocation } from "./evidence.ts";
import type { EvidenceExcerpt, EvidenceRef, EvidenceSource, PlanDocument } from "./types.ts";

// One cited excerpt behind a brick: where the host read it, and the claim the model wrote next to it.
export interface StackFile {
  excerptId: string;
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  // The pinned permalink with the line range, for a remote source.
  url?: string;
  snapshotPath: string;
  claim: string;
}

// The cited excerpts of one repository at its pinned commit, or of the local project (no repository).
export interface StackSupport {
  repository?: string;
  commitSha?: string;
  files: StackFile[];
}

export interface StackLayer {
  kind: "module" | "data";
  name: string;
  description: string;
  support: StackSupport[];
  newDesignReason?: string;
}

// The plan's bricks from the bottom up: the data model's entities, then the modules in the plan's order. A brick lists
// only excerpts the host cut, grouped by the repository and commit the host read them from.
export function stackLayers(plan: PlanDocument, evidence: { sources: EvidenceSource[]; excerpts: EvidenceExcerpt[] }): StackLayer[] {
  const sourceById = new Map(evidence.sources.map((source) => [source.id, source]));
  const excerptById = new Map(evidence.excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const support = (refs: EvidenceRef[]): StackSupport[] => {
    const groups = new Map<string, StackSupport>();
    for (const ref of refs) {
      const excerpt = excerptById.get(ref.excerptId);
      const source = excerpt ? sourceById.get(excerpt.sourceId) : undefined;
      if (!excerpt || !source) continue;
      const key = source.kind === "remote" ? `${source.provider}:${source.repository}@${source.commitSha}` : "local";
      const group = groups.get(key) ?? (source.kind === "remote" ? { repository: source.repository!, commitSha: source.commitSha!, files: [] } : { files: [] });
      group.files.push({
        excerptId: excerpt.id,
        sourceId: source.id,
        path: source.path,
        startLine: excerpt.startLine,
        endLine: excerpt.endLine,
        ...(source.permalink ? { url: sourceLocation(source, excerpt.startLine, excerpt.endLine) } : {}),
        snapshotPath: source.snapshotPath,
        claim: ref.claim,
      });
      groups.set(key, group);
    }
    return [...groups.values()];
  };
  const reason = (value: string | undefined): { newDesignReason?: string } => (value ? { newDesignReason: value } : {});
  return [
    ...plan.design.dataModel.entities.map((entity): StackLayer => ({ kind: "data", name: entity.name, description: entity.fields.join(", "), support: support(entity.evidence), ...reason(entity.newDesignReason) })),
    ...plan.design.modules.map((module): StackLayer => ({ kind: "module", name: module.name, description: module.responsibility, support: support(module.evidence), ...reason(module.newDesignReason) })),
  ];
}

// The 2x4 brick of the logo (docs/images/logo.mjs): isometric 30 degrees, 1.2 pitches high, studs drawn back to front.
// `step` is how far a brick sits above the one below it, and `labelY` the height of the middle of its right face.
export function brickDrawing(pitch: number): { paths: Array<{ kind: "edge" | "mid" | "mid open"; d: string }>; viewBox: string; width: number; height: number; step: number; labelY: number } {
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  const [width, depth, height, studRadius, studHeight] = [4, 2, 1.2, 0.3, 0.2];
  const project = (x: number, y: number, z: number): [number, number] => [(x - y) * cos * pitch, (x + y) * sin * pitch - z * pitch];
  const f = (value: number): string => Number(value.toFixed(2)).toString();
  const paths: Array<{ kind: "edge" | "mid" | "mid open"; d: string }> = [];
  const points: Array<[number, number]> = [];
  const face = (corners: Array<[number, number, number]>, kind: "edge" | "mid"): void => {
    const projected = corners.map((corner) => project(...corner));
    points.push(...projected);
    paths.push({ kind, d: `M${projected.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L")} Z` });
  };
  face([[width, 0, 0], [width, depth, 0], [width, depth, height], [width, 0, height]], "edge");
  face([[0, depth, 0], [width, depth, 0], [width, depth, height], [0, depth, height]], "edge");
  face([[0, 0, height], [width, 0, height], [width, depth, height], [0, depth, height]], "mid");
  const rx = Math.SQRT2 * studRadius * cos * pitch;
  const ry = Math.SQRT2 * studRadius * sin * pitch;
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < width; i += 1) for (let j = 0; j < depth; j += 1) cells.push([i + 0.5, j + 0.5]);
  cells.sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  for (const [cx, cy] of cells) {
    const [x, top] = project(cx, cy, height + studHeight);
    const bottom = top + studHeight * pitch;
    points.push([x - rx, top - ry], [x + rx, bottom + ry]);
    paths.push({ kind: "edge", d: `M${f(x - rx)} ${f(top)} A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(top)} L${f(x + rx)} ${f(bottom)} A${f(rx)} ${f(ry)} 0 0 1 ${f(x - rx)} ${f(bottom)} Z` });
    paths.push({ kind: "mid open", d: `M${f(x - rx)} ${f(top)} A${f(rx)} ${f(ry)} 0 0 0 ${f(x + rx)} ${f(top)}` });
  }
  const pad = 1.5;
  const minX = Math.min(...points.map(([x]) => x)) - pad;
  const minY = Math.min(...points.map(([, y]) => y)) - pad;
  const boxWidth = Math.max(...points.map(([x]) => x)) - minX + pad;
  const boxHeight = Math.max(...points.map(([, y]) => y)) - minY + pad;
  return {
    paths,
    viewBox: `${f(minX)} ${f(minY)} ${f(boxWidth)} ${f(boxHeight)}`,
    width: boxWidth,
    height: boxHeight,
    step: height * pitch,
    labelY: project(width, depth / 2, height / 2)[1] - minY,
  };
}
