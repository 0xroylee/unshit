import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { answerOptions, createBriefApprover, createTerminalAsk, exitCodeFor, formatJsonlResult, gatewayOptions, helpText, main, needsInputMessage, parseCliArguments, readAnswerFile, runWithAnswers, terminalPrompts, withAnswersFile, type LoadedAnswers } from "../src/cli.ts";
import { briefSha256, editableBrief, renderBriefForApproval } from "../src/brief-approval.ts";
import { sourceLocation } from "../src/evidence.ts";
import { parseIntake, stableMaterialQuestionId } from "../src/model-schema.ts";
import { writeAnswersTemplate, writeCheckpointArtifacts, writePlanArtifacts } from "../src/storage.ts";
import type { WorkflowOptions } from "../src/workflow.ts";
import type { ApprovedBrief, BriefApproval, EvidenceSource, PlanDocument, ResearchSummary, RunOutcome } from "../src/types.ts";

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
      { status: "timed_out", message: "The plan turn timed out.", stage: "plan", limit: "idle", limitSeconds: 600 },
      { status: "error", message: "failed" },
    ];
    for (const outcome of outcomes) {
      const lines = formatJsonlResult(outcome).split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).type).toBe("result");
    }
  });

  test("parses --turn-timeout as whole seconds from 30 to 3600", () => {
    expect(parseCliArguments(["plan refunds", "--turn-timeout", "900"]).turnTimeoutSeconds).toBe(900);
    expect(parseCliArguments(["plan refunds", "--turn-timeout=30"]).turnTimeoutSeconds).toBe(30);
    expect(parseCliArguments(["plan refunds", "--turn-timeout", "3600"]).turnTimeoutSeconds).toBe(3600);
    expect(parseCliArguments(["plan refunds"]).turnTimeoutSeconds).toBeUndefined();
    for (const value of ["29", "3601", "90.5", "1e3", "-60", "ten"]) {
      expect(() => parseCliArguments(["plan refunds", "--turn-timeout", value])).toThrow("--turn-timeout must be a whole number of seconds from 30 to 3600.");
    }
    expect(() => parseCliArguments(["plan refunds", "--turn-timeout"])).toThrow("--turn-timeout needs a value.");
  });

  test("passes --turn-timeout to the model gateway as the idle limit in milliseconds", () => {
    expect(gatewayOptions(parseCliArguments(["plan refunds", "--turn-timeout", "900"]), "/work")).toEqual({ cwd: "/work", turnIdleTimeoutMs: 900_000 });
    expect(gatewayOptions(parseCliArguments(["plan refunds", "--effort", "high"]), "/work")).toEqual({ cwd: "/work", effort: "high" });
  });

  test("maps run outcomes to exit codes, with 124 for a model turn timeout", () => {
    const timedOut: RunOutcome = { status: "timed_out", message: "The plan turn timed out.", stage: "plan", limit: "idle", limitSeconds: 600 };
    expect(exitCodeFor(timedOut, false)).toBe(124);
    expect(exitCodeFor(timedOut, true)).toBe(130);
    expect(exitCodeFor({ status: "interrupted", message: "cancelled" }, false)).toBe(130);
    expect(exitCodeFor({ status: "error", message: "failed" }, false)).toBe(1);
    expect(exitCodeFor({ status: "needs_input", questions: [], brief }, true)).toBe(2);
    expect(helpText()).toContain("--turn-timeout <seconds>");
    expect(helpText()).toContain("A model turn that times out returns 124.");
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
      selected: 1,
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
        selected: 0,
        excluded: 0,
        rateLimited: false,
        trustworthyReferenceFound: false,
        // Grep query records are optional; both manifests must keep them.
        codeSearch: {
          queries: [{ provider: "grep", purpose: "discovery", query: "OrderRefund", status: "ok", resultCount: 2 }],
          requests: 1,
          budget: 12,
          repositoriesMatched: 2,
          repositoriesScreened: 1,
          metadataRequests: 1,
        },
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

describe("brief approval files", () => {
  const approvalQuestion = {
    id: stableMaterialQuestionId("Who approves refunds?", "This sets the access boundary."),
    question: "Who approves refunds?",
    whyMaterial: "This sets the access boundary.",
  };
  const requirement = "Build a refund service. Refunds need approval.";
  const answer = "Only named refund managers.";
  const labelledBrief = parseIntake({
    summary: "Refunds with approval.",
    requirements: [
      { description: "Only refund managers approve refunds.", userWords: "named refund managers", observableAcceptance: ["A clerk cannot approve a refund."] },
      { description: "Record refunds.", userWords: null, observableAcceptance: ["A refund is saved."] },
    ],
    outOfScope: ["Partial refunds."],
    assumptions: ["Refund managers are named in the staff list."],
    materialQuestions: [{ question: approvalQuestion.question, whyMaterial: approvalQuestion.whyMaterial }],
    researchQueries: ["refund approval"],
  }, [requirement, answer]);
  const currencyQuestion = {
    id: stableMaterialQuestionId("Which currency do refunds use?", "This sets the amount field."),
    question: "Which currency do refunds use?",
    whyMaterial: "This sets the amount field.",
  };
  const resolvedAnswers = [{ questionId: approvalQuestion.id, question: approvalQuestion.question, whyMaterial: approvalQuestion.whyMaterial, answer }];
  const unapproved: RunOutcome = {
    status: "completed",
    readiness: "draft",
    brief: labelledBrief,
    resolvedAnswers,
    plan: {
      title: "Refund plan",
      summary: "Refunds with approval.",
      requirements: labelledBrief.requirements,
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

  test("saves an unapproved plan's brief without IDs, its answers and approveBrief false, and only when nothing approved it", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    try {
      const saved = await withAnswersFile(unapproved, { cwd, requirement, answers: {} });
      if (saved.status !== "completed" || !saved.answersFile) throw new Error("No answers file was saved.");
      const document = JSON.parse(await readFile(saved.answersFile, "utf8")) as Record<string, any>;
      expect(document.brief).toEqual(editableBrief(labelledBrief));
      expect(JSON.stringify(document.brief)).not.toContain("\"id\"");
      expect(document.answers).toEqual({ [approvalQuestion.id]: answer });
      expect(document.request.questions).toEqual([approvalQuestion]);
      expect(document.approveBrief).toBe(false);
      const approved: RunOutcome = { ...unapproved, briefApproval: { briefSha256: briefSha256(labelledBrief), via: "tty", approvedAt: "2026-10-25T09:30:00.000Z" } };
      expect(await withAnswersFile(approved, { cwd, requirement, answers: {} })).toEqual(approved);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("saves the brief and the terminal answers when a person does not approve and says so instead of asking for answers", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    try {
      const refused: RunOutcome = { status: "needs_input", questions: [], brief: labelledBrief, approvalRequested: true, resolvedAnswers };
      const saved = await withAnswersFile(refused, { cwd, requirement, answers: {} });
      if (saved.status !== "needs_input" || !saved.answersFile) throw new Error("No answers file was saved.");
      const document = JSON.parse(await readFile(saved.answersFile, "utf8")) as Record<string, any>;
      expect(document).toMatchObject({ brief: editableBrief(labelledBrief), answers: { [approvalQuestion.id]: answer }, approveBrief: false });
      expect(needsInputMessage(saved)).toBe(`The brief was not approved, so reference search did not start.\nEdit the brief in ${saved.answersFile} if it needs changes, set approveBrief to true, and rerun with --answers ${saved.answersFile}.\n`);
      expect(exitCodeFor(saved, false)).toBe(2);
      expect(needsInputMessage({ status: "needs_input", questions: [approvalQuestion], brief, answersFile: "/work/answers.json" })).toBe(`Material answers are required before reference search can start.\n- ${approvalQuestion.id}: Who approves refunds? (This sets the access boundary.)\nEdit /work/answers.json and rerun with --answers.\n`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reads an approved brief, checks it like intake and records the file approval at the read time", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    const readAt = new Date("2026-10-25T09:30:00.000Z");
    try {
      const answersFile = await writeAnswersTemplate({ cwd, requirement, questions: [approvalQuestion], answers: { [approvalQuestion.id]: answer }, brief: labelledBrief });
      const template = JSON.parse(await readFile(answersFile, "utf8")) as Record<string, any>;
      template.brief.requirements[0].observableAcceptance.push("A person added this acceptance.");
      template.approveBrief = true;
      await writeFile(answersFile, JSON.stringify(template));
      const loaded = await readAnswerFile(answersFile, { requirement, cwd }, readAt);
      const approvedBrief = loaded.approvedBrief!;
      expect(approvedBrief.brief.requirements.map((item) => [item.id, item.origin, item.observableAcceptance.map((criterion) => criterion.id)])).toEqual([
        ["R1", "stated", ["A1", "A2"]],
        ["R2", "inferred", ["A3"]],
      ]);
      expect(approvedBrief.brief.requirements[0]!.observableAcceptance[1]!.description).toBe("A person added this acceptance.");
      expect(approvedBrief.brief.materialQuestions).toEqual([approvalQuestion]);
      expect(approvedBrief.resolvedAnswers).toEqual(resolvedAnswers);
      expect(approvedBrief.approval).toEqual({ briefSha256: briefSha256(approvedBrief.brief), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" });
      await expect(readAnswerFile(answersFile, { requirement: `${requirement} changed`, cwd })).rejects.toThrow(/different requirement/);
      await expect(readAnswerFile(answersFile, { requirement, cwd: `${cwd}-other` })).rejects.toThrow(/different requirement/);

      await writeFile(answersFile, JSON.stringify({ ...template, approveBrief: false }));
      expect((await readAnswerFile(answersFile, { requirement, cwd })).approvedBrief).toBeUndefined();
      await writeFile(answersFile, JSON.stringify({ ...template, approveBrief: "yes" }));
      await expect(readAnswerFile(answersFile, { requirement, cwd })).rejects.toThrow("--answers brief must be an object, and approveBrief must be true or false.");
      const { brief: _brief, ...withoutBrief } = template;
      await writeFile(answersFile, JSON.stringify(withoutBrief));
      await expect(readAnswerFile(answersFile, { requirement, cwd })).rejects.toThrow("--answers brief must be an object, and approveBrief must be true or false.");
      await writeFile(answersFile, JSON.stringify({ ...template, brief: { ...template.brief, requirements: [] } }));
      await expect(readAnswerFile(answersFile, { requirement, cwd })).rejects.toThrow("--answers brief is invalid: requirements must contain 1 to 12 items.");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects an approved brief while a question in its request has no answer, and names that question", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    try {
      const answersFile = await writeAnswersTemplate({ cwd, requirement, questions: [approvalQuestion, currencyQuestion], answers: { [approvalQuestion.id]: answer }, brief: labelledBrief });
      const template = JSON.parse(await readFile(answersFile, "utf8")) as Record<string, any>;
      await writeFile(answersFile, JSON.stringify({ ...template, approveBrief: true }));
      await expect(readAnswerFile(answersFile, { requirement, cwd })).rejects.toThrow(`--answers approveBrief is true, but these questions have no answer: ${currencyQuestion.id}. Approving the brief does not answer them; write each answer in answers and rerun.`);
      // Without the approval the file is an ordinary rerun, which asks the question or returns needs_input.
      await writeFile(answersFile, JSON.stringify(template));
      const rerun = await readAnswerFile(answersFile, { requirement, cwd });
      expect(rerun).toEqual({ answers: { [approvalQuestion.id]: answer }, questions: [approvalQuestion, currencyQuestion] });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("keeps a completed Draft when the file for approving its brief cannot be written", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    try {
      const notADirectory = path.join(directory, "target");
      await writeFile(notADirectory, "a file, not a directory\n");
      expect(await withAnswersFile(unapproved, { cwd: notADirectory, requirement, answers: {} })).toEqual(unapproved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("runs the workflow with the loaded answers and the prompts, and keeps those answers in a later needs_input file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    const loaded: LoadedAnswers = { answers: { [approvalQuestion.id]: answer }, questions: [approvalQuestion, currencyQuestion] };
    const approveBrief = async (): Promise<boolean> => true;
    let received: WorkflowOptions | undefined;
    try {
      const outcome = await runWithAnswers({ cwd, requirement, modelGateway: {} as never, researcher: {} as never }, loaded, { approveBrief }, async (options) => {
        received = options;
        return { status: "needs_input", questions: [currencyQuestion], brief: { ...labelledBrief, materialQuestions: [approvalQuestion, currencyQuestion] } };
      });
      expect(received).toMatchObject({ cwd, requirement, answers: loaded.answers, priorQuestions: loaded.questions, approveBrief });
      if (outcome.status !== "needs_input" || !outcome.answersFile) throw new Error("No answers file was saved.");
      const document = JSON.parse(await readFile(outcome.answersFile, "utf8")) as Record<string, any>;
      expect(document.request.questions).toEqual([approvalQuestion, currencyQuestion]);
      expect(document.answers).toEqual({ [approvalQuestion.id]: answer });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("with --json, main asks nothing even in a terminal, saves the unapproved plan's answers file and prints answersFile in its one JSON result", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    const printed: string[] = [];
    const write = process.stdout.write;
    const terminal = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
    let received: WorkflowOptions | undefined;
    // Both streams look like a terminal, so only --json keeps the prompts away.
    process.stdin.isTTY = true;
    process.stderr.isTTY = true;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exitCode = await main([requirement, "--cwd", cwd, "--json"], async (options) => {
        received = options;
        return unapproved;
      });
      process.stdout.write = write;
      expect(exitCode).toBe(0);
      expect(received?.answerQuestion).toBeUndefined();
      expect(received?.approveBrief).toBeUndefined();
      expect(printed).toHaveLength(1);
      const result = JSON.parse(printed[0]!) as Record<string, any>;
      expect(result).toMatchObject({ status: "completed", readiness: "draft" });
      expect(result.briefApproval).toBeUndefined();
      expect(path.dirname(path.dirname(result.answersFile))).toBe(path.join(cwd, ".unshit"));
      const document = JSON.parse(await readFile(result.answersFile, "utf8")) as Record<string, any>;
      expect(document).toMatchObject({ brief: editableBrief(labelledBrief), answers: { [approvalQuestion.id]: answer }, approveBrief: false });
    } finally {
      process.stdout.write = write;
      process.stdin.isTTY = terminal.stdin;
      process.stderr.isTTY = terminal.stderr;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // main reads isTTY from the real streams; Bun and Node set it to undefined, not false, for a pipe.
  const setTerminal = (stdin: boolean | undefined, stderr: boolean | undefined): void => {
    Object.assign(process.stdin, { isTTY: stdin });
    Object.assign(process.stderr, { isTTY: stderr });
  };

  test("main passes the terminal prompts only to an interactive run: not with --jsonl, and not when stdin or stderr is not a terminal", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    const write = process.stdout.write;
    const terminal = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
    const runs: Array<{ argv: string[]; stdin: boolean | undefined; stderr: boolean | undefined; prompts: boolean }> = [
      { argv: ["--jsonl"], stdin: true, stderr: true, prompts: false },
      { argv: [], stdin: undefined, stderr: true, prompts: false },
      { argv: [], stdin: true, stderr: undefined, prompts: false },
      { argv: [], stdin: true, stderr: true, prompts: true },
    ];
    try {
      for (const run of runs) {
        const printed: string[] = [];
        let received: WorkflowOptions | undefined;
        setTerminal(run.stdin, run.stderr);
        process.stdout.write = ((chunk: string | Uint8Array) => {
          printed.push(String(chunk));
          return true;
        }) as typeof process.stdout.write;
        const exitCode = await main([requirement, "--cwd", cwd, ...run.argv], async (options) => {
          received = options;
          return unapproved;
        });
        process.stdout.write = write;
        expect(exitCode).toBe(0);
        expect([typeof received?.answerQuestion, typeof received?.approveBrief]).toEqual(run.prompts ? ["function", "function"] : ["undefined", "undefined"]);
        if (run.argv.includes("--jsonl")) {
          expect(printed).toHaveLength(1);
          const line = JSON.parse(printed[0]!) as Record<string, any>;
          expect(line).toMatchObject({ type: "result", result: { status: "completed", readiness: "draft" } });
          expect(path.dirname(path.dirname(line.result.answersFile))).toBe(path.join(cwd, ".unshit"));
        }
      }
    } finally {
      process.stdout.write = write;
      setTerminal(terminal.stdin, terminal.stderr);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("without a terminal on stdin, main asks nothing, prints the unapproved plan and names on stderr the answers file that approves its brief", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    const printed: string[] = [];
    const notices: string[] = [];
    const write = { stdout: process.stdout.write, stderr: process.stderr.write };
    const terminal = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
    let received: WorkflowOptions | undefined;
    // A run without --json from a script or an agent: stdin is a pipe while stderr may be a terminal.
    setTerminal(undefined, true);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      notices.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const reportPath = path.join(cwd, "plan.md");
      await writeFile(reportPath, "# Refund plan\n");
      const exitCode = await main([requirement, "--cwd", cwd], async (options) => {
        received = options;
        return { ...unapproved, artifacts: { reportPath, evidenceDirectory: cwd, manifestPath: path.join(cwd, "manifest.json") } } as RunOutcome;
      });
      process.stdout.write = write.stdout;
      process.stderr.write = write.stderr;
      expect(exitCode).toBe(0);
      expect(received?.answerQuestion).toBeUndefined();
      expect(received?.approveBrief).toBeUndefined();
      expect(printed).toEqual(["# Refund plan\n\n"]);
      const answersFile = /Read the brief in (.+?); to approve it/.exec(notices.join(""))?.[1] ?? "";
      expect(path.dirname(path.dirname(answersFile))).toBe(path.join(cwd, ".unshit"));
      expect(notices).toEqual([`No person approved the brief, so the plan is Draft. Read the brief in ${answersFile}; to approve it, set approveBrief to true and rerun with --answers ${answersFile}.\n`]);
      const document = JSON.parse(await readFile(answersFile, "utf8")) as Record<string, any>;
      expect(document).toMatchObject({ brief: editableBrief(labelledBrief), approveBrief: false });
    } finally {
      process.stdout.write = write.stdout;
      process.stderr.write = write.stderr;
      setTerminal(terminal.stdin, terminal.stderr);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("without a terminal on stdin, main prints an approved Draft plan with no approval notice and writes no answers file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    const printed: string[] = [];
    const notices: string[] = [];
    const write = { stdout: process.stdout.write, stderr: process.stderr.write };
    const terminal = { stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
    // Draft for an evidence gap, not for approval: the brief was approved in the answers file this run read.
    const approved: RunOutcome = { ...unapproved, briefApproval: { briefSha256: briefSha256(labelledBrief), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" } } as RunOutcome;
    setTerminal(undefined, true);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      notices.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const reportPath = path.join(cwd, "plan.md");
      await writeFile(reportPath, "# Refund plan\n");
      const exitCode = await main([requirement, "--cwd", cwd], async () => ({ ...approved, artifacts: { reportPath, evidenceDirectory: cwd, manifestPath: path.join(cwd, "manifest.json") } }) as RunOutcome);
      process.stdout.write = write.stdout;
      process.stderr.write = write.stderr;
      expect(exitCode).toBe(0);
      expect(printed).toEqual(["# Refund plan\n\n"]);
      expect(notices).toEqual([]);
      expect(existsSync(path.join(cwd, ".unshit"))).toBe(false);
    } finally {
      process.stdout.write = write.stdout;
      process.stderr.write = write.stderr;
      setTerminal(terminal.stdin, terminal.stderr);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("passes the answers file's approved brief and the terminal prompts to the workflow", () => {
    const approvedBrief: ApprovedBrief = { brief: labelledBrief, resolvedAnswers, approval: { briefSha256: briefSha256(labelledBrief), via: "answers_file", approvedAt: "2026-10-25T09:30:00.000Z" } };
    const answerQuestion = async (): Promise<string> => answer;
    const approveBrief = async (): Promise<boolean> => true;
    expect(answerOptions({ answers: { [approvalQuestion.id]: answer }, questions: [approvalQuestion], approvedBrief }, { answerQuestion, approveBrief })).toEqual({
      answers: { [approvalQuestion.id]: answer },
      priorQuestions: [approvalQuestion],
      approvedBrief,
      answerQuestion,
      approveBrief,
    });
    expect(answerOptions(undefined, {})).toEqual({ answers: {} });
  });

  test("records the brief approval, or null, in the final and checkpoint manifests", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-approval-"));
    const briefApproval: BriefApproval = { briefSha256: briefSha256(labelledBrief), via: "tty", approvedAt: "2026-10-25T09:30:00.000Z" };
    const input = {
      brief: labelledBrief,
      resolvedAnswers,
      plan: (unapproved as Extract<RunOutcome, { status: "completed" }>).plan,
      sources: [],
      evidence: { sources: [], excerpts: [], bytesBySourceId: new Map(), textBySourceId: new Map(), gaps: [] },
      gaps: [],
      reviews: [],
      validationIssues: [],
      validationHistory: [],
      commands: [],
    };
    try {
      const checkpoint = JSON.parse(await readFile(await writeCheckpointArtifacts({ cwd, runId: "approved-checkpoint", stage: "evidence", input: { ...input, briefApproval } }), "utf8")) as Record<string, any>;
      expect(checkpoint.briefApproval).toEqual(briefApproval);
      const approved = await writePlanArtifacts({ cwd, runId: "approved-plan", input: { ...input, briefApproval } });
      expect((JSON.parse(await readFile(approved.manifestPath, "utf8")) as Record<string, any>).briefApproval).toEqual(briefApproval);
      const unapprovedArtifacts = await writePlanArtifacts({ cwd, runId: "unapproved-plan", input });
      expect((JSON.parse(await readFile(unapprovedArtifacts.manifestPath, "utf8")) as Record<string, any>).briefApproval).toBeNull();
      const unapprovedCheckpoint = JSON.parse(await readFile(await writeCheckpointArtifacts({ cwd, runId: "unapproved-checkpoint", stage: "evidence", input }), "utf8")) as Record<string, any>;
      expect(unapprovedCheckpoint.briefApproval).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("asks at the terminal only when the run is interactive, never with --json, --jsonl or without a TTY", async () => {
    const prompts: string[] = [];
    const ask = async (prompt: string): Promise<string> => { prompts.push(prompt); return "Only named refund managers."; };
    const tty = { json: false, jsonl: false, stdinIsTTY: true, stderrIsTTY: true };
    const interactive = terminalPrompts(tty, ask);
    expect(await interactive.answerQuestion?.(approvalQuestion)).toBe("Only named refund managers.");
    expect(prompts).toEqual([`\n${approvalQuestion.id}: Who approves refunds?\nWhy it matters: This sets the access boundary.\n> `]);
    expect(typeof interactive.approveBrief).toBe("function");
    // Bun and Node set isTTY to undefined, not false, for a stream that is not a terminal, such as a pipe.
    for (const mode of [{ ...tty, json: true }, { ...tty, jsonl: true }, { ...tty, stdinIsTTY: undefined }, { ...tty, stdinIsTTY: false }, { ...tty, stderrIsTTY: undefined }, { ...tty, stderrIsTTY: false }]) {
      expect(terminalPrompts(mode, ask)).toEqual({});
    }
    expect(helpText()).toContain("In an interactive terminal run without --json or --jsonl, unshit shows the final requirements and acceptance criteria and asks for yes before reference search; another reply returns needs_input with exit code 2. Other runs stay Draft until a rerun with --answers whose approveBrief is true.\n");
  });

  test("shows the final brief with its summary, labelled requirements, out of scope and assumptions, and approves only yes", async () => {
    const shown: string[] = [];
    const replies = ["no", " YES \n", "y", ""];
    const approveBrief = createBriefApprover(async (prompt) => { shown.push(prompt); return replies.shift()!; });
    expect(await approveBrief(labelledBrief)).toBe(false);
    expect(await approveBrief(labelledBrief)).toBe(true);
    expect(await approveBrief(labelledBrief)).toBe(false);
    expect(await approveBrief(labelledBrief)).toBe(false);
    const text = shown[0]!;
    expect(text).toBe(`\n${renderBriefForApproval(labelledBrief)}\nType yes to approve these requirements and acceptance criteria and start the reference search. Any other reply stops here and saves the brief for editing.\n> `);
    expect(text).toContain("Final brief:\nRefunds with approval.\n");
    expect(text).toContain("R1 (you said: \"named refund managers\"): Only refund managers approve refunds.\n  A1: A clerk cannot approve a refund.\n");
    expect(text).toContain("R2 (inferred): Record refunds.\n  A2: A refund is saved.\n");
    expect(text).toContain("Out of scope:\n- Partial refunds.\n");
    expect(text).toContain("Assumptions:\n- Refund managers are named in the staff list.\n");
  });

  // A terminal readline over in-memory streams: "\x03" is Ctrl+C and "\r" ends a line, as in a real terminal.
  const terminalFixture = () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const state = { interrupts: 0, opens: 0, closes: 0 };
    const open = () => {
      state.opens += 1;
      const readline = createInterface({ input, output: new PassThrough(), terminal: true });
      readline.on("close", () => { state.closes += 1; });
      return readline;
    };
    const terminal = createTerminalAsk(open, () => { state.interrupts += 1; controller.abort(); }, controller.signal);
    return { input, controller, state, terminal };
  };
  const settle = (question: Promise<string>): Promise<string> => Promise.race([
    question.then((reply) => `answered ${reply}`, (error: Error) => `rejected ${error.name}`),
    Bun.sleep(500).then(() => "still waiting"),
  ]);

  test("interrupts the run on Ctrl+C at a terminal prompt or between prompts, and rejects the waiting question", async () => {
    const atPrompt = terminalFixture();
    const waiting = atPrompt.terminal.ask("Type yes\n> ");
    atPrompt.input.write("\x03");
    expect(await settle(waiting)).toBe("rejected AbortError");
    expect(atPrompt.state.interrupts).toBe(1);
    atPrompt.terminal.close();

    const between = terminalFixture();
    const first = between.terminal.ask("Q-1\n> ");
    between.input.write("One event.\r");
    expect(await settle(first)).toBe("answered One event.");
    between.input.write("\x03");
    await Bun.sleep(50);
    expect(between.state.interrupts).toBe(1);
    expect(await settle(between.terminal.ask("Type yes\n> "))).toBe("rejected AbortError");
    between.terminal.close();
  });

  test("interrupts the run when the terminal input ends while a question waits, but not when the run closes the prompt", async () => {
    const ended = terminalFixture();
    const waiting = ended.terminal.ask("Type yes\n> ");
    ended.input.end();
    expect(await settle(waiting)).toBe("rejected AbortError");
    expect(ended.state.interrupts).toBe(1);

    const finished = terminalFixture();
    const reply = finished.terminal.ask("Type yes\n> ");
    finished.input.write("yes\r");
    expect(await settle(reply)).toBe("answered yes");
    finished.terminal.close();
    await Bun.sleep(50);
    expect(finished.state.interrupts).toBe(0);
    expect(finished.controller.signal.aborted).toBe(false);
  });

  test("interrupts the run at the next question when the terminal input ended after the previous one", async () => {
    const ended = terminalFixture();
    const first = ended.terminal.ask("Q-1\n> ");
    ended.input.write("One event.\r");
    expect(await settle(first)).toBe("answered One event.");
    ended.input.end();
    await Bun.sleep(50);
    expect(await settle(ended.terminal.ask("Type yes\n> "))).toBe("rejected AbortError");
    expect(ended.state.interrupts).toBe(1);
  });

  // An interface left open on stdin keeps the CLI process alive after the run, because main only sets the exit code.
  test("asks every terminal question on one interface and closes it when the run closes the prompt", async () => {
    const terminal = terminalFixture();
    const first = terminal.terminal.ask("Q-1\n> ");
    terminal.input.write("One event.\r");
    expect(await settle(first)).toBe("answered One event.");
    const second = terminal.terminal.ask("Type yes\n> ");
    terminal.input.write("yes\r");
    expect(await settle(second)).toBe("answered yes");
    expect(terminal.state.opens).toBe(1);
    expect(terminal.state.closes).toBe(0);
    terminal.terminal.close();
    expect(terminal.state.closes).toBe(1);
    expect(terminal.state.interrupts).toBe(0);
  });
});
