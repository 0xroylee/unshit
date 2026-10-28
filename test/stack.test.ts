import { describe, expect, test } from "bun:test";
import { brickDrawing, stackLayers } from "../src/stack.ts";
import type { EvidenceExcerpt, EvidenceSource, PlanDocument } from "../src/types.ts";

const sha = "c".repeat(40);

function remote(id: string, repository: string, filePath: string, provider: "github" | "gitlab" = "github"): EvidenceSource {
  const host = provider === "gitlab" ? `https://gitlab.com/${repository}/-/blob/${sha}/${filePath}` : `https://github.com/${repository}/blob/${sha}/${filePath}`;
  return { id, kind: "remote", path: filePath, sha256: "a".repeat(64), lineCount: 40, byteCount: 400, provider, repository, commitSha: sha, permalink: host, snapshotPath: `sources/${id}.txt`, roles: ["production"] };
}

const sources: EvidenceSource[] = [
  remote("S1", "org/a", "src/a.ts"),
  remote("S2", "org/a", "src/b.ts"),
  remote("S3", "org/b", "lib/c.rb", "gitlab"),
  { id: "S4", kind: "local", path: "src/app.ts", sha256: "b".repeat(64), lineCount: 10, byteCount: 100, snapshotPath: "sources/S4.txt", roles: ["production"] },
];
const excerpts: EvidenceExcerpt[] = [
  { id: "E1", sourceId: "S1", startLine: 1, endLine: 5, text: "a" },
  { id: "E2", sourceId: "S2", startLine: 3, endLine: 9, text: "b" },
  { id: "E3", sourceId: "S3", startLine: 2, endLine: 4, text: "c" },
  { id: "E4", sourceId: "S4", startLine: 1, endLine: 2, text: "d" },
];

function plan(): PlanDocument {
  return {
    title: "Ticket plan",
    summary: "Sell tickets.",
    requirements: [],
    tasks: [],
    decisions: [],
    design: {
      architecture: "Two modules over one entity.",
      modules: [
        { name: "Checkout", responsibility: "Takes payment.", interfaces: [], evidence: [{ excerptId: "E1", claim: "a pays" }, { excerptId: "E4", claim: "local app" }, { excerptId: "E99", claim: "not cut by the host" }, { excerptId: "E2", claim: "b pays" }, { excerptId: "E3", claim: "c refunds" }] },
        { name: "Seat map", responsibility: "Shows seats.", interfaces: [], evidence: [], newDesignReason: "No reference draws seats." },
      ],
      dataModel: { entities: [{ name: "Ticket", fields: ["seat", "price"], evidence: [{ excerptId: "E3", claim: "c stores tickets" }] }] },
      invariants: { items: [] },
      accessControl: { boundaries: [] },
    },
    repositoryChoices: [],
    referenceComparisons: [],
    risks: [],
    readiness: "draft",
    readinessNotes: [],
  };
}

describe("stack layers", () => {
  test("puts the data model's entities at the bottom, then the modules in the plan's order", () => {
    expect(stackLayers(plan(), { sources, excerpts }).map((layer) => [layer.kind, layer.name])).toEqual([
      ["data", "Ticket"],
      ["module", "Checkout"],
      ["module", "Seat map"],
    ]);
  });

  test("groups a brick's citations by repository and commit, keeps local sources apart, and leaves out excerpts the host did not cut", () => {
    const checkout = stackLayers(plan(), { sources, excerpts })[1]!;
    expect(checkout.support).toEqual([
      {
        repository: "org/a",
        commitSha: sha,
        files: [
          { excerptId: "E1", sourceId: "S1", path: "src/a.ts", startLine: 1, endLine: 5, url: `https://github.com/org/a/blob/${sha}/src/a.ts#L1-L5`, snapshotPath: "sources/S1.txt", claim: "a pays" },
          { excerptId: "E2", sourceId: "S2", path: "src/b.ts", startLine: 3, endLine: 9, url: `https://github.com/org/a/blob/${sha}/src/b.ts#L3-L9`, snapshotPath: "sources/S2.txt", claim: "b pays" },
        ],
      },
      { files: [{ excerptId: "E4", sourceId: "S4", path: "src/app.ts", startLine: 1, endLine: 2, snapshotPath: "sources/S4.txt", claim: "local app" }] },
      { repository: "org/b", commitSha: sha, files: [{ excerptId: "E3", sourceId: "S3", path: "lib/c.rb", startLine: 2, endLine: 4, url: `https://gitlab.com/org/b/-/blob/${sha}/lib/c.rb#L2-4`, snapshotPath: "sources/S3.txt", claim: "c refunds" }] },
    ]);
    const ticket = stackLayers(plan(), { sources, excerpts })[0]!;
    expect(ticket.support[0]!.files[0]!.url).toBe(`https://gitlab.com/org/b/-/blob/${sha}/lib/c.rb#L2-4`);
    expect(stackLayers(plan(), { sources, excerpts })[2]).toEqual({ kind: "module", name: "Seat map", description: "Shows seats.", support: [], newDesignReason: "No reference draws seats." });
  });

  test("draws the logo's 2x4 brick: three faces and eight studs, one step of 1.2 pitches", () => {
    const brick = brickDrawing(20);
    expect(brick.paths.filter((path) => path.kind === "edge" || path.kind === "mid")).toHaveLength(3 + 8);
    expect(brick.paths.filter((path) => path.kind === "mid open")).toHaveLength(8);
    expect(brick.step).toBe(24);
    expect(brick.viewBox.split(" ").map(Number).slice(2)).toEqual([Number(brick.width.toFixed(2)), Number(brick.height.toFixed(2))]);
  });
});
