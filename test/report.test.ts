import { describe, expect, test } from "bun:test";
import { renderPreviewHtml, renderPreviewText, renderReport } from "../src/report.ts";
import { parseIntake } from "../src/model-schema.ts";
import { candidateReference, createPreviewRecorder, evidenceReferences } from "../src/preview.ts";
import type { BriefApproval, EvidenceSource, FinalSource, PlanDocument, PlanTask, PreviewUse, RepositoryChoice, ResearchSummary, WorkflowPreview } from "../src/types.ts";

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
      verification: [{
        id: "T1-V1",
        kind: "manual",
        acceptanceIds: ["A1"],
        description: "Submit a request and inspect the record.",
        rejectsMutants: [{ id: "T1-V1-M1", acceptanceId: "A1", wrongImplementation: "The endpoint returns success without saving the request.", observedFailure: "The inspected record list has no refund request." }],
      }],
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

describe("trusted, not checked", () => {
  const brief = parseIntake({
    summary: "Record refunds.",
    requirements: [{ description: "Record refunds.", observableAcceptance: ["A refund is recorded."] }],
    outOfScope: [],
    assumptions: [],
    materialQuestions: [],
    researchQueries: ["refunds"],
  });
  const github: RepositoryChoice = {
    candidateId: "C1",
    provider: "github",
    repository: "org/refunds",
    outcome: "selected",
    rationale: "Implements the refund lifecycle.",
    webUrl: "https://github.com/org/refunds",
    defaultBranch: "main",
    commitSha: "a".repeat(40),
    decidedBy: "model",
    signals: { stars: 321, forks: 40, archived: false, fork: false, licenseSpdxId: "MIT", language: "TypeScript", topics: [], pushedAt: "2026-08-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" },
    treeFileCount: 200,
    testFileCount: 12,
    licenseEvidence: "metadata",
  };
  const gitlab: RepositoryChoice = {
    candidateId: "C2",
    provider: "gitlab",
    repository: "group/refund-desk",
    outcome: "selected",
    rationale: "Records refund requests.",
    webUrl: "https://gitlab.com/group/refund-desk",
    defaultBranch: "develop",
    commitSha: "b".repeat(40),
    decidedBy: "model",
    signals: { stars: 45, forks: 3, archived: null, fork: null, licenseSpdxId: null, language: null, topics: [], pushedAt: "2026-05-02T10:00:00.000Z", createdAt: null },
    treeFileCount: 80,
    testFileCount: 4,
    licenseEvidence: "tree",
    licensePath: "LICENSE.md",
  };
  const rejected: RepositoryChoice = {
    candidateId: "C3",
    provider: "github",
    repository: "org/old-refunds",
    outcome: "rejected",
    rationale: "stars 0 is below the minimum of 20",
    webUrl: "https://github.com/org/old-refunds",
    defaultBranch: "main",
    decidedBy: "host",
  };
  // Every candidate that passed the host checks but that the model did not select has this shape.
  const alsoRan: RepositoryChoice = {
    candidateId: "C4",
    provider: "github",
    repository: "org/also-ran",
    outcome: "rejected",
    rationale: "Not selected for deep inspection.",
    webUrl: "https://github.com/org/also-ran",
    defaultBranch: "main",
    decidedBy: "model",
    signals: { stars: 321, forks: 12, archived: false, fork: false, licenseSpdxId: "MIT", language: "TypeScript", topics: [], pushedAt: "2026-07-01T00:00:00.000Z", createdAt: "2021-01-01T00:00:00.000Z" },
  };
  const source = (id: string, repository: string | undefined, sourcePath: string, roles: FinalSource["roles"], provider: "github" | "gitlab" = "github"): FinalSource => ({
    id,
    kind: repository ? "remote" : "local",
    path: sourcePath,
    location: sourcePath,
    snapshotPath: `sources/${id}.txt`,
    sha256: "c".repeat(64),
    lineCount: 1,
    byteCount: 1,
    ...(repository ? { provider, repository, commitSha: "a".repeat(40) } : {}),
    roles,
    excerpts: [],
  });
  const render = (repositoryChoices: RepositoryChoice[], sources: FinalSource[] = [], plan: Partial<PlanDocument> = {}, briefApproval?: BriefApproval): string => renderReport({
    brief,
    resolvedAnswers: [],
    ...(briefApproval ? { briefApproval } : {}),
    plan: {
      title: "Refund plan",
      summary: "Record a refund.",
      requirements: brief.requirements,
      tasks: [],
      decisions: [],
      design: {
        architecture: "A request endpoint records refunds.",
        modules: [],
        dataModel: { entities: [], notApplicableReason: "Not included in this rendering fixture." },
        invariants: { items: [], notApplicableReason: "Not included in this rendering fixture." },
        accessControl: { boundaries: [], notApplicableReason: "Not included in this rendering fixture." },
      },
      repositoryChoices,
      referenceComparisons: [],
      risks: [],
      readiness: "draft",
      readinessNotes: [],
      ...plan,
    },
    sources,
    evidence: { sources: [], excerpts: [], bytesBySourceId: new Map(), textBySourceId: new Map(), gaps: [] },
    gaps: [],
    reviews: [],
    validationIssues: [],
    validationHistory: [],
    commands: [],
  });
  const trustedSection = (report: string): string => report.slice(report.indexOf("## Trusted, not checked"), report.indexOf("## Source registry"));

  test("lists a GitHub comparator with stars, dates, the default-branch head, tests read but not run, and its SPDX license", () => {
    const report = render([github, rejected, alsoRan], [
      source("S1", "org/refunds", "src/refund.ts", ["production"]),
      source("S2", "org/refunds", "tests/refund.test.ts", ["test"]),
      source("S3", "org/refunds", "tests/amount.test.ts", ["test"]),
      source("S4", "org/other", "tests/other.test.ts", ["test"]),
      source("S5", undefined, "test/local.test.ts", ["test"]),
      // The host reads these reference files of every selected repository; none is a production file.
      source("S6", "org/refunds", "LICENSE", ["license"]),
      source("S7", "org/refunds", "package.json", ["manifest"]),
      source("S8", "org/refunds", ".github/workflows/ci.yml", ["ci"]),
    ]);

    expect(trustedSection(report)).toContain(`- github:org/refunds@${"a".repeat(40)}: 321 stars; last push 2026-08-01; created 2020-01-01. The commit is the head of the default branch \`main\` when this run resolved it, not a release or tag. The tree listing the host received had 12 test-like path(s) by file name; if the evidence gaps say that listing was truncated, this count is a lower bound. The host read 1 production file(s) and 2 test file(s) from it and ran none of them. License: MIT, as GitHub's SPDX metadata reports it.\n`);
    expect(trustedSection(report)).not.toContain("org/old-refunds");
    expect(trustedSection(report)).not.toContain("org/also-ran");
  });

  test("lists a GitLab comparator with last activity, unknown age, a root license file, and unchecked archived and fork status", () => {
    const report = render([gitlab], [
      source("S1", "group/refund-desk", "app/refund.rb", ["production"], "gitlab"),
      source("S2", "group/refund-desk", "test/refund_test.rb", ["test"], "gitlab"),
      // The same repository path on the other provider is a different repository.
      source("S3", "group/refund-desk", "src/refund.ts", ["production"]),
      source("S4", "group/refund-desk", "src/refund-list.ts", ["production"]),
    ]);

    expect(trustedSection(report)).toContain(`- gitlab:group/refund-desk@${"b".repeat(40)}: 45 stars; last activity 2026-05-02; creation date unknown, and an unknown age passes the quality bar. The commit is the head of the default branch \`develop\` when this run resolved it, not a release or tag. The tree listing the host received had 4 test-like path(s) by file name; if the evidence gaps say that listing was truncated, this count is a lower bound. The host read 1 production file(s) and 1 test file(s) from it and ran none of them. License: the root file \`LICENSE.md\`; the host did not identify which license it is. GitLab search reports no archived or fork status, so the host checked neither; the search asked GitLab to leave out archived projects.\n`);
  });

  test("lists a GitLab comparator's creation date when GitLab reported one", () => {
    const dated: RepositoryChoice = { ...gitlab, signals: { ...gitlab.signals!, createdAt: "2021-06-01T10:00:00.000Z" } };

    expect(trustedSection(render([dated]))).toContain(`- gitlab:group/refund-desk@${"b".repeat(40)}: 45 stars; last activity 2026-05-02; created 2021-06-01. The commit is the head of the default branch \`develop\``);
  });

  test("says the plan has no reference repository behind it when no comparator was selected", () => {
    const section = trustedSection(render([rejected, alsoRan]));

    expect(section).toContain("- No reference repository was selected, so the plan has no reference repository behind it.\n");
    expect(section).not.toContain("org/old-refunds");
    expect(section).not.toContain("org/also-ran");
  });

  test("states what citations, local sources and the review are trusted for, with or without a comparator", () => {
    for (const report of [render([]), render([github])]) {
      const section = trustedSection(report);
      expect(section).toContain("- The claim next to each citation is written by the model. The host checks only that the excerpt ID exists, and for a reference comparison that the excerpt comes from that repository at the pinned commit and, for a cited reference test, from a file it read as a test; it then shows the line range it recorded when it read the file.\n");
      expect(section).toContain("- Local sources are identified by the SHA-256 of the content this run read, taken after any redaction, not by a commit.\n");
      expect(section).toContain("- The independent review is the same model in a fresh session.\n");
      expect(section).toContain("- Surviving mutants, and the lack of them, are the reviewer model's reasoning: unshit applied and ran none of them, and a review that reports none does not show that the planned checks reject every wrong implementation.\n");
    }
  });

  test("puts the trusted section after the checks performed and before the source registry", () => {
    const report = render([github]);
    const checks = report.indexOf("## Checks performed");
    const trusted = report.indexOf("## Trusted, not checked");

    expect(checks).toBeGreaterThan(-1);
    expect(trusted).toBeGreaterThan(checks);
    expect(report.indexOf("## Source registry")).toBeGreaterThan(trusted);
  });

  test("says that the model wrote the named wrong implementations and that unshit applied and ran none of them", () => {
    const method = (id: string, count: number): PlanTask["verification"][number] => ({
      id,
      kind: "manual",
      acceptanceIds: ["A1"],
      description: "Inspect the saved refund.",
      rejectsMutants: Array.from({ length: count }, (_, index) => ({ id: `${id}-M${index + 1}`, acceptanceId: "A1", wrongImplementation: "The refund is not saved.", observedFailure: "The refund list stays empty." })),
    });
    const task: PlanTask = {
      id: "T1",
      title: "Record refunds",
      description: "Save the refund.",
      requirementIds: ["R1"],
      dependencies: [],
      acceptance: [{ id: "T1-A1", requirementId: "R1", coversAcceptanceIds: ["A1"], condition: "The refund is saved." }],
      verification: [method("T1-V1", 2), method("T1-V2", 1)],
      evidence: [],
    };
    const second: PlanTask = { ...task, id: "T2", dependencies: ["T1"], verification: [method("T2-V1", 1)] };

    expect(trustedSection(render([], [], { tasks: [task, second] }))).toContain("- The plan names 4 wrong implementation(s) under its verification steps. The model wrote them, and unshit did not apply any of them or run any check.\n");
    expect(trustedSection(render([]))).not.toContain("wrong implementation(s)");
  });

  test("says how many reference tests the plan cites and that the host ran none of them", () => {
    // Each inner list is the test excerpts one adopted pattern cites.
    const comparison = (candidateId: string, repository: string, patterns: string[][]): PlanDocument["referenceComparisons"][number] => ({
      candidateId,
      provider: "github",
      repository,
      commitSha: "a".repeat(40),
      selectionRationale: "Implements refunds.",
      adoptedPatterns: patterns.map((tests) => ({
        pattern: "Keep a refund status.",
        evidence: [{ excerptId: "E1", claim: "The model has a status." }],
        testEvidence: tests.map((excerptId) => ({ excerptId, claim: "The test moves a refund to approved." })),
      })),
      rejectedPatterns: [{ pattern: "Approve inline.", reason: "It blocks the request.", evidence: [{ excerptId: "E1", claim: "Approval is inline." }] }],
      localAdaptation: "Use the local store.",
    });

    // Six citations of four test excerpts: E2 twice under one pattern and again under a second pattern, which also
    // cites E5.
    const report = render([], [], { referenceComparisons: [comparison("C1", "org/refunds", [["E2", "E3", "E2"], ["E2", "E5"]]), comparison("C2", "org/refund-desk", [["E4"]])] });
    expect(trustedSection(report)).toContain("- The plan cites 4 distinct reference test excerpt(s) under adopted patterns. The host recognises a test file by its path name only; it read these at the pinned commit and ran none of them, and that each one exercises its pattern rests on the planner and the independent review.\n");
    expect(trustedSection(render([]))).not.toContain("reference test excerpt(s)");
  });

  test("says that an approval from an answers file does not show who approved the brief", () => {
    const approval: BriefApproval = { briefSha256: "d".repeat(64), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" };

    expect(trustedSection(render([], [], {}, approval))).toContain("- The brief approval came from an answers file whose approveBrief was true; the host cannot tell who set it.\n");
    expect(trustedSection(render([], [], {}, { ...approval, via: "tty" }))).not.toContain("approveBrief");
  });

  test("says that a terminal approval is a yes typed at the prompt and does not show who typed it", () => {
    const approval: BriefApproval = { briefSha256: "d".repeat(64), via: "tty", approvedAt: "2026-10-25T09:30:00.000Z" };

    expect(trustedSection(render([], [], {}, approval))).toContain("- The brief approval is a yes typed at an interactive terminal prompt; the host takes it as the user's and cannot tell who typed it.\n");
    expect(trustedSection(render([], [], {}, { ...approval, via: "answers_file" }))).not.toContain("terminal prompt");
    expect(trustedSection(render([]))).not.toContain("brief approval");
  });

  test("describes the checks performed as excerpt ID, comparator commit, coverage, command and dependency checks", () => {
    const report = render([]);

    expect(report).toContain("## Checks performed\n\nThe host read and hashed the listed source files and recorded the line range of every excerpt it cut. It checked that each cited excerpt ID is one it created and that each reference comparison cites only its own repository at the pinned commit, checked requirement and acceptance coverage, checked that existing verification commands come from local files it read, and checked that task dependencies exist and form no cycle. It checked that each verification names at least one wrong implementation for every acceptance criterion it covers, and that each reference test cited under an adopted pattern comes from a file it read as a test from that repository at the pinned commit. It did not check that an excerpt supports the claim next to it, and it did not run target project commands or tests.\n");
    expect(report).not.toContain("validated citations against source line ranges");
  });
});

test("renders each named wrong implementation under its verification and one done-when line per task", () => {
  const brief = parseIntake({
    summary: "Record refunds.",
    requirements: [{ description: "Record refunds.", observableAcceptance: ["A refund is recorded."] }],
    materialQuestions: [],
  });
  const notApplicable = "Not included in this rendering fixture.";
  const plan: PlanDocument = {
    title: "Refund plan",
    summary: "Record a refund request.",
    requirements: brief.requirements,
    tasks: [
      {
        id: "T1",
        title: "Create the endpoint",
        description: "Validate and save the request.",
        requirementIds: ["R1"],
        dependencies: [],
        acceptance: [{ id: "T1-A1", requirementId: "R1", coversAcceptanceIds: ["A1"], condition: "A refund request is saved." }],
        verification: [
          {
            id: "T1-V1",
            kind: "manual",
            acceptanceIds: ["A1"],
            description: "Submit a request and inspect the record.",
            rejectsMutants: [
              { id: "T1-V1-M1", acceptanceId: "A1", wrongImplementation: "The endpoint returns 201 without saving the request.", observedFailure: "The record list stays empty." },
              { id: "T1-V1-M2", acceptanceId: "A1", wrongImplementation: "The endpoint saves the request without its status.", observedFailure: "The record shows no pending status." },
            ],
          },
          {
            id: "T1-V2",
            kind: "to_create",
            acceptanceIds: ["A1"],
            description: "A test posts a refund request and reads it back.",
            plannedCommand: "bun test test/refunds.test.ts",
            rejectsMutants: [{ id: "T1-V2-M1", acceptanceId: "A1", wrongImplementation: "The endpoint saves the amount as zero.", observedFailure: "The test fails: expected amount 25, received 0." }],
          },
          {
            id: "T1-V3",
            kind: "existing",
            acceptanceIds: ["A1"],
            description: "The existing suite posts a refund request.",
            commandId: "CMD1",
            command: "bun test",
            rejectsMutants: [{ id: "T1-V3-M1", acceptanceId: "A1", wrongImplementation: "The endpoint drops the refund reason.", observedFailure: "The suite fails: expected reason \"damaged\", received undefined." }],
          },
        ],
        evidence: [],
      },
      {
        id: "T2",
        title: "List refunds",
        description: "Show saved requests.",
        requirementIds: ["R1"],
        dependencies: ["T1"],
        acceptance: [{ id: "T2-A1", requirementId: "R1", coversAcceptanceIds: ["A1"], condition: "The saved request is listed." }],
        verification: [{
          id: "T2-V1",
          kind: "manual",
          acceptanceIds: ["A1"],
          description: "Open the refund list.",
          rejectsMutants: [{ id: "T2-V1-M1", acceptanceId: "A1", wrongImplementation: "The list query drops pending requests.", observedFailure: "The new request is missing from the list." }],
        }],
        evidence: [],
      },
    ],
    decisions: [],
    design: {
      architecture: "A request endpoint validates and records refunds.",
      modules: [],
      dataModel: { entities: [], notApplicableReason: notApplicable },
      invariants: { items: [], notApplicableReason: notApplicable },
      accessControl: { boundaries: [], notApplicableReason: notApplicable },
    },
    repositoryChoices: [],
    referenceComparisons: [],
    risks: [],
    readiness: "draft",
    readinessNotes: [],
  };
  const report = renderReport({
    brief,
    resolvedAnswers: [],
    plan,
    sources: [],
    evidence: { sources: [], excerpts: [], bytesBySourceId: new Map(), textBySourceId: new Map(), gaps: [] },
    gaps: [],
    reviews: [],
    validationIssues: [],
    validationHistory: [],
    commands: [{ id: "CMD1", command: "bun test", sourceId: "S9", line: 3 }],
  });
  const doneWhen = "Done when: each wrong implementation named above, applied alone to the finished code, makes its check fail, while the unmodified code passes every check above. unshit has not applied any of them or run any check.";
  expect(report).toContain([
    "- T1-V1 checks A1: Manual check. Submit a request and inspect the record.",
    "  - Must fail on T1-V1-M1 (A1): The endpoint returns 201 without saving the request. Expected failure: The record list stays empty.",
    "  - Must fail on T1-V1-M2 (A1): The endpoint saves the request without its status. Expected failure: The record shows no pending status.",
    "- T1-V2 checks A1: A test posts a refund request and reads it back. Create and run `bun test test/refunds.test.ts` as part of implementation.",
    "  - Must fail on T1-V2-M1 (A1): The endpoint saves the amount as zero. Expected failure: The test fails: expected amount 25, received 0.",
    "- T1-V3 checks A1: The existing suite posts a refund request. Run existing command `bun test` (source location unavailable). This command was read, not run.",
    "  - Must fail on T1-V3-M1 (A1): The endpoint drops the refund reason. Expected failure: The suite fails: expected reason \"damaged\", received undefined.",
    "",
    doneWhen,
  ].join("\n"));
  expect(report.split(doneWhen).length - 1).toBe(2);
});

test("renders under each adopted pattern its reference test as read, not run, or why it has none", () => {
  const brief = parseIntake({
    summary: "Record refunds.",
    requirements: [{ description: "Record refunds.", observableAcceptance: ["A refund is recorded."] }],
    materialQuestions: [],
    researchQueries: ["refund endpoint"],
  });
  const sha = "c".repeat(40);
  const remote = (id: string, filePath: string, roles: EvidenceSource["roles"]): EvidenceSource => ({
    id,
    kind: "remote",
    path: filePath,
    sha256: "a".repeat(64),
    lineCount: 10,
    byteCount: 150,
    provider: "github",
    repository: "org/refunds",
    commitSha: sha,
    permalink: `https://github.com/org/refunds/blob/${sha}/${filePath}`,
    snapshotPath: `sources/${id}.txt`,
    roles,
  });
  const sources = [remote("S1", "src/refund.ts", ["production"]), remote("S2", "tests/refund.test.ts", ["test"])];
  const excerpts = [
    { id: "E1", sourceId: "S1", startLine: 1, endLine: 8, text: "production" },
    { id: "E2", sourceId: "S2", startLine: 2, endLine: 9, text: "test" },
  ];
  const plan: PlanDocument = {
    title: "Refund plan",
    summary: "Record a refund request.",
    requirements: brief.requirements,
    tasks: [],
    decisions: [],
    design: {
      architecture: "A request endpoint records refunds.",
      modules: [],
      dataModel: { entities: [], notApplicableReason: "Not included in this rendering fixture." },
      invariants: { items: [], notApplicableReason: "Not included in this rendering fixture." },
      accessControl: { boundaries: [], notApplicableReason: "Not included in this rendering fixture." },
    },
    repositoryChoices: [],
    referenceComparisons: [{
      candidateId: "C1",
      provider: "github",
      repository: "org/refunds",
      commitSha: sha,
      selectionRationale: "Implements the refund lifecycle.",
      adoptedPatterns: [
        { pattern: "Keep a refund status.", evidence: [{ excerptId: "E1", claim: "The model has a status." }], testEvidence: [{ excerptId: "E2", claim: "The test moves a refund to approved." }] },
        { pattern: "Cap partial refunds.", evidence: [{ excerptId: "E1", claim: "The model caps the amount." }], testEvidence: [], untestedReason: "No read test covers partial refunds." },
      ],
      rejectedPatterns: [{ pattern: "Approve inline.", reason: "It blocks the request.", evidence: [{ excerptId: "E1", claim: "Approval is inline." }] }],
      localAdaptation: "Use the local store.",
    }],
    risks: [],
    readiness: "draft",
    readinessNotes: [],
  };
  const report = renderReport({
    brief,
    resolvedAnswers: [],
    plan,
    sources: sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      path: source.path,
      location: source.permalink!,
      snapshotPath: source.snapshotPath,
      sha256: source.sha256,
      lineCount: source.lineCount,
      byteCount: source.byteCount,
      provider: "github",
      repository: source.repository,
      commitSha: source.commitSha,
      permalink: source.permalink,
      roles: source.roles,
      excerpts: excerpts.filter((excerpt) => excerpt.sourceId === source.id).map(({ id, startLine, endLine }) => ({ id, startLine, endLine })),
    })),
    evidence: { sources, excerpts, bytesBySourceId: new Map(), textBySourceId: new Map(), gaps: [] },
    gaps: [],
    reviews: [],
    validationIssues: [],
    validationHistory: [],
    commands: [],
  });
  // The line after the reference test is the next pattern, so a tested pattern shows no "No reference test" line.
  expect(report).toContain(`- Keep a refund status. ([src/refund.ts L1-L8](https://github.com/org/refunds/blob/${sha}/src/refund.ts#L1-L8))\n  - Reference test (read, not run): The test moves a refund to approved. ([tests/refund.test.ts L2-L9](https://github.com/org/refunds/blob/${sha}/tests/refund.test.ts#L2-L9))\n- Cap partial refunds. (`);
  expect(report.match(/No reference test/g)).toHaveLength(1);
  expect(report).toContain(`- Cap partial refunds. ([src/refund.ts L1-L8](https://github.com/org/refunds/blob/${sha}/src/refund.ts#L1-L8))\n  - No reference test: No read test covers partial refunds.\n`);
});

test("shows the brief approval and labels every requirement with the user's words or inferred", () => {
  const brief = parseIntake({
    summary: "Sign-in tokens.",
    requirements: [
      { description: "Issue a token only for the right password.", userWords: "You only get a token with the right password.", observableAcceptance: ["A wrong password gets no token."] },
      { description: "Lock the account after five failures.", userWords: null, observableAcceptance: ["The sixth try is refused."] },
    ],
    materialQuestions: [],
    researchQueries: ["token sign-in"],
  }, ["You only get a token with the right password."]);
  const plan: PlanDocument = {
    title: "Sign-in plan",
    summary: "Issue tokens.",
    requirements: brief.requirements,
    tasks: [{
      id: "T1",
      title: "Check passwords",
      description: "Check the password and count failures.",
      requirementIds: ["R1", "R2"],
      dependencies: [],
      acceptance: [{ id: "T1-A1", requirementId: "R1", coversAcceptanceIds: ["A1"], condition: "A wrong password gets no token." }, { id: "T1-A2", requirementId: "R2", coversAcceptanceIds: ["A2"], condition: "The sixth try is refused." }],
      verification: [{ id: "T1-V1", kind: "manual", acceptanceIds: ["A1", "A2"], description: "Try wrong passwords.", rejectsMutants: [{ id: "T1-V1-M1", acceptanceId: "A1", wrongImplementation: "Any password gets a token.", observedFailure: "A wrong password gets a token." }, { id: "T1-V1-M2", acceptanceId: "A2", wrongImplementation: "Failures are not counted.", observedFailure: "The sixth try gets a token." }] }],
      evidence: [],
    }],
    decisions: [],
    design: {
      architecture: "A sign-in module.",
      modules: [],
      dataModel: { entities: [], notApplicableReason: "Not included in this rendering fixture." },
      invariants: { items: [], notApplicableReason: "Not included in this rendering fixture." },
      accessControl: { boundaries: [], notApplicableReason: "Not included in this rendering fixture." },
    },
    repositoryChoices: [],
    referenceComparisons: [],
    risks: [],
    readiness: "ready",
    readinessNotes: [],
  };
  const briefApproval: BriefApproval = { briefSha256: "c".repeat(64), via: "tty", approvedAt: "2026-10-25T09:30:00.000Z" };
  const input = {
    brief,
    resolvedAnswers: [],
    plan,
    sources: [],
    evidence: { sources: [], excerpts: [], bytesBySourceId: new Map(), textBySourceId: new Map(), gaps: [] },
    gaps: [],
    reviews: [],
    validationIssues: [],
    validationHistory: [],
    commands: [],
  };
  const report = renderReport({ ...input, briefApproval });
  expect(report).toContain(`## Brief approval\n\nApproved by a yes typed at the interactive terminal prompt; the host cannot tell who typed it. Recorded 2026-10-25T09:30:00.000Z; brief SHA-256 \`${"c".repeat(64)}\`.\n`);
  expect(report).toContain("- **R1.** Issue a token only for the right password. (you said: \"You only get a token with the right password.\") → T1");
  expect(report).toContain("- **R2.** Lock the account after five failures. (inferred) → T1");
  expect(renderReport({ ...input, briefApproval: { ...briefApproval, via: "answers_file" } })).toContain("The answers file approved this brief (approveBrief was true); the host cannot tell who set it. Recorded 2026-10-25T09:30:00.000Z;");
  expect(renderReport(input)).toContain("## Brief approval\n\nNo person approved this brief before reference research, so the plan is Draft.\n");
});

test("labels the brief of an approved answers file as the approved brief, not the initial intake summary, and keeps its answers", () => {
  const brief = parseIntake({
    summary: "Refunds approved by managers.",
    requirements: [{ description: "Only refund managers approve refunds.", observableAcceptance: ["A clerk cannot approve a refund."] }],
    materialQuestions: [],
    researchQueries: ["refund approval"],
  });
  const input = {
    brief,
    resolvedAnswers: [{ questionId: "Q-123456abcdef", question: "Who may approve refunds?", whyMaterial: "This defines the refund authorization boundary.", answer: "Only named refund managers." }],
    plan: {
      title: "Refund approval plan",
      summary: "Let managers approve refunds.",
      requirements: brief.requirements,
      tasks: [],
      decisions: [],
      design: {
        architecture: "An approval step.",
        modules: [],
        dataModel: { entities: [], notApplicableReason: "Not included in this rendering fixture." },
        invariants: { items: [], notApplicableReason: "Not included in this rendering fixture." },
        accessControl: { boundaries: [], notApplicableReason: "Not included in this rendering fixture." },
      },
      repositoryChoices: [],
      referenceComparisons: [],
      risks: [],
      readiness: "draft" as const,
      readinessNotes: [],
    },
    sources: [],
    evidence: { sources: [], excerpts: [], bytesBySourceId: new Map(), textBySourceId: new Map(), gaps: [] },
    gaps: [],
    reviews: [],
    validationIssues: [],
    validationHistory: [],
    commands: [],
  };
  const approval: BriefApproval = { briefSha256: "e".repeat(64), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" };
  const fromFile = renderReport({ ...input, briefApproval: approval });
  expect(fromFile).toContain("**Final plan scope.** Let managers approve refunds.\n**Approved brief (from the answers file).** Refunds approved by managers.\n");
  expect(fromFile).not.toContain("Initial intake summary");
  expect(fromFile).toContain("- **Who may approve refunds?** Why it mattered: This defines the refund authorization boundary. Answer: Only named refund managers.");
  const fromTerminal = renderReport({ ...input, briefApproval: { ...approval, via: "tty" } });
  expect(fromTerminal).toContain("**Initial intake summary (before material answers and source review).** Refunds approved by managers.\n");
  expect(fromTerminal).not.toContain("Approved brief (from the answers file)");
});

test("lists the surviving mutants of each review with the decision they need", () => {
  const brief = parseIntake({
    summary: "Approve refunds.",
    requirements: [{ description: "Approve refunds.", observableAcceptance: ["A manager approves a pending refund."] }],
    outOfScope: [],
    assumptions: [],
    materialQuestions: [],
    researchQueries: ["refund approval"],
  });
  const plan: PlanDocument = {
    title: "Refund approval plan",
    summary: "Approve pending refunds.",
    requirements: brief.requirements,
    tasks: [],
    decisions: [],
    design: {
      architecture: "An approval endpoint records decisions.",
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
    resolvedAnswers: [],
    plan,
    sources: [],
    evidence: { sources: [], excerpts: [], bytesBySourceId: new Map(), textBySourceId: new Map(), gaps: [] },
    gaps: [],
    reviews: [
      {
        findings: [],
        survivingMutants: [
          { acceptanceId: "A1", wrongImplementation: "Approves every refund without checking the approver.", whyPlannedChecksPass: "The only check signs in as a manager." },
          { acceptanceId: "A1", wrongImplementation: "Lets a manager approve a refund they requested.", whyPlannedChecksPass: "No check has a manager request a refund.", decisionNeeded: "May a manager approve a refund they requested?" },
        ],
      },
      { findings: [], survivingMutants: [] },
    ],
    validationIssues: [],
    validationHistory: [],
    commands: [],
  });
  expect(report).toContain("Review 1: 0 finding(s), 2 surviving mutant(s).");
  expect(report).toContain("- surviving mutant for A1: Approves every refund without checking the approver. Planned checks would pass: The only check signs in as a manager.\n");
  expect(report).toContain("- surviving mutant for A1: Lets a manager approve a refund they requested. Planned checks would pass: No check has a manager request a refund. Open decision: May a manager approve a refund they requested?\n");
  expect(report).toContain("Review 2: 0 finding(s), 0 surviving mutant(s).");
});

describe("stage and reference preview rendering", () => {
  const sha = "c".repeat(40);
  const remote: EvidenceSource = {
    id: "S1",
    kind: "remote",
    path: "src/refund.ts",
    sha256: "a".repeat(64),
    lineCount: 10,
    byteCount: 150,
    provider: "github",
    repository: "org/refunds",
    commitSha: sha,
    permalink: `https://github.com/org/refunds/blob/${sha}/src/refund.ts`,
    snapshotPath: "sources/S1.txt",
    roles: ["production"],
  };
  const local: EvidenceSource = { id: "S2", kind: "local", path: "src/app.ts", sha256: "b".repeat(64), lineCount: 3, byteCount: 40, snapshotPath: "sources/S2.txt", roles: ["production"] };

  function previewWith(options: { waiting?: boolean; labels?: Record<string, string> } = {}): WorkflowPreview {
    const recorder = createPreviewRecorder();
    const candidate = { id: "C1", provider: "github" as const, fullName: "org/refunds", description: "", defaultBranch: "main", webUrl: "https://github.com/org/refunds" };
    recorder.register([candidateReference(candidate), ...evidenceReferences({ sources: [remote, local], excerpts: [{ id: "E1", sourceId: "S1", startLine: 2, endLine: 5, text: "x" }] })]);
    recorder.record("repository_search", "found", ["C1"]);
    recorder.setStatus("repository_search", "completed");
    if (options.waiting) {
      recorder.setStatus("preview_confirmation", "waiting");
    } else {
      recorder.setStatus("preview_confirmation", "completed");
      recorder.record("source_reads", "read", ["S1", "S2"]);
      recorder.setStatus("source_reads", "completed");
      recorder.record("plan", "cited", ["E1"]);
      recorder.setStatus("plan", "completed");
    }
    const preview = recorder.snapshot();
    for (const reference of preview.references) {
      const label = options.labels?.[reference.key];
      if (label) reference.label = label;
    }
    return preview;
  }

  test("shows each reference's path, destination and published snapshot, and marks a snapshot that is not written yet", () => {
    const html = renderPreviewHtml(previewWith(), new Set(["S1"]));
    expect(html).toContain("<code>src/refund.ts</code>");
    expect(html).toContain(`<a href="https://github.com/org/refunds/blob/${sha}/src/refund.ts">`);
    expect(html).toContain(`<a href="https://github.com/org/refunds/blob/${sha}/src/refund.ts#L2-L5">`);
    expect(html).toContain("<a href=\"sources/S1.txt\">sources/S1.txt</a>");
    expect(html).not.toContain("href=\"sources/S2.txt\"");
    expect(html).toContain("sources/S2.txt (<span lang=\"en\">not written yet</span>");
    expect(html).toContain("<a href=\"#ref-S1\"><code>S1</code></a>");
    expect(html).toContain("<div class=\"reference\" id=\"ref-S1\">");
  });

  test("renders only references the host registered, whatever a stage use carries", () => {
    const preview = previewWith();
    const plan = preview.stages.find((stage) => stage.id === "plan")!;
    plan.uses.push({ relation: "cited", key: "E999", url: "https://evil.example/forged" } as PreviewUse);
    const html = renderPreviewHtml(preview, new Set());
    expect(html).not.toContain("E999");
    expect(html).not.toContain("evil.example");
  });

  test("escapes untrusted labels and notes and links only https URLs", () => {
    const preview = previewWith({ labels: { C1: "github:org/<img src=x onerror=alert(1)>", S1: "</code><script>alert(1)</script>" } });
    preview.references.find((reference) => reference.key === "S2")!.url = "javascript:alert(1)";
    const html = renderPreviewHtml(preview, new Set(["S1", "S2"]));
    expect(html).toContain("github:org/&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.match(/<script/g) ?? []).toEqual([]);
    expect(html.match(/<img/g) ?? []).toEqual([]);
    expect(html).not.toContain("javascript:");
  });

  // Ported from the comparator's preview tests (langgenius/dify, E84): a paused run and missing data read differently
  // from a finished run whose traces can be opened.
  test("escapes a hostile note on a stage use", () => {
    const preview = previewWith();
    preview.stages.find((stage) => stage.id === "repository_search")!.uses[0]!.note = "archived</span><script>alert(1)</script><img src=x onerror=alert(1)>";
    const html = renderPreviewHtml(preview, new Set());
    expect(html).toContain("archived&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html.match(/<script/g) ?? []).toEqual([]);
    expect(html.match(/<img/g) ?? []).toEqual([]);
  });

  test("tells a waiting preview from a finished one", () => {
    const waiting = renderPreviewHtml(previewWith({ waiting: true }), new Set());
    expect(waiting).toContain("The run is waiting at this preview. Type yes in the terminal to continue");
    expect(waiting).toContain("data-status=\"waiting\"");
    expect(waiting).toContain("<code>source_reads</code></h2><p class=\"status\"><span lang=\"en\">Pending</span> · <span lang=\"zh-CN\">待执行</span></p><p class=\"muted\"><span lang=\"en\">No references yet</span>");
    const finished = renderPreviewHtml(previewWith(), new Set(["S1", "S2"]));
    expect(finished).not.toContain("The run is waiting at this preview");
    expect(finished).toContain("<code>intake</code></h2><p class=\"status\"><span lang=\"en\">Pending</span>");
    expect(finished).toContain("<code>source_reads</code></h2><p class=\"status\"><span lang=\"en\">Completed</span> · <span lang=\"zh-CN\">已完成</span></p><details open><summary><span lang=\"en\">Read and hashed</span> · <span lang=\"zh-CN\">读取并计算哈希</span> (2)</summary>");
    expect(finished).not.toMatch(/<script|https?:\/\/(?!github\.com\/org\/refunds)/);
  });

  test("keeps control characters in a label from forging terminal lines", () => {
    const escape = String.fromCharCode(27);
    const preview = previewWith({ labels: { S2: `src/app.ts\n[ok] plan: completed; cited 9\r${escape}[2J` } });
    const text = renderPreviewText(preview);
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("[ok] plan:"))).toEqual(["[ok] plan: completed; cited 1"]);
    expect(text).not.toContain(escape);
    expect(text).toContain("    read S2 src/app.ts [ok] plan: completed; cited 9  [2J [evidence]\n");
  });
});
