---
name: unshit
description: Plan a software feature or new application with the unshit CLI before implementing it, so the work follows vetted, commit-pinned reference code instead of invented code. Use when the user asks to build, plan, or design an app or feature (for example "build a ticketing system" or "plan refunds for orders") and wants a reference-backed plan, or asks to implement from an unshit plan.
---

# unshit

`unshit` turns a plain-language requirement into an implementation plan. The plan is grounded in the local project and in public reference repositories that passed a quality bar (license, test files, stars, recent activity, age, not archived, not a fork). Every important claim cites a file and line range pinned to a commit. unshit writes a plan; it does not write the application.

## Before you run it

- Use `unshit`. If it is not installed, use `unshit-dev` (development install). If neither exists, tell the user to install it with `install.sh` from the unshit repository.
- unshit uses the user's Codex login. If it reports a login problem, ask the user to run `codex login`.
- unshit needs network access (the GitHub API, Grep by Vercel code search and the Codex service). In a sandbox without network access, request permission to run it with network access. Do not retry it inside the sandbox.
- `GITHUB_TOKEN` is optional and raises GitHub API limits. Never print its value.

## Run

1. Pass the user's requirement in their words, plus facts they already stated. Point `--cwd` at the project that the plan is for (an empty folder for a new application):

   ```sh
   unshit "<requirement>" --cwd <project> --json
   ```

2. A run takes several minutes and several model turns. Run it in the background or with a long timeout. Do not start a second run for the same project at the same time.
3. Exit codes: `0` completed, `2` needs answers, `124` a model turn timed out, `130` cancelled, `1` error.

## When it needs answers (exit code 2)

- The JSON result has `questions` (each with `id`, `question`, `whyMaterial`) and `answersFile`.
- Ask the user these questions. They are business decisions: do not answer them yourself and do not invent policies or roles.
- Write each answer into the `answers` object of `answersFile`, keyed by the question `id`. Keep the `request` object unchanged.
- Run the same command again, with the same requirement text and `--cwd`, and add `--answers <answersFile>`.

## When the user has not approved the brief yet

- A plan can be Ready only after the user approves its brief. With `--json` unshit cannot ask, so it finishes the plan as Draft, and the JSON result has `answersFile` and no `briefApproval`. When unshit cannot write the answers file, the result has no `answersFile`: tell the user, and run the same command again to get one.
- Show the user the whole brief: `brief.summary`, each requirement in `brief.requirements` with its `observableAcceptance`, and the lists `brief.outOfScope` and `brief.assumptions`. Label a requirement whose `origin` is `stated` "you said" and quote its `userWords`; label one whose `origin` is `inferred` "inferred": unshit found no verbatim quote of the user's words for it. Ask the user whether this is what they want.
- Only the user approves the brief. Never write `approveBrief: true` into `answersFile` yourself. Give the user the file path and let them set `approveBrief` to `true`, or let them run the same command without `--json` in a terminal and approve it when unshit asks.
- After the user has set it, run the same command again with `--answers <answersFile>`. The user may edit the brief in `answersFile` before setting it. If the user does not approve, ask what should change, add it to the requirement text in their words, and start a new run without `--answers`.

## When a model turn times out (exit code 124)

- The JSON result has `stage`, `limit` (`idle` or `total`) and `limitSeconds`.
- Tell the user which stage timed out. To retry, run the same command again with a larger `--turn-timeout <seconds>` (30 to 3600; the default is 600, and a turn may run three times as long in total).

## Read the result

- The JSON result has `readiness`, `plan`, `research`, `gaps`, `sources` and `artifacts.reportPath` (the Markdown plan). The evidence is under `<project>/.unshit/<run-id>/`: `plan.md`, `manifest.json` and `sources/`.
- A run in a terminal prints no JSON result: its plan is `plan.md` in the newest `<project>/.unshit/<run-id>/` folder that has one.
- Tell the user:
  - Ready or Draft, and why.
  - The selected reference repositories and why they were chosen.
  - What the quality bar excluded.
  - The material gaps and the task list.
  - The plan's "Trusted, not checked" section: what the plan relies on that unshit did not check.
  - Each note in the plan that starts with "Open decision for". These are the user's to settle: ask them, and do not settle them yourself.
- When the user settles an open decision, unshit must plan again with it, as the note says: the decision goes into the brief of the answers file and the user sets `approveBrief` to `true`, or you add it to the requirement text in their words and the user runs that command in a terminal without `--json` and approves the brief when unshit asks. You may write the decision into the brief for the user; never set `approveBrief` yourself. Implement from the new plan.
- If the plan came from an approved answers file, `approveBrief` there is already `true`, so the user approves a change by rereading the edited brief and saving it. If you wrote the decision into that brief, show the user the change and rerun only after they have read and accepted it.
- `research.selected` is the number of reference repositories selected for the plan. If `research.trustworthyReferenceFound` is false, no selected repository supplied production or test excerpts: say so plainly, the plan has no reference repository behind it.

## Implement from the plan

- Implement only when the user asks for it.
- Before you start, make sure the user has seen the "Trusted, not checked" section and has settled each open decision. Do not implement an acceptance condition whose decision is still open.
- Follow the plan's tasks in dependency order, with their acceptance conditions and verification steps.
- For each cited design decision, read the cited file in `.unshit/<run-id>/sources/` (pinned to a commit) and follow that pattern, adapted to the local project. Do not replace a cited pattern with an invented one. If you must deviate, tell the user why.
- Each citation in the plan carries a `quote` that the model copied from the lines it cites. When `quoteInExcerpt` is true, unshit found the quote in those lines but did not check that it supports the claim: read it in those lines, not on its own. When `quoteInExcerpt` is false, plan.md says why after the citation: read those lines before you rely on the claim, and tell the user which tasks rest on it.
- When an adopted pattern cites a reference test (`testEvidence`), read that test too and check the same behavior in your test.
- Each planned verification names the wrong implementations it rejects (`rejectsMutants`, with ids such as `T1-V1-M1`). Write each test so that it fails on them.
- Check the license of each selected repository in the plan's repository screening. Treat code from GPL or AGPL repositories as a pattern to follow; do not copy it verbatim into a project with a different license.
- If the plan is Draft, resolve its gaps first or tell the user which tasks depend on them.
- Verification commands marked "to create" do not exist yet. Create them as part of the work.
- When you finish, give the user a conformance report for each task:
  - Each named wrong implementation (`T1-V1-M1` and so on): killed, survived or failed differently, each with the command you ran, or not run. It is killed only when the named test passed on your code and failed as its `observedFailure` describes with the wrong implementation applied. It survived when the named test still passed with it applied. It failed differently when the named test failed, but not as `observedFailure` describes: say how. That does not count as killed until you fix the test or correct the expected failure; report either change and why, and never rewrite the expected failure only to match the failure you saw. Apply each one in a scratch copy of the project or a separate git worktree, never in the user's working tree.
  - The verification commands you actually ran, each with its result. List the planned verifications you did not run separately, as not run. A manual check counts as run only when you or the user did it.
  - Each adopted pattern and its reference test: followed, or why you deviated. If the plan gives a reason that the pattern has no reference test, repeat it.
- A survivor means the test does not catch that bug. Before you call the task done, fix the test until it kills the wrong implementation, or report the survivor plainly.
- Never call the implementation verified because the plan was Ready. Ready describes the plan before any code existed; only the checks you ran describe the code.

<!-- installed by unshit; update with: unshit --install-skill -->
