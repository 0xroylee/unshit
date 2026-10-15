import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { JsonRecord, ModelGateway, ModelSession, ModelTurnResult } from "../src/app-server.ts";
import { GitHubResearcher } from "../src/github.ts";
import { ProviderRequestError } from "../src/request-failure.ts";
import { parseIntake } from "../src/model-schema.ts";
import { DEFAULT_QUALITY_BAR } from "../src/repository-screening.ts";
import type { CodeSearchSummary, RepositoryCandidate, RepositorySnapshot, TreeFile } from "../src/types.ts";
import type { DomainMaterial } from "../src/repository-screening.ts";
import { REFERENCE_PLAN_MODULES, REFERENCE_POLICY_INPUTS } from "../src/instructions.ts";
import { renderReport } from "../src/report.ts";
import { writeCheckpointArtifacts, writePlanArtifacts } from "../src/storage.ts";
import { runWorkflow } from "../src/workflow.ts";

function baseIntake(questions: Array<{ question: string; whyMaterial: string }> = []) {
  return {
    summary: "Build a small refund request service.",
    requirements: [{ description: "Record refund requests.", observableAcceptance: ["A request has an amount and status."] }],
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

function validPlan(excerptId = "E1"): Record<string, any> {
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
      verification: [{ kind: "manual", coversAcceptanceIds: ["A1"], description: "Submit a valid request and inspect the stored status.", commandId: null, plannedCommand: null }],
      evidence: [{ excerptId, claim: "The reference validates and stores refund requests." }],
    }],
    decisions: [],
    referenceComparisons: [{
      candidateId: "C1",
      adoptedPatterns: [{ pattern: "Represent requests with a state.", evidence: [{ excerptId, claim: "The reference has a request state." }] }],
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

type TurnKind = "refined" | "intake" | "ranking" | "selection" | "files" | "plan" | "review";

function turnKind(schema: JsonRecord): TurnKind {
  const properties = schema.properties as Record<string, unknown>;
  if ((properties.materialQuestions as { maxItems?: number } | undefined)?.maxItems === 0) return "refined";
  if ("requirements" in properties) return "intake";
  if ("ranked" in properties) return "ranking";
  if ("selected" in properties) return "selection";
  if ("files" in properties) return "files";
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
  onPrompt?: (prompt: string, schema: JsonRecord) => void;
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
          options.onPrompt?.(prompt, schema);
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
        modelGateway: gateway({ intake: baseIntake() }),
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
          modelGateway: gateway({ intake: baseIntake() }),
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
        modelGateway: gateway({ intake: baseIntake(), plans: [noReferencesPlan()], fileSelection: { files: [] } }),
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
        "Choose up to fifteen local or remote",
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
      for (const start of ["Select zero to three public repository", "Choose up to fifteen local or remote"]) {
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
      requirements: [{ description: "Sell tickets and verify event admission.", observableAcceptance: ["A ticket can be sold and scanned."] }],
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
      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to fifteen local or remote"))!;
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
      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to fifteen local or remote"))!;
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
      const filePrompt = prompts.find((prompt) => prompt.startsWith("Choose up to fifteen local or remote"))!;
      expect(filePrompt).toContain("\"fileId\":\"C1Z1\",\"path\":\"vendor/legacy/deep/path/refund_hook.ts\"");
      expect(filePrompt).toContain("\"codeMatch\":\"refund_hook\"");
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
