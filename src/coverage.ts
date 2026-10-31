import type { EvidenceCoverage, EvidenceExcerpt, EvidenceRef, EvidenceSource, PlanDocument } from "./types.ts";

// Design elements are the decisions, modules, data entities, invariants and access boundaries. An element counts as
// reference when one of its excerpts comes from a remote source (any file the host read from a reference repository),
// local only when all of them come from the local project, and no source when it cites no excerpt the host cut.
export function evidenceCoverage(plan: PlanDocument, evidence: { sources: EvidenceSource[]; excerpts: EvidenceExcerpt[] }): EvidenceCoverage {
  const sourceById = new Map(evidence.sources.map((source) => [source.id, source]));
  const excerptById = new Map(evidence.excerpts.map((excerpt) => [excerpt.id, excerpt]));
  const kinds = (refs: EvidenceRef[]): EvidenceSource["kind"][] => refs.flatMap((ref) => {
    const excerpt = excerptById.get(ref.excerptId);
    const source = excerpt ? sourceById.get(excerpt.sourceId) : undefined;
    return source ? [source.kind] : [];
  });
  const { design } = plan;
  const elements = [...plan.decisions, ...design.modules, ...design.dataModel.entities, ...design.invariants.items, ...design.accessControl.boundaries].map((element) => kinds(element.evidence));
  const reference = elements.filter((cited) => cited.includes("remote")).length;
  const noSource = elements.filter((cited) => cited.length === 0).length;
  const localOnly = elements.length - reference - noSource;
  const patterns = plan.referenceComparisons.flatMap((comparison) => comparison.adoptedPatterns);
  const tested = patterns.filter((pattern) => pattern.testEvidence.length > 0).length;
  return {
    designElements: elements.length,
    reference,
    referencePercent: percent(reference, elements.length),
    localOnly,
    localOnlyPercent: percent(localOnly, elements.length),
    noSource,
    noSourcePercent: percent(noSource, elements.length),
    adoptedPatterns: patterns.length,
    adoptedPatternsWithReferenceTest: tested,
    adoptedPatternsWithReferenceTestPercent: percent(tested, patterns.length),
  };
}

function percent(count: number, total: number): number | null {
  return total > 0 ? Math.round((100 * count) / total) : null;
}
