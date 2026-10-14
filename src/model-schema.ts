import { createHash } from "node:crypto";
import type {
  DesignDecision,
  EvidenceSource,
  IntakeBrief,
  MaterialQuestion,
  PlanDesign,
  PlanDocument,
  PlanTask,
  ReferenceComparison,
  RepositoryChoice,
  RepositoryCandidate,
  RepositorySnapshot,
  ReviewFinding,
  ReviewResult,
  SelectedFile,
  SelectedFileRole,
  EvidenceExcerpt,
  ExistingCommand,
  VerificationKind,
} from "./types.ts";

type JsonSchema = Record<string, unknown>;

const string = { type: "string" } as const;
const stringArray = { type: "array", items: string } as const;
const DOMAIN_TERM_ITEM = { minLength: 1, maxLength: 120 } as const;
const TOPIC_SLUG_ITEM = { minLength: 1, maxLength: 50 } as const;
const CODE_PATTERN_ITEM = { minLength: 3, maxLength: 40 } as const;

function object(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const INTAKE_SCHEMA: JsonSchema = object({
  summary: string,
  requirements: {
    type: "array",
    minItems: 1,
    maxItems: 12,
    items: object({ description: string, observableAcceptance: { ...stringArray, minItems: 1, maxItems: 8 } }),
  },
  outOfScope: { ...stringArray, maxItems: 12 },
  assumptions: { ...stringArray, maxItems: 12 },
  materialQuestions: {
    type: "array",
    maxItems: 6,
    items: object({ question: string, whyMaterial: string }),
  },
  researchQueries: { ...stringArray, minItems: 1, maxItems: 3 },
  domainTerms: { type: "array", minItems: 1, maxItems: 6, items: { ...string, ...DOMAIN_TERM_ITEM } },
  topicSlugs: { type: "array", maxItems: 4, items: { ...string, ...TOPIC_SLUG_ITEM } },
  codePatterns: { type: "array", minItems: 1, maxItems: 4, items: { ...string, ...CODE_PATTERN_ITEM } },
});

export const REFINED_BRIEF_SCHEMA: JsonSchema = {
  ...INTAKE_SCHEMA,
  properties: {
    ...(INTAKE_SCHEMA.properties as Record<string, JsonSchema>),
    materialQuestions: {
      type: "array",
      maxItems: 0,
      items: object({ question: string, whyMaterial: string }),
    },
  },
};

export const REPOSITORY_SELECTION_SCHEMA: JsonSchema = object({
  selected: {
    type: "array",
    maxItems: 3,
    items: object({ candidateId: string, rationale: string }),
  },
  rejected: {
    type: "array",
    maxItems: 15,
    items: object({ candidateId: string, rationale: string }),
  },
});

export const FILE_SELECTION_SCHEMA: JsonSchema = object({
  files: {
    type: "array",
    maxItems: 15,
    items: object({ fileId: string, role: { type: "string", enum: ["production", "test"] }, rationale: string }),
  },
});

const evidenceRefSchema = object({ excerptId: string, claim: string });

export const PLAN_SCHEMA: JsonSchema = object({
  title: string,
  summary: string,
  shouldDraft: { type: "boolean" },
  draftReasons: stringArray,
  design: object({
    architecture: string,
    modules: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: object({
        name: string,
        responsibility: string,
        interfaces: { ...stringArray, minItems: 1, maxItems: 8 },
        evidence: { type: "array", items: evidenceRefSchema, maxItems: 6 },
        newDesignReason: { type: ["string", "null"] },
      }),
    },
    dataModel: object({
      entities: {
        type: "array",
        maxItems: 12,
        items: object({
          name: string,
          fields: { ...stringArray, minItems: 1, maxItems: 12 },
          evidence: { type: "array", items: evidenceRefSchema, maxItems: 6 },
          newDesignReason: { type: ["string", "null"] },
        }),
      },
      notApplicableReason: { type: ["string", "null"] },
    }),
    invariants: object({
      items: {
        type: "array",
        maxItems: 12,
        items: object({
          statement: string,
          evidence: { type: "array", items: evidenceRefSchema, maxItems: 6 },
          newDesignReason: { type: ["string", "null"] },
        }),
      },
      notApplicableReason: { type: ["string", "null"] },
    }),
    accessControl: object({
      boundaries: {
        type: "array",
        maxItems: 8,
        items: object({
          boundary: string,
          behavior: string,
          evidence: { type: "array", items: evidenceRefSchema, maxItems: 6 },
          newDesignReason: { type: ["string", "null"] },
        }),
      },
      notApplicableReason: { type: ["string", "null"] },
    }),
  }),
  tasks: {
    type: "array",
    minItems: 1,
    maxItems: 24,
    items: object({
      id: string,
      title: string,
      description: string,
      requirementIds: { type: "array", minItems: 1, items: string },
      dependencies: stringArray,
      acceptance: {
        type: "array",
        minItems: 1,
        items: object({ requirementId: string, coversAcceptanceIds: { type: "array", minItems: 1, items: string }, condition: string }),
      },
      verification: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: object({
          kind: { type: "string", enum: ["existing", "to_create", "manual"] },
          coversAcceptanceIds: { type: "array", minItems: 1, items: string },
          description: string,
          commandId: { type: ["string", "null"] },
          plannedCommand: { type: ["string", "null"] },
        }),
      },
      evidence: { type: "array", items: evidenceRefSchema, maxItems: 8 },
    }),
  },
  decisions: {
    type: "array",
    maxItems: 12,
    items: object({
      title: string,
      decision: string,
      rationale: string,
      evidence: { type: "array", items: evidenceRefSchema, maxItems: 6 },
      newDesignReason: { type: ["string", "null"] },
    }),
  },
  referenceComparisons: {
    type: "array",
    maxItems: 3,
    items: object({
      candidateId: string,
      adoptedPatterns: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: object({ pattern: string, evidence: { type: "array", minItems: 1, items: evidenceRefSchema, maxItems: 6 } }),
      },
      rejectedPatterns: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: object({ pattern: string, reason: string, evidence: { type: "array", minItems: 1, items: evidenceRefSchema, maxItems: 6 } }),
      },
      localAdaptation: string,
    }),
  },
  risks: {
    type: "array",
    maxItems: 12,
    items: object({ description: string, evidence: { type: "array", items: evidenceRefSchema, maxItems: 6 } }),
  },
});

export const REVIEW_SCHEMA: JsonSchema = object({
  findings: {
    type: "array",
    maxItems: 12,
    items: object({
      severity: { type: "string", enum: ["blocking", "material", "minor"] },
      description: string,
      requirementIds: stringArray,
      evidence: { type: "array", items: evidenceRefSchema, maxItems: 6 },
      suggestedCorrection: string,
    }),
  },
});

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

type Obj = Record<string, unknown>;

function asObject(value: unknown, label: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelOutputError(`${label} must be an object.`);
  }
  return value as Obj;
}

function asString(value: unknown, label: string, max = 3000): string {
  if (typeof value !== "string") throw new ModelOutputError(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new ModelOutputError(`${label} must contain 1 to ${max} characters.`);
  return normalized;
}

function asStringArray(value: unknown, label: string, min: number, max: number, itemMax = 1200): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ModelOutputError(`${label} must contain ${min} to ${max} items.`);
  }
  return value.map((item, index) => asString(item, `${label}[${index + 1}]`, itemMax));
}

function asBoundedStringArray(
  value: unknown,
  label: string,
  max: number,
  itemBounds: { minLength: number; maxLength: number },
): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new ModelOutputError(`${label} must contain at most ${max} items.`);
  }
  return value.map((item, index) => {
    const length = typeof item === "string" ? [...item].length : 0;
    if (typeof item !== "string" || length < itemBounds.minLength || length > itemBounds.maxLength) {
      throw new ModelOutputError(`${label}[${index + 1}] must contain ${itemBounds.minLength} to ${itemBounds.maxLength} characters.`);
    }
    return item;
  });
}

function asArray(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ModelOutputError(`${label} must contain ${min} to ${max} items.`);
  }
  return value;
}

export function parseModelJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ModelOutputError("The model did not return valid JSON for the requested schema.");
  }
}

export function parseIntake(value: unknown): IntakeBrief {
  const input = asObject(value, "Intake result");
  const summary = asString(input.summary, "summary");
  const rawRequirements = asArray(input.requirements, "requirements", 1, 12);
  let acceptanceNumber = 0;
  const requirements = rawRequirements.map((value, index) => {
    const entry = asObject(value, `requirements[${index + 1}]`);
    const descriptions = asStringArray(entry.observableAcceptance, `requirements[${index + 1}].observableAcceptance`, 1, 8);
    return {
      id: `R${index + 1}`,
      description: asString(entry.description, `requirements[${index + 1}].description`),
      observableAcceptance: descriptions.map((description) => ({ id: `A${++acceptanceNumber}`, description })),
    };
  });
  const rawQuestions = asArray(input.materialQuestions, "materialQuestions", 0, 6);
  const questionIds = new Set<string>();
  const materialQuestions: MaterialQuestion[] = rawQuestions.map((value, index) => {
    const question = asObject(value, `materialQuestions[${index + 1}]`);
    const questionText = asString(question.question, `materialQuestions[${index + 1}].question`);
    const whyMaterial = asString(question.whyMaterial, `materialQuestions[${index + 1}].whyMaterial`);
    const id = stableMaterialQuestionId(questionText, whyMaterial);
    if (questionIds.has(id)) throw new ModelOutputError("The intake repeated the same material question. Combine duplicate questions before answering.");
    questionIds.add(id);
    return {
      id,
      question: questionText,
      whyMaterial,
    };
  });
  return {
    summary,
    requirements,
    outOfScope: input.outOfScope === undefined ? [] : asStringArray(input.outOfScope, "outOfScope", 0, 12),
    assumptions: input.assumptions === undefined ? [] : asStringArray(input.assumptions, "assumptions", 0, 12),
    materialQuestions,
    researchQueries: input.researchQueries === undefined ? [] : asStringArray(input.researchQueries, "researchQueries", 1, 3, 300),
    domainTerms: input.domainTerms === undefined ? [] : asBoundedStringArray(input.domainTerms, "domainTerms", 6, DOMAIN_TERM_ITEM),
    topicSlugs: input.topicSlugs === undefined ? [] : asBoundedStringArray(input.topicSlugs, "topicSlugs", 4, TOPIC_SLUG_ITEM),
    ...(input.codePatterns === undefined ? {} : { codePatterns: asBoundedStringArray(input.codePatterns, "codePatterns", 4, CODE_PATTERN_ITEM) }),
  };
}

export function parseRefinedBrief(value: unknown, initial: IntakeBrief): IntakeBrief {
  const parsed = parseIntake(value);
  if (parsed.materialQuestions.length > 0) throw new ModelOutputError("The brief rebuild may not add material questions.");
  return { ...parsed, materialQuestions: initial.materialQuestions };
}

export function stableMaterialQuestionId(question: string, whyMaterial: string): string {
  const normalize = (value: string): string => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  const semanticText = `question:${normalize(question)}\nwhy:${normalize(whyMaterial)}`;
  return `Q-${createHash("sha256").update(semanticText, "utf8").digest("hex").slice(0, 12)}`;
}

export function parseRepositorySelection(
  value: unknown,
  candidates: RepositoryCandidate[],
): { selected: Array<{ candidateId: string; rationale: string }>; rejected: Array<{ candidateId: string; rationale: string }> } {
  const result = asObject(value, "Repository selection");
  const selected = asArray(result.selected, "selected", 0, 3).map((value, index) => {
    const item = asObject(value, `selected[${index + 1}]`);
    return {
      candidateId: asString(item.candidateId, `selected[${index + 1}].candidateId`, 80),
      rationale: asString(item.rationale, `selected[${index + 1}].rationale`),
    };
  });
  const rejected = asArray(result.rejected, "rejected", 0, 15).map((value, index) => {
    const item = asObject(value, `rejected[${index + 1}]`);
    return {
      candidateId: asString(item.candidateId, `rejected[${index + 1}].candidateId`, 80),
      rationale: asString(item.rationale, `rejected[${index + 1}].rationale`),
    };
  });
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const ids = new Set<string>();
  for (const item of [...selected, ...rejected]) {
    if (!allowed.has(item.candidateId)) throw new ModelOutputError(`Unknown repository candidate ID: ${item.candidateId}.`);
    if (ids.has(item.candidateId)) throw new ModelOutputError(`Repository candidate appears more than once: ${item.candidateId}.`);
    ids.add(item.candidateId);
  }
  if (ids.size !== allowed.size) throw new ModelOutputError("Every searched repository candidate needs a selected or rejected reason.");
  return { selected, rejected };
}

const FILE_ROLES = new Set<SelectedFileRole>(["production", "test", "manifest", "ci", "license", "config"]);

export function parseFileSelection(value: unknown, allowedFiles: TreeFileLike[]): SelectedFile[] {
  const result = asObject(value, "File selection");
  const files = asArray(result.files, "files", 0, 15).map((value, index) => {
    const item = asObject(value, `files[${index + 1}]`);
    const role = asString(item.role, `files[${index + 1}].role`, 20) as SelectedFileRole;
    if (!FILE_ROLES.has(role)) throw new ModelOutputError(`Unsupported file role: ${role}.`);
    return {
      fileId: asString(item.fileId, `files[${index + 1}].fileId`, 160),
      role,
      rationale: asString(item.rationale, `files[${index + 1}].rationale`),
    };
  });
  const allowed = new Set(allowedFiles.map((file) => file.id));
  const ids = new Set<string>();
  for (const file of files) {
    if (!allowed.has(file.fileId)) throw new ModelOutputError(`Unknown file ID: ${file.fileId}.`);
    if (ids.has(file.fileId)) throw new ModelOutputError(`File selected twice: ${file.fileId}.`);
    ids.add(file.fileId);
  }
  return files;
}

interface TreeFileLike { id: string; }

function parseEvidence(value: unknown, label: string, min = 0, max = 8): PlanTask["evidence"] {
  return asArray(value, label, min, max).map((value, index) => {
    const entry = asObject(value, `${label}[${index + 1}]`);
    return {
      excerptId: asString(entry.excerptId, `${label}[${index + 1}].excerptId`, 100),
      claim: asString(entry.claim, `${label}[${index + 1}].claim`, 700),
    };
  });
}

function parseDesign(
  value: unknown,
  validateEvidence: (refs: PlanTask["evidence"], label: string) => void,
): PlanDesign {
  const design = asObject(value, "design");
  const nullableText = (value: unknown, label: string): string | undefined => {
    if (value === null || value === undefined) return undefined;
    return asString(value, label, 1200);
  };
  const requireGrounding = (evidence: PlanTask["evidence"], newDesignReason: string | undefined, label: string): void => {
    validateEvidence(evidence, label);
    if (evidence.length === 0 && !newDesignReason?.trim()) throw new ModelOutputError(`${label} needs source evidence or a concrete new-design reason.`);
  };
  const modules = asArray(design.modules, "design.modules", 1, 12).map((value, index) => {
    const item = asObject(value, `design.modules[${index + 1}]`);
    const evidence = parseEvidence(item.evidence, `design.modules[${index + 1}].evidence`, 0, 6);
    const newDesignReason = nullableText(item.newDesignReason, `design.modules[${index + 1}].newDesignReason`);
    requireGrounding(evidence, newDesignReason, `Module ${index + 1}`);
    return {
      name: asString(item.name, `design.modules[${index + 1}].name`, 140),
      responsibility: asString(item.responsibility, `design.modules[${index + 1}].responsibility`),
      interfaces: asStringArray(item.interfaces, `design.modules[${index + 1}].interfaces`, 1, 8),
      evidence,
      ...(newDesignReason ? { newDesignReason } : {}),
    };
  });
  const dataModelValue = asObject(design.dataModel, "design.dataModel");
  const dataModelReason = nullableText(dataModelValue.notApplicableReason, "design.dataModel.notApplicableReason");
  const entities = asArray(dataModelValue.entities, "design.dataModel.entities", 0, 12).map((value, index) => {
    const item = asObject(value, `design.dataModel.entities[${index + 1}]`);
    const evidence = parseEvidence(item.evidence, `design.dataModel.entities[${index + 1}].evidence`, 0, 6);
    const newDesignReason = nullableText(item.newDesignReason, `design.dataModel.entities[${index + 1}].newDesignReason`);
    requireGrounding(evidence, newDesignReason, `Data entity ${index + 1}`);
    return {
      name: asString(item.name, `design.dataModel.entities[${index + 1}].name`, 140),
      fields: asStringArray(item.fields, `design.dataModel.entities[${index + 1}].fields`, 1, 12),
      evidence,
      ...(newDesignReason ? { newDesignReason } : {}),
    };
  });
  if ((entities.length === 0) === !dataModelReason?.trim()) {
    throw new ModelOutputError("design.dataModel must contain grounded entities or a concrete notApplicableReason, but not both.");
  }

  const invariantsValue = asObject(design.invariants, "design.invariants");
  const invariantsReason = nullableText(invariantsValue.notApplicableReason, "design.invariants.notApplicableReason");
  const invariants = asArray(invariantsValue.items, "design.invariants.items", 0, 12).map((value, index) => {
    const item = asObject(value, `design.invariants.items[${index + 1}]`);
    const evidence = parseEvidence(item.evidence, `design.invariants.items[${index + 1}].evidence`, 0, 6);
    const newDesignReason = nullableText(item.newDesignReason, `design.invariants.items[${index + 1}].newDesignReason`);
    requireGrounding(evidence, newDesignReason, `Invariant ${index + 1}`);
    return {
      statement: asString(item.statement, `design.invariants.items[${index + 1}].statement`),
      evidence,
      ...(newDesignReason ? { newDesignReason } : {}),
    };
  });
  if ((invariants.length === 0) === !invariantsReason?.trim()) {
    throw new ModelOutputError("design.invariants must contain grounded invariants or a concrete notApplicableReason, but not both.");
  }

  const accessValue = asObject(design.accessControl, "design.accessControl");
  const accessReason = nullableText(accessValue.notApplicableReason, "design.accessControl.notApplicableReason");
  const boundaries = asArray(accessValue.boundaries, "design.accessControl.boundaries", 0, 8).map((value, index) => {
    const item = asObject(value, `design.accessControl.boundaries[${index + 1}]`);
    const evidence = parseEvidence(item.evidence, `design.accessControl.boundaries[${index + 1}].evidence`, 0, 6);
    const newDesignReason = nullableText(item.newDesignReason, `design.accessControl.boundaries[${index + 1}].newDesignReason`);
    requireGrounding(evidence, newDesignReason, `Access boundary ${index + 1}`);
    return {
      boundary: asString(item.boundary, `design.accessControl.boundaries[${index + 1}].boundary`),
      behavior: asString(item.behavior, `design.accessControl.boundaries[${index + 1}].behavior`),
      evidence,
      ...(newDesignReason ? { newDesignReason } : {}),
    };
  });
  if ((boundaries.length === 0) === !accessReason?.trim()) {
    throw new ModelOutputError("design.accessControl must contain grounded boundaries or a concrete notApplicableReason, but not both.");
  }

  return {
    architecture: asString(design.architecture, "design.architecture"),
    modules,
    dataModel: { entities, ...(dataModelReason ? { notApplicableReason: dataModelReason } : {}) },
    invariants: { items: invariants, ...(invariantsReason ? { notApplicableReason: invariantsReason } : {}) },
    accessControl: { boundaries, ...(accessReason ? { notApplicableReason: accessReason } : {}) },
  };
}

export interface ParsedPlanPayload {
  title: string;
  summary: string;
  shouldDraft: boolean;
  draftReasons: string[];
  design: PlanDesign;
  tasks: PlanTask[];
  decisions: DesignDecision[];
  referenceComparisons: Array<Pick<ReferenceComparison, "candidateId" | "adoptedPatterns" | "rejectedPatterns" | "localAdaptation">>;
  risks: PlanDocument["risks"];
}

export function parsePlan(
  value: unknown,
  brief: IntakeBrief,
  excerpts: EvidenceExcerpt[],
  commands: ExistingCommand[],
  selectedRepositories: RepositorySnapshot[] = [],
  evidenceSources: EvidenceSource[] = [],
): ParsedPlanPayload {
  const result = asObject(value, "Plan");
  if (typeof result.shouldDraft !== "boolean") throw new ModelOutputError("shouldDraft must be a boolean.");
  const excerptIds = new Set(excerpts.map((excerpt) => excerpt.id));
  const commandIds = new Set(commands.map((command) => command.id));
  const requirementIds = new Set(brief.requirements.map((requirement) => requirement.id));
  const acceptanceIds = new Set(brief.requirements.flatMap((requirement) => requirement.observableAcceptance.map((item) => item.id)));
  const sourceById = new Map(evidenceSources.map((source) => [source.id, source]));
  const excerptById = new Map(excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const validateEvidence = (refs: PlanTask["evidence"], label: string, expectedRepository?: RepositorySnapshot): void => {
    for (const ref of refs) {
      if (!excerptIds.has(ref.excerptId)) throw new ModelOutputError(`${label} refers to unknown evidence excerpt ${ref.excerptId}.`);
      if (!expectedRepository) continue;
      const excerpt = excerptById.get(ref.excerptId)!;
      const source = sourceById.get(excerpt.sourceId);
      if (!source || source.kind !== "remote" || source.provider !== expectedRepository.candidate.provider || source.repository !== expectedRepository.candidate.fullName || source.commitSha !== expectedRepository.commitSha) {
        throw new ModelOutputError(`${label} must cite evidence from ${expectedRepository.candidate.provider}:${expectedRepository.candidate.fullName}@${expectedRepository.commitSha}.`);
      }
    }
  };
  const rawTasks = asArray(result.tasks, "tasks", 1, 24);
  const taskIds = new Set<string>();
  const taskAcceptances = new Set<string>();
  const tasks: PlanTask[] = rawTasks.map((value, index) => {
    const item = asObject(value, `tasks[${index + 1}]`);
    const id = asString(item.id, `tasks[${index + 1}].id`, 20);
    if (!/^T[1-9]\d*$/.test(id)) throw new ModelOutputError(`Task ID ${id} must use the T1, T2 format.`);
    if (taskIds.has(id)) throw new ModelOutputError(`Duplicate task ID: ${id}.`);
    taskIds.add(id);
    const mappedRequirements = asStringArray(item.requirementIds, `${id}.requirementIds`, 1, 12, 20);
    for (const requirementId of mappedRequirements) {
      if (!requirementIds.has(requirementId)) throw new ModelOutputError(`${id} refers to unknown requirement ${requirementId}.`);
    }
    const acceptance = asArray(item.acceptance, `${id}.acceptance`, 1, 24).map((value, acceptanceIndex) => {
      const criterion = asObject(value, `${id}.acceptance[${acceptanceIndex + 1}]`);
      const requirementId = asString(criterion.requirementId, `${id}.acceptance.requirementId`, 20);
      if (!mappedRequirements.includes(requirementId)) throw new ModelOutputError(`${id} acceptance maps to a requirement outside the task.`);
      const coversAcceptanceIds = asStringArray(criterion.coversAcceptanceIds, `${id}.acceptance.coversAcceptanceIds`, 1, 12, 20);
      const req = brief.requirements.find((entry) => entry.id === requirementId)!;
      const validForRequirement = new Set(req.observableAcceptance.map((entry) => entry.id));
      for (const acceptanceId of coversAcceptanceIds) {
        if (!acceptanceIds.has(acceptanceId) || !validForRequirement.has(acceptanceId)) {
          throw new ModelOutputError(`${id} acceptance refers to ${acceptanceId}, which does not belong to ${requirementId}.`);
        }
      }
      const acceptanceId = `${id}-A${acceptanceIndex + 1}`;
      taskAcceptances.add(acceptanceId);
      return {
        id: acceptanceId,
        requirementId,
        coversAcceptanceIds,
        condition: asString(criterion.condition, `${id}.acceptance.condition`),
      };
    });
    const rawVerification = asArray(item.verification, `${id}.verification`, 1, 8);
    const verification = rawVerification.map((value, verificationIndex) => {
      const method = asObject(value, `${id}.verification[${verificationIndex + 1}]`);
      const kindValue = asString(method.kind, `${id}.verification.kind`, 20);
      if (kindValue !== "existing" && kindValue !== "to_create" && kindValue !== "manual") {
        throw new ModelOutputError(`${id} has an unsupported verification kind.`);
      }
      const kind = kindValue as VerificationKind;
      const covers = asStringArray(method.coversAcceptanceIds, `${id}.verification.coversAcceptanceIds`, 1, 24, 20);
      const taskCoveredIds = new Set(acceptance.flatMap((entry) => entry.coversAcceptanceIds));
      if (covers.some((acceptanceId) => !taskCoveredIds.has(acceptanceId))) {
        throw new ModelOutputError(`${id} verification refers to acceptance outside its task.`);
      }
      const commandId = method.commandId === null ? undefined : asString(method.commandId, `${id}.verification.commandId`, 80);
      const plannedCommand = method.plannedCommand === null ? undefined : asString(method.plannedCommand, `${id}.verification.plannedCommand`, 300);
      if (kind === "existing") {
        if (!commandId || !commandIds.has(commandId) || plannedCommand) throw new ModelOutputError(`${id} existing verification must use a supplied command ID only.`);
      } else if (kind === "to_create") {
        if (commandId || !plannedCommand) throw new ModelOutputError(`${id} new verification must name a command to create, not an existing command ID.`);
      } else if (commandId || plannedCommand) {
        throw new ModelOutputError(`${id} manual verification cannot include a shell command.`);
      }
      return {
        id: `${id}-V${verificationIndex + 1}`,
        kind,
        acceptanceIds: covers,
        description: asString(method.description, `${id}.verification.description`),
        ...(commandId ? {
          commandId,
          command: commands.find((command) => command.id === commandId)!.command,
          commandSource: { sourceId: commands.find((command) => command.id === commandId)!.sourceId, line: commands.find((command) => command.id === commandId)!.line },
        } : {}),
        ...(plannedCommand ? { plannedCommand } : {}),
      };
    });
    const evidence = parseEvidence(item.evidence, `${id}.evidence`);
    validateEvidence(evidence, id);
    return {
      id,
      title: asString(item.title, `${id}.title`, 180),
      description: asString(item.description, `${id}.description`),
      requirementIds: mappedRequirements,
      dependencies: asStringArray(item.dependencies, `${id}.dependencies`, 0, 24, 20),
      acceptance,
      verification,
      evidence,
    };
  });

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) throw new ModelOutputError(`${task.id} depends on unknown task ${dependency}.`);
      if (dependency === task.id) throw new ModelOutputError(`${task.id} cannot depend on itself.`);
    }
    const covered = new Set(task.acceptance.flatMap((entry) => entry.coversAcceptanceIds));
    const verified = new Set(task.verification.flatMap((entry) => entry.acceptanceIds));
    for (const acceptanceId of covered) if (!verified.has(acceptanceId)) throw new ModelOutputError(`${task.id} has unverified acceptance ${acceptanceId}.`);
  }

  for (const requirement of brief.requirements) {
    if (!tasks.some((task) => task.requirementIds.includes(requirement.id))) throw new ModelOutputError(`No task covers ${requirement.id}.`);
  }
  for (const requirement of brief.requirements) {
    for (const criterion of requirement.observableAcceptance) {
      if (!tasks.some((task) => task.acceptance.some((item) => item.coversAcceptanceIds.includes(criterion.id)))) {
        throw new ModelOutputError(`No task acceptance covers ${criterion.id}.`);
      }
    }
  }
  assertAcyclic(tasks);

  const rawDecisions = asArray(result.decisions, "decisions", 0, 12);
  const decisions: DesignDecision[] = rawDecisions.map((value, index) => {
    const item = asObject(value, `decisions[${index + 1}]`);
    const evidence = parseEvidence(item.evidence, `decisions[${index + 1}].evidence`);
    validateEvidence(evidence, "Decision");
    const newDesignReason = item.newDesignReason === null ? undefined : asString(item.newDesignReason, `decisions[${index + 1}].newDesignReason`);
    if (evidence.length === 0 && !newDesignReason) throw new ModelOutputError(`Design decision ${index + 1} needs source evidence or a new-design reason.`);
    return {
      id: `D${index + 1}`,
      title: asString(item.title, `decisions[${index + 1}].title`, 180),
      decision: asString(item.decision, `decisions[${index + 1}].decision`),
      rationale: asString(item.rationale, `decisions[${index + 1}].rationale`),
      evidence,
      ...(newDesignReason ? { newDesignReason } : {}),
    };
  });

  const design = parseDesign(result.design, validateEvidence);

  const rawComparisons = asArray(result.referenceComparisons, "referenceComparisons", 0, 3);
  const selectedRepositoryIds = new Set(selectedRepositories.map((repository) => repository.candidate.id));
  const comparedIds = new Set<string>();
  const referenceComparisons = rawComparisons.map((value, index) => {
    const item = asObject(value, `referenceComparisons[${index + 1}]`);
    const candidateId = asString(item.candidateId, `referenceComparisons[${index + 1}].candidateId`, 80);
    const expectedRepository = selectedRepositories.find((repository) => repository.candidate.id === candidateId);
    if (!selectedRepositoryIds.has(candidateId) || !expectedRepository) throw new ModelOutputError(`Reference comparison uses an unselected candidate ${candidateId}.`);
    if (comparedIds.has(candidateId)) throw new ModelOutputError(`Reference ${candidateId} is compared more than once.`);
    comparedIds.add(candidateId);
    const adoptedPatterns = asArray(item.adoptedPatterns, `referenceComparisons[${index + 1}].adoptedPatterns`, 1, 6).map((value, patternIndex) => {
      const pattern = asObject(value, `referenceComparisons[${index + 1}].adoptedPatterns[${patternIndex + 1}]`);
      const evidence = parseEvidence(pattern.evidence, "adopted pattern evidence", 1, 6);
      validateEvidence(evidence, `Adopted pattern for ${candidateId}`, expectedRepository);
      return { pattern: asString(pattern.pattern, "adopted pattern", 400), evidence };
    });
    const rejectedPatterns = asArray(item.rejectedPatterns, `referenceComparisons[${index + 1}].rejectedPatterns`, 1, 6).map((value, patternIndex) => {
      const pattern = asObject(value, `referenceComparisons[${index + 1}].rejectedPatterns[${patternIndex + 1}]`);
      const evidence = parseEvidence(pattern.evidence, "rejected pattern evidence", 1, 6);
      validateEvidence(evidence, `Rejected pattern for ${candidateId}`, expectedRepository);
      return {
        pattern: asString(pattern.pattern, "rejected pattern", 400),
        reason: asString(pattern.reason, "rejected pattern reason", 700),
        evidence,
      };
    });
    return {
      candidateId,
      adoptedPatterns,
      rejectedPatterns,
      localAdaptation: asString(item.localAdaptation, "reference local adaptation"),
    };
  });
  if (comparedIds.size !== selectedRepositoryIds.size) throw new ModelOutputError("Every selected repository needs an evidence-backed adopt/reject comparison.");

  const rawRisks = asArray(result.risks, "risks", 0, 12);
  const risks = rawRisks.map((value, index) => {
    const item = asObject(value, `risks[${index + 1}]`);
    const evidence = parseEvidence(item.evidence, `risks[${index + 1}].evidence`);
    validateEvidence(evidence, "Risk");
    return { description: asString(item.description, `risks[${index + 1}].description`), evidence };
  });

  return {
    title: asString(result.title, "title", 180),
    summary: asString(result.summary, "summary"),
    shouldDraft: result.shouldDraft,
    draftReasons: result.draftReasons === undefined ? [] : asStringArray(result.draftReasons, "draftReasons", 0, 12),
    design,
    tasks,
    decisions,
    referenceComparisons,
    risks,
  };
}

function assertAcyclic(tasks: PlanTask[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ModelOutputError(`Task dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function parseReview(value: unknown, brief: IntakeBrief, excerpts: EvidenceExcerpt[]): ReviewResult {
  const result = asObject(value, "Review");
  const allowedRequirements = new Set(brief.requirements.map((requirement) => requirement.id));
  const allowedExcerpts = new Set(excerpts.map((excerpt) => excerpt.id));
  const findings: ReviewFinding[] = asArray(result.findings, "findings", 0, 12).map((value, index) => {
    const item = asObject(value, `findings[${index + 1}]`);
    const severity = asString(item.severity, `findings[${index + 1}].severity`, 20);
    if (severity !== "blocking" && severity !== "material" && severity !== "minor") throw new ModelOutputError("Review severity is invalid.");
    const requirementIds = asStringArray(item.requirementIds, `findings[${index + 1}].requirementIds`, 0, 12, 20);
    for (const id of requirementIds) if (!allowedRequirements.has(id)) throw new ModelOutputError(`Review refers to unknown requirement ${id}.`);
    const evidence = parseEvidence(item.evidence, `findings[${index + 1}].evidence`);
    for (const ref of evidence) if (!allowedExcerpts.has(ref.excerptId)) throw new ModelOutputError(`Review refers to unknown evidence excerpt ${ref.excerptId}.`);
    return {
      severity,
      description: asString(item.description, `findings[${index + 1}].description`),
      requirementIds,
      evidence,
      suggestedCorrection: asString(item.suggestedCorrection, `findings[${index + 1}].suggestedCorrection`),
    };
  });
  return { findings };
}

export function createPlanDocument(
  payload: ParsedPlanPayload,
  brief: IntakeBrief,
  readiness: PlanDocument["readiness"],
  readinessNotes: string[],
  repositoryChoices: RepositoryChoice[] = [],
  selectedRepositories: RepositorySnapshot[] = [],
  selectionRationales: Map<string, string> = new Map(),
): PlanDocument {
  const snapshotById = new Map(selectedRepositories.map((repository) => [repository.candidate.id, repository]));
  return {
    title: payload.title,
    summary: payload.summary,
    requirements: brief.requirements,
    tasks: payload.tasks,
    decisions: payload.decisions,
    design: payload.design,
    repositoryChoices,
    referenceComparisons: payload.referenceComparisons.map((comparison) => {
      const snapshot = snapshotById.get(comparison.candidateId)!;
      return {
        ...comparison,
        provider: snapshot.candidate.provider,
        repository: snapshot.candidate.fullName,
        commitSha: snapshot.commitSha,
        ...(snapshot.commitDate ? { commitDate: snapshot.commitDate } : {}),
        ...(snapshot.candidate.lastActivityAt ? { lastActivityAt: snapshot.candidate.lastActivityAt } : {}),
        selectionRationale: selectionRationales.get(comparison.candidateId) ?? "Selected for implementation evidence.",
      };
    }),
    risks: payload.risks,
    readiness,
    readinessNotes: [...new Set([...readinessNotes, ...payload.draftReasons])],
  };
}

export function topologicalTasks(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const result: PlanTask[] = [];
  const visit = (task: PlanTask): void => {
    if (visited.has(task.id)) return;
    for (const id of task.dependencies) visit(byId.get(id)!);
    visited.add(task.id);
    result.push(task);
  };
  for (const task of tasks) visit(task);
  return result;
}

export function intakeQuestionMap(brief: IntakeBrief): Map<string, MaterialQuestion> {
  return new Map(brief.materialQuestions.map((question) => [question.id, question]));
}

export function selectedRepositorySnapshots(
  selected: Array<{ candidateId: string; rationale: string }>,
  candidates: RepositoryCandidate[],
  snapshots: RepositorySnapshot[],
): RepositorySnapshot[] {
  const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.candidate.id, snapshot]));
  return selected.flatMap(({ candidateId }) => {
    const candidate = candidateMap.get(candidateId);
    const snapshot = snapshotMap.get(candidateId);
    return candidate && snapshot ? [snapshot] : [];
  });
}
