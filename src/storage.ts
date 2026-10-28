import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { editableBrief, type EditableBrief } from "./brief-approval.ts";
import { REFERENCE_POLICY_HASH } from "./instructions.ts";
import { renderPreviewHtml, renderReport, type ReportInput } from "./report.ts";
import type { LoadedEvidence } from "./evidence.ts";
import { PREVIEW_FINALIZE_FAILED, PREVIEW_SAVE_FAILED, PREVIEW_SOURCES_FAILED, PUBLICATION_CLOSED } from "./preview.ts";
import type { CheckpointStage, IntakeBrief, MaterialQuestion, RunArtifacts, WorkflowPreview } from "./types.ts";

// Writes `data` to `target`. The default writes a temporary file and renames it; a test passes its own.
export type FileWriter = (target: string, data: string | Uint8Array) => Promise<void>;

// With completePreview, the save stage completes only after the source snapshots are written: completePreview returns
// that revision, and the manifest, the plan and the page all carry it. A failed write of those three is reported as
// PREVIEW_FINALIZE_FAILED.
export async function writePlanArtifacts(options: {
  cwd: string;
  reportPath?: string;
  runId?: string;
  input: ReportInput;
  completePreview?: () => WorkflowPreview;
  writer?: FileWriter;
}): Promise<RunArtifacts> {
  const write = options.writer ?? atomicWrite;
  const runId = options.runId ?? createRunId();
  const evidenceDirectory = path.join(options.cwd, ".unshit", runId);
  const reportPath = options.reportPath ? path.resolve(options.reportPath) : path.join(evidenceDirectory, "plan.md");
  const manifestPath = path.join(evidenceDirectory, "manifest.json");
  const snapshotRecords = await writeSourceSnapshots(evidenceDirectory, options.input.evidence, write);

  const preview = options.completePreview ? options.completePreview() : options.input.preview;
  const previewPath = preview ? path.join(evidenceDirectory, "preview.html") : undefined;
  const artifacts: RunArtifacts = { reportPath, evidenceDirectory, manifestPath, ...(previewPath ? { previewPath } : {}) };
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
    preview,
  };
  const writeFinal = async (): Promise<void> => {
    await write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await write(reportPath, renderReport({ ...options.input, artifacts, ...(preview ? { preview } : {}) }));
    if (preview && previewPath) await write(previewPath, renderPreviewHtml(preview, new Set(snapshotRecords.map((record) => record.sourceId))));
  };
  if (!preview) {
    await writeFinal();
    return artifacts;
  }
  try {
    await writeFinal();
  } catch {
    throw new Error(PREVIEW_FINALIZE_FAILED);
  }
  return artifacts;
}

export async function writeCheckpointArtifacts(options: {
  cwd: string;
  runId: string;
  stage: CheckpointStage;
  input: ReportInput;
  writer?: FileWriter;
}): Promise<string> {
  const write = options.writer ?? atomicWrite;
  const evidenceDirectory = path.join(path.resolve(options.cwd), ".unshit", options.runId);
  const manifestPath = path.join(evidenceDirectory, "manifest.json");
  const snapshotRecords = await writeSourceSnapshots(evidenceDirectory, options.input.evidence, write);
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
    preview: options.input.preview,
  };
  await write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

type SnapshotRecord = { sourceId: string; path: string; sha256: string; byteCount: number };

// Writes the snapshot of each source, or of each source in `sourceIds`, from the bytes the host read (after redaction),
// inside the run directory. A source without bytes is skipped.
async function writeSourceSnapshots(evidenceDirectory: string, evidence: LoadedEvidence, write: FileWriter, sourceIds?: ReadonlySet<string>): Promise<SnapshotRecord[]> {
  const records: SnapshotRecord[] = [];
  for (const source of evidence.sources) {
    if (sourceIds && !sourceIds.has(source.id)) continue;
    const bytes = evidence.bytesBySourceId.get(source.id);
    if (!bytes) continue;
    const target = path.resolve(evidenceDirectory, source.snapshotPath);
    if (!target.startsWith(`${evidenceDirectory}${path.sep}`)) throw new Error("An evidence snapshot path escaped the run directory.");
    await write(target, bytes);
    records.push({ sourceId: source.id, path: source.snapshotPath, sha256: source.sha256, byteCount: bytes.byteLength });
  }
  return records;
}

// Writes one preview revision: first the snapshot of each source it lists that `published` does not hold yet, from the
// bytes the host read, then the page that links them. A listed source without bytes, or a failed snapshot write, fails
// before the page is replaced, so the page still shows the last revision that was written. `published` grows here.
export async function writePreviewRevision(options: {
  evidenceDirectory: string;
  preview: WorkflowPreview;
  evidence: LoadedEvidence;
  published: Set<string>;
  writer?: FileWriter;
}): Promise<string> {
  const write = options.writer ?? atomicWrite;
  const wanted = new Set(options.preview.references.filter((reference) => reference.kind === "source" && !options.published.has(reference.key)).map((reference) => reference.key));
  try {
    const known = new Set(options.evidence.sources.map((source) => source.id));
    for (const key of wanted) if (!known.has(key) || !options.evidence.bytesBySourceId.has(key)) throw new Error(PREVIEW_SOURCES_FAILED);
    const written = await writeSourceSnapshots(options.evidenceDirectory, options.evidence, write, wanted);
    for (const record of written) options.published.add(record.sourceId);
  } catch {
    throw new Error(PREVIEW_SOURCES_FAILED);
  }
  const pagePath = path.join(options.evidenceDirectory, "preview.html");
  try {
    await write(pagePath, renderPreviewHtml(options.preview, options.published));
  } catch {
    throw new Error(PREVIEW_SAVE_FAILED);
  }
  return pagePath;
}

export interface RunPublisher {
  run<T>(job: () => Promise<T>): Promise<T>;
  finalize<T>(job: () => Promise<T>): Promise<T>;
}

// The one writer of a run's preview pages, checkpoints and final artifacts. Jobs run one at a time in the order they
// were queued; a failed job rejects only its own caller. finalize closes the queue before it returns, so a later run()
// rejects with PUBLICATION_CLOSED, and its own job starts after every earlier job has settled.
export function createRunPublisher(): RunPublisher {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };
  return {
    run: (job) => closed ? Promise.reject(new Error(PUBLICATION_CLOSED)) : enqueue(job),
    finalize: (job) => {
      if (closed) return Promise.reject(new Error(PUBLICATION_CLOSED));
      closed = true;
      return enqueue(job);
    },
  };
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
