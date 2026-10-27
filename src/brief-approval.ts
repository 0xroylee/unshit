import { createHash } from "node:crypto";
import type { IntakeBrief, Requirement, ResearchGap } from "./types.ts";

// The readiness note of a plan whose brief no person approved.
export const UNAPPROVED_BRIEF_NOTE = "No person approved the brief's requirements and acceptance criteria before reference research.";

// The brief as a person reads and edits it in an answers file: the intake fields without the host's R* and A* IDs,
// the origin labels, or the material questions.
export interface EditableBrief {
  summary: string;
  requirements: Array<{ description: string; userWords: string | null; observableAcceptance: string[] }>;
  outOfScope: string[];
  assumptions: string[];
  researchQueries: string[];
  domainTerms: string[];
  topicSlugs: string[];
  codePatterns: string[];
}

export function editableBrief(brief: IntakeBrief): EditableBrief {
  return {
    summary: brief.summary,
    requirements: brief.requirements.map((requirement) => ({
      description: requirement.description,
      userWords: requirement.userWords ?? null,
      observableAcceptance: requirement.observableAcceptance.map((criterion) => criterion.description),
    })),
    outOfScope: brief.outOfScope,
    assumptions: brief.assumptions,
    researchQueries: brief.researchQueries,
    domainTerms: brief.domainTerms,
    topicSlugs: brief.topicSlugs,
    codePatterns: brief.codePatterns ?? [],
  };
}

// The hash covers the editable form, so a brief keeps its hash when the host reassigns the R* and A* IDs.
export function briefSha256(brief: IntakeBrief): string {
  return createHash("sha256").update(JSON.stringify(editableBrief(brief)), "utf8").digest("hex");
}

export function requirementLabel(requirement: Requirement): string {
  return requirement.origin === "stated" && requirement.userWords ? `you said: "${requirement.userWords}"` : "inferred";
}

// The final brief as the terminal shows it before asking for approval.
export function renderBriefForApproval(brief: IntakeBrief): string {
  const lines = ["Final brief:", brief.summary, ""];
  for (const requirement of brief.requirements) {
    lines.push(`${requirement.id} (${requirementLabel(requirement)}): ${requirement.description}`);
    for (const criterion of requirement.observableAcceptance) lines.push(`  ${criterion.id}: ${criterion.description}`);
  }
  if (brief.outOfScope.length > 0) lines.push("", "Out of scope:", ...brief.outOfScope.map((item) => `- ${item}`));
  if (brief.assumptions.length > 0) lines.push("", "Assumptions:", ...brief.assumptions.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
}

// Only yes approves the brief, in any letter case and with surrounding whitespace.
export function isBriefApproval(reply: string): boolean {
  return reply.trim().toLowerCase() === "yes";
}

// One informational gap that names the requirements labelled inferred. Inferred requirements do not keep a plan Draft.
export function inferredRequirementGaps(brief: IntakeBrief): ResearchGap[] {
  const inferred = brief.requirements.filter((requirement) => requirement.origin === "inferred").map((requirement) => requirement.id);
  if (inferred.length === 0) return [];
  return [{ kind: "validation", material: false, message: `Inferred requirements (no quote of the user's words was found in the requirement or the confirmed answers): ${inferred.join(", ")}.` }];
}
