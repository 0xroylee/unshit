import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEVELOPER_INSTRUCTIONS,
  REFERENCE_PLAN_MODULES,
  REFERENCE_POLICY_HASH,
  REFERENCE_POLICY_INPUTS,
  computeReferencePolicyHash,
  referencePlanPrompt,
} from "../src/instructions.ts";
import { writeAnswersTemplate } from "../src/storage.ts";

describe("modular reference-plan guidance", () => {
  test("shares the bundled entrypoint without eagerly loading reference modules", () => {
    const entrypoint = REFERENCE_POLICY_INPUTS.find((file) => file.path === "SKILL.md");
    expect(entrypoint).toBeDefined();
    expect(DEVELOPER_INSTRUCTIONS).toContain(entrypoint!.text);
    for (const module of REFERENCE_POLICY_INPUTS.filter((file) => file.path !== "SKILL.md")) {
      expect(DEVELOPER_INSTRUCTIONS).not.toContain(module.text.trim());
    }
  });

  test("bundles every canonical path and hashes the bytes with their paths", () => {
    expect(REFERENCE_POLICY_INPUTS.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/intake.md",
      "references/research.md",
      "references/design.md",
      "references/plan.md",
      "references/review.md",
    ]);
    expect(computeReferencePolicyHash(REFERENCE_POLICY_INPUTS)).toBe(REFERENCE_POLICY_HASH);

    const changedModule = REFERENCE_POLICY_INPUTS.map((file) => file.path === "references/plan.md"
      ? { ...file, text: `${file.text}\nA policy change.` }
      : file);
    expect(computeReferencePolicyHash(changedModule)).not.toBe(REFERENCE_POLICY_HASH);
  });

  test("uses the bundled policy hash in the saved answer request context", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "unshit-reference-policy-"));
    try {
      const answersPath = await writeAnswersTemplate({ cwd, requirement: "Build a refund service.", questions: [] });
      const document = JSON.parse(await readFile(answersPath, "utf8")) as { request: { referencePolicySha256: string } };
      expect(document.request.referencePolicySha256).toBe(computeReferencePolicyHash(REFERENCE_POLICY_INPUTS));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("injects only the modules assigned to the active phase", () => {
    const expectedPaths = {
      intake: ["references/intake.md"],
      research: ["references/research.md"],
      planning: ["references/design.md", "references/plan.md"],
      review: ["references/design.md", "references/plan.md", "references/review.md"],
    } as const;

    for (const [phase, expected] of Object.entries(expectedPaths) as Array<[keyof typeof expectedPaths, readonly string[]]>) {
      const prompt = referencePlanPrompt("TURN REQUEST", phase);
      expect(REFERENCE_PLAN_MODULES[phase].map((module) => module.path)).toEqual([...expected]);
      expect(prompt).toContain("TURN REQUEST");
      for (const module of REFERENCE_POLICY_INPUTS) {
        if (expected.includes(module.path)) expect(prompt).toContain(module.text.trim());
        else expect(prompt).not.toContain(module.text.trim());
      }
    }
  });

  test("describes host code-search matches as location hints", () => {
    expect(DEVELOPER_INSTRUCTIONS).toContain("- The host may run grep.app code searches itself. A codeMatch, codeMatchedFiles, or codePatterns value only marks where to look; a file becomes evidence only after the host reads it at the pinned commit.");
  });
});
