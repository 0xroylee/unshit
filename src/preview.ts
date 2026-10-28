import { encodeRepositoryPath } from "./github.ts";
import { sourceLocation } from "./evidence.ts";
import type {
  EvidenceExcerpt,
  EvidenceSource,
  PlanDocument,
  PreviewReference,
  PreviewRelation,
  PreviewStage,
  PreviewStageId,
  PreviewStageStatus,
  PreviewUse,
  RepositoryCandidate,
  RepositorySnapshot,
  ReviewResult,
  TreeFile,
  WorkflowPreview,
} from "./types.ts";

export const UNKNOWN_PREVIEW_REFERENCE = "Unknown preview reference.";
export const PREVIEW_DECLINED = "Reference preview was not confirmed. No downstream work started.";
export const PREVIEW_UNAVAILABLE = "Reference preview requires confirmation in an interactive terminal. No downstream work started.";
export const PREVIEW_SAVE_FAILED = "Could not save workflow preview.";
export const PREVIEW_SOURCES_FAILED = "Could not publish workflow preview sources.";
export const PREVIEW_FINALIZE_FAILED = "Could not finalize workflow preview artifacts.";
export const PUBLICATION_CLOSED = "Workflow preview publication is closed.";

// The stages of a run in run order, with their titles in English and simplified Chinese.
export const PREVIEW_STAGES: ReadonlyArray<{ id: PreviewStageId; title: string; titleZh: string }> = [
  { id: "intake", title: "Intake", titleZh: "需求提取" },
  { id: "answer_gate", title: "Material answers", titleZh: "关键问题的回答" },
  { id: "brief_rebuild", title: "Brief rebuild", titleZh: "重建 brief" },
  { id: "brief_approval", title: "Brief approval", titleZh: "核准 brief" },
  { id: "local_baseline", title: "Local baseline", titleZh: "本地项目基线" },
  { id: "repository_search", title: "Repository search", titleZh: "仓库搜索" },
  { id: "metadata_screening", title: "Metadata screening", titleZh: "元数据筛选" },
  { id: "preview_confirmation", title: "Preview confirmation", titleZh: "确认预览" },
  { id: "candidate_ranking", title: "Candidate ranking", titleZh: "候选排序" },
  { id: "repository_trees", title: "Commit-pinned tree checks", titleZh: "固定提交的文件树检查" },
  { id: "candidate_selection", title: "Comparator selection", titleZh: "选择参考仓库" },
  { id: "file_selection", title: "File selection", titleZh: "选择文件" },
  { id: "source_reads", title: "Source reads", titleZh: "读取源码" },
  { id: "evidence_requests", title: "Evidence requests", titleZh: "补充证据" },
  { id: "plan", title: "Plan and repair", titleZh: "计划与修补" },
  { id: "review", title: "Independent review", titleZh: "独立审查" },
  { id: "readiness", title: "Readiness", titleZh: "就绪判定" },
  { id: "save", title: "Save", titleZh: "保存" },
];

export interface PreviewRecorder {
  register(references: PreviewReference[]): void;
  has(key: string): boolean;
  setStatus(stage: PreviewStageId, status: PreviewStageStatus): void;
  setOfferedFiles(stage: PreviewStageId, count: number): void;
  record(stage: PreviewStageId, relation: PreviewRelation, keys: string[], notes?: ReadonlyMap<string, string>): void;
  snapshot(): WorkflowPreview;
}

// The preview state of one run. register keeps the first record of each key, so a later stage cannot change how an
// earlier one classified a reference. record replaces the keys that a stage uses in one relation, and every key must
// be registered. snapshot returns a detached copy; its revision grows by one after each change.
export function createPreviewRecorder(): PreviewRecorder {
  const registry = new Map<string, PreviewReference>();
  const statuses = new Map<PreviewStageId, PreviewStageStatus>();
  const offeredFiles = new Map<PreviewStageId, number>();
  const uses = new Map<PreviewStageId, Map<PreviewRelation, PreviewUse[]>>();
  let revision = 0;
  let changed = true;
  return {
    register(references) {
      for (const reference of references) if (!registry.has(reference.key)) registry.set(reference.key, { ...reference });
    },
    has: (key) => registry.has(key),
    setStatus(stage, status) {
      if ((statuses.get(stage) ?? "pending") === status) return;
      statuses.set(stage, status);
      changed = true;
    },
    setOfferedFiles(stage, count) {
      offeredFiles.set(stage, count);
      changed = true;
    },
    record(stage, relation, keys, notes = new Map()) {
      for (const key of keys) if (!registry.has(key)) throw new Error(UNKNOWN_PREVIEW_REFERENCE);
      const byRelation = uses.get(stage) ?? new Map<PreviewRelation, PreviewUse[]>();
      byRelation.set(relation, [...new Set(keys)].map((key) => {
        const note = notes.get(key);
        return note ? { relation, key, note } : { relation, key };
      }));
      uses.set(stage, byRelation);
      changed = true;
    },
    snapshot() {
      if (changed) {
        revision += 1;
        changed = false;
      }
      const stages: PreviewStage[] = PREVIEW_STAGES.map(({ id }) => {
        const offered = offeredFiles.get(id);
        return {
          id,
          status: statuses.get(id) ?? "pending",
          uses: [...(uses.get(id)?.values() ?? [])].flat().map((use) => ({ ...use })),
          ...(offered === undefined ? {} : { offeredFiles: offered }),
        };
      });
      const shown = new Set(stages.flatMap((stage) => stage.uses.map((use) => use.key)));
      for (const key of [...shown]) {
        const sourceKey = registry.get(key)?.sourceKey;
        if (sourceKey) shown.add(sourceKey);
      }
      const references = [...registry.values()].filter((reference) => shown.has(reference.key)).map((reference) => ({ ...reference }));
      return { revision, stages, references };
    },
  };
}

export function previewStageTitle(id: PreviewStageId): { title: string; titleZh: string } {
  return PREVIEW_STAGES.find((stage) => stage.id === id) ?? { title: id, titleZh: id };
}

// The stages of `preview` whose status, references or notes differ from `previous`; every stage without `previous`.
export function changedStages(preview: WorkflowPreview, previous?: WorkflowPreview): PreviewStage[] {
  if (!previous) return preview.stages;
  const before = new Map(previous.stages.map((stage) => [stage.id, stageSignature(stage)]));
  return preview.stages.filter((stage) => before.get(stage.id) !== stageSignature(stage));
}

function stageSignature(stage: PreviewStage): string {
  return JSON.stringify([stage.status, stage.offeredFiles ?? null, stage.uses.map((use) => [use.relation, use.key, use.note ?? ""])]);
}

export function candidateReference(candidate: RepositoryCandidate): PreviewReference {
  return {
    key: candidate.id,
    kind: "repository",
    classification: "discovery",
    label: `${candidate.provider}:${candidate.fullName}`,
    provider: candidate.provider,
    repository: candidate.fullName,
    url: candidate.webUrl,
  };
}

export function commitKey(snapshot: RepositorySnapshot): string {
  return `${snapshot.candidate.id}@${snapshot.commitSha.slice(0, 12)}`;
}

export function commitReference(snapshot: RepositorySnapshot): PreviewReference {
  const { candidate } = snapshot;
  return {
    key: commitKey(snapshot),
    kind: "commit",
    classification: "listed",
    label: `${candidate.provider}:${candidate.fullName}@${snapshot.commitSha.slice(0, 12)}`,
    provider: candidate.provider,
    repository: candidate.fullName,
    commitSha: snapshot.commitSha,
    url: repositoryUrl(snapshot, "tree", ""),
  };
}

// A file of the local project or of a commit-pinned tree, listed but not read.
export function fileReference(file: TreeFile, snapshot?: RepositorySnapshot): PreviewReference {
  if (!snapshot) return { key: file.id, kind: "file", classification: "listed", label: file.path, provider: "local", path: file.path };
  const { candidate } = snapshot;
  return {
    key: file.id,
    kind: "file",
    classification: "listed",
    label: `${candidate.provider}:${candidate.fullName}@${snapshot.commitSha.slice(0, 12)} ${file.path}`,
    provider: candidate.provider,
    repository: candidate.fullName,
    commitSha: snapshot.commitSha,
    path: file.path,
    url: repositoryUrl(snapshot, "blob", file.path),
  };
}

// The sources the host read and the excerpts it cut from them.
export function evidenceReferences(evidence: { sources: EvidenceSource[]; excerpts: EvidenceExcerpt[] }): PreviewReference[] {
  const sourceById = new Map(evidence.sources.map((source) => [source.id, source]));
  return [
    ...evidence.sources.map(sourceReference),
    ...evidence.excerpts.flatMap((excerpt) => {
      const source = sourceById.get(excerpt.sourceId);
      return source ? [excerptReference(excerpt, source)] : [];
    }),
  ];
}

function sourceReference(source: EvidenceSource): PreviewReference {
  return {
    key: source.id,
    kind: "source",
    classification: "evidence",
    label: source.kind === "remote" ? `${source.provider}:${source.repository}@${source.commitSha?.slice(0, 12)} ${source.path}` : source.path,
    provider: source.kind === "remote" ? source.provider : "local",
    ...(source.repository ? { repository: source.repository } : {}),
    ...(source.commitSha ? { commitSha: source.commitSha } : {}),
    path: source.path,
    ...(source.permalink ? { url: source.permalink } : {}),
    sha256: source.sha256,
    snapshotPath: source.snapshotPath,
  };
}

function excerptReference(excerpt: EvidenceExcerpt, source: EvidenceSource): PreviewReference {
  return {
    key: excerpt.id,
    kind: "excerpt",
    classification: "evidence",
    label: `${source.path} L${excerpt.startLine}-L${excerpt.endLine}`,
    provider: source.kind === "remote" ? source.provider : "local",
    ...(source.repository ? { repository: source.repository } : {}),
    ...(source.commitSha ? { commitSha: source.commitSha } : {}),
    path: source.path,
    ...(source.permalink ? { url: sourceLocation(source, excerpt.startLine, excerpt.endLine) } : {}),
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
    sourceKey: source.id,
  };
}

function repositoryUrl(snapshot: RepositorySnapshot, view: "tree" | "blob", filePath: string): string {
  const repository = encodeRepositoryPath(snapshot.candidate.fullName);
  const suffix = filePath ? `/${encodeRepositoryPath(filePath)}` : "";
  if (snapshot.candidate.provider === "gitlab") return `https://gitlab.com/${repository}/-/${view}/${snapshot.commitSha}${suffix}`;
  return `https://github.com/${repository}/${view}/${snapshot.commitSha}${suffix}`;
}

// The excerpt IDs that a plan cites anywhere, in first-cited order.
export function planCitations(plan: PlanDocument): string[] {
  const refs = [
    ...plan.tasks.flatMap((task) => task.evidence),
    ...plan.decisions.flatMap((decision) => decision.evidence),
    ...plan.design.modules.flatMap((module) => module.evidence),
    ...plan.design.dataModel.entities.flatMap((entity) => entity.evidence),
    ...plan.design.invariants.items.flatMap((item) => item.evidence),
    ...plan.design.accessControl.boundaries.flatMap((boundary) => boundary.evidence),
    ...plan.referenceComparisons.flatMap((comparison) => [
      ...comparison.adoptedPatterns.flatMap((pattern) => [...pattern.evidence, ...pattern.testEvidence]),
      ...comparison.rejectedPatterns.flatMap((pattern) => pattern.evidence),
    ]),
    ...plan.risks.flatMap((risk) => risk.evidence),
  ];
  return [...new Set(refs.map((ref) => ref.excerptId))];
}

export function reviewCitations(reviews: ReviewResult[]): string[] {
  return [...new Set(reviews.flatMap((review) => review.findings.flatMap((finding) => finding.evidence.map((ref) => ref.excerptId))))];
}
