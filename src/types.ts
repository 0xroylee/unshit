export type Readiness = "ready" | "draft";

export interface AcceptanceCriterion {
  id: string;
  description: string;
}

// Host decided: "stated" when the user's requirement or a confirmed answer contains the requirement's userWords.
export type RequirementOrigin = "stated" | "inferred";

export interface Requirement {
  id: string;
  description: string;
  observableAcceptance: AcceptanceCriterion[];
  // The user's own words that state the requirement, NFKC- and whitespace-normalized; only when origin is "stated".
  userWords?: string;
  origin: RequirementOrigin;
}

export interface MaterialQuestion {
  id: string;
  question: string;
  whyMaterial: string;
}

export type RequestEndpoint = "search" | "commit" | "tree" | "source";
export type RequestFailureCategory =
  | "http_status"
  | "rate_limit"
  | "timeout"
  | "size_limit"
  | "invalid_json"
  | "invalid_response"
  | "network"
  | "cancelled"
  | "request_budget"
  | "invalid_request"
  | "internal";

// The first check that a Grep search body failed: no readable JSON-RPC response, a JSON-RPC error, a tool error, or
// a result with neither a hit nor the no-results message.
export type GrepResponseProblem = "not_json_rpc" | "rpc_error" | "tool_error" | "no_hits";

export interface RequestFailure {
  provider: "github" | "gitlab" | "grep";
  endpoint: RequestEndpoint;
  category: RequestFailureCategory;
  status?: number;
  limitBytes?: number;
  page?: number;
  // Only on a Grep invalid_response: the failed check, the media type (not_json_rpc) and the error code (rpc_error).
  responseProblem?: GrepResponseProblem;
  contentType?: string;
  rpcErrorCode?: number;
  attempts: number;
  retryRefused: boolean;
}

export interface ResolvedAnswer {
  questionId: string;
  question: string;
  whyMaterial: string;
  answer: string;
}

// A person's approval of the final brief before reference research. briefSha256 hashes the brief's editable form
// (src/brief-approval.ts). approvedAt is when the host recorded the approval: the reply at the terminal, or the read of
// an answers file whose approveBrief was true.
export interface BriefApproval {
  briefSha256: string;
  via: "tty" | "answers_file";
  approvedAt: string;
}

// The brief of an answers file whose approveBrief is true, after the host checked it again like intake output.
export interface ApprovedBrief {
  brief: IntakeBrief;
  resolvedAnswers: ResolvedAnswer[];
  approval: BriefApproval;
}

export interface IntakeBrief {
  summary: string;
  requirements: Requirement[];
  outOfScope: string[];
  assumptions: string[];
  materialQuestions: MaterialQuestion[];
  researchQueries: string[];
  domainTerms: string[];
  topicSlugs: string[];
  codePatterns?: string[];
}

export interface RepositoryQualitySignals {
  stars: number | null;
  forks: number | null;
  archived: boolean | null;
  fork: boolean | null;
  licenseSpdxId: string | null;
  language: string | null;
  topics: string[];
  pushedAt: string | null;
  createdAt: string | null;
}

export type LicenseEvidence = "metadata" | "tree" | "none";

export interface QualityBar {
  minStars: number;
  maxMonthsSincePush: number;
  minAgeDays: number;
  requireTests: boolean;
  requireLicense: boolean;
}

export interface SearchQueryRecord {
  provider: "github" | "gitlab";
  // GitLab fallback keeps tier 2 as the required manifest sentinel; it is not a widening tier.
  tier: 0 | 1 | 2;
  query: string;
  status: "ok" | "failed" | "rate_limited" | "skipped";
  resultCount: number;
  newCandidates: number;
  failure?: RequestFailure;
}

export interface CodePatternMatch {
  pattern: string;
  path: string;
}

export interface CodeMatch {
  fileId: string;
  path: string;
  patterns: string[];
}

export interface CodeSearchQueryRecord {
  provider: "grep";
  purpose: "discovery" | "location";
  query: string;
  repository?: string;
  status: "ok" | "failed" | "rate_limited" | "skipped";
  resultCount: number;
  failure?: RequestFailure;
}

export interface CodeSearchSummary {
  queries: CodeSearchQueryRecord[];
  requests: number;
  budget: number;
  repositoriesMatched: number;
  repositoriesScreened: number;
  metadataRequests: number;
}

export interface ResearchSummary {
  queries: SearchQueryRecord[];
  searchRequests: { github: number; gitlab: number; budget: number };
  treeResolutions: number;
  qualityBar: QualityBar;
  matched: number;
  passedMetadataBar: number;
  // Repositories that passed the commit-pinned tree checks.
  shortlisted: number;
  // Comparators the model selected from the tree-verified shortlist.
  selected: number;
  excluded: number;
  rateLimited: boolean;
  // True only when a selected comparator supplied production or test source excerpts to the plan.
  trustworthyReferenceFound: boolean;
  codeSearch?: CodeSearchSummary;
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
  signals?: RepositoryQualitySignals;
  searchRank?: number;
  matchedQueries?: string[];
  codeMatches?: CodePatternMatch[];
}

export interface RepositorySnapshot {
  candidate: RepositoryCandidate;
  commitSha: string;
  commitDate?: string;
  treeTruncated: boolean;
  files: TreeFile[];
  testFileCount?: number;
  licensePath?: string;
  codeMatches?: CodeMatch[];
}

export interface TreeFile {
  id: string;
  path: string;
  size: number | null;
}

export type SelectedFileRole = "production" | "test" | "manifest" | "ci" | "license" | "config";

// A piece of source that the model asks for after reading the first excerpts. `definition` names something that the
// source `id` defines; `lines` is a 1-based line range of source `id`; `file` is an unread file with file ID `id`.
export interface EvidenceRequest {
  kind: "definition" | "lines" | "file";
  id: string;
  name: string;
  startLine: number;
  endLine: number;
  reason: string;
}

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

// A wrong implementation that a planned check must reject, and the failure the check reports on it. The host assigns
// the ID (T1-V1-M1). unshit never applies these mutants or runs the check; they are for the implementer's mutation runner.
export interface PlannedMutant {
  id: string;
  acceptanceId: string;
  wrongImplementation: string;
  observedFailure: string;
}

export interface VerificationMethod {
  id: string;
  kind: VerificationKind;
  acceptanceIds: string[];
  description: string;
  commandId?: string;
  command?: string;
  commandSource?: { sourceId: string; line: number };
  plannedCommand?: string;
  rejectsMutants: PlannedMutant[];
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
  decidedBy?: "host" | "model";
  signals?: RepositoryQualitySignals;
  treeFileCount?: number;
  testFileCount?: number;
  licenseEvidence?: LicenseEvidence;
  licensePath?: string;
  codeMatches?: string[];
}

export interface ReferenceComparison {
  candidateId: string;
  provider: "github" | "gitlab";
  repository: string;
  commitSha: string;
  commitDate?: string;
  lastActivityAt?: string;
  selectionRationale: string;
  // testEvidence cites the comparator's own tests that exercise the pattern (read, not run); untestedReason says why
  // no read test does. Exactly one of the two is present.
  adoptedPatterns: Array<{ pattern: string; evidence: EvidenceRef[]; testEvidence: EvidenceRef[]; untestedReason?: string }>;
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

// A wrong implementation of one acceptance criterion that every planned check for it would still pass, in the
// reviewer's reading. decisionNeeded names the business choice that would rule it out; the planner may not make it.
export interface SurvivingMutant {
  acceptanceId: string;
  wrongImplementation: string;
  whyPlannedChecksPass: string;
  decisionNeeded?: string;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  survivingMutants: SurvivingMutant[];
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

export type CheckpointStage = "evidence" | "plan" | "interrupted" | "timed_out" | "failed" | "needs_input";

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
  | { status: "needs_input"; questions: MaterialQuestion[]; brief: IntakeBrief; answersFile?: string; checkpointPath?: string; approvalRequested?: boolean; resolvedAnswers?: ResolvedAnswer[] }
  | { status: "completed"; readiness: Readiness; brief: IntakeBrief; initialBrief?: IntakeBrief; research?: ResearchSummary; resolvedAnswers: ResolvedAnswer[]; briefApproval?: BriefApproval; answersFile?: string; plan: PlanDocument; sources: FinalSource[]; gaps: ResearchGap[]; reviews: ReviewResult[]; artifacts?: RunArtifacts; validationIssues: string[]; validationHistory: ValidationRecord[] }
  | { status: "interrupted"; message: string; checkpointPath?: string }
  | { status: "timed_out"; message: string; stage: string; limit: "idle" | "total"; limitSeconds: number; checkpointPath?: string }
  | { status: "error"; message: string; checkpointPath?: string };
