import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { editableBrief, type EditableBrief } from "./brief-approval.ts";
import { REFERENCE_POLICY_HASH } from "./instructions.ts";
import { renderReport, type ReportInput } from "./report.ts";
import type { CheckpointStage, IntakeBrief, MaterialQuestion, RunArtifacts } from "./types.ts";

export async function writePlanArtifacts(options: {
  cwd: string;
  reportPath?: string;
  runId?: string;
  input: ReportInput;
}): Promise<RunArtifacts> {
  const runId = options.runId ?? createRunId();
  const evidenceDirectory = path.join(options.cwd, ".unshit", runId);
  const reportPath = options.reportPath ? path.resolve(options.reportPath) : path.join(evidenceDirectory, "plan.md");
  const manifestPath = path.join(evidenceDirectory, "manifest.json");
  const artifacts = { reportPath, evidenceDirectory, manifestPath };
  await mkdir(path.join(evidenceDirectory, "sources"), { recursive: true, mode: 0o700 });

  const snapshotRecords: Array<{ sourceId: string; path: string; sha256: string; byteCount: number }> = [];
  for (const source of options.input.evidence.sources) {
    const bytes = options.input.evidence.bytesBySourceId.get(source.id);
    if (!bytes) continue;
    const target = path.resolve(evidenceDirectory, source.snapshotPath);
    if (!target.startsWith(`${evidenceDirectory}${path.sep}`)) throw new Error("An evidence snapshot path escaped the run directory.");
    await atomicWrite(target, bytes);
    snapshotRecords.push({ sourceId: source.id, path: source.snapshotPath, sha256: source.sha256, byteCount: bytes.byteLength });
  }

  const manifest = {
    schemaVersion: "1",
    runId,
    generatedAt: new Date().toISOString(),
    readiness: options.input.plan.readiness,
    briefApproval: options.input.briefApproval ?? null,
    brief: options.input.brief,
    initialBrief: options.input.initialBrief,
    research: options.input.research,
    resolvedAnswers: options.input.resolvedAnswers,
    plan: options.input.plan,
    referencePolicySha256: REFERENCE_POLICY_HASH,
    sources: options.input.sources,
    snapshots: snapshotRecords,
    excerpts: options.input.evidence.excerpts.map((excerpt) => ({
      id: excerpt.id,
      sourceId: excerpt.sourceId,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      sha256: createHash("sha256").update(excerpt.text, "utf8").digest("hex"),
    })),
    existingCommandsReadFromTarget: options.input.commands,
    gaps: options.input.gaps,
    reviews: options.input.reviews,
    validationIssues: options.input.validationIssues,
    validationHistory: options.input.validationHistory,
  };
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const report = renderReport({ ...options.input, artifacts });
  await atomicWrite(reportPath, report);
  return artifacts;
}

export async function writeCheckpointArtifacts(options: {
  cwd: string;
  runId: string;
  stage: CheckpointStage;
  input: ReportInput;
}): Promise<string> {
  const evidenceDirectory = path.join(path.resolve(options.cwd), ".unshit", options.runId);
  const manifestPath = path.join(evidenceDirectory, "manifest.json");
  await mkdir(path.join(evidenceDirectory, "sources"), { recursive: true, mode: 0o700 });
  const snapshotRecords: Array<{ sourceId: string; path: string; sha256: string; byteCount: number }> = [];
  for (const source of options.input.evidence.sources) {
    const bytes = options.input.evidence.bytesBySourceId.get(source.id);
    if (!bytes) continue;
    const target = path.resolve(evidenceDirectory, source.snapshotPath);
    if (!target.startsWith(`${evidenceDirectory}${path.sep}`)) throw new Error("An evidence snapshot path escaped the run directory.");
    await atomicWrite(target, bytes);
    snapshotRecords.push({ sourceId: source.id, path: source.snapshotPath, sha256: source.sha256, byteCount: bytes.byteLength });
  }
  const manifest = {
    schemaVersion: "1",
    runId: options.runId,
    generatedAt: new Date().toISOString(),
    checkpointStage: options.stage,
    readiness: "draft",
    briefApproval: options.input.briefApproval ?? null,
    referencePolicySha256: REFERENCE_POLICY_HASH,
    brief: options.input.brief,
    initialBrief: options.input.initialBrief,
    research: options.input.research,
    resolvedAnswers: options.input.resolvedAnswers,
    plan: options.input.plan,
    sources: options.input.sources,
    snapshots: snapshotRecords,
    excerpts: options.input.evidence.excerpts.map((excerpt) => ({
      id: excerpt.id,
      sourceId: excerpt.sourceId,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      sha256: createHash("sha256").update(excerpt.text, "utf8").digest("hex"),
    })),
    existingCommandsReadFromTarget: options.input.commands,
    gaps: options.input.gaps,
    reviews: options.input.reviews,
    validationIssues: options.input.validationIssues,
    validationHistory: options.input.validationHistory,
  };
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export interface AnswerRequestDocument {
  schemaVersion: "1";
  request: {
    requirementSha256: string;
    cwdSha256: string;
    referencePolicySha256: string;
    questions: MaterialQuestion[];
  };
  answers: Record<string, string>;
  // Only in a file written after the final brief existed: the brief for a person to read and edit, and their decision.
  // A rerun uses the brief and the answers in place of new intake, answer and rebuild turns only when approveBrief is true.
  brief?: EditableBrief;
  approveBrief?: boolean;
}

export async function writeAnswersTemplate(options: {
  cwd: string;
  requirement: string;
  questions: MaterialQuestion[];
  answers?: Record<string, string>;
  // The final brief for a person to approve; the file then says approveBrief: false until they change it.
  brief?: IntakeBrief;
}): Promise<string> {
  const runId = createRunId();
  const directory = path.join(path.resolve(options.cwd), ".unshit", runId);
  const target = path.join(directory, "answers.json");
  const questionIds = new Set(options.questions.map((question) => question.id));
  const answers = Object.fromEntries(Object.entries(options.answers ?? {}).filter(([id]) => questionIds.has(id)));
  const document: AnswerRequestDocument = {
    schemaVersion: "1",
    request: {
      requirementSha256: hashText(options.requirement),
      cwdSha256: hashText(path.resolve(options.cwd)),
      referencePolicySha256: REFERENCE_POLICY_HASH,
      questions: options.questions,
    },
    answers,
    ...(options.brief ? { brief: editableBrief(options.brief), approveBrief: false } : {}),
  };
  await atomicWrite(target, `${JSON.stringify(document, null, 2)}\n`);
  return target;
}

async function atomicWrite(target: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
