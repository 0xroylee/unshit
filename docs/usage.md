# Usage

English · [简体中文](usage.zh-CN.md)

The full guide: install options, terminal and scripted runs, how a run works, reference repositories, options, results and development. The [README](../README.md) has the short version.

## Install

You need git, Bun 1.3 or later, and a logged-in Codex CLI (`codex login`).

```sh
git clone https://github.com/0xroylee/unshit.git
cd unshit

# Production install: builds unshit from a clean clone of --ref (main by default) and installs it in ~/.local/bin
./install.sh

# Development install: installs dependencies in this repository, runs the checks and installs unshit-dev, which runs the source directly
./install.sh --dev
```

After installing, both modes run `--install-skill`, which installs the unshit agent skill: if the Claude Code directory exists, to `~/.claude/skills/unshit` (or `$CLAUDE_CONFIG_DIR/skills/unshit`); if the Codex directory exists, to `$CODEX_HOME/skills/unshit` (default `~/.codex/skills`); if the Codex directory or `~/.agents` exists, also to `~/.agents/skills/unshit`. Then, when you ask Claude Code or Codex to "use unshit to plan a ticketing system", the agent can run unshit as the skill describes. The skill requires the agent to: pass clarifying questions to you; give you the whole requirement summary (overview, requirements and their acceptance criteria, out-of-scope items and assumptions) to approve, marked "you said" or "inferred", and not approve it for you; show you the plan's "Trusted, not checked" section and its open decisions first, have unshit plan again once the open decisions are settled, and then implement from the new plan and the pinned reference code; after implementing, report per task whether each named wrong implementation was killed, survived, failed differently than expected, or was not run (it applies wrong implementations in a temporary copy of the project or a separate git worktree and does not change your working tree; a wrong implementation that fails differently than expected does not count as killed; if it changes a test or an expected failure, it must say what it changed and why, and it must not change an expectation only to match the failure it saw), which verification commands it actually ran and their results, and whether it followed each reference pattern; when there is a surviving mutant, first strengthen the test or report it truthfully, and only then does the task count as done. All of these are the skill's requirements for the agent, and unshit cannot enforce them. unshit also cannot tell who changed `approveBrief` in the answers file, and the report's "Brief approval" and "Trusted, not checked" sections say so. A Ready plan does not mean the implementation is verified. `./install.sh --help` lists `--ref`, `--bin-dir`, `--no-skill` and other options.

You can also install or update the skill on its own:

```sh
unshit --install-skill                     # agents already on this machine
unshit --install-skill --skill-dir <dir>   # a skills directory you specify
```

## Quick start

For a new application, use an empty directory; for an existing project, run unshit in the project directory (or point to it with `--cwd`).

```sh
mkdir my-app && cd my-app
unshit "Build an event ticketing system for one team, with ticket sales, refunds and entry check-in"
```

When you run it in a terminal:

1. unshit first asks the material questions (for example, who can issue refunds), and you answer them directly.
2. It shows the whole brief: each requirement and its acceptance criteria, the out-of-scope items and the assumptions. It marks which parts you said and which are inferred. It continues only when you type `yes`.
3. It searches for reference repositories, then shows each step of the run with the references it used so far, in the terminal and in `.unshit/<run-id>/preview.html`. It continues only when you type `yes`.
4. It screens and reads reference code, generates the plan, and then reviews it once; as each later step finishes, the terminal and the page show the references it used. A run usually takes 15 to 30 minutes.
5. It prints the plan to the terminal and saves it as `.unshit/<run-id>/plan.md`.

When you run it from a script or an agent (`--json`, `--jsonl`), unshit does not stop to wait for input:

1. When there are business questions, it returns `needs_input` with exit code 2 and writes the answers file `answers.json`. Fill in the answers under `answers` in the file, then run again with the same requirement and directory, adding `--answers <answers.json>`.
2. After the search, the run stops at the reference preview: it writes `.unshit/<run-id>/preview.html`, returns `needs_input` with `previewStop: "unavailable"` and `previewPath`, and exits with code 2. Only a run in an interactive terminal continues past the preview, so run the same command in a terminal and type `yes` at the brief and at the preview.

Exit codes: 0 completed, 2 needs answers, approval or confirmation of the reference preview, 124 a model turn timed out, 130 interrupted, 1 error.

Once you have the plan, ask the agent in Claude Code or Codex to implement it (the install already set up the unshit skill). The agent implements the tasks in order, reads the pinned source that the plan cites, and reports whether the tests caught each named wrong implementation.

## How it works

1. **Ask** (Codex): Extracts requirements and acceptance criteria from your requirement. It asks questions only when a business decision would affect scope, permissions or acceptance.
2. **Approve the brief** (you): The host records the SHA-256 of the brief at approval. A plan without this approval can only be `Draft`.
3. **Local project** (host): Reads a limited number of text files in the target directory, excludes generated files and private key files, and redacts credential values. It records the scripts that already exist in the project as available verification commands.
4. **Search and preview** (host, then you): Builds GitHub repository queries from the domain terms in the brief and searches for literal code patterns with Grep by Vercel; when GitHub has no qualifying candidate, it searches GitLab instead. Search results are only leads, not evidence. The host then shows each step with the references it used, in the terminal and in `.unshit/<run-id>/preview.html`, and starts ranking, tree checks, reads and planning only after you type `yes`.
5. **Screen references** (host and Codex): The metadata bar excludes repositories that do not qualify; the model ranks the repositories that pass it; the host reads their trees at the pinned commit in that order and checks for test files and a license; the model picks at most three of the repositories that pass these checks as references.
6. **Pinned reads** (host): The model picks files from the real tree, and the host reads them at the pinned commit and records the SHA-256, line numbers and excerpts. The model can also request a limited amount of additional source.
7. **Plan** (Codex): Tasks in dependency order, acceptance criteria and verification methods; each verification names the wrong implementations it must reject, and important design choices cite excerpts. The host validates IDs, citations, coverage and dependencies.
8. **Independent review** (Codex, fresh session): For each acceptance criterion, the reviewer tries to construct a wrong implementation that passes every planned check. Material findings from the first review go into the one bounded repair, followed by one more review.
9. **Save** (host): Writes `plan.md`, `manifest.json` and the source snapshots atomically to `.unshit/<run-id>/`.

The plan stays `Draft` in any of these cases: there is a material gap; the latest review still has a blocking or material finding; a business decision is still open; validation did not pass; nobody approved the brief. Otherwise it is `Ready`. Wrong implementations that the review after the repair still finds are only listed in the report and do not affect `Ready`. `Ready` describes the plan before any code is written and does not mean the implementation has been verified.

## Reference repositories

unshit aims to base the plan on mature, tested, actively maintained public code instead of designing it from nothing.

How it finds candidates:

- **GitHub repository search**: The host builds queries from the brief, limited to repositories that are not archived and not forks, and relaxes them in three tiers: at least 200 stars and a push within one year, at least 50 stars and within two years, at least 20 stars and within three years.
- **Grep code search**: The host searches public code for the literal code patterns in the brief, and repositories with hits also become candidates; inside the selected repositories, it then uses Grep to locate the relevant files. Each run makes at most 12 Grep requests and stops using Grep after the first failure; Grep requests carry no token at all.
- **GitLab**: When GitHub has no qualifying candidate, the host falls back to the official GitLab API.

The quality bar: a license, at least 20 stars, a push within 36 months, created at least 180 days ago, not archived, not a fork, and test files. When GitHub reports `NOASSERTION` (it cannot identify the license), the root directory must have a standard license file.

How the plan uses them:

- The "Reference comparison" section gives, for each selected repository, the pinned commit, the reason for choosing it, the patterns to adopt and to reject, and how to adapt them to the local project.
- Each adopted pattern cites a source excerpt from that repository at that commit, and the reference test that uses this code (read, not run); when there is no such test, the plan says why.
- The "Repository screening" section lists why each candidate was selected, rejected by the model, or excluded by the quality bar.
- The "Trusted, not checked" section states what the plan relies on but the host did not check, for example that the commit is the latest commit on the default branch rather than a release, and that the reference tests were not run.
- When no reference repository is selected, the plan states plainly that it has no reference repository behind it.
- When implementing, adapt the cited patterns. Treat code from GPL or AGPL repositories only as a pattern reference, and do not copy it directly into a project with a different license.

## Run from source

You need Bun and a logged-in Codex CLI. For a record of the verified environments, see the [verification report](verification.md) (in Chinese).

```sh
bun install
bun run check
bun run build
./dist/unshit "Build an event ticketing system for one team"
```

The compiled `dist/unshit` contains the Bun runtime and the planning rules. You can put this file on your PATH; when it runs, it still needs to find `codex` on this machine.

During development you do not need to build; you can run the source directly:

```sh
bun run dev "Build an event ticketing system for one team" --cwd ../my-project
```

`bun run dev` runs in the repository root, so use `--cwd` to point to the target project; relative paths in `--cwd` and `--answers` resolve against the repository root, and relative paths in `--out` resolve against `--cwd`. To run the source directly from any directory, use `unshit-dev`, which `./install.sh --dev` installs.

## Usage

```sh
# Use an existing project's conventions, dependencies and scripts as the baseline
./dist/unshit "Add a refund flow for orders" --cwd ../my-project

# Choose the plan file
./dist/unshit "Build an event ticketing system for one team" --out ./ticketing-plan.md

# A single JSON result, for scripts to read
./dist/unshit "Build an event ticketing system for one team" --json

# JSONL progress events and the final result
./dist/unshit "Build an event ticketing system for one team" --jsonl

# Supply clarifying answers in a non-interactive call
./dist/unshit "build a ticketing system" --answers ./answers.json --json

# A model turn times out only after 15 minutes in a row with no activity at all; the default is 10 minutes
./dist/unshit "Build an event ticketing system for one team" --turn-timeout 900
```

By default, unshit inherits the Codex model configuration. `--model` and `--effort` can override these settings for this planning run; the current Codex version determines the supported values. Reading public code needs no extra credentials by default; an existing `GITHUB_TOKEN` or `GITLAB_TOKEN` can be used for the matching service's API quota.

Each model turn times out when Codex shows no activity at all for 10 minutes in a row; even with constant activity, a turn can run at most 3 times this limit, 30 minutes by default. `--turn-timeout <seconds>` sets the idle limit, from 30 to 3600, and the total limit becomes 3 times that. When the brief rebuild, candidate ranking, evidence request, plan repair or review repair turn times out, the run continues with that turn's existing failure handling and records a gap; when the review after the review repair times out, the plan stays `Draft`, and the reason says that no completed review covers the repaired plan; when any other turn times out, the run ends, returns `timed_out` and saves a checkpoint.

When material questions are unanswered, an interactive terminal asks them. In non-interactive mode, unshit returns `needs_input`, the question IDs and `answersFile`, with exit code 2. Fill in the `answers` object in the generated file, with the question IDs from the file as keys and the answer text as values, keep the `request` context, and call again with the same prompt and directory. unshit checks the file against the prompt, directory and rule version, so old answers are not applied to new questions. The exit code is 124 when a model turn times out, 130 on cancellation, and 1 when the run cannot complete.

Once the brief is final (the rebuilt brief when there are answers; the intake brief, with the answers as context, when the rebuild fails; the intake brief when there are no questions), an interactive terminal shows the whole brief before unshit scans the local project and searches for reference repositories: the overview, each requirement R* with its acceptance criteria A*, the out-of-scope items and the assumptions. Each requirement is marked with its origin: `you said: "…"` quotes the user's exact words from the requirement text or a confirmed answer, and `inferred` means it was inferred. The run continues only on `yes` (in any letter case, with optional leading and trailing whitespace), and the host records this approval: the SHA-256 of the brief, `via: "tty"` and the time. The host only knows that someone typed `yes` in the terminal and cannot tell who; the report's "Brief approval" and "Trusted, not checked" sections both say so. Any other input ends the run: it returns `needs_input` with `approvalRequested` true and `questions` empty, exits with code 2, and writes an answers file that contains the editable brief without IDs, the existing answers and `approveBrief: false`. If you press Ctrl+C at this prompt or at a question, or input ends while unshit is asking, the run ends as `interrupted` with exit code 130; if input ends between two questions, the run likewise ends as `interrupted` at the next question.

With `--json` or `--jsonl`, or when stdin or stderr is not a terminal, unshit does not ask for approval, and the run stops at the reference preview after the search (see the next paragraph), so it writes no plan. To approve a brief in a file, reply with anything other than `yes` at the brief prompt: unshit saves the brief in the answers file described above. After you read the brief and edit it if needed, set `approveBrief` to `true` and run again in a terminal with the same prompt and directory plus `--answers`. The file must have both `brief` and `approveBrief` or neither, and `approveBrief` can only be `true` or `false`; otherwise reading fails. Approving the brief does not replace answering the questions: every question in `request` must have an answer in `answers`; otherwise reading fails and lists the IDs of the unanswered questions. The host validates the brief again under the intake rules (the brief must not contain `materialQuestions`; reading fails if it has this key), renumbers R* and A*, determines the origins again, and then uses this brief and the answers in the file directly, with no further intake, answers or rebuild; the approval is recorded as `via: "answers_file"`, with the time the host read the file. The host cannot tell who changed `approveBrief` to `true`, and the report's "Brief approval" and "Trusted, not checked" sections both state this plainly. When `approveBrief` is `false`, the brief in the file has no effect, and the rerun starts from intake as before. The host decides the origin: the model gives, for each requirement, a passage of the user's own words (`userWords`) or null; only when this passage, after NFKC and whitespace normalization, is at least 4 code points long and appears, case-sensitively, in the requirement text (or in a confirmed answer) is the requirement labeled as the user's words; otherwise it is labeled `inferred`. Inferred requirements are listed in one informational gap and do not make the plan `Draft`.

After the search, and before candidate ranking, the host writes `.unshit/<run-id>/preview.html` and, in a terminal, prints every step of the run with its status and the references it used: the repositories the search found, how many the metadata bar passed and which it excluded, with its reasons, and the steps still pending. It then asks for `yes` (in any letter case, with optional leading and trailing whitespace); only then do candidate ranking, tree checks, source reads and planning start. Any other reply ends the run: it returns `needs_input` with `previewStop: "declined"`, `message` and `previewPath`, exits with code 2 and writes no plan. A run with `--json` or `--jsonl`, or when stdin or stderr is not a terminal, stops at the same point with `previewStop: "unavailable"`. An approved brief does not confirm the preview, and no flag or answers file field does, so only a run in an interactive terminal continues past it; a stop at the preview writes no answers file. After the confirmation, each later step updates the page and prints its references before the next step starts: the candidates supplied to the ranking turn and the ones it ranked, the repositories tree checked, selected or rejected, the files selected and how many files were offered, the sources read, the excerpts supplied to the evidence-request turn and the sources and excerpts it added, and the excerpts supplied to the plan and review turns and the ones they cite. The terminal gives the repositories that passed the metadata bar and the references supplied to a model turn only as counts; the page and the plan list each one. With `--jsonl`, each update is a `{"type":"preview"}` line with the steps that changed. Each reference keeps its class: a search result is a lead, not evidence; a listed commit or file was not read; evidence is source the host read and hashed, or an excerpt it cut from that source. The page links a source snapshot only after the host has written it from the bytes it read, after redaction. When the page cannot be written, the run ends with `Could not save workflow preview.`; when a snapshot cannot be written, it ends with `Could not publish workflow preview sources.`, and the page still shows the last revision that was written. The final page, the plan's "Stages and references" section and the manifest's `preview` carry the same revision.

## Results and evidence

By default, results are saved in `.unshit/<run-id>/` in the target directory, with `preview.html`, the stage-and-reference page. The plan file contains the scope, the confirmed business answers, the brief's approval record or a note that it was not approved, the origin label of each requirement, the out-of-scope items, the module and data design, tasks in dependency order, acceptance scenarios, verification methods, and the reasons for adopting or rejecting reference patterns; its "Stages and references" section lists every step of the run with the references it used. Each adopted reference pattern must also cite excerpts of that reference repository's own tests, to show which test uses this code; when there is no such test, it gives the reason, and a pattern can have only one of the two (at most 6 test excerpts, or a reason of at most 700 characters). A cited excerpt must come from the same repository and the same commit, and from a file that the host recorded as a test file when it read it. Under the pattern, the report writes `Reference test (read, not run)` or `No reference test`: reference tests are only read, not run; the "Trusted, not checked" section gives the number of distinct reference test excerpts cited (an excerpt cited more than once counts once) and says that the host identifies test files by path name only. When none of the adopted patterns cites a reference test, a material gap is recorded and the plan stays `Draft`; this gap also says that the host identifies test files by path name only and that a reference test it cannot recognize by its path name cannot be cited. Each important citation points to a file and line numbers that were actually read; remote citations are pinned to a commit. The initial requirement summary and the final scope are labeled separately, and decisions made through answers are saved in both the report and the manifest; a run that starts from an approved answers file has no intake turn, its scope section says `Approved brief (from the answers file)`, and there is no initial summary.

Each verification method must also name at least one wrong implementation for each acceptance criterion it covers: one specific mistake the planned code could make, and the failure the check reports on that mistake. The same goes for manual checks. Each wrong implementation can only point to an acceptance criterion that this verification covers; a verification has at most 24 of them, and the mistake and failure texts are at most 500 characters each. If they are missing or invalid, the run goes through one plan repair; if they are still invalid after the repair, the run ends with an error, as with any other validation failure. The host numbers them in the form `T1-V1-M1` and does not use the IDs the model gives. plan.md lists them one by one under each verification (`Must fail on …`), and each task's verifications are followed by a `Done when` sentence: when each wrong implementation is put into the finished code on its own, its check must fail, and the unmodified code passes all checks. unshit does not apply these wrong implementations and does not run any check; they are left for the implementer to check with their own mutation testing tool. The "Trusted, not checked" section gives the number of wrong implementations and says so, and "Checks performed" states that the host checked that each verification names a wrong implementation for each acceptance criterion it covers.

The report's "Trusted, not checked" section comes after "Checks performed" and lists what the plan relies on but the host did not check. Each selected reference repository gets one line: `provider:repository@commit`, the star count, the last push (last activity for GitLab) and the creation date, and when the creation date is unknown, the repository still passes the quality bar and the line says so too; that the commit is the latest commit on the default branch at the time of this run, not a release or tag (when no commit was resolved, it says so); the number of test paths, judged by file name, in the tree listing the host received (when the listing was truncated, a separate gap records it, and this number is only a lower bound); how many implementation files and test files the host read, and that it ran none of them; and whether the license evidence comes from GitHub's SPDX metadata or from a root license file (the host does not identify which license the file contains), and when no evidence was recorded, it says so too. For GitLab repositories, the line also notes that the search results have no archived or fork status. When no reference repository is selected, this section states that the plan has no reference repository behind it. Every report also has four lines: the model writes the claims next to citations, and the host only checks that the excerpt IDs exist and that the excerpts of a reference comparison come from that repository's pinned commit (cited reference tests must also come from files that the host read as tests), then replaces the IDs with the line numbers the host recorded; local source is identified by the SHA-256 of its content as read in this run, after credential redaction, with no commit; the independent review is a fresh session of the same model; the surviving mutants that the review reports, and the review reporting none, are both only the review model's reasoning: unshit did not apply or run any of them, and a review that reports none does not show that the plan's checks reject every wrong implementation. Three more lines appear when they apply: when the plan names wrong implementations, their number, and that the model wrote them and unshit applied none of them and ran no check; when adopted patterns cite reference tests, the number of distinct reference test excerpts, that the host identifies test files by path name only and read these tests without running them, and that planning and review judge whether a test uses the adopted code; when the brief was approved, whether the approval came from `yes` typed in the terminal or from `approveBrief: true` in the answers file, and that in both cases the host cannot tell who it was.

The evidence manifest and the source snapshots are saved with the plan. Source reads, existing test files and checks that actually ran are recorded separately. When there is a material finding or an evidence gap, or nobody approved the brief, the result stays `Draft`; with full coverage, a passing review and an approved brief, it is marked `Ready`. Only the host judges approval: without an approval, the host keeps the plan `Draft`; the plan and review prompts state the approval status the host recorded and ask the model not to mark the plan Draft because of a missing approval, and the review not to report it as a problem; the host does not check whether the model complies. The review prompt asks the reviewer to try, for each acceptance criterion A*, to construct a wrong implementation that would still pass every planned check covering that criterion; the reviewer must also check the wrong implementations that verifications name for rejection, report one in the same way when its check would still pass on it, and report one that is equivalent to a correct implementation as a material finding. The reviewer gives counterexamples first instead of arguing that the checks are already enough. The host does not check whether the reviewer does this. Wrong implementations reported by the first review that need no business decision go into the one bounded repair as material findings against their requirement R*; such wrong implementations that the latest review still reports are only listed in that review's record and do not keep the plan `Draft`. Those that only a business decision by the user can rule out are recorded as `Open decision for A*`, with the original text of that acceptance criterion (the brief in the answers file has no A* IDs); they are not given to the model to repair, and the plan stays `Draft`. The steps given depend on how the brief was approved: for a run that nobody approved, which saved an answers file, write the decision into its brief, set `approveBrief` to true and run again with `--answers` (if the answers file could not be written and was not saved, first run the same command again to get one); for a run approved in the terminal, which saved no answers file, run again and reply with anything other than yes at the approval prompt, and unshit saves the brief in an answers file, which you then edit as in the previous case; for a run that started from an approved answers file, write the decision into the brief in that same file and then pass it with `--answers`; `approveBrief` in this file is already true, so rereading and saving the edited brief is what approves the change. The report lists these wrong implementations under each review. `survivingMutants` is only advisory and does not fail the run: the host treats a blank `decisionNeeded` as null, drops items whose `acceptanceId` is not an A* ID in the brief, items it cannot use and items after the 12th, and writes each drop into the plan and the manifest as an informational gap. When the repair passes validation but the review after it does not complete, the plan stays `Draft`, and the reason says that no completed review covers the repaired plan; the first review's findings and the wrong implementations that need no business decision are no longer written as Draft reasons for the repaired plan; open decisions reported by any review are still Draft reasons.

Before sending local files to the model, unshit replaces single-line values that look like credentials, such as `apiKey = "..."` or a token that starts with `ghp_`, with `[redacted by unshit]`. A valid JSON file is still valid JSON after redaction, and the scripts in `package.json` stay readable. The file is still read, its line numbers do not change, the saved snapshot and hash match the redacted content, and an informational gap is recorded. Files that contain a private key block, and valid JSON files whose member names contain likely credential values, are excluded entirely, and a material gap is recorded.

For public reference repositories, the host first builds GitHub search conditions from the domain terms and topics found at intake, then relaxes them step by step by star count and last push time. Search results first go through checks of stars, age, activity, archived status and forks; before a repository enters the shortlist, test files must also be found in its tree at the pinned commit, and a license must be confirmed: an SPDX license that GitHub recognizes, or a root license file. GitHub returns `NOASSERTION` when it found a license file but could not identify it, and a license file must then be found in the root directory; when there are several, standard names such as `LICENSE`, `LICENSE.txt` and `COPYING` come first, `LICENSE-*` is only a fallback, and the evidence read uses the same file. The screening criteria, query log, repository signals and exclusion reasons are saved in the report and the manifest. When no reference repository meets the conditions, the report marks this clearly and the plan stays `Draft`.

When more candidates pass the metadata bar than there are tree check slots, 8 by default, the model first ranks up to 12 of them by description, topics and code hits, and the host checks trees in that order; if the ranking fails or times out, the host falls back to its own keyword ranking and records an informational gap. Keyword ranking counts whole words only, and plurals count as hits; generic words such as `code` and `reference`, and code patterns that are ordinary words, have lower weight. Responses over the size limit are not retried. `research.shortlisted` is the number of repositories that passed the tree check, and `research.selected` is the number the model selected; `research.trustworthyReferenceFound` is true only when at least one selected repository supplied implementation or test source excerpts.

A reference repository's file list is ranked by the domain terms of the requirement, with slots reserved for test files and implementation files. Source reads still have their own size limit; full trees use a higher response limit. For GitHub, `treeTruncated` uses the truncation flag the provider returns; for GitLab, the host also marks the tree as truncated when it reaches the 25-page limit and there is still a next page.

At intake, the model also gives 1–4 code patterns, such as `OrderRefund` and `refund_amount`. The host searches for these patterns literally with Grep by Vercel; the model thread itself still cannot call any tool. Repositories with hits are added to the candidate list: the host fetches their stars, dates and licenses with one GitHub search that has several `repo:` qualifiers, and they then go through the same quality bar. Hits in example, sample and documentation directories do not count. After the tree check at the pinned commit, the host searches within each repository again for at most two patterns, and keeps only hits whose repository name matches exactly and whose path exists in the pinned tree. These files go to the front of the file list. When excerpts are chosen, lines that contain these patterns score higher in every file (local files included). Grep results only help locate files; evidence is still read at the pinned commit. A whole run sends at most 12 Grep requests; after the first failure, the run sends no more Grep requests, and the rest of the run continues as usual. When a response has the wrong format, the gap message says which kind: no readable JSON-RPC response, a JSON-RPC error, a tool error, or a result with neither hits nor a no-results notice; when the response headers have a valid media type or the error has an integer error code, the message includes them too. As long as any candidate repository passes the quality bar, this failure is recorded as an informational gap; when no candidate passes, it is recorded as a material gap, like other search gaps. The code patterns are sent to Grep by Vercel.

After the files are read and before the plan is written, the model can request up to 8 additions based on the excerpts it already has: the definition of a name in a file already read, a line range of a file already read, or up to 6 files from the list of unread files. First-round excerpts are at most 220,000 characters, and the additions and the first round together stay within 260,000 characters; items that do not fit or are invalid are recorded as informational gaps. If this turn fails or times out, the plan uses the first-round excerpts.

Progress shows the actual stage. Human-readable progress goes to stderr, and the JSON result goes to stdout; in JSONL mode, both events and the result are JSON, one object per line.

## Development and verification

```sh
bun run dev "<requirement>" --cwd <target project>   # runs the source directly
bun run check                                        # typecheck and tests
bun run build                                        # compiles dist/unshit
```

The protocol, the requirement gates, source validation, failure handling and machine output are tested through public interfaces with fixtures. Real-login and model smoke tests are recorded separately, so that test fixtures are not mistaken for verification against the real services.

- [Approved requirements and acceptance criteria](specs/unshit.md)
- [Implementation structure and pinned source references](architecture.md)
- [Actual verification results and limits](verification.md) (in Chinese)

`reference-plan` uses one entry file and five modules that are read on demand:

```text
reference-plan/
  SKILL.md
  references/
    intake.md    requirement and business-decision gates
    research.md  local baseline, reference repositories and source evidence
    design.md    minimal design, reuse of native capabilities, and tradeoffs
    plan.md      tasks, acceptance, verification and Draft / Ready
    review.md    review of an existing plan or system
```

The CLI embeds the [entry file and modules](../src/resources/reference-plan/SKILL.md). The native thread's shared instructions contain only the entry file and the host constraints; each turn then supplies the module for its stage, continuing the Codex session history. A change to the entry file or any module updates the rule-pack hash, and answers files from an older version must be generated again with the new version; the host constraints and the unshit agent skill do not count toward this hash. The rules for named wrong implementations, reference test citations, brief approval and surviving mutants changed the four modules intake, research, plan and review, so answers files generated by earlier versions are all rejected and must be generated again. An ordinary skill invocation also reads the modules under the conditions in the entry file.

Planning prefers to reuse what the project and the platform already have. A new module, store or abstraction must explain the concrete need, the gap in existing capabilities, and why a simpler option is not enough.

## Diagrams and credits

- The flow diagram is drawn from [Hairline](https://hairline.lucasmarkes.com/figures) line figures (`@lucasmarkes/hairline` 0.5.1, MIT license, © Lucas Marques). Hairline draws SVG with a script in the browser; [`docs/images/how-it-works.mjs`](images/how-it-works.mjs) draws these figures in headless Chrome and writes the computed styles as attributes, which gives static SVGs that need no script. When the steps change, edit `STEPS` in the script and regenerate: run `npm install @lucasmarkes/hairline playwright-core` in any directory, then run `node docs/images/how-it-works.mjs <that directory>` (Google Chrome must be installed).
- Code search uses [Grep by Vercel](https://grep.app).
