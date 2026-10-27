import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { briefSha256, editableBrief, inferredRequirementGaps, isBriefApproval, renderBriefForApproval } from "../src/brief-approval.ts";
import { parseApprovedBrief, parseIntake } from "../src/model-schema.ts";

const requirementText = "Build sign-in. You only get a token with the right password.";
const brief = parseIntake({
  summary: "Sign-in tokens.",
  requirements: [
    { description: "Issue a token only for the right password.", userWords: "You only get a token with the right password.", observableAcceptance: ["A wrong password gets no token."] },
    { description: "Lock the account after five failures.", userWords: null, observableAcceptance: ["The sixth try is refused."] },
    { description: "Log every sign-in.", userWords: null, observableAcceptance: ["A sign-in is logged."] },
  ],
  outOfScope: ["Single sign-on."],
  assumptions: ["Passwords are already hashed."],
  materialQuestions: [],
  researchQueries: ["token sign-in"],
  domainTerms: ["sign-in"],
  topicSlugs: [],
  codePatterns: ["issueToken"],
}, [requirementText]);

describe("brief approval", () => {
  test("hashes the editable brief, so new IDs keep the hash and an edited acceptance changes it", () => {
    const roundTrip = parseApprovedBrief(editableBrief(brief), brief.materialQuestions, [requirementText]);
    expect(roundTrip).toEqual(brief);
    expect(JSON.stringify(editableBrief(brief))).not.toContain("\"id\"");
    expect(briefSha256(brief)).toBe(createHash("sha256").update(JSON.stringify(editableBrief(brief)), "utf8").digest("hex"));
    const renumbered = { ...brief, requirements: brief.requirements.map((requirement, index) => ({ ...requirement, id: `R${index + 7}` })) };
    expect(briefSha256(renumbered)).toBe(briefSha256(brief));
    const edited = editableBrief(brief);
    edited.requirements[0]!.observableAcceptance[0] = "A wrong password gets an error message.";
    expect(briefSha256(parseApprovedBrief(edited, [], [requirementText]))).not.toBe(briefSha256(brief));
  });

  test("reads a requirement without userWords, as a person may write it in the answers file, as inferred", () => {
    const edited = editableBrief(brief);
    const { userWords: _removed, ...withoutWords } = edited.requirements[0]!;
    const approved = parseApprovedBrief({ ...edited, requirements: [withoutWords] }, [], [requirementText]);
    expect(approved.requirements).toEqual([{ id: "R1", description: "Issue a token only for the right password.", observableAcceptance: [{ id: "A1", description: "A wrong password gets no token." }], origin: "inferred" }]);
  });

  test("shows every requirement with its label and its acceptance criteria before approval", () => {
    const text = renderBriefForApproval(brief);
    expect(text).toContain("Final brief:\nSign-in tokens.\n");
    expect(text).toContain("R1 (you said: \"You only get a token with the right password.\"): Issue a token only for the right password.\n  A1: A wrong password gets no token.\n");
    expect(text).toContain("R2 (inferred): Lock the account after five failures.\n  A2: The sixth try is refused.\n");
    expect(text).toContain("Out of scope:\n- Single sign-on.");
    expect(text).toContain("Assumptions:\n- Passwords are already hashed.");
  });

  test("approves only yes, in any letter case and with surrounding whitespace", () => {
    expect(isBriefApproval("yes")).toBe(true);
    expect(isBriefApproval("  YES \n")).toBe(true);
    for (const reply of ["", "y", "yes please", "no", "ok"]) expect(isBriefApproval(reply)).toBe(false);
  });

  test("names the inferred requirements in one informational gap", () => {
    expect(inferredRequirementGaps(brief)).toEqual([{
      kind: "validation",
      material: false,
      message: "Inferred requirements (no quote of the user's words was found in the requirement or the confirmed answers): R2, R3.",
    }]);
    expect(inferredRequirementGaps({ ...brief, requirements: [brief.requirements[0]!] })).toEqual([]);
  });
});
