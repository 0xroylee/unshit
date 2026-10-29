import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { JsonRecord, ModelGateway, ModelSession, ModelTurnResult } from "../src/app-server.ts";
import { GitHubResearcher } from "../src/github.ts";
import { scanLocalTree } from "../src/local.ts";
import { ProviderRequestError } from "../src/request-failure.ts";
import { parseApprovedBrief, parseIntake } from "../src/model-schema.ts";
import { UNAPPROVED_BRIEF_NOTE, briefSha256, editableBrief } from "../src/brief-approval.ts";
import { DEFAULT_QUALITY_BAR } from "../src/repository-screening.ts";
import type { BriefApproval, CodeSearchSummary, IntakeBrief, ProgressEvent, RepositoryCandidate, RepositorySnapshot, ResearchGap, TreeFile } from "../src/types.ts";
import type { DomainMaterial } from "../src/repository-screening.ts";
import { REFERENCE_PLAN_MODULES, REFERENCE_POLICY_INPUTS } from "../src/instructions.ts";
import { renderReport } from "../src/report.ts";
import { writeCheckpointArtifacts, writePlanArtifacts } from "../src/storage.ts";
import { runWorkflow as runWorkflowWithGate, type WorkflowOptions } from "../src/workflow.ts";
import { createPreviewConfirmer, createRunWriters, exitCodeFor } from "../src/cli.ts";
import { createAgentProtocol } from "../src/agent-protocol.ts";
import { PREVIEW_DECLINED, PREVIEW_SAVE_FAILED, PREVIEW_SOURCES_FAILED, PREVIEW_UNAVAILABLE } from "../src/preview.ts";
import type { WorkflowPreview } from "../src/types.ts";

// Most tests here exercise the stages after the reference preview, so a person confirms it unless a test passes its
// own confirmPreview, or undefined.
function runWorkflow(options: WorkflowOptions) {
  return runWorkflowWithGate({ confirmPreview: async () => true, ...options });
}

function baseIntake(questions: Array<{ question: string; whyMaterial: string }> = []) {
  return {
    summary: "Build a small refund request service.",
    requirements: [{ description: "Record refund requests.", userWords: null, observableAcceptance: ["A request has an amount and status."] }],
    outOfScope: [],
    assumptions: [],
    materialQuestions: questions,
    researchQueries: ["refund request service"],
    domainTerms: ["refund request", "refund status"],
    topicSlugs: ["refunds"],
  };
}

function repositorySnapshot(): RepositorySnapshot {
  const paths = ["src/index.ts", "tests/index.test.ts", "package.json", "LICENSE", ".github/workflows/check.yml", "vitest.config.ts"];
  const files: TreeFile[] = paths.map((filePath, index) => ({ id: `C1F${index + 1}`, path: filePath, size: 100 }));
  return {
    candidate: {
      id: "C1",
      provider: "github",
      fullName: "org/refunds",
      description: "Refund request API",
      defaultBranch: "main",
      webUrl: "https://github.com/org/refunds",
      lastActivityAt: "2026-01-01T00:00:00Z",
    },
    commitSha: "a".repeat(40),
    commitDate: "2025-12-01T00:00:00Z",
    treeTruncated: false,
    files,
  };
}

function snapshotFor(candidate: RepositoryCandidate, treeTruncated = false): RepositorySnapshot {
  const base = repositorySnapshot();
  return {
    ...base,
    candidate,
    treeTruncated,
    files: base.files.map((file, index) => ({ ...file, id: `${candidate.id}F${index + 1}` })),
  };
}

// testExcerptId is the comparator test excerpt that the adopted pattern cites; with the default researcher it is the
// excerpt of tests/index.test.ts. With null the pattern gives an untested reason instead.
function validPlan(excerptId = "E1", testExcerptId: string | null = "E2"): Record<string, any> {
  return {
    title: "Refund request plan",
    summary: "Validate and record a refund request.",
    shouldDraft: false,
    draftReasons: [],
    design: {
      architecture: "A request module validates inputs and persists the request.",
      modules: [{ name: "Refund requests", responsibility: "Validate and record requests.", interfaces: ["POST /refund-requests"], evidence: [{ excerptId, claim: "The comparator uses an HTTP request handler." }], newDesignReason: null }],
      dataModel: { entities: [{ name: "RefundRequest", fields: ["amount", "status"], evidence: [{ excerptId, claim: "The comparator stores request state." }], newDesignReason: null }], notApplicableReason: null },
      invariants: { items: [{ statement: "Amounts must be positive.", evidence: [{ excerptId, claim: "The source validates the amount." }], newDesignReason: null }], notApplicableReason: null },
      accessControl: { boundaries: [{ boundary: "Refund approval", behavior: "Only an authorized actor can approve a refund.", evidence: [], newDesignReason: "Approval permissions are required by the brief and the target access policy must be designed." }], notApplicableReason: null },
    },
    tasks: [{
      id: "T1",
      title: "Record refund requests",
      description: "Validate request amounts and persist a pending request.",
      requirementIds: ["R1"],
      dependencies: [],
      acceptance: [{ requirementId: "R1", coversAcceptanceIds: ["A1"], condition: "A valid request is stored with a pending status." }],
      verification: [{
        kind: "manual",
        coversAcceptanceIds: ["A1"],
        description: "Submit a valid request and inspect the stored status.",
        commandId: null,
        plannedCommand: null,
        rejectsMutants: [{ acceptanceId: "A1", wrongImplementation: "The handler stores the request without a status.", observedFailure: "The stored request shows no pending status." }],
      }],
      evidence: [{ excerptId, claim: "The reference validates and stores refund requests." }],
    }],
    decisions: [],
    referenceComparisons: [{
      candidateId: "C1",
      adoptedPatterns: [{ pattern: "Represent requests with a state.", evidence: [{ excerptId, claim: "The reference has a request state." }], testEvidence: testExcerptId ? [{ excerptId: testExcerptId, claim: "The reference test creates a pending refund." }] : [], untestedReason: testExcerptId ? null : "No test of the comparator was read." }],
      rejectedPatterns: [{ pattern: "Process approval inline.", reason: "It couples request intake to approval handling.", evidence: [{ excerptId, claim: "The reference combines request and approval." }] }],
      localAdaptation: "Apply the target authorization and persistence rules.",
    }],
    risks: [],
  };
}

function noReferencesPlan() {
  const output = validPlan();
  output.design.modules[0]!.evidence = [];
  output.design.modules[0]!.newDesignReason = "The target is new and no source was readable.";
  output.design.dataModel.entities[0]!.evidence = [];
  output.design.dataModel.entities[0]!.newDesignReason = "A new request record is needed to satisfy the user brief.";
  output.design.invariants.items[0]!.evidence = [];
  output.design.invariants.items[0]!.newDesignReason = "Positive amounts are an explicit validation requirement.";
  output.design.accessControl.boundaries = [];
  output.design.accessControl.notApplicableReason = "The brief names no user roles or permission rules.";
  output.tasks[0]!.evidence = [];
  output.referenceComparisons = [];
  return output;
}

type TurnKind = "refined" | "intake" | "ranking" | "selection" | "files" | "requests" | "plan" | "review";

function turnKind(schema: JsonRecord): TurnKind {
  const properties = schema.properties as Record<string, unknown>;
  if ((properties.materialQuestions as { maxItems?: number } | undefined)?.maxItems === 0) return "refined";
  if ("requirements" in properties) return "intake";
  if ("ranked" in properties) return "ranking";
  if ("selected" in properties) return "selection";
  if ("files" in properties) return "files";
  if ("requests" in properties) return "requests";
  if ("tasks" in properties) return "plan";
  if ("findings" in properties) return "review";
  throw new Error("Unexpected model schema.");
}

function timedOutTurn(): ModelTurnResult {
  return { status: "timed_out", limit: "idle", limitMs: 600_000, message: "Codex reported no activity on the turn for 10 minutes." };
}

function gateway(options: {
  intake: unknown;
  refined?: unknown;
  plans?: unknown[];
  reviews?: unknown[];
  selection?: unknown;
  ranking?: unknown;
  fileSelection?: unknown;
  // The evidence request answer, or a function of the request prompt that returns it.
  evidenceRequests?: unknown;
  // Also gets the 0-based index of the session that the turn runs in.
  onPrompt?: (prompt: string, schema: JsonRecord, session: number) => void;
  // Returns a scripted turn result for the given turn kind and its 1-based occurrence, or undefined for the default.
  turnResult?: (kind: TurnKind, occurrence: number) => ModelTurnResult | undefined;
  // Like the native client after an unacknowledged interrupt: a session that timed out fails every later turn.
  disposeOnTimeout?: boolean;
}): ModelGateway {
  let sessions = 0;
  let planIndex = 0;
  let reviewIndex = 0;
  const occurrences = new Map<TurnKind, number>();
  return {
    createSession(): ModelSession {
      const sessionIndex = sessions++;
      let disposed = false;
      return {
        async turn(prompt: string, schema: JsonRecord): Promise<ModelTurnResult> {
          options.onPrompt?.(prompt, schema, sessionIndex);
          if (disposed) return { status: "failed", message: "Codex App Server session cannot be reused after connection termination." };
          const kind = turnKind(schema);
          const occurrence = (occurrences.get(kind) ?? 0) + 1;
          occurrences.set(kind, occurrence);
          const scripted = options.turnResult?.(kind, occurrence);
          if (scripted) {
            if (scripted.status === "timed_out" && options.disposeOnTimeout) disposed = true;
            return scripted;
          }
          let result: unknown;
          if (kind === "refined") result = options.refined ?? { ...(options.intake as Record<string, unknown>), materialQuestions: [] };
          else if (kind === "intake") result = options.intake;
          else if (kind === "ranking") result = options.ranking ?? { ranked: [] };
          else if (kind === "selection") result = options.selection ?? { selected: [{ candidateId: "C1", rationale: "The repository implements refund requests." }], rejected: [] };
          else if (kind === "files") result = options.fileSelection ?? { files: [{ fileId: "C1F1", role: "production", rationale: "Main request handler." }] };
          else if (kind === "requests") result = typeof options.evidenceRequests === "function" ? options.evidenceRequests(prompt) : options.evidenceRequests ?? { requests: [] };
          else if (kind === "plan") result = options.plans?.[planIndex++] ?? validPlan();
          else result = options.reviews?.[reviewIndex++] ?? { findings: [] };
          if (sessionIndex > 0 && kind === "review" && result === undefined) result = { findings: [] };
          return { status: "completed", text: JSON.stringify(result), threadId: `thread-${sessionIndex + 1}`, turnId: `turn-${planIndex + reviewIndex + 1}` };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

function researcher(options: {
  candidates?: RepositoryCandidate[];
  snapshots?: RepositorySnapshot[];
  failReads?: boolean;
  failPaths?: string[];
  // File contents by path, in place of the default contents.
  content?: Record<string, string>;
  sourceFailure?: unknown;
  sourceFailurePath?: string;
  discoveryExcluded?: Array<{ candidate: RepositoryCandidate; reasons: string[] }>;
  shortlistExcluded?: Array<{
    candidate: RepositoryCandidate;
    reasons: string[];
    resolution?: { commitSha: string; commitDate?: string; treeFileCount: number; testFileCount: number; licensePath?: string };
  }>;
  shortlistGaps?: Array<{ kind: "tree" | "search"; message: string; material: boolean }>;
  shortlistRateLimited?: boolean;
  shortlistCodeSearch?: CodeSearchSummary;
  discoveryCodeSearch?: CodeSearchSummary;
  discoveryGaps?: Array<{ kind: "search"; message: string; material: boolean }>;
  treeResolutionLimit?: number;
} = {}): { value: GitHubResearcher; searches: number; materials: DomainMaterial[]; shortlistPatterns: string[][]; shortlistInputs: string[][] } {
  let searches = 0;
  const materials: DomainMaterial[] = [];
  const shortlistPatterns: string[][] = [];
  const shortlistInputs: string[][] = [];
  const snapshots = options.snapshots ?? [repositorySnapshot()];
  const candidates = options.candidates ?? snapshots.map((snapshot) => snapshot.candidate);
  const content = new Map<string, string>([
    ["src/index.ts", "export function createRefund() { return { status: 'pending' }; }\n"],
    ["tests/index.test.ts", "test('creates refund', () => {});\n"],
    ["package.json", "{\n  \"scripts\": {\n    \"test\": \"bun test\"\n  }\n}\n"],
    ["LICENSE", "MIT License\n"],
    [".github/workflows/check.yml", "name: checks\non: [push]\n"],
    ["vitest.config.ts", "export default {};\n"],
    ...Object.entries(options.content ?? {}),
  ]);
  const value = {
    treeResolutionLimit: options.treeResolutionLimit ?? 8,
    async discover(material: DomainMaterial) {
      searches += 1;
      materials.push(material);
      return {
        candidates,
        excluded: options.discoveryExcluded ?? [],
        gaps: options.discoveryGaps ?? (candidates.length ? [] : [{ kind: "search", message: "Public source providers were unavailable.", material: true }]),
        research: {
          queries: [],
          searchRequests: { github: 0, gitlab: 0, budget: 9 },
          treeResolutions: 0,
          qualityBar: { ...DEFAULT_QUALITY_BAR },
          matched: candidates.length + (options.discoveryExcluded?.length ?? 0),
          passedMetadataBar: candidates.length,
          shortlisted: 0,
          selected: 0,
          excluded: options.discoveryExcluded?.length ?? 0,
          rateLimited: false,
          trustworthyReferenceFound: false,
          ...(options.discoveryCodeSearch ? { codeSearch: options.discoveryCodeSearch } : {}),
        },
      };
    },
    async resolveShortlist(candidatesToCheck: RepositoryCandidate[], _signal?: unknown, _onProgress?: unknown, codePatterns: string[] = []) {
      shortlistInputs.push(candidatesToCheck.map((candidate) => candidate.id));
      shortlistPatterns.push(codePatterns);
      const excluded = options.shortlistExcluded ?? [];
      return {
        snapshots,
        excluded,
        resolutions: snapshots.length + excluded.length,
        gaps: options.shortlistGaps ?? [],
        rateLimited: options.shortlistRateLimited ?? false,
        ...(options.shortlistCodeSearch ? { codeSearch: options.shortlistCodeSearch } : {}),
      };
    },
    async fetchSource(_snapshot: RepositorySnapshot, filePath: string) {
      if (options.sourceFailure !== undefined && (!options.sourceFailurePath || filePath === options.sourceFailurePath)) {
        throw options.sourceFailure;
      }
      if (options.failReads || options.failPaths?.includes(filePath)) throw new Error("fixture source outage");
      return new TextEncoder().encode(content.get(filePath) ?? `export const path = '${filePath}';\n`);
    },
  } as unknown as GitHubResearcher;
  return { value, get searches() { return searches; }, materials, shortlistPatterns, shortlistInputs };
}

function providerFailureWithThrowingGetter(marker: string): ProviderRequestError {
  const error = new ProviderRequestError({
    provider: "github",
    endpoint: "source",
    category: "network",
    attempts: 1,
    retryRefused: false,
  });
  Object.defineProperty(error, "failure", {
    get() {
      throw new Error(marker);
    },
  });
  return error;
}

function valueWithThrowingPrototypeLookup(marker: string): unknown {
  return new Proxy({}, {
    getPrototypeOf() {
      throw new Error(marker);
    },
  });
}

function forgedProviderError(marker: string): { value: unknown; reads: () => number } {
  let failureReads = 0;
  let statusReads = 0;
  const failure = {
    provider: "github",
    endpoint: "search",
    category: "http_status",
    attempts: 1,
    retryRefused: false,
  } as Record<string, unknown>;
  Object.defineProperty(failure, "status", {
    get() {
      statusReads += 1;
      return statusReads === 1 ? 500 : marker;
    },
  });
  const value = Object.create(ProviderRequestError.prototype) as object;
  Object.defineProperty(value, "message", { value: marker, enumerable: true });
  Object.defineProperty(value, "failure", {
    get() {
      failureReads += 1;
      return failure;
    },
  });
  return { value, reads: () => failureReads + statusReads };
}

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "unshit-workflow-"));
}

function expectPhaseModules(prompt: string, phase: keyof typeof REFERENCE_PLAN_MODULES): void {
  const expectedPaths = new Set(REFERENCE_PLAN_MODULES[phase].map((module) => module.path));
  for (const module of REFERENCE_POLICY_INPUTS) {
    if (expectedPaths.has(module.path)) expect(prompt).toContain(module.text.trim());
    else expect(prompt).not.toContain(module.text.trim());
  }
}

function expectNoCredentialFragments(value: string, tokens: string[]): void {
  for (const token of tokens) {
    for (let index = 0; index <= token.length - 8; index += 1) {
      if (value.includes(token.slice(index, index + 8))) throw new Error("workflow output contains a credential fragment");
    }
  }
}

const readFailureExtractionCases = [
  {
    name: "ProviderRequestError with a throwing failure getter",
    marker: "MARKER_ALPHA_7Q2W9E4R",
    create: providerFailureWithThrowingGetter,
  },
  {
    name: "value with a throwing prototype lookup",
    marker: "MARKER_BRAVO_3X8N5K1P",
    create: valueWithThrowingPrototypeLookup,
  },
] as const;

describe("candidate ranking before tree checks", () => {
  function manyCandidates(count: number): RepositoryCandidate[] {
    return Array.from({ length: count }, (_, index) => ({ ...repositorySnapshot().candidate, id: `C${index + 1}`, fullName: `org/refunds-${index + 1}` }));
  }

  test("ranks metadata-passing repositories with the model before tree checks when they exceed the tree budget", async () => {
    const cwd = await tempDirectory();
    const refs = researcher({ candidates: manyCandidates(9), treeResolutionLimit: 8 });
    const prompts: string[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), ranking: { ranked: ["C9", "C3"] }, onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: refs.value,
      });

      expect(outcome.status).toBe("completed");
      expect(refs.shortlistInputs).toEqual([["C9", "C3", "C1", "C2", "C4", "C5", "C6", "C7", "C8"]]);
      const rankingPrompt = prompts.find((prompt) => prompt.startsWith("Rank up to twelve repositories"));
      expect(rankingPrompt).toContain("The host checks at most 8 trees");
      expect(rankingPrompt).toContain("\"repository\":\"org/refunds-9\"");
      expectPhaseModules(rankingPrompt!, "research");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("skips the ranking turn when the candidates fit the tree budget", async () => {
    const cwd = await tempDirectory();
    const refs = researcher({ candidates: manyCandidates(8), treeResolutionLimit: 8 });
    const prompts: string[] = [];
    try {
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: refs.value,
      });

      expect(prompts.some((prompt) => prompt.startsWith("Rank up to twelve repositories"))).toBe(false);
      expect(refs.shortlistInputs).toEqual([["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the host order and records a non-material gap when the model ranking is invalid", async () => {
    const cwd = await tempDirectory();
    const refs = researcher({ candidates: manyCandidates(9), treeResolutionLimit: 8 });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), ranking: { ranked: ["C99"] } }),
        researcher: refs.value,
      });

      expect(outcome.status).toBe("completed");
      expect(refs.shortlistInputs).toEqual([["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9"]]);
      if (outcome.status === "completed") {
        expect(outcome.gaps).toContainEqual({ kind: "repository", material: false, message: "The model ranking of metadata-passing repositories failed, so tree checks used the host keyword order." });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("falls back to the host order when the ranking turn times out", async () => {
    const cwd = await tempDirectory();
    const refs = researcher({ candidates: manyCandidates(9), treeResolutionLimit: 8 });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), turnResult: (kind) => (kind === "ranking" ? timedOutTurn() : undefined) }),
        researcher: refs.value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.gaps).toContainEqual({
          kind: "repository",
          material: false,
          message: "The model ranking of metadata-passing repositories failed, so tree checks used the host keyword order. The candidate ranking turn timed out. Codex reported no activity on the turn for 10 minutes.",
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("continues with a new planning session after a ranking timeout disposes the session", async () => {
    const cwd = await tempDirectory();
    const refs = researcher({ candidates: manyCandidates(9), treeResolutionLimit: 8 });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), disposeOnTimeout: true, turnResult: (kind) => (kind === "ranking" ? timedOutTurn() : undefined) }),
        researcher: refs.value,
      });

      expect(outcome.status).toBe("completed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("trustworthy reference flag", () => {
  test("keeps trustworthyReferenceFound false when the model selects no comparator", async () => {
    const cwd = await tempDirectory();
    let report = "";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [noReferencesPlan()],
          selection: { selected: [], rejected: [{ candidateId: "C1", rationale: "It does not implement refund requests." }] },
        }),
        researcher: researcher().value,
        onArtifacts: async (details) => {
          report = renderReport(details);
          return undefined;
        },
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") expect(outcome.research).toMatchObject({ shortlisted: 1, selected: 0, trustworthyReferenceFound: false });
      expect(report).toContain("tree-verified shortlist 1; selected 0;");
      expect(report).toContain("No selected reference repository supplied production or test source to this plan.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps trustworthyReferenceFound false when a selected comparator supplied only license and manifest source", async () => {
    const cwd = await tempDirectory();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [validPlan("E1", null)] }),
        researcher: researcher({ failPaths: ["src/index.ts", "tests/index.test.ts"] }).value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.research).toMatchObject({ selected: 1, trustworthyReferenceFound: false });
        expect(outcome.sources.some((source) => source.repository === "org/refunds" && source.roles.includes("license"))).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("sets trustworthyReferenceFound when a selected comparator supplied production source", async () => {
    const cwd = await tempDirectory();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: researcher().value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") expect(outcome.research).toMatchObject({ shortlisted: 1, selected: 1, trustworthyReferenceFound: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// The material gap the host records when no adopted pattern cites a reference test.
const noReferenceTest = "No adopted pattern cites a reference test that exercises it; the reference comparison rests on production excerpts alone. The host recognises a test file by its path name only, so a comparator test whose path it does not recognise cannot be cited.";

describe("reference test citations", () => {
  const testFinding = { severity: "material", description: "No adopted pattern cites the comparator test E2, which exercises request creation.", requirementIds: ["R1"], evidence: [{ excerptId: "E2", claim: "The comparator test creates a refund." }], suggestedCorrection: "Cite E2 as testEvidence of the request state pattern." };

  test("keeps a plan Draft with a material gap that the reviewer sees when no adopted pattern cites a reference test", async () => {
    const cwd = await tempDirectory();
    const reviewPrompts: string[] = [];
    try {
      // The brief is approved, so the gap is the only reason for Draft.
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [validPlan("E1", null)],
          onPrompt: (prompt) => { if (prompt.startsWith("Independently review this plan")) reviewPrompts.push(prompt); },
        }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("draft");
        expect(outcome.gaps).toContainEqual({ kind: "repository", material: true, message: noReferenceTest });
        expect(outcome.plan.readinessNotes).toEqual([noReferenceTest]);
      }
      expect(reviewPrompts).toHaveLength(1);
      expect(reviewPrompts[0]).toContain(noReferenceTest);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reaches Ready when the review repair cites a reference test", async () => {
    const cwd = await tempDirectory();
    const reviewPrompts: string[] = [];
    let repairPrompt = "";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [validPlan("E1", null), validPlan()],
          reviews: [{ findings: [testFinding] }, { findings: [] }],
          onPrompt: (prompt) => {
            if (prompt.startsWith("Independently review this plan")) reviewPrompts.push(prompt);
            if (prompt.startsWith("Repair the current plan")) repairPrompt = prompt;
          },
        }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("ready");
        expect(outcome.gaps.some((gap) => gap.message === noReferenceTest)).toBe(false);
        expect(outcome.plan.readinessNotes).not.toContain(noReferenceTest);
      }
      expect(repairPrompt).toContain(noReferenceTest);
      expect(reviewPrompts).toHaveLength(2);
      expect(reviewPrompts[1]).not.toContain(noReferenceTest);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("shows the follow-up reviewer the gap again when the repaired plan still cites no reference test", async () => {
    const cwd = await tempDirectory();
    const reviewPrompts: string[] = [];
    try {
      // The brief is approved and the follow-up review finds nothing, so the gap is the only reason for Draft.
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [validPlan("E1", null), validPlan("E1", null)],
          reviews: [{ findings: [testFinding] }, { findings: [] }],
          onPrompt: (prompt) => { if (prompt.startsWith("Independently review this plan")) reviewPrompts.push(prompt); },
        }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("draft");
        expect(outcome.gaps.filter((gap) => gap.message === noReferenceTest)).toHaveLength(1);
        expect(outcome.plan.readinessNotes).toEqual([noReferenceTest]);
      }
      expect(reviewPrompts).toHaveLength(2);
      expect(reviewPrompts[1]).toContain(noReferenceTest);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reaches Ready when an adopted pattern of the second comparison cites a reference test and the first gives an untested reason", async () => {
    const cwd = await tempDirectory();
    const second: RepositoryCandidate = { ...repositorySnapshot().candidate, id: "C2", fullName: "org/refund-two", webUrl: "https://github.com/org/refund-two" };
    const plan = validPlan("E1", null);
    // E7 and E8 are the production and test excerpts of the second comparator, read after the six files of the first.
    plan.referenceComparisons.push({
      candidateId: "C2",
      adoptedPatterns: [{ pattern: "Record the refund amount.", evidence: [{ excerptId: "E7", claim: "The second comparator records the amount." }], testEvidence: [{ excerptId: "E8", claim: "Its test creates a refund." }], untestedReason: null }],
      rejectedPatterns: [{ pattern: "Process approval inline.", reason: "It couples request intake to approval handling.", evidence: [{ excerptId: "E7", claim: "The second comparator approves inline." }] }],
      localAdaptation: "Apply the target persistence rules.",
    });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          selection: { selected: [{ candidateId: "C1", rationale: "Implements refund requests." }, { candidateId: "C2", rationale: "Records refund amounts." }], rejected: [] },
          plans: [plan],
        }),
        researcher: researcher({ snapshots: [repositorySnapshot(), snapshotFor(second)] }).value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.sources.find((source) => source.excerpts.some((excerpt) => excerpt.id === "E8"))).toMatchObject({ repository: "org/refund-two", roles: ["test"] });
        expect(outcome.readiness).toBe("ready");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tells file selection, the planner, the reviewer and the review repair how to cite reference tests", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [validPlan(), validPlan()],
          reviews: [{ findings: [testFinding] }, { findings: [] }],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher().value,
      });
      const prompt = (start: string): string => prompts.find((entry) => entry.startsWith(start)) ?? "";
      expect(prompt("Choose up to 20")).toContain("For a selected repository, choose with its production files the tests that exercise them; the plan cites those tests for the patterns it adopts.");
      expect(prompt("Produce a detailed implementation plan")).toContain("For each adopted pattern, put in testEvidence the excerpts of that comparator's own tests (sources with role test) that exercise the code the pattern adopts, and set untestedReason to null. When no supplied test excerpt exercises it, give an empty testEvidence and a concrete untestedReason. A reference test was read, not run. A verification that ports a reference test case names that test's excerpt ID in its description.");
      expect(prompt("Independently review this plan")).toContain("For each adopted pattern, check that every testEvidence excerpt is a test that exercises the code the pattern adopts; a cited test that does not is an unsupported citation. When the plan's readinessNotes say that no adopted pattern cites a reference test and a supplied test excerpt of that comparator exercises an adopted pattern, report a material finding that names the excerpt.");
      expect(prompt("Repair the current plan")).toContain("Each adopted pattern keeps either testEvidence that cites a test excerpt of its comparator exercising the pattern, or a concrete untestedReason. When the current plan's readinessNotes say that no adopted pattern cites a reference test, cite such a test excerpt where one is supplied; never cite a test that does not exercise the pattern to clear the note.");
      // The roles of each source in the registry of a prompt; the registry is one JSON line after its heading.
      const registryRoles = (text: string, heading: string): Record<string, unknown> => {
        const registry = JSON.parse(text.split(`${heading}\n\n`)[1]!.split("\n\n")[0]!) as { sources: Array<{ path: string; roles: unknown }> };
        return Object.fromEntries(registry.sources.map((source) => [source.path, source.roles]));
      };
      for (const [start, heading] of [["Produce a detailed implementation plan", "HOST-CREATED SOURCE REGISTRY AND UNTRUSTED EXCERPTS:"], ["Independently review this plan", "HOST-CREATED SOURCE REGISTRY AND UNTRUSTED EXCERPTS:"], ["Repair the current plan", "HOST SOURCE REGISTRY AND UNTRUSTED EXCERPTS:"]] as const) {
        expect(registryRoles(prompt(start), heading)).toMatchObject({ "src/index.ts": ["production"], "tests/index.test.ts": ["test"] });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tells the planner to cite an adopted pattern's excerpts in the evidence of each module or entity that follows it", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [validPlan()], reviews: [{ findings: [] }], onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: researcher().value,
      });
      // The stack page shows the excerpts that each module and entity cites.
      expect(prompts.find((prompt) => prompt.startsWith("Produce a detailed implementation plan"))).toContain("When a module or entity follows an adopted pattern, its evidence cites that pattern's excerpts as well as the local code it keeps or changes.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tells the review repair that a new test case run by a supplied command is an existing verification with that commandId", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [validPlan(), validPlan()], reviews: [{ findings: [testFinding] }, { findings: [] }], onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: researcher().value,
      });
      // parsePlan rejects a to_create verification with a commandId, and a review repair that fails it is not retried.
      expect(prompts.find((prompt) => prompt.startsWith("Repair the current plan"))).toContain("For a verification that runs a supplied command, including a new test case that the command runs, use kind existing with that commandId. Use kind to_create with plannedCommand only for a command the target project does not have yet; to_create never takes a commandId.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("reference test roles and checkpoints", () => {

  test("rejects a production excerpt cited as a reference test even when the model selected its file as a test", async () => {
    const cwd = await tempDirectory();
    try {
      // E1 is the excerpt of src/index.ts. The model selects that file as a test and cites E1 as testEvidence; the
      // repair cites the test excerpt E2.
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          fileSelection: { files: [{ fileId: "C1F1", role: "test", rationale: "The model calls the handler a test." }] },
          plans: [validPlan("E1", "E1"), validPlan()],
        }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.validationHistory).toEqual([{ issue: "Adopted pattern test for C1 cites E1 from src/index.ts, which the host did not read as a test file.", resolved: true }]);
        expect(outcome.sources.find((source) => source.path === "src/index.ts")?.roles).toEqual(["production"]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("saves the reference-test gap with every checkpoint whose plan notes hold it, also when review is interrupted or times out", async () => {
    const scenarios: Array<{ name: string; plans: unknown[]; reviews?: unknown[]; turnResult?: (kind: TurnKind, occurrence: number) => ModelTurnResult | undefined; expected: Array<[string, boolean, number]> }> = [
      {
        name: "interrupted in the first review",
        plans: [validPlan("E1", null)],
        turnResult: (kind) => (kind === "review" ? { status: "interrupted", message: "The run was interrupted." } : undefined),
        expected: [["evidence", false, 0], ["plan", true, 1], ["interrupted", true, 1]],
      },
      {
        name: "timed out in the first review",
        plans: [validPlan("E1", null)],
        turnResult: (kind) => (kind === "review" ? timedOutTurn() : undefined),
        expected: [["evidence", false, 0], ["plan", true, 1], ["timed_out", true, 1]],
      },
      {
        // The repair cites the test excerpt E2, so the checkpoint after it has neither the note nor the gap.
        name: "interrupted in the review after a repair that cites a reference test",
        plans: [validPlan("E1", null), validPlan()],
        reviews: [{ findings: [{ severity: "material", description: "No adopted pattern cites the comparator test E2.", requirementIds: ["R1"], evidence: [{ excerptId: "E2", claim: "The comparator test creates a refund." }], suggestedCorrection: "Cite E2 as testEvidence." }] }],
        turnResult: (kind, occurrence) => (kind === "review" && occurrence === 2 ? { status: "interrupted", message: "The run was interrupted." } : undefined),
        expected: [["evidence", false, 0], ["plan", true, 1], ["plan", false, 0], ["interrupted", false, 0]],
      },
      {
        // The final checkpoint gets the gap once, from gaps.
        name: "completed",
        plans: [validPlan("E1", null)],
        expected: [["evidence", false, 0], ["plan", true, 1], ["plan", true, 1]],
      },
    ];
    for (const scenario of scenarios) {
      const cwd = await tempDirectory();
      const checkpoints: Array<[string, boolean, number]> = [];
      try {
        await runWorkflow({
          cwd,
          requirement: "Build a refund request service.",
          approveBrief: async () => true,
          modelGateway: gateway({ intake: baseIntake(), plans: scenario.plans, ...(scenario.reviews ? { reviews: scenario.reviews } : {}), ...(scenario.turnResult ? { turnResult: scenario.turnResult } : {}) }),
          researcher: researcher().value,
          onCheckpoint: async (input, stage) => {
            checkpoints.push([stage, input.plan.readinessNotes.includes(noReferenceTest), input.gaps.filter((gap) => gap.message === noReferenceTest && gap.material).length]);
            return undefined;
          },
        });
        expect({ name: scenario.name, checkpoints }).toEqual({ name: scenario.name, checkpoints: scenario.expected });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });
});

describe("model turn timeouts", () => {
  test("reports a plan-turn timeout as timed_out with its stage and limit and saves a timed_out checkpoint", async () => {
    const cwd = await tempDirectory();
    const checkpoints: Array<[string, string]> = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), turnResult: (kind) => (kind === "plan" ? timedOutTurn() : undefined) }),
        researcher: researcher().value,
        onCheckpoint: async (input, stage) => {
          checkpoints.push([stage, input.plan.title]);
          return `/tmp/unshit-checkpoints/${stage}.json`;
        },
      });

      expect(outcome).toEqual({
        status: "timed_out",
        message: "The plan turn timed out. Codex reported no activity on the turn for 10 minutes.",
        stage: "plan",
        limit: "idle",
        limitSeconds: 600,
        checkpointPath: "/tmp/unshit-checkpoints/timed_out.json",
      });
      expect(checkpoints).toEqual([
        ["evidence", "Evidence checkpoint before plan generation"],
        ["timed_out", "Draft checkpoint after a model turn timed out"],
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the validated plan as Draft when the review repair turn times out", async () => {
    const cwd = await tempDirectory();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [{ findings: [{ severity: "material", description: "The approval rule is missing.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "Add the approval rule." }] }],
          turnResult: (kind, occurrence) => (kind === "plan" && occurrence === 2 ? timedOutTurn() : undefined),
        }),
        researcher: researcher().value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("draft");
        expect(outcome.plan.tasks).toHaveLength(1);
        expect(outcome.plan.readinessNotes).toContain("The review repair turn timed out. Codex reported no activity on the turn for 10 minutes.");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("treats a plan-repair timeout like a failed repair", async () => {
    const cwd = await tempDirectory();
    const invalid = validPlan();
    invalid.tasks[0]!.requirementIds = ["R99"];
    let failedIssues: string[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [invalid], turnResult: (kind, occurrence) => (kind === "plan" && occurrence === 2 ? timedOutTurn() : undefined) }),
        researcher: researcher().value,
        onCheckpoint: async (input, stage) => {
          if (stage === "failed") failedIssues = input.validationIssues;
          return undefined;
        },
      });

      expect(outcome.status).toBe("error");
      if (outcome.status === "error") expect(outcome.message).toContain("did not produce a usable task map");
      expect(failedIssues).toContain("The plan repair turn timed out. Codex reported no activity on the turn for 10 minutes.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("plans from the initial brief when the brief rebuild turn times out", async () => {
    const cwd = await tempDirectory();
    const question = { question: "Who may approve a refund?", whyMaterial: "This defines the refund authorization boundary." };
    const questionId = parseIntake(baseIntake([question])).materialQuestions[0]!.id;
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build refunds.",
        answers: { [questionId]: "Only named refund managers." },
        modelGateway: gateway({ intake: baseIntake([question]), turnResult: (kind) => (kind === "refined" ? timedOutTurn() : undefined) }),
        researcher: researcher().value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.gaps).toContainEqual({
          kind: "validation",
          material: true,
          message: "The brief could not be rebuilt after the material answers; planning used the initial brief with the answers as context. The brief rebuild turn timed out. Codex reported no activity on the turn for 10 minutes.",
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("continues with a new planning session after a brief-rebuild timeout disposes the session", async () => {
    const cwd = await tempDirectory();
    const question = { question: "Who may approve a refund?", whyMaterial: "This defines the refund authorization boundary." };
    const questionId = parseIntake(baseIntake([question])).materialQuestions[0]!.id;
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build refunds.",
        answers: { [questionId]: "Only named refund managers." },
        modelGateway: gateway({ intake: baseIntake([question]), disposeOnTimeout: true, turnResult: (kind) => (kind === "refined" ? timedOutTurn() : undefined) }),
        researcher: researcher().value,
      });

      expect(outcome.status).toBe("completed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("saves a timed_out checkpoint when intake, candidate selection or file selection times out", async () => {
    for (const timedOutKind of ["intake", "selection", "files"] as const) {
      const cwd = await tempDirectory();
      const checkpoints: Array<{ stage: string; title: string; sources: number; summary: string }> = [];
      try {
        const outcome = await runWorkflow({
          cwd,
          requirement: "Build a refund request service.",
          modelGateway: gateway({ intake: baseIntake(), turnResult: (kind) => (kind === timedOutKind ? timedOutTurn() : undefined) }),
          researcher: researcher().value,
          onCheckpoint: async (input, stage) => {
            checkpoints.push({ stage, title: input.plan.title, sources: input.sources.length, summary: input.brief.summary });
            return `/tmp/unshit-checkpoints/${timedOutKind}.json`;
          },
        });

        expect(outcome).toMatchObject({ status: "timed_out", checkpointPath: `/tmp/unshit-checkpoints/${timedOutKind}.json` });
        expect(checkpoints).toEqual([{
          stage: "timed_out",
          title: "Draft checkpoint after a model turn timed out",
          sources: 0,
          summary: timedOutKind === "intake" ? "Build a refund request service." : "Build a small refund request service.",
        }]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });
});

describe("checkpoint placeholders", () => {
  test("titles each checkpoint for its own stage when the plan turn is interrupted", async () => {
    const cwd = await tempDirectory();
    const checkpoints: Array<{ stage: string; title: string; architecture: string; notes: string[] }> = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          turnResult: (kind) => (kind === "plan" ? { status: "interrupted", message: "The run was interrupted." } : undefined),
        }),
        researcher: researcher().value,
        onCheckpoint: async (input, stage) => {
          checkpoints.push({ stage, title: input.plan.title, architecture: input.plan.design.architecture, notes: input.plan.readinessNotes });
          return undefined;
        },
      });

      expect(outcome.status).toBe("interrupted");
      expect(checkpoints).toEqual([
        {
          stage: "evidence",
          title: "Evidence checkpoint before plan generation",
          architecture: "Not generated yet; plan generation had not finished when this checkpoint was saved.",
          notes: ["Plan generation is in progress; this checkpoint contains evidence only."],
        },
        {
          stage: "interrupted",
          title: "Draft checkpoint after an interrupted run",
          architecture: "Not generated; the run was interrupted first.",
          notes: ["The run was interrupted before planning and review completed; saved material remains Draft."],
        },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("saves a mid-run input request as a needs_input checkpoint", async () => {
    const cwd = await tempDirectory();
    const checkpoints: Array<{ stage: string; title: string }> = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          turnResult: (kind) => (kind === "plan" ? { status: "needs_input", questions: [{ id: "Q1", question: "Which currency do refunds use?" }] } : undefined),
        }),
        researcher: researcher().value,
        onCheckpoint: async (input, stage) => {
          checkpoints.push({ stage, title: input.plan.title });
          return undefined;
        },
      });

      expect(outcome.status).toBe("needs_input");
      expect(checkpoints.at(-1)).toEqual({ stage: "needs_input", title: "Draft checkpoint while waiting for input" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the validation title when plan validation and its repair both fail", async () => {
    const cwd = await tempDirectory();
    const invalid = validPlan();
    invalid.tasks[0]!.requirementIds = ["R99"];
    const checkpoints: Array<[string, string]> = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [invalid, invalid] }),
        researcher: researcher().value,
        onCheckpoint: async (input, stage) => {
          checkpoints.push([stage, input.plan.title]);
          return undefined;
        },
      });

      expect(outcome.status).toBe("error");
      expect(checkpoints).toEqual([
        ["evidence", "Evidence checkpoint before plan generation"],
        ["plan", "Draft plan blocked by validation"],
        ["failed", "Draft plan blocked by validation"],
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("workflow gates and readiness", () => {
  for (const fixture of readFailureExtractionCases) {
    test(`keeps ${fixture.name} out of workflow read diagnostics`, async () => {
      const cwd = await tempDirectory();
      const failure = fixture.create(fixture.marker);
      const refs = researcher({ sourceFailure: failure, sourceFailurePath: "src/index.ts" });
      let report = "";
      try {
        const outcome = await runWorkflow({
          cwd,
          requirement: "Build a refund request service.",
          modelGateway: gateway({ intake: baseIntake(), plans: [validPlan("E1", null)] }),
          researcher: refs.value,
          onArtifacts: async (input) => {
            report = renderReport(input);
            return undefined;
          },
        });

        expect(outcome.status).toBe("completed");
        if (outcome.status === "completed") {
          const expected = fixture.name.startsWith("ProviderRequestError")
            ? "Could not read src/index.ts from org/refunds; GitHub source request failed: no response (network failure)."
            : "Could not read src/index.ts from org/refunds; the file could not be read.";
          expect(outcome.gaps.some((gap) => gap.message === expected)).toBe(true);
        }
        expect(report.length).toBeGreaterThan(0);
        expectNoCredentialFragments(JSON.stringify(outcome), [fixture.marker]);
        expectNoCredentialFragments(report, [fixture.marker]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  test("keeps a forged failure thrown inside the search request out of every host output and manifest", async () => {
    const cwd = await tempDirectory();
    const marker = "MARKER_FOXTROT_8D3J6M1Q";
    const forged = forgedProviderError(marker);
    const urls: URL[] = [];
    const entries = ["refund-one", "refund-two"].map((name) => ({
      full_name: `org/${name}`,
      default_branch: "main",
      description: "Refund request service",
      stargazers_count: 250,
      forks_count: 20,
      archived: false,
      fork: false,
      license: { spdx_id: "MIT" },
      language: "TypeScript",
      topics: ["refunds"],
      pushed_at: "2026-06-01T00:00:00Z",
      created_at: "2020-01-01T00:00:00Z",
    }));
    const files = [
      { path: "src/index.ts", type: "blob", size: 60 },
      { path: "tests/index.test.ts", type: "blob", size: 50 },
      { path: "package.json", type: "blob", size: 20 },
      { path: "LICENSE", type: "blob", size: 20 },
      { path: ".github/workflows/check.yml", type: "blob", size: 20 },
      { path: "vitest.config.ts", type: "blob", size: 20 },
    ];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      urls.push(url);
      if (url.origin === "https://api.github.com" && url.pathname === "/search/repositories") {
        return new Response(JSON.stringify({ items: entries }), { status: 200 });
      }
      if (url.pathname.endsWith("/repos/org/refund-one/commits/main") || url.pathname.endsWith("/repos/org/refund-two/commits/main")) {
        return new Response(JSON.stringify({ sha: "8e0d33a8257952f4d02d92fd566297082b9a7f2e" }), { status: 200 });
      }
      if (url.pathname.includes("/repos/org/refund-one/git/trees/") || url.pathname.includes("/repos/org/refund-two/git/trees/")) {
        return new Response(JSON.stringify({ tree: files, truncated: false }), { status: 200 });
      }
      if (url.origin === "https://raw.githubusercontent.com") return new Response("export const value = true;\n", { status: 200 });
      return new Response("unexpected request", { status: 404 });
    };
    const realResearcher = new GitHubResearcher({
      fetch,
      now: () => new Date("2026-10-10T00:00:00.000Z"),
      minimumPassing: 2,
      maxTreeResolutions: 2,
      shortlistSize: 2,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });
    const runId = "failure-registry-e2e";
    const hostOutputs: string[] = [];
    const checkpointManifests: string[] = [];
    const progressEvents: string[] = [];
    let throwCount = 0;
    let finalManifest = "";
    let savedReport = "";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [noReferencesPlan()],
          selection: {
            selected: [{ candidateId: "C1", rationale: "Use the first verified refund service." }],
            rejected: [{ candidateId: "C2", rationale: "The first repository is the comparator for this run." }],
          },
          fileSelection: { files: [] },
        }),
        researcher: realResearcher,
        onProgress: (event) => {
          const serialized = JSON.stringify(event);
          progressEvents.push(serialized);
          if (throwCount === 0 && event.stage === "repository_search" && event.message.startsWith("GitHub tier")) {
            throwCount += 1;
            throw forged.value;
          }
        },
        onCheckpoint: async (input, stage) => {
          hostOutputs.push(JSON.stringify({ input, stage }));
          const manifestPath = await writeCheckpointArtifacts({ cwd, runId, stage, input });
          checkpointManifests.push(await readFile(manifestPath, "utf8"));
          return manifestPath;
        },
        onArtifacts: async (input) => {
          hostOutputs.push(JSON.stringify(input));
          const artifacts = await writePlanArtifacts({ cwd, runId, input });
          finalManifest = await readFile(artifacts.manifestPath, "utf8");
          savedReport = await readFile(artifacts.reportPath, "utf8");
          return artifacts;
        },
      });

      if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome));
      expect(outcome.status).toBe("completed");
      expect(throwCount).toBe(1);
      if (outcome.status === "completed") {
        expect(outcome.research?.queries[0]).toMatchObject({
          provider: "github",
          status: "failed",
          failure: { provider: "github", endpoint: "search", category: "internal", attempts: 0, retryRefused: false },
        });
        expect(outcome.research?.queries.some((query) => query.provider === "github" && query.status === "ok")).toBe(true);
        expect(outcome.gaps.some((gap) => gap.message.includes("GitHub search request failed: internal host error (tier 0 query)."))).toBe(true);
      }
      expect(urls.filter((url) => url.origin === "https://api.github.com" && url.pathname === "/search/repositories").length).toBeGreaterThanOrEqual(2);
      expect(urls.some((url) => url.pathname.endsWith("/repos/org/refund-one/commits/main"))).toBe(true);
      expect(urls.some((url) => url.pathname.endsWith("/repos/org/refund-two/commits/main"))).toBe(true);
      expect(urls.some((url) => url.pathname.includes("/repos/org/refund-one/git/trees/"))).toBe(true);
      expect(urls.some((url) => url.pathname.includes("/repos/org/refund-two/git/trees/"))).toBe(true);
      expect(urls.some((url) => url.origin === "https://raw.githubusercontent.com")).toBe(true);
      expect(checkpointManifests.length).toBeGreaterThan(0);
      expect(finalManifest).not.toBe("");
      expect(savedReport).not.toBe("");
      expect(forged.reads()).toBe(0);
      const outputs = [
        JSON.stringify(outcome), savedReport, finalManifest, ...hostOutputs, ...progressEvents, ...checkpointManifests,
      ];
      for (const output of outputs) expectNoCredentialFragments(output, [marker]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reuses exact question context when intake order and phrasing change", async () => {
    const firstQuestions = [
      { question: "Who may approve a refund?", whyMaterial: "This decides the authorization boundary." },
      { question: "Which region launches first?", whyMaterial: "This changes tax and receipt rules." },
    ];
    const firstBrief = parseIntake(baseIntake(firstQuestions));
    let blockedIntakePrompt = "";
    const inputGateway = gateway({
      intake: baseIntake(firstQuestions),
      onPrompt: (prompt) => { blockedIntakePrompt = prompt; },
    });
    const refs = researcher();
    const cwd = await tempDirectory();
    try {
      const first = await runWorkflow({ cwd, requirement: "Build a refund system.", modelGateway: inputGateway, researcher: refs.value });
      expect(first.status).toBe("needs_input");
      expectPhaseModules(blockedIntakePrompt, "intake");
      expect(refs.searches).toBe(0);

      const changed = baseIntake([
        { question: "Which region is the first launch?", whyMaterial: "Tax and receipt behavior differs by region." },
        { question: "Who is allowed to approve refunds?", whyMaterial: "The answer defines authorization." },
      ]);
      const secondRefs = researcher();
      const second = await runWorkflow({
        cwd,
        requirement: "Build a refund system.",
        priorQuestions: firstBrief.materialQuestions,
        answers: { [firstBrief.materialQuestions[0]!.id]: "Only named refund managers." },
        modelGateway: gateway({ intake: changed }),
        researcher: secondRefs.value,
      });
      expect(second.status).toBe("needs_input");
      if (second.status === "needs_input") expect(second.questions.map((question) => question.id)).toEqual([firstBrief.materialQuestions[1]!.id]);
      expect(secondRefs.searches).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects unmatched stale answer IDs before any reference search", async () => {
    const cwd = await tempDirectory();
    const refs = researcher();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund system.",
        answers: { "Q-000000000000": "Only managers." },
        modelGateway: gateway({ intake: baseIntake([{ question: "Who may approve a refund?", whyMaterial: "Authorization changes." }]) }),
        researcher: refs.value,
      });
      expect(outcome.status).toBe("error");
      expect(refs.searches).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ends the run before research when the initial intake violates the topic slug contract", async () => {
    const invalidCwd = await tempDirectory();
    const validCwd = await tempDirectory();
    const invalidResearcher = researcher();
    const validResearcher = researcher();
    try {
      const invalid = await runWorkflow({
        cwd: invalidCwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: { ...baseIntake(), topicSlugs: ["a".repeat(51)] } }),
        researcher: invalidResearcher.value,
      });
      expect(invalid).toMatchObject({ status: "error", message: "topicSlugs[1] must contain 1 to 50 characters." });
      expect(invalidResearcher.searches).toBe(0);

      const valid = await runWorkflow({
        cwd: validCwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: { ...baseIntake(), topicSlugs: ["a".repeat(50)] } }),
        researcher: validResearcher.value,
      });
      expect(valid.status).toBe("completed");
      expect(validResearcher.materials[0]?.topics).toEqual(["a".repeat(50)]);
    } finally {
      await rm(invalidCwd, { recursive: true, force: true });
      await rm(validCwd, { recursive: true, force: true });
    }
  });

  test("keeps every host output free of adapter text when real provider requests fail", async () => {
    const cwd = await tempDirectory();
    const githubToken = "SENTINEL_GITHUB_7f3b9d2a4c6e8f10";
    const gitlabToken = "SENTINEL_GITLAB_2a4c6e8f0b1d3f57";
    const tokens = [githubToken, gitlabToken];
    const urls: URL[] = [];
    const sentinelText = `${githubToken} ${gitlabToken}`;
    let firstSearchQuery: string | undefined;
    const files = [
      { path: "src/index.ts", type: "blob", size: 60 },
      { path: "tests/index.test.ts", type: "blob", size: 50 },
      { path: "package.json", type: "blob", size: 20 },
      { path: "LICENSE", type: "blob", size: 20 },
      { path: ".github/workflows/check.yml", type: "blob", size: 20 },
      { path: "vitest.config.ts", type: "blob", size: 20 },
    ];
    const entries = ["refund-one", "refund-two"].map((name) => ({
      full_name: `org/${name}`,
      default_branch: "main",
      description: "Refund request service",
      stargazers_count: 250,
      forks_count: 20,
      archived: false,
      fork: false,
      license: { spdx_id: "MIT" },
      language: "TypeScript",
      topics: ["refunds"],
      pushed_at: "2026-06-01T00:00:00Z",
      created_at: "2020-01-01T00:00:00Z",
    }));
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      urls.push(url);
      if (url.origin === "https://api.github.com" && url.pathname === "/search/repositories") {
        const query = url.searchParams.get("q") ?? "";
        if (firstSearchQuery === undefined) firstSearchQuery = query;
        if (query === firstSearchQuery) throw new Error(sentinelText);
        return new Response(JSON.stringify({ items: entries }), { status: 200 });
      }
      if (url.pathname.endsWith("/repos/org/refund-one/commits/main") || url.pathname.endsWith("/repos/org/refund-two/commits/main")) {
        return new Response(JSON.stringify({ sha: "8e0d33a8257952f4d02d92fd566297082b9a7f2e" }), { status: 200 });
      }
      if (url.pathname.includes("/repos/org/refund-one/git/trees/")) {
        return new Response(JSON.stringify({ tree: files, truncated: false }), { status: 200 });
      }
      if (url.pathname.includes("/repos/org/refund-two/git/trees/")) throw new Error(sentinelText);
      if (url.origin === "https://raw.githubusercontent.com" && url.pathname.endsWith("/src/index.ts")) throw new Error(sentinelText);
      if (url.origin === "https://raw.githubusercontent.com") return new Response("export const value = true;\n", { status: 200 });
      return new Response("unexpected request", { status: 404 });
    };
    const realResearcher = new GitHubResearcher({
      fetch,
      githubToken,
      gitlabToken,
      now: () => new Date("2026-10-10T00:00:00.000Z"),
      minimumPassing: 2,
      maxTreeResolutions: 2,
      shortlistSize: 2,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });
    const artifactOutputs: string[] = [];
    const checkpointOutputs: string[] = [];
    const progressMessages: string[] = [];
    let report = "";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [noReferencesPlan(), validPlan("E1", null)], fileSelection: { files: [] } }),
        researcher: realResearcher,
        onArtifacts: async (input) => {
          artifactOutputs.push(JSON.stringify(input));
          report = renderReport(input);
          return undefined;
        },
        onCheckpoint: async (input, stage) => {
          checkpointOutputs.push(JSON.stringify({ input, stage }));
          return undefined;
        },
        onProgress: (event) => progressMessages.push(JSON.stringify(event)),
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("draft");
        expect(outcome.gaps.some((gap) => gap.message.includes("GitHub search request failed"))).toBe(true);
        expect(outcome.gaps.some((gap) => gap.message.includes("GitHub tree request failed"))).toBe(true);
        expect(outcome.gaps.some((gap) => gap.message.includes("GitHub source request failed"))).toBe(true);
      }
      expect(urls.some((url) => url.pathname === "/search/repositories")).toBe(true);
      expect(urls.some((url) => url.pathname.endsWith("/repos/org/refund-one/commits/main"))).toBe(true);
      expect(urls.some((url) => url.pathname.endsWith("/repos/org/refund-two/commits/main"))).toBe(true);
      expect(urls.some((url) => url.pathname.includes("/repos/org/refund-one/git/trees/"))).toBe(true);
      expect(urls.some((url) => url.pathname.includes("/repos/org/refund-two/git/trees/"))).toBe(true);
      expect(urls.some((url) => url.origin === "https://raw.githubusercontent.com" && url.pathname.endsWith("/src/index.ts"))).toBe(true);
      expect(report).not.toBe("");
      expect(artifactOutputs.length).toBeGreaterThan(0);
      expect(checkpointOutputs.length).toBeGreaterThan(0);
      for (const output of [JSON.stringify(outcome), report, ...artifactOutputs, ...checkpointOutputs, ...progressMessages]) {
        expectNoCredentialFragments(output, tokens);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reaches Ready for a new target when pinned production, test, and metadata evidence is complete", async () => {
    const cwd = await tempDirectory();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: { files: [{ fileId: "C1F1", role: "production", rationale: "Handler." }, { fileId: "C1F2", role: "test", rationale: "Tests." }] } }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("ready");
        expect(outcome.plan.tasks).toHaveLength(1);
        expect(outcome.sources.some((source) => source.roles.includes("test"))).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps a full plan Draft when public reference sources are unavailable", async () => {
    const cwd = await tempDirectory();
    const noCandidates = researcher({ candidates: [], snapshots: [] });
    const prompts: string[] = [];
    let finalReport = "";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [noReferencesPlan()], onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: noCandidates.value,
        onArtifacts: async (details) => { finalReport = renderReport(details); return undefined; },
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("draft");
        expect(outcome.plan.tasks).toHaveLength(1);
        expect(outcome.research?.trustworthyReferenceFound).toBe(false);
        expect(outcome.gaps.find((gap) => gap.message.startsWith("No trustworthy public reference repository was found"))?.message).toContain("a license");
        expect(outcome.gaps.some((gap) => gap.message.startsWith("No adopted pattern cites a reference test"))).toBe(false);
      }
      expect(prompts.some((prompt) => prompt.startsWith("Select zero to three public repository"))).toBe(false);
      expect(finalReport).toContain("No trustworthy public reference repository was found");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("records resolved tree evidence for host-excluded repositories and reports their test counts", async () => {
    const cwd = await tempDirectory();
    const candidateWithTestsMissing: RepositoryCandidate = {
      id: "C7",
      provider: "github",
      fullName: "org/no-tests",
      description: "Refund project",
      defaultBranch: "main",
      webUrl: "https://github.com/org/no-tests",
      signals: { stars: 80, forks: 4, archived: false, fork: false, licenseSpdxId: null, language: "PHP", topics: [], pushedAt: "2026-07-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" },
    };
    const candidateWithoutLicense: RepositoryCandidate = {
      id: "C8",
      provider: "github",
      fullName: "org/no-license",
      description: "Refund project",
      defaultBranch: "main",
      webUrl: "https://github.com/org/no-license",
      signals: { stars: 80, forks: 4, archived: false, fork: false, licenseSpdxId: null, language: "PHP", topics: [], pushedAt: "2026-07-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" },
    };
    const commitWithoutTests = "a".repeat(40);
    const commitWithoutLicense = "b".repeat(40);
    const noTestReason = `no test file at ${commitWithoutTests}`;
    const noLicenseReason = `no license: GitHub reported no license and the tree at ${commitWithoutLicense} has no root LICENSE, LICENCE, UNLICENSE or COPYING file`;
    let finalReport = "";
    const refs = researcher({
      candidates: [candidateWithTestsMissing, candidateWithoutLicense],
      snapshots: [],
      shortlistExcluded: [
        {
          candidate: candidateWithTestsMissing,
          reasons: [noTestReason],
          resolution: { commitSha: commitWithoutTests, commitDate: "2026-09-20T00:00:00.000Z", treeFileCount: 2, testFileCount: 0, licensePath: "LICENSE.md" },
        },
        {
          candidate: candidateWithoutLicense,
          reasons: [noLicenseReason],
          resolution: { commitSha: commitWithoutLicense, commitDate: "2026-09-21T00:00:00.000Z", treeFileCount: 2, testFileCount: 1 },
        },
      ],
    });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [noReferencesPlan()] }),
        researcher: refs.value,
        onArtifacts: async (details) => { finalReport = renderReport(details); return undefined; },
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.research?.excluded).toBe(2);
        expect(outcome.plan.repositoryChoices.find((choice) => choice.candidateId === "C7")).toMatchObject({
          outcome: "rejected",
          decidedBy: "host",
          commitSha: commitWithoutTests,
          commitDate: "2026-09-20T00:00:00.000Z",
          treeFileCount: 2,
          testFileCount: 0,
          licenseEvidence: "tree",
          licensePath: "LICENSE.md",
          rationale: noTestReason,
        });
        expect(outcome.plan.repositoryChoices.find((choice) => choice.candidateId === "C8")).toMatchObject({
          outcome: "rejected",
          decidedBy: "host",
          commitSha: commitWithoutLicense,
          commitDate: "2026-09-21T00:00:00.000Z",
          treeFileCount: 2,
          testFileCount: 1,
          licenseEvidence: "none",
          rationale: noLicenseReason,
        });
        expect(outcome.plan.repositoryChoices.find((choice) => choice.candidateId === "C8")).not.toHaveProperty("licensePath");
      }
      expect(finalReport).toContain("0 test files");
      expect(finalReport).toContain("1 test files");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("records root LICENSE.md tree evidence on the repository choice", async () => {
    const cwd = await tempDirectory();
    const candidateWithTreeLicense: RepositoryCandidate = {
      ...repositorySnapshot().candidate,
      id: "C7",
      fullName: "org/tree-licensed",
      webUrl: "https://github.com/org/tree-licensed",
      signals: { stars: 80, forks: 4, archived: false, fork: false, licenseSpdxId: null, language: "PHP", topics: [], pushedAt: "2026-07-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" },
    };
    const snapshot = snapshotFor(candidateWithTreeLicense);
    snapshot.files = snapshot.files.map((file) => file.path === "LICENSE" ? { ...file, path: "LICENSE.md" } : file);
    snapshot.licensePath = "LICENSE.md";
    snapshot.testFileCount = 1;
    const plan = validPlan();
    plan.referenceComparisons[0]!.candidateId = "C7";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          selection: { selected: [{ candidateId: "C7", rationale: "GitHub did not classify the root license file." }], rejected: [] },
          fileSelection: { files: [{ fileId: "C7F1", role: "production", rationale: "Main handler." }, { fileId: "C7F2", role: "test", rationale: "Tests." }] },
          plans: [plan],
        }),
        researcher: researcher({ candidates: [candidateWithTreeLicense], snapshots: [snapshot] }).value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.plan.repositoryChoices.find((choice) => choice.candidateId === "C7")).toMatchObject({
          licenseEvidence: "tree",
          licensePath: "LICENSE.md",
          treeFileCount: 6,
          testFileCount: 1,
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("stays Ready when a failed tree is followed by six verified candidates", async () => {
    const cwd = await tempDirectory();
    const failedCandidate: RepositoryCandidate = {
      ...repositorySnapshot().candidate,
      id: "C0",
      fullName: "org/unreadable-first",
      webUrl: "https://github.com/org/unreadable-first",
    };
    const verifiedCandidates = Array.from({ length: 6 }, (_, index) => ({
      ...repositorySnapshot().candidate,
      id: `C${index + 1}`,
      fullName: `org/refund-${index + 1}`,
      webUrl: `https://github.com/org/refund-${index + 1}`,
    }));
    const verifiedSnapshots = verifiedCandidates.map((candidate) => snapshotFor(candidate));
    const refs = researcher({
      candidates: [failedCandidate, ...verifiedCandidates],
      snapshots: verifiedSnapshots,
      shortlistExcluded: [{ candidate: failedCandidate, reasons: ["could not resolve commit-pinned tree: HTTP 500"] }],
      shortlistGaps: [{ kind: "tree", message: "Could not read the first commit-pinned tree: HTTP 500.", material: false }],
    });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          selection: {
            selected: [{ candidateId: "C1", rationale: "Use the first verified repository." }],
            rejected: verifiedCandidates.slice(1).map((candidate) => ({ candidateId: candidate.id, rationale: "The first comparator is sufficient." })),
          },
        }),
        researcher: refs.value,
      });

      if (outcome.status !== "completed") {
        throw new Error(`Workflow returned ${outcome.status}${outcome.status === "error" ? `: ${outcome.message}` : ""}`);
      }
      if (outcome.status === "completed") {
        expect(outcome.research?.shortlisted).toBe(6);
        expect(outcome.gaps.find((gap) => gap.message.includes("first commit-pinned tree"))).toMatchObject({ material: false });
        expect(outcome.readiness).toBe("ready");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("records tree license evidence for a NOASSERTION comparator in the selection data and the repository choice", async () => {
    const cwd = await tempDirectory();
    const snapshot = repositorySnapshot();
    snapshot.candidate.signals = { stars: 300, forks: 10, archived: false, fork: false, licenseSpdxId: "NOASSERTION", language: "Java", topics: [], pushedAt: "2026-06-01T00:00:00.000Z", createdAt: "2015-01-01T00:00:00.000Z" };
    snapshot.licensePath = "LICENSE";
    const prompts: string[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: researcher({ snapshots: [snapshot] }).value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.plan.repositoryChoices[0]).toMatchObject({ candidateId: "C1", licenseEvidence: "tree", licensePath: "LICENSE" });
      }
      const selectionPrompt = prompts.find((prompt) => prompt.startsWith("Select zero to three public repository"));
      expect(selectionPrompt).toContain("\"licenseEvidence\":\"tree\"");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not add a truncation gap when the model rejects the truncated candidate", async () => {
    const cwd = await tempDirectory();
    const truncatedCandidate = { ...repositorySnapshot().candidate, id: "C1" };
    const completeCandidate: RepositoryCandidate = {
      ...repositorySnapshot().candidate,
      id: "C2",
      fullName: "org/complete-refund",
      webUrl: "https://github.com/org/complete-refund",
    };
    const plan = validPlan();
    plan.referenceComparisons[0]!.candidateId = "C2";
    const refs = researcher({
      candidates: [truncatedCandidate, completeCandidate],
      snapshots: [snapshotFor(truncatedCandidate, true), snapshotFor(completeCandidate)],
    });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          selection: { selected: [{ candidateId: "C2", rationale: "Use the complete repository." }], rejected: [{ candidateId: "C1", rationale: "The tree is incomplete." }] },
          fileSelection: { files: [{ fileId: "C2F1", role: "production", rationale: "Main handler." }, { fileId: "C2F2", role: "test", rationale: "Tests." }] },
          plans: [plan],
        }),
        researcher: refs.value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.gaps.filter((gap) => gap.message.includes("indexed tree") && gap.message.includes("truncated"))).toHaveLength(0);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("adds exactly one material truncation gap for a selected truncated repository", async () => {
    const cwd = await tempDirectory();
    const truncated = snapshotFor(repositorySnapshot().candidate, true);
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: researcher({ snapshots: [truncated] }).value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        const truncationGaps = outcome.gaps.filter((gap) => gap.message.includes("indexed tree") && gap.message.includes("truncated"));
        expect(truncationGaps).toHaveLength(1);
        expect(truncationGaps[0]?.material).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("carries shortlist tree rate limits into research and the report", async () => {
    const cwd = await tempDirectory();
    let finalReport = "";
    const refs = researcher({
      shortlistRateLimited: true,
      shortlistGaps: [{ kind: "tree", message: "GitHub rate limit reached during tree resolution.", material: false }],
    });
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: refs.value,
        onArtifacts: async (details) => { finalReport = renderReport(details); return undefined; },
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") expect(outcome.research?.rateLimited).toBe(true);
      expect(finalReport).toContain("rate limited yes");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("clears fixed initial validation and uses the latest clean review for readiness", async () => {
    const cwd = await tempDirectory();
    const invalid = validPlan();
    invalid.tasks[0]!.requirementIds = ["R99"];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), plans: [invalid, validPlan()], reviews: [{ findings: [] }] }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("ready");
        expect(outcome.validationIssues).toEqual([]);
        expect(outcome.validationHistory).toEqual([{ issue: expect.any(String), resolved: true }]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("routes only phase-needed modules and gives every planning and review turn the exact answer context", async () => {
    const cwd = await tempDirectory();
    const question = { question: "Who may approve a refund?", whyMaterial: "This defines the refund authorization boundary." };
    const questionId = parseIntake(baseIntake([question])).materialQuestions[0]!.id;
    const observedPrompts: string[] = [];
    const reviewFinding = { findings: [{ severity: "material", description: "The authorization choice needs a direct statement.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "Carry the decision into the access boundary." }] };
    const invalidInitialPlan = validPlan();
    invalidInitialPlan.tasks[0]!.requirementIds = ["R99"];
    let finalReport = "";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build refunds. Only named refund managers may approve them.",
        answers: { [questionId]: "Only named refund managers." },
        modelGateway: gateway({
          intake: baseIntake([question]),
          plans: [invalidInitialPlan, validPlan(), validPlan()],
          reviews: [reviewFinding, { findings: [] }],
          onPrompt: (prompt) => observedPrompts.push(prompt),
        }),
        researcher: researcher().value,
        onArtifacts: async (details) => {
          finalReport = renderReport(details);
          return undefined;
        },
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.resolvedAnswers).toEqual([{
          questionId,
          question: question.question,
          whyMaterial: question.whyMaterial,
          answer: "Only named refund managers.",
        }]);
      }
      expect(finalReport).toContain(question.question);
      expect(finalReport).toContain("Only named refund managers.");
      const requiredPrompts = [
        "Select zero to three public repository",
        "Choose up to 20 local or remote",
        "Produce a detailed implementation plan",
        "Repair the prior plan output",
        "Independently review this plan",
        "Repair the current plan",
      ];
      for (const start of requiredPrompts) {
        const prompt = observedPrompts.find((item) => item.startsWith(start));
        expect(prompt).toBeDefined();
        expect(prompt).toContain(question.question);
        expect(prompt).toContain(question.whyMaterial);
        expect(prompt).toContain("Only named refund managers.");
      }
      for (const start of ["Select zero to three public repository", "Choose up to 20 local or remote"]) {
        expectPhaseModules(observedPrompts.find((item) => item.startsWith(start))!, "research");
      }
      for (const start of ["Produce a detailed implementation plan", "Repair the prior plan output", "Repair the current plan"]) {
        expectPhaseModules(observedPrompts.find((item) => item.startsWith(start))!, "planning");
      }
      for (const prompt of observedPrompts.filter((item) => item.startsWith("Independently review this plan"))) {
        expectPhaseModules(prompt, "review");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("repairs a plan whose verification names no wrong implementation and asks each planning turn for them", async () => {
    const cwd = await tempDirectory();
    const missing = validPlan();
    delete missing.tasks[0]!.verification[0]!.rejectsMutants;
    const prompts: string[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [missing, validPlan(), validPlan()],
          reviews: [{ findings: [{ severity: "material", description: "The status check is vague.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "Name the stored status." }] }, { findings: [] }],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("ready");
        expect(outcome.validationHistory).toEqual([{ issue: "T1.verification[1].rejectsMutants must contain 1 to 24 items.", resolved: true }]);
        expect(outcome.plan.tasks[0]!.verification[0]!.rejectsMutants.map((mutant) => mutant.id)).toEqual(["T1-V1-M1"]);
      }
      expect(prompts.find((prompt) => prompt.startsWith("Produce a detailed implementation plan"))).toContain("For every verification, fill rejectsMutants with at least one wrong implementation for each acceptance ID it covers. A wrong implementation is one specific mistake in the code this plan proposes, such as a reversed comparison, a skipped state or permission check, or a missing write. Give the failure its check reports on that mistake: the failing assertion or exact error message for a command, or what the person sees for a manual check. Pick mistakes that change the observable outcome, so the check fails on the mistake alone and passes on the correct code. Nobody has applied these mistakes or run these checks; describe the expected failure, not a result.");
      expect(prompts.find((prompt) => prompt.startsWith("Repair the prior plan output"))).toContain("Every verification needs a rejectsMutants entry for each acceptance ID it covers, and no entry for an ID it does not cover.");
      expect(prompts.find((prompt) => prompt.startsWith("Repair the current plan"))).toContain("When a repair changes a verification, update its rejectsMutants so each covered acceptance ID keeps at least one wrong implementation and the failure the changed check reports on it.");
      // The review repair keeps or adjusts the named wrong implementations, so its current plan carries them.
      const repairPrompt = prompts.find((prompt) => prompt.startsWith("Repair the current plan"))!;
      expect(repairPrompt.slice(repairPrompt.indexOf("\n\nCURRENT PLAN:\n\n"), repairPrompt.indexOf("\n\nBRIEF:\n\n"))).toContain('"rejectsMutants":[{"id":"T1-V1-M1","acceptanceId":"A1","wrongImplementation":"The handler stores the request without a status.","observedFailure":"The stored request shows no pending status."}]');
      expect(prompts.find((prompt) => prompt.startsWith("Produce a detailed implementation plan"))).toContain("The host rejects a plan that breaks any of these limits: a verification names at most 24 wrong implementations; the acceptanceId of each wrong implementation is an A* ID that the same verification lists in coversAcceptanceIds; wrongImplementation and observedFailure each have at most 500 characters; an untestedReason has at most 700 characters; testEvidence cites only excerpts of sources with role test from that comparison's repository at its pinned commit.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("returns an error when initial and bounded validation repair both fail", async () => {
    const cwd = await tempDirectory();
    const invalid = validPlan();
    invalid.tasks[0]!.requirementIds = ["R99"];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [invalid, invalid] }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("error");
      if (outcome.status === "error") expect(outcome.message).toContain("did not produce a usable task map");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("retains the last valid task map Draft if independent-review repair fails", async () => {
    const cwd = await tempDirectory();
    const invalidRepair = validPlan();
    invalidRepair.tasks[0]!.requirementIds = ["R99"];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          plans: [validPlan(), invalidRepair],
          reviews: [{ findings: [{ severity: "material", description: "A material answer is not reflected.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "Honor the clarified constraint." }] }],
        }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("draft");
        expect(outcome.plan.tasks).toHaveLength(1);
        expect(outcome.validationIssues.length).toBeGreaterThan(0);
        // The repair itself failed here, so the note does not say that a repair passed validation.
        expect(outcome.plan.readinessNotes).toContain("The bounded review repair did not complete.");
        expect(outcome.plan.readinessNotes.some((note) => note.startsWith("The bounded review repair passed host validation"))).toBe(false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rebuilds the brief once after an interactive answer and uses it for search, planning, review, and report", async () => {
    const cwd = await tempDirectory();
    const question = { question: "Which event is in scope?", whyMaterial: "This changes ticket inventory and admission." };
    const questionId = parseIntake(baseIntake([question])).materialQuestions[0]!.id;
    const refined = {
      ...baseIntake(),
      summary: "Rebuilt event-admission brief.",
      requirements: [{ description: "Sell tickets and verify event admission.", userWords: null, observableAcceptance: ["A ticket can be sold and scanned."] }],
      domainTerms: ["event admission", "ticket sales"],
      topicSlugs: ["event-ticketing"],
      researchQueries: ["event admission ticketing"],
    };
    const schemas: JsonRecord[] = [];
    const prompts: string[] = [];
    let finalReport = "";
    const refs = researcher();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build an event ticketing system.",
        answerQuestion: async () => "One event; entry is checked by QR scan.",
        modelGateway: gateway({
          intake: baseIntake([question]),
          refined,
          onPrompt: (prompt, schema) => { prompts.push(prompt); schemas.push(schema); },
        }),
        researcher: refs.value,
        onArtifacts: async (details) => { finalReport = renderReport(details); return undefined; },
      });
      expect(outcome.status).toBe("completed");
      const intakeTurns = schemas.filter((schema) => "requirements" in (schema.properties as Record<string, unknown>));
      expect(intakeTurns).toHaveLength(2);
      expect((intakeTurns[1]!.properties as Record<string, { maxItems?: number }>).materialQuestions?.maxItems).toBe(0);
      expect(prompts.find((prompt) => prompt.includes("Rebuild the software brief"))).toContain("One event; entry is checked by QR scan.");
      expect(refs.materials).toEqual([{ phrases: ["event admission", "ticket sales"], topics: ["event-ticketing"] }]);
      expect(prompts.some((prompt) => prompt.startsWith("Produce a detailed implementation plan") && prompt.includes("Rebuilt event-admission brief."))).toBe(true);
      expect(prompts.some((prompt) => prompt.startsWith("Independently review this plan") && prompt.includes("Rebuilt event-admission brief."))).toBe(true);
      expect(finalReport).toContain("**Final plan scope.** Validate and record a refund request.");
      expect(finalReport).toContain("**Clarified brief (after material answers).** Rebuilt event-admission brief.");
      expect(finalReport).toContain("**Initial intake summary (before material answers and source review).** Build a small refund request service.");
      if (outcome.status === "completed") {
        expect(outcome.initialBrief?.summary).toBe("Build a small refund request service.");
        expect(outcome.brief.summary).toBe("Rebuilt event-admission brief.");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rebuilds the brief on a validated --answers rerun", async () => {
    const cwd = await tempDirectory();
    const question = { question: "Which event is in scope?", whyMaterial: "This changes ticket inventory." };
    const priorQuestions = parseIntake(baseIntake([question])).materialQuestions;
    const refined = {
      ...baseIntake(),
      summary: "Clarified ticket and refund brief.",
      domainTerms: ["ticket refund"],
      topicSlugs: ["event-ticketing"],
    };
    const schemas: JsonRecord[] = [];
    const prompts: string[] = [];
    let finalReport = "";
    const refs = researcher();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund service.",
        priorQuestions,
        answers: { [priorQuestions[0]!.id]: "One event with QR admission." },
        modelGateway: gateway({ intake: baseIntake(), refined, onPrompt: (prompt, schema) => { prompts.push(prompt); schemas.push(schema); } }),
        researcher: refs.value,
        onArtifacts: async (details) => { finalReport = renderReport(details); return undefined; },
      });
      expect(outcome.status).toBe("completed");
      expect(schemas.filter((schema) => "requirements" in (schema.properties as Record<string, unknown>))).toHaveLength(2);
      expect(refs.materials[0]).toEqual({ phrases: ["ticket refund"], topics: ["event-ticketing"] });
      expect(prompts.some((prompt) => prompt.startsWith("Produce a detailed implementation plan") && prompt.includes("Clarified ticket and refund brief."))).toBe(true);
      expect(prompts.some((prompt) => prompt.startsWith("Independently review this plan") && prompt.includes("Clarified ticket and refund brief."))).toBe(true);
      expect(finalReport).toContain("**Final plan scope.** Validate and record a refund request.");
      expect(finalReport).toContain("**Clarified brief (after material answers).** Clarified ticket and refund brief.");
      expect(finalReport).toContain("**Initial intake summary (before material answers and source review).** Build a small refund request service.");
      if (outcome.status === "completed") {
        expect(outcome.initialBrief?.materialQuestions).toEqual(priorQuestions);
        expect(outcome.brief.summary).toBe("Clarified ticket and refund brief.");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("asks intake for literal code patterns and carries them into the rebuilt brief", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const question = { question: "Who may approve a refund?", whyMaterial: "This defines the refund authorization boundary." };
    const questionId = parseIntake(baseIntake([question])).materialQuestions[0]!.id;
    const refs = researcher();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build refunds.",
        answers: { [questionId]: "Only refund managers." },
        modelGateway: gateway({
          intake: { ...baseIntake([question]), codePatterns: ["createRefund"] },
          refined: { ...baseIntake(), codePatterns: ["createRefund", "refund_status"] },
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: refs.value,
      });
      expect(outcome.status).toBe("completed");
      expect(prompts[0]).toContain("Supply 1–4 codePatterns: identifiers or lowercase words that source files implementing the core workflow would literally contain, such as OrderRefund, refund_amount, or checkin.");
      expect(prompts[0]).toContain("Use only letters, digits, and underscores, and put the most distinctive pattern first.");
      const rebuild = prompts.find((prompt) => prompt.startsWith("Rebuild the software brief"))!;
      expect(rebuild).toContain("domainTerms, topicSlugs, codePatterns, and researchQueries to reflect those decisions");
      expect(rebuild).toContain("\"codePatterns\":[\"createRefund\"]");
      expect(refs.materials[0]?.codePatterns).toEqual(["createRefund", "refund_status"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("passes code patterns to tree screening and shows host code matches to the model and the report", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const base = repositorySnapshot();
    const one: RepositorySnapshot = {
      ...base,
      candidate: { ...base.candidate, codeMatches: [{ pattern: "OrderRefund", path: "src/index.ts" }] },
      codeMatches: [{ fileId: "C1F1", path: "src/index.ts", patterns: ["createRefund"] }],
    };
    const two = snapshotFor({ ...base.candidate, id: "C2", fullName: "org/two", webUrl: "https://github.com/org/two", codeMatches: [{ pattern: "refund_status", path: "src/index.ts" }] });
    const three: RepositoryCandidate = { ...base.candidate, id: "C3", fullName: "org/three", webUrl: "https://github.com/org/three", codeMatches: [{ pattern: "createRefund", path: "src/index.ts" }] };
    const codeSearch: CodeSearchSummary = {
      queries: [
        { provider: "grep", purpose: "location", query: "refund_status", repository: "org/refunds", status: "ok", resultCount: 0 },
        {
          provider: "grep",
          purpose: "location",
          query: "OrderRefund",
          repository: "org/refunds",
          status: "failed",
          resultCount: 0,
          failure: { provider: "grep", endpoint: "search", category: "http_status", status: 503, attempts: 2, retryRefused: false },
        },
      ],
      requests: 2,
      budget: 12,
      repositoriesMatched: 0,
      repositoriesScreened: 0,
      metadataRequests: 0,
    };
    const discoveryCodeSearch: CodeSearchSummary = {
      queries: [
        { provider: "grep", purpose: "discovery", query: "createRefund", status: "ok", resultCount: 3 },
        { provider: "grep", purpose: "discovery", query: "refund_status", status: "ok", resultCount: 1 },
      ],
      requests: 2,
      budget: 12,
      repositoriesMatched: 2,
      repositoriesScreened: 1,
      metadataRequests: 1,
    };
    const refs = researcher({
      snapshots: [one, two],
      shortlistExcluded: [{ candidate: three, reasons: ["no test file at the pinned commit"] }],
      shortlistCodeSearch: codeSearch,
      discoveryCodeSearch,
    });
    let report = "";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: { ...baseIntake(), codePatterns: ["createRefund", "refund_status"] },
          selection: {
            selected: [{ candidateId: "C1", rationale: "The repository implements refund requests." }],
            rejected: [{ candidateId: "C2", rationale: "It only wraps a payment library." }],
          },
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: refs.value,
        onArtifacts: async (input) => {
          report = renderReport(input);
          return undefined;
        },
      });
      expect(outcome.status).toBe("completed");
      expect(refs.shortlistPatterns).toEqual([["createRefund", "refund_status"]]);
      const selectionPrompt = prompts.find((prompt) => prompt.startsWith("Select zero to three public repository"))!;
      expect(selectionPrompt).toContain("\"codeMatchedFiles\":1");
      expect(selectionPrompt).toContain("\"codePatterns\":[\"createRefund\"]");
      expect(selectionPrompt).toContain("Use them as relevance hints, not as evidence.");
      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to 20 local or remote"))!;
      expect(filePrompt).toContain("\"fileId\":\"C1F1\",\"path\":\"src/index.ts\"");
      expect(filePrompt).toContain("\"codeMatch\":\"createRefund\"");
      expect(filePrompt).toContain("the file is not evidence until the host reads it at the pinned commit.");
      if (outcome.status === "completed") {
        expect(outcome.research?.codeSearch?.requests).toBe(4);
        const choices = new Map(outcome.plan.repositoryChoices.map((choice) => [choice.candidateId, choice.codeMatches]));
        expect(choices.get("C1")).toEqual(["OrderRefund", "createRefund"]);
        expect(choices.get("C2")).toEqual(["refund_status"]);
        expect(choices.get("C3")).toEqual(["createRefund"]);
      }
      const lines = report.split("\n");
      expect(report).toContain("Code search (Grep by Vercel): 4/12 request(s)");
      expect(report).toContain("- grep location `refund_status` in org/refunds — ok; 0 result(s).");
      expect(lines.find((line) => line.startsWith("- Selected [github:org/refunds]"))).toContain("Code search matched `OrderRefund`, `createRefund`.");
      expect(lines.find((line) => line.startsWith("- Rejected [github:org/two]"))).toContain("Code search matched `refund_status`.");
      expect(lines.find((line) => line.startsWith("- Host excluded [github:org/three]"))).toContain("Code search matched `createRefund`.");
      if (outcome.status === "completed") {
        expect(outcome.research?.codeSearch).toMatchObject({
          requests: 4,
          budget: 12,
          repositoriesMatched: 2,
          repositoriesScreened: 1,
          metadataRequests: 1,
        });
        expect(outcome.research?.codeSearch?.queries.map((query) => [query.purpose, query.query, query.status])).toEqual([
          ["discovery", "createRefund", "ok"],
          ["discovery", "refund_status", "ok"],
          ["location", "refund_status", "ok"],
          ["location", "OrderRefund", "failed"],
        ]);
      }
      expect(report).toContain("Code search (Grep by Vercel): 4/12 request(s); 2 repositories matched outside example and documentation paths; 1 new repositories screened with 1 GitHub metadata request(s).");
      expect(report).toContain("- grep location `OrderRefund` in org/refunds — failed (Grep search request failed after one retry: HTTP 503); 0 result(s).");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps non-text code matches out of the file list", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const base = repositorySnapshot();
    const textMatch: TreeFile = { id: "C1F7", path: "src/refund_match.ts", size: 100 };
    const imageMatch: TreeFile = { id: "C1F8", path: "assets/refund-flow.png", size: 100 };
    const snapshot: RepositorySnapshot = {
      ...base,
      files: [...base.files, textMatch, imageMatch],
      codeMatches: [
        { fileId: textMatch.id, path: textMatch.path, patterns: ["OrderRefund"] },
        { fileId: imageMatch.id, path: imageMatch.path, patterns: ["refund_flow"] },
      ],
    };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: { ...baseIntake(), codePatterns: ["OrderRefund", "refund_flow"] },
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher({ snapshots: [snapshot] }).value,
      });

      expect(outcome.status).toBe("completed");
      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to 20 local or remote"))!;
      const actualFileList = filePrompt.split("ACTUAL FILE ID AND PATH LIST:\n\n")[1]?.split("\n\nBEGIN HOST-PROVIDED MODULE")[0] ?? "";
      expect(actualFileList).toContain("\"fileId\":\"C1F7\",\"path\":\"src/refund_match.ts\"");
      expect(actualFileList).toContain("\"codeMatch\":\"OrderRefund\"");
      expect(actualFileList).not.toContain("C1F8");
      expect(actualFileList).not.toContain("assets/refund-flow.png");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("lists a code-matched file even when the path ranking would cut it", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const base = repositorySnapshot();
    const filler: TreeFile[] = Array.from({ length: 850 }, (_, index) => ({ id: `C1X${index + 1}`, path: `src/refund_module_${index}.ts`, size: 100 }));
    const matched: TreeFile = { id: "C1Z1", path: "vendor/legacy/deep/path/refund_hook.ts", size: 100 };
    const snapshot: RepositorySnapshot = {
      ...base,
      files: [...base.files, ...filler, matched],
      codeMatches: [{ fileId: "C1Z1", path: matched.path, patterns: ["refund_hook"] }],
    };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: { ...baseIntake(), codePatterns: ["refund_hook"] },
          fileSelection: { files: [{ fileId: "C1Z1", role: "production", rationale: "Code match." }] },
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher({ snapshots: [snapshot] }).value,
      });
      expect(outcome.status).toBe("completed");
      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to 20 local or remote"))!;
      expect(filePrompt).toContain("\"fileId\":\"C1Z1\",\"path\":\"vendor/legacy/deep/path/refund_hook.ts\"");
      expect(filePrompt).toContain("\"codeMatch\":\"refund_hook\"");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ranks a local definition of a brief code pattern into the plan's excerpts", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      await mkdir(path.join(cwd, "src"), { recursive: true });
      // Two selected files of about 160,000 characters each, so the first one is not kept whole. No line shares a word
      // with the brief; only the code pattern marks line 200.
      const lines = Array.from({ length: 300 }, (_, index) => `const localFiller${index} = ${index};`);
      lines[199] = "export class LedgerSeal { seal() { return \"anchor-marker-7\"; } }";
      const ballast = Array.from({ length: 1_500 }, () => "z".repeat(100)).join("\n");
      await writeFile(path.join(cwd, "src", "ledger.ts"), `${lines.join("\n")}\n${ballast}\n`);
      await writeFile(path.join(cwd, "src", "other.ts"), `export const other = 1;\n${ballast}\n`);
      const local = await scanLocalTree(cwd);
      const ledger = local.files.find((file) => file.path === "src/ledger.ts")!;
      const other = local.files.find((file) => file.path === "src/other.ts")!;
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: { ...baseIntake(), codePatterns: ["LedgerSeal"] },
          fileSelection: {
            files: [
              { fileId: ledger.id, role: "production", rationale: "Local ledger code." },
              { fileId: other.id, role: "production", rationale: "Local helper." },
            ],
          },
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher({ snapshots: [repositorySnapshot()] }).value,
      });

      expect(outcome.status).toBe("completed");
      const planPrompt = prompts.find((prompt) => prompt.startsWith("Produce a detailed implementation plan"))!;
      expect(planPrompt).toContain("anchor-marker-7");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("lists each selected tree once without its file list and gives every file only its own fields", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const snapshot = repositorySnapshot();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: researcher({ snapshots: [snapshot] }).value,
      });

      expect(outcome.status).toBe("completed");
      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to 20 local or remote"))!;
      const trees = filePrompt.split("COMMIT-PINNED TREES:\n\n")[1]!.split("\n\nACTUAL FILE ID AND PATH LIST:")[0]!;
      expect(JSON.parse(trees)).toEqual([
        { candidateId: "C1", source: "github:org/refunds", commitSha: "a".repeat(40), commitDate: "2025-12-01T00:00:00Z", lastActivityAt: "2026-01-01T00:00:00Z", treeTruncated: false },
      ]);
      const list = filePrompt.split("ACTUAL FILE ID AND PATH LIST:\n\n")[1]!.split("\n\nBEGIN HOST-PROVIDED MODULE")[0]!;
      const groups = JSON.parse(list) as Array<{ source: string; files: Array<Record<string, unknown>> }>;
      expect(groups.map((group) => group.source)).toEqual(["local project", "github:org/refunds"]);
      expect(groups[1]!.files.map((file) => file.fileId)).toContain("C1F1");
      expect(groups[1]!.files.every((file) => snapshot.files.some((treeFile) => treeFile.id === file.fileId))).toBe(true);
      for (const file of groups.flatMap((group) => group.files)) {
        expect(Object.keys(file).every((key) => ["fileId", "path", "size", "roleHint", "codeMatch"].includes(key))).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the file list within 300,000 characters, gives each source an equal share and ignores a file the limit left out", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const longTree = (candidate: RepositoryCandidate): RepositorySnapshot => ({
      ...snapshotFor(candidate),
      files: Array.from({ length: 700 }, (_, index) => ({ id: `${candidate.id}L${index + 1}`, path: `src/refund/${"nested/".repeat(40)}refund_handler_${index + 1}.ts`, size: 100 })),
    });
    const second: RepositoryCandidate = { ...repositorySnapshot().candidate, id: "C2", fullName: "org/refund-two", webUrl: "https://github.com/org/refund-two" };
    const snapshots = [longTree(repositorySnapshot().candidate), longTree(second)];
    const groupsOf = (prompt: string) =>
      JSON.parse(prompt.split("ACTUAL FILE ID AND PATH LIST:\n\n")[1]!.split("\n\nBEGIN HOST-PROVIDED MODULE")[0]!) as Array<{ source: string; files: Array<{ fileId: string }> }>;
    const checkpointGaps: ResearchGap[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          selection: { selected: [{ candidateId: "C1", rationale: "Refund handlers." }, { candidateId: "C2", rationale: "More refund handlers." }], rejected: [] },
          onPrompt: (prompt) => prompts.push(prompt),
          turnResult: (kind) => {
            if (kind === "plan") return timedOutTurn();
            if (kind !== "files") return undefined;
            // Choose one offered file and one ranked file that the character limit left out.
            const offered = new Set(groupsOf(prompts.at(-1)!).flatMap((group) => group.files.map((file) => file.fileId)));
            const leftOut = snapshots[1]!.files.find((file) => !offered.has(file.id))!.id;
            const files = [{ fileId: "C1L1", role: "production", rationale: "Handler." }, { fileId: leftOut, role: "production", rationale: "Left out." }];
            return { status: "completed", text: JSON.stringify({ files }), threadId: "thread-1", turnId: "turn-files" };
          },
        }),
        researcher: researcher({ candidates: snapshots.map((snapshot) => snapshot.candidate), snapshots }).value,
        onCheckpoint: async (input) => {
          checkpointGaps.push(...input.gaps);
          return undefined;
        },
      });

      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to 20 local or remote"))!;
      const list = filePrompt.split("ACTUAL FILE ID AND PATH LIST:\n\n")[1]!.split("\n\nBEGIN HOST-PROVIDED MODULE")[0]!;
      const groups = groupsOf(filePrompt);
      const share = Math.floor((300_000 - groups.length - 1) / groups.length);
      expect(list.length).toBeLessThanOrEqual(300_000);
      expect(groups.map((group) => group.source)).toEqual(["local project", "github:org/refunds", "github:org/refund-two"]);
      for (const group of groups.slice(1)) {
        expect(JSON.stringify(group).length).toBeLessThanOrEqual(share);
        expect(JSON.stringify(group).length).toBeGreaterThan(share - 500);
      }
      const offered = groups.reduce((count, group) => count + group.files.length, 0);
      expect(outcome.status).toBe("timed_out");
      expect(checkpointGaps).toContainEqual({ kind: "file", material: false, message: `The file list for model selection left out ${1_400 - offered} lower-ranked files to stay within 300,000 characters.` });
      expect(checkpointGaps).toContainEqual({ kind: "file", material: false, message: "The model chose 1 file ID(s) that were not offered or were repeated; the host ignored them." });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ignores file IDs that were not offered or were repeated, records a gap and continues", async () => {
    const cwd = await tempDirectory();
    const progressMessages: string[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          fileSelection: {
            files: [
              { fileId: "C1F1", role: "production", rationale: "Main handler." },
              { fileId: "C1F99", role: "production", rationale: "Not in the tree." },
              { fileId: "C1F1", role: "production", rationale: "Repeated." },
            ],
          },
        }),
        researcher: researcher({ snapshots: [repositorySnapshot()] }).value,
        onProgress: (event) => progressMessages.push(event.message),
      });

      expect(outcome.status).toBe("completed");
      expect(progressMessages).toContain("Selected 1 source files for bounded reads.");
      if (outcome.status === "completed") {
        expect(outcome.gaps).toContainEqual({ kind: "file", material: false, message: "The model chose 2 file ID(s) that were not offered or were repeated; the host ignored them." });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not make a refine turn when no material answer was resolved", async () => {
    const cwd = await tempDirectory();
    const schemas: JsonRecord[] = [];
    try {
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), onPrompt: (_prompt, schema) => schemas.push(schema) }),
        researcher: researcher().value,
      });
      expect(schemas.filter((schema) => "requirements" in (schema.properties as Record<string, unknown>))).toHaveLength(1);
      expect(schemas.filter((schema) => ((schema.properties as Record<string, any>).materialQuestions?.maxItems === 0))).toHaveLength(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the initial brief and records a material gap when the rebuild adds a question", async () => {
    const cwd = await tempDirectory();
    const question = { question: "Which event is in scope?", whyMaterial: "This changes ticket inventory." };
    const badRefined = {
      ...baseIntake(),
      summary: "The model tried to add another round.",
      materialQuestions: [{ question: "Which ticket currency?", whyMaterial: "This changes payment handling." }],
    };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        answers: { [parseIntake(baseIntake([question])).materialQuestions[0]!.id]: "One event." },
        modelGateway: gateway({ intake: baseIntake([question]), refined: badRefined }),
        researcher: researcher().value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.brief.summary).toBe("Build a small refund request service.");
        expect(outcome.gaps.some((gap) => gap.kind === "validation" && gap.material && gap.message.includes("could not be rebuilt"))).toBe(true);
        expect(outcome.readiness).toBe("draft");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("evidence requests", () => {
  // About 230,000 characters in lines of about 100 characters. No line shares a word with the brief.
  async function writeLedger(cwd: string, extra: (lines: string[]) => void = () => {}): Promise<TreeFile> {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const lines = Array.from({ length: 2_300 }, (_, index) => `const ledgerFiller${String(index).padStart(4, "0")} = "${"z".repeat(70)}";`);
    extra(lines);
    await writeFile(path.join(cwd, "src", "ledger.ts"), `${lines.join("\n")}\n`);
    return (await scanLocalTree(cwd)).files.find((file) => file.path === "src/ledger.ts")!;
  }

  test("asks for missing source after the reads and gives the plan the added excerpt", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const sessions: number[] = [];
    const events: ProgressEvent[] = [];
    const checkpointTexts: string[] = [];
    let ledgerSourceId = "";
    try {
      const ledger = await writeLedger(cwd, (lines) => {
        lines[1_999] = "export function settleLedger() {";
        lines[2_000] = '  return "settle-ledger-marker";';
        lines[2_001] = "}";
      });
      await writeFile(path.join(cwd, "src", "notes.ts"), "export const notes = 1;\n");
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          fileSelection: { files: [{ fileId: ledger.id, role: "production", rationale: "Local ledger code." }] },
          evidenceRequests: (prompt: string) => {
            const counts = JSON.parse(prompt.split("SOURCE LINE COUNTS:\n\n")[1]!.split("\n\nUNREAD FILE ID AND PATH LIST:")[0]!) as Array<{ sourceId: string; path: string }>;
            const sourceId = counts.find((entry) => entry.path === "src/ledger.ts")!.sourceId;
            ledgerSourceId = sourceId;
            return {
              requests: [
                { kind: "definition", id: sourceId, name: "settleLedger", startLine: 0, endLine: 0, reason: "The plan needs the settlement." },
                // Lines that the first excerpts already hold: served, nothing added.
                { kind: "lines", id: sourceId, name: "", startLine: 1, endLine: 10, reason: "The plan needs the start." },
                { kind: "definition", id: sourceId, name: "missingThing", startLine: 0, endLine: 0, reason: "The plan needs it." },
              ],
            };
          },
          onPrompt: (prompt, _schema, session) => {
            prompts.push(prompt);
            sessions.push(session);
          },
        }),
        researcher: researcher().value,
        onProgress: (event) => events.push(event),
        onCheckpoint: async (input, stage) => {
          if (stage === "evidence") checkpointTexts.push(...input.evidence.excerpts.map((excerpt) => excerpt.text));
          return undefined;
        },
      });

      expect(outcome.status).toBe("completed");
      expect(checkpointTexts.some((text) => text.includes("settle-ledger-marker"))).toBe(true);
      const requestIndex = prompts.findIndex((prompt) => prompt.startsWith("Before the plan is written"));
      const planIndex = prompts.findIndex((prompt) => prompt.startsWith("Produce a detailed implementation plan"));
      expect(requestIndex).toBeGreaterThan(-1);
      expect(planIndex).toBeGreaterThan(requestIndex);
      expect(prompts[requestIndex]).not.toContain("settle-ledger-marker");
      expect(prompts[requestIndex]).toContain("ledgerFiller0000");
      expect(prompts[requestIndex]).toContain("Ask first for the unread files and definitions that the plan would otherwise list as missing context.");
      expect(prompts[planIndex]).toContain("settle-ledger-marker");
      expectPhaseModules(prompts[requestIndex]!, "research");
      expect(sessions[requestIndex]).toBe(sessions[planIndex]!);
      if (outcome.status === "completed") {
        expect(outcome.gaps).toContainEqual({ kind: "file", material: false, message: `The model asked for missingThing in ${ledgerSourceId}; no line of src/ledger.ts holds missingThing.` });
      }
      const unread = prompts[requestIndex]!.split("UNREAD FILE ID AND PATH LIST:\n\n")[1]!.split("\n\nHOST-CREATED SOURCE REGISTRY")[0]!;
      expect(unread).toContain("\"path\":\"src/notes.ts\"");
      expect(unread).not.toContain("\"path\":\"src/ledger.ts\"");
      expect(events.filter((event) => event.stage === "evidence_requests").map((event) => [event.state, event.message])).toEqual([
        ["started", "Asking the model which source the plan needs beyond the excerpts."],
        ["completed", "Added 1 excerpts for 2 of 3 requests."],
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps 40,000 characters of the excerpt budget for requested source", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      // With no comparator, the ledger is the only planned file: whole within 260,000 characters, not within 220,000.
      const ledger = await writeLedger(cwd);
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          fileSelection: { files: [{ fileId: ledger.id, role: "production", rationale: "Local ledger code." }] },
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher({ snapshots: [], candidates: [] }).value,
      });

      const requestPrompt = prompts.find((prompt) => prompt.startsWith("Before the plan is written"))!;
      expect(Number(/fit in (\d+) characters/.exec(requestPrompt)![1])).toBeGreaterThanOrEqual(40_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("lists at most 40,000 characters of unread files, without the files already read", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      const base = repositorySnapshot();
      const filler: TreeFile[] = Array.from({ length: 1_000 }, (_, index) => ({ id: `C1M${index + 1}`, path: `src/refund_module_${index}.ts`, size: 100 }));
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: researcher({ snapshots: [{ ...base, files: [...base.files, ...filler] }] }).value,
      });

      const requestPrompt = prompts.find((prompt) => prompt.startsWith("Before the plan is written"))!;
      const unread = requestPrompt.split("UNREAD FILE ID AND PATH LIST:\n\n")[1]!.split("\n\nHOST-CREATED SOURCE REGISTRY")[0]!;
      expect(unread.length).toBeLessThanOrEqual(40_000);
      // Each group, the local project and the tree, fills at most an equal share.
      const groups = JSON.parse(unread) as Array<{ source: string; files: unknown[] }>;
      const share = Math.floor((40_000 - groups.length - 1) / groups.length);
      for (const group of groups) expect(JSON.stringify(group).length).toBeLessThanOrEqual(share);
      expect(unread).toContain("\"fileId\":\"C1M");
      expect(unread).not.toContain("\"fileId\":\"C1F1\"");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("counts a comparator file that a request adds as comparator source", async () => {
    const cwd = await tempDirectory();
    try {
      const base = repositorySnapshot();
      const extra: TreeFile = { id: "C1F7", path: "src/extra.ts", size: 100 };
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: baseIntake(),
          evidenceRequests: { requests: [{ kind: "file", id: "C1F7", name: "", startLine: 0, endLine: 0, reason: "The comparator's production code." }] },
          plans: [validPlan("E1", null)],
        }),
        // The first reads of the comparator's production and test files fail, so only the requested file is its code.
        researcher: researcher({ snapshots: [{ ...base, files: [...base.files, extra] }], failPaths: ["src/index.ts", "tests/index.test.ts"] }).value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") expect(outcome.research?.trustworthyReferenceFound).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("gives a requested file the brief's code patterns", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      const base = repositorySnapshot();
      // A remote file of about 300,000 characters: larger than what is left, so only its head and the pattern line fit.
      const lines = Array.from({ length: 3_000 }, (_, index) => `const remoteFiller${String(index).padStart(4, "0")} = "${"z".repeat(70)}";`);
      lines[2_499] = 'export class LedgerSeal { seal() { return "remote-seal-marker"; } }';
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({
          intake: { ...baseIntake(), codePatterns: ["LedgerSeal"] },
          evidenceRequests: { requests: [{ kind: "file", id: "C1F7", name: "", startLine: 0, endLine: 0, reason: "The comparator's seal code." }] },
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher({ snapshots: [{ ...base, files: [...base.files, { id: "C1F7", path: "src/seal.ts", size: 300_000 }] }], content: { "src/seal.ts": `${lines.join("\n")}\n` } }).value,
      });

      expect(outcome.status).toBe("completed");
      expect(prompts.find((prompt) => prompt.startsWith("Produce a detailed implementation plan"))).toContain("remote-seal-marker");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("stops before the plan when the evidence request turn is interrupted or asks for input", async () => {
    const results: Array<[ModelTurnResult, "interrupted" | "needs_input"]> = [
      [{ status: "interrupted", message: "The run was interrupted." }, "interrupted"],
      [{ status: "needs_input", questions: [{ id: "Q1", question: "Which ledger holds refunds?" }] }, "needs_input"],
    ];
    for (const [result, status] of results) {
      const cwd = await tempDirectory();
      const prompts: string[] = [];
      try {
        const outcome = await runWorkflow({
          cwd,
          requirement: "Build a refund request service.",
          modelGateway: gateway({ intake: baseIntake(), turnResult: (kind) => (kind === "requests" ? result : undefined), onPrompt: (prompt) => prompts.push(prompt) }),
          researcher: researcher().value,
        });

        expect(outcome.status).toBe(status);
        expect(prompts.some((prompt) => prompt.startsWith("Produce a detailed implementation plan"))).toBe(false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  test("plans with the first excerpts when the evidence request turn fails", async () => {
    const cwd = await tempDirectory();
    const events: ProgressEvent[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), turnResult: (kind) => (kind === "requests" ? { status: "failed", message: "Codex turn ended with status failed." } : undefined) }),
        researcher: researcher().value,
        onProgress: (event) => events.push(event),
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.gaps).toContainEqual({ kind: "file", material: false, message: "The model's requests for more source failed, so the plan uses the first excerpts." });
        // The flag comes from the first excerpts, which hold the comparator's production code.
        expect(outcome.research?.trustworthyReferenceFound).toBe(true);
      }
      expect(events.filter((event) => event.stage === "evidence_requests").map((event) => event.state)).toEqual(["started", "warning"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("continues with a new planning session after an evidence request timeout disposes the session", async () => {
    const cwd = await tempDirectory();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), disposeOnTimeout: true, turnResult: (kind) => (kind === "requests" ? timedOutTurn() : undefined) }),
        researcher: researcher().value,
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.gaps.some((gap) => !gap.material && gap.message.startsWith("The model's requests for more source failed, so the plan uses the first excerpts. "))).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("brief approval", () => {
  const question = { question: "Which event is in scope?", whyMaterial: "This changes ticket inventory and admission." };
  const refined = {
    ...baseIntake(),
    summary: "Rebuilt event-admission brief.",
    requirements: [{ description: "Sell tickets and verify event admission.", userWords: null, observableAcceptance: ["A ticket can be sold and scanned."] }],
  };
  const completeFiles = { files: [{ fileId: "C1F1", role: "production", rationale: "Handler." }, { fileId: "C1F2", role: "test", rationale: "Tests." }] };

  test("a protocol failure at the readiness preview or final save boundary prevents final artifact publication", async () => {
    for (const boundary of ["readiness preview", "final plan checkpoint", "save started"]) {
      const cwd = await tempDirectory();
      const input = new PassThrough();
      const controller = new AbortController();
      const protocol = createAgentProtocol({ input, controller, write: () => undefined });
      let published = false;
      let checkpoints = 0;
      let aborted = false;
      const abort = () => { aborted = true; input.write("malformed agent input\n"); };
      try {
        const outcome = await runWorkflow({
          cwd, requirement: "Build a refund request service.", signal: controller.signal,
          modelGateway: gateway({ intake: baseIntake(), fileSelection: completeFiles }), researcher: researcher().value,
          approveBrief: async () => true, approvalVia: "agent",
          onCheckpoint: async (_value, stage) => {
            if (stage === "plan") checkpoints += 1;
            if (boundary === "final plan checkpoint" && checkpoints === 2 && !aborted) abort();
            return undefined;
          },
          onPreview: async (preview) => {
            if (boundary === "readiness preview" && preview.stages.find((stage) => stage.id === "readiness")?.status === "completed") abort();
          },
          onProgress: (event) => { if (boundary === "save started" && event.stage === "save" && event.state === "started") abort(); },
          onArtifacts: async () => { published = true; return undefined; },
        });
        expect(aborted, boundary).toBe(true);
        expect(outcome.status, boundary).toBe("interrupted");
        expect(protocol.failure()?.code, boundary).toBe("agent_protocol_error");
        expect(published, boundary).toBe(false);
      } finally { protocol.close(); input.destroy(); await rm(cwd, { recursive: true, force: true }); }
    }
  });

  test("agent gate failures abort before brief research or preview tree checks and close the model session", async () => {
    for (const gate of ["material_answers", "brief_approval", "preview_confirmation"]) {
      const cwd = await tempDirectory();
      const input = new PassThrough();
      const controller = new AbortController();
      const refs = researcher();
      const base = gateway({ intake: baseIntake(gate === "material_answers" ? [question] : []) });
      let closed = 0;
      const modelGateway: ModelGateway = { createSession: () => {
        const session = base.createSession();
        return { ...session, close: async () => { closed += 1; await session.close(); } };
      } };
      const protocol = createAgentProtocol({ input, controller, write: (line) => {
        const request = JSON.parse(line);
        input.write(`${JSON.stringify({ type: "input_response", requestId: request.kind === gate ? "stale-host-id" : request.requestId, approved: true })}\n`);
      } });
      try {
        const outcome = await runWorkflow({
          cwd, requirement: "Build a refund request service.", signal: controller.signal, modelGateway, researcher: refs.value,
          answerQuestions: protocol.answerQuestions, approveBrief: protocol.approveBrief, approvalVia: "agent",
          confirmPreview: (preview) => protocol.confirmPreview(preview, "/published/preview.html"),
        });
        expect(outcome.status, gate).toBe("interrupted");
        expect(protocol.failure()?.code, gate).toBe("agent_protocol_error");
        expect(refs.searches, gate).toBe(gate === "preview_confirmation" ? 1 : 0);
        expect(refs.shortlistInputs, gate).toEqual([]);
        expect(closed, gate).toBe(1);
      } finally { protocol.close(); input.destroy(); await rm(cwd, { recursive: true, force: true }); }
    }
  });

  test("batches only missing answers in question order before rebuilding and records agent approval with the host hash and clock", async () => {
    const cwd = await tempDirectory();
    const questions = [question, { question: "Who issues refunds?", whyMaterial: "This sets the permission boundary." }, { question: "Which currency is accepted?", whyMaterial: "This sets amount validation." }];
    const parsed = parseIntake(baseIntake(questions));
    const refs = researcher();
    const prompts: string[] = [];
    let batches = 0;
    const requestedIds: string[][] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build an event ticketing system.",
        answers: { [parsed.materialQuestions[1]!.id]: " Managers " },
        answerQuestion: async () => { throw new Error("The single-question callback must not be used."); },
        answerQuestions: async (missing) => {
          batches += 1;
          requestedIds.push(missing.map((question) => question.id));
          expect(refs.searches).toBe(0);
          return { [parsed.materialQuestions[2]!.id]: " USD ", [parsed.materialQuestions[0]!.id]: " One event " };
        },
        approvalVia: "agent",
        approveBrief: async (brief) => {
          expect(batches).toBe(1);
          expect(brief.summary).toBe(refined.summary);
          expect(refs.searches).toBe(0);
          return true;
        },
        now: () => new Date("2026-10-29T09:30:00.000Z"),
        modelGateway: gateway({ intake: baseIntake(questions), refined, fileSelection: completeFiles, onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: refs.value,
      });
      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(batches).toBe(1);
      expect(requestedIds).toEqual([[parsed.materialQuestions[0]!.id, parsed.materialQuestions[2]!.id]]);
      expect(outcome.resolvedAnswers.map((answer) => answer.answer)).toEqual(["One event", "Managers", "USD"]);
      expect(outcome.readiness).toBe("ready");
      expect(outcome.briefApproval).toEqual({ via: "agent", approvedAt: "2026-10-29T09:30:00.000Z", briefSha256: briefSha256(outcome.brief) });
      expect(prompts.some((prompt) => prompt.includes("the host recorded approved true through the agent protocol and cannot verify who approved the brief"))).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("keeps a complete plan Draft with the unapproved-brief note when no person approved the brief", async () => {
    const cwd = await tempDirectory();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), fileSelection: completeFiles }),
        researcher: researcher().value,
      });
      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(outcome.readiness).toBe("draft");
      expect(outcome.briefApproval).toBeUndefined();
      expect(outcome.plan.readinessNotes).toEqual([UNAPPROVED_BRIEF_NOTE]);
      expect(UNAPPROVED_BRIEF_NOTE).toBe("No person approved the brief's requirements and acceptance criteria before reference research.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("asks a person to approve the rebuilt brief after the answers and before the local scan and records the approval", async () => {
    const cwd = await tempDirectory();
    const order: string[] = [];
    const checkpoints: Array<[string, BriefApproval | undefined]> = [];
    const messages: string[] = [];
    let shown: IntakeBrief | undefined;
    const refs = researcher();
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build an event ticketing system.",
        answerQuestion: async () => { order.push("answer"); return "One event; entry is checked by QR scan."; },
        approveBrief: async (brief) => { order.push(`approve after ${refs.searches} searches`); shown = brief; return true; },
        now: () => new Date("2026-10-25T09:30:00.000Z"),
        modelGateway: gateway({ intake: baseIntake([question]), refined }),
        researcher: refs.value,
        onProgress: (event) => {
          messages.push(event.message);
          if (event.stage === "local_baseline" && event.state === "started") order.push("local scan");
        },
        onCheckpoint: async (input, stage) => { checkpoints.push([stage, input.briefApproval]); return undefined; },
      });
      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(order).toEqual(["answer", "approve after 0 searches", "local scan"]);
      expect(shown?.summary).toBe("Rebuilt event-admission brief.");
      const approval: BriefApproval = { briefSha256: briefSha256(outcome.brief), via: "tty", approvedAt: "2026-10-25T09:30:00.000Z" };
      expect(outcome.briefApproval).toEqual(approval);
      expect(checkpoints[0]).toEqual(["evidence", approval]);
      // The host saw a yes typed at the prompt; it cannot tell that a person typed it.
      expect(messages).toContain("The brief was approved: yes was typed at the terminal prompt.");
      expect(messages.filter((message) => /person approved/i.test(message))).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ends as needs_input with the brief and its answers, before any search, when the person does not approve", async () => {
    const cwd = await tempDirectory();
    const questionId = parseIntake(baseIntake([question])).materialQuestions[0]!.id;
    const refs = researcher();
    let localScan = false;
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build an event ticketing system.",
        answerQuestion: async () => "One event; entry is checked by QR scan.",
        approveBrief: async () => false,
        modelGateway: gateway({ intake: baseIntake([question]), refined }),
        researcher: refs.value,
        onProgress: (event) => { if (event.stage === "local_baseline") localScan = true; },
      });
      expect(outcome).toEqual({
        status: "needs_input",
        questions: [],
        brief: expect.objectContaining({ summary: "Rebuilt event-admission brief." }),
        approvalRequested: true,
        resolvedAnswers: [{ questionId, question: question.question, whyMaterial: question.whyMaterial, answer: "One event; entry is checked by QR scan." }],
      });
      expect(refs.searches).toBe(0);
      expect(localScan).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ends as interrupted, not needs_input, when the run is aborted at a material question or at the approval prompt", async () => {
    const cwd = await tempDirectory();
    try {
      const atQuestion = new AbortController();
      const questionOutcome = await runWorkflow({
        cwd,
        requirement: "Build an event ticketing system.",
        answerQuestion: async () => { atQuestion.abort(); return ""; },
        signal: atQuestion.signal,
        modelGateway: gateway({ intake: baseIntake([question]), refined }),
        researcher: researcher().value,
      });
      expect(questionOutcome.status).toBe("interrupted");

      // The prompt may return a refusal after the abort, or reject with the abort.
      const endings: Array<(controller: AbortController) => Promise<boolean>> = [
        async (controller) => { controller.abort(); return false; },
        async (controller) => { controller.abort(); throw controller.signal.reason; },
      ];
      for (const ending of endings) {
        const controller = new AbortController();
        const refs = researcher();
        const outcome = await runWorkflow({
          cwd,
          requirement: "Build an event ticketing system.",
          answerQuestion: async () => "One event; entry is checked by QR scan.",
          approveBrief: () => ending(controller),
          signal: controller.signal,
          modelGateway: gateway({ intake: baseIntake([question]), refined }),
          researcher: refs.value,
        });
        expect(outcome.status).toBe("interrupted");
        expect(refs.searches).toBe(0);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("plans from a brief approved in the answers file without intake, answer or rebuild turns and can reach Ready", async () => {
    const cwd = await tempDirectory();
    const questions = parseIntake(baseIntake([question])).materialQuestions;
    const resolvedAnswers = [{ questionId: questions[0]!.id, question: question.question, whyMaterial: question.whyMaterial, answer: "Only the spring refund window." }];
    const requirement = "Build a refund request service.";
    const brief = parseApprovedBrief(editableBrief(parseIntake(baseIntake())), questions, [requirement, resolvedAnswers[0]!.answer]);
    const approval: BriefApproval = { briefSha256: briefSha256(brief), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" };
    const schemas: JsonRecord[] = [];
    const prompts: string[] = [];
    let asked = 0;
    let artifactApproval: BriefApproval | undefined;
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approvedBrief: { brief, resolvedAnswers, approval },
        answerQuestion: async () => { asked += 1; return "An answer nobody asked for."; },
        approveBrief: async () => { asked += 1; return false; },
        modelGateway: gateway({ intake: { summary: "" }, fileSelection: completeFiles, onPrompt: (prompt, schema) => { prompts.push(prompt); schemas.push(schema); } }),
        researcher: researcher().value,
        onArtifacts: async (input) => { artifactApproval = input.briefApproval; return undefined; },
      });
      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(schemas.filter((schema) => "requirements" in (schema.properties as Record<string, unknown>))).toHaveLength(0);
      expect(asked).toBe(0);
      expect(outcome.brief).toBe(brief);
      expect(outcome.resolvedAnswers).toEqual(resolvedAnswers);
      expect(prompts.find((prompt) => prompt.startsWith("Produce a detailed implementation plan"))).toContain("Only the spring refund window.");
      expect(outcome.briefApproval).toEqual(approval);
      expect(artifactApproval).toEqual(approval);
      expect(outcome.gaps).toContainEqual({ kind: "validation", material: false, message: "Inferred requirements (no quote of the user's words was found in the requirement or the confirmed answers): R1." });
      expect(outcome.readiness).toBe("ready");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tells the planner, both reviewers and the review repair the approval the host recorded and leaves its Draft to the host", async () => {
    const statuses = {
      none: "Brief approval: no person has approved this brief yet, and the host keeps the plan Draft for that itself; the host handles this, so do not set shouldDraft or report a finding about brief approval.",
      tty: "Brief approval: the host recorded the brief as approved by a yes typed at the interactive terminal prompt; the host handles this, so do not set shouldDraft or report a finding about brief approval.",
      answers_file: "Brief approval: the host recorded the brief as approved by approveBrief true in the answers file; the host handles this, so do not set shouldDraft or report a finding about brief approval.",
    };
    const unchecked = { acceptanceId: "A1", wrongImplementation: "Stores the request with status approved instead of pending.", whyPlannedChecksPass: "The only check inspects that a request was stored, not its status.", decisionNeeded: null };
    const requirement = "Build a refund request service.";
    const approvedBrief = parseApprovedBrief(editableBrief(parseIntake(baseIntake())), [], [requirement]);
    const routes: Array<[keyof typeof statuses, Partial<Parameters<typeof runWorkflow>[0]>]> = [
      ["none", {}],
      ["tty", { approveBrief: async () => true }],
      ["answers_file", { approvedBrief: { brief: approvedBrief, resolvedAnswers: [], approval: { briefSha256: briefSha256(approvedBrief), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" } } }],
    ];
    const cwd = await tempDirectory();
    try {
      for (const [route, approval] of routes) {
        const prompts: string[] = [];
        const outcome = await runWorkflow({
          cwd,
          requirement,
          ...approval,
          modelGateway: gateway({
            intake: baseIntake(),
            fileSelection: completeFiles,
            reviews: [{ findings: [], survivingMutants: [unchecked] }, { findings: [], survivingMutants: [] }],
            onPrompt: (prompt) => prompts.push(prompt),
          }),
          researcher: researcher().value,
        });
        if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
        const turns = prompts.filter((prompt) => ["Produce a detailed implementation plan", "Independently review this plan", "Repair the current plan"].some((start) => prompt.startsWith(start)));
        expect(turns.map((prompt) => prompt.slice(0, 20))).toEqual(["Produce a detailed i", "Independently review", "Repair the current p", "Independently review"]);
        for (const prompt of turns) {
          for (const [status, sentence] of Object.entries(statuses)) {
            if (status === route) expect(prompt).toContain(sentence);
            else expect(prompt).not.toContain(sentence);
          }
        }
        expect(outcome.readiness).toBe(route === "none" ? "draft" : "ready");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("labels intake requirements against the requirement and rebuilt ones against the confirmed answers", async () => {
    const cwd = await tempDirectory();
    const intake = { ...baseIntake([question]), requirements: [{ description: "Record refund requests.", userWords: "record refund requests", observableAcceptance: ["A request has an amount and status."] }] };
    const answeredRebuild = { ...baseIntake(), requirements: [{ description: "Check entry by QR scan.", userWords: "entry is checked by QR scan", observableAcceptance: ["A request has an amount and status."] }] };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a service to record refund requests.",
        answerQuestion: async () => "One event; entry is checked by QR scan.",
        modelGateway: gateway({ intake, refined: answeredRebuild }),
        researcher: researcher().value,
      });
      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(outcome.initialBrief?.requirements[0]).toMatchObject({ origin: "stated", userWords: "record refund requests" });
      expect(outcome.brief.requirements[0]).toMatchObject({ origin: "stated", userWords: "entry is checked by QR scan" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tells intake and the rebuild to copy the user's words into userWords or set it to null", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      await runWorkflow({
        cwd,
        requirement: "Build an event ticketing system.",
        answerQuestion: async () => "One event.",
        modelGateway: gateway({ intake: baseIntake([question]), refined, onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: researcher().value,
      });
      expect(prompts[0]).toContain("For each requirement, set userWords to the words of the USER REQUIREMENT that state it, copied character for character, or to null when you inferred the requirement.");
      expect(prompts.find((prompt) => prompt.startsWith("Rebuild the software brief"))).toContain("For each requirement, set userWords to the words of the USER REQUIREMENT or of one confirmed answer that state it, copied character for character, or to null when the requirement is inferred.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("surviving mutants from independent review", () => {
  const unchecked = { acceptanceId: "A1", wrongImplementation: "Stores the request with status approved instead of pending.", whyPlannedChecksPass: "The only check inspects that a request was stored, not its status.", decisionNeeded: null };
  const stillUnchecked = { acceptanceId: "A1", wrongImplementation: "Stores a negative amount as a pending request.", whyPlannedChecksPass: "No check submits a negative amount.", decisionNeeded: null };
  const needsDecision = { acceptanceId: "A1", wrongImplementation: "Stores a request for more than the order total as pending.", whyPlannedChecksPass: "No check submits an amount above the order total.", decisionNeeded: "May a refund request exceed the order total, for example to cover shipping?" };
  const openDecisionStart = "Open decision for A1 (\"A request has an amount and status.\"): May a refund request exceed the order total, for example to cover shipping? The planner did not make this choice. To settle it, ";
  // The note of a terminal-approved run, which saved no answers file.
  const openDecisionNote = `${openDecisionStart}rerun unshit and reply anything but yes when it asks you to approve the brief; it saves the brief in an answers file, where you write the decision, set approveBrief to true and rerun with --answers.`;
  const survivingNotePrefix = "Independent review found a wrong implementation";
  const unreviewedRepairNote = "The bounded review repair passed host validation, but the follow-up review of the repaired plan did not complete, so no completed review covers this plan; the first review's findings and surviving mutants describe the plan before the repair.";

  function repairFindings(prompt: string): Array<{ severity: string; description: string; requirementIds: string[]; evidence: unknown[]; suggestedCorrection: string }> {
    return JSON.parse(prompt.split("FINDINGS:\n\n")[1]!.split("\n\nORIGINAL USER REQUIREMENT:")[0]!);
  }

  test("repairs a surviving mutant that needs no decision as a material finding and clears it after a clean review", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const events: ProgressEvent[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [{ findings: [], survivingMutants: [unchecked] }, { findings: [], survivingMutants: [] }],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher().value,
        onProgress: (event) => events.push(event),
      });

      const repairPrompt = prompts.find((prompt) => prompt.startsWith("Repair the current plan"));
      expect(repairPrompt).toBeDefined();
      const findings = repairFindings(repairPrompt!);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: "material", requirementIds: ["R1"], evidence: [] });
      expect(findings[0]!.description).toContain(unchecked.wrongImplementation);
      expect(findings[0]!.description).toContain(unchecked.whyPlannedChecksPass);
      expect(events.map((event) => event.message)).toContain("Repairing 1 independent review finding(s) once.");
      expect(events.map((event) => event.message)).toContain("Independent review recorded 0 finding(s) and 1 surviving mutant(s).");
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.reviews.map((review) => review.survivingMutants.length)).toEqual([1, 0]);
        expect(outcome.readiness).toBe("ready");
        expect(outcome.plan.readinessNotes.some((note) => note.startsWith(survivingNotePrefix))).toBe(false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps a surviving mutant from the review after the repair in its record without keeping the plan Draft", async () => {
    const cwd = await tempDirectory();
    const events: ProgressEvent[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [{ findings: [], survivingMutants: [unchecked] }, { findings: [], survivingMutants: [stillUnchecked] }],
        }),
        researcher: researcher().value,
        onProgress: (event) => events.push(event),
      });

      expect(events.map((event) => event.message)).toContain("Independent review recorded 0 finding(s) and 2 surviving mutant(s).");
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("ready");
        expect(outcome.plan.readinessNotes.some((note) => note.startsWith(survivingNotePrefix))).toBe(false);
        expect(outcome.reviews.map((review) => review.survivingMutants.map((mutant) => mutant.wrongImplementation))).toEqual([[unchecked.wrongImplementation], [stillUnchecked.wrongImplementation]]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps a surviving mutant that needs a decision out of the repair and lists it as an open decision", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [{ findings: [], survivingMutants: [needsDecision] }],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher().value,
      });

      expect(prompts.some((prompt) => prompt.startsWith("Repair the current plan"))).toBe(false);
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.reviews).toHaveLength(1);
        expect(outcome.readiness).toBe("draft");
        expect(outcome.plan.readinessNotes).toContain(openDecisionNote);
        expect(outcome.plan.readinessNotes.some((note) => note.startsWith(survivingNotePrefix))).toBe(false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("lists an open decision from the first review when the review after the repair is clean", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const finding = { severity: "material", description: "The pending status rule is missing.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "State the pending status rule." };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [{ findings: [finding], survivingMutants: [needsDecision] }, { findings: [], survivingMutants: [] }],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher().value,
      });

      const repairPrompt = prompts.find((prompt) => prompt.startsWith("Repair the current plan"));
      expect(repairFindings(repairPrompt!)).toEqual([finding]);
      expect(repairPrompt).not.toContain(needsDecision.wrongImplementation);
      expect(repairPrompt).not.toContain(needsDecision.decisionNeeded);
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.reviews).toHaveLength(2);
        expect(outcome.readiness).toBe("draft");
        expect(outcome.plan.readinessNotes).toContain(openDecisionNote);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("asks the reviewer for one wrong implementation per acceptance criterion and for the decision it needs", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    try {
      await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), onPrompt: (prompt) => prompts.push(prompt) }),
        researcher: researcher().value,
      });

      const reviewPrompt = prompts.find((prompt) => prompt.startsWith("Independently review this plan"));
      // The reviewer reports a surviving named mutant by its ID, so the plan it reviews carries the host-numbered mutants.
      expect(reviewPrompt!.slice(reviewPrompt!.indexOf("\n\nPLAN:\n\n"), reviewPrompt!.indexOf("\n\nHOST-CREATED SOURCE REGISTRY"))).toContain('"rejectsMutants":[{"id":"T1-V1-M1","acceptanceId":"A1","wrongImplementation":"The handler stores the request without a status.","observedFailure":"The stored request shows no pending status."}]');
      expect(reviewPrompt).toContain("Then try to falsify each acceptance criterion A*: construct one plausible wrong implementation that every planned check covering it would still pass, including the rejected mutants that the checks name.");
      expect(reviewPrompt).toContain("Construct the counterexample first; do not argue that the checks are sufficient.");
      expect(reviewPrompt).toContain("A named rejected mutant whose check would still pass on it is a surviving mutant; begin its wrongImplementation with the mutant ID.");
      expect(reviewPrompt).toContain("A named mutant that behaves like a correct implementation, so that no check can fail on it, is a material finding that names the mutant ID.");
      expect(reviewPrompt).toContain("Otherwise set decisionNeeded to null. Do not make the choice yourself.");
      expect(reviewPrompt).toContain("\n\nSet decisionNeeded only when a business choice that the brief and resolved answers leave open decides whether the implementation is wrong, such as who may act, which state is final, or what a limit is; state that choice as a question. Otherwise set decisionNeeded to null. Do not make the choice yourself.\n\n");
      expect(reviewPrompt).toContain(" Report each counterexample in survivingMutants with its A* ID, the wrong implementation, and why every planned check for that A* would still pass. Return an empty survivingMutants array when the planned checks reject every plausible wrong implementation you can construct.\n\n");
      expect(reviewPrompt).toContain("\n\nSet acceptanceId to an acceptance criterion ID of the brief (A1, A2, ...), never to a task acceptance ID such as T1-A1. List at most 12 surviving mutants, the most consequential first; the host drops every entry after the 12th and every entry whose acceptanceId is not an A* ID of the brief.\n\n");
      expect(reviewPrompt).toContain("Use only the requirement IDs, acceptance criterion IDs and excerpt IDs supplied. Findings should name the concrete gap and one correction. Report a business choice that the brief and resolved answers leave open only as a surviving mutant with decisionNeeded, never as a finding or in a suggestedCorrection.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("lists an open decision that only the review after the repair reports", async () => {
    const cwd = await tempDirectory();
    const finding = { severity: "material", description: "The pending status rule is missing.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "State the pending status rule." };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [{ findings: [finding], survivingMutants: [] }, { findings: [], survivingMutants: [needsDecision] }],
        }),
        researcher: researcher().value,
      });

      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(outcome.reviews).toHaveLength(2);
      expect(outcome.readiness).toBe("draft");
      expect(outcome.plan.readinessNotes).toEqual([openDecisionNote]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("tells the user how to settle an open decision for the way the brief was approved", async () => {
    const requirement = "Build a refund request service.";
    const approvedBrief = parseApprovedBrief(editableBrief(parseIntake(baseIntake())), [], [requirement]);
    const routes: Array<[string, Partial<Parameters<typeof runWorkflow>[0]>]> = [
      ["write the decision into the brief of the answers file this run saved, set approveBrief to true and rerun with --answers; if the run saved no answers file, run the same command again to get one.", {}],
      ["rerun unshit and reply anything but yes when it asks you to approve the brief; it saves the brief in an answers file, where you write the decision, set approveBrief to true and rerun with --answers.", { approveBrief: async () => true }],
      ["write the decision into the brief of the answers file this run read and pass that file to --answers again; approveBrief is already true in that file, so rereading and saving the edited brief is your approval of it.",{ approvedBrief: { brief: approvedBrief, resolvedAnswers: [], approval: { briefSha256: briefSha256(approvedBrief), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" } } }],
    ];
    const cwd = await tempDirectory();
    try {
      for (const [step, approval] of routes) {
        const outcome = await runWorkflow({
          cwd,
          requirement,
          ...approval,
          modelGateway: gateway({ intake: baseIntake(), reviews: [{ findings: [], survivingMutants: [needsDecision] }] }),
          researcher: researcher().value,
        });
        if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
        expect(outcome.readiness).toBe("draft");
        expect(outcome.plan.readinessNotes.filter((note) => note.startsWith("Open decision for"))).toEqual([`${openDecisionStart}${step}`]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("repairs a surviving mutant against the requirement that owns its acceptance criterion and asks for a rejected mutant", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const intake = {
      ...baseIntake(),
      requirements: [
        baseIntake().requirements[0]!,
        { description: "Approve refund requests.", userWords: null, observableAcceptance: ["A manager can approve a pending request."] },
      ],
    };
    const twoTaskPlan = (): Record<string, any> => {
      const plan = validPlan();
      const first = plan.tasks[0]!;
      plan.tasks.push({
        ...first,
        id: "T2",
        title: "Approve refund requests",
        requirementIds: ["R2"],
        dependencies: ["T1"],
        acceptance: [{ requirementId: "R2", coversAcceptanceIds: ["A2"], condition: "A manager approves a pending request." }],
        verification: [{ ...first.verification[0], coversAcceptanceIds: ["A2"], description: "Approve a pending request as a manager.", rejectsMutants: [{ acceptanceId: "A2", wrongImplementation: "Approval leaves the request pending.", observedFailure: "The request still shows pending." }] }],
      });
      return plan;
    };
    const onApproval = { acceptanceId: "A2", wrongImplementation: "Lets any signed-in user approve a request.", whyPlannedChecksPass: "The only approval check signs in as a manager.", decisionNeeded: null };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service with manager approval.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake,
          plans: [twoTaskPlan(), twoTaskPlan()],
          reviews: [{ findings: [], survivingMutants: [onApproval] }, { findings: [], survivingMutants: [] }],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher().value,
      });

      const repairPrompt = prompts.find((prompt) => prompt.startsWith("Repair the current plan"));
      expect(repairFindings(repairPrompt!)).toStrictEqual([{
        severity: "material",
        description: "Surviving mutant for A2: Lets any signed-in user approve a request. Why every planned check for it would still pass: The only approval check signs in as a manager.",
        requirementIds: ["R2"],
        evidence: [],
        suggestedCorrection: "Add or tighten a planned check for A2 that fails on this wrong implementation, and name the implementation as a rejected mutant of that check.",
      }]);
      expect(outcome.status).toBe("completed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("drops surviving mutants it cannot use from either review, records each drop in plan.md and the manifest and still completes", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    let manifest: { gaps: unknown[]; reviews: Array<{ survivingMutants: unknown[] }> } | undefined;
    let report = "";
    const blankDecision = { ...unchecked, decisionNeeded: "  " };
    const firstDrop = "In review 1, the host dropped surviving mutant 2: T1-A1 is not an acceptance criterion of the brief.";
    const secondDrop = "In review 2, the host dropped surviving mutant 1: R1 is not an acceptance criterion of the brief.";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [
            { findings: [], survivingMutants: [blankDecision, { ...needsDecision, acceptanceId: "T1-A1" }] },
            { findings: [], survivingMutants: [{ ...stillUnchecked, acceptanceId: "R1" }] },
          ],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
        researcher: researcher().value,
        onArtifacts: async (input) => {
          const artifacts = await writePlanArtifacts({ cwd, runId: "dropped-survivors", input });
          manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8"));
          report = await readFile(artifacts.reportPath, "utf8");
          return artifacts;
        },
      });

      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      // The blank decision is read as none, so that surviving mutant goes to the repair.
      expect(repairFindings(prompts.find((prompt) => prompt.startsWith("Repair the current plan"))!).map((finding) => finding.description)).toEqual([
        `Surviving mutant for A1: ${unchecked.wrongImplementation} Why every planned check for it would still pass: ${unchecked.whyPlannedChecksPass}`,
      ]);
      expect(outcome.reviews).toStrictEqual([
        { findings: [], survivingMutants: [{ acceptanceId: "A1", wrongImplementation: unchecked.wrongImplementation, whyPlannedChecksPass: unchecked.whyPlannedChecksPass }] },
        { findings: [], survivingMutants: [] },
      ]);
      const drops: ResearchGap[] = [{ kind: "review", material: false, message: firstDrop }, { kind: "review", material: false, message: secondDrop }];
      expect(outcome.gaps.filter((gap) => gap.kind === "review")).toEqual(drops);
      expect(outcome.readiness).toBe("ready");
      expect(manifest?.gaps).toEqual(expect.arrayContaining(drops));
      expect(manifest?.reviews.map((review) => review.survivingMutants.length)).toEqual([1, 0]);
      expect(report).toContain(`- Informational (review): ${firstDrop}\n`);
      expect(report).toContain(`- Informational (review): ${secondDrop}\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("says that no review covers a repaired plan whose follow-up review failed, drops the first review's stale notes and keeps its open decisions", async () => {
    const cwd = await tempDirectory();
    const events: ProgressEvent[] = [];
    const finding = { severity: "material", description: "The pending status rule is missing.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "State the pending status rule." };
    const unknownRequirement = "Review refers to unknown requirement R9.";
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: gateway({
          intake: baseIntake(),
          reviews: [
            { findings: [finding], survivingMutants: [unchecked, needsDecision] },
            { findings: [{ ...finding, requirementIds: ["R9"] }], survivingMutants: [] },
          ],
        }),
        researcher: researcher().value,
        onProgress: (event) => events.push(event),
      });

      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(outcome.reviews).toHaveLength(1);
      expect(outcome.readiness).toBe("draft");
      // No repair may settle a business decision, so the first review's open decision stays.
      expect(outcome.plan.readinessNotes).toEqual([unreviewedRepairNote, unknownRequirement, openDecisionNote]);
      expect(outcome.validationHistory).toContainEqual({ issue: unknownRequirement, resolved: false });
      expect(events.map((event) => event.message)).toContain("The repaired plan passed host validation, but its follow-up review did not complete; the report remains Draft.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Lets every ready promise callback and fake I/O step run, without waiting for wall-clock time.
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Stops at the first turn of each paused kind until its release settles; `reached` resolves when it stops there.
function pausingGateway(base: ModelGateway, pauses: Partial<Record<TurnKind, { reached: { resolve: () => void }; release: Promise<void> }>>): ModelGateway {
  const paused = new Set<TurnKind>();
  return {
    createSession(): ModelSession {
      const session = base.createSession();
      return {
        async turn(prompt, schema, options) {
          const kind = turnKind(schema);
          const pause = pauses[kind];
          if (pause && !paused.has(kind)) {
            paused.add(kind);
            pause.reached.resolve();
            await pause.release;
          }
          return session.turn(prompt, schema, options);
        },
        close: () => session.close(),
      };
    },
  };
}

// Writes like the default writer, without the temporary file.
async function plainWrite(target: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
}

function stageOf(preview: WorkflowPreview | undefined, id: string) {
  return preview?.stages.find((stage) => stage.id === id);
}

// Each snapshot that the page links: its bytes, which must exist and hash to the SHA-256 the page shows for it.
async function linkedSnapshots(pagePath: string): Promise<string[]> {
  const html = await readFile(pagePath, "utf8");
  const contents: string[] = [];
  for (const block of html.split("<div class=\"reference\" ").slice(1)) {
    const href = /<a href="(sources\/[^"]+)">/.exec(block)?.[1];
    if (!href) continue;
    const bytes = await readFile(path.join(path.dirname(pagePath), href));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(/SHA-256<\/span><\/dt><dd><code>([0-9a-f]{64})<\/code>/.exec(block)?.[1] ?? "no hash shown");
    contents.push(bytes.toString("utf8"));
  }
  return contents;
}

describe("reference preview gate", () => {
  const requirement = "Build a refund request service.";
  const downstreamKinds: TurnKind[] = ["ranking", "selection", "files", "requests", "plan", "review"];
  const youngCandidate = { candidate: { ...repositorySnapshot().candidate, id: "C2", fullName: "org/young", webUrl: "https://github.com/org/young" }, reasons: ["created 2026-09-16, younger than 180 days"] };

  // As in the comparator's confirmation test (google-gemini/gemini-cli, E31): the run enters a waiting state, awaits the
  // response, and proceeds only after it.
  test("publishes the preview after the search, starts nothing downstream while the confirmation is open, and checks trees only after yes", async () => {
    // Both ranking branches: one candidate fits a tree budget of 8; a budget of 0 needs a ranking turn first.
    for (const treeResolutionLimit of [8, 0]) {
      const cwd = await tempDirectory();
      const kinds: TurnKind[] = [];
      const research = researcher({ treeResolutionLimit });
      const published: WorkflowPreview[] = [];
      const asked = deferred<WorkflowPreview>();
      const answer = deferred<boolean>();
      try {
        const run = runWorkflow({
          cwd,
          requirement,
          approveBrief: async () => true,
          modelGateway: gateway({ intake: baseIntake(), onPrompt: (_prompt, schema) => kinds.push(turnKind(schema)) }),
          researcher: research.value,
          onPreview: async (preview) => {
            published.push(preview);
          },
          confirmPreview: (preview) => {
            asked.resolve(preview);
            return answer.promise;
          },
        });
        const shown = await asked.promise;
        await settle();
        expect(research.shortlistInputs).toEqual([]);
        expect(kinds.filter((kind) => downstreamKinds.includes(kind))).toEqual([]);
        expect(stageOf(shown, "preview_confirmation")?.status).toBe("waiting");
        expect(stageOf(published.at(-1), "preview_confirmation")?.status).toBe("waiting");
        expect(stageOf(published.at(-1), "repository_search")?.uses).toEqual([{ relation: "found", key: "C1" }]);
        answer.resolve(true);
        const outcome = await run;
        expect(outcome.status).toBe("completed");
        expect(research.shortlistInputs).toHaveLength(1);
        expect(kinds.includes("ranking")).toBe(treeResolutionLimit === 0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  test("asks only after the page of the search is written", async () => {
    const cwd = await tempDirectory();
    const entered = deferred();
    const write = deferred();
    let written = false;
    let writtenWhenAsked: boolean | undefined;
    try {
      const run = runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: researcher().value,
        onPreview: async () => {
          entered.resolve();
          await write.promise;
          written = true;
        },
        confirmPreview: async () => {
          writtenWhenAsked = written;
          return false;
        },
      });
      await entered.promise;
      await settle();
      expect(writtenWhenAsked).toBeUndefined();
      write.resolve();
      const outcome = await run;
      expect(writtenWhenAsked).toBe(true);
      expect(outcome).toMatchObject({ status: "needs_input", previewStop: "declined" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("stops a run with no person to ask at the preview: the page is written, nothing downstream starts, and an approved brief does not count", async () => {
    const approvedBrief = parseApprovedBrief(editableBrief(parseIntake(baseIntake())), [], [requirement]);
    const routes: Array<Partial<WorkflowOptions>> = [
      {},
      { approveBrief: async () => true },
      { approvedBrief: { brief: approvedBrief, resolvedAnswers: [], approval: { briefSha256: briefSha256(approvedBrief), via: "answers_file", approvedAt: "2026-10-28T09:00:00.000Z" } } },
    ];
    for (const route of routes) {
      const cwd = await tempDirectory();
      const kinds: TurnKind[] = [];
      const research = researcher();
      const published: WorkflowPreview[] = [];
      let saved = false;
      try {
        const outcome = await runWorkflow({
          cwd,
          requirement,
          ...route,
          modelGateway: gateway({ intake: baseIntake(), onPrompt: (_prompt, schema) => kinds.push(turnKind(schema)) }),
          researcher: research.value,
          onPreview: async (preview) => {
            published.push(preview);
          },
          onArtifacts: async () => {
            saved = true;
            return undefined;
          },
          confirmPreview: undefined,
        });
        expect(outcome).toMatchObject({ status: "needs_input", questions: [], previewStop: "unavailable", message: "Reference preview requires confirmation in an interactive terminal. No downstream work started." });
        expect(exitCodeFor(outcome, false)).toBe(2);
        expect(published).toHaveLength(1);
        expect(stageOf(published[0], "preview_confirmation")?.status).toBe("stopped");
        // A search-only preview: source reads and every other later stage are still pending.
        expect(stageOf(published[0], "source_reads")?.status).toBe("pending");
        expect(published[0]!.stages.slice(8).map((stage) => stage.status)).toEqual(Array(10).fill("pending"));
        expect(research.shortlistInputs).toEqual([]);
        expect(kinds.filter((kind) => downstreamKinds.includes(kind))).toEqual([]);
        expect(saved).toBe(false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  test("continues only on a reply that is yes once trimmed and lowercased, and otherwise stops before any tree check", async () => {
    const replies: Array<[string, boolean]> = [["not yet", false], ["no", false], ["y", false], ["yes please", false], ["", false], ["  YES  ", true], ["Yes", true]];
    for (const [reply, confirmed] of replies) {
      const cwd = await tempDirectory();
      const research = researcher();
      try {
        const outcome = await runWorkflow({
          cwd,
          requirement,
          approveBrief: async () => true,
          modelGateway: gateway({ intake: baseIntake() }),
          researcher: research.value,
          confirmPreview: createPreviewConfirmer(async () => reply),
        });
        if (confirmed) {
          expect(outcome.status).toBe("completed");
          expect(research.shortlistInputs).toHaveLength(1);
        } else {
          expect(outcome).toMatchObject({ status: "needs_input", questions: [], previewStop: "declined", message: "Reference preview was not confirmed. No downstream work started." });
          expect(exitCodeFor(outcome, false)).toBe(2);
          expect(research.shortlistInputs).toEqual([]);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  test("treats a false confirmation as a stop: the page shows it stopped and no plan is written", async () => {
    const cwd = await tempDirectory();
    const research = researcher();
    try {
      const writers = createRunWriters({ cwd, runId: "run-1", jsonl: false, write: () => undefined });
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: research.value,
        ...writers,
        confirmPreview: async () => false,
      });
      expect(outcome).toMatchObject({ status: "needs_input", previewStop: "declined", message: PREVIEW_DECLINED });
      expect(research.shortlistInputs).toEqual([]);
      const page = await readFile(path.join(cwd, ".unshit", "run-1", "preview.html"), "utf8");
      expect(page).toContain("data-status=\"stopped\"");
      expect(existsSync(path.join(cwd, ".unshit", "run-1", "plan.md"))).toBe(false);
      expect(existsSync(path.join(cwd, ".unshit", "run-1", "manifest.json"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("asks at the preview of a search that found nothing", async () => {
    const cwd = await tempDirectory();
    let shown: WorkflowPreview | undefined;
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: researcher({ candidates: [], snapshots: [] }).value,
        confirmPreview: async (preview) => {
          shown = preview;
          return false;
        },
      });
      expect(stageOf(shown, "repository_search")).toEqual({ id: "repository_search", status: "completed", uses: [] });
      expect(outcome).toMatchObject({ status: "needs_input", previewStop: "declined" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ends as interrupted when Ctrl+C or the end of input comes at the preview prompt", async () => {
    for (const ending of ["reply after abort", "rejected question"] as const) {
      const cwd = await tempDirectory();
      const controller = new AbortController();
      const research = researcher();
      try {
        const outcome = await runWorkflow({
          cwd,
          requirement,
          approveBrief: async () => true,
          signal: controller.signal,
          modelGateway: gateway({ intake: baseIntake() }),
          researcher: research.value,
          confirmPreview: async () => {
            controller.abort();
            if (ending === "rejected question") throw new Error("The operation was aborted.");
            return true;
          },
        });
        expect(outcome.status).toBe("interrupted");
        expect(research.shortlistInputs).toEqual([]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  test("fails with a fixed message before anyone is asked when the page of the search cannot be written", async () => {
    const cwd = await tempDirectory();
    let asked = false;
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: researcher().value,
        onPreview: async () => {
          throw new Error("EACCES: permission denied, open '/private/run/preview.html'");
        },
        confirmPreview: async () => {
          asked = true;
          return true;
        },
      });
      expect(outcome).toEqual({ status: "error", message: "Could not save workflow preview." });
      expect(PREVIEW_SAVE_FAILED).toBe("Could not save workflow preview.");
      expect(asked).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("prints the page path, each stage and the references the search found before the preview prompt", async () => {
    const cwd = await tempDirectory();
    const output: string[] = [];
    try {
      const writers = createRunWriters({ cwd, runId: "run-1", jsonl: false, write: (text) => output.push(text) });
      await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake() }),
        researcher: researcher({ discoveryExcluded: [youngCandidate] }).value,
        ...writers,
        confirmPreview: createPreviewConfirmer(async (prompt) => {
          output.push(prompt);
          return "no";
        }),
      });
      const text = output.join("");
      const prompt = text.indexOf("Type yes to continue");
      expect(prompt).toBeGreaterThan(0);
      const before = text.slice(0, prompt);
      const page = path.join(cwd, ".unshit", "run-1", "preview.html");
      expect(before).toContain(`Reference preview page: ${page}\n`);
      expect(before).toContain("[ok] repository_search: completed; found 2\n    found C1 github:org/refunds [discovery]\n    found C2 github:org/young [discovery]\n");
      expect(before).toContain("[ok] metadata_screening: completed; passed 1, excluded 1\n    excluded C2 github:org/young [discovery] (created 2026-09-16, younger than 180 days)\n");
      // The terminal gives repositories that passed the metadata bar only as a count; the page lists them.
      expect(before).not.toContain("    passed ");
      expect(before).toContain("[..] preview_confirmation: waiting\n");
      expect(before).toContain("[  ] source_reads: pending\n");
      expect(await readFile(page, "utf8")).toContain("github:org/young");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("reference preview publication", () => {
  const requirement = "Build a refund request service.";
  const bothFiles = { files: [{ fileId: "C1F1", role: "production", rationale: "Handler." }, { fileId: "C1F2", role: "test", rationale: "Tests." }] };

  test("publishes each later stage before the next model turn returns: terminal lines, the page, and snapshots that open with the bytes the host read", async () => {
    const cwd = await tempDirectory();
    const output: string[] = [];
    const secret = "export const apiKey = \"plainCredentialValue123456\";\nexport function send() { return apiKey; }\n";
    const redacted = "export const apiKey = \"[redacted by unshit]\";\nexport function send() { return apiKey; }\n";
    const requests = { reached: deferred(), release: deferred() };
    const review = { reached: deferred(), release: deferred() };
    let settled = false;
    try {
      await mkdir(path.join(cwd, "src"), { recursive: true });
      await writeFile(path.join(cwd, "src", "client.ts"), secret);
      const base = repositorySnapshot();
      const extra: TreeFile = { id: "C1F7", path: "src/extra.ts", size: 100 };
      const writers = createRunWriters({ cwd, runId: "run-1", jsonl: false, write: (text) => output.push(text) });
      const run = runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: pausingGateway(gateway({
          intake: baseIntake(),
          fileSelection: { files: [...bothFiles.files, { fileId: "LFILE1", role: "production", rationale: "Client." }] },
          evidenceRequests: { requests: [{ kind: "file", id: "C1F7", name: "", startLine: 0, endLine: 0, reason: "More comparator code." }] },
        }), {
          requests: { reached: requests.reached, release: requests.release.promise },
          review: { reached: review.reached, release: review.release.promise },
        }),
        researcher: researcher({ snapshots: [{ ...base, files: [...base.files, extra] }] }).value,
        ...writers,
      });
      void run.then(() => {
        settled = true;
      });
      const page = path.join(cwd, ".unshit", "run-1", "preview.html");

      await requests.reached.promise;
      let text = output.join("");
      expect(text).toContain("[ok] source_reads: completed; read ");
      expect(text).toMatch(/\n {4}read S\d+ src\/client\.ts \[evidence\]\n/);
      let snapshots = await linkedSnapshots(page);
      expect(snapshots).toContain(redacted);
      expect(snapshots).toContain("export function createRefund() { return { status: 'pending' }; }\n");
      expect(snapshots.join("")).not.toContain("plainCredentialValue123456");
      expect(settled).toBe(false);
      expect(existsSync(path.join(cwd, ".unshit", "run-1", "plan.md"))).toBe(false);
      // The file changes after the host read it; every snapshot keeps the bytes that were read.
      await writeFile(path.join(cwd, "src", "client.ts"), "export const changed = true;\n");
      requests.release.resolve();

      await review.reached.promise;
      text = output.join("");
      expect(text).toMatch(/\[ok\] evidence_requests: completed; supplied_to_model \d+, added \d+\n {4}added excerpts: E\d+/);
      expect(text).toContain("[ok] plan: completed; supplied_to_model ");
      snapshots = await linkedSnapshots(page);
      expect(snapshots).toContain("export const path = 'src/extra.ts';\n");
      expect(settled).toBe(false);
      review.release.resolve();

      const outcome = await run;
      expect(outcome.status).toBe("completed");
      text = output.join("");
      // As in the comparator's progress test (Azure/azure-dev, E8): the page path is printed once, not on every update.
      expect(text.split("Reference preview page: ").length - 1).toBe(1);
      expect(await linkedSnapshots(page)).toContain(redacted);
    } finally {
      requests.release.resolve();
      review.release.resolve();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("shows no evidence for a selected file while its read is still open, and keeps the search result a discovery reference after the read", async () => {
    const cwd = await tempDirectory();
    const reached = deferred();
    const release = deferred();
    const published: WorkflowPreview[] = [];
    try {
      const base = researcher();
      const value = {
        ...base.value,
        fetchSource: async (snapshot: RepositorySnapshot, filePath: string) => {
          if (filePath === "src/index.ts") {
            reached.resolve();
            await release.promise;
          }
          return base.value.fetchSource(snapshot, filePath);
        },
      } as unknown as GitHubResearcher;
      const run = runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles }),
        researcher: value,
        onPreview: async (preview) => {
          published.push(preview);
        },
      });
      await reached.promise;
      await settle();
      const open = published.at(-1)!;
      expect(stageOf(open, "file_selection")?.status).toBe("completed");
      expect(stageOf(open, "source_reads")?.status).toBe("pending");
      expect(open.references.filter((reference) => reference.classification === "evidence")).toEqual([]);
      expect(open.references.find((reference) => reference.key === "C1F1")?.classification).toBe("listed");
      release.resolve();
      expect((await run).status).toBe("completed");
      for (const preview of published) expect(preview.references.find((reference) => reference.key === "C1")?.classification).toBe("discovery");
      const final = published.at(-1)!;
      expect(stageOf(final, "repository_search")?.uses).toEqual([{ relation: "found", key: "C1" }]);
      expect(final.references.some((reference) => reference.kind === "source" && reference.path === "src/index.ts" && reference.classification === "evidence")).toBe(true);
    } finally {
      release.resolve();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps a selected file that could not be read out of the evidence", async () => {
    const cwd = await tempDirectory();
    const published: WorkflowPreview[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles }),
        researcher: researcher({ failPaths: ["src/index.ts"] }).value,
        onPreview: async (preview) => {
          published.push(preview);
        },
      });
      // The plan fixture cites the excerpts of the file that failed, so the run itself ends in a plan validation error.
      expect(outcome).toMatchObject({ status: "error", message: "Plan generation and its bounded validation repair did not produce a usable task map." });
      const final = published.at(-1)!;
      expect(stageOf(final, "source_reads")?.status).toBe("completed");
      expect(final.references.some((reference) => reference.classification === "evidence")).toBe(true);
      expect(final.references.filter((reference) => reference.classification === "evidence" && reference.path === "src/index.ts")).toEqual([]);
      expect(final.references.find((reference) => reference.key === "C1F1")).toMatchObject({ kind: "file", classification: "listed" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("leaves a file ID that the model made up out of every preview", async () => {
    const cwd = await tempDirectory();
    const published: WorkflowPreview[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: { files: [...bothFiles.files, { fileId: "C1F99", role: "production", rationale: "Invented." }] } }),
        researcher: researcher().value,
        onPreview: async (preview) => {
          published.push(preview);
        },
      });
      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      const hostKeys = new Set([
        "C1",
        `C1@${"a".repeat(12)}`,
        ...repositorySnapshot().files.map((file) => file.id),
        ...outcome.sources.flatMap((source) => [source.id, ...source.excerpts.map((excerpt) => excerpt.id)]),
      ]);
      expect(published.length).toBeGreaterThan(5);
      for (const preview of published) {
        expect(preview.references.map((reference) => reference.key).filter((key) => !hostKeys.has(key))).toEqual([]);
        expect(preview.stages.flatMap((stage) => stage.uses.map((use) => use.key)).filter((key) => !hostKeys.has(key))).toEqual([]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("records every excerpt the plan turn received as supplied to the model, and only what the plan cites as cited", async () => {
    const cwd = await tempDirectory();
    const planPrompts: string[] = [];
    const published: WorkflowPreview[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles, onPrompt: (prompt, schema) => { if (turnKind(schema) === "plan") planPrompts.push(prompt); } }),
        researcher: researcher().value,
        onPreview: async (preview) => {
          published.push(preview);
        },
      });
      expect(outcome.status).toBe("completed");
      const supplied = [...new Set([...planPrompts[0]!.matchAll(/"excerptId":"(E\d+)"/g)].map((match) => match[1]!))];
      expect(supplied).toContain("E3");
      const plan = stageOf(published.at(-1), "plan")!;
      expect(plan.uses.filter((use) => use.relation === "supplied_to_model").map((use) => use.key).sort()).toEqual([...supplied].sort());
      expect(plan.uses.filter((use) => use.relation === "cited").map((use) => use.key).sort()).toEqual(["E1", "E2"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("prints the plan stage again when a repair replaces one cited excerpt with another at the same count", async () => {
    const cwd = await tempDirectory();
    const output: string[] = [];
    const first = validPlan("E1", "E2");
    first.tasks[0].evidence = [{ excerptId: "E4", claim: "The license file names MIT." }];
    const repaired = validPlan("E1", "E2");
    repaired.tasks[0].evidence = [{ excerptId: "E3", claim: "The manifest runs bun test." }];
    const finding = { severity: "material", description: "The task cites the license, not the manifest.", requirementIds: ["R1"], evidence: [], suggestedCorrection: "Cite the manifest." };
    try {
      const writers = createRunWriters({ cwd, runId: "run-1", jsonl: false, write: (text) => output.push(text) });
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles, plans: [first, repaired], reviews: [{ findings: [finding] }, { findings: [] }] }),
        researcher: researcher().value,
        ...writers,
      });
      expect(outcome.status).toBe("completed");
      const blocks = output.join("").split("Reference preview, revision ");
      const planBlock = blocks.find((block) => block.includes("[ok] plan: completed") && !block.includes("[ok] review:"))!;
      expect(planBlock).toContain("[ok] plan: completed; supplied_to_model 6, cited 3\n    cited excerpts: E4, E1, E2\n");
      const reviewBlock = blocks.find((block) => block.includes("[ok] review: completed"))!;
      expect(reviewBlock).toContain("[ok] plan: completed; supplied_to_model 6, cited 3\n    cited excerpts: E3, E1, E2\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("stops with a fixed message and keeps the last page when a source snapshot cannot be written", async () => {
    const cwd = await tempDirectory();
    try {
      const writers = createRunWriters({
        cwd,
        runId: "run-1",
        jsonl: false,
        write: () => undefined,
        writer: async (target, data) => {
          if (target.includes(`${path.sep}sources${path.sep}`)) throw new Error("ENOSPC: no space left on device, write '/private/run/sources/S1.txt'");
          await plainWrite(target, data);
        },
      });
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles }),
        researcher: researcher().value,
        ...writers,
      });
      expect(outcome).toMatchObject({ status: "error", message: "Could not publish workflow preview sources." });
      expect(PREVIEW_SOURCES_FAILED).toBe("Could not publish workflow preview sources.");
      const page = await readFile(path.join(cwd, ".unshit", "run-1", "preview.html"), "utf8");
      expect(page).toContain("<code>file_selection</code></h2><p class=\"status\"><span lang=\"en\">Completed</span>");
      expect(page).toContain("<code>source_reads</code></h2><p class=\"status\"><span lang=\"en\">Pending</span>");
      expect(page).not.toContain("href=\"sources/");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ends as an error with a fixed message, and no completed result, when the final plan cannot be written", async () => {
    const cwd = await tempDirectory();
    try {
      const writers = createRunWriters({
        cwd,
        runId: "run-1",
        jsonl: false,
        write: () => undefined,
        writer: async (target, data) => {
          if (target.endsWith("plan.md")) throw new Error("ENOSPC: no space left on device, write '/private/run/plan.md'");
          await plainWrite(target, data);
        },
      });
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles }),
        researcher: researcher().value,
        ...writers,
      });
      expect(outcome).toMatchObject({ status: "error", message: "Could not finalize workflow preview artifacts." });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("reference preview inputs", () => {
  const requirement = "Build a refund request service.";
  const bothFiles = { files: [{ fileId: "C1F1", role: "production", rationale: "Handler." }, { fileId: "C1F2", role: "test", rationale: "Tests." }] };

  test("records every candidate the ranking turn received as supplied to the model, apart from the ones it ranked", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const published: WorkflowPreview[] = [];
    const second = { ...repositorySnapshot().candidate, id: "C2", fullName: "org/other", webUrl: "https://github.com/org/other" };
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), ranking: { ranked: ["C2"] }, fileSelection: bothFiles, onPrompt: (prompt, schema) => { if (turnKind(schema) === "ranking") prompts.push(prompt); } }),
        researcher: researcher({ candidates: [repositorySnapshot().candidate, second], treeResolutionLimit: 1 }).value,
        onPreview: async (preview) => {
          published.push(preview);
        },
      });
      expect(outcome.status).toBe("completed");
      const offered = [...prompts[0]!.matchAll(/"id":"(C\d+)"/g)].map((match) => match[1]!);
      expect(offered).toEqual(["C1", "C2"]);
      const ranking = stageOf(published.at(-1), "candidate_ranking")!;
      expect(ranking.uses.filter((use) => use.relation === "supplied_to_model").map((use) => use.key)).toEqual(offered);
      expect(ranking.uses.filter((use) => use.relation === "ranked").map((use) => use.key)).toEqual(["C2"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("records the excerpts the evidence-request turn received, also when it adds nothing", async () => {
    const cwd = await tempDirectory();
    const prompts: string[] = [];
    const published: WorkflowPreview[] = [];
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles, evidenceRequests: { requests: [] }, onPrompt: (prompt, schema) => { if (turnKind(schema) === "requests") prompts.push(prompt); } }),
        researcher: researcher().value,
        onPreview: async (preview) => {
          published.push(preview);
        },
      });
      expect(outcome.status).toBe("completed");
      const received = [...new Set([...prompts[0]!.matchAll(/"excerptId":"(E\d+)"/g)].map((match) => match[1]!))];
      expect(received.length).toBeGreaterThan(0);
      const requests = stageOf(published.at(-1), "evidence_requests")!;
      expect(requests.status).toBe("completed");
      expect(requests.uses).toEqual(received.map((key) => ({ relation: "supplied_to_model", key })));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("gives the number of files offered to file selection in the terminal, the page and the plan", async () => {
    const cwd = await tempDirectory();
    const output: string[] = [];
    const prompts: string[] = [];
    try {
      const writers = createRunWriters({ cwd, runId: "run-1", jsonl: false, write: (text) => output.push(text) });
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles, onPrompt: (prompt, schema) => { if (turnKind(schema) === "files") prompts.push(prompt); } }),
        researcher: researcher().value,
        ...writers,
      });
      expect(outcome.status).toBe("completed");
      const offered = new Set([...prompts[0]!.matchAll(/"fileId":"([^"]+)"/g)].map((match) => match[1]!)).size;
      expect(offered).toBeGreaterThan(2);
      expect(output.join("")).toContain(`[ok] file_selection: completed; selected 2; ${offered} files offered to the model\n`);
      const page = await readFile(path.join(cwd, ".unshit", "run-1", "preview.html"), "utf8");
      expect(page).toContain(`<p class="muted"><span lang="en">${offered} files offered to the model, not listed</span><span lang="zh-CN">提供给模型的文件 ${offered} 个，未逐一列出</span></p>`);
      const plan = await readFile(path.join(cwd, ".unshit", "run-1", "plan.md"), "utf8");
      expect(plan).toContain(`- **File selection** (\`file_selection\`): completed; ${offered} files offered to the model, not listed.\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("ends as an error with a fixed message, and no completed result, when the final page cannot be written", async () => {
    const cwd = await tempDirectory();
    let planWritten = false;
    try {
      const writers = createRunWriters({
        cwd,
        runId: "run-1",
        jsonl: false,
        write: () => undefined,
        writer: async (target, data) => {
          if (target.endsWith("preview.html") && planWritten) throw new Error("ENOSPC: no space left on device, write '/private/run/preview.html'");
          await plainWrite(target, data);
          if (target.endsWith("plan.md")) planWritten = true;
        },
      });
      const outcome = await runWorkflow({
        cwd,
        requirement,
        approveBrief: async () => true,
        modelGateway: gateway({ intake: baseIntake(), fileSelection: bothFiles }),
        researcher: researcher().value,
        ...writers,
      });
      expect(planWritten).toBe(true);
      expect(outcome).toMatchObject({ status: "error", message: "Could not finalize workflow preview artifacts." });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("stack page", () => {
  test("writes the stack page once the plan exists, before the review turn, and again with the final plan", async () => {
    const cwd = await tempDirectory();
    const output: string[] = [];
    const requests = { reached: deferred(), release: deferred() };
    const review = { reached: deferred(), release: deferred() };
    try {
      const writers = createRunWriters({ cwd, runId: "run-1", jsonl: false, write: (text) => output.push(text) });
      const run = runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        approveBrief: async () => true,
        modelGateway: pausingGateway(gateway({ intake: baseIntake(), fileSelection: { files: [{ fileId: "C1F1", role: "production", rationale: "Handler." }, { fileId: "C1F2", role: "test", rationale: "Tests." }] } }), {
          requests: { reached: requests.reached, release: requests.release.promise },
          review: { reached: review.reached, release: review.release.promise },
        }),
        researcher: researcher().value,
        ...writers,
      });
      const stack = path.join(cwd, ".unshit", "run-1", "stack.html");

      await requests.reached.promise;
      expect(existsSync(stack)).toBe(false);
      requests.release.resolve();

      await review.reached.promise;
      const early = await readFile(stack, "utf8");
      expect(early).toContain("<h1>Refund request plan</h1>");
      expect(early).toContain('aria-label="Refund requests"');
      expect(early).toContain('aria-label="RefundRequest"');
      expect(output.join("")).toContain(`Stack page: ${stack}\n`);
      review.release.resolve();

      const outcome = await run;
      if (outcome.status !== "completed") throw new Error(`Workflow returned ${outcome.status}`);
      expect(outcome.artifacts?.stackPath).toBe(stack);
      expect(output.join("").split("Stack page: ").length - 1).toBe(1);
      expect(await readFile(stack, "utf8")).toContain('<li class="layer" data-i="2"');
      expect(await readFile(path.join(cwd, ".unshit", "run-1", "plan.md"), "utf8")).toContain("## Stack\n");
    } finally {
      requests.release.resolve();
      review.release.resolve();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
