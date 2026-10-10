export type Readiness = "ready" | "draft";

export interface AcceptanceCriterion {
  id: string;
  description: string;
}

export interface Requirement {
  id: string;
  description: string;
  observableAcceptance: AcceptanceCriterion[];
}

export interface MaterialQuestion {
  id: string;
  question: string;
  whyMaterial: string;
}

export interface ResolvedAnswer {
  questionId: string;
  question: string;
  whyMaterial: string;
  answer: string;
}

export interface IntakeBrief {
  summary: string;
  requirements: Requirement[];
  outOfScope: string[];
  assumptions: string[];
  materialQuestions: MaterialQuestion[];
  researchQueries: string[];
}

export interface RepositoryCandidate {
  id: string;
  provider: "github" | "gitlab";
  fullName: string;
  description: string;
  defaultBranch: string;
  webUrl: string;
  lastActivityAt?: string;
  providerProjectId?: string;
}

export interface RepositorySnapshot {
  candidate: RepositoryCandidate;
  commitSha: string;
  commitDate?: string;
  treeTruncated: boolean;
  files: TreeFile[];
}

export interface TreeFile {
  id: string;
  path: string;
  size: number | null;
}

export type SelectedFileRole = "production" | "test" | "manifest" | "ci" | "license" | "config";

export interface SelectedFile {
  fileId: string;
  role: SelectedFileRole;
  rationale: string;
}

export interface EvidenceSource {
  id: string;
  kind: "local" | "remote";
  path: string;
  sha256: string;
  lineCount: number;
  byteCount: number;
  provider?: "github" | "gitlab";
  repository?: string;
  commitSha?: string;
  commitDate?: string;
  lastActivityAt?: string;
  permalink?: string;
  snapshotPath: string;
  roles: SelectedFileRole[];
}

export interface EvidenceExcerpt {
  id: string;
  sourceId: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface EvidenceRef {
  excerptId: string;
  claim: string;
}

export interface TaskAcceptance {
  id: string;
  requirementId: string;
  coversAcceptanceIds: string[];
  condition: string;
}

export type VerificationKind = "existing" | "to_create" | "manual";

export interface VerificationMethod {
  id: string;
  kind: VerificationKind;
  acceptanceIds: string[];
  description: string;
  commandId?: string;
  command?: string;
  commandSource?: { sourceId: string; line: number };
  plannedCommand?: string;
}

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  requirementIds: string[];
  dependencies: string[];
  acceptance: TaskAcceptance[];
  verification: VerificationMethod[];
  evidence: EvidenceRef[];
}

export interface DesignDecision {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  evidence: EvidenceRef[];
  newDesignReason?: string;
}

export interface PlanModule {
  name: string;
  responsibility: string;
  interfaces: string[];
  evidence: EvidenceRef[];
  newDesignReason?: string;
}

export interface PlanDesign {
  architecture: string;
  modules: PlanModule[];
  dataModel: {
    entities: Array<{ name: string; fields: string[]; evidence: EvidenceRef[]; newDesignReason?: string }>;
    notApplicableReason?: string;
  };
  invariants: {
    items: Array<{ statement: string; evidence: EvidenceRef[]; newDesignReason?: string }>;
    notApplicableReason?: string;
  };
  accessControl: {
    boundaries: Array<{ boundary: string; behavior: string; evidence: EvidenceRef[]; newDesignReason?: string }>;
    notApplicableReason?: string;
  };
}

export interface RepositoryChoice {
  candidateId: string;
  provider: "github" | "gitlab";
  repository: string;
  outcome: "selected" | "rejected";
  rationale: string;
  webUrl: string;
  defaultBranch: string;
  lastActivityAt?: string;
  commitSha?: string;
  commitDate?: string;
}

export interface ReferenceComparison {
  candidateId: string;
  provider: "github" | "gitlab";
  repository: string;
  commitSha: string;
  commitDate?: string;
  lastActivityAt?: string;
  selectionRationale: string;
  adoptedPatterns: Array<{ pattern: string; evidence: EvidenceRef[] }>;
  rejectedPatterns: Array<{ pattern: string; reason: string; evidence: EvidenceRef[] }>;
  localAdaptation: string;
}

export interface PlanDocument {
  title: string;
  summary: string;
  requirements: Requirement[];
  tasks: PlanTask[];
  decisions: DesignDecision[];
  design: PlanDesign;
  repositoryChoices: RepositoryChoice[];
  referenceComparisons: ReferenceComparison[];
  risks: Array<{ description: string; evidence: EvidenceRef[] }>;
  readiness: Readiness;
  readinessNotes: string[];
}

export interface ReviewFinding {
  severity: "blocking" | "material" | "minor";
  description: string;
  requirementIds: string[];
  evidence: EvidenceRef[];
  suggestedCorrection: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
}

export interface ExistingCommand {
  id: string;
  command: string;
  sourceId: string;
  line: number;
}

export interface ResearchGap {
  kind: "search" | "repository" | "tree" | "file" | "local" | "protocol" | "review" | "validation";
  message: string;
  material: boolean;
}

export interface ProgressEvent {
  stage: string;
  state: "started" | "completed" | "skipped" | "warning";
  message: string;
}

export interface FinalSource {
  id: string;
  kind: EvidenceSource["kind"];
  path: string;
  location: string;
  snapshotPath: string;
  sha256: string;
  lineCount: number;
  byteCount: number;
  repository?: string;
  commitSha?: string;
  commitDate?: string;
  lastActivityAt?: string;
  permalink?: string;
  provider?: "github" | "gitlab";
  roles: SelectedFileRole[];
  excerpts: Array<{ id: string; startLine: number; endLine: number }>;
}

export interface RunArtifacts {
  reportPath: string;
  evidenceDirectory: string;
  manifestPath: string;
}

export interface ValidationRecord {
  issue: string;
  resolved: boolean;
}

export type RunOutcome =
  | { status: "needs_input"; questions: MaterialQuestion[]; brief: IntakeBrief; answersFile?: string; checkpointPath?: string }
  | { status: "completed"; readiness: Readiness; brief: IntakeBrief; resolvedAnswers: ResolvedAnswer[]; plan: PlanDocument; sources: FinalSource[]; gaps: ResearchGap[]; reviews: ReviewResult[]; artifacts?: RunArtifacts; validationIssues: string[]; validationHistory: ValidationRecord[] }
  | { status: "interrupted"; message: string; checkpointPath?: string }
  | { status: "error"; message: string; checkpointPath?: string };
