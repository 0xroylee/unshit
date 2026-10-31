import { describe, expect, test } from "bun:test";
import { evidenceCoverage } from "../src/coverage.ts";
import type { EvidenceExcerpt, EvidenceRef, EvidenceSource, PlanDocument } from "../src/types.ts";

const sha = "c".repeat(40);

const sources: EvidenceSource[] = [
  { id: "S1", kind: "remote", path: "src/a.ts", sha256: "a".repeat(64), lineCount: 40, byteCount: 400, provider: "github", repository: "org/a", commitSha: sha, permalink: `https://github.com/org/a/blob/${sha}/src/a.ts`, snapshotPath: "sources/S1.txt", roles: ["production"] },
  { id: "S2", kind: "remote", path: "test/a.test.ts", sha256: "b".repeat(64), lineCount: 30, byteCount: 300, provider: "github", repository: "org/a", commitSha: sha, permalink: `https://github.com/org/a/blob/${sha}/test/a.test.ts`, snapshotPath: "sources/S2.txt", roles: ["test"] },
  { id: "S3", kind: "local", path: "src/app.ts", sha256: "d".repeat(64), lineCount: 10, byteCount: 100, snapshotPath: "sources/S3.txt", roles: ["production"] },
];
const excerpts: EvidenceExcerpt[] = [
  { id: "E1", sourceId: "S1", startLine: 1, endLine: 5, text: "remote" },
  { id: "E2", sourceId: "S2", startLine: 1, endLine: 4, text: "remote test" },
  { id: "E3", sourceId: "S3", startLine: 1, endLine: 2, text: "local" },
];
const remoteRef: EvidenceRef = { excerptId: "E1", claim: "the reference does this" };
const testRef: EvidenceRef = { excerptId: "E2", claim: "the reference tests this" };
const localRef: EvidenceRef = { excerptId: "E3", claim: "the project does this" };
const unknownRef: EvidenceRef = { excerptId: "E99", claim: "the host never cut this excerpt" };

function plan(): PlanDocument {
  return {
    title: "Ticket plan",
    summary: "Sell tickets.",
    requirements: [],
    tasks: [],
    decisions: [{ id: "D1", title: "Hold seats", decision: "Hold a seat for ten minutes.", rationale: "As the reference does.", evidence: [remoteRef] }],
    design: {
      architecture: "One service.",
      modules: [{ name: "Checkout", responsibility: "Takes payment.", interfaces: [], evidence: [localRef, remoteRef] }],
      dataModel: { entities: [{ name: "Ticket", fields: ["seat"], evidence: [unknownRef], newDesignReason: "No reference stores seats." }] },
      invariants: { items: [{ statement: "A seat is sold once.", evidence: [localRef] }] },
      accessControl: { boundaries: [{ boundary: "Staff", behavior: "Only staff refund.", evidence: [], newDesignReason: "The brief adds staff refunds." }] },
    },
    repositoryChoices: [],
    referenceComparisons: [{
      candidateId: "C1",
      provider: "github",
      repository: "org/a",
      commitSha: sha,
      selectionRationale: "Mature.",
      adoptedPatterns: [
        { pattern: "Seat hold", evidence: [remoteRef], testEvidence: [testRef] },
        { pattern: "Refund queue", evidence: [remoteRef], testEvidence: [], untestedReason: "The reference has no refund test." },
      ],
      rejectedPatterns: [],
      localAdaptation: "Use the project's queue.",
    }],
    risks: [],
    readiness: "draft",
    readinessNotes: [],
  };
}

describe("evidence coverage", () => {
  test("counts the decisions, invariants and access boundaries as well as the modules and data entities", () => {
    // Rejects counting only the stack's bricks (modules and data entities), which would give 2 elements.
    const coverage = evidenceCoverage(plan(), { sources, excerpts });
    expect(coverage.designElements).toBe(5);
    expect([coverage.reference, coverage.localOnly, coverage.noSource]).toEqual([2, 1, 2]);
  });

  test("counts an element as reference when any excerpt it cites is remote, even after a local one", () => {
    // Rejects classifying an element by its first citation: Checkout cites a local excerpt before a remote one.
    const only = plan();
    only.decisions = [];
    only.design.dataModel.entities = [];
    only.design.invariants.items = [];
    only.design.accessControl.boundaries = [];
    expect(evidenceCoverage(only, { sources, excerpts })).toMatchObject({ designElements: 1, reference: 1, localOnly: 0, noSource: 0 });
  });

  test("counts an element that cites only excerpts the host never cut as citing no source, not as local", () => {
    // Rejects counting citations instead of the excerpts the host knows: Ticket cites E99, which no source backs.
    // parsePlan rejects an unknown excerpt ID, so in a run this happens only when the evidence passed in does not match.
    const only = plan();
    only.decisions = [];
    only.design.modules = [];
    only.design.invariants.items = [];
    only.design.accessControl.boundaries = [];
    expect(evidenceCoverage(only, { sources, excerpts })).toMatchObject({ designElements: 1, reference: 0, localOnly: 0, noSource: 1 });
  });

  test("counts adopted patterns that cite a reference test, not those with only an untested reason", () => {
    // Rejects counting every adopted pattern, which would give 2 of 2.
    expect(evidenceCoverage(plan(), { sources, excerpts })).toMatchObject({ adoptedPatterns: 2, adoptedPatternsWithReferenceTest: 1, adoptedPatternsWithReferenceTestPercent: 50 });
  });

  test("rounds each share to the nearest whole percent of its own total", () => {
    // Rejects truncation, which turns two of three into 66.
    const thirds = plan();
    thirds.decisions = [];
    thirds.design.dataModel.entities = [];
    thirds.design.accessControl.boundaries = [];
    thirds.design.invariants.items = [{ statement: "Local.", evidence: [localRef] }, { statement: "Also local.", evidence: [localRef] }];
    expect(evidenceCoverage(thirds, { sources, excerpts })).toMatchObject({ designElements: 3, referencePercent: 33, localOnlyPercent: 67, noSourcePercent: 0 });
  });

  test("gives null shares when there is nothing to count", () => {
    // Rejects dividing by zero, which gives NaN, and reporting 0% of nothing.
    const empty = plan();
    empty.decisions = [];
    empty.design.modules = [];
    empty.design.dataModel.entities = [];
    empty.design.invariants.items = [];
    empty.design.accessControl.boundaries = [];
    empty.referenceComparisons = [];
    expect(evidenceCoverage(empty, { sources, excerpts })).toEqual({
      designElements: 0,
      reference: 0,
      referencePercent: null,
      localOnly: 0,
      localOnlyPercent: null,
      noSource: 0,
      noSourcePercent: null,
      adoptedPatterns: 0,
      adoptedPatternsWithReferenceTest: 0,
      adoptedPatternsWithReferenceTestPercent: null,
    });
  });
});
