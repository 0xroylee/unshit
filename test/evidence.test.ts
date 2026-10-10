import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { loadSelectedEvidence } from "../src/evidence.ts";
import type { GitHubResearcher } from "../src/github.ts";
import type { LocalIndex } from "../src/local.ts";
import type { RepositorySnapshot, TreeFile } from "../src/types.ts";

function repository(id = "C1", fullName = "org/repo", includeTests = true): RepositorySnapshot {
  const paths = [
    "src/index.ts",
    ...(includeTests ? ["tests/index.test.ts"] : []),
    "package.json",
    "LICENSE",
    ".github/workflows/check.yml",
    "vitest.config.ts",
  ];
  const files: TreeFile[] = paths.map((path, index) => ({ id: `${id}F${index + 1}`, path, size: 20 }));
  return {
    candidate: { id, provider: "github", fullName, description: "", defaultBranch: "main", webUrl: `https://github.com/${fullName}` },
    commitSha: "a".repeat(40),
    treeTruncated: false,
    files,
  };
}

function localIndex(): LocalIndex {
  return { root: "/tmp/unshit-empty-target", files: [], gaps: [] };
}

function researcher(options: { failPaths?: Set<string> } = {}): { fake: GitHubResearcher; fetched: string[] } {
  const fetched: string[] = [];
  const fake = {
    fetchSource: async (_repo: RepositorySnapshot, filePath: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("aborted");
      fetched.push(filePath);
      if (options.failPaths?.has(filePath)) throw new Error("fixture outage");
      const content = new Map([
        ["src/index.ts", "export function makeRefund() { return { status: 'pending' }; }\n"],
        ["tests/index.test.ts", "import { test, expect } from 'vitest';\ntest('records a refund', () => expect(true).toBe(true));\n"],
        ["package.json", "{\n  \"scripts\": {\n    \"test\": \"vitest run\"\n  }\n}\n"],
        ["LICENSE", "MIT License\n"],
        [".github/workflows/check.yml", "name: checks\non: [push]\n"],
        ["vitest.config.ts", "export default { test: { environment: 'node' } };\n"],
      ]).get(filePath);
      return new TextEncoder().encode(content ?? `export const value = '${filePath}';\n`);
    },
  } as unknown as GitHubResearcher;
  return { fake, fetched };
}

describe("bounded source evidence", () => {
  test("reserves production, tests, manifest, license, CI, and test config from a selected comparator", async () => {
    const repo = repository();
    const { fake, fetched } = researcher();
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "refund request status",
    });
    expect(fetched).toContain("tests/index.test.ts");
    expect(fetched).toContain("vitest.config.ts");
    const production = evidence.sources.find((source) => source.path === "src/index.ts")!;
    expect(production.roles).toContain("production");
    expect(evidence.sources.find((source) => source.path === "tests/index.test.ts")?.roles).toContain("test");
    expect(evidence.sources.some((source) => source.roles.includes("manifest"))).toBe(true);
    expect(evidence.sources.some((source) => source.roles.includes("license"))).toBe(true);
    expect(evidence.sources.some((source) => source.roles.includes("ci"))).toBe(true);
    expect(evidence.sources.some((source) => source.roles.includes("config"))).toBe(true);
    expect(production.sha256).toBe(createHash("sha256").update("export function makeRefund() { return { status: 'pending' }; }\n").digest("hex"));
    expect(evidence.excerpts.every((excerpt) => excerpt.startLine >= 1 && excerpt.endLine >= excerpt.startLine)).toBe(true);
    expect(evidence.gaps.some((gap) => gap.material)).toBe(false);
  });

  test("keeps missing or unreadable comparator tests as material evidence gaps", async () => {
    const noTests = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repository("C1", "org/no-tests", false)],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: researcher().fake,
      relevantText: "refund",
    });
    expect(noTests.gaps.some((gap) => gap.material && gap.message.includes("No readable test source"))).toBe(true);

    const outage = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repository()],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: researcher({ failPaths: new Set(["tests/index.test.ts"]) }).fake,
      relevantText: "refund",
    });
    expect(outage.gaps.some((gap) => gap.material && gap.message.includes("tests/index.test.ts"))).toBe(true);
  });

  test("does not treat README, manifests, or CI files as comparator production code", async () => {
    const paths = ["README.md", "tests/index.test.ts", "package.json", "LICENSE", ".github/workflows/check.yml", "vitest.config.ts"];
    const files = paths.map((path, index) => ({ id: `C1F${index + 1}`, path, size: 100 }));
    const repo = { ...repository(), files };
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [
        { fileId: "C1F1", role: "production", rationale: "README is selected incorrectly." },
        { fileId: "C1F2", role: "test", rationale: "Test coverage." },
      ],
      github: researcher().fake,
      relevantText: "refund",
    });
    expect(evidence.gaps.some((gap) => gap.material && gap.message.includes("No readable production source"))).toBe(true);
    expect(evidence.sources.some((source) => source.roles.includes("production"))).toBe(false);
  });

  test("stays within the 24 remote-file cap while retaining core evidence per selected repository", async () => {
    const repositories = ["C1", "C2", "C3"].map((id) => {
      const base = repository(id, `org/${id.toLowerCase()}`);
      const extras = Array.from({ length: 12 }, (_, index) => ({ id: `${id}X${index}`, path: `src/extra${index}.ts`, size: 10 }));
      const testExtras = Array.from({ length: 12 }, (_, index) => ({ id: `${id}T${index}`, path: `tests/extra${index}.test.ts`, size: 10 }));
      return { ...base, files: [...base.files, ...extras, ...testExtras] };
    });
    const selected = repositories.flatMap((repo) => repo.files.filter((file) => file.path.startsWith("src/extra")).slice(0, 5).map((file) => ({ fileId: file.id, role: "production" as const, rationale: "sample" })));
    const evidence = await loadSelectedEvidence({ local: localIndex(), repositories, modelSelection: selected, github: researcher().fake, relevantText: "application" });
    expect(evidence.sources.filter((source) => source.kind === "remote").length).toBeLessThanOrEqual(24);
    for (const repo of repositories) {
      const sources = evidence.sources.filter((source) => source.repository === repo.candidate.fullName);
      expect(sources.some((source) => source.roles.includes("production"))).toBe(true);
      expect(sources.some((source) => source.roles.includes("test"))).toBe(true);
      expect(sources.some((source) => source.roles.includes("manifest"))).toBe(true);
      expect(sources.some((source) => source.roles.includes("license"))).toBe(true);
      expect(sources.some((source) => source.roles.includes("ci"))).toBe(true);
    }
  });
});
