import { describe, expect, test } from "bun:test";
import { renderReport } from "../src/report.ts";
import { parseIntake } from "../src/model-schema.ts";
import type { EvidenceSource, PlanDocument } from "../src/types.ts";

test("report citations use GitLab's documented Lstart-end anchor", () => {
  const brief = parseIntake({
    summary: "Architecture and source research remain pending answers.",
    requirements: [{ description: "Record refunds.", observableAcceptance: ["A refund is recorded."] }],
    outOfScope: [],
    assumptions: [],
    materialQuestions: [],
    researchQueries: ["refund endpoint"],
  });
  const source: EvidenceSource = {
    id: "S1",
    kind: "remote",
    path: "src/refund.ts",
    sha256: "a".repeat(64),
    lineCount: 10,
    byteCount: 150,
    provider: "gitlab",
    repository: "org/refunds",
    commitSha: "b".repeat(40),
    permalink: "https://gitlab.com/org/refunds/-/blob/commit/src/refund.ts",
    snapshotPath: "sources/S1.txt",
    roles: ["production"],
  };
  const plan: PlanDocument = {
    title: "Refund plan",
    summary: "Record a refund request.",
    requirements: brief.requirements,
    tasks: [{
      id: "T1",
      title: "Create the endpoint",
      description: "Validate and save the request.",
      requirementIds: ["R1"],
      dependencies: [],
      acceptance: [{ id: "T1-A1", requirementId: "R1", coversAcceptanceIds: ["A1"], condition: "A refund request is saved." }],
      verification: [{ id: "T1-V1", kind: "manual", acceptanceIds: ["A1"], description: "Submit a request and inspect the record." }],
      evidence: [{ excerptId: "E1", claim: "The reference validates refund inputs." }],
    }],
    decisions: [],
    design: {
      architecture: "A request endpoint validates and records refunds.",
      modules: [],
      dataModel: { entities: [], notApplicableReason: "Not included in this rendering fixture." },
      invariants: { items: [], notApplicableReason: "Not included in this rendering fixture." },
      accessControl: { boundaries: [], notApplicableReason: "Not included in this rendering fixture." },
    },
    repositoryChoices: [],
    referenceComparisons: [],
    risks: [],
    readiness: "draft",
    readinessNotes: [],
  };
  const report = renderReport({
    brief,
    resolvedAnswers: [{
      questionId: "Q-123456abcdef",
      question: "Who may approve refunds?",
      whyMaterial: "This defines the refund authorization boundary.",
      answer: "Only named refund managers.",
    }],
    plan,
    sources: [{
      id: "S1",
      kind: "remote",
      path: source.path,
      location: source.permalink!,
      snapshotPath: source.snapshotPath,
      sha256: source.sha256,
      lineCount: source.lineCount,
      byteCount: source.byteCount,
      provider: "gitlab",
      repository: source.repository,
      commitSha: source.commitSha,
      permalink: source.permalink,
      roles: source.roles,
      excerpts: [{ id: "E1", startLine: 3, endLine: 10 }],
    }],
    evidence: {
      sources: [source],
      excerpts: [{ id: "E1", sourceId: "S1", startLine: 3, endLine: 10, text: "source text" }],
      bytesBySourceId: new Map([["S1", new TextEncoder().encode("source text")]]),
      textBySourceId: new Map([["S1", "source text"]]),
      gaps: [],
    },
    gaps: [],
    reviews: [],
    validationIssues: [],
    validationHistory: [],
    commands: [],
  });
  expect(report).toContain("https://gitlab.com/org/refunds/-/blob/commit/src/refund.ts#L3-10");
  expect(report).not.toContain("#L3-L10");
  expect(report).toContain("**Final plan scope.** Record a refund request.");
  expect(report).toContain("Initial intake summary (before material answers and source review)");
  expect(report).not.toContain("**Brief.**");
  expect(report).toContain("Who may approve refunds?");
  expect(report).toContain("Only named refund managers.");
});
