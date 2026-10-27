import { describe, expect, test } from "bun:test";
import { CANDIDATE_RANKING_SCHEMA, EVIDENCE_REQUEST_SCHEMA, FILE_SELECTION_SCHEMA, INTAKE_SCHEMA, ModelOutputError, PLAN_SCHEMA, REFINED_BRIEF_SCHEMA, REVIEW_SCHEMA, parseApprovedBrief, parseCandidateRanking, parseEvidenceRequests, parseFileSelection, parseIntake, parsePlan, parseRefinedBrief, parseReview, stableMaterialQuestionId, verifiedUserWords } from "../src/model-schema.ts";
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
      verification: [{
        kind: "manual",
        coversAcceptanceIds: ["A1"],
        description: "Submit a valid request and inspect the record.",
        commandId: null,
        plannedCommand: null,
        rejectsMutants: [{ acceptanceId: "A1", wrongImplementation: "The handler returns success without saving the request.", observedFailure: "The inspected record list has no refund request." }],
      }],
      evidence: [{ excerptId: "E1", claim: "The local application has a request-handling entry point." }],
    }],
    decisions: [],
    referenceComparisons: snapshots.map((repository) => ({
      candidateId: repository.candidate.id,
      adoptedPatterns: [{ pattern: "Use a request status field.", evidence: [{ excerptId: repository.candidate.id === "C1" ? comparisonEvidence : "E3", claim: "The comparator records request state." }], testEvidence: [], untestedReason: "No test of the comparator was read for this fixture." }],
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

  test("advertises and enforces code pattern bounds without adding the field when it is absent", () => {
    const intakeProperties = INTAKE_SCHEMA.properties as Record<string, any>;
    expect(INTAKE_SCHEMA.required as string[]).toContain("codePatterns");
    expect(intakeProperties.codePatterns).toEqual({ type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 3, maxLength: 40 } });
    expect((REFINED_BRIEF_SCHEMA.properties as Record<string, any>).codePatterns).toEqual(intakeProperties.codePatterns);
    const base = {
      summary: "Event tickets.",
      requirements: [{ description: "Refund tickets.", observableAcceptance: ["A refund is recorded."] }],
      materialQuestions: [],
      researchQueries: ["event ticketing"],
    };
    expect(parseIntake({ ...base, codePatterns: ["OrderRefund", "refund_amount"] }).codePatterns).toEqual(["OrderRefund", "refund_amount"]);
    expect("codePatterns" in parseIntake(base)).toBe(false);
    expect(() => parseIntake({ ...base, codePatterns: ["aaa", "bbb", "ccc", "ddd", "eee"] })).toThrow("codePatterns must contain at most 4 items.");
    expect(() => parseIntake({ ...base, codePatterns: ["ab"] })).toThrow("codePatterns[1] must contain 3 to 40 characters.");

    const initial = parseIntake(base);
    const validBoundary = "a".repeat(40);
    const invalidBoundary = "a".repeat(41);
    expect(parseIntake({ ...base, codePatterns: [validBoundary] }).codePatterns).toEqual([validBoundary]);
    expect(parseRefinedBrief({ ...base, codePatterns: [validBoundary] }, initial).codePatterns).toEqual([validBoundary]);
    expect(parseIntake({ ...base, codePatterns: [] }).codePatterns).toEqual([]);
    expect(parseRefinedBrief({ ...base, codePatterns: [] }, initial).codePatterns).toEqual([]);
    expect(() => parseIntake({ ...base, codePatterns: [invalidBoundary] })).toThrow("codePatterns[1] must contain 3 to 40 characters.");
    expect(() => parseRefinedBrief({ ...base, codePatterns: [invalidBoundary] }, initial)).toThrow("codePatterns[1] must contain 3 to 40 characters.");
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

describe("candidate ranking", () => {
  test("accepts a ranking of known, unique candidate IDs and rejects others", () => {
    const candidates = ["C1", "C2", "C3"].map((id) => snapshot(id, `org/${id}`, "a".repeat(40)).candidate);

    expect(parseCandidateRanking({ ranked: ["C3", "C1"] }, candidates)).toEqual(["C3", "C1"]);
    expect(parseCandidateRanking({ ranked: [] }, candidates)).toEqual([]);
    expect(() => parseCandidateRanking({ ranked: ["C9"] }, candidates)).toThrow("Unknown repository candidate ID: C9.");
    expect(() => parseCandidateRanking({ ranked: ["C1", "C1"] }, candidates)).toThrow("Repository candidate appears more than once: C1.");
    expect(() => parseCandidateRanking({ ranked: Array.from({ length: 13 }, () => "C1") }, candidates)).toThrow("ranked must contain 0 to 12 items.");
    expect(CANDIDATE_RANKING_SCHEMA).toMatchObject({ required: ["ranked"], properties: { ranked: { maxItems: 12 } } });
  });
});

describe("file selection", () => {
  test("keeps offered file IDs once, in order, and counts the IDs it ignores", () => {
    const offered = [{ id: "A" }, { id: "B" }];
    const choice = (fileId: string) => ({ fileId, role: "production" as const, rationale: "Relevant." });

    expect(parseFileSelection({ files: [choice("A"), choice("X"), choice("A"), choice("B")] }, offered)).toEqual({ files: [choice("A"), choice("B")], ignored: 2 });
    expect(parseFileSelection({ files: [choice("B"), choice("X"), choice("A"), choice("B")] }, offered)).toEqual({ files: [choice("B"), choice("A")], ignored: 2 });
    expect(parseFileSelection({ files: [choice("X")] }, offered)).toEqual({ files: [], ignored: 1 });
    expect(() => parseFileSelection({ files: [{ fileId: "A", role: "owner", rationale: "Relevant." }] }, offered)).toThrow(ModelOutputError);
  });

  test("chooses at most 20 files", () => {
    const offered = Array.from({ length: 21 }, (_, index) => ({ id: `F${index + 1}` }));
    const choices = offered.map((file) => ({ fileId: file.id, role: "production" as const, rationale: "Relevant." }));

    expect(parseFileSelection({ files: choices.slice(0, 20) }, offered).files).toHaveLength(20);
    expect(() => parseFileSelection({ files: choices }, offered)).toThrow("files must contain 0 to 20 items.");
    expect(FILE_SELECTION_SCHEMA).toMatchObject({ properties: { files: { maxItems: 20 } } });
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

describe("named wrong implementations", () => {
  const repoA = snapshot("C1", "org/a", "a".repeat(40));
  const sources = [localSource, sourceA, sourceB];
  const twoBrief = parseIntake({
    summary: "Add a refund flow.",
    requirements: [{ description: "Issue a refund.", observableAcceptance: ["A refund request is recorded.", "A refund over the charge is refused."] }],
    materialQuestions: [],
  });
  const threeBrief = parseIntake({
    summary: "Add a refund flow.",
    requirements: [{ description: "Issue a refund.", observableAcceptance: ["A refund request is recorded.", "A refund over the charge is refused.", "A refunded charge shows its refund."] }],
    materialQuestions: [],
  });
  const wideBrief = parseIntake({
    summary: "Add a refund flow.",
    requirements: [1, 2, 3].map((number) => ({
      description: `Refund rule ${number}.`,
      observableAcceptance: Array.from({ length: 8 }, (_, index) => `Outcome ${(number - 1) * 8 + index + 1} is visible.`),
    })),
    materialQuestions: [],
  });
  const mutant = (acceptanceId: string, fields: Record<string, unknown> = {}) => ({
    acceptanceId,
    wrongImplementation: `The handler skips the rule behind ${acceptanceId}.`,
    observedFailure: `The check for ${acceptanceId} reports the missing outcome.`,
    ...fields,
  });
  // A plan whose only task covers every acceptance criterion of the brief.
  const planFor = (target: IntakeBrief): Record<string, any> => {
    const output = plan();
    output.tasks[0]!.requirementIds = target.requirements.map((requirement) => requirement.id);
    output.tasks[0]!.acceptance = target.requirements.map((requirement) => ({
      requirementId: requirement.id,
      coversAcceptanceIds: requirement.observableAcceptance.map((item) => item.id),
      condition: `${requirement.description} holds.`,
    }));
    return output;
  };

  test("numbers named wrong implementations per verification and ignores a model-supplied id", () => {
    const output = planFor(twoBrief);
    output.tasks[0]!.verification = [
      { ...output.tasks[0]!.verification[0]!, coversAcceptanceIds: ["A1", "A2"], rejectsMutants: [mutant("A1", { id: "X9" }), mutant("A2")] },
      { ...output.tasks[0]!.verification[0]!, coversAcceptanceIds: ["A2"], rejectsMutants: [mutant("A2")] },
    ];
    const verification = parsePlan(output, twoBrief, excerpts, [], [repoA], sources).tasks[0]!.verification;
    expect(verification.map((method) => method.rejectsMutants)).toEqual([
      [
        { id: "T1-V1-M1", acceptanceId: "A1", wrongImplementation: "The handler skips the rule behind A1.", observedFailure: "The check for A1 reports the missing outcome." },
        { id: "T1-V1-M2", acceptanceId: "A2", wrongImplementation: "The handler skips the rule behind A2.", observedFailure: "The check for A2 reports the missing outcome." },
      ],
      [{ id: "T1-V2-M1", acceptanceId: "A2", wrongImplementation: "The handler skips the rule behind A2.", observedFailure: "The check for A2 reports the missing outcome." }],
    ]);
  });

  test("requires a named wrong implementation for every acceptance a verification covers", () => {
    const output = planFor(twoBrief);
    output.tasks[0]!.verification[0]!.coversAcceptanceIds = ["A1", "A2"];
    output.tasks[0]!.verification[0]!.rejectsMutants = [mutant("A1")];
    expect(() => parsePlan(output, twoBrief, excerpts, [], [repoA], sources)).toThrow("T1-V1 names no wrong implementation for A2.");

    // The missing ID comes first or in the middle, and a repeated ID does not stand in for another.
    const parsed = (rejectsMutants: Record<string, unknown>[]) => {
      const covering = planFor(threeBrief);
      covering.tasks[0]!.verification[0]!.coversAcceptanceIds = ["A1", "A2", "A3"];
      covering.tasks[0]!.verification[0]!.rejectsMutants = rejectsMutants;
      return () => parsePlan(covering, threeBrief, excerpts, [], [repoA], sources);
    };
    expect(parsed([mutant("A2"), mutant("A3")])).toThrow("T1-V1 names no wrong implementation for A1.");
    expect(parsed([mutant("A1"), mutant("A3")])).toThrow("T1-V1 names no wrong implementation for A2.");
    expect(parsed([mutant("A1"), mutant("A1"), mutant("A3")])).toThrow("T1-V1 names no wrong implementation for A2.");
    expect(parsed([mutant("A3"), mutant("A1"), mutant("A2")])).not.toThrow();
  });

  test("rejects a named wrong implementation for acceptance the verification does not cover", () => {
    const output = plan();
    output.tasks[0]!.verification[0]!.rejectsMutants = [mutant("A1"), mutant("A9")];
    expect(() => parsePlan(output, brief, excerpts, [], [repoA], sources)).toThrow("T1-V1 names a wrong implementation for A9, which it does not cover.");
  });

  test("requires named wrong implementations on manual, existing and new-command verifications", () => {
    const commands = [{ id: "CMD1", command: "bun test", sourceId: "S1", line: 3 }];
    const kinds = [
      { kind: "manual", commandId: null, plannedCommand: null },
      { kind: "existing", commandId: "CMD1", plannedCommand: null },
      { kind: "to_create", commandId: null, plannedCommand: "bun test test/refunds.test.ts" },
    ];
    for (const fields of kinds) {
      const valid = plan();
      Object.assign(valid.tasks[0]!.verification[0]!, fields);
      expect(parsePlan(valid, brief, excerpts, commands, [repoA], sources).tasks[0]!.verification[0]!.rejectsMutants).toHaveLength(1);
      for (const rejectsMutants of [undefined, []]) {
        const output = plan();
        Object.assign(output.tasks[0]!.verification[0]!, fields, { rejectsMutants });
        expect(() => parsePlan(output, brief, excerpts, commands, [repoA], sources)).toThrow("T1.verification[1].rejectsMutants must contain 1 to 24 items.");
      }
    }
  });

  test("labels a missing list of wrong implementations with the position of its verification", () => {
    const output = plan();
    const first = output.tasks[0]!.verification[0]!;
    output.tasks[0]!.verification = [first, { ...first, rejectsMutants: [] }];
    expect(() => parsePlan(output, brief, excerpts, [], [repoA], sources)).toThrow("T1.verification[2].rejectsMutants must contain 1 to 24 items.");
  });

  test("accepts one named wrong implementation for each of 24 covered criteria and rejects a 25th", () => {
    const ids = wideBrief.requirements.flatMap((requirement) => requirement.observableAcceptance.map((item) => item.id));
    const output = planFor(wideBrief);
    output.tasks[0]!.verification[0]!.coversAcceptanceIds = ids;
    output.tasks[0]!.verification[0]!.rejectsMutants = ids.map((acceptanceId) => mutant(acceptanceId));
    const mutants = parsePlan(output, wideBrief, excerpts, [], [repoA], sources).tasks[0]!.verification[0]!.rejectsMutants;
    expect(ids).toHaveLength(24);
    expect(mutants.map((item) => item.acceptanceId)).toEqual(ids);
    expect(mutants.at(-1)!.id).toBe("T1-V1-M24");

    output.tasks[0]!.verification[0]!.rejectsMutants.push(mutant("A1"));
    expect(() => parsePlan(output, wideBrief, excerpts, [], [repoA], sources)).toThrow("T1.verification[1].rejectsMutants must contain 1 to 24 items.");
  });

  test("limits each wrong implementation and expected failure to 500 characters", () => {
    const parsed = (fields: Record<string, unknown>) => {
      const output = plan();
      output.tasks[0]!.verification[0]!.rejectsMutants = [mutant("A1", fields)];
      return () => parsePlan(output, brief, excerpts, [], [repoA], sources);
    };
    expect(parsed({ wrongImplementation: "w".repeat(500), observedFailure: "f".repeat(500) })).not.toThrow();
    expect(parsed({ wrongImplementation: "w".repeat(501) })).toThrow("T1.verification[1].rejectsMutants[1].wrongImplementation must contain 1 to 500 characters.");
    expect(parsed({ observedFailure: "f".repeat(501) })).toThrow("T1.verification[1].rejectsMutants[1].observedFailure must contain 1 to 500 characters.");
    expect(parsed({ wrongImplementation: "  " })).toThrow("T1.verification[1].rejectsMutants[1].wrongImplementation must contain 1 to 500 characters.");
  });

  test("gives the model room for one named wrong implementation per covered acceptance", () => {
    const verification = (PLAN_SCHEMA.properties as Record<string, any>).tasks.items.properties.verification.items;
    expect(verification.required).toContain("rejectsMutants");
    expect(verification.properties.coversAcceptanceIds).toMatchObject({ minItems: 1, maxItems: 24 });
    expect(verification.properties.rejectsMutants).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 24,
      items: { required: ["acceptanceId", "wrongImplementation", "observedFailure"], additionalProperties: false },
    });
  });
});

describe("reference test evidence", () => {
  const repoA = snapshot("C1", "org/a", "a".repeat(40));
  const repoB = snapshot("C2", "org/b", "b".repeat(40));
  const testSourceA = source("S4", "remote", { provider: "github", repository: "org/a", commitSha: "a".repeat(40), path: "tests/refund.test.ts", roles: ["test"] });
  const testSourceB = source("S5", "remote", { provider: "github", repository: "org/b", commitSha: "b".repeat(40), path: "tests/refund.test.ts", roles: ["test"] });
  const sources = [localSource, sourceA, sourceB, testSourceA, testSourceB];
  const testExcerpts: EvidenceExcerpt[] = [
    ...excerpts,
    { id: "E4", sourceId: "S4", startLine: 1, endLine: 6, text: "repository A test" },
    { id: "E5", sourceId: "S5", startLine: 1, endLine: 6, text: "repository B test" },
  ];
  // Sets the reference test fields of the first adopted pattern of the first comparison.
  const withTest = (output: Record<string, any>, testEvidence: unknown, untestedReason: unknown): Record<string, any> => {
    Object.assign(output.referenceComparisons[0].adoptedPatterns[0], { testEvidence, untestedReason });
    return output;
  };
  const testRef = { excerptId: "E4", claim: "The comparator test records a pending refund." };

  test("keeps the cited reference test or the untested reason on each adopted pattern", () => {
    const parsed = parsePlan(withTest(plan("E2", [repoA, repoB]), [testRef], null), brief, testExcerpts, [], [repoA, repoB], sources);
    expect(parsed.referenceComparisons[0]!.adoptedPatterns[0]).toEqual({
      pattern: "Use a request status field.",
      evidence: [{ excerptId: "E2", claim: "The comparator records request state." }],
      testEvidence: [testRef],
    });
    expect(parsed.referenceComparisons[1]!.adoptedPatterns[0]).toEqual({
      pattern: "Use a request status field.",
      evidence: [{ excerptId: "E3", claim: "The comparator records request state." }],
      testEvidence: [],
      untestedReason: "No test of the comparator was read for this fixture.",
    });
  });

  test("rejects a reference test citation from a file the host did not read as a test", () => {
    const output = withTest(plan("E2", [repoA]), [{ excerptId: "E2", claim: "The handler is tested." }], null);
    expect(() => parsePlan(output, brief, testExcerpts, [], [repoA], sources)).toThrow("Adopted pattern test for C1 cites E2 from S2.ts, which the host did not read as a test file.");
  });

  test("rejects a reference test citation from another comparator's tests", () => {
    const output = withTest(plan("E2", [repoA, repoB]), [{ excerptId: "E5", claim: "The other comparator tests refunds." }], null);
    expect(() => parsePlan(output, brief, testExcerpts, [], [repoA, repoB], sources)).toThrow(`Adopted pattern test for C1 must cite evidence from github:org/a@${"a".repeat(40)}.`);
  });

  test("requires exactly one of reference test evidence and a non-blank untested reason", () => {
    const message = "Adopted pattern 1 for C1 needs reference test evidence or an untestedReason, but not both.";
    expect(() => parsePlan(withTest(plan("E2", [repoA]), [], null), brief, testExcerpts, [], [repoA], sources)).toThrow(message);
    expect(() => parsePlan(withTest(plan("E2", [repoA]), [testRef], "The test covers only full refunds."), brief, testExcerpts, [], [repoA], sources)).toThrow(message);
    expect(() => parsePlan(withTest(plan("E2", [repoA]), [], "   "), brief, testExcerpts, [], [repoA], sources)).toThrow("adopted pattern untested reason must contain 1 to 700 characters.");
  });

  test("accepts at most six reference test citations on one adopted pattern", () => {
    expect(() => parsePlan(withTest(plan("E2", [repoA]), Array(6).fill(testRef), null), brief, testExcerpts, [], [repoA], sources)).not.toThrow();
    expect(() => parsePlan(withTest(plan("E2", [repoA]), Array(7).fill(testRef), null), brief, testExcerpts, [], [repoA], sources)).toThrow("adopted pattern test evidence must contain 0 to 6 items.");
  });

  test("advertises reference test evidence and the untested reason as required adopted pattern fields", () => {
    const comparisons = (PLAN_SCHEMA.properties as Record<string, any>).referenceComparisons;
    const pattern = comparisons.items.properties.adoptedPatterns.items;
    expect(pattern.required).toEqual(["pattern", "evidence", "testEvidence", "untestedReason"]);
    // Each test citation has the shape of a production citation, so parseEvidence accepts what a strict model returns.
    expect(pattern.properties.testEvidence).toEqual({
      type: "array",
      items: { type: "object", properties: { excerptId: { type: "string" }, claim: { type: "string" } }, required: ["excerptId", "claim"], additionalProperties: false },
      maxItems: 6,
    });
    expect(pattern.properties.testEvidence.items).toEqual(pattern.properties.evidence.items);
    expect(pattern.properties.untestedReason).toEqual({ type: ["string", "null"] });
  });
});

describe("evidence requests", () => {
  const item = (fields: Record<string, unknown>) => ({ kind: "definition", id: "S1", name: "approveRefund", startLine: 0, endLine: 0, reason: "The plan needs it.", ...fields });

  test("reads definition, lines and file requests and keeps only the fields of each kind", () => {
    expect(parseEvidenceRequests({
      requests: [
        item({ startLine: 4, endLine: 9 }),
        item({ kind: "lines", name: "ignored", startLine: 20, endLine: 40 }),
        item({ kind: "file", id: "C1F7", name: "ignored", startLine: 3, endLine: 5 }),
      ],
    })).toEqual([
      { kind: "definition", id: "S1", name: "approveRefund", startLine: 0, endLine: 0, reason: "The plan needs it." },
      { kind: "lines", id: "S1", name: "", startLine: 20, endLine: 40, reason: "The plan needs it." },
      { kind: "file", id: "C1F7", name: "", startLine: 0, endLine: 0, reason: "The plan needs it." },
    ]);
    expect(parseEvidenceRequests({ requests: [] })).toEqual([]);
    expect((EVIDENCE_REQUEST_SCHEMA.properties as { requests: { maxItems: number } }).requests.maxItems).toBe(8);
  });

  test("rejects more than eight requests, an unknown kind, a definition without a name and lines that are not whole numbers", () => {
    expect(() => parseEvidenceRequests({ requests: Array.from({ length: 9 }, () => item({})) })).toThrow(ModelOutputError);
    expect(() => parseEvidenceRequests({ requests: [item({ kind: "symbol" })] })).toThrow("Unsupported request kind: symbol.");
    expect(() => parseEvidenceRequests({ requests: [item({ name: "" })] })).toThrow(ModelOutputError);
    expect(() => parseEvidenceRequests({ requests: [item({ name: "approve refund" })] })).toThrow("requests[1].name must not contain whitespace.");
    expect(() => parseEvidenceRequests({ requests: [item({ kind: "lines", startLine: 1.5, endLine: 4 })] })).toThrow("requests[1] needs whole line numbers.");
    expect(() => parseEvidenceRequests({ requests: [item({ reason: "" })] })).toThrow(ModelOutputError);
    expect(() => parseEvidenceRequests({ requests: [item({ id: "" })] })).toThrow(ModelOutputError);
  });
});

describe("surviving mutants in review", () => {
  const reviewBrief = parseIntake({
    summary: "Approve refunds.",
    requirements: [{ description: "Approve refunds.", observableAcceptance: ["A manager approves a pending refund.", "A requester cannot approve their own refund."] }],
    outOfScope: [],
    assumptions: [],
    materialQuestions: [],
    researchQueries: ["refund approval"],
  });
  const mutant = { acceptanceId: "A1", wrongImplementation: "Approves every refund.", whyPlannedChecksPass: "The only check signs in as a manager.", decisionNeeded: null };

  test("keeps surviving mutants for known acceptance criteria and reads a null decision as none", () => {
    const review = parseReview({
      findings: [],
      survivingMutants: [
        { ...mutant, wrongImplementation: " Approves every refund. " },
        { acceptanceId: "A2", wrongImplementation: "Lets a requester approve a refund they filed for a customer.", whyPlannedChecksPass: "No check files a refund for a customer.", decisionNeeded: "May a requester approve a refund they filed for a customer?" },
      ],
    }, reviewBrief, []);
    expect(review.survivingMutants).toStrictEqual([
      { acceptanceId: "A1", wrongImplementation: "Approves every refund.", whyPlannedChecksPass: "The only check signs in as a manager." },
      { acceptanceId: "A2", wrongImplementation: "Lets a requester approve a refund they filed for a customer.", whyPlannedChecksPass: "No check files a refund for a customer.", decisionNeeded: "May a requester approve a refund they filed for a customer?" },
    ]);
  });

  test("drops a surviving mutant it cannot use and every one past the cap, keeps the rest in order and notes each drop", () => {
    const review = (fields: Record<string, unknown>, count = 1) => ({ findings: [], survivingMutants: Array.from({ length: count }, () => ({ ...mutant, ...fields })) });
    const dropped = (fields: Record<string, unknown>, count = 1) => parseReview(review(fields, count), reviewBrief, []).dropped;
    expect(parseReview(review({ acceptanceId: "A9" }), reviewBrief, [])).toStrictEqual({ findings: [], survivingMutants: [], dropped: ["the host dropped surviving mutant 1: A9 is not an acceptance criterion of the brief."] });
    expect(dropped({ acceptanceId: "R1" })).toEqual(["the host dropped surviving mutant 1: R1 is not an acceptance criterion of the brief."]);
    expect(dropped({ acceptanceId: "T1-A1" })).toEqual(["the host dropped surviving mutant 1: T1-A1 is not an acceptance criterion of the brief."]);
    expect(dropped({ wrongImplementation: "x".repeat(1201) })).toEqual(["the host dropped surviving mutant 1: survivingMutants[1].wrongImplementation must contain 1 to 1200 characters."]);
    expect(dropped({ whyPlannedChecksPass: "x".repeat(1201) })).toEqual(["the host dropped surviving mutant 1: survivingMutants[1].whyPlannedChecksPass must contain 1 to 1200 characters."]);
    expect(dropped({ decisionNeeded: "x".repeat(701) })).toEqual(["the host dropped surviving mutant 1: survivingMutants[1].decisionNeeded must contain 1 to 700 characters."]);

    const atLimits = parseReview(review({ wrongImplementation: "x".repeat(1200), whyPlannedChecksPass: "y".repeat(1200), decisionNeeded: "z".repeat(700) }, 12), reviewBrief, []);
    expect(atLimits.survivingMutants).toHaveLength(12);
    expect(atLimits.dropped).toEqual([]);
    const pastCap = parseReview({ findings: [], survivingMutants: Array.from({ length: 14 }, (_, index) => ({ ...mutant, wrongImplementation: `Wrong implementation ${index + 1}.` })) }, reviewBrief, []);
    expect(pastCap.survivingMutants.map((entry) => entry.wrongImplementation)).toEqual(Array.from({ length: 12 }, (_, index) => `Wrong implementation ${index + 1}.`));
    expect(pastCap.dropped).toEqual(["the host dropped 2 surviving mutant(s) after the first 12."]);

    const mixed = parseReview({ findings: [], survivingMutants: [mutant, { ...mutant, acceptanceId: "T1-A1" }, "Approves every refund.", { ...mutant, acceptanceId: "A2" }] }, reviewBrief, []);
    expect(mixed.survivingMutants.map((entry) => entry.acceptanceId)).toEqual(["A1", "A2"]);
    expect(mixed.dropped).toEqual([
      "the host dropped surviving mutant 2: T1-A1 is not an acceptance criterion of the brief.",
      "the host dropped surviving mutant 3: survivingMutants[3] must be an object.",
    ]);
    expect(parseReview({ findings: [], survivingMutants: "none" }, reviewBrief, [])).toStrictEqual({ findings: [], survivingMutants: [], dropped: ["the host read survivingMutants as none because it is not a list."] });
    expect(parseReview({ findings: [], survivingMutants: null }, reviewBrief, []).dropped).toEqual(["the host read survivingMutants as none because it is not a list."]);
  });

  test("reads a blank decisionNeeded as no decision", () => {
    expect(parseReview({ findings: [], survivingMutants: [{ ...mutant, decisionNeeded: "" }, { ...mutant, decisionNeeded: " \n " }] }, reviewBrief, [])).toStrictEqual({
      findings: [],
      survivingMutants: [
        { acceptanceId: "A1", wrongImplementation: "Approves every refund.", whyPlannedChecksPass: "The only check signs in as a manager." },
        { acceptanceId: "A1", wrongImplementation: "Approves every refund.", whyPlannedChecksPass: "The only check signs in as a manager." },
      ],
      dropped: [],
    });
  });

  test("keeps findings strict while it drops surviving mutants", () => {
    const finding = { severity: "material", description: "No check covers approval.", requirementIds: ["R9"], evidence: [], suggestedCorrection: "Add one." };
    expect(() => parseReview({ findings: [finding], survivingMutants: [] }, reviewBrief, [])).toThrow("Review refers to unknown requirement R9.");
  });

  test("requires survivingMutants in the review schema and reads a review without the key as none", () => {
    const schema = REVIEW_SCHEMA as { required: string[]; properties: { survivingMutants: { maxItems: number; items: { required: string[]; properties: { decisionNeeded: { type: unknown } } } } } };
    expect(schema.required).toEqual(["findings", "survivingMutants"]);
    expect(schema.properties.survivingMutants.maxItems).toBe(12);
    expect(schema.properties.survivingMutants.items.required).toEqual(["acceptanceId", "wrongImplementation", "whyPlannedChecksPass", "decisionNeeded"]);
    expect(schema.properties.survivingMutants.items.properties.decisionNeeded.type).toEqual(["string", "null"]);
    expect(parseReview({ findings: [] }, reviewBrief, [])).toStrictEqual({ findings: [], survivingMutants: [], dropped: [] });
  });
});

describe("requirement labels", () => {
  test("asks intake and the rebuild for a nullable userWords on every requirement", () => {
    const requirements = (INTAKE_SCHEMA.properties as Record<string, any>).requirements;
    expect(requirements.items.properties.userWords).toEqual({ type: ["string", "null"] });
    expect(requirements.items.required).toContain("userWords");
    expect((REFINED_BRIEF_SCHEMA.properties as Record<string, any>).requirements).toEqual(requirements);
  });

  test("keeps userWords only when its normalized form of at least four code points is in a user text", () => {
    expect(verifiedUserWords("the right  password", ["You only get a token with the right\npassword."])).toBe("the right password");
    expect(verifiedUserWords("ｒｉｇｈｔ password", ["the right password"])).toBe("right password");
    expect(verifiedUserWords("pass", ["password"])).toBe("pass");
    expect(verifiedUserWords("the", ["the right password"])).toBeUndefined();
    // Surrounding whitespace is trimmed before the floor, so " ab " is two code points, not four.
    expect(verifiedUserWords(" ab ", ["x ab y"])).toBeUndefined();
    expect(verifiedUserWords("a😀b", ["xa😀by"])).toBeUndefined();
    expect(verifiedUserWords("wrong password", ["the right password"])).toBeUndefined();
    expect(verifiedUserWords("right password", ["the requirement", "the right password"])).toBe("right password");
    expect(verifiedUserWords(null, ["the right password"])).toBeUndefined();
  });

  test("labels each intake requirement stated or inferred and rejects userWords that is neither text nor null", () => {
    const intake = {
      summary: "Sign-in tokens.",
      requirements: [
        { description: "Issue a token only for the right password.", userWords: "You only get a token with the right password.", observableAcceptance: ["A wrong password gets no token."] },
        { description: "Lock the account after five failures.", userWords: "Lock after five failures.", observableAcceptance: ["The sixth try is refused."] },
        { description: "Log every sign-in.", observableAcceptance: ["A sign-in is logged."] },
      ],
      materialQuestions: [],
      researchQueries: ["token sign-in"],
    };
    const parsed = parseIntake(intake, ["Build sign-in. You only get a token with the right password."]);
    expect(parsed.requirements.map((requirement) => [requirement.origin, requirement.userWords])).toEqual([
      ["stated", "You only get a token with the right password."],
      ["inferred", undefined],
      ["inferred", undefined],
    ]);
    expect("userWords" in parsed.requirements[1]!).toBe(false);
    expect(() => parseIntake({ ...intake, requirements: [{ description: "Sign in.", userWords: 3, observableAcceptance: ["A token is issued."] }] })).toThrow("requirements[1].userWords must be text or null.");
  });

  test("labels a rebuilt requirement stated when a confirmed answer holds its words", () => {
    const base = { summary: "Event tickets.", materialQuestions: [], researchQueries: ["event tickets"] };
    const initial = parseIntake({ ...base, requirements: [{ description: "Sell tickets.", userWords: null, observableAcceptance: ["A ticket is sold."] }], materialQuestions: [{ question: "How is entry checked?", whyMaterial: "This changes admission." }] });
    const rebuilt = parseRefinedBrief(
      { ...base, requirements: [{ description: "Check entry by QR scan.", userWords: "entry is checked by QR scan", observableAcceptance: ["A scanned ticket admits one person."] }] },
      initial,
      ["Build an event ticketing system.", "One event; entry is checked by QR scan."],
    );
    expect(rebuilt.requirements[0]).toMatchObject({ origin: "stated", userWords: "entry is checked by QR scan" });
  });

  test("checks an approved brief like intake without material questions and reassigns its IDs and labels", () => {
    const questions = [{ id: stableMaterialQuestionId("Which event?", "This sets the scope."), question: "Which event?", whyMaterial: "This sets the scope." }];
    const edited = {
      summary: "Edited event brief.",
      requirements: [
        { description: "Sell tickets.", userWords: "sell tickets", observableAcceptance: ["A ticket is sold."] },
        { description: "Scan entry.", userWords: "words nobody wrote", observableAcceptance: ["An entry is scanned.", "A used ticket is refused."] },
      ],
      outOfScope: [],
      assumptions: [],
      researchQueries: ["event tickets"],
      domainTerms: ["ticket"],
      topicSlugs: [],
      codePatterns: ["checkin"],
    };
    const approved = parseApprovedBrief(edited, questions, ["We sell tickets for one event.", "One event."]);
    expect(approved.requirements.map((requirement) => requirement.id)).toEqual(["R1", "R2"]);
    expect(approved.requirements[1]!.observableAcceptance.map((criterion) => criterion.id)).toEqual(["A2", "A3"]);
    expect(approved.requirements.map((requirement) => requirement.origin)).toEqual(["stated", "inferred"]);
    expect(approved.materialQuestions).toEqual(questions);
    expect(() => parseApprovedBrief({ ...edited, materialQuestions: [{ question: "Another?", whyMaterial: "It adds scope." }] }, questions, [])).toThrow("The approved brief may not contain material questions.");
    expect(() => parseApprovedBrief({ ...edited, requirements: [] }, questions, [])).toThrow("requirements must contain 1 to 12 items.");
  });
});
