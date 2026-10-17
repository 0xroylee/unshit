import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { NativeModelGateway, type AppServerClientOptions } from "./app-server.ts";
import { GitHubResearcher } from "./github.ts";
import { runWorkflow } from "./workflow.ts";
import { createRunId, writeAnswersTemplate, writeCheckpointArtifacts, writePlanArtifacts } from "./storage.ts";
import { REFERENCE_POLICY_HASH } from "./instructions.ts";
import { stableMaterialQuestionId } from "./model-schema.ts";
import type { MaterialQuestion, ProgressEvent, RunOutcome } from "./types.ts";

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
  help: boolean;
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
  let help = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") { json = true; continue; }
    if (token === "--jsonl") { jsonl = true; continue; }
    const [name, inlineValue] = token.startsWith("--") && token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
    if (["--cwd", "--out", "--answers", "--model", "--effort", "--turn-timeout"].includes(name)) {
      const value = inlineValue ?? argv[++index];
      if (!value || value.startsWith("--")) throw new CliError(`${name} needs a value.`);
      if (name === "--cwd") cwd = value;
      if (name === "--out") out = value;
      if (name === "--answers") answers = value;
      if (name === "--model") model = value;
      if (name === "--effort") effort = value;
      if (name === "--turn-timeout") turnTimeoutSeconds = parseTurnTimeout(value);
      continue;
    }
    if (token.startsWith("-")) throw new CliError(`Unknown option: ${token}`);
    positional.push(token);
  }

  if (json && jsonl) throw new CliError("Use either --json or --jsonl, not both.");
  if (effort && !["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    throw new CliError("--effort must be minimal, low, medium, high, or xhigh.");
  }
  if (!help && positional.length === 0) throw new CliError("Pass a software requirement in quotes. Run `unshit --help` for usage.");
  if (["resume", "refs", "export"].includes(positional[0]?.toLowerCase() ?? "")) {
    throw new CliError("This CLI accepts one software requirement and produces a plan. Start with a quoted requirement.");
  }
  return { requirement: positional.join(" "), cwd, out, answers, model, effort, turnTimeoutSeconds, json, jsonl, help };
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArguments;
  try {
    args = parseCliArguments(argv);
  } catch (error) {
    return writeCliError(error instanceof Error ? error.message : "Invalid command line.", argv.includes("--json"), argv.includes("--jsonl"));
  }
  if (args.help) {
    stdout.write(helpText());
    return 0;
  }

  const cwd = path.resolve(args.cwd ?? process.cwd());
  try {
    if (!(await stat(cwd)).isDirectory()) throw new CliError(`--cwd is not a directory: ${cwd}`);
  } catch (error) {
    return writeCliError(error instanceof Error ? error.message : `Cannot access --cwd: ${cwd}`, args.json, args.jsonl);
  }

  const answerPath = args.answers ? path.resolve(process.cwd(), args.answers) : undefined;
  let answers: Record<string, string> = {};
  let priorQuestions: MaterialQuestion[] | undefined;
  if (answerPath) {
    try {
      const loaded = await readAnswerFile(answerPath, { requirement: args.requirement, cwd });
      answers = loaded.answers;
      priorQuestions = loaded.questions;
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
  let readlineInterface: ReturnType<typeof createInterface> | undefined;
  let signalCount = 0;
  const onSigint = (): void => {
    signalCount += 1;
    if (!controller.signal.aborted) {
      controller.abort();
      readlineInterface?.close();
    } else if (signalCount > 1) {
      process.exitCode = 130;
    }
  };
  process.on("SIGINT", onSigint);

  const interactive = !args.json && !args.jsonl && stdin.isTTY === true && stderr.isTTY === true;
  const answerQuestion = interactive ? async (question: { id: string; question: string; whyMaterial: string }): Promise<string> => {
    readlineInterface ??= createInterface({ input: stdin, output: stderr });
    return readlineInterface.question(`\n${question.id}: ${question.question}\nWhy it matters: ${question.whyMaterial}\n> `);
  } : undefined;
  const gateway = new NativeModelGateway(gatewayOptions(args, cwd));
  const researcher = new GitHubResearcher({ githubToken: process.env.GITHUB_TOKEN, gitlabToken: process.env.GITLAB_TOKEN, codeSearch: true });
  const runId = createRunId();
  let flowHeaderPrinted = false;

  let outcome = await runWorkflow({
    cwd,
    requirement: args.requirement,
    answers,
    ...(priorQuestions ? { priorQuestions } : {}),
    ...(answerQuestion ? { answerQuestion } : {}),
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
    onCheckpoint: (details, stage) => writeCheckpointArtifacts({ cwd, runId, stage, input: { ...details, commands: details.commands } }),
    onArtifacts: (details) => writePlanArtifacts({
      cwd,
      runId,
      ...(reportPath ? { reportPath } : {}),
      input: details,
    }),
  });

  if (outcome.status === "needs_input") {
    try {
      const questions = uniqueQuestions([...outcome.brief.materialQuestions, ...outcome.questions]);
      const answersFile = await writeAnswersTemplate({ cwd, requirement: args.requirement, questions, answers });
      outcome = { ...outcome, answersFile };
    } catch (error) {
      outcome = { status: "error", message: error instanceof Error ? error.message : "Could not save the answers request." };
    }
  }

  readlineInterface?.close();
  process.off("SIGINT", onSigint);
  if (outcome.status === "completed" && !args.json && !args.jsonl && outcome.artifacts) {
    const report = await readFile(outcome.artifacts.reportPath, "utf8");
    stdout.write(`${report}\n`);
  } else if (args.json) {
    stdout.write(`${JSON.stringify(outcome)}\n`);
  } else if (outcome.status === "needs_input") {
    stderr.write("Material answers are required before reference search can start.\n");
    for (const question of outcome.questions) stderr.write(`- ${question.id}: ${question.question} (${question.whyMaterial})\n`);
    stderr.write(`Edit ${outcome.answersFile ?? "the generated answers.json"} and rerun with --answers.\n`);
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
  return exitCodeFor(outcome, controller.signal.aborted);
}

export async function readAnswerFile(
  filePath: string,
  expected?: { requirement: string; cwd: string },
): Promise<{ answers: Record<string, string>; questions?: MaterialQuestion[] }> {
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
    return { answers: parseAnswerMap(record.answers, ids), questions };
  }
  return { answers: parseAnswerMap(record) };
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
    "  --answers <json-file> Use and edit the answers.json template returned by needs_input",
    "  --model <name>        Use a Codex model for this run",
    "  --effort <level>      minimal, low, medium, high, or xhigh",
    "  --turn-timeout <seconds>  End a model turn after this many seconds without Codex activity (30-3600, default 600); a turn may run three times as long in total",
    "  --json                Emit one JSON result object",
    "  --jsonl               Emit progress and result as JSON Lines",
    "  --help                Show this help",
    "",
    "The default report and evidence manifest are saved under .unshit/<run-id>/.",
    "Missing material answers return needs_input with exit code 2. A model turn that times out returns 124. Ctrl+C returns 130.",
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
