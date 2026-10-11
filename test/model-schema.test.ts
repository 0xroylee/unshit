import { describe, expect, test } from "bun:test";
import { INTAKE_SCHEMA, ModelOutputError, REFINED_BRIEF_SCHEMA, parseIntake, parsePlan, parseRefinedBrief, stableMaterialQuestionId } from "../src/model-schema.ts";
import type { EvidenceExcerpt, EvidenceSource, IntakeBrief, RepositorySnapshot } from "../src/types.ts";

const brief = parseIntake({
  summary: "Add a refund flow.",
  requirements: [{ description: "Issue a refund.", observableAcceptance: ["A refund request is recorded."] }],
  outOfScope: [],
  assumptions: [],
  materialQuestions: [],
  researchQueries: ["refund workflow"],
});

function snapshot(id: string, fullName: string, sha: string): RepositorySnapshot {
  return {
    candidate: {
      id,
      provider: "github",
      fullName,
      description: "",
      defaultBranch: "main",
      webUrl: `https://github.com/${fullName}`,
    },
    commitSha: sha,
    treeTruncated: false,
    files: [],
  };
}

function source(id: string, kind: "local" | "remote", extra: Partial<EvidenceSource> = {}): EvidenceSource {
  return {
    id,
    kind,
    path: `${id}.ts`,
    sha256: "a".repeat(64),
    lineCount: 12,
    byteCount: 80,
    snapshotPath: `sources/${id}.txt`,
    roles: ["production"],
    ...extra,
  };
}

const localSource = source("S1", "local");
const sourceA = source("S2", "remote", { provider: "github", repository: "org/a", commitSha: "a".repeat(40) });
const sourceB = source("S3", "remote", { provider: "github", repository: "org/b", commitSha: "b".repeat(40) });
const excerpts: EvidenceExcerpt[] = [
  { id: "E1", sourceId: "S1", startLine: 1, endLine: 4, text: "local source" },
  { id: "E2", sourceId: "S2", startLine: 5, endLine: 9, text: "repository A source" },
  { id: "E3", sourceId: "S3", startLine: 2, endLine: 6, text: "repository B source" },
];

function plan(comparisonEvidence = "E2", snapshots: RepositorySnapshot[] = [snapshot("C1", "org/a", "a".repeat(40))]): Record<string, any> {
  return {
    title: "Refund plan",
    summary: "Record and verify refund requests.",
    shouldDraft: false,
    draftReasons: [],
    design: {
      architecture: "A request handler validates the refund request and records it.",
      modules: [{ name: "Refund handler", responsibility: "Validate and record refunds.", interfaces: ["POST /refunds"], evidence: [{ excerptId: "E1", claim: "The local project uses a request handler." }], newDesignReason: null }],
      dataModel: {
        entities: [{ name: "RefundRequest", fields: ["requestId", "amount", "status"], evidence: [{ excerptId: "E1", claim: "Existing project entities use explicit status." }], newDesignReason: null }],
        notApplicableReason: null,
      },
      invariants: { items: [{ statement: "A refund cannot exceed the original charge.", evidence: [{ excerptId: "E1", claim: "The source validates monetary limits." }], newDesignReason: null }], notApplicableReason: null },
      accessControl: { boundaries: [], notApplicableReason: "The clarified brief does not specify authenticated actors or access restrictions." },
    },
    tasks: [{
      id: "T1",
      title: "Add refund request handling",
      description: "Validate and persist a refund request.",
      requirementIds: ["R1"],
      dependencies: [],
      acceptance: [{ requirementId: "R1", coversAcceptanceIds: ["A1"], condition: "A valid refund request is recorded." }],
      verification: [{ kind: "manual", coversAcceptanceIds: ["A1"], description: "Submit a valid request and inspect the record.", commandId: null, plannedCommand: null }],
      evidence: [{ excerptId: "E1", claim: "The local application has a request-handling entry point." }],
    }],
    decisions: [],
    referenceComparisons: snapshots.map((repository) => ({
      candidateId: repository.candidate.id,
      adoptedPatterns: [{ pattern: "Use a request status field.", evidence: [{ excerptId: repository.candidate.id === "C1" ? comparisonEvidence : "E3", claim: "The comparator records request state." }] }],
      rejectedPatterns: [{ pattern: "Use a synchronous provider call.", reason: "It would keep a user request blocked on the external service.", evidence: [{ excerptId: repository.candidate.id === "C1" ? comparisonEvidence : "E3", claim: "The comparator performs synchronous provider work." }] }],
      localAdaptation: "Use the local persistence conventions.",
    })),
    risks: [],
  };
}

describe("material question identities", () => {
  test("bind IDs to question text and reason instead of list position", () => {
    const first = parseIntake({
      summary: "S",
      requirements: [{ description: "R", observableAcceptance: ["A"] }],
      materialQuestions: [
        { question: "Who can approve a refund?", whyMaterial: "This changes authorization." },
        { question: "Which region launches first?", whyMaterial: "This changes tax behavior." },
      ],
      researchQueries: ["refund system"],
    });
    const reversed = parseIntake({
      summary: "S",
      requirements: [{ description: "R", observableAcceptance: ["A"] }],
      materialQuestions: [
        { question: "Which region launches first?", whyMaterial: "This changes tax behavior." },
        { question: "Who can approve a refund?", whyMaterial: "This changes authorization." },
      ],
      researchQueries: ["refund system"],
    });
    expect(first.materialQuestions[0]!.id).toBe(reversed.materialQuestions[1]!.id);
    expect(first.materialQuestions[1]!.id).toBe(reversed.materialQuestions[0]!.id);
    expect(first.materialQuestions[0]!.id).toMatch(/^Q-[a-f0-9]{12}$/);
    expect(stableMaterialQuestionId("Who can approve a refund?", "This changes authorization.")).toBe(first.materialQuestions[0]!.id);
  });

  test("keeps domain terms and topic slugs unchanged while enforcing their bounds", () => {
    const intakeProperties = INTAKE_SCHEMA.properties as Record<string, any>;
    const refinedProperties = REFINED_BRIEF_SCHEMA.properties as Record<string, any>;
    expect((INTAKE_SCHEMA.required as string[])).toContain("domainTerms");
    expect((INTAKE_SCHEMA.required as string[])).toContain("topicSlugs");
    expect(REFINED_BRIEF_SCHEMA.required).toEqual(INTAKE_SCHEMA.required);
    expect(refinedProperties.materialQuestions.maxItems).toBe(0);
    expect({ ...refinedProperties, materialQuestions: undefined }).toEqual({ ...intakeProperties, materialQuestions: undefined });
    const domainTerms = ["  stars:>5 NOT \"event ticketing\"  ", "ticket -refund", "--- "];
    const topicSlugs = ["../invalid", "Event-Ticketing ", "event-ticketing", "ticket:system"];
    const parsed = parseIntake({
      summary: "Event tickets.",
      requirements: [{ description: "Sell tickets.", observableAcceptance: ["The order is recorded."] }],
      materialQuestions: [],
      researchQueries: ["event ticketing"],
      domainTerms,
      topicSlugs,
    });
    expect(parsed.domainTerms).toEqual(domainTerms);
    expect(parsed.topicSlugs).toEqual(topicSlugs);
    expect(parseIntake({
      summary: "Event tickets.",
      requirements: [{ description: "Sell tickets.", observableAcceptance: ["The order is recorded."] }],
      materialQuestions: [],
      researchQueries: ["event ticketing"],
    }).domainTerms).toEqual([]);
    expect(() => parseIntake({
      summary: "Event tickets.",
      requirements: [{ description: "Sell tickets.", observableAcceptance: ["The order is recorded."] }],
      materialQuestions: [],
      researchQueries: ["event ticketing"],
      domainTerms: Array(7).fill("ticket"),
      topicSlugs: [],
    })).toThrow("at most 6 items");
    expect(() => parseIntake({
      summary: "Event tickets.",
      requirements: [{ description: "Sell tickets.", observableAcceptance: ["The order is recorded."] }],
      materialQuestions: [],
      researchQueries: ["event ticketing"],
      domainTerms: ["ticket"],
      topicSlugs: ["a", "b", "c", "d", "e"],
    })).toThrow("at most 4 items");
    expect(() => parseIntake({
      summary: "Event tickets.",
      requirements: [{ description: "Sell tickets.", observableAcceptance: ["The order is recorded."] }],
      materialQuestions: [],
      researchQueries: ["event ticketing"],
      domainTerms: [3],
      topicSlugs: [],
    })).toThrow("must contain 1 to 120 characters");
  });

  test("advertises and enforces the same topic slug bounds", () => {
    const intakeProperties = INTAKE_SCHEMA.properties as Record<string, any>;
    const refinedProperties = REFINED_BRIEF_SCHEMA.properties as Record<string, any>;
    expect(intakeProperties.topicSlugs.items).toEqual({ type: "string", minLength: 1, maxLength: 50 });
    expect(refinedProperties.topicSlugs.items).toEqual({ type: "string", minLength: 1, maxLength: 50 });
    expect(intakeProperties.domainTerms.items).toEqual({ type: "string", minLength: 1, maxLength: 120 });

    const intakeWithTopic = (topic: string) => ({
      summary: "Event ticket service.",
      requirements: [{ description: "Sell tickets.", observableAcceptance: ["The ticket is reserved."] }],
      materialQuestions: [],
      researchQueries: ["event tickets"],
      topicSlugs: [topic],
    });
    expect(() => parseIntake(intakeWithTopic(""))).toThrow("topicSlugs[1] must contain 1 to 50 characters.");
    expect(() => parseIntake(intakeWithTopic("a".repeat(51)))).toThrow("topicSlugs[1] must contain 1 to 50 characters.");
    expect(parseIntake(intakeWithTopic("a")).topicSlugs).toEqual(["a"]);
    expect(parseIntake(intakeWithTopic("a".repeat(50))).topicSlugs).toEqual(["a".repeat(50)]);
    const fiftyCodePointsWithAstralCharacter = `${"a".repeat(49)}😀`;
    expect([...fiftyCodePointsWithAstralCharacter]).toHaveLength(50);
    expect(fiftyCodePointsWithAstralCharacter.length).toBe(51);
    expect(parseIntake(intakeWithTopic(fiftyCodePointsWithAstralCharacter)).topicSlugs).toEqual([fiftyCodePointsWithAstralCharacter]);
  });

  test("rebuild parsing preserves initial questions, regenerates IDs, and rejects new questions", () => {
    const initial = parseIntake({
      summary: "Initial brief.",
      requirements: [{ description: "Initial requirement.", observableAcceptance: ["Initial acceptance."] }],
      materialQuestions: [{ question: "Which event?", whyMaterial: "This changes ticketing rules." }],
      researchQueries: ["event tickets"],
      domainTerms: ["event ticketing"],
      topicSlugs: [],
    });
    const refinedPayload = {
      summary: "Clarified brief.",
      requirements: [{ description: "Sell event tickets.", observableAcceptance: ["The ticket is reserved."] }],
      outOfScope: ["Resale marketplace."],
      assumptions: ["The launch event is a single event."],
      materialQuestions: [],
      researchQueries: ["event admission"],
      domainTerms: ["event admission"],
      topicSlugs: ["event-ticketing"],
    };
    const rebuilt = parseRefinedBrief(refinedPayload, initial);
    expect(rebuilt.summary).toBe("Clarified brief.");
    expect(rebuilt.materialQuestions).toEqual(initial.materialQuestions);
    expect(rebuilt.requirements[0]?.id).toBe("R1");
    expect(rebuilt.requirements[0]?.observableAcceptance[0]?.id).toBe("A1");
    expect(() => parseRefinedBrief({ ...refinedPayload, materialQuestions: [{ question: "Another question?", whyMaterial: "It changes scope." }] }, initial)).toThrow(ModelOutputError);
  });
});

describe("host plan validation", () => {
  const repoA = snapshot("C1", "org/a", "a".repeat(40));
  const repoB = snapshot("C2", "org/b", "b".repeat(40));
  const repositories = [repoA, repoB];
  const sources = [localSource, sourceA, sourceB];

  test("rejects comparator A citing comparator B", () => {
    const output = plan("E3", repositories);
    expect(() => parsePlan(output, brief, excerpts, [], repositories, sources)).toThrow(/must cite evidence from github:org\/a/);
  });

  test("rejects a comparator claim citing local evidence", () => {
    const output = plan("E1", repositories);
    expect(() => parsePlan(output, brief, excerpts, [], repositories, sources)).toThrow(/must cite evidence from github:org\/a/);
  });

  test("accepts citations from the exact pinned repository for each comparison", () => {
    expect(() => parsePlan(plan("E2", repositories), brief, excerpts, [], repositories, sources)).not.toThrow();
  });

  test("rejects uncovered acceptance criteria and dependency cycles", () => {
    const uncovered = plan();
    uncovered.tasks[0]!.acceptance[0]!.coversAcceptanceIds = [];
    expect(() => parsePlan(uncovered, brief, excerpts, [], [repoA], sources)).toThrow();

    const cyclic = plan();
    cyclic.tasks.push({ ...cyclic.tasks[0]!, id: "T2", dependencies: ["T1"], acceptance: [{ ...cyclic.tasks[0]!.acceptance[0]!, requirementId: "R1" }] });
    cyclic.tasks[0]!.dependencies = ["T2"];
    expect(() => parsePlan(cyclic, brief, excerpts, [], [repoA], sources)).toThrow(/cycle/);
  });
});
