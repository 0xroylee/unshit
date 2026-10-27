# Review an existing plan or system

First read the brief, existing plan, cited references, and the actual artifacts in scope. Inspect the local project guidance and code; use indexed CodeGraph for structural questions when available and verify important conclusions in source. For every comparator claim being evaluated, resolve the cited commit and inspect the actual relevant files there. When source retrieval or comparator inspection is needed, read [research](research.md).

Report findings only when they connect a brief requirement or reference-based design claim to concrete evidence. Each finding states the requirement or claim, the observed plan or system behavior, the source location, and the consequence. Call out unsupported citations, stale or unpinned reference claims, traceability gaps, missing acceptance or verification, and material divergence between plan and implementation when present. A cited reference test that does not exercise the adopted pattern's code is an unsupported citation. State uncertainty where retrieval failed.

For each acceptance criterion, try to build a plausible wrong implementation that would pass every planned check for that criterion, including any mutant that a check names as rejected. Build the counterexample before you judge the checks; a persuasive explanation of why they suffice is not evidence. When only a business choice that the brief leaves open can rule the wrong implementation out, name that choice for the user instead of making it.

For consequential additions or duplicated native capabilities, read and apply [design](design.md). Recommend removal only with evidence that the required behavior and quality remain covered.

Order findings by impact and give a practical improvement task for each. Read [plan](plan.md) when checking requirement-to-task-to-verification coverage and final readiness. End with the updated coverage map and Draft or Ready status. Separate checks actually performed from checks still needed, then follow the execution scope in `SKILL.md` for authorized improvement work.
