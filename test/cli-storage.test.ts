import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { formatJsonlResult, parseCliArguments, readAnswerFile } from "../src/cli.ts";
import { sourceLocation } from "../src/evidence.ts";
import { parseIntake, stableMaterialQuestionId } from "../src/model-schema.ts";
import { writeAnswersTemplate, writeCheckpointArtifacts, writePlanArtifacts } from "../src/storage.ts";
import type { EvidenceSource, PlanDocument, ResearchSummary, RunOutcome } from "../src/types.ts";

const brief = parseIntake({
  summary: "Build a small API.",
  requirements: [{ description: "Create records.", observableAcceptance: ["A record is saved."] }],
  outOfScope: [],
  assumptions: [],
  materialQuestions: [],
  researchQueries: ["record API"],
});

describe("answers and script output", () => {
  test("writes an exact question request and validates its prompt, cwd, policy, and IDs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-answers-"));
    const requirement = "Build a refund service for the current team.";
    const questions = [{
      id: stableMaterialQuestionId("Who approves refunds?", "This sets the access boundary."),
      question: "Who approves refunds?",
      whyMaterial: "This sets the access boundary.",
    }];
    try {
      const answersFile = await writeAnswersTemplate({ cwd, requirement, questions });
      const template = JSON.parse(await readFile(answersFile, "utf8")) as Record<string, any>;
      template.answers[questions[0]!.id] = "Only named refund managers.";
      await writeFile(answersFile, `${JSON.stringify(template, null, 2)}\n`);
      const loaded = await readAnswerFile(answersFile, { requirement, cwd });
      expect(loaded.questions).toEqual(questions);
      expect(loaded.answers).toEqual({ [questions[0]!.id]: "Only named refund managers." });
      await expect(readAnswerFile(answersFile, { requirement: `${requirement} changed`, cwd })).rejects.toThrow(/different requirement/);
      await expect(readAnswerFile(answersFile, { requirement, cwd: `${cwd}-other` })).rejects.toThrow(/different requirement/);

      template.answers["Q-000000000000"] = "Stale answer.";
      await writeFile(answersFile, JSON.stringify(template));
      await expect(readAnswerFile(answersFile, { requirement, cwd })).rejects.toThrow(/current material-question IDs/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps the public CLI minimal and emits one JSONL result record", () => {
    expect(() => parseCliArguments(["resume"])).toThrow(/one software requirement/);
    expect(parseCliArguments(["add audit events", "--jsonl"]).jsonl).toBe(true);
    const outcomes: RunOutcome[] = [
      { status: "needs_input", questions: [], brief },
      { status: "interrupted", message: "cancelled" },
      { status: "error", message: "failed" },
    ];
    for (const outcome of outcomes) {
      const lines = formatJsonlResult(outcome).split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).type).toBe("result");
    }
  });

  test("serializes the initial brief and repository research in the JSON result", () => {
    const initialBrief = { ...brief, summary: "Before material answers." };
    const research: ResearchSummary = {
      queries: [],
      searchRequests: { github: 1, gitlab: 0, budget: 9 },
      treeResolutions: 1,
      qualityBar: { minStars: 20, maxMonthsSincePush: 36, minAgeDays: 180, requireTests: true, requireLicense: true },
      matched: 2,
      passedMetadataBar: 1,
      shortlisted: 1,
      excluded: 1,
      rateLimited: false,
      trustworthyReferenceFound: true,
    };
    const outcome: RunOutcome = {
      status: "completed",
      readiness: "draft",
      brief,
      initialBrief,
      research,
      resolvedAnswers: [],
      plan: {
        title: "Ticketing plan",
        summary: "Build a ticketing service.",
        requirements: brief.requirements,
        tasks: [],
        decisions: [],
        design: {
          architecture: "Draft.",
          modules: [],
          dataModel: { entities: [], notApplicableReason: "Draft." },
          invariants: { items: [], notApplicableReason: "Draft." },
          accessControl: { boundaries: [], notApplicableReason: "Draft." },
        },
        repositoryChoices: [],
        referenceComparisons: [],
        risks: [],
        readiness: "draft",
        readinessNotes: [],
      },
      sources: [],
      gaps: [],
      reviews: [],
      validationIssues: [],
      validationHistory: [],
    };
    const record = JSON.parse(formatJsonlResult(outcome)) as { result: RunOutcome };
    expect(record.result).toMatchObject({ initialBrief: { summary: "Before material answers." }, research: { matched: 2 } });
  });
});

describe("partial evidence persistence", () => {
  test("saves source bytes, plan state, policy hash, and interruption stage in the manifest", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-checkpoint-"));
    const runId = "fixture-run";
    const bytes = new TextEncoder().encode("export const version = 1;\n");
    const sha256 = await Bun.CryptoHasher.hash("sha256", bytes, "hex");
    const source: EvidenceSource = {
      id: "S1",
      kind: "local",
      path: "src/app.ts",
      sha256,
      lineCount: 1,
      byteCount: bytes.byteLength,
      snapshotPath: "sources/S1.txt",
      roles: ["production"],
    };
    const plan: PlanDocument = {
      title: "Saved draft plan",
      summary: "Planning was interrupted after evidence was collected.",
      requirements: brief.requirements,
      tasks: [],
      decisions: [],
      design: {
        architecture: "Design is not complete.",
        modules: [],
        dataModel: { entities: [], notApplicableReason: "Design is not complete." },
        invariants: { items: [], notApplicableReason: "Design is not complete." },
        accessControl: { boundaries: [], notApplicableReason: "Design is not complete." },
      },
      repositoryChoices: [],
      referenceComparisons: [],
      risks: [],
      readiness: "draft",
      readinessNotes: ["Review was interrupted."],
    };
    try {
      const resolvedAnswers = [{ questionId: "Q-123456abcdef", question: "Who can approve a refund?", whyMaterial: "This establishes access rules.", answer: "Only named refund managers." }];
      const initialBrief = { ...brief, summary: "Initial API brief." };
      const research: ResearchSummary = {
        queries: [],
        searchRequests: { github: 0, gitlab: 0, budget: 9 },
        treeResolutions: 0,
        qualityBar: { minStars: 20, maxMonthsSincePush: 36, minAgeDays: 180, requireTests: true, requireLicense: true },
        matched: 0,
        passedMetadataBar: 0,
        shortlisted: 0,
        excluded: 0,
        rateLimited: false,
        trustworthyReferenceFound: false,
      };
      const input = {
        brief,
        initialBrief,
        research,
        resolvedAnswers,
        plan,
        sources: [{ id: "S1", kind: "local" as const, path: "src/app.ts", location: "src/app.ts", snapshotPath: source.snapshotPath, sha256, lineCount: 1, byteCount: bytes.byteLength, roles: ["production" as const], excerpts: [] }],
        evidence: { sources: [source], excerpts: [], bytesBySourceId: new Map([["S1", bytes]]), textBySourceId: new Map([["S1", "export const version = 1;\n"]]), gaps: [] },
        gaps: [],
        reviews: [],
        validationIssues: [],
        validationHistory: [],
        commands: [],
      };
      const manifestPath = await writeCheckpointArtifacts({
        cwd,
        runId,
        stage: "interrupted",
        input,
      });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
      expect(manifest.checkpointStage).toBe("interrupted");
      expect(manifest.plan.title).toBe("Saved draft plan");
      expect(manifest.initialBrief).toEqual(initialBrief);
      expect(manifest.research).toEqual(research);
      expect(manifest.resolvedAnswers).toEqual(resolvedAnswers);
      expect(manifest.referencePolicySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await readFile(path.join(path.dirname(manifestPath), source.snapshotPath), "utf8")).toBe("export const version = 1;\n");

      const artifacts = await writePlanArtifacts({ cwd, runId, input });
      const finalManifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as Record<string, any>;
      const savedReport = await readFile(artifacts.reportPath, "utf8");
      expect(finalManifest.resolvedAnswers).toEqual(resolvedAnswers);
      expect(finalManifest.initialBrief).toEqual(initialBrief);
      expect(finalManifest.research).toEqual(research);
      expect(savedReport).toContain("Who can approve a refund?");
      expect(savedReport).toContain("Only named refund managers.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

test("GitLab source citations use the documented compact line range anchor", () => {
  const source: EvidenceSource = {
    id: "S1",
    kind: "remote",
    path: "src/refund.ts",
    sha256: "a".repeat(64),
    lineCount: 20,
    byteCount: 300,
    provider: "gitlab",
    repository: "org/refunds",
    commitSha: "b".repeat(40),
    permalink: "https://gitlab.com/org/refunds/-/blob/commit/src/refund.ts",
    snapshotPath: "sources/S1.txt",
    roles: ["production"],
  };
  expect(sourceLocation(source, 3, 10)).toBe(`${source.permalink}#L3-10`);
  expect(sourceLocation(source, 3, 10)).not.toContain("#L3-L10");
});
