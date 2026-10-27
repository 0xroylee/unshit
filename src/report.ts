import { MIN_QUOTE_CODE_POINTS, QUOTE_MAX, topologicalTasks } from "./model-schema.ts";
import { requirementLabel } from "./brief-approval.ts";
import type { LoadedEvidence } from "./evidence.ts";
import type { ExistingCommand } from "./types.ts";
import type { BriefApproval, FinalSource, IntakeBrief, PlanDocument, QuotedEvidenceRef, RepositoryChoice, ResearchGap, ResearchSummary, ResolvedAnswer, ReviewResult, RunArtifacts, ValidationRecord } from "./types.ts";
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
        for (const evidence of task.evidence) lines.push(`- ${evidence.claim} (${quotedCitation(evidence, input, sourceById, excerptById)})`);
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
        const refs = pattern.evidence.map((evidence) => quotedCitation(evidence, input, sourceById, excerptById));
        lines.push(`- ${pattern.pattern} (${refs.join("; ")})`);
        for (const test of pattern.testEvidence) lines.push(`  - Reference test (read, not run): ${test.claim} (${quotedCitation(test, input, sourceById, excerptById)})`);
        if (pattern.untestedReason) lines.push(`  - No reference test: ${pattern.untestedReason}`);
      }
      lines.push("", "Patterns to reject:", "");
      for (const pattern of comparison.rejectedPatterns) {
        const refs = pattern.evidence.map((evidence) => quotedCitation(evidence, input, sourceById, excerptById));
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
      for (const evidence of decision.evidence) lines.push(`- ${evidence.claim} (${quotedCitation(evidence, input, sourceById, excerptById)})`);
      lines.push("");
    }
  }

  if (plan.risks.length > 0) {
    lines.push("## Risks and open evidence", "");
    for (const risk of plan.risks) {
      const refs = risk.evidence.map((evidence) => quotedCitation(evidence, input, sourceById, excerptById));
      lines.push(`- ${risk.description}${refs.length ? ` (${refs.join("; ")})` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Architecture and data design", "", plan.design.architecture, "", "### Modules and interfaces", "");
  if (plan.design.modules.length === 0) lines.push("No module design passed host validation.", "");
  for (const module of plan.design.modules) {
    lines.push(`- **${module.name}:** ${module.responsibility}`);
    for (const api of module.interfaces) lines.push(`  - Interface: ${api}`);
    for (const evidence of module.evidence) lines.push(`  - Evidence: ${evidence.claim} (${quotedCitation(evidence, input, sourceById, excerptById)})`);
    if (module.newDesignReason) lines.push(`  - New design reason: ${module.newDesignReason}`);
  }
  lines.push("", "### Data model", "");
  if (plan.design.dataModel.notApplicableReason) {
    lines.push(`Not applicable: ${plan.design.dataModel.notApplicableReason}`, "");
  } else {
    for (const entity of plan.design.dataModel.entities) {
      lines.push(`- **${entity.name}:** ${entity.fields.join(", ")}`);
      for (const evidence of entity.evidence) lines.push(`  - Evidence: ${evidence.claim} (${quotedCitation(evidence, input, sourceById, excerptById)})`);
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
      for (const evidence of invariant.evidence) lines.push(`  - Evidence: ${evidence.claim} (${quotedCitation(evidence, input, sourceById, excerptById)})`);
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
      for (const evidence of boundary.evidence) lines.push(`  - Evidence: ${evidence.claim} (${quotedCitation(evidence, input, sourceById, excerptById)})`);
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

  lines.push("## Checks performed", "", `The host read and hashed the listed source files and recorded the line range of every excerpt it cut. It checked that each cited excerpt ID is one it created and that each reference comparison cites only its own repository at the pinned commit, checked requirement and acceptance coverage, checked that existing verification commands come from local files it read, and checked that task dependencies exist and form no cycle. It checked that each verification names at least one wrong implementation for every acceptance criterion it covers, that each reference test cited under an adopted pattern comes from a file it read as a test from that repository at the pinned commit, and that a pattern citing a reference test also cites an excerpt of a file it read as production from that repository. It checked that the quote of each plan citation, after NFKC and whitespace normalization, has ${MIN_QUOTE_CODE_POINTS} to ${QUOTE_MAX} characters (counted as Unicode code points) and appears in the lines of the excerpt it cites, and it marks each citation whose quote it did not count as found. It did not check that a quote or its excerpt supports the claim next to it, or that a cited test exercises the production code cited with it, and it did not run target project commands or tests.`, "");
  lines.push(`## ${TRUSTED_SECTION_HEADING}`, "", ...trustedLines(input), "");
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
    "- The claim next to each citation is written by the model. The host checks only that the excerpt ID exists, that the quote of a plan citation appears in that excerpt, and for a reference comparison that the excerpt comes from that repository at the pinned commit and, for a cited reference test, from a file it read as a test, with an excerpt of a file it read as production cited by the same pattern; it then shows the line range it recorded when it read the file. That the quoted text supports the claim rests on the planner and the independent review.",
    "- Local sources are identified by the SHA-256 of the content this run read, taken after any redaction, not by a commit.",
    "- The independent review is the same model in a fresh session.",
    "- Surviving mutants, and the lack of them, are the reviewer model's reasoning: unshit applied and ran none of them, and a review that reports none does not show that the planned checks reject every wrong implementation.",
  );
  const mutants = input.plan.tasks.reduce((count, task) => count + task.verification.reduce((sum, method) => sum + method.rejectsMutants.length, 0), 0);
  if (mutants > 0) lines.push(`- The plan names ${mutants} wrong implementation(s) under its verification steps. The model wrote them, and unshit did not apply any of them or run any check.`);
  const testExcerptIds = input.plan.referenceComparisons.flatMap((comparison) => comparison.adoptedPatterns.flatMap((pattern) => pattern.testEvidence.map((test) => test.excerptId)));
  // A test excerpt cited more than once, under one pattern or several, counts once.
  const referenceTests = new Set(testExcerptIds).size;
  if (referenceTests > 0) lines.push(`- The plan cites ${referenceTests} distinct reference test excerpt(s) under adopted patterns. The host recognises a test file by its path name only; it read these at the pinned commit and ran none of them, and that each one exercises the production excerpts cited with it rests on the planner and the independent review.`);
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

// A plan citation and its quote, or why the host did not count the quote as found in the cited excerpt.
function quotedCitation(
  ref: QuotedEvidenceRef,
  input: ReportInput,
  sourceById: Map<string, LoadedEvidence["sources"][number]>,
  excerptById: Map<string, LoadedEvidence["excerpts"][number]>,
): string {
  const where = citation(ref.excerptId, input, sourceById, excerptById);
  return ref.quoteInExcerpt ? `${where}: ${codeSpan(ref.quote)}` : `${where}; ${quoteProblemText(ref)}`;
}

// One text for each reason that the host did not count a quote as found. A quote over the limit is kept cut to it.
function quoteProblemText(ref: QuotedEvidenceRef): string {
  switch (ref.quoteProblem) {
    case "empty":
      return `the quote is empty, so the host did not count it as found in ${ref.excerptId}`;
    case "too_short":
      return `the quote ${codeSpan(ref.quote)} is shorter than ${MIN_QUOTE_CODE_POINTS} characters, so the host did not count it as found in ${ref.excerptId}`;
    case "too_long":
      return `the quote ${codeSpan(`${ref.quote}…`)} is longer than ${QUOTE_MAX} characters, so the host did not count it as found in ${ref.excerptId}`;
    default:
      return `the host did not find the quoted ${codeSpan(ref.quote)} in ${ref.excerptId}`;
  }
}

// Inline code whose fence is one backtick longer than the longest run of backticks in the text.
function codeSpan(text: string): string {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence} ${text} ${fence}`;
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
