import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadSelectedEvidence } from "../src/evidence.ts";
import type { GitHubResearcher } from "../src/github.ts";
import { LocalReadError, type LocalIndex } from "../src/local.ts";
import { ProviderRequestError } from "../src/request-failure.ts";
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

function researcher(options: { failPaths?: Set<string>; failures?: Map<string, unknown>; content?: Map<string, string> } = {}): { fake: GitHubResearcher; fetched: string[] } {
  const fetched: string[] = [];
  const fake = {
    fetchSource: async (_repo: RepositorySnapshot, filePath: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("aborted");
      fetched.push(filePath);
      if (options.failures?.has(filePath)) throw options.failures.get(filePath);
      if (options.failPaths?.has(filePath)) throw new Error("fixture outage");
      const content = options.content?.get(filePath) ?? new Map([
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

function claimedLocalReadError(reason: unknown, marker: string): LocalReadError {
  const error = Object.create(LocalReadError.prototype) as LocalReadError;
  Object.defineProperties(error, {
    reason: { value: reason, enumerable: true },
    message: { value: marker, enumerable: true },
  });
  return error;
}

describe("bounded source evidence", () => {
  test("describes a typed provider request failure without adapter text", async () => {
    const failure = new ProviderRequestError({
      provider: "github",
      endpoint: "source",
      category: "http_status",
      status: 404,
      attempts: 2,
      retryRefused: false,
    });
    const { fake } = researcher({ failures: new Map([["src/index.ts", failure]]) });
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repository()],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "refund",
    });

    expect(evidence.gaps.find((gap) => gap.message.startsWith("Could not read src/index.ts"))?.message)
      .toBe("Could not read src/index.ts from org/repo; GitHub source request failed after one retry: HTTP 404.");
  });

  test("replaces plain provider and filesystem errors with fixed read-failure text", async () => {
    const sentinel = "SENTINEL_GITHUB_7f3b9d2a4c6e8f10";
    const { fake } = researcher({ failures: new Map([["src/index.ts", new Error(`adapter ${sentinel}`)]]) });
    const remote = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repository()],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "refund",
    });
    const remoteGap = remote.gaps.find((gap) => gap.message.startsWith("Could not read src/index.ts"))!;
    expect(remoteGap.message).toBe("Could not read src/index.ts from org/repo; the file could not be read.");
    for (let index = 0; index <= sentinel.length - 8; index += 1) {
      expect(remoteGap.message).not.toContain(sentinel.slice(index, index + 8));
    }

    const missingFile: TreeFile = { id: "L-missing", path: "src/missing.ts", size: 10 };
    const local = await loadSelectedEvidence({
      local: { root: path.join(os.tmpdir(), "unshit-evidence-missing-root"), files: [missingFile], gaps: [] },
      repositories: [],
      modelSelection: [{ fileId: missingFile.id, role: "production", rationale: "local entry point" }],
      github: researcher().fake,
      relevantText: "refund",
    });
    expect(local.gaps.find((gap) => gap.message.startsWith("Could not read src/missing.ts"))?.message)
      .toBe("Could not read src/missing.ts; the file could not be read.");
  });

  test("describes read failures from registered records, never from the thrown value", async () => {
    const marker = "MARKER_CHARLIE_6V3M8P2K";
    const localError = new LocalReadError("invalid_utf8");
    Object.defineProperty(localError, "reason", { get: () => marker });
    const forgedLocalError = claimedLocalReadError("invalid_utf8", marker);
    const statefulLocalError = Object.create(LocalReadError.prototype) as LocalReadError;
    let reasonReads = 0;
    Object.defineProperty(statefulLocalError, "reason", {
      get() {
        reasonReads += 1;
        return reasonReads === 1 ? "invalid_utf8" : marker;
      },
    });
    const providerError = new ProviderRequestError({
      provider: "github", endpoint: "source", category: "network", attempts: 2, retryRefused: false,
    });
    Object.defineProperty(providerError, "failure", { get: () => { throw new Error(marker); } });
    const cases: Array<{ value: unknown; expected: string }> = [
      { value: localError, expected: "the content is not valid UTF-8 text" },
      { value: forgedLocalError, expected: "the file could not be read" },
      { value: statefulLocalError, expected: "the file could not be read" },
      { value: providerError, expected: "GitHub source request failed after one retry: no response (network failure)" },
      { value: new Error(marker), expected: "the file could not be read" },
    ];

    for (const { value, expected } of cases) {
      const { fake, fetched } = researcher({ failures: new Map([["src/index.ts", value]]) });
      const evidence = await loadSelectedEvidence({
        local: localIndex(),
        repositories: [repository()],
        modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
        github: fake,
        relevantText: "refund",
      });
      const gap = evidence.gaps.find((entry) => entry.message.startsWith("Could not read src/index.ts"));

      expect(gap?.message).toBe(`Could not read src/index.ts from org/repo; ${expected}.`);
      expect(fetched).toContain("src/index.ts");
      for (let index = 0; index <= marker.length - 8; index += 1) {
        expect(JSON.stringify({ evidence, gap })).not.toContain(marker.slice(index, index + 8));
      }
    }
    expect(reasonReads).toBe(0);
  });

  test("reports the fixed local-file limit for a source above 256 KB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-evidence-local-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "large.ts"), "x".repeat(256_001));
      const file: TreeFile = { id: "L-large", path: "src/large.ts", size: 256_001 };
      const evidence = await loadSelectedEvidence({
        local: { root, files: [file], gaps: [] },
        repositories: [],
        modelSelection: [{ fileId: file.id, role: "production", rationale: "local entry point" }],
        github: researcher().fake,
        relevantText: "refund",
      });

      expect(evidence.gaps.find((gap) => gap.message.startsWith("Could not read src/large.ts"))?.message)
        .toBe("Could not read src/large.ts; source exceeded the 256 KB local-file limit.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("uses the shared domain ranking for automatic production, test, and license references", async () => {
    const paths = [
      "src/aaa-profile.ts",
      "src/ticket.ts",
      "tests/aaa-profile.test.ts",
      "tests/ticket.test.ts",
      "NOTICE",
      "LICENSE-MIT",
      "package.json",
    ];
    const files: TreeFile[] = paths.map((filePath, index) => ({ id: `C1R${index + 1}`, path: filePath, size: 20 }));
    const repo = { ...repository(), files };
    const { fake, fetched } = researcher();
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [],
      github: fake,
      relevantText: "ticket purchase",
      domainTerms: [{ term: "ticket", weight: 3 }],
    });
    expect(fetched).toContain("src/ticket.ts");
    expect(fetched).toContain("tests/ticket.test.ts");
    expect(fetched).not.toContain("src/aaa-profile.ts");
    expect(fetched).not.toContain("tests/aaa-profile.test.ts");
    expect(fetched).toContain("LICENSE-MIT");
    expect(fetched).not.toContain("NOTICE");
    expect(evidence.sources.find((source) => source.path === "src/ticket.ts")?.roles).toContain("production");
    expect(evidence.sources.find((source) => source.path === "tests/ticket.test.ts")?.roles).toContain("test");
  });

  test("prefers code-matched production and test files over the path ranking", async () => {
    const paths = ["src/aaa-ticket.ts", "src/refund_service.ts", "tests/aaa-ticket.test.ts", "tests/refund.test.ts", "LICENSE", "package.json"];
    const files: TreeFile[] = paths.map((filePath, index) => ({ id: `C1M${index + 1}`, path: filePath, size: 20 }));
    const repo: RepositorySnapshot = {
      ...repository(),
      files,
      codeMatches: [
        { fileId: "C1M2", path: "src/refund_service.ts", patterns: ["refund_amount"] },
        { fileId: "C1M4", path: "tests/refund.test.ts", patterns: ["RefundStatus"] },
      ],
    };
    const { fake, fetched } = researcher();
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [],
      github: fake,
      relevantText: "ticket purchase",
      domainTerms: [{ term: "ticket", weight: 3 }],
    });
    expect(fetched).toContain("src/refund_service.ts");
    expect(fetched).toContain("tests/refund.test.ts");
    expect(fetched).not.toContain("src/aaa-ticket.ts");
    expect(fetched).not.toContain("tests/aaa-ticket.test.ts");
    expect(evidence.sources.find((source) => source.path === "src/refund_service.ts")?.roles).toContain("production");
  });

  test("centers the second excerpt on the line that contains a code-search pattern", async () => {
    const lines = Array.from({ length: 300 }, (_, index) => `const filler${index} = ${index};`);
    lines[199] = "class OrderRefund { approve() { return true; } }";
    const repo: RepositorySnapshot = {
      ...repository(),
      codeMatches: [{ fileId: "C1F1", path: "src/index.ts", patterns: ["OrderRefund"] }],
    };
    const { fake } = researcher({ content: new Map([["src/index.ts", `${lines.join("\n")}\n`]]) });
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "unrelated words only",
    });
    const source = evidence.sources.find((entry) => entry.path === "src/index.ts")!;
    const ranges = evidence.excerpts.filter((excerpt) => excerpt.sourceId === source.id);
    expect(ranges.some((range) => range.startLine <= 200 && range.endLine >= 200)).toBe(true);
  });

  test("keeps the model's production pick ahead of a code match", async () => {
    const paths = ["src/chosen.ts", "src/matched.ts", "tests/index.test.ts", "LICENSE", "package.json"];
    const files: TreeFile[] = paths.map((filePath, index) => ({ id: `C1P${index + 1}`, path: filePath, size: 20 }));
    const repo: RepositorySnapshot = {
      ...repository(),
      files,
      codeMatches: [{ fileId: "C1P2", path: "src/matched.ts", patterns: ["OrderRefund"] }],
    };
    const { fake, fetched } = researcher();
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1P1", role: "production", rationale: "The model picked this handler." }],
      github: fake,
      relevantText: "refund",
    });
    expect(evidence.sources.find((source) => source.path === "src/chosen.ts")?.roles).toContain("production");
    expect(fetched).not.toContain("src/matched.ts");
  });

  test("keeps the model's test pick ahead of a code match", async () => {
    const paths = ["src/index.ts", "tests/model-picked.test.ts", "tests/code-matched.test.ts", "LICENSE", "package.json"];
    const files: TreeFile[] = paths.map((filePath, index) => ({ id: `C1TP${index + 1}`, path: filePath, size: 20 }));
    const repo: RepositorySnapshot = {
      ...repository(),
      files,
      codeMatches: [{ fileId: "C1TP3", path: "tests/code-matched.test.ts", patterns: ["OrderRefund"] }],
    };
    const { fake, fetched } = researcher();

    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1TP2", role: "test", rationale: "The model picked this important scenario." }],
      github: fake,
      relevantText: "refund",
    });

    expect(evidence.sources.find((source) => source.path === "tests/model-picked.test.ts")?.roles).toContain("test");
    expect(fetched).toContain("tests/model-picked.test.ts");
    expect(fetched).not.toContain("tests/code-matched.test.ts");
  });

  test("keeps two 90-line windows and the total excerpt budget around an anchor", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[299] = "export class OrderRefund { approve() { return true; } }";
    const repo: RepositorySnapshot = {
      ...repository(),
      codeMatches: [{ fileId: "C1F1", path: "src/index.ts", patterns: ["OrderRefund"] }],
    };
    const { fake } = researcher({ content: new Map([["src/index.ts", `${lines.join("\n")}\n`]]) });
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "unrelated words only",
    });
    const source = evidence.sources.find((entry) => entry.path === "src/index.ts")!;
    const ranges = evidence.excerpts.filter((excerpt) => excerpt.sourceId === source.id);

    expect(ranges.map((range) => [range.startLine, range.endLine])).toEqual([[1, 90], [270, 359]]);
    expect(ranges.filter((range) => range.startLine <= 300 && range.endLine >= 300)).toHaveLength(1);

    const sourcePaths = Array.from({ length: 19 }, (_, index) => `src/anchor-${index}.ts`);
    const budgetFiles: TreeFile[] = [
      ...sourcePaths.map((filePath, index) => ({ id: `C1B${index + 1}`, path: filePath, size: 70_000 })),
      { id: "C1BT", path: "tests/anchor.test.ts", size: 70_000 },
      { id: "C1BM", path: "package.json", size: 20 },
      { id: "C1BL", path: "LICENSE", size: 20 },
      { id: "C1BC", path: ".github/workflows/check.yml", size: 20 },
      { id: "C1BG", path: "vitest.config.ts", size: 20 },
    ];
    const budgetRepo: RepositorySnapshot = {
      ...repository(),
      files: budgetFiles,
      codeMatches: [
        ...sourcePaths.map((filePath, index) => ({ fileId: `C1B${index + 1}`, path: filePath, patterns: ["AnchorToken"] })),
        { fileId: "C1BT", path: "tests/anchor.test.ts", patterns: ["AnchorToken"] },
      ],
    };
    const largeContent = (index: number): string => {
      const longLines = Array.from({ length: 300 }, (_, line) => `const filler${line} = ${"x".repeat(180)};`);
      longLines[199] = `export const AnchorToken${index} = "${"x".repeat(180)}";`;
      return `${longLines.join("\n")}\n`;
    };
    const budgetContent = new Map<string, string>(sourcePaths.map((filePath, index) => [filePath, largeContent(index)]));
    budgetContent.set("tests/anchor.test.ts", largeContent(19));
    const budgetReader = researcher({ content: budgetContent });
    const modelSelection = [
      ...sourcePaths.map((filePath, index) => ({ fileId: `C1B${index + 1}`, role: "production" as const, rationale: `Selected source ${index}.` })),
      { fileId: "C1BT", role: "test" as const, rationale: "Selected code-matched test." },
    ];
    const budgetEvidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [budgetRepo],
      modelSelection,
      github: budgetReader.fake,
      relevantText: "unrelated words only",
    });
    const excerptCharacters = budgetEvidence.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);

    expect(budgetReader.fetched).toHaveLength(24);
    expect(excerptCharacters).toBeLessThanOrEqual(260_000);
  });

  test("centers the second excerpt on a definition line rather than an earlier mention", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[119] = "import { OrderRefund } from './models';";
    lines[299] = "export class OrderRefund { approve() { return true; } }";
    const repo: RepositorySnapshot = {
      ...repository(),
      codeMatches: [{ fileId: "C1F1", path: "src/index.ts", patterns: ["OrderRefund"] }],
    };
    const { fake } = researcher({ content: new Map([["src/index.ts", `${lines.join("\n")}\n`]]) });
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "unrelated words only",
    });
    const source = evidence.sources.find((entry) => entry.path === "src/index.ts")!;
    const ranges = evidence.excerpts.filter((excerpt) => excerpt.sourceId === source.id);
    expect(ranges.some((range) => range.startLine <= 300 && range.endLine >= 300)).toBe(true);
    expect(ranges.some((range) => range.startLine <= 120 && range.endLine >= 120)).toBe(false);
  });

  test("uses code-search anchors only for the matched file", async () => {
    const lines = Array.from({ length: 300 }, (_, index) => `const filler${index} = ${index};`);
    lines[199] = "class OrderRefund { approve() { return true; } }";
    const repo: RepositorySnapshot = {
      ...repository(),
      codeMatches: [{ fileId: "C1F2", path: "tests/index.test.ts", patterns: ["OrderRefund"] }],
    };
    const { fake } = researcher({ content: new Map([["src/index.ts", `${lines.join("\n")}\n`]]) });
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "unrelated words only",
    });
    const source = evidence.sources.find((entry) => entry.path === "src/index.ts")!;
    const ranges = evidence.excerpts.filter((excerpt) => excerpt.sourceId === source.id);
    expect(ranges.some((range) => range.startLine <= 200 && range.endLine >= 200)).toBe(false);
  });

  test("does not give remote anchors to local files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-local-anchor-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      const lines = Array.from({ length: 300 }, (_, index) => `const localFiller${index} = ${index};`);
      lines[199] = "export class OrderRefund { approve() { return true; } }";
      await writeFile(path.join(root, "src", "local.ts"), `${lines.join("\n")}\n`);
      const localFile: TreeFile = { id: "L-anchor", path: "src/local.ts", size: 100 };
      const local: LocalIndex = { root, files: [localFile], gaps: [] };
      const repo: RepositorySnapshot = {
        ...repository(),
        codeMatches: [{ fileId: "C1F2", path: "tests/index.test.ts", patterns: ["OrderRefund"] }],
      };
      const evidence = await loadSelectedEvidence({
        local,
        repositories: [repo],
        modelSelection: [{ fileId: localFile.id, role: "production", rationale: "Local entry point." }],
        github: researcher().fake,
        relevantText: "unrelated words only",
      });
      const source = evidence.sources.find((entry) => entry.path === "src/local.ts")!;
      const ranges = evidence.excerpts.filter((excerpt) => excerpt.sourceId === source.id);

      expect(source.kind).toBe("local");
      expect(ranges.some((range) => range.startLine <= 200 && range.endLine >= 200)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
