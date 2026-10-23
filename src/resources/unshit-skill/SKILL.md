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

## When a model turn times out (exit code 124)

- The JSON result has `stage`, `limit` (`idle` or `total`) and `limitSeconds`.
- Tell the user which stage timed out. To retry, run the same command again with a larger `--turn-timeout <seconds>` (30 to 3600; the default is 600, and a turn may run three times as long in total).

## Read the result

- The JSON result has `readiness`, `plan`, `research`, `gaps`, `sources` and `artifacts.reportPath` (the Markdown plan). The evidence is under `<project>/.unshit/<run-id>/`: `plan.md`, `manifest.json` and `sources/`.
- Tell the user:
  - Ready or Draft, and why.
  - The selected reference repositories and why they were chosen.
  - What the quality bar excluded.
  - The material gaps and the task list.
- `research.selected` is the number of reference repositories selected for the plan. If `research.trustworthyReferenceFound` is false, no selected repository supplied production or test excerpts: say so plainly, the plan has no reference repository behind it.

## Implement from the plan

- Implement only when the user asks for it.
- Follow the plan's tasks in dependency order, with their acceptance conditions and verification steps.
- For each cited design decision, read the cited file in `.unshit/<run-id>/sources/` (pinned to a commit) and follow that pattern, adapted to the local project. Do not replace a cited pattern with an invented one. If you must deviate, tell the user why.
- Check the license of each selected repository in the plan's repository screening. Treat code from GPL or AGPL repositories as a pattern to follow; do not copy it verbatim into a project with a different license.
- If the plan is Draft, resolve its gaps first or tell the user which tasks depend on them.
- Verification commands marked "to create" do not exist yet. Create them as part of the work.

<!-- installed by unshit; update with: unshit --install-skill -->
