import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { parseCliArguments } from "../src/cli.ts";
import { SKILL_MARKER, UNSHIT_SKILL, defaultSkillTargets, installSkill } from "../src/skill-install.ts";
import { TRUSTED_SECTION_HEADING } from "../src/report.ts";
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
  test("describes one live agent process, matching replies and explicit user approval", () => {
    expect(UNSHIT_SKILL.startsWith("---\nname: unshit\ndescription: ")).toBe(true);
    expect(UNSHIT_SKILL.trimEnd().endsWith(SKILL_MARKER)).toBe(true);
    for (const text of [
      'unshit "<requirement>" --cwd "<project>" --agent',
      "Keep this one process alive with writable stdin",
      '"type":"input_response","requestId":"<exact pending ID>"',
      "show the whole `questions` batch",
      "Ask for explicit approval of this brief",
      "Only after the user approves this displayed brief",
      "Use the full `preview` snapshot from this request",
      "Each displayed approval request needs its own explicit response",
      "Requests and replies are not persisted for resume",
      "If the process or session is lost, start again",
      "When live stdin is unavailable",
      "Read and link that exact returned plan path",
    ]) expect(UNSHIT_SKILL).toContain(text);
  });

  test("describes a new directory per run, stdin fed from a file, and a waiter for the next request or a lost run", () => {
    for (const text of [
      "Each tool call starts a new shell, so write the run directory's literal path into every command",
      'd=$(mktemp -d "<project>/.unshit/agent-XXXXXX")',
      `tail -f "$d/in.jsonl" | (sh -c 'echo $PPID' > "$d/pid"; unshit "<requirement>" --cwd "<project>" --agent > "$d/out.jsonl"`,
      'echo $? > "$d/exit.code"; exec </dev/null; echo >> "$d/in.jsonl")',
      "the run is lost: tell the user and start a new run in a new directory",
      "Never type an agent-protocol reply into a terminal",
      "A waiter that waits only for the process to exit never ends",
      `[ "$(grep -c -E '"type":"(input_request|result)"' "$d/out.jsonl")" -gt "$n" ] && break; [ -s "$d/exit.code" ] && break; kill -0 "$(cat "$d/pid")" 2> /dev/null || break`,
      "When the waiter stops at its own time limit, start it again.",
      "End each of your turns during a run with one line for the user",
    ]) expect(UNSHIT_SKILL).toContain(text);
  });

  test("has the user see what the plan trusts and settle open decisions before implementation", () => {
    expect(UNSHIT_SKILL).toContain(`the plan's "${TRUSTED_SECTION_HEADING}" section`);
    expect(UNSHIT_SKILL).toContain(`each note starting with "${OPEN_DECISION_PREFIX}"`);
    expect(UNSHIT_SKILL).toContain("start a new run with new brief and preview approvals. Implement from the new plan.");
    expect(UNSHIT_SKILL).toContain('Before you start, make sure the user has seen the "Trusted, not checked" section and has settled each open decision.');
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
                  ...(["origin", "userWords", "observableAcceptance"] satisfies Array<keyof Requirement>),
      ...(["rejectsMutants"] satisfies Array<keyof VerificationMethod>),
      ...(["observedFailure"] satisfies Array<keyof PlannedMutant>),
      ...(["testEvidence"] satisfies Array<keyof ReferenceComparison["adoptedPatterns"][number]>),
    ];
    for (const field of fields) expect(UNSHIT_SKILL).toContain(`\`${field}`);
    for (const field of ["summary", "requirements", "outOfScope", "assumptions"] satisfies Array<keyof IntakeBrief>) {
      expect(UNSHIT_SKILL).toContain(field);
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
