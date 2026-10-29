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

## Run in one live process

1. Pass the user's requirement in their words, plus facts they already stated. Point `--cwd` at the target project, or an empty directory for a new application:

   ```sh
   unshit "<requirement>" --cwd <project> --agent
   ```

2. Keep this one process alive with writable stdin while you talk to the user. A run takes several minutes and several model turns. Read stdout as JSONL, keep stdin open between replies, and do not start another run for the same project at the same time. `--agent` already enables JSONL; it cannot be combined with `--json` or `--install-skill`.
3. Progress and preview records describe the work. An `input_request` pauses at one gate with a host-issued `requestId` and `kind`. Respond only to that pending request, using its exact ID. One final `result` record ends the run.
4. Exit codes are `0` completed, `2` declined brief or preview, `124` model turn timeout, `130` cancelled or stdin ended, and `1` error. There is no timeout while waiting for the user's reply. A malformed, early, stale, duplicate or wrong-kind reply fails the run. To cancel, write `{"type":"cancel"}` on one line or send Ctrl+C.

## Reply to input requests

- `material_answers`: show the whole `questions` batch in chat, including each `id`, `question` and `whyMaterial`. Ask the user for the missing business decisions. Preserve their answers and send one line after every question has an answer:

  ```json
  {"type":"input_response","requestId":"<exact pending ID>","answers":{"<question ID>":"<user's answer>"}}
  ```

  Include exactly the requested question IDs, each with a nonempty string. Use facts the user already stated where they answer a question; ask them about the rest. Do not invent policies, roles or decisions.

- `brief_approval`: show the complete returned `brief` in chat. Include `brief.summary`, every item in `brief.requirements` with all its `observableAcceptance`, `outOfScope` and `assumptions`. Label each requirement with `origin`: for `stated`, quote `userWords` and say "you said"; for `inferred`, say "inferred". Ask for explicit approval of this brief. Only after the user approves this displayed brief, relay one line:

  ```json
  {"type":"input_response","requestId":"<exact pending ID>","approved":true}
  ```

- `preview_confirmation`: show the returned preview's stages, the repositories found, and the metadata exclusions with their reasons. Give the exact `pagePath` and revision. Use the full `preview` snapshot from this request, since ordinary preview updates contain only changes. Explain that search results are leads, not evidence. Ask for explicit confirmation to continue to ranking, tree checks, source reads and planning. Only after that confirmation, relay `approved: true` with this pending `requestId`.
- Approval of a brief does not confirm a later preview. Each displayed approval request needs its own explicit response from the user. The host records `via: "agent"`, the brief hash and receipt time; it cannot verify who approved it. You relay the user's decision.
- If the user declines a brief or preview, send `approved: false` with its pending ID. If they request edits, cancel this run, add their changes to the requirement in their words, and start a fresh run. Requests and replies are not persisted for resume. If the process or session is lost, start again and show the new requests for approval.

## When live stdin is unavailable

Run the same requirement in a visible interactive terminal without `--agent`, `--json` or `--jsonl`, or give the user that command. They answer, approve the brief and confirm the preview there. Relay the terminal output as needed; the user types `yes` at its prompts. Plain `--json` and `--jsonl` remain non-interactive: they return missing questions and an `answersFile`, or stop at the reference preview with exit 2. They do not provide a live approval channel. For an answers-file rerun, preserve its request context and use its exact path; the user controls `approveBrief`.

## When a model turn times out

The final result has `stage`, `limit` (`idle` or `total`) and `limitSeconds`. Tell the user which stage timed out. To retry, start a fresh run with a larger `--turn-timeout <seconds>` (30 to 3600; the default is 600, and a turn may run three times as long in total).

## Read the result

- Read the final `result` record. A completed result has `readiness`, `plan`, `research`, `gaps`, `sources` and `artifacts.reportPath`. Read and link that exact returned plan path; do not guess the newest run directory. The evidence is beside it in the returned `artifacts.evidenceDirectory`.
- Tell the user whether it is Ready or Draft and why, the selected reference repositories and why they were chosen, what the quality bar excluded, the material gaps and the task list.
- Give the user the plan's "Trusted, not checked" section and ask each note starting with "Open decision for". Do not settle these decisions yourself. Once the user settles one, add it to the requirement in their words and start a new run with new brief and preview approvals. Implement from the new plan.
- The plan's "Stages and references" section and `artifacts.previewPath` show each stage and its references, distinguishing search results, listed but unread files and source the host read. Answer questions about what a stage relied on from there.
- `artifacts.stackPath` draws modules and data entities as bricks and shows the repositories and cited code behind each brick.
- `research.selected` counts selected reference repositories. If `research.trustworthyReferenceFound` is false, no selected repository supplied production or test excerpts. Say plainly that the plan has no reference repository behind it.

## Implement from the plan

- Implement only when the user asks for it.
- Before you start, make sure the user has seen the "Trusted, not checked" section and has settled each open decision. Do not implement an acceptance condition whose decision is still open.
- Follow the plan's tasks in dependency order, with their acceptance conditions and verification steps.
- For each cited design decision, read the cited file in `.unshit/<run-id>/sources/` (pinned to a commit) and follow that pattern, adapted to the local project. Do not replace a cited pattern with an invented one. If you must deviate, tell the user why.
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
