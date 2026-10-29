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

  test("tells planners to name a rejected wrong implementation for each covered acceptance", () => {
    const plan = REFERENCE_PLAN_MODULES.planning.find((module) => module.path === "references/plan.md")!.text;
    expect(plan).toContain("For each acceptance condition that a verification method covers, name at least one wrong implementation the method must reject: one specific mistake in the planned code, such as a reversed comparison, a skipped state or permission check, or a missing write, and the failure the check reports on it. Pick mistakes that change the observable outcome. When the outcome is an error, make the check assert the exact error or message, because a check that accepts any error also passes on a mistake that raises a different one. Each named mistake, applied alone to the finished code, must make its check fail while the unmodified code passes. These mistakes are a handoff to the implementer's mutation runner: present them as planned, never as applied or run.");
  });

  test("asks research, planning and review to back adopted patterns with reference tests that exercise them", () => {
    const text = (phase: keyof typeof REFERENCE_PLAN_MODULES, modulePath: string): string => REFERENCE_PLAN_MODULES[phase].find((module) => module.path === modulePath)!.text;
    expect(text("research", "references/research.md")).toContain("For each pattern you may adopt, look for the comparator's own test that exercises that code; a test that only shares the domain does not support the pattern.");
    expect(text("planning", "references/plan.md")).toContain("- the reference comparison, with pinned source citations supporting consequential design choices, and for each adopted pattern the comparator test that exercises it or the reason none does;");
    expect(text("planning", "references/plan.md")).toContain("A reference test that an adopted pattern cites was read, not run. A verification that ports a reference test case names that test.");
    expect(text("review", "references/review.md")).toContain("A cited reference test that does not exercise the adopted pattern's code is an unsupported citation.");
  });

  test("tells the review phase to build a wrong implementation for each acceptance criterion", () => {
    const review = REFERENCE_PLAN_MODULES.review.find((module) => module.path === "references/review.md")!;
    expect(review.text).toContain("For each acceptance criterion, try to build a plausible wrong implementation that would pass every planned check for that criterion, including any mutant that a check names as rejected. Build the counterexample before you judge the checks; a persuasive explanation of why they suffice is not evidence.");
    expect(review.text).toContain("When only a business choice that the brief leaves open can rule the wrong implementation out, name that choice for the user instead of making it.");
  });

  test("leaves brief approval and the Draft it causes to the host in every module", () => {
    const text = (modulePath: string): string => REFERENCE_POLICY_INPUTS.find((file) => file.path === modulePath)!.text;
    expect(text("references/plan.md")).toContain("Otherwise mark the plan **Ready**. When a host program such as the unshit CLI runs this workflow, brief approval is the host's to enforce: the host keeps the plan **Draft** until a person approves the final requirements and acceptance criteria, so do not set shouldDraft or report a finding because the brief is not approved. Without such a host, keep the plan **Draft** until the user approves them.");
    expect(text("references/intake.md")).toContain("After the business decision gate passes, in an interactive terminal run the host shows the user the final requirements and acceptance criteria with these labels and asks for their approval before research starts. If they do not approve, the host stops with the brief so they can correct it. In other runs the host asks nothing before research and saves the brief in an answers file where the user can approve it for a rerun. The host keeps a plan built on a brief that nobody approved **Draft**. Without a host program such as the unshit CLI, show the user the final requirements and acceptance criteria with these labels yourself and ask for their approval before research starts.");
    expect(text("SKILL.md")).toContain("| Clarify scope and material decisions | [intake](references/intake.md) | The business decision gate has passed |\n");
    // No sentence of the rule pack leaves the approval, or the Draft it causes, to the model.
    for (const file of REFERENCE_POLICY_INPUTS) {
      for (const sentence of file.text.split(/(?<=\.)\s+|\n/)) {
        if (/approv/i.test(sentence)) expect(sentence).toContain("host");
      }
    }
  });

  test("tells intake to quote the user's words for each requirement and never to present an inferred one as said", () => {
    const intake = REFERENCE_PLAN_MODULES.intake.find((module) => module.path === "references/intake.md")!;
    expect(intake.text).toContain("Label every requirement with the user's own words that state it, copied exactly from the request or a confirmed answer, or mark it inferred when the user did not state it. Never present an inferred requirement as something the user said.");
  });

  test("leaves terminal and agent brief approval to the host in developer instructions", () => {
    expect(DEVELOPER_INSTRUCTIONS.split("\n")).toContain("- The host handles brief approval. When a run starts from an answers file in which the user approved the brief, the host uses that brief as approved. Otherwise, the host requests approval of the final requirements and acceptance criteria at an interactive terminal or through the opt-in agent protocol; the host cannot verify who approved them. In other runs the host asks nothing and keeps the plan Draft without approval. Do not ask for the host's brief approval as a material question.");
    // Every model session starts with these instructions, so none of their sentences may leave approval to the model.
    for (const sentence of DEVELOPER_INSTRUCTIONS.split(/(?<=\.)\s+|\n/)) {
      if (/approv/i.test(sentence)) expect(sentence).toContain("host");
    }
  });

  test("describes host code-search matches as location hints", () => {
    expect(DEVELOPER_INSTRUCTIONS).toContain("- The host may run grep.app code searches itself. A codeMatch, codeMatchedFiles, or codePatterns value only marks where to look; a file becomes evidence only after the host reads it at the pinned commit.");
  });
});
