import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import type { Readable } from "node:stream";
import { createAgentProtocol } from "./agent-protocol.ts";
import { NativeModelGateway, type AppServerClientOptions } from "./app-server.ts";
import { GitHubResearcher } from "./github.ts";
import { materialAnswerContext, runWorkflow, type AnswerQuestion, type AnswerQuestions, type ApproveBrief, type ConfirmPreview, type WorkflowOptions } from "./workflow.ts";
import { createRunId, createRunPublisher, writeAnswersTemplate, writeCheckpointArtifacts, writePlanArtifacts, writePreviewRevision, type FileWriter, type RunPublisher } from "./storage.ts";
import { changedStages } from "./preview.ts";
import { renderPreviewText } from "./report.ts";
import type { LoadedEvidence } from "./evidence.ts";
import { REFERENCE_POLICY_HASH } from "./instructions.ts";
import { parseApprovedBrief, stableMaterialQuestionId } from "./model-schema.ts";
import { briefSha256, isBriefApproval, renderBriefForApproval } from "./brief-approval.ts";
import { SKILL_NAME, defaultSkillTargets, installSkill, type SkillTarget } from "./skill-install.ts";
import type { ApprovedBrief, IntakeBrief, MaterialQuestion, PlanDocument, ProgressEvent, ResolvedAnswer, RunOutcome, WorkflowPreview } from "./types.ts";

interface CliArguments {
  requirement: string;
  cwd?: string;
  out?: string;
  answers?: string;
  model?: string;
  effort?: string;
  turnTimeoutSeconds?: number;
  json: boolean;
  jsonl: boolean;
  agent: boolean;
  help: boolean;
  installSkill: boolean;
  skillDir?: string;
  force: boolean;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function parseCliArguments(argv: string[]): CliArguments {
  let cwd: string | undefined;
  let out: string | undefined;
  let answers: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let turnTimeoutSeconds: number | undefined;
  let json = false;
  let jsonl = false;
  let agent = false;
  let help = false;
  let installSkillFlag = false;
  let skillDir: string | undefined;
  let force = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") { json = true; continue; }
    if (token === "--jsonl") { jsonl = true; continue; }
    if (token === "--agent") { agent = true; continue; }
    if (token === "--install-skill") { installSkillFlag = true; continue; }
    if (token === "--force") { force = true; continue; }
    const [name, inlineValue] = token.startsWith("--") && token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
    if (["--cwd", "--out", "--answers", "--model", "--effort", "--turn-timeout", "--skill-dir"].includes(name)) {
      const value = inlineValue ?? argv[++index];
      if (!value || value.startsWith("--")) throw new CliError(`${name} needs a value.`);
      if (name === "--cwd") cwd = value;
      if (name === "--out") out = value;
      if (name === "--answers") answers = value;
      if (name === "--model") model = value;
      if (name === "--effort") effort = value;
      if (name === "--turn-timeout") turnTimeoutSeconds = parseTurnTimeout(value);
      if (name === "--skill-dir") skillDir = value;
      continue;
    }
    if (token.startsWith("-")) throw new CliError(`Unknown option: ${token}`);
    positional.push(token);
  }

  if (agent && json) throw new CliError("--agent uses JSONL and cannot be combined with --json.");
  if (agent && installSkillFlag) throw new CliError("--agent cannot be combined with --install-skill.");
  if (agent) jsonl = true;
  if (json && jsonl) throw new CliError("Use either --json or --jsonl, not both.");
  if (installSkillFlag) {
    if (positional.length > 0 || cwd || out || answers || model || effort || turnTimeoutSeconds !== undefined) {
      throw new CliError("--install-skill runs on its own; it does not take a requirement or planning options.");
    }
    if (jsonl) throw new CliError("Use --json with --install-skill.");
    return { requirement: "", json, jsonl, agent, help, installSkill: true, ...(skillDir ? { skillDir } : {}), force };
  }
  if (skillDir || force) throw new CliError("--skill-dir and --force work only with --install-skill.");
  if (effort && !["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    throw new CliError("--effort must be minimal, low, medium, high, or xhigh.");
  }
  if (!help && positional.length === 0) throw new CliError("Pass a software requirement in quotes. Run `unshit --help` for usage.");
  if (["resume", "refs", "export"].includes(positional[0]?.toLowerCase() ?? "")) {
    throw new CliError("This CLI accepts one software requirement and produces a plan. Start with a quoted requirement.");
  }
  return { requirement: positional.join(" "), cwd, out, answers, model, effort, turnTimeoutSeconds, json, jsonl, agent, help, installSkill: false, force: false };
}

function parseTurnTimeout(value: string): number {
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || seconds < 30 || seconds > 3_600) {
    throw new CliError("--turn-timeout must be a whole number of seconds from 30 to 3600.");
  }
  return seconds;
}

export function gatewayOptions(args: CliArguments, cwd: string): AppServerClientOptions {
  return {
    cwd,
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.turnTimeoutSeconds ? { turnIdleTimeoutMs: args.turnTimeoutSeconds * 1_000 } : {}),
  };
}

export function exitCodeFor(outcome: RunOutcome, aborted: boolean): number {
  if (outcome.status === "needs_input") return 2;
  if (outcome.status === "interrupted" || aborted) return 130;
  if (outcome.status === "timed_out") return 124;
  if (outcome.status === "error") return 1;
  return 0;
}

async function runInstallSkill(args: CliArguments): Promise<number> {
  const targets: SkillTarget[] = args.skillDir
    ? [{ agent: "custom", skillsRoot: path.resolve(args.skillDir) }]
    : await defaultSkillTargets(os.homedir(), process.env);
  if (targets.length === 0) {
    return writeCliError("No Claude Code (~/.claude) or Codex (~/.codex, ~/.agents) folder was found. Pass --skill-dir <skills folder> to choose one.", args.json, false);
  }
  const results = await installSkill(targets, { force: args.force });
  const failed = results.some((result) => result.status === "failed");
  if (args.json) {
    stdout.write(`${JSON.stringify({ status: failed ? "error" : "ok", skill: SKILL_NAME, results })}\n`);
  } else {
    for (const result of results) {
      const line = `${result.status.padEnd(9)} ${result.agent.padEnd(6)} ${result.path}${result.reason ? ` (${result.reason})` : ""}\n`;
      (result.status === "failed" ? stderr : stdout).write(line);
    }
  }
  return failed ? 1 : 0;
}

// `run` is the workflow; a test passes its own to check main's handling of options, files and output.
export async function main(argv = process.argv.slice(2), run: (options: WorkflowOptions) => Promise<RunOutcome> = runWorkflow, agentInput: Readable = stdin): Promise<number> {
  let args: CliArguments;
  try {
    args = parseCliArguments(argv);
  } catch (error) {
    return writeCliError(error instanceof Error ? error.message : "Invalid command line.", argv.includes("--json") && !argv.includes("--agent"), argv.includes("--jsonl") || argv.includes("--agent"));
  }
  if (args.help) {
    stdout.write(helpText());
    return 0;
  }
  if (args.installSkill) return runInstallSkill(args);

  const cwd = path.resolve(args.cwd ?? process.cwd());
  try {
    if (!(await stat(cwd)).isDirectory()) throw new CliError(`--cwd is not a directory: ${cwd}`);
  } catch (error) {
    return writeCliError(error instanceof Error ? error.message : `Cannot access --cwd: ${cwd}`, args.json, args.jsonl);
  }

  const answerPath = args.answers ? path.resolve(process.cwd(), args.answers) : undefined;
  let loaded: LoadedAnswers | undefined;
  if (answerPath) {
    try {
      loaded = await readAnswerFile(answerPath, { requirement: args.requirement, cwd });
    } catch (error) {
      return writeCliError(error instanceof Error ? error.message : "Could not read the answers file.", args.json, args.jsonl);
    }
  }

  const reportPath = args.out ? path.resolve(cwd, args.out) : undefined;
  if (reportPath) {
    try {
      const metadata = await stat(reportPath);
      if (metadata.isDirectory()) throw new CliError(`--out points to a directory: ${reportPath}`);
    } catch (error) {
      if (error instanceof CliError) return writeCliError(error.message, args.json, args.jsonl);
      if (isExistingPathError(error)) return writeCliError(`Cannot access --out: ${reportPath}`, args.json, args.jsonl);
    }
  }

  const controller = new AbortController();
  const terminal = createTerminalAsk(() => createInterface({ input: stdin, output: stderr }), () => onSigint(), controller.signal);
  let signalCount = 0;
  const onSigint = (): void => {
    signalCount += 1;
    if (!controller.signal.aborted) {
      controller.abort();
      terminal.close();
    } else if (signalCount > 1) {
      process.exitCode = 130;
    }
  };
  process.on("SIGINT", onSigint);

  const prompts = terminalPrompts({ json: args.json, jsonl: args.jsonl, stdinIsTTY: stdin.isTTY, stderrIsTTY: stderr.isTTY }, terminal.ask);
  const gateway = new NativeModelGateway(gatewayOptions(args, cwd));
  const researcher = new GitHubResearcher({ githubToken: process.env.GITHUB_TOKEN, gitlabToken: process.env.GITLAB_TOKEN, codeSearch: true });
  const runId = createRunId();
  let flowHeaderPrinted = false;
  const writers = createRunWriters({
    cwd,
    runId,
    ...(reportPath ? { reportPath } : {}),
    jsonl: args.jsonl,
    write: (text) => (args.jsonl ? stdout : stderr).write(text),
  });
  const agent = args.agent ? createAgentProtocol({ input: agentInput, write: (text) => stdout.write(text), controller }) : undefined;
  const inputPrompts: TerminalPrompts = agent ? {
    answerQuestions: agent.answerQuestions,
    approveBrief: agent.approveBrief,
    approvalVia: "agent",
    confirmPreview: (preview) => {
      const page = writers.pagePath();
      if (!page) throw new Error("Could not save workflow preview.");
      return agent.confirmPreview(preview, page);
    },
  } : prompts;

  try {
    let ran: RunOutcome;
    try {
      ran = await runWithAnswers({
        cwd,
        requirement: args.requirement,
        signal: controller.signal,
        modelGateway: gateway,
        researcher,
        onProgress: (event) => {
          if (!args.jsonl && !flowHeaderPrinted) {
            stderr.write("Flow: scope -> sources -> evidence -> plan -> review -> saved\n");
            flowHeaderPrinted = true;
          }
          outputProgress(event, args.jsonl);
        },
        onPreview: writers.onPreview,
        onCheckpoint: writers.onCheckpoint,
        onArtifacts: writers.onArtifacts,
      }, loaded, inputPrompts, run);
    } catch (error) {
      if (!agent) throw error;
      ran = { status: "error", message: "The workflow failed." };
    }
    agent?.finish();
    const protocolFailure = agent?.failure();
    if (protocolFailure) ran = { status: "error", code: protocolFailure.code, message: protocolFailure.message };
    else if (args.agent && controller.signal.aborted) ran = { status: "interrupted", message: "The agent run was interrupted.", ...("checkpointPath" in ran && ran.checkpointPath ? { checkpointPath: ran.checkpointPath } : {}) };
    const page = writers.pagePath();
    const outcome: RunOutcome = ran.status === "needs_input" && ran.previewStop && page ? { ...ran, previewPath: page } : ran;

    if (outcome.status === "completed" && !args.json && !args.jsonl && outcome.artifacts) {
      const report = await readFile(outcome.artifacts.reportPath, "utf8");
      stdout.write(`${report}\n`);
      if (outcome.answersFile) stderr.write(`No person approved the brief, so the plan is Draft. Read the brief in ${outcome.answersFile}; to approve it, set approveBrief to true and rerun with --answers ${outcome.answersFile}.\n`);
    } else if (args.json) {
      stdout.write(`${JSON.stringify(outcome)}\n`);
    } else if (outcome.status === "needs_input") {
      stderr.write(needsInputMessage(outcome));
    } else if (outcome.status === "interrupted") {
      stderr.write(`${outcome.message}\n`);
      if (outcome.checkpointPath) stderr.write(`Saved evidence checkpoint: ${outcome.checkpointPath}\n`);
    } else if (outcome.status === "timed_out") {
      stderr.write(`${outcome.message}\n`);
      if (outcome.checkpointPath) stderr.write(`Saved evidence checkpoint: ${outcome.checkpointPath}\n`);
      stderr.write("Use --turn-timeout <seconds> to allow longer model turns.\n");
    } else if (outcome.status === "error") {
      stderr.write(`${outcome.message}\n`);
      if (outcome.checkpointPath) stderr.write(`Saved evidence checkpoint: ${outcome.checkpointPath}\n`);
    }

    if (args.jsonl) stdout.write(`${formatJsonlResult(outcome)}\n`);
    return protocolFailure ? 1 : exitCodeFor(outcome, controller.signal.aborted);
  } finally {
    agent?.close();
    terminal.close();
    process.off("SIGINT", onSigint);
  }
}

export interface LoadedAnswers {
  answers: Record<string, string>;
  questions?: MaterialQuestion[];
  approvedBrief?: ApprovedBrief;
}

export async function readAnswerFile(
  filePath: string,
  expected?: { requirement: string; cwd: string },
  now = new Date(),
): Promise<LoadedAnswers> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new CliError("--answers must point to a valid JSON object mapping question IDs to strings.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("--answers must be a JSON object mapping question IDs to strings.");
  }
  const record = parsed as Record<string, unknown>;
  if ("request" in record || "answers" in record || "schemaVersion" in record) {
    if (!expected || record.schemaVersion !== "1" || !isRecord(record.request) || !isRecord(record.answers)) {
      throw new CliError("--answers request file has an unsupported or incomplete format.");
    }
    const request = record.request;
    const expectedRequirement = hashText(expected.requirement);
    const expectedCwd = hashText(path.resolve(expected.cwd));
    if (request.requirementSha256 !== expectedRequirement || request.cwdSha256 !== expectedCwd || request.referencePolicySha256 !== REFERENCE_POLICY_HASH) {
      throw new CliError("--answers belongs to a different requirement, working directory, or reference policy.");
    }
    if (!Array.isArray(request.questions) || request.questions.length > 12) throw new CliError("--answers request has invalid question context.");
    const questions: MaterialQuestion[] = [];
    const ids = new Set<string>();
    for (const raw of request.questions) {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.question !== "string" || typeof raw.whyMaterial !== "string" || raw.id !== stableMaterialQuestionId(raw.question, raw.whyMaterial) || ids.has(raw.id)) {
        throw new CliError("--answers request has invalid or duplicate question context.");
      }
      ids.add(raw.id);
      questions.push({ id: raw.id, question: raw.question, whyMaterial: raw.whyMaterial });
    }
    const answers = parseAnswerMap(record.answers, ids);
    if (record.brief === undefined && record.approveBrief === undefined) return { answers, questions };
    if (!isRecord(record.brief) || typeof record.approveBrief !== "boolean") {
      throw new CliError("--answers brief must be an object, and approveBrief must be true or false.");
    }
    if (!record.approveBrief) return { answers, questions };
    return { answers, questions, approvedBrief: approvedBriefFrom(record.brief, questions, answers, expected.requirement, now) };
  }
  return { answers: parseAnswerMap(record) };
}

// The brief of an answers file whose approveBrief is true. Approving the brief does not answer a material question, so
// every question in the request needs its answer. The brief passes the intake checks again: the host reassigns the
// R* and A* IDs and labels each requirement against the requirement text and the file's answers. approvedAt is `now`,
// when the host read the file, because the file does not say when or by whom approveBrief was set.
export function approvedBriefFrom(
  value: Record<string, unknown>,
  questions: MaterialQuestion[],
  answers: Record<string, string>,
  requirement: string,
  now: Date,
): ApprovedBrief {
  const unanswered = questions.filter((question) => !answers[question.id]).map((question) => question.id);
  if (unanswered.length > 0) {
    throw new CliError(`--answers approveBrief is true, but these questions have no answer: ${unanswered.join(", ")}. Approving the brief does not answer them; write each answer in answers and rerun.`);
  }
  const resolvedAnswers = materialAnswerContext({ materialQuestions: questions }, answers);
  let brief: IntakeBrief;
  try {
    brief = parseApprovedBrief(value, questions, [requirement, ...resolvedAnswers.map((answer) => answer.answer)]);
  } catch (error) {
    throw new CliError(`--answers brief is invalid: ${error instanceof Error ? error.message : "it could not be read."}`);
  }
  return { brief, resolvedAnswers, approval: { briefSha256: briefSha256(brief), via: "answers_file", approvedAt: now.toISOString() } };
}

type TerminalPrompts = { answerQuestion?: AnswerQuestion; answerQuestions?: AnswerQuestions; approveBrief?: ApproveBrief; approvalVia?: "tty" | "agent"; confirmPreview?: ConfirmPreview };

// The workflow options that an answers file and the terminal prompts supply.
export function answerOptions(
  loaded: LoadedAnswers | undefined,
  prompts: TerminalPrompts,
): Pick<WorkflowOptions, "answers" | "priorQuestions" | "approvedBrief" | "answerQuestion" | "answerQuestions" | "approveBrief" | "approvalVia" | "confirmPreview"> {
  return {
    answers: loaded?.answers ?? {},
    ...(loaded?.questions ? { priorQuestions: loaded.questions } : {}),
    ...(loaded?.approvedBrief ? { approvedBrief: loaded.approvedBrief } : {}),
    ...(prompts.answerQuestion ? { answerQuestion: prompts.answerQuestion } : {}),
    ...(prompts.answerQuestions ? { answerQuestions: prompts.answerQuestions } : {}),
    ...(prompts.approveBrief ? { approveBrief: prompts.approveBrief } : {}),
    ...(prompts.approvalVia ? { approvalVia: prompts.approvalVia } : {}),
    ...(prompts.confirmPreview ? { confirmPreview: prompts.confirmPreview } : {}),
  };
}

// Runs the workflow with what the answers file and the terminal supply, then saves the answers file the outcome needs.
// A later needs_input file keeps the answers this run was given, so a person does not write them again.
export async function runWithAnswers(
  options: Omit<WorkflowOptions, keyof ReturnType<typeof answerOptions>>,
  loaded: LoadedAnswers | undefined,
  prompts: TerminalPrompts,
  run: (options: WorkflowOptions) => Promise<RunOutcome> = runWorkflow,
): Promise<RunOutcome> {
  const outcome = await run({ ...options, ...answerOptions(loaded, prompts) });
  return withAnswersFile(outcome, { cwd: options.cwd, requirement: options.requirement, answers: loaded?.answers ?? {} });
}

// The terminal prompts: each unanswered material question, the final brief for approval, and the reference preview
// for confirmation. A run with --json or --jsonl, or whose stdin or stderr is not a terminal, gets none, so it never
// waits on stdin: missing answers return needs_input, and the run stops at the reference preview, before any plan.
export function terminalPrompts(
  mode: { json: boolean; jsonl: boolean; stdinIsTTY: boolean | undefined; stderrIsTTY: boolean | undefined },
  ask: (prompt: string) => Promise<string>,
): TerminalPrompts {
  if (mode.json || mode.jsonl || mode.stdinIsTTY !== true || mode.stderrIsTTY !== true) return {};
  return {
    answerQuestion: (question) => ask(`\n${question.id}: ${question.question}\nWhy it matters: ${question.whyMaterial}\n> `),
    approveBrief: createBriefApprover(ask),
    confirmPreview: createPreviewConfirmer(ask),
  };
}

// Asks after the preview that its publication printed, and confirms only a reply that is yes once trimmed and
// lowercased.
export function createPreviewConfirmer(ask: (prompt: string) => Promise<string>): ConfirmPreview {
  return async () => isPreviewConfirmation(await ask("\nType yes to continue with candidate ranking, tree checks, source reads and planning. Any other reply stops here, and no downstream work starts.\n> "));
}

export function isPreviewConfirmation(reply: string): boolean {
  return reply.trim().toLowerCase() === "yes";
}

// The writers of one run. The preview pages, the checkpoints and the final artifacts all go through one queue, in the
// order the workflow calls them; the final artifacts close it. `write` reports each preview revision (stderr, or stdout
// for JSONL); `writer` replaces the atomic file write in tests.
export function createRunWriters(options: {
  cwd: string;
  runId: string;
  reportPath?: string;
  jsonl: boolean;
  write: (text: string) => void;
  writer?: FileWriter;
}): Required<Pick<WorkflowOptions, "onPreview" | "onCheckpoint" | "onArtifacts">> & { pagePath: () => string | undefined } {
  const { cwd, runId } = options;
  const writer = options.writer ? { writer: options.writer } : {};
  const publisher = createRunPublisher();
  const preview = createPreviewPublication({ evidenceDirectory: path.join(cwd, ".unshit", runId), publisher, jsonl: options.jsonl, write: options.write, ...writer });
  return {
    onPreview: preview.publish,
    onCheckpoint: (details, stage) => publisher.run(() => writeCheckpointArtifacts({ cwd, runId, stage, input: { ...details, commands: details.commands }, ...writer })),
    onArtifacts: (details) => publisher.finalize(() => writePlanArtifacts({
      cwd,
      runId,
      ...(options.reportPath ? { reportPath: options.reportPath } : {}),
      input: details,
      ...(details.completePreview ? { completePreview: details.completePreview } : {}),
      ...writer,
    })),
    pagePath: preview.pagePath,
  };
}

// Publishes each preview revision through `publisher`: its source snapshots and page, and with a plan its stack page,
// then a report of it. A terminal gets each page path once, then the stages that changed; JSONL gets one preview line
// per revision.
function createPreviewPublication(options: {
  evidenceDirectory: string;
  publisher: RunPublisher;
  jsonl: boolean;
  write: (text: string) => void;
  writer?: FileWriter;
}): { publish: (preview: WorkflowPreview, evidence: LoadedEvidence, plan?: PlanDocument) => Promise<void>; pagePath: () => string | undefined } {
  const published = new Set<string>();
  let previous: WorkflowPreview | undefined;
  let pagePath: string | undefined;
  let stackPath: string | undefined;
  return {
    publish: (preview, evidence, plan) => options.publisher.run(async () => {
      const written = await writePreviewRevision({ evidenceDirectory: options.evidenceDirectory, preview, evidence, published, ...(plan ? { plan } : {}), ...(options.writer ? { writer: options.writer } : {}) });
      const page = written.page;
      if (options.jsonl) {
        const stages = changedStages(preview, previous);
        const keys = new Set(stages.flatMap((stage) => stage.uses.map((use) => use.key)));
        options.write(`${JSON.stringify({ type: "preview", revision: preview.revision, page, ...(written.stack ? { stack: written.stack } : {}), stages, references: preview.references.filter((reference) => keys.has(reference.key)) })}\n`);
      } else {
        if (!pagePath) options.write(`Reference preview page: ${page}\n`);
        if (written.stack && !stackPath) options.write(`Stack page: ${written.stack}\n`);
        options.write(renderPreviewText(preview, previous));
      }
      pagePath = page;
      stackPath = written.stack ?? stackPath;
      previous = preview;
    }),
    pagePath: () => pagePath,
  };
}

// Shows the final brief with its labelled requirements and acceptance criteria, and approves it only on a reply of yes.
export function createBriefApprover(ask: (prompt: string) => Promise<string>): ApproveBrief {
  return async (brief) => {
    const reply = await ask(`\n${renderBriefForApproval(brief)}\nType yes to approve these requirements and acceptance criteria and start the reference search. Any other reply stops here and saves the brief for editing.\n> `);
    return isBriefApproval(reply);
  };
}

// One readline interface for every terminal prompt, opened at the first one. In a terminal, readline takes Ctrl+C
// itself and only closes, with no process SIGINT, so a pending question never settled and the run hung. Here Ctrl+C,
// or input that ends while a question waits or before the next question, calls `interrupt`; the aborted signal then
// rejects the question, and the run ends as interrupted (exit 130).
export function createTerminalAsk(
  open: () => Interface,
  interrupt: () => void,
  signal: AbortSignal,
): { ask: (prompt: string) => Promise<string>; close: () => void } {
  let readline: Interface | undefined;
  let waiting = false;
  let closed = false;
  return {
    ask: async (prompt) => {
      // Input that ended between two questions closed the interface. question() would reject with "readline was
      // closed" and end the run as an error; the run ends as interrupted instead, as when input ends at a question.
      if (closed && !signal.aborted) interrupt();
      // Bun's question() throws a TypeError for a signal that is already aborted.
      signal.throwIfAborted();
      if (!readline) {
        readline = open();
        readline.on("SIGINT", interrupt);
        readline.on("close", () => {
          closed = true;
          if (waiting && !signal.aborted) interrupt();
        });
      }
      waiting = true;
      try {
        return await readline.question(prompt, { signal });
      } finally {
        waiting = false;
      }
    },
    close: () => readline?.close(),
  };
}

// Saves the answers file that a person edits after needs_input or after a plan whose brief nobody approved, and names
// it in the outcome. A brief that was not approved goes into the file with approveBrief: false.
export async function withAnswersFile(
  outcome: RunOutcome,
  options: { cwd: string; requirement: string; answers: Record<string, string> },
): Promise<RunOutcome> {
  // A stop at the reference preview is not a question: it needs an interactive rerun, not an answers file.
  if (outcome.status === "needs_input" && outcome.previewStop) return outcome;
  if (outcome.status === "needs_input") {
    try {
      const questions = uniqueQuestions([...outcome.brief.materialQuestions, ...outcome.questions]);
      const answersFile = await writeAnswersTemplate(outcome.approvalRequested
        ? { cwd: options.cwd, requirement: options.requirement, questions, answers: answerMap(outcome.resolvedAnswers ?? []), brief: outcome.brief }
        : { cwd: options.cwd, requirement: options.requirement, questions, answers: options.answers });
      return { ...outcome, answersFile };
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : "Could not save the answers request." };
    }
  }
  if (outcome.status === "completed" && !outcome.briefApproval) {
    try {
      const answersFile = await writeAnswersTemplate({ cwd: options.cwd, requirement: options.requirement, questions: outcome.brief.materialQuestions, answers: answerMap(outcome.resolvedAnswers), brief: outcome.brief });
      return { ...outcome, answersFile };
    } catch {
      // The plan is already saved; only the file for approving its brief is missing.
      return outcome;
    }
  }
  return outcome;
}

// What a person reads on stderr when the run stopped for input.
export function needsInputMessage(outcome: Extract<RunOutcome, { status: "needs_input" }>): string {
  if (outcome.previewStop) {
    const page = outcome.previewPath ? `Reference preview page: ${outcome.previewPath}\n` : "";
    return `${outcome.message ?? "The run stopped at the reference preview."}\n${page}To continue past the preview, run the same command in an interactive terminal and type yes when unshit asks.\n`;
  }
  const file = outcome.answersFile ?? "the generated answers.json";
  if (outcome.approvalRequested) {
    return `The brief was not approved, so reference search did not start.\nEdit the brief in ${file} if it needs changes, set approveBrief to true, and rerun with --answers ${file}.\n`;
  }
  const lines = [
    "Material answers are required before reference search can start.",
    ...outcome.questions.map((question) => `- ${question.id}: ${question.question} (${question.whyMaterial})`),
    `Edit ${file} and rerun with --answers.`,
  ];
  return `${lines.join("\n")}\n`;
}

function outputProgress(event: ProgressEvent, jsonl: boolean): void {
  if (jsonl) {
    stdout.write(`${JSON.stringify({ type: "progress", ...event })}\n`);
    return;
  }
  const marker = event.state === "started" ? "->" : event.state === "completed" ? "[ok]" : event.state === "skipped" ? "[skip]" : "[!]";
  stderr.write(`${marker} ${event.stage}: ${event.message}\n`);
}

export function formatJsonlResult(outcome: RunOutcome): string {
  return JSON.stringify({ type: "result", result: outcome });
}

function parseAnswerMap(value: Record<string, unknown>, allowedIds?: Set<string>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [id, answer] of Object.entries(value)) {
    if (!/^Q-[a-f0-9]{12}$/.test(id) || typeof answer !== "string" || answer.trim().length === 0 || (allowedIds && !allowedIds.has(id))) {
      throw new CliError("--answers must map current material-question IDs to non-empty strings.");
    }
    answers[id] = answer.trim();
  }
  return answers;
}

function answerMap(resolved: ResolvedAnswer[]): Record<string, string> {
  return Object.fromEntries(resolved.map((answer) => [answer.questionId, answer.answer]));
}

function uniqueQuestions(questions: MaterialQuestion[]): MaterialQuestion[] {
  const seen = new Set<string>();
  return questions.filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  });
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeCliError(message: string, json: boolean, jsonl: boolean): number {
  if (json) stdout.write(`${JSON.stringify({ status: "error", message })}\n`);
  else if (jsonl) stdout.write(`${JSON.stringify({ type: "result", result: { status: "error", message } })}\n`);
  else stderr.write(`${message}\n`);
  return 1;
}

export function helpText(): string {
  return [
    "unshit \"software requirement\"",
    "",
    "Create a source-backed implementation plan using the current Codex login.",
    "",
    "Options:",
    "  --cwd <directory>     Target project directory (default: current directory)",
    "  --out <file>          Save the Markdown plan at this path",
    "  --answers <json-file> Use and edit the answers.json that needs_input or an unapproved plan returned",
    "  --model <name>        Use a Codex model for this run",
    "  --effort <level>      minimal, low, medium, high, or xhigh",
    "  --turn-timeout <seconds>  End a model turn after this many seconds without Codex activity (30-3600, default 600); a turn may run three times as long in total",
    "  --json                Emit one JSON result object",
    "  --jsonl               Emit progress and result as JSON Lines",
    "  --agent               Exchange JSONL input requests and replies over stdout/stdin in one live run",
    "  --help                Show this help",
    "",
    "unshit --install-skill [--skill-dir <dir>] [--force] [--json]",
    "",
    "Install the unshit agent skill (how to run unshit and implement from its plans)",
    "into ~/.claude/skills/unshit (Claude Code), and into $CODEX_HOME/skills/unshit",
    "(default ~/.codex/skills) and ~/.agents/skills/unshit (Codex), for the agent",
    "folders found on this machine.",
    "  --skill-dir <dir>     Install into this skills folder instead",
    "  --force               Replace an existing unshit skill that unshit did not install",
    "",
    "The default report and evidence manifest are saved under .unshit/<run-id>/.",
    "Missing material answers return needs_input with exit code 2. A model turn that times out returns 124. Ctrl+C returns 130.",
    "In an interactive terminal run without --json or --jsonl, unshit shows the final requirements and acceptance criteria and asks for yes before reference search; another reply returns needs_input with exit code 2 and saves the brief in an answers file, whose approveBrief a person can set to true for a rerun with --answers.",
    "After the search, unshit writes .unshit/<run-id>/preview.html, shows each stage with the references it used, and asks for yes before ranking, tree checks, source reads and planning; another reply returns needs_input with exit code 2. A run with --json or --jsonl, or without a terminal, stops there with exit code 2 unless --agent is set.",
    "--agent implies --jsonl and waits for input_response records matching each input_request requestId: answers for material_answers, or approved for brief_approval and preview_confirmation. It has no reply timeout. A cancel record, Ctrl+C or EOF interrupts with exit 130; invalid protocol input fails with exit 1. --agent cannot be combined with --json or --install-skill.",
    "",
  ].join("\n");
}

function isExistingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTDIR");
}

if (import.meta.main) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    stderr.write(`${error instanceof Error ? error.message : "unshit failed."}\n`);
    process.exitCode = 1;
  });
}
