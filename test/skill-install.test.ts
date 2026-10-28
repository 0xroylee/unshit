import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { parseCliArguments } from "../src/cli.ts";
import { SKILL_MARKER, UNSHIT_SKILL, defaultSkillTargets, installSkill } from "../src/skill-install.ts";
import { TRUSTED_SECTION_HEADING } from "../src/report.ts";
import type { AnswerRequestDocument } from "../src/storage.ts";
import { OPEN_DECISION_PREFIX } from "../src/workflow.ts";
import type { IntakeBrief, PlannedMutant, ReferenceComparison, Requirement, RequirementOrigin, RunOutcome, VerificationMethod } from "../src/types.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "unshit-skill-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runCli(argv: string[], home: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, path.join(repositoryRoot, "src", "cli.ts"), ...argv], {
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("unshit agent skill", () => {
  test("is a skill named unshit whose lines on exit codes, results and options match the CLI, ending with the installer marker", () => {
    expect(UNSHIT_SKILL.startsWith("---\nname: unshit\ndescription: ")).toBe(true);
    for (const line of [
      "- unshit needs network access (the GitHub API, Grep by Vercel code search and the Codex service). In a sandbox without network access, request permission to run it with network access. Do not retry it inside the sandbox.",
      "   unshit \"<requirement>\" --cwd <project> --json",
      "3. Exit codes: `0` completed, `2` stopped for answers, at the brief or at the reference preview, `124` a model turn timed out, `130` cancelled, `1` error.",
      "- The JSON result has `previewStop` (`unavailable`: no person could be asked; `declined`: the reply was not yes), `message` and `previewPath`: the page that lists each step of the run and the references it used. It has no `answersFile`.",
      "- The JSON result has `questions` (each with `id`, `question`, `whyMaterial`) and `answersFile`.",
      "- Write each answer into the `answers` object of `answersFile`, keyed by the question `id`. Keep the `request` object unchanged.",
      "- Run the same command again, with the same requirement text and `--cwd`, and add `--answers <answersFile>`.",
      "- The JSON result has `stage`, `limit` (`idle` or `total`) and `limitSeconds`.",
      "- Tell the user which stage timed out. To retry, run the same command again with a larger `--turn-timeout <seconds>` (30 to 3600; the default is 600, and a turn may run three times as long in total).",
      "- The JSON result has `readiness`, `plan`, `research`, `gaps`, `sources` and `artifacts.reportPath` (the Markdown plan). The evidence is under `<project>/.unshit/<run-id>/`: `plan.md`, `manifest.json` and `sources/`.",
      "- A run in a terminal prints no JSON result: its plan is `plan.md` in the newest `<project>/.unshit/<run-id>/` folder that has one.",
      "- `research.selected` is the number of reference repositories selected for the plan. If `research.trustworthyReferenceFound` is false, no selected repository supplied production or test excerpts: say so plainly, the plan has no reference repository behind it.",
    ]) {
      expect(UNSHIT_SKILL.split("\n")).toContain(line);
    }
    expect(UNSHIT_SKILL.trimEnd().endsWith(SKILL_MARKER)).toBe(true);
  });

  const onlyTheUserApproves = "- Only the user approves the brief. Never write `approveBrief: true` into `answersFile` yourself. Give the user the file path and let them set `approveBrief` to `true`, or let them run the same command without `--json` in a terminal and approve it when unshit asks.";
  const settledDecisionsPlanAgain = "- When the user settles an open decision, unshit must plan again with it, as the note says: the decision goes into the brief of the answers file and the user sets `approveBrief` to `true`, or you add it to the requirement text in their words and the user runs that command in a terminal without `--json` and approves the brief when unshit asks. You may write the decision into the brief for the user; never set `approveBrief` yourself. Implement from the new plan.";
  const approvedFileStaysApproved = "- If the plan came from an approved answers file, `approveBrief` there is already `true`, so the user approves a change by rereading the edited brief and saving it. If you wrote the decision into that brief, show the user the change and rerun only after they have read and accepted it.";
  const readyOnlyAfterApproval = "- A plan can be Ready only after the user approves its brief. In an interactive terminal, unshit shows the brief and asks for yes before the search; any other reply stops the run (exit code 2, `approvalRequested`) and saves the brief in `answersFile`. A run with `--json` does not ask and does not reach a plan: it stops at the reference preview.";
  const onlyTheUserConfirms = "4. A run with `--json` never gets past the reference preview: after the search it stops with exit code 2 and `previewStop`. To reach a plan, the run must be interactive: start the same command without `--json` in a terminal that the user can see and type in, or give the user the command to run there. The user answers the questions, approves the brief and confirms the preview in that terminal. You may relay what the terminal shows; only the user types `yes`.";

  test("leaves approval of the brief to the user and labels what the user said apart from what unshit inferred", () => {
    const lines = UNSHIT_SKILL.split("\n");
    for (const line of [
      "## When the user has not approved the brief yet",
      readyOnlyAfterApproval,
      "- Show the user the whole brief: `brief.summary`, each requirement in `brief.requirements` with its `observableAcceptance`, and the lists `brief.outOfScope` and `brief.assumptions`. Label a requirement whose `origin` is `stated` \"you said\" and quote its `userWords`; label one whose `origin` is `inferred` \"inferred\": unshit found no verbatim quote of the user's words for it. Ask the user whether this is what they want.",
      onlyTheUserApproves,
      "- After the user has set it, run the same command again with `--answers <answersFile>`. The user may edit the brief in `answersFile` before setting it. If the user does not approve, ask what should change, add it to the requirement text in their words, and start a new run without `--answers`.",
    ]) {
      expect(lines).toContain(line);
    }
    // No other line may tell an agent when or how to set approveBrief.
    expect(lines.filter((line) => line.includes("approveBrief"))).toEqual([onlyTheUserApproves, settledDecisionsPlanAgain, approvedFileStaysApproved]);
    // Nor approve the brief, or type yes at unshit's prompt, in the user's place without naming approveBrief.
    expect(lines.filter((line) => /approv|type yes|yourself/i.test(line))).toEqual([
      onlyTheUserConfirms,
      "- Ask the user these questions. They are business decisions: do not answer them yourself and do not invent policies or roles.",
      "## When the user has not approved the brief yet",
      readyOnlyAfterApproval,
      onlyTheUserApproves,
      "- After the user has set it, run the same command again with `--answers <answersFile>`. The user may edit the brief in `answersFile` before setting it. If the user does not approve, ask what should change, add it to the requirement text in their words, and start a new run without `--answers`.",
      "- To continue, run the same command in an interactive terminal, as in Run. A brief approved in an answers file does not confirm the preview.",
      "  - Each note in the plan that starts with \"Open decision for\". These are the user's to settle: ask them, and do not settle them yourself.",
      settledDecisionsPlanAgain,
      approvedFileStaysApproved,
    ]);
  });

  test("has the user see what the plan trusts and settle its open decisions before implementing", () => {
    for (const line of [
      "  - The plan's \"Trusted, not checked\" section: what the plan relies on that unshit did not check.",
      "  - Each note in the plan that starts with \"Open decision for\". These are the user's to settle: ask them, and do not settle them yourself.",
      settledDecisionsPlanAgain,
      approvedFileStaysApproved,
      "- Before you start, make sure the user has seen the \"Trusted, not checked\" section and has settled each open decision. Do not implement an acceptance condition whose decision is still open.",
    ]) {
      expect(UNSHIT_SKILL.split("\n")).toContain(line);
    }
    // The code renders the heading and the note prefix from these constants, so a rename that leaves the skill behind fails here.
    expect(UNSHIT_SKILL).toContain(`The plan's "${TRUSTED_SECTION_HEADING}" section`);
    expect(UNSHIT_SKILL).toContain(`Each note in the plan that starts with "${OPEN_DECISION_PREFIX}".`);
  });

  test("writes tests against the plan's named wrong implementations and the reference tests", () => {
    for (const line of [
      "- When an adopted pattern cites a reference test (`testEvidence`), read that test too and check the same behavior in your test.",
      "- Each planned verification names the wrong implementations it rejects (`rejectsMutants`, with ids such as `T1-V1-M1`). Write each test so that it fails on them.",
    ]) {
      expect(UNSHIT_SKILL.split("\n")).toContain(line);
    }
  });

  test("ends an implementation with a conformance report of the checks that actually ran", () => {
    const lines = UNSHIT_SKILL.split("\n");
    const eachWrongImplementation = "  - Each named wrong implementation (`T1-V1-M1` and so on): killed, survived or failed differently, each with the command you ran, or not run. It is killed only when the named test passed on your code and failed as its `observedFailure` describes with the wrong implementation applied. It survived when the named test still passed with it applied. It failed differently when the named test failed, but not as `observedFailure` describes: say how. That does not count as killed until you fix the test or correct the expected failure; report either change and why, and never rewrite the expected failure only to match the failure you saw. Apply each one in a scratch copy of the project or a separate git worktree, never in the user's working tree.";
    const survivors = "- A survivor means the test does not catch that bug. Before you call the task done, fix the test until it kills the wrong implementation, or report the survivor plainly.";
    for (const line of [
      "- When you finish, give the user a conformance report for each task:",
      eachWrongImplementation,
      "  - The verification commands you actually ran, each with its result. List the planned verifications you did not run separately, as not run. A manual check counts as run only when you or the user did it.",
      "  - Each adopted pattern and its reference test: followed, or why you deviated. If the plan gives a reason that the pattern has no reference test, repeat it.",
      survivors,
      "- Never call the implementation verified because the plan was Ready. Ready describes the plan before any code existed; only the checks you ran describe the code.",
    ]) {
      expect(lines).toContain(line);
    }
    // No other line may say when a wrong implementation counts as killed or what to do with a survivor.
    expect(lines.filter((line) => /killed|surviv/.test(line))).toEqual([eachWrongImplementation, survivors]);
  });

  test("names only fields that the run result and the plan carry", () => {
    const fields: string[] = [
      ...(["answersFile", "brief"] satisfies Array<keyof Extract<RunOutcome, { status: "completed" }>>),
      ...(["approvalRequested", "previewStop", "previewPath"] satisfies Array<keyof Extract<RunOutcome, { status: "needs_input" }>>),
      ...(["approveBrief"] satisfies Array<keyof AnswerRequestDocument>),
      ...(["origin", "userWords", "observableAcceptance"] satisfies Array<keyof Requirement>),
      ...(["rejectsMutants"] satisfies Array<keyof VerificationMethod>),
      ...(["observedFailure"] satisfies Array<keyof PlannedMutant>),
      ...(["testEvidence"] satisfies Array<keyof ReferenceComparison["adoptedPatterns"][number]>),
    ];
    for (const field of fields) expect(UNSHIT_SKILL).toContain(`\`${field}`);
    for (const field of ["summary", "requirements", "outOfScope", "assumptions"] satisfies Array<keyof IntakeBrief>) {
      expect(UNSHIT_SKILL).toContain(`\`brief.${field}\``);
    }
    for (const origin of ["stated", "inferred"] satisfies RequirementOrigin[]) expect(UNSHIT_SKILL).toContain(`\`${origin}\``);
  });

  test("installs into each target, then reports unchanged, and updates its own older copy", async () => {
    await withTemporaryDirectory(async (directory) => {
      const targets = [
        { agent: "claude" as const, skillsRoot: path.join(directory, "claude", "skills") },
        { agent: "codex" as const, skillsRoot: path.join(directory, "agents", "skills") },
      ];
      const first = await installSkill(targets);
      expect(first.map((result) => result.status)).toEqual(["installed", "installed"]);
      for (const result of first) {
        expect(await readFile(result.path, "utf8")).toBe(UNSHIT_SKILL);
        expect(await readdir(path.dirname(result.path))).toEqual(["SKILL.md"]);
      }

      const second = await installSkill(targets);
      expect(second.map((result) => result.status)).toEqual(["unchanged", "unchanged"]);

      await writeFile(first[0]!.path, `---\nname: unshit\ndescription: old\n---\n\nOld text.\n\n${SKILL_MARKER}\n`);
      const third = await installSkill(targets);
      expect(third.map((result) => result.status)).toEqual(["updated", "unchanged"]);
      expect(await readFile(first[0]!.path, "utf8")).toBe(UNSHIT_SKILL);
    });
  });

  test("keeps a skill that unshit did not install unless forced", async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = { agent: "custom" as const, skillsRoot: directory };
      const file = path.join(directory, "unshit", "SKILL.md");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "---\nname: unshit\ndescription: someone else's skill\n---\n");

      const refused = await installSkill([target]);
      expect(refused[0]!.status).toBe("failed");
      expect(refused[0]!.reason).toContain("--force");
      expect(await readFile(file, "utf8")).toContain("someone else's skill");

      const forced = await installSkill([target], { force: true });
      expect(forced[0]!.status).toBe("updated");
      expect(await readFile(file, "utf8")).toBe(UNSHIT_SKILL);
    });
  });

  test("does not follow a skill folder that is a symbolic link, and does not write over a file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const elsewhere = path.join(directory, "elsewhere");
      await mkdir(elsewhere);
      const linkedRoot = path.join(directory, "linked");
      await mkdir(linkedRoot);
      await symlink(elsewhere, path.join(linkedRoot, "unshit"));
      const linked = await installSkill([{ agent: "codex", skillsRoot: linkedRoot }]);
      expect(linked[0]!.status).toBe("skipped");
      expect(await readdir(elsewhere)).toEqual([]);

      const fileRoot = path.join(directory, "file");
      await mkdir(fileRoot);
      await writeFile(path.join(fileRoot, "unshit"), "not a folder");
      const blocked = await installSkill([{ agent: "claude", skillsRoot: fileRoot }]);
      expect(blocked[0]!.status).toBe("failed");
      expect(blocked[0]!.reason).toContain("exists and is not a folder");
      expect(await readFile(path.join(fileRoot, "unshit"), "utf8")).toBe("not a folder");

      const outside = path.join(directory, "outside.md");
      await writeFile(outside, "outside text");
      const fileLinkRoot = path.join(directory, "file-link");
      await mkdir(path.join(fileLinkRoot, "unshit"), { recursive: true });
      await symlink(outside, path.join(fileLinkRoot, "unshit", "SKILL.md"));
      const fileLink = await installSkill([{ agent: "claude", skillsRoot: fileLinkRoot }], { force: true });
      expect(fileLink[0]!.status).toBe("failed");
      expect(fileLink[0]!.reason).toContain("is not a regular file");
      expect(await readFile(outside, "utf8")).toBe("outside text");
    });
  });

  test("writes through a skills root that is a symbolic link", async () => {
    await withTemporaryDirectory(async (directory) => {
      const real = path.join(directory, "dotfiles-skills");
      await mkdir(real);
      const linkedRoot = path.join(directory, "skills");
      await symlink(real, linkedRoot);
      const results = await installSkill([{ agent: "claude", skillsRoot: linkedRoot }]);
      expect(results.map((result) => [result.status, result.path])).toEqual([["installed", path.join(linkedRoot, "unshit", "SKILL.md")]]);
      expect(await readFile(path.join(real, "unshit", "SKILL.md"), "utf8")).toBe(UNSHIT_SKILL);
    });
  });

  test("targets only the agents that exist in the home folder", async () => {
    await withTemporaryDirectory(async (home) => {
      expect(await defaultSkillTargets(home, {})).toEqual([]);

      await mkdir(path.join(home, ".codex"));
      expect(await defaultSkillTargets(home, {})).toEqual([
        { agent: "codex", skillsRoot: path.join(home, ".codex", "skills") },
        { agent: "codex", skillsRoot: path.join(home, ".agents", "skills") },
      ]);

      await mkdir(path.join(home, ".claude"));
      expect(await defaultSkillTargets(home, {})).toEqual([
        { agent: "claude", skillsRoot: path.join(home, ".claude", "skills") },
        { agent: "codex", skillsRoot: path.join(home, ".codex", "skills") },
        { agent: "codex", skillsRoot: path.join(home, ".agents", "skills") },
      ]);

      const claudeConfig = path.join(home, "custom-claude");
      const codexConfig = path.join(home, "custom-codex");
      await mkdir(claudeConfig);
      await mkdir(codexConfig);
      expect(await defaultSkillTargets(home, { CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexConfig })).toEqual([
        { agent: "claude", skillsRoot: path.join(claudeConfig, "skills") },
        { agent: "codex", skillsRoot: path.join(codexConfig, "skills") },
        { agent: "codex", skillsRoot: path.join(home, ".agents", "skills") },
      ]);
    });

    await withTemporaryDirectory(async (home) => {
      await mkdir(path.join(home, ".agents"));
      expect(await defaultSkillTargets(home, {})).toEqual([
        { agent: "codex", skillsRoot: path.join(home, ".agents", "skills") },
      ]);
    });
  });
});

describe("unshit --install-skill", () => {
  test("parses on its own and rejects planning arguments", () => {
    const parsed = parseCliArguments(["--install-skill", "--skill-dir", "/tmp/skills", "--force", "--json"]);
    expect(parsed).toMatchObject({ installSkill: true, skillDir: "/tmp/skills", force: true, json: true });
    for (const planning of [["build a ticketing system"], ["--cwd", "/tmp"], ["--out", "plan.md"], ["--answers", "answers.json"], ["--model", "a-model"], ["--effort", "low"], ["--turn-timeout", "60"]]) {
      expect(() => parseCliArguments(["--install-skill", ...planning])).toThrow(/runs on its own/);
    }
    expect(() => parseCliArguments(["--install-skill", "--jsonl"])).toThrow(/--json with --install-skill/);
    expect(() => parseCliArguments(["build a ticketing system", "--force"])).toThrow(/only with --install-skill/);
    expect(() => parseCliArguments(["build a ticketing system", "--skill-dir", "/tmp"])).toThrow(/only with --install-skill/);
    expect(parseCliArguments(["build a ticketing system"]).installSkill).toBe(false);
  });

  test("installs for the agents in HOME and prints one JSON result", async () => {
    await withTemporaryDirectory(async (home) => {
      await mkdir(path.join(home, ".claude"));
      await mkdir(path.join(home, ".codex"));
      const result = await runCli(["--install-skill", "--json"], home);
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as { status: string; skill: string; results: Array<{ agent: string; path: string; status: string }> };
      expect(output.status).toBe("ok");
      expect(output.skill).toBe("unshit");
      expect(output.results.map((entry) => [entry.agent, entry.status])).toEqual([["claude", "installed"], ["codex", "installed"], ["codex", "installed"]]);
      expect(await readFile(path.join(home, ".claude", "skills", "unshit", "SKILL.md"), "utf8")).toBe(UNSHIT_SKILL);
      expect(await readFile(path.join(home, ".codex", "skills", "unshit", "SKILL.md"), "utf8")).toBe(UNSHIT_SKILL);
      expect(await readFile(path.join(home, ".agents", "skills", "unshit", "SKILL.md"), "utf8")).toBe(UNSHIT_SKILL);
    });
  });

  test("exits 1 when a target fails, with the reason on stderr or in the JSON result", async () => {
    await withTemporaryDirectory(async (home) => {
      const custom = path.join(home, "my-skills");
      await mkdir(path.join(custom, "unshit"), { recursive: true });
      await writeFile(path.join(custom, "unshit", "SKILL.md"), "---\nname: unshit\ndescription: someone else's skill\n---\n");

      const plain = await runCli(["--install-skill", "--skill-dir", custom], home);
      expect(plain.exitCode).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain("was not installed by unshit; pass --force to replace it");

      const json = await runCli(["--install-skill", "--skill-dir", custom, "--json"], home);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ status: "error", skill: "unshit", results: [{ agent: "custom", status: "failed" }] });
    });
  });

  test("installs only into --skill-dir when it is given, even with agent folders in HOME", async () => {
    await withTemporaryDirectory(async (home) => {
      for (const folder of [".claude", ".codex", ".agents"]) await mkdir(path.join(home, folder));
      const custom = path.join(home, "my-skills");
      const result = await runCli(["--install-skill", "--skill-dir", custom, "--json"], home);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).results).toEqual([{ agent: "custom", path: path.join(custom, "unshit", "SKILL.md"), status: "installed" }]);
      for (const folder of [".claude", ".codex", ".agents"]) expect(await readdir(path.join(home, folder))).toEqual([]);
    });
  });

  test("fails with guidance when no agent folder exists, and honors --skill-dir", async () => {
    await withTemporaryDirectory(async (home) => {
      const none = await runCli(["--install-skill"], home);
      expect(none.exitCode).toBe(1);
      expect(none.stderr).toContain("--skill-dir");
      const noneJson = await runCli(["--install-skill", "--json"], home);
      expect(noneJson.exitCode).toBe(1);
      expect(JSON.parse(noneJson.stdout)).toMatchObject({ status: "error" });
      expect(JSON.parse(noneJson.stdout).message).toContain("--skill-dir");

      const custom = path.join(home, "my-skills");
      const explicit = await runCli(["--install-skill", "--skill-dir", custom], home);
      expect(explicit.exitCode).toBe(0);
      expect(explicit.stdout).toContain(path.join(custom, "unshit", "SKILL.md"));
      expect(await readFile(path.join(custom, "unshit", "SKILL.md"), "utf8")).toBe(UNSHIT_SKILL);
    });
  });
});

describe("install.sh", () => {
  const script = path.join(repositoryRoot, "install.sh");

  async function runScript(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(["sh", script, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stdout, stderr };
  }

  test("is an executable POSIX shell script whose help names the three skill folders", async () => {
    expect((await stat(script)).mode & 0o111).toBe(0o111);
    const syntax = Bun.spawnSync(["sh", "-n", script]);
    expect(syntax.exitCode).toBe(0);
    const help = await runScript(["--help"]);
    expect(help.exitCode).toBe(0);
    for (const folder of ["~/.claude/skills/unshit", "$CODEX_HOME/skills/unshit (default ~/.codex/skills)", "~/.agents/skills/unshit", "--no-skill"]) {
      expect(help.stdout).toContain(folder);
    }
  });

  test("rejects an unknown option and an option without its value before it checks any tool", async () => {
    const unknown = await runScript(["--bogus"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toBe("error: unknown option: --bogus (see --help)\n");
    const missing = await runScript(["--ref"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toBe("error: --ref needs a value\n");
  });

  test("is documented as a script to run from a clone, without a pipe from the network", async () => {
    const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
    expect(readme).toContain("git clone https://github.com/0xroylee/unshit.git");
    expect(readme).toContain("./install.sh --dev");
    for (const text of [readme, await readFile(script, "utf8")]) {
      expect(text).not.toContain("raw.githubusercontent.com/0xroylee/unshit");
    }
  });
});
