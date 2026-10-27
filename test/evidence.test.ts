import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { EXCERPT_BUDGET, addRequestedEvidence, loadSelectedEvidence, type LoadedEvidence } from "../src/evidence.ts";
import type { GitHubResearcher } from "../src/github.ts";
import { extractExistingCommands, LocalReadError, type LocalIndex } from "../src/local.ts";
import { ProviderRequestError } from "../src/request-failure.ts";
import type { EvidenceRequest, RepositorySnapshot, TreeFile } from "../src/types.ts";

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

// A last line longer than any share keeps a remote file from being excerpted whole.
function tooLong(lines: string[]): string {
  return `${lines.join("\n")}\n${"z".repeat(260_000)}\n`;
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

  test("sends and hashes only the redacted text of a local source that held a credential", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-redact-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "client.ts"), 'export const apiKey = "plainCredentialValue123456";\nexport function send() { return apiKey; }\n');
      const local: LocalIndex = { root, files: [{ id: "L1", path: "src/client.ts", size: 90 }], gaps: [] };
      const { fake } = researcher();

      const evidence = await loadSelectedEvidence({
        local,
        repositories: [],
        modelSelection: [{ fileId: "L1", role: "production", rationale: "API client" }],
        github: fake,
        relevantText: "send",
      });

      const redacted = 'export const apiKey = "[redacted by unshit]";\nexport function send() { return apiKey; }\n';
      expect(evidence.sources.find((source) => source.path === "src/client.ts")?.sha256).toBe(createHash("sha256").update(redacted).digest("hex"));
      expect(evidence.excerpts.map((excerpt) => excerpt.text).join("\n")).not.toContain("plainCredentialValue123456");
      expect(evidence.gaps).toContainEqual({
        kind: "local",
        material: false,
        message: "Replaced 1 likely secret value(s) in src/client.ts with [redacted by unshit] before any model turn; the saved snapshot and its SHA-256 cover the redacted text.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps every part of a quoted credential out of excerpts and snapshots and keeps package scripts readable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-redact-"));
    try {
      const manifest = '{\n  "scripts": {\n    "test": "bun test"\n  },\n  "token": "MARKER_VALUE_0123456789\\"MARKER_TAIL_0123456789"\n}\n';
      await writeFile(path.join(root, "package.json"), manifest);
      const local: LocalIndex = { root, files: [{ id: "L1", path: "package.json", size: manifest.length }], gaps: [] };
      const { fake } = researcher();

      const evidence = await loadSelectedEvidence({ local, repositories: [], modelSelection: [], github: fake, relevantText: "test" });

      const source = evidence.sources.find((entry) => entry.path === "package.json")!;
      const bytes = evidence.bytesBySourceId.get(source.id)!;
      expect(new TextDecoder().decode(bytes)).not.toContain("MARKER_TAIL");
      expect(evidence.excerpts.map((excerpt) => excerpt.text).join("\n")).not.toContain("MARKER_TAIL");
      expect(extractExistingCommands([{ id: source.id, path: "package.json", bytes }]).map((command) => command.command)).toEqual(["bun run test"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a redacted package.json valid when an assignment sits inside another JSON string", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-redact-"));
    try {
      const manifest = '{\r\n  "description": "token=\'MARKER_VALUE_0123456789",\r\n  "token": "token=\'",\r\n  "scripts": {\r\n    "test": "bun test"\r\n  }\r\n}\r\n';
      await writeFile(path.join(root, "package.json"), manifest);
      const local: LocalIndex = { root, files: [{ id: "L1", path: "package.json", size: manifest.length }], gaps: [] };
      const { fake } = researcher();

      const evidence = await loadSelectedEvidence({ local, repositories: [], modelSelection: [], github: fake, relevantText: "test" });

      const source = evidence.sources.find((entry) => entry.path === "package.json")!;
      const bytes = evidence.bytesBySourceId.get(source.id)!;
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ description: "token='[redacted by unshit]", token: "token='", scripts: { test: "bun test" } });
      expect(evidence.excerpts.map((excerpt) => excerpt.text).join("\n")).not.toContain("MARKER_VALUE");
      expect(extractExistingCommands([{ id: source.id, path: "package.json", bytes }]).map((command) => command.command)).toEqual(["bun run test"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records a material gap and no snapshot for JSON whose member name holds a credential-like value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-redact-"));
    try {
      const manifest = '{\n  "token=\'MARKER_VALUE_0123456789": 1,\n  "scripts": {\n    "test": "bun test"\n  }\n}\n';
      await writeFile(path.join(root, "package.json"), manifest);
      const local: LocalIndex = { root, files: [{ id: "L1", path: "package.json", size: manifest.length }], gaps: [] };
      const { fake } = researcher();

      const evidence = await loadSelectedEvidence({ local, repositories: [], modelSelection: [], github: fake, relevantText: "test" });

      expect(evidence.sources.map((source) => source.path)).not.toContain("package.json");
      expect(evidence.bytesBySourceId.size).toBe(0);
      expect(evidence.gaps).toContainEqual({ kind: "local", message: "Could not read package.json; source was excluded because a JSON member name holds a credential-like value.", material: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("reads the standard root license file when an ancillary LICENSE-<suffix> file sorts first", async () => {
    const paths = ["src/index.ts", "tests/index.test.ts", "LICENSE-adaic.org.txt", "LICENSE.txt", "package.json"];
    const files: TreeFile[] = paths.map((filePath, index) => ({ id: `C1L${index + 1}`, path: filePath, size: 20 }));
    const { fake, fetched } = researcher();

    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [{ ...repository(), files }],
      modelSelection: [],
      github: fake,
      relevantText: "refund request",
    });

    expect(fetched).toContain("LICENSE.txt");
    expect(fetched).not.toContain("LICENSE-adaic.org.txt");
    expect(evidence.sources.find((source) => source.path === "LICENSE.txt")?.roles).toEqual(["license"]);
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
    const { fake } = researcher({ content: new Map([["src/index.ts", tooLong(lines)]]) });
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repository()],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText: "unrelated words only",
      codePatterns: ["OrderRefund"],
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

  // A reference test citation is valid only for a source with role test, so the model's role alone must not give a
  // production file that role.
  test("gives role test only to a file whose path is a test path, whatever role the model chose", async () => {
    const { fake } = researcher();
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repository()],
      modelSelection: [{ fileId: "C1F1", role: "test", rationale: "The model calls the handler a test." }],
      github: fake,
      relevantText: "refund",
    });

    expect(evidence.sources.find((source) => source.path === "src/index.ts")?.roles).toEqual(["production"]);
    expect(evidence.sources.filter((source) => source.roles.includes("test")).map((source) => source.path)).toEqual(["tests/index.test.ts"]);
  });

  // src/index.ts is the first of six planned files, so its share is 260,000 / 6 = 43,333 characters.
  async function excerptRangesFor(content: string, relevantText: string, patterns: string[]): Promise<number[][]> {
    const { fake } = researcher({ content: new Map([["src/index.ts", content]]) });
    const evidence = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repository()],
      modelSelection: [{ fileId: "C1F1", role: "production", rationale: "entry point" }],
      github: fake,
      relevantText,
      codePatterns: patterns,
    });
    const source = evidence.sources.find((entry) => entry.path === "src/index.ts")!;
    return evidence.excerpts.filter((excerpt) => excerpt.sourceId === source.id).map((excerpt) => [excerpt.startLine, excerpt.endLine]);
  }

  test("keeps a file whole when it fits its share, and otherwise a 30-line head and the complete definition around a match", async () => {
    const fits = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    expect(await excerptRangesFor(`${fits.join("\n")}\n`, "unrelated words only", [])).toEqual([[1, 400]]);

    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[249] = "export function approveRefund(order: Order) {";
    for (let index = 250; index < 279; index += 1) lines[index] = `  const step${index} = ${index};`;
    lines[264] = "  return OrderRefund.approve(order);";
    lines[279] = "}";

    expect(await excerptRangesFor(tooLong(lines), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [250, 280]]);

    // A region that starts right after the head stays a separate range.
    const nearHead = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    nearHead[30] = "export function nearHead() {";
    for (let index = 31; index < 39; index += 1) nearHead[index] = `  step(${index});`;
    nearHead[34] = "  OrderRefund.approve();";
    nearHead[39] = "}";
    expect(await excerptRangesFor(tooLong(nearHead), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [31, 40]]);
  });

  test("treats a one-line arrow function as a definition", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[249] = "export const approveOne = () => { return OrderRefund.ok(); };";
    lines[299] = "export const approveTwo = (order: Order) => OrderRefund.check(order);";
    // A parameter list without inner parentheses may hold quotes.
    lines[389] = 'export const approveFive = (label = "refund") => OrderRefund.label(label);';

    expect(await excerptRangesFor(tooLong(lines), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [250, 250], [300, 300], [390, 390]]);
  });

  test("does not treat a declaration as a definition when a string or a comment in it holds parentheses and an arrow", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[249] = 'const label = ("() ) => OrderRefund");';
    lines[299] = "const total = (/*() ) => */ OrderRefund.total);";
    lines[349] = "const value /* = (order = f()) => OrderRefund */ = 1;";
    lines[379] = 'const { "x = (order = f()) => OrderRefund": key } = object;';

    expect(await excerptRangesFor(tooLong(lines), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [230, 389]]);
  });

  test("handles 99,000-character lines whose return type holds an equals sign in under a second", async () => {
    // Such a return type is not recognized. Each line is still tested as a possible definition start.
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    const spaces = " ".repeat(99_000);
    lines[249] = `const approveOne = (order: Order):${spaces}{ "x=y": number } => OrderRefund.check(order);`;
    lines[299] = `const approveTwo = (order = makeOrder()):${spaces}{ "x=y": number } => OrderRefund.check(order);`;
    const started = performance.now();

    const ranges = await excerptRangesFor(tooLong(lines), "unrelated words only", ["OrderRefund"]);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(ranges).toEqual([[1, 30]]);
  });

  test("ends a Python function by indentation, not by a dict in its body", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `filler_${index} = ${index}`);
    lines[199] = "def approve_refund(order):";
    for (let index = 200; index < 239; index += 1) lines[index] = `    step(${index})`;
    lines[200] = "    state = {}";
    lines[220] = "    OrderRefund.approve(order)";
    lines[238] = "    return state";

    expect(await excerptRangesFor(tooLong(lines), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [200, 239]]);
  });

  test("excerpts a file that exactly fills its share", async () => {
    const evidenceOf = async (content: string) => {
      const repo: RepositorySnapshot = { ...repository(), files: [{ id: "C1F1", path: "src/index.ts", size: content.length }], codeMatches: [] };
      return loadSelectedEvidence({
        local: { root: "/nonexistent-unshit-local", files: [], gaps: [] },
        repositories: [repo],
        modelSelection: [{ fileId: "C1F1", role: "production", rationale: "The only file." }],
        github: researcher({ content: new Map([["src/index.ts", content]]) }).fake,
        relevantText: "unrelated words only",
      });
    };
    const excerptOf = async (content: string) => (await evidenceOf(content)).excerpts.map((excerpt) => [excerpt.startLine, excerpt.endLine, excerpt.text.length]);
    // With one planned file, the file's share is the whole 260,000-character budget.
    expect(await excerptOf("x".repeat(260_000))).toEqual([[1, 1, 260_000]]);
    expect(await excerptOf(`${"x".repeat(260_000)}\n`)).toEqual([[1, 1, 260_000]]);
    expect(await excerptOf(`${"a".repeat(129_999)}\n${"b".repeat(130_000)}`)).toEqual([[1, 2, 260_000]]);
    expect(await excerptOf("x".repeat(260_001))).toEqual([]);
    expect((await evidenceOf("x".repeat(260_001))).gaps.map((gap) => gap.message)).toContain("No excerpt context remained for src/index.ts.");
    // A head that does not fit is cut from its end.
    expect(await excerptOf(Array.from({ length: 40 }, () => "x".repeat(10_000)).join("\n"))).toEqual([[1, 25, 250_024]]);
    // 40 lines that join to exactly 260,000 characters stay whole; one more character leaves the 30-line head.
    const forty = (last: number) => [...Array.from({ length: 39 }, () => "x".repeat(6_499)), "y".repeat(last)].join("\n");
    expect(await excerptOf(forty(6_500))).toEqual([[1, 40, 260_000]]);
    expect(await excerptOf(forty(6_501))).toEqual([[1, 30, 194_999]]);
  });

  test("keeps the first excerpts within a smaller budget when one is given", async () => {
    // 40 lines that join to 224,999 characters: whole within the default budget, not within 220,000.
    const content = Array.from({ length: 40 }, () => "x".repeat(5_624)).join("\n");
    const excerptsWithin = async (excerptBudget?: number) => {
      const evidence = await loadSelectedEvidence({
        local: { root: "/nonexistent-unshit-local", files: [], gaps: [] },
        repositories: [{ ...repository(), files: [{ id: "C1F1", path: "src/index.ts", size: content.length }] }],
        modelSelection: [{ fileId: "C1F1", role: "production", rationale: "The only file." }],
        github: researcher({ content: new Map([["src/index.ts", content]]) }).fake,
        relevantText: "unrelated words only",
        ...(excerptBudget === undefined ? {} : { excerptBudget }),
      });
      return evidence.excerpts.map((excerpt) => [excerpt.startLine, excerpt.endLine]);
    };

    expect(await excerptsWithin()).toEqual([[1, 40]]);
    expect(await excerptsWithin(220_000)).toEqual([[1, 30]]);
  });

  test("keeps the definition that holds the match, not one that ended above it", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[199] = "export function outerFlow() {";
    lines[200] = "  const helper = () => {";
    lines[201] = "    prepare();";
    lines[202] = "  };";
    lines[203] = "  if (ready) {";
    lines[204] = "    OrderRefund.approve();";
    lines[205] = "  }";
    for (let index = 206; index < 239; index += 1) lines[index] = `  step(${index});`;
    lines[239] = "}";

    expect(await excerptRangesFor(tooLong(lines), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [200, 240]]);

    // In these fixtures, a variable whose value is a function is a definition; a callback passed to a call is not.
    const inArrow = [...lines];
    inArrow[201] = "    OrderRefund.prepare();";
    inArrow[204] = "    approve();";
    expect(await excerptRangesFor(tooLong(inArrow), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [201, 203]]);

    const inCallback = [...lines];
    inCallback[200] = "  const results = items.map((item) => {";
    inCallback[201] = "    return OrderRefund.check(item);";
    inCallback[202] = "  });";
    inCallback[204] = "    approve();";
    expect(await excerptRangesFor(tooLong(inCallback), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [200, 240]]);
  });

  test("takes the best-scoring matches first and stops at the first match that no window fits", async () => {
    const lines = Array.from({ length: 800 }, (_, index) => `const filler${index} = "${"x".repeat(80)}";`);
    // Each definition is 40 lines of about 11,500 characters; the 43,333-character share holds the head and three.
    const define = (line: number, name: string) => {
      lines[line - 1] = `export function ${name}() {`;
      for (let index = line; index < line + 38; index += 1) lines[index] = `  step("${"y".repeat(290)}");`;
      lines[line + 38] = "}";
    };
    for (const line of [200, 300, 400, 500, 600]) define(line, `AnchorToken${line}`);
    define(700, "AnchorTokenRefundApproval");
    lines[749] = "export function refundHelper() { return 1; }";
    const ranges = await excerptRangesFor(tooLong(lines), "refund approval", ["AnchorToken"]);
    const covers = (line: number) => ranges.some(([start, end]) => start! <= line && end! >= line);

    expect([200, 300, 700].every(covers)).toBe(true);
    // The match at line 400 fits no window, so the one-line definition at line 750 is not taken either.
    expect([400, 500, 600, 750].some(covers)).toBe(false);
    expect(ranges).toEqual([[1, 30], [200, 239], [300, 339], [700, 739]]);
  });

  test("keeps a long definition whole when it fits, and else 150 or 60 lines of it around the match", async () => {
    const flow = (bodyLine: (index: number) => string) => {
      const lines = Array.from({ length: 700 }, (_, index) => `const filler${index} = ${index};`);
      lines[99] = "export function longRefundFlow() {";
      for (let index = 100; index < 599; index += 1) lines[index] = bodyLine(index);
      lines[399] = "  OrderRefund.approve();";
      lines[599] = "}";
      return tooLong(lines);
    };

    expect(await excerptRangesFor(flow((index) => `  step(${index});`), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [100, 600]]);
    expect(await excerptRangesFor(flow(() => `  step("${"y".repeat(240)}");`), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [350, 499]]);
    expect(await excerptRangesFor(flow(() => `  step("${"y".repeat(600)}");`), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [380, 439]]);
  });

  test("keeps 60 lines around a match that no definition holds", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `step(${index});`);
    lines[249] = "function setup() {";
    lines[250] = "  prepare();";
    lines[251] = "}";
    lines[299] = "OrderRefund.approve();";

    expect(await excerptRangesFor(tooLong(lines), "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [280, 339]]);

    // A window that starts inside the head merges with it.
    const nearHead = [...lines];
    nearHead[34] = "OrderRefund.approve();";
    nearHead[299] = "step(299);";
    expect(await excerptRangesFor(tooLong(nearHead), "unrelated words only", ["OrderRefund"])).toEqual([[1, 74]]);
  });

  test("chooses a definition of a code-search pattern before its mentions", async () => {
    // Lines of about 700 characters: the share holds the head and the one-line definition, not 60 lines around a mention.
    const lines = Array.from({ length: 400 }, (_, index) => `step(${index}, "${"x".repeat(690)}");`);
    for (const line of [60, 100, 140, 180, 220]) lines[line - 1] = "use(OrderRefund);";
    lines[349] = "export class OrderRefund { approve() { return true; } }";

    expect(await excerptRangesFor(`${lines.join("\n")}\n`, "unrelated words only", ["OrderRefund"])).toEqual([[1, 30], [350, 350]]);
  });

  test("gives every selected file an equal share of the excerpt budget", async () => {
    const sourcePaths = Array.from({ length: 19 }, (_, index) => `src/anchor-${index}.ts`);
    const budgetFiles: TreeFile[] = [
      ...sourcePaths.map((filePath, index) => ({ id: `C1B${index + 1}`, path: filePath, size: 130_000 })),
      { id: "C1BT", path: "tests/anchor.test.ts", size: 130_000 },
      { id: "C1BM", path: "package.json", size: 20 },
      { id: "C1BL", path: "LICENSE", size: 20 },
      { id: "C1BC", path: ".github/workflows/check.yml", size: 20 },
      { id: "C1BG", path: "vitest.config.ts", size: 20 },
    ];
    const budgetRepo: RepositorySnapshot = { ...repository(), files: budgetFiles };
    // Every file wants about 22,000 characters: a 30-line head and four 20-line anchor definitions. An equal share
    // of about 10,800 characters holds the head and one definition.
    const largeContent = (index: number): string => {
      const longLines = Array.from({ length: 600 }, (_, line) => `const filler${line} = "${"x".repeat(180)}";`);
      for (const start of [200, 300, 400, 500]) {
        longLines[start - 1] = `export function AnchorToken${index}Part${start}() {`;
        for (let line = start; line < start + 18; line += 1) longLines[line] = `  return "${"x".repeat(190)}";`;
        longLines[start + 18] = "}";
      }
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
      codePatterns: ["AnchorToken"],
    });
    const excerptCharacters = budgetEvidence.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
    const anchorSources = budgetEvidence.sources.filter((source) => [...sourcePaths, "tests/anchor.test.ts"].includes(source.path));

    expect(budgetReader.fetched).toHaveLength(24);
    expect(anchorSources).toHaveLength(20);
    for (const source of anchorSources) {
      expect(budgetEvidence.excerpts.some((excerpt) => excerpt.sourceId === source.id && excerpt.startLine <= 200 && excerpt.endLine >= 200)).toBe(true);
    }
    expect(excerptCharacters).toBeLessThanOrEqual(260_000);
  });
  test("ranks lines that hold a code pattern first in local files too", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-local-anchor-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      // Two selected files of about 160,000 characters each: the first one's share is half the budget, so it is not
      // kept whole. Short lines keep the local credential scan fast.
      const lines = Array.from({ length: 300 }, (_, index) => `const localFiller${index} = ${index};`);
      lines[199] = "export class OrderRefund { approve() { return true; } }";
      const ballast = Array.from({ length: 1_500 }, () => "z".repeat(100)).join("\n");
      await writeFile(path.join(root, "src", "local.ts"), `${lines.join("\n")}\n${ballast}\n`);
      await writeFile(path.join(root, "src", "other.ts"), `export const other = 1;\n${ballast}\n`);
      const localFile: TreeFile = { id: "L-anchor", path: "src/local.ts", size: 160_000 };
      const otherFile: TreeFile = { id: "L-other", path: "src/other.ts", size: 160_000 };
      const local: LocalIndex = { root, files: [localFile, otherFile], gaps: [] };
      const evidence = await loadSelectedEvidence({
        local,
        repositories: [],
        modelSelection: [
          { fileId: localFile.id, role: "production", rationale: "Local entry point." },
          { fileId: otherFile.id, role: "production", rationale: "Local helper." },
        ],
        github: researcher().fake,
        relevantText: "unrelated words only",
        codePatterns: ["OrderRefund"],
      });
      const source = evidence.sources.find((entry) => entry.path === "src/local.ts")!;
      const ranges = evidence.excerpts.filter((excerpt) => excerpt.sourceId === source.id).map((excerpt) => [excerpt.startLine, excerpt.endLine]);

      expect(source.kind).toBe("local");
      expect(ranges).toEqual([[1, 30], [200, 200]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("requested evidence", () => {
  const request = (kind: EvidenceRequest["kind"], id: string, fields: Partial<EvidenceRequest> = {}): EvidenceRequest =>
    ({ kind, id, name: "", startLine: 0, endLine: 0, reason: "The plan needs it.", ...fields });

  // Evidence of one remote source S1 whose first `excerptLines` lines are excerpt E1.
  function oneSource(filePath: string, text: string, excerptLines = text.split("\n").length): LoadedEvidence {
    const lines = text.split("\n");
    return {
      sources: [{ id: "S1", kind: "remote", path: filePath, sha256: "0".repeat(64), lineCount: lines.length, byteCount: text.length, snapshotPath: "sources/S1.txt", roles: ["production"] }],
      excerpts: [{ id: "E1", sourceId: "S1", startLine: 1, endLine: excerptLines, text: lines.slice(0, excerptLines).join("\n") }],
      bytesBySourceId: new Map([["S1", new TextEncoder().encode(text)]]),
      textBySourceId: new Map([["S1", text]]),
      gaps: [],
    };
  }

  // One planned file, src/index.ts, from a tree of the given paths.
  async function firstRound(content: Map<string, string>, paths: string[]) {
    const repo: RepositorySnapshot = { ...repository(), files: paths.map((filePath, index) => ({ id: `C1R${index + 1}`, path: filePath, size: 100 })) };
    const reader = researcher({ content });
    const loaded = await loadSelectedEvidence({
      local: localIndex(),
      repositories: [repo],
      modelSelection: [{ fileId: "C1R1", role: "production", rationale: "entry point" }],
      github: reader.fake,
      relevantText: "unrelated words only",
    });
    return { loaded, repo, reader };
  }

  test("adds the definition and the lines that requests name, without the lines that excerpts already hold", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[99] = "const result = approveRefund(order);";
    lines[199] = "export function approveRefundLater() { return 1; }";
    lines[249] = "export function approveRefund(order: Order) {";
    for (let index = 250; index < 279; index += 1) lines[index] = `  const step${index} = ${index};`;
    lines[279] = "}";
    const { loaded } = await firstRound(new Map([["src/index.ts", tooLong(lines)]]), ["src/index.ts"]);
    const source = loaded.sources.find((entry) => entry.path === "src/index.ts")!;
    expect(loaded.excerpts.map((excerpt) => [excerpt.id, excerpt.startLine, excerpt.endLine])).toEqual([["E1", 1, 30]]);

    const result = await addRequestedEvidence(loaded, [
      // The definition line wins over the earlier call, and over approveRefundLater, which only starts with the name.
      request("definition", source.id, { name: "approveRefund" }),
      request("lines", source.id, { startLine: 20, endLine: 40 }),
      request("lines", source.id, { startLine: 1, endLine: 10 }),
      request("definition", source.id, { name: "missingName" }),
      request("lines", source.id, { startLine: 399, endLine: 402 }),
      request("definition", "S99", { name: "approveRefund" }),
    ], { local: localIndex(), repositories: [], unreadFileIds: new Set(), github: researcher().fake, relevantText: "unrelated words only" });

    expect(result.evidence.excerpts.map((excerpt) => [excerpt.id, excerpt.startLine, excerpt.endLine])).toEqual([["E1", 1, 30], ["E2", 250, 280], ["E3", 31, 40]]);
    expect(result.evidence.excerpts[1]!.text).toBe(lines.slice(249, 280).join("\n"));
    expect(result.evidence.excerpts[2]!.text).toBe(lines.slice(30, 40).join("\n"));
    expect([result.added, result.served]).toEqual([2, 3]);
    expect(result.gaps.map((gap) => [gap.material, gap.message])).toEqual([
      [false, `The model asked for missingName in ${source.id}; no line of src/index.ts holds missingName.`],
      [false, `The model asked for lines 399 to 402 of ${source.id}; src/index.ts has lines 1 to 401.`],
      [false, "The model asked for approveRefund in S99; no source has that ID."],
    ]);
  });

  test("reads at most six unread files that requests name, and only files from the unread list", async () => {
    const paths = ["src/index.ts", "src/extra-1.ts", "tests/extra-2.test.ts", "src/extra-3.ts", "src/extra-4.ts", "src/extra-5.ts", "src/extra-6.ts", "src/extra-7.ts", "src/extra-8.ts"];
    const repo: RepositorySnapshot = { ...repository(), files: paths.map((filePath, index) => ({ id: `C1R${index + 1}`, path: filePath, size: 100 })) };
    const reader = researcher();
    const loaded = oneSource("src/index.ts", "export const index = 1;");
    const extra = repo.files.slice(1);
    const result = await addRequestedEvidence(loaded, [request("file", "C1R1"), request("file", "C1R2"), ...extra.map((file) => request("file", file.id))], {
      local: localIndex(),
      repositories: [repo],
      unreadFileIds: new Set(extra.map((file) => file.id)),
      github: reader.fake,
      relevantText: "unrelated words only",
    });

    expect(result.evidence.sources.slice(1).map((source) => [source.id, source.path, source.kind, source.commitSha, source.roles])).toEqual([
      ["S2", "src/extra-1.ts", "remote", "a".repeat(40), ["production"]],
      ["S3", "tests/extra-2.test.ts", "remote", "a".repeat(40), ["test"]],
      ["S4", "src/extra-3.ts", "remote", "a".repeat(40), ["production"]],
      ["S5", "src/extra-4.ts", "remote", "a".repeat(40), ["production"]],
      ["S6", "src/extra-5.ts", "remote", "a".repeat(40), ["production"]],
      ["S7", "src/extra-6.ts", "remote", "a".repeat(40), ["production"]],
    ]);
    expect(result.evidence.excerpts.slice(1).map((excerpt) => [excerpt.id, excerpt.sourceId, excerpt.startLine, excerpt.endLine])).toEqual(
      [2, 3, 4, 5, 6, 7].map((number) => [`E${number}`, `S${number}`, 1, 1]),
    );
    expect(reader.fetched).toEqual(["src/extra-1.ts", "tests/extra-2.test.ts", "src/extra-3.ts", "src/extra-4.ts", "src/extra-5.ts", "src/extra-6.ts"]);
    expect(result.served).toBe(6);
    expect(result.gaps.map((gap) => gap.message)).toEqual([
      "The model asked for file C1R1; it is not in the unread file list.",
      // The second request for C1R2 comes after the first read it.
      "The model asked for file C1R2; it is not in the unread file list.",
      "The model asked for file C1R8; at most 6 unread files can be added.",
      "The model asked for file C1R9; at most 6 unread files can be added.",
    ]);
  });

  test("gives a requested file that is neither a test nor implementation source no production role", async () => {
    const repo: RepositorySnapshot = { ...repository(), files: [{ id: "C1D1", path: "docs/design.md", size: 100 }, { id: "C1D2", path: "src/extra.ts", size: 100 }] };
    const result = await addRequestedEvidence(oneSource("src/index.ts", "export const index = 1;"), [request("file", "C1D1"), request("file", "C1D2")], {
      local: localIndex(),
      repositories: [repo],
      unreadFileIds: new Set(["C1D1", "C1D2"]),
      github: researcher().fake,
      relevantText: "unrelated words only",
    });

    expect(result.evidence.sources.slice(1).map((source) => [source.path, source.roles])).toEqual([["docs/design.md", ["config"]], ["src/extra.ts", ["production"]]]);
  });

  test("gives the last file within the limit at most what is left, and records a file whose first line does not fit", async () => {
    // 10,881 characters are left for eight requested files, and at most six can be read. Each file of 7,999 characters
    // gets an equal share of what is left among the files still to read, counting no more files than the limit still
    // allows: the first three give the first 22 or 23 lines of their head; wide.ts is one line of 20,000 characters and
    // gives nothing; four.ts and five.ts give their whole 30-line heads; the last two requests are over the limit.
    const loaded = oneSource("src/flow.ts", Array.from({ length: 360 }, (_, index) => `const filler${String(index).padStart(3, "0")} = "${"x".repeat(670)}";`).join("\n"));
    const file = Array.from({ length: 100 }, (_, index) => `const line${String(index).padStart(3, "0")} = "${"w".repeat(60)}";`).join("\n");
    const paths = ["src/one.ts", "src/two.ts", "src/three.ts", "src/wide.ts", "src/four.ts", "src/five.ts", "src/six.ts", "src/seven.ts"];
    const repo: RepositorySnapshot = { ...repository(), files: paths.map((filePath, index) => ({ id: `C1W${index + 1}`, path: filePath, size: 100 })) };
    const content = new Map(paths.map((filePath) => [filePath, filePath === "src/wide.ts" ? "w".repeat(20_000) : file]));
    const result = await addRequestedEvidence(loaded, repo.files.map((entry) => request("file", entry.id)), {
      local: localIndex(),
      repositories: [repo],
      unreadFileIds: new Set(repo.files.map((entry) => entry.id)),
      github: researcher({ content }).fake,
      relevantText: "unrelated words only",
    });
    const used = result.evidence.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);

    expect(result.evidence.excerpts.slice(1).map((excerpt) => [excerpt.sourceId, excerpt.startLine, excerpt.endLine])).toEqual([["S2", 1, 22], ["S3", 1, 22], ["S4", 1, 23], ["S6", 1, 30], ["S7", 1, 30]]);
    expect(used).toBeLessThanOrEqual(EXCERPT_BUDGET);
    expect(result.served).toBe(5);
    expect(result.gaps.map((gap) => gap.message)).toEqual([
      "The model asked for file C1W4; no excerpt of src/wide.ts fit the 1841 characters of its share.",
      "The model asked for file C1W7; at most 6 unread files can be added.",
      "The model asked for file C1W8; at most 6 unread files can be added.",
    ]);
  });

  test("excerpts a requested file with the brief's code patterns", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index} = ${index};`);
    lines[199] = "export class OrderRefund { approve() { return true; } }";
    const repo: RepositorySnapshot = { ...repository(), files: [{ id: "C1U1", path: "src/refund.ts", size: 100 }] };
    const result = await addRequestedEvidence(oneSource("src/index.ts", "export const index = 1;"), [request("file", "C1U1")], {
      local: localIndex(),
      repositories: [repo],
      unreadFileIds: new Set(["C1U1"]),
      github: researcher({ content: new Map([["src/refund.ts", tooLong(lines)]]) }).fake,
      relevantText: "unrelated words only",
      codePatterns: ["OrderRefund"],
    });

    expect(result.evidence.excerpts.slice(1).map((excerpt) => [excerpt.sourceId, excerpt.startLine, excerpt.endLine])).toEqual([["S2", 1, 30], ["S2", 200, 200]]);
  });

  test("takes the first window that fits what is left of the budget and skips a request that does not fit", async () => {
    const lines = Array.from({ length: 360 }, (_, index) => `const filler${String(index).padStart(3, "0")} = "${"x".repeat(670)}";`);
    lines.push("export function smallHelper() {", "  return 1;", "}");
    lines.push("export function bigFlow() {", ...Array.from({ length: 298 }, (_, index) => `  step("${"y".repeat(50)}", ${index});`), "}");
    const loaded = oneSource("src/flow.ts", lines.join("\n"), 360);
    // About 10,900 characters are left: bigFlow (300 lines) does not fit whole, its first 150 lines do.
    const result = await addRequestedEvidence(loaded, [
      request("definition", "S1", { name: "smallHelper" }),
      request("definition", "S1", { name: "bigFlow" }),
      request("lines", "S1", { startLine: 600, endLine: 650 }),
    ], { local: localIndex(), repositories: [], unreadFileIds: new Set(), github: researcher().fake, relevantText: "unrelated words only" });
    const used = result.evidence.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);

    expect(result.evidence.excerpts.slice(1).map((excerpt) => [excerpt.startLine, excerpt.endLine])).toEqual([[361, 363], [364, 513]]);
    expect(used).toBeLessThanOrEqual(EXCERPT_BUDGET);
    expect(result.gaps.map((gap) => gap.message)).toEqual([`The model asked for lines 600 to 650 of S1; it does not fit the ${EXCERPT_BUDGET - used} characters left.`]);
  });

  test("gives each requested unread file an equal share of what is left", async () => {
    // 249,119 characters are used, so 10,881 are left. Two files of 7,999 characters: the first gets half of what is
    // left and only its head fits; the second gets all that is then left and fits whole.
    const loaded = oneSource("src/flow.ts", Array.from({ length: 360 }, (_, index) => `const filler${String(index).padStart(3, "0")} = "${"x".repeat(670)}";`).join("\n"));
    const file = Array.from({ length: 100 }, (_, index) => `const line${String(index).padStart(3, "0")} = "${"w".repeat(60)}";`).join("\n");
    const repo: RepositorySnapshot = { ...repository(), files: [{ id: "C1U1", path: "src/one.ts", size: 100 }, { id: "C1U2", path: "src/two.ts", size: 100 }] };
    const result = await addRequestedEvidence(loaded, [request("file", "C1U1"), request("file", "C1U2")], {
      local: localIndex(),
      repositories: [repo],
      unreadFileIds: new Set(["C1U1", "C1U2"]),
      github: researcher({ content: new Map([["src/one.ts", file], ["src/two.ts", file]]) }).fake,
      relevantText: "unrelated words only",
    });

    expect(result.evidence.excerpts.slice(1).map((excerpt) => [excerpt.sourceId, excerpt.startLine, excerpt.endLine])).toEqual([["S2", 1, 30], ["S3", 1, 100]]);
  });
});

describe("pinned source links", () => {
  test("links each remote source to its commit, not to its default branch", async () => {
    const github = repository();
    const gitlab: RepositorySnapshot = { ...repository("C2", "org/lab"), candidate: { ...repository("C2", "org/lab").candidate, provider: "gitlab", providerProjectId: "42", webUrl: "https://gitlab.com/org/lab" } };
    for (const [repo, expected] of [
      [github, `https://github.com/org/repo/blob/${"a".repeat(40)}/src/index.ts`],
      [gitlab, `https://gitlab.com/org/lab/-/blob/${"a".repeat(40)}/src/index.ts`],
    ] as const) {
      const evidence = await loadSelectedEvidence({
        local: localIndex(),
        repositories: [repo],
        modelSelection: [{ fileId: `${repo.candidate.id}F1`, role: "production", rationale: "entry point" }],
        github: researcher().fake,
        relevantText: "refund request status",
      });
      expect(evidence.sources.find((source) => source.path === "src/index.ts")?.permalink).toBe(expected);
    }
  });
});
