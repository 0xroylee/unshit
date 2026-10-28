import { describe, expect, test } from "bun:test";
import { UNKNOWN_PREVIEW_REFERENCE, candidateReference, changedStages, createPreviewRecorder } from "../src/preview.ts";
import type { PreviewReference, RepositoryCandidate } from "../src/types.ts";

function candidate(id: string, fullName: string): RepositoryCandidate {
  return { id, provider: "github", fullName, description: "", defaultBranch: "main", webUrl: `https://github.com/${fullName}` };
}

const source: PreviewReference = { key: "S1", kind: "source", classification: "evidence", label: "src/index.ts", provider: "local", path: "src/index.ts", sha256: "a".repeat(64), snapshotPath: "sources/S1.txt" };

describe("stage and reference projection", () => {
  test("lists every stage of a run in run order, each pending until the run sets it", () => {
    const preview = createPreviewRecorder().snapshot();
    // Written out here, not taken from PREVIEW_STAGES, so a missing or reordered stage fails.
    expect(preview.stages.map((stage) => stage.id)).toEqual([
      "intake",
      "answer_gate",
      "brief_rebuild",
      "brief_approval",
      "local_baseline",
      "repository_search",
      "metadata_screening",
      "preview_confirmation",
      "candidate_ranking",
      "repository_trees",
      "candidate_selection",
      "file_selection",
      "source_reads",
      "evidence_requests",
      "plan",
      "review",
      "readiness",
      "save",
    ]);
    expect(new Set(preview.stages.map((stage) => stage.status))).toEqual(new Set(["pending"]));
    expect(preview.references).toEqual([]);
  });

  test("gives a stage only the references recorded for it, and lists only references some stage uses", () => {
    const recorder = createPreviewRecorder();
    recorder.register([candidateReference(candidate("C1", "org/one")), candidateReference(candidate("C2", "org/two")), source]);
    recorder.record("repository_search", "found", ["C1"]);
    recorder.setStatus("repository_search", "completed");
    const preview = recorder.snapshot();
    expect(preview.stages.find((stage) => stage.id === "repository_search")?.uses).toEqual([{ relation: "found", key: "C1" }]);
    expect(preview.stages.filter((stage) => stage.id !== "repository_search").flatMap((stage) => stage.uses)).toEqual([]);
    expect(preview.references.map((reference) => reference.key)).toEqual(["C1"]);
  });

  test("keeps the first classification of a key when the same key is registered again", () => {
    const recorder = createPreviewRecorder();
    recorder.register([candidateReference(candidate("C1", "org/one"))]);
    recorder.register([{ ...candidateReference(candidate("C1", "org/one")), classification: "evidence" }]);
    recorder.record("repository_search", "found", ["C1"]);
    expect(recorder.snapshot().references).toEqual([candidateReference(candidate("C1", "org/one"))]);
  });

  test("rejects a key that no host record registered", () => {
    const recorder = createPreviewRecorder();
    recorder.register([source]);
    expect(() => recorder.record("plan", "cited", ["E999"])).toThrow(UNKNOWN_PREVIEW_REFERENCE);
    expect(recorder.snapshot().stages.find((stage) => stage.id === "plan")?.uses).toEqual([]);
  });

  // Ported from the comparator's trace projection tests (langgenius/dify, E19): a projection keeps each record's
  // identity, drops duplicate attempts, and is a separate read copy.
  test("keeps keys across revisions, collapses a repeated key, and returns copies that do not change the run's state", () => {
    const recorder = createPreviewRecorder();
    recorder.register([candidateReference(candidate("C1", "org/one")), candidateReference(candidate("C2", "org/two"))]);
    recorder.record("repository_search", "found", ["C1", "C2", "C1"]);
    const first = recorder.snapshot();
    expect(first.stages.find((stage) => stage.id === "repository_search")?.uses.map((use) => use.key)).toEqual(["C1", "C2"]);
    first.stages.find((stage) => stage.id === "repository_search")!.uses.push({ relation: "found", key: "C9" });
    first.references[0]!.label = "changed";
    const unchanged = recorder.snapshot();
    expect(unchanged.revision).toBe(first.revision);
    expect(unchanged.stages.find((stage) => stage.id === "repository_search")?.uses.map((use) => use.key)).toEqual(["C1", "C2"]);
    expect(unchanged.references[0]!.label).toBe("github:org/one");
    recorder.setStatus("repository_search", "completed");
    const next = recorder.snapshot();
    expect(next.revision).toBe(first.revision + 1);
    expect(next.references.map((reference) => reference.key)).toEqual(["C1", "C2"]);
  });

  test("reports a stage as changed when one reference replaces another at the same count", () => {
    const recorder = createPreviewRecorder();
    recorder.register([candidateReference(candidate("C1", "org/one")), candidateReference(candidate("C2", "org/two"))]);
    recorder.setStatus("candidate_ranking", "completed");
    recorder.record("candidate_ranking", "ranked", ["C1"]);
    const before = recorder.snapshot();
    recorder.record("candidate_ranking", "ranked", ["C2"]);
    const after = recorder.snapshot();
    expect(changedStages(after, before).map((stage) => stage.id)).toEqual(["candidate_ranking"]);
    expect(changedStages(after, after)).toEqual([]);
    expect(changedStages(after).map((stage) => stage.id)).toHaveLength(18);
  });
});
