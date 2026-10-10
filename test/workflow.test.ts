import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { JsonRecord, ModelGateway, ModelSession, ModelTurnResult } from "../src/app-server.ts";
import type { GitHubResearcher } from "../src/github.ts";
import { parseIntake } from "../src/model-schema.ts";
import type { RepositoryCandidate, RepositorySnapshot, TreeFile } from "../src/types.ts";
import { REFERENCE_PLAN_MODULES, REFERENCE_POLICY_INPUTS } from "../src/instructions.ts";
import { renderReport } from "../src/report.ts";
import { runWorkflow } from "../src/workflow.ts";

function baseIntake(questions: Array<{ question: string; whyMaterial: string }> = []) {
  return {
    summary: "Build a small refund request service.",
    requirements: [{ description: "Record refund requests.", observableAcceptance: ["A request has an amount and status."] }],
    outOfScope: [],
    assumptions: [],
    materialQuestions: questions,
    researchQueries: ["refund request service"],
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

function gateway(options: {
  intake: unknown;
  plans?: unknown[];
  reviews?: unknown[];
  selection?: unknown;
  fileSelection?: unknown;
  onPrompt?: (prompt: string, schema: JsonRecord) => void;
}): ModelGateway {
  let sessions = 0;
  let planIndex = 0;
  let reviewIndex = 0;
  return {
    createSession(): ModelSession {
      const sessionIndex = sessions++;
      return {
        async turn(prompt: string, schema: JsonRecord): Promise<ModelTurnResult> {
          options.onPrompt?.(prompt, schema);
          const properties = schema.properties as Record<string, unknown>;
          let result: unknown;
          if ("requirements" in properties) result = options.intake;
          else if ("selected" in properties) result = options.selection ?? { selected: [{ candidateId: "C1", rationale: "The repository implements refund requests." }], rejected: [] };
          else if ("files" in properties) result = options.fileSelection ?? { files: [{ fileId: "C1F1", role: "production", rationale: "Main request handler." }] };
          else if ("tasks" in properties) result = options.plans?.[planIndex++] ?? validPlan();
          else if ("findings" in properties) result = options.reviews?.[reviewIndex++] ?? { findings: [] };
          else throw new Error("Unexpected model schema.");
          if (sessionIndex > 0 && "findings" in properties && result === undefined) result = { findings: [] };
          return { status: "completed", text: JSON.stringify(result), threadId: `thread-${sessionIndex + 1}`, turnId: `turn-${planIndex + reviewIndex + 1}` };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

function researcher(options: { candidates?: RepositoryCandidate[]; snapshots?: RepositorySnapshot[]; failReads?: boolean } = {}): { value: GitHubResearcher; searches: number } {
  let searches = 0;
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
    async discover() {
      searches += 1;
      return { candidates, gaps: candidates.length ? [] : [{ kind: "search", message: "Public source providers were unavailable.", material: true }] };
    },
    async resolveSelected(_candidates: RepositoryCandidate[], selectedIds: string[]) {
      return { snapshots: snapshots.filter((snapshot) => selectedIds.includes(snapshot.candidate.id)), gaps: [] };
    },
    async fetchSource(_snapshot: RepositorySnapshot, filePath: string) {
      if (options.failReads) throw new Error("fixture source outage");
      return new TextEncoder().encode(content.get(filePath) ?? `export const path = '${filePath}';\n`);
    },
  } as unknown as GitHubResearcher;
  return { value, get searches() { return searches; } };
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

describe("workflow gates and readiness", () => {
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
    try {
      const outcome = await runWorkflow({
        cwd,
        requirement: "Build a refund request service.",
        modelGateway: gateway({ intake: baseIntake(), plans: [noReferencesPlan()] }),
        researcher: noCandidates.value,
      });
      expect(outcome.status).toBe("completed");
      if (outcome.status === "completed") {
        expect(outcome.readiness).toBe("draft");
        expect(outcome.plan.tasks).toHaveLength(1);
      }
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
});
