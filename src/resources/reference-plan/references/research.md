# Inspect the baseline and comparators

## Establish the local baseline

Inspect the relevant application entry points, module boundaries, data model, dependencies, repository guidance, and existing tests or CI configuration. Read project manifests and scripts to learn the actual commands and conventions. Use CodeGraph impact information where indexed, then verify source directly when results are missing, inconsistent, or stale.

When integrating with an existing platform, inspect its supported server/API, SDK, and CLI interfaces before choosing an integration architecture. Verify which required capabilities it already provides and which interface fits the user's workflow and constraints. Native support with a thin adapter is the starting point; choose a wrapper or replacement only for a concrete gap or constraint. An SDK example alone does not establish the best integration surface.

Separate observations from proposals. Record which checks you actually performed. Reading a test, test filename, README, or CI workflow is evidence that it exists or is configured; it does not mean the test was run or passed.

## Select and inspect comparators

Choose only repositories that can answer a concrete design question raised by the clarified requirements. Deeply inspect at most three; fewer is appropriate when evidence is sufficient. Prefer repositories with a close domain and workflow fit, then consider stack fit and maintainability.

Prioritize tools already connected in the session. If they cannot provide needed evidence, use free public source retrieval such as public GitHub or GitLab APIs and file pages; do not make paid services or new integration setup a prerequisite. Inspect live tool schemas before calling them and use only tools that are actually exposed. Keep repository discovery separate from code-pattern search:

- The connected grep.app tool searches **literal source patterns**. Its current tool is `searchGitHub` with a required `query`; use it after forming a plausible code token or snippet, with repository, path, language, or regex filters as useful. It is not a natural-language repository-discovery tool.
- The connected DeepWiki tools can navigate or summarize a named GitHub repository. Their current names are `ask_wiki_question`, `read_wiki_contents`, and `read_wiki_structure`, each requiring a repository name. Use their output to find likely files or concepts, never as sole evidence for how code works.
- Public GitLab Projects and Repository Files APIs are an optional free fallback when relevant. Keep the same repository cap and source-verification standard.

If a source cannot be retrieved, make one focused retry using a more direct source path or query, then try an available fallback such as another connected source tool or public GitLab APIs. If it remains unavailable, identify the source, fallback attempted, and conclusion that remains unverified. Continue with unaffected planning work and record material gaps for the [readiness check](plan.md#readiness). Never replace missing evidence with a plausible guess.

For each selected candidate, resolve and record an exact commit SHA before making implementation claims. At that SHA, inspect the relevant production implementation and tests, plus applicable dependency manifest or lockfile, test and CI configuration, and license. Follow tool results to the actual files; search snippets, generated documentation, README claims, and wiki summaries are leads, not implementation evidence. If a file or category is absent or inaccessible, say so. Never invent a commit, file, license, or test result.

Support claims with direct links to the inspected files pinned to that commit, with line locations when the source supports them. Use GitHub links of the form `https://github.com/OWNER/REPO/blob/COMMIT/path#Lx-Ly` or the equivalent commit-pinned GitLab file link. Stars and popularity are background only.

Judge each candidate against the clarified requirements: domain and workflow fit, stack fit, behavior shown by implementation and tests, necessary complexity, maintenance signals, and verified license. Distinguish tests you read from tests that were actually run. For each pattern you may adopt, look for the comparator's own test that exercises that code; a test that only shares the domain does not support the pattern. Record which useful patterns it offers, which should be rejected, and what adaptation the local system needs. Use these findings in the design phase to select one coherent architecture.
