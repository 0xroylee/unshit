import { topologicalTasks } from "./model-schema.ts";
import { requirementLabel } from "./brief-approval.ts";
import { changedStages, previewStageTitle } from "./preview.ts";
import type { LoadedEvidence } from "./evidence.ts";
import type { ExistingCommand } from "./types.ts";
import type {
  BriefApproval,
  FinalSource,
  IntakeBrief,
  PlanDocument,
  PreviewClassification,
  PreviewReference,
  PreviewRelation,
  PreviewStageStatus,
  PreviewUse,
  RepositoryChoice,
  ResearchGap,
  ResearchSummary,
  ResolvedAnswer,
  ReviewResult,
  RunArtifacts,
  ValidationRecord,
  WorkflowPreview,
} from "./types.ts";
import { describeRequestFailure } from "./request-failure.ts";

export interface ReportInput {
  brief: IntakeBrief;
  initialBrief?: IntakeBrief;
  research?: ResearchSummary;
  resolvedAnswers: ResolvedAnswer[];
  briefApproval?: BriefApproval;
  plan: PlanDocument;
  sources: FinalSource[];
  evidence: LoadedEvidence;
  gaps: ResearchGap[];
  reviews: ReviewResult[];
  validationIssues: string[];
  validationHistory: ValidationRecord[];
  commands: ExistingCommand[];
  artifacts?: RunArtifacts;
  preview?: WorkflowPreview;
}

// The heading of the plan.md section that lists what the plan relies on and the host did not check. The unshit agent
// skill quotes it.
export const TRUSTED_SECTION_HEADING = "Trusted, not checked";

export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  const { brief, plan } = input;
  const sourceById = new Map(input.evidence.sources.map((source) => [source.id, source]));
  const excerptById = new Map(input.evidence.excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const commandById = new Map(input.commands.map((command) => [command.id, command]));

  lines.push(`# ${plan.title}`, "", `**Readiness: ${plan.readiness === "ready" ? "Ready" : "Draft"}**`, "", plan.summary, "");
  lines.push("This is a proposed implementation plan. The target application has not been changed, and its tests or scripts were not run.", "");

  if (input.artifacts) {
    lines.push(`Saved report: \`${input.artifacts.reportPath}\``, `Evidence manifest: \`${input.artifacts.manifestPath}\``, "");
  }

  lines.push("## Scope", "", `**Final plan scope.** ${plan.summary}`);
  if (input.briefApproval?.via === "answers_file") {
    // A run from an approved answers file had no intake turn, so there is no initial summary to show.
    lines.push(`**Approved brief (from the answers file).** ${brief.summary}`, "");
  } else {
    if (input.initialBrief) lines.push(`**Clarified brief (after material answers).** ${brief.summary}`);
    lines.push(`**Initial intake summary (before material answers and source review).** ${input.initialBrief?.summary ?? brief.summary}`, "");
  }
  if (input.resolvedAnswers.length > 0) {
    lines.push("## Confirmed decisions", "");
    for (const answer of input.resolvedAnswers) {
      lines.push(`- **${answer.question}** Why it mattered: ${answer.whyMaterial} Answer: ${answer.answer}`);
    }
    lines.push("");
  }
  if (brief.assumptions.length > 0) {
    lines.push("**Assumptions.**", "");
    for (const assumption of brief.assumptions) lines.push(`- ${assumption}`);
    lines.push("");
  }
  if (brief.outOfScope.length > 0) {
    lines.push("**Out of scope.**", "");
    for (const item of brief.outOfScope) lines.push(`- ${item}`);
    lines.push("");
  }
  lines.push("## Brief approval", "", briefApprovalText(input.briefApproval), "");

  lines.push("## Requirement map", "");
  if (plan.tasks.length === 0) {
    lines.push("Task generation is blocked by host validation. The task list is empty so no invalid dependency order is presented as ready work.", "");
  } else {
    const tasks = topologicalTasks(plan.tasks);
    for (const requirement of plan.requirements) {
      const related = tasks.filter((task) => task.requirementIds.includes(requirement.id));
      const taskIds = related.map((task) => task.id).join(", ") || "no task yet";
      lines.push(`- **${requirement.id}.** ${requirement.description} (${requirementLabel(requirement)}) → ${taskIds}`);
      for (const acceptance of requirement.observableAcceptance) {
        const coveredBy = related.flatMap((task) => task.acceptance.filter((item) => item.coversAcceptanceIds.includes(acceptance.id)).map((item) => task.id));
        const verifiedBy = related.flatMap((task) => task.verification.filter((method) => method.acceptanceIds.includes(acceptance.id)).map((method) => method.id));
        lines.push(`  - ${acceptance.id}: ${acceptance.description} → ${coveredBy.join(", ") || "uncovered"} → ${verifiedBy.join(", ") || "unverified"}`);
      }
    }
    lines.push("");
  }

  if (plan.tasks.length > 0) {
    lines.push("## Ordered tasks", "");
    for (const task of topologicalTasks(plan.tasks)) {
      const requirements = task.requirementIds.join(", ");
      const dependencies = task.dependencies.length ? task.dependencies.join(", ") : "none";
      lines.push(`### ${task.id}: ${task.title}`, "", task.description, "", `Requirements: ${requirements}`, `Depends on: ${dependencies}`, "", "Acceptance:", "");
      for (const acceptance of task.acceptance) {
        lines.push(`- [ ] ${acceptance.id} (${acceptance.requirementId}; covers ${acceptance.coversAcceptanceIds.join(", ")}): ${acceptance.condition}`);
      }
      lines.push("", "Proposed verification:", "");
      for (const method of task.verification) {
        const covers = method.acceptanceIds.join(", ");
        if (method.kind === "existing") {
          const command = commandById.get(method.commandId ?? "");
          const location = command ? sourceLocation(command.sourceId, command.line, command.line, input) : "source line unavailable";
          lines.push(`- ${method.id} checks ${covers}: ${method.description} Run existing command \`${method.command ?? command?.command ?? "command unavailable"}\` (${location}). This command was read, not run.`);
        } else if (method.kind === "to_create") {
          lines.push(`- ${method.id} checks ${covers}: ${method.description} Create and run \`${method.plannedCommand ?? "a project-appropriate test command"}\` as part of implementation.`);
        } else {
          lines.push(`- ${method.id} checks ${covers}: Manual check. ${method.description}`);
        }
        for (const mutant of method.rejectsMutants) {
          lines.push(`  - Must fail on ${mutant.id} (${mutant.acceptanceId}): ${mutant.wrongImplementation} Expected failure: ${mutant.observedFailure}`);
        }
      }
      lines.push("", "Done when: each wrong implementation named above, applied alone to the finished code, makes its check fail, while the unmodified code passes every check above. unshit has not applied any of them or run any check.");
      if (task.evidence.length > 0) {
        lines.push("", "Source basis:", "");
        for (const evidence of task.evidence) lines.push(`- ${evidence.claim} (${citation(evidence.excerptId, input, sourceById, excerptById)})`);
      }
      lines.push("");
    }
  }

  if (input.research) {
    const research = input.research;
    const bar = research.qualityBar;
    lines.push("## Reference research", "", `Quality bar: ${bar.requireLicense ? "license required" : "license optional"}; at least ${bar.minStars} stars; pushed within ${bar.maxMonthsSincePush} months; created at least ${bar.minAgeDays} days ago; not archived; not a fork${bar.requireTests ? "; test files required" : ""}.`);
    lines.push(`Search requests: GitHub ${research.searchRequests.github}/${research.searchRequests.budget}; GitLab ${research.searchRequests.gitlab}. Matched ${research.matched}; passed metadata bar ${research.passedMetadataBar}; tree-verified shortlist ${research.shortlisted}; selected ${research.selected}; host exclusions ${research.excluded}; tree resolutions ${research.treeResolutions}; rate limited ${research.rateLimited ? "yes" : "no"}.`);
    if (research.queries.length > 0) {
      lines.push("Queries:");
      for (const query of research.queries) {
        const label = query.provider === "gitlab" ? "gitlab fallback" : `github tier ${query.tier}`;
        const failure = query.failure ? ` (${describeRequestFailure(query.failure)})` : "";
        lines.push(`- ${label} \`${query.query}\` — ${query.status}${failure}; ${query.resultCount} result(s), ${query.newCandidates} new candidate(s).`);
      }
    }
    if (research.codeSearch) {
      const code = research.codeSearch;
      lines.push(`Code search (Grep by Vercel): ${code.requests}/${code.budget} request(s); ${code.repositoriesMatched} repositories matched outside example and documentation paths; ${code.repositoriesScreened} new repositories screened with ${code.metadataRequests} GitHub metadata request(s).`);
      for (const query of code.queries) {
        const scope = query.repository ? ` in ${query.repository}` : "";
        const failure = query.failure ? ` (${describeRequestFailure(query.failure)})` : "";
        lines.push(`- grep ${query.purpose} \`${query.query}\`${scope} — ${query.status}${failure}; ${query.resultCount} result(s).`);
      }
    }
    if (!research.trustworthyReferenceFound) {
      const noTrustGap = input.gaps.find((gap) => gap.message.startsWith("No trustworthy public reference repository was found"));
      lines.push(noTrustGap?.message ?? "No selected reference repository supplied production or test source to this plan.");
    }
    lines.push("");
  }

  if (plan.repositoryChoices.length > 0) {
    lines.push("## Repository screening", "");
    for (const choice of plan.repositoryChoices) {
      const label = `[${choice.provider}:${choice.repository}](${choice.webUrl})`;
      const signals = choice.signals
        ? ` Signals: ${choice.signals.stars === null ? "star count unavailable" : `${choice.signals.stars} stars`}; ${choice.signals.forks === null ? "fork count unavailable" : `${choice.signals.forks} forks`}; archived ${choice.signals.archived ?? "unknown"}; fork ${choice.signals.fork ?? "unknown"}; ${choice.signals.language ?? "language unknown"}; topics ${choice.signals.topics.join(", ") || "none"}; pushed ${choice.signals.pushedAt ?? "date unavailable"}; created ${choice.signals.createdAt ?? "date unavailable (age unknown)"}; license ${choice.signals.licenseSpdxId ?? "not reported"}${choice.licenseEvidence ? ` (${choice.licenseEvidence} evidence)` : ""}; ${choice.testFileCount === undefined ? "test count unknown" : `${choice.testFileCount} test files`}.`
        : "";
      const code = choice.codeMatches?.length ? ` Code search matched ${choice.codeMatches.map((pattern) => `\`${pattern}\``).join(", ")}.` : "";
      if (choice.decidedBy === "host") {
        lines.push(`- Host excluded ${label}. Reason: ${choice.rationale}${signals}${code}`);
      } else if (choice.outcome === "selected") {
        const commit = choice.commitSha ? `, inspected at \`${choice.commitSha}\`` : ", selected but its tree could not be read";
        const activity = choice.lastActivityAt ? `, last activity reported ${choice.lastActivityAt}` : "";
        const commitDate = choice.commitDate ? `, commit dated ${choice.commitDate}` : "";
        lines.push(`- Selected ${label}${commit}${commitDate}${activity}.${signals}${code} ${choice.rationale}`);
      } else {
        const activity = choice.lastActivityAt ? ` Search metadata reported last activity ${choice.lastActivityAt}.` : "";
        lines.push(`- Rejected ${label}.${activity}${signals}${code} ${choice.rationale}`);
      }
    }
    lines.push("");
  }

  if (plan.referenceComparisons.length > 0) {
    lines.push("## Reference comparison", "");
    for (const comparison of plan.referenceComparisons) {
      lines.push(`### ${comparison.provider}:${comparison.repository}`, "", `Commit: \`${comparison.commitSha}\`${comparison.commitDate ? `, dated ${comparison.commitDate}` : ""}${comparison.lastActivityAt ? `; last activity reported ${comparison.lastActivityAt}` : ""}`, `Selection reason: ${comparison.selectionRationale}`, "", "Patterns to adopt:", "");
      for (const pattern of comparison.adoptedPatterns) {
        const refs = pattern.evidence.map((evidence) => citation(evidence.excerptId, input, sourceById, excerptById));
        lines.push(`- ${pattern.pattern} (${refs.join("; ")})`);
        for (const test of pattern.testEvidence) lines.push(`  - Reference test (read, not run): ${test.claim} (${citation(test.excerptId, input, sourceById, excerptById)})`);
        if (pattern.untestedReason) lines.push(`  - No reference test: ${pattern.untestedReason}`);
      }
      lines.push("", "Patterns to reject:", "");
      for (const pattern of comparison.rejectedPatterns) {
        const refs = pattern.evidence.map((evidence) => citation(evidence.excerptId, input, sourceById, excerptById));
        lines.push(`- ${pattern.pattern}: ${pattern.reason}${refs.length ? ` (${refs.join("; ")})` : ""}`);
      }
      lines.push("", `Local adaptation: ${comparison.localAdaptation}`, "");
    }
  }

  if (plan.decisions.length > 0) {
    lines.push("## Design decisions", "");
    for (const decision of plan.decisions) {
      lines.push(`### ${decision.id}: ${decision.title}`, "", decision.decision, "", decision.rationale);
      if (decision.newDesignReason) lines.push("", `New design reason: ${decision.newDesignReason}`);
      for (const evidence of decision.evidence) lines.push(`- ${evidence.claim} (${citation(evidence.excerptId, input, sourceById, excerptById)})`);
      lines.push("");
    }
  }

  if (plan.risks.length > 0) {
    lines.push("## Risks and open evidence", "");
    for (const risk of plan.risks) {
      const refs = risk.evidence.map((evidence) => citation(evidence.excerptId, input, sourceById, excerptById));
      lines.push(`- ${risk.description}${refs.length ? ` (${refs.join("; ")})` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Architecture and data design", "", plan.design.architecture, "", "### Modules and interfaces", "");
  if (plan.design.modules.length === 0) lines.push("No module design passed host validation.", "");
  for (const module of plan.design.modules) {
    lines.push(`- **${module.name}:** ${module.responsibility}`);
    for (const api of module.interfaces) lines.push(`  - Interface: ${api}`);
    for (const evidence of module.evidence) lines.push(`  - Evidence: ${evidence.claim} (${citation(evidence.excerptId, input, sourceById, excerptById)})`);
    if (module.newDesignReason) lines.push(`  - New design reason: ${module.newDesignReason}`);
  }
  lines.push("", "### Data model", "");
  if (plan.design.dataModel.notApplicableReason) {
    lines.push(`Not applicable: ${plan.design.dataModel.notApplicableReason}`, "");
  } else {
    for (const entity of plan.design.dataModel.entities) {
      lines.push(`- **${entity.name}:** ${entity.fields.join(", ")}`);
      for (const evidence of entity.evidence) lines.push(`  - Evidence: ${evidence.claim} (${citation(evidence.excerptId, input, sourceById, excerptById)})`);
      if (entity.newDesignReason) lines.push(`  - New design reason: ${entity.newDesignReason}`);
    }
    lines.push("");
  }
  lines.push("### Invariants", "");
  if (plan.design.invariants.notApplicableReason) {
    lines.push(`Not applicable: ${plan.design.invariants.notApplicableReason}`, "");
  } else {
    for (const invariant of plan.design.invariants.items) {
      lines.push(`- ${invariant.statement}`);
      for (const evidence of invariant.evidence) lines.push(`  - Evidence: ${evidence.claim} (${citation(evidence.excerptId, input, sourceById, excerptById)})`);
      if (invariant.newDesignReason) lines.push(`  - New design reason: ${invariant.newDesignReason}`);
    }
    lines.push("");
  }
  lines.push("### Access control", "");
  if (plan.design.accessControl.notApplicableReason) {
    lines.push(`Not applicable: ${plan.design.accessControl.notApplicableReason}`, "");
  } else {
    for (const boundary of plan.design.accessControl.boundaries) {
      lines.push(`- **${boundary.boundary}:** ${boundary.behavior}`);
      for (const evidence of boundary.evidence) lines.push(`  - Evidence: ${evidence.claim} (${citation(evidence.excerptId, input, sourceById, excerptById)})`);
      if (boundary.newDesignReason) lines.push(`  - New design reason: ${boundary.newDesignReason}`);
    }
    lines.push("");
  }

  if (input.gaps.length > 0) {
    lines.push("## Evidence gaps", "");
    for (const gap of input.gaps) lines.push(`- ${gap.material ? "Material" : "Informational"} (${gap.kind}): ${gap.message}`);
    lines.push("");
  }

  if (plan.readinessNotes.length > 0) {
    lines.push("## Draft reasons", "");
    for (const note of plan.readinessNotes) lines.push(`- ${note}`);
    lines.push("");
  }

  if (input.validationHistory.length > 0 || input.validationIssues.length > 0) {
    lines.push("## Host validation and repair history", "");
    if (input.validationHistory.length > 0) {
      for (const entry of input.validationHistory) lines.push(`- ${entry.resolved ? "Resolved by bounded repair" : "Unresolved"}: ${entry.issue}`);
    } else {
      for (const issue of input.validationIssues) lines.push(`- Unresolved: ${issue}`);
    }
    lines.push("");
  }

  if (input.reviews.length > 0) {
    lines.push("## Independent review", "");
    for (const [index, review] of input.reviews.entries()) {
      lines.push(`Review ${index + 1}: ${review.findings.length} finding(s), ${review.survivingMutants.length} surviving mutant(s).`, "");
      for (const finding of review.findings) {
        const refs = finding.evidence.map((evidence) => citation(evidence.excerptId, input, sourceById, excerptById));
        lines.push(`- ${finding.severity}: ${finding.description}${finding.requirementIds.length ? ` (${finding.requirementIds.join(", ")})` : ""}${refs.length ? ` (${refs.join("; ")})` : ""} Correction: ${finding.suggestedCorrection}`);
      }
      for (const mutant of review.survivingMutants) {
        const decision = mutant.decisionNeeded ? ` Open decision: ${mutant.decisionNeeded}` : "";
        lines.push(`- surviving mutant for ${mutant.acceptanceId}: ${mutant.wrongImplementation} Planned checks would pass: ${mutant.whyPlannedChecksPass}${decision}`);
      }
      lines.push("");
    }
  }

  lines.push("## Checks performed", "", "The host read and hashed the listed source files and recorded the line range of every excerpt it cut. It checked that each cited excerpt ID is one it created and that each reference comparison cites only its own repository at the pinned commit, checked requirement and acceptance coverage, checked that existing verification commands come from local files it read, and checked that task dependencies exist and form no cycle. It checked that each verification names at least one wrong implementation for every acceptance criterion it covers, and that each reference test cited under an adopted pattern comes from a file it read as a test from that repository at the pinned commit. It did not check that an excerpt supports the claim next to it, and it did not run target project commands or tests.", "");
  lines.push(`## ${TRUSTED_SECTION_HEADING}`, "", ...trustedLines(input), "");
  if (input.preview) lines.push(...previewMarkdown(input.preview), "");
  lines.push("## Source registry", "");
  if (input.sources.length === 0) lines.push("No source snapshots were prepared.", "");
  for (const source of input.sources) {
    const excerpts = source.excerpts.map((excerpt) => `${excerpt.id} L${excerpt.startLine}-L${excerpt.endLine}`).join(", ") || "no excerpt sent to the model";
    const repo = source.repository ? `${source.provider}:${source.repository}@${source.commitSha}` : "local";
    const date = source.commitDate ? `; commit ${source.commitDate}` : "";
    const activity = source.lastActivityAt ? `; last activity ${source.lastActivityAt}` : "";
    const linked = source.permalink ? `[${source.path}](${source.permalink})` : `\`${source.path}\``;
    lines.push(`- ${source.id} ${repo}: ${linked}${date}${activity}; SHA-256 \`${source.sha256}\`; ${source.lineCount} lines; ${excerpts}. Snapshot: \`${source.snapshotPath}\`.`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// How the brief was approved, when the host recorded it, and the hash; or that no person approved it. Neither route
// tells the host who approved it.
function briefApprovalText(approval: BriefApproval | undefined): string {
  if (!approval) return "No person approved this brief before reference research, so the plan is Draft.";
  const source = approval.via === "tty"
    ? "Approved by a yes typed at the interactive terminal prompt; the host cannot tell who typed it"
    : "The answers file approved this brief (approveBrief was true); the host cannot tell who set it";
  return `${source}. Recorded ${approval.approvedAt}; brief SHA-256 \`${approval.briefSha256}\`.`;
}

// What the plan relies on that the host did not check: each selected comparator, the claims the model wrote next to
// citations, local sources without a commit, a review by the same model and the surviving mutants it reasons out, the
// named wrong implementations, the cited reference tests, and who approved the brief.
function trustedLines(input: ReportInput): string[] {
  const selected = input.plan.repositoryChoices.filter((choice) => choice.outcome === "selected");
  const lines = selected.length > 0
    ? selected.map((choice) => `- ${trustedComparator(choice, input.sources)}`)
    : ["- No reference repository was selected, so the plan has no reference repository behind it."];
  lines.push(
    "- The claim next to each citation is written by the model. The host checks only that the excerpt ID exists, and for a reference comparison that the excerpt comes from that repository at the pinned commit and, for a cited reference test, from a file it read as a test; it then shows the line range it recorded when it read the file.",
    "- Local sources are identified by the SHA-256 of the content this run read, taken after any redaction, not by a commit.",
    "- The independent review is the same model in a fresh session.",
    "- Surviving mutants, and the lack of them, are the reviewer model's reasoning: unshit applied and ran none of them, and a review that reports none does not show that the planned checks reject every wrong implementation.",
  );
  const mutants = input.plan.tasks.reduce((count, task) => count + task.verification.reduce((sum, method) => sum + method.rejectsMutants.length, 0), 0);
  if (mutants > 0) lines.push(`- The plan names ${mutants} wrong implementation(s) under its verification steps. The model wrote them, and unshit did not apply any of them or run any check.`);
  const testExcerptIds = input.plan.referenceComparisons.flatMap((comparison) => comparison.adoptedPatterns.flatMap((pattern) => pattern.testEvidence.map((test) => test.excerptId)));
  // A test excerpt cited more than once, under one pattern or several, counts once.
  const referenceTests = new Set(testExcerptIds).size;
  if (referenceTests > 0) lines.push(`- The plan cites ${referenceTests} distinct reference test excerpt(s) under adopted patterns. The host recognises a test file by its path name only; it read these at the pinned commit and ran none of them, and that each one exercises its pattern rests on the planner and the independent review.`);
  if (input.briefApproval) lines.push(input.briefApproval.via === "answers_file"
    ? "- The brief approval came from an answers file whose approveBrief was true; the host cannot tell who set it."
    : "- The brief approval is a yes typed at an interactive terminal prompt; the host takes it as the user's and cannot tell who typed it.");
  return lines;
}

function trustedComparator(choice: RepositoryChoice, sources: FinalSource[]): string {
  const signals = choice.signals;
  const stars = typeof signals?.stars === "number" ? `${signals.stars} stars` : "star count unknown";
  const activity = choice.provider === "gitlab" ? "last activity" : "last push";
  const pushed = signals?.pushedAt ? `${activity} ${signals.pushedAt.slice(0, 10)}` : `${activity} unknown`;
  const created = signals?.createdAt ? `created ${signals.createdAt.slice(0, 10)}` : "creation date unknown, and an unknown age passes the quality bar";
  const commit = choice.commitSha
    ? `The commit is the head of the default branch \`${choice.defaultBranch}\` when this run resolved it, not a release or tag.`
    : "No commit was resolved for it.";
  const read = sources.filter((source) => source.provider === choice.provider && source.repository === choice.repository);
  const production = read.filter((source) => source.roles.includes("production")).length;
  const tests = read.filter((source) => source.roles.includes("test")).length;
  const license = choice.licenseEvidence === "metadata"
    ? `License: ${signals?.licenseSpdxId}, as GitHub's SPDX metadata reports it.`
    : choice.licenseEvidence === "tree" && choice.licensePath
      ? `License: the root file \`${choice.licensePath}\`; the host did not identify which license it is.`
      : "License: no evidence recorded.";
  // The count comes from the tree listing the host received; a truncated listing is recorded as a separate gap.
  const testPaths = choice.testFileCount === undefined
    ? "The tree listing the host received had an unknown number of test-like path(s) by file name."
    : `The tree listing the host received had ${choice.testFileCount} test-like path(s) by file name; if the evidence gaps say that listing was truncated, this count is a lower bound.`;
  const gitlab = choice.provider === "gitlab" ? " GitLab search reports no archived or fork status, so the host checked neither; the search asked GitLab to leave out archived projects." : "";
  return `${choice.provider}:${choice.repository}@${choice.commitSha ?? "unresolved"}: ${stars}; ${pushed}; ${created}. ${commit} ${testPaths} The host read ${production} production file(s) and ${tests} test file(s) from it and ran none of them. ${license}${gitlab}`;
}

function citation(
  excerptId: string,
  input: ReportInput,
  sourceById: Map<string, LoadedEvidence["sources"][number]>,
  excerptById: Map<string, LoadedEvidence["excerpts"][number]>,
): string {
  const excerpt = excerptById.get(excerptId);
  if (!excerpt) return `${excerptId} (source unavailable)`;
  const source = sourceById.get(excerpt.sourceId);
  if (!source) return `${excerptId} (source unavailable)`;
  const finalSource = input.sources.find((entry) => entry.id === source.id);
  const lines = `L${excerpt.startLine}-L${excerpt.endLine}`;
  if (finalSource?.permalink) return `[${source.path} ${lines}](${finalSource.permalink}${lineAnchor(finalSource.provider, excerpt.startLine, excerpt.endLine)})`;
  return `\`${source.path}#${lines}\``;
}

function sourceLocation(sourceId: string, start: number, end: number, input: ReportInput): string {
  const source = input.sources.find((entry) => entry.id === sourceId);
  if (!source) return "source location unavailable";
  if (source.permalink) return `[${source.path}#L${start}-L${end}](${source.permalink}${lineAnchor(source.provider, start, end)})`;
  return `\`${source.path}#L${start}-L${end}\``;
}

function lineAnchor(provider: FinalSource["provider"], start: number, end: number): string {
  return provider === "gitlab" ? `#L${start}-${end}` : `#L${start}-L${end}`;
}

const PREVIEW_INTRO = "A search result is a discovery hint, not evidence. A listed commit or file was not read. Evidence is source the host read and hashed, or an excerpt it cut from that source.";
const PREVIEW_INTRO_ZH = "搜索结果只是线索，不是证据。列出的提交或文件没有读取。证据是 host 读取并计算了哈希的源码，或从中截取的片段。";

const STATUS_TEXT: Record<PreviewStageStatus, [string, string]> = {
  pending: ["Pending", "待执行"],
  waiting: ["Waiting for confirmation", "等待确认"],
  completed: ["Completed", "已完成"],
  skipped: ["Skipped", "已跳过"],
  failed: ["Failed", "失败"],
  stopped: ["Stopped", "已停止"],
};

const RELATION_TEXT: Record<PreviewRelation, [string, string]> = {
  found: ["Found by search", "搜索找到"],
  passed: ["Passed the metadata bar", "通过元数据门槛"],
  excluded: ["Excluded", "被排除"],
  ranked: ["Ranked for tree checks", "排入文件树检查"],
  tree_checked: ["Tree checked at a commit", "检查了固定提交的文件树"],
  selected: ["Selected", "选中"],
  rejected: ["Rejected", "未选中"],
  read: ["Read and hashed", "读取并计算哈希"],
  added: ["Added on request", "按请求补充"],
  supplied_to_model: ["Supplied to the model", "提供给模型"],
  cited: ["Cited by the model", "模型引用"],
};

const CLASSIFICATION_TEXT: Record<PreviewClassification, [string, string]> = {
  discovery: ["search result, not evidence", "搜索结果，不是证据"],
  listed: ["listed, not read", "已列出，未读取"],
  evidence: ["read by the host", "由 host 读取"],
};

const STATUS_MARKERS: Record<PreviewStageStatus, string> = {
  pending: "[  ]",
  waiting: "[..]",
  completed: "[ok]",
  skipped: "[skip]",
  failed: "[!]",
  stopped: "[stop]",
};

// The uses of a stage whose key the preview lists, grouped by relation in first-use order.
function relationGroups(uses: PreviewUse[], references: Map<string, PreviewReference>): Array<{ relation: PreviewRelation; rows: Array<{ use: PreviewUse; reference: PreviewReference }> }> {
  const groups = new Map<PreviewRelation, Array<{ use: PreviewUse; reference: PreviewReference }>>();
  for (const use of uses) {
    const reference = references.get(use.key);
    if (!reference) continue;
    groups.set(use.relation, [...(groups.get(use.relation) ?? []), { use, reference }]);
  }
  return [...groups].map(([relation, rows]) => ({ relation, rows }));
}

// Relations that the terminal gives only as a count on the stage line; the page and the plan list each reference.
const COUNTED_IN_TERMINAL = new Set<PreviewRelation>(["passed", "supplied_to_model"]);

// The terminal lines for the stages that changed since `previous`, or for every stage without it. Labels and notes
// lose control and bidirectional characters, so a file name cannot move the cursor or start a forged line.
export function renderPreviewText(preview: WorkflowPreview, previous?: WorkflowPreview): string {
  const references = new Map(preview.references.map((reference) => [reference.key, reference]));
  const lines = [`Reference preview, revision ${preview.revision}:`];
  for (const stage of changedStages(preview, previous)) {
    const groups = relationGroups(stage.uses, references);
    const counts = groups.map(({ relation, rows }) => `${relation} ${rows.length}`).join(", ");
    const empty = stage.status === "completed" || stage.status === "skipped" || stage.status === "failed" ? "; no references" : "";
    const offered = stage.offeredFiles === undefined ? "" : `; ${stage.offeredFiles} files offered to the model`;
    lines.push(`${STATUS_MARKERS[stage.status]} ${stage.id}: ${stage.status}${counts ? `; ${counts}` : empty}${offered}`);
    for (const { relation, rows } of groups) {
      if (COUNTED_IN_TERMINAL.has(relation)) continue;
      const excerpts = rows.filter(({ reference }) => reference.kind === "excerpt");
      if (excerpts.length > 0) lines.push(`    ${relation} excerpts: ${excerpts.map(({ reference }) => reference.key).join(", ")}`);
      for (const { use, reference } of rows) {
        if (reference.kind === "excerpt") continue;
        lines.push(`    ${relation} ${reference.key} ${terminalText(reference.label)} [${reference.classification}]${use.note ? ` (${terminalText(use.note)})` : ""}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}

// The plan.md section: every stage with its status, and each reference it used with the relation. Labels and notes are
// untrusted text, so each is one code span; links come only from host-built https URLs.
function previewMarkdown(preview: WorkflowPreview): string[] {
  const references = new Map(preview.references.map((reference) => [reference.key, reference]));
  const lines = ["## Stages and references", "", `Revision ${preview.revision} of the stage-and-reference preview; \`preview.html\` in the run folder shows the same revision. ${PREVIEW_INTRO}`, ""];
  for (const stage of preview.stages) {
    const groups = relationGroups(stage.uses, references);
    const offered = stage.offeredFiles === undefined ? "" : `; ${stage.offeredFiles} files offered to the model, not listed`;
    lines.push(`- **${previewStageTitle(stage.id).title}** (\`${stage.id}\`): ${STATUS_TEXT[stage.status][0].toLowerCase()}${groups.length === 0 ? "; no references" : ""}${offered}.`);
    for (const { relation, rows } of groups) {
      const label = RELATION_TEXT[relation][0];
      const excerpts = rows.filter(({ reference }) => reference.kind === "excerpt");
      if (excerpts.length > 0) lines.push(`  - ${label}, ${excerpts.length} excerpt(s): ${excerpts.map(({ reference }) => markdownCode(reference.key)).join(", ")}`);
      for (const { use, reference } of rows) {
        if (reference.kind === "excerpt") continue;
        const url = safePreviewUrl(reference.url);
        const shown = url ? `[${markdownCode(reference.label)}](<${url}>)` : markdownCode(reference.label);
        lines.push(`  - ${label}: ${markdownCode(reference.key)} ${shown} (${CLASSIFICATION_TEXT[reference.classification][0]})${use.note ? `; ${markdownCode(use.note)}` : ""}`);
      }
    }
  }
  return lines;
}

// One CommonMark code span of `value` on one line: the fence is one backtick longer than the longest run inside.
export function markdownCode(value: string): string {
  const text = terminalText(value);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const padded = text === "" || text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

// Only an absolute https URL without whitespace, quotes or angle brackets becomes a link.
function safePreviewUrl(url: string | undefined): string | undefined {
  return url && /^https:\/\/[^\s"'<>`\\]+$/.test(url) ? url : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function bilingual(english: string, chinese: string): string {
  return `<span lang="en">${escapeHtml(english)}</span> · <span lang="zh-CN">${escapeHtml(chinese)}</span>`;
}

function referenceAnchor(key: string): string {
  return `ref-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

// The page of one preview revision, readable from disk with no remote asset or script. A snapshot link appears only for
// a source whose file this run has written (`publishedSnapshots`); other links are host-built https URLs.
export function renderPreviewHtml(preview: WorkflowPreview, publishedSnapshots: ReadonlySet<string>): string {
  const references = new Map(preview.references.map((reference) => [reference.key, reference]));
  const waiting = preview.stages.some((stage) => stage.id === "preview_confirmation" && stage.status === "waiting");
  const stages = preview.stages.map((stage, index) => {
    const { title, titleZh } = previewStageTitle(stage.id);
    const [status, statusZh] = STATUS_TEXT[stage.status];
    const groups = relationGroups(stage.uses, references).map(({ relation, rows }) => {
      const [label, labelZh] = RELATION_TEXT[relation];
      const items = rows.map(({ use, reference }) => `<li><a href="#${referenceAnchor(reference.key)}"><code>${escapeHtml(reference.key)}</code></a> ${escapeHtml(reference.label)} <span class="tag">${bilingual(...CLASSIFICATION_TEXT[reference.classification])}</span>${use.note ? ` <span class="muted">${escapeHtml(use.note)}</span>` : ""}</li>`).join("");
      return `<details${rows.length <= 12 ? " open" : ""}><summary>${bilingual(label, labelZh)} (${rows.length})</summary><ul>${items}</ul></details>`;
    }).join("");
    const empty = groups ? "" : `<p class="muted">${stage.status === "pending" || stage.status === "waiting" ? bilingual("No references yet", "暂无参考") : bilingual("No references", "无参考")}</p>`;
    const offered = stage.offeredFiles === undefined ? "" : `<p class="muted">${bilingual(`${stage.offeredFiles} files offered to the model, not listed`, `提供给模型的文件 ${stage.offeredFiles} 个，未逐一列出`)}</p>`;
    return `<li class="stage" data-status="${stage.status}"><h2><span class="num">${String(index + 1).padStart(2, "0")}</span> ${bilingual(title, titleZh)} <code>${stage.id}</code></h2><p class="status">${bilingual(status, statusZh)}</p>${offered}${groups}${empty}</li>`;
  }).join("\n");
  const registry = preview.references.map((reference) => referenceDetails(reference, publishedSnapshots)).join("\n");
  const note = waiting
    ? `<p class="note">${bilingual("The run is waiting at this preview. Type yes in the terminal to continue; any other reply stops it.", "运行在此预览处等待。在终端输入 yes 继续；其他回答会停止运行。")}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>unshit: stages and references</title>
<link rel="icon" href="data:,">
<style>
:root { color-scheme: light dark; --bg: #ffffff; --text: #232327; --muted: #6e6e78; --line: #e0e0e4; --line-strong: #c3c3c9; --hi: #232327; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --text: #f0f0f3; --muted: #a1a1aa; --line: #27272a; --line-strong: #52525b; --hi: #fafafa; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 48px 24px 72px; }
h1 { font-size: 30px; font-weight: 650; letter-spacing: -0.015em; line-height: 1.2; margin: 0 0 12px; }
h2 { font-size: 16px; font-weight: 620; margin: 0; }
code, .num { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { font-size: 0.9em; overflow-wrap: anywhere; }
.num { font-size: 12px; color: var(--muted); }
.muted, .status, .tag, .lede { color: var(--muted); }
.lede { font-size: 15px; max-width: 720px; }
.status { margin: 2px 0 0; font-size: 14px; }
li.stage p.muted { margin: 4px 0 0; font-size: 14px; }
.tag { font-size: 13px; }
.note { border: 0.9px solid var(--line-strong); border-radius: 10px; padding: 12px 16px; font-size: 14px; }
ol.stages { list-style: none; margin: 32px 0 0; padding: 0; border-top: 0.9px solid var(--line); }
li.stage { border-bottom: 0.9px solid var(--line); padding: 16px 0; }
li.stage[data-status="waiting"] h2 { text-decoration: underline; text-decoration-thickness: 0.9px; text-underline-offset: 4px; }
details { margin: 8px 0 0; }
summary { cursor: pointer; font-size: 14px; }
ul { margin: 4px 0 0; padding-left: 20px; font-size: 14px; }
li { overflow-wrap: anywhere; }
a { color: inherit; }
a:focus-visible, summary:focus-visible { outline: 0.9px solid var(--hi); outline-offset: 2px; }
section.references { margin-top: 48px; }
.reference { border-bottom: 0.9px solid var(--line); padding: 8px 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: 14px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 820px) { main { padding: 32px 16px 56px; } dl { grid-template-columns: 1fr; } dd { margin-bottom: 6px; } }
</style>
</head>
<body>
<main>
<h1>${bilingual("Stages and references", "步骤与参考")}</h1>
<p class="lede">${bilingual(`Revision ${preview.revision}. ${PREVIEW_INTRO}`, `第 ${preview.revision} 版。${PREVIEW_INTRO_ZH}`)}</p>
${note}
<ol class="stages">
${stages}
</ol>
<section class="references">
<h2>${bilingual("References", "参考")} (${preview.references.length})</h2>
${registry}
</section>
</main>
</body>
</html>
`;
}

function referenceDetails(reference: PreviewReference, publishedSnapshots: ReadonlySet<string>): string {
  const rows: string[] = [];
  const row = (english: string, chinese: string, value: string): void => {
    rows.push(`<dt>${bilingual(english, chinese)}</dt><dd>${value}</dd>`);
  };
  row("Classification", "类别", bilingual(...CLASSIFICATION_TEXT[reference.classification]));
  if (reference.repository) row("Repository", "仓库", `${escapeHtml(reference.provider ?? "")}:${escapeHtml(reference.repository)}`);
  if (reference.commitSha) row("Commit", "提交", `<code>${escapeHtml(reference.commitSha)}</code>`);
  if (reference.path) row("Path", "路径", `<code>${escapeHtml(reference.path)}</code>`);
  if (reference.startLine !== undefined && reference.endLine !== undefined) row("Lines", "行", `L${reference.startLine}-L${reference.endLine}`);
  if (reference.sha256) row("SHA-256", "SHA-256", `<code>${escapeHtml(reference.sha256)}</code>`);
  if (reference.sourceKey) row("Source", "来源", `<a href="#${referenceAnchor(reference.sourceKey)}"><code>${escapeHtml(reference.sourceKey)}</code></a>`);
  const url = safePreviewUrl(reference.url);
  if (url) row("Link", "链接", `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
  if (reference.snapshotPath) {
    const local = publishedSnapshots.has(reference.key) && /^sources\/[A-Za-z0-9_-]+\.txt$/.test(reference.snapshotPath);
    row("Snapshot", "快照", local
      ? `<a href="${escapeHtml(reference.snapshotPath)}">${escapeHtml(reference.snapshotPath)}</a>`
      : `${escapeHtml(reference.snapshotPath)} (${bilingual("not written yet", "尚未写入")})`);
  }
  return `<div class="reference" id="${referenceAnchor(reference.key)}"><details><summary><code>${escapeHtml(reference.key)}</code> ${escapeHtml(reference.label)}</summary><dl>${rows.join("")}</dl></details></div>`;
}
