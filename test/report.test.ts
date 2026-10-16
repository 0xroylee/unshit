import { describe, expect, test } from "bun:test";
import { renderReport } from "../src/report.ts";
import { parseIntake } from "../src/model-schema.ts";
import type { EvidenceSource, PlanDocument, ResearchSummary } from "../src/types.ts";

test("renders failed queries with host failure descriptions and GitLab report citations", () => {
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
    repositoryChoices: [
      {
        candidateId: "C1",
        provider: "github",
        repository: "org/refunds",
        outcome: "selected",
        rationale: "Implements the refund lifecycle.",
        webUrl: "https://github.com/org/refunds",
        defaultBranch: "main",
        decidedBy: "model",
        signals: { stars: 321, forks: 40, archived: false, fork: false, licenseSpdxId: "MIT", language: "TypeScript", topics: ["refunds"], pushedAt: "2026-08-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" },
        treeFileCount: 200,
        testFileCount: 12,
        licenseEvidence: "metadata",
      },
      {
        candidateId: "C2",
        provider: "github",
        repository: "org/old-refunds",
        outcome: "rejected",
        rationale: "stars 0 is below the minimum of 20",
        webUrl: "https://github.com/org/old-refunds",
        defaultBranch: "main",
        decidedBy: "host",
        signals: { stars: 0, forks: 0, archived: false, fork: false, licenseSpdxId: "MIT", language: "PHP", topics: [], pushedAt: "2025-01-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" },
      },
    ],
    referenceComparisons: [],
    risks: [],
    readiness: "draft",
    readinessNotes: [],
  };
  const research: ResearchSummary = {
    queries: [
      { provider: "github", tier: 0, query: "refunds in:name,description,topics archived:false fork:false stars:>=200 pushed:>=2025-10-10", status: "ok", resultCount: 1, newCandidates: 1 },
      {
        provider: "github",
        tier: 1,
        query: "refund request in:name,description,topics",
        status: "failed",
        resultCount: 0,
        newCandidates: 0,
        failure: { provider: "github", endpoint: "search", category: "http_status", status: 500, attempts: 1, retryRefused: true },
      },
      { provider: "gitlab", tier: 2, query: "refunds", status: "ok", resultCount: 1, newCandidates: 1 },
    ],
    searchRequests: { github: 1, gitlab: 0, budget: 9 },
    treeResolutions: 1,
    qualityBar: { minStars: 20, maxMonthsSincePush: 36, minAgeDays: 180, requireTests: true, requireLicense: true },
    matched: 2,
    passedMetadataBar: 1,
    shortlisted: 1,
    selected: 1,
    excluded: 1,
    rateLimited: false,
    trustworthyReferenceFound: true,
  };
  const report = renderReport({
    brief,
    initialBrief: { ...brief, summary: "Original intake summary before the answer." },
    research,
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
  expect(report).toContain("**Clarified brief (after material answers).** Architecture and source research remain pending answers.");
  expect(report).toContain("**Initial intake summary (before material answers and source review).** Original intake summary before the answer.");
  expect(report).not.toContain("**Brief.**");
  expect(report).toContain("Who may approve refunds?");
  expect(report).toContain("Only named refund managers.");
  expect(report).toContain("## Reference research");
  expect(report).toContain("github tier 0 `refunds in:name,description,topics");
  expect(report).toContain("- github tier 1 `refund request in:name,description,topics` — failed (GitHub search request failed: HTTP 500; the retry was not sent because the request budget was exhausted); 0 result(s), 0 new candidate(s).");
  expect(report).toContain("gitlab fallback `refunds`");
  expect(report).not.toContain("gitlab tier 2");
  expect(report).toContain("321 stars");
  expect(report).toContain("TypeScript");
  expect(report).toContain("license MIT (metadata evidence)");
  expect(report).toContain("12 test files");
  expect(report).toContain("Host excluded [github:org/old-refunds]");
  expect(report).toContain("stars 0 is below the minimum of 20");
});
