# Write a traceable implementation plan

Write in the user's language and default to a chat response. Save a file only when asked. Scale detail to the project, but make the plan actionable and reviewable. Include:

- scope, exclusions, actors, and primary workflows;
- the proposed architecture and module responsibilities, including important interfaces;
- necessary entities, relationships, invariants, and access rules;
- a dependency-ordered task list and a completion checklist;
- the reference comparison, with pinned source citations supporting consequential design choices, and for each adopted pattern the comparator test that exercises it or the reason none does;
- readiness, material assumptions, unresolved questions, and evidence gaps.

Give each material requirement a stable ID, for example `R1`, and map it to one or more tasks. Each task has a stable ID, observable outcome, dependencies, acceptance conditions, and a verification method. Show the links explicitly, for example: `R1 → T2 → acceptance A2; verify with V2`. Every material requirement must reach at least one task and verification method; every proposed task must support a requirement or a named operational need.

For each acceptance condition that a verification method covers, name at least one wrong implementation the method must reject: one specific mistake in the planned code, such as a reversed comparison, a skipped state or permission check, or a missing write, and the failure the check reports on it. Pick mistakes that change the observable outcome. When the outcome is an error, make the check assert the exact error or message, because a check that accepts any error also passes on a mistake that raises a different one. Each named mistake, applied alone to the finished code, must make its check fail while the unmodified code passes. These mistakes are a handoff to the implementer's mutation runner: present them as planned, never as applied or run.

Use commands only when found in the local repository's scripts/configuration or the selected tool's official documentation. Cite or name their source. Mark commands or tests that need to be created as planned work; never present them as existing. Keep checks already performed separate from planned verification. A reference test that an adopted pattern cites was read, not run. A verification that ports a reference test case names that test.

## Readiness

After the [business decision gate](intake.md) passes, set readiness to **Draft** when an assumption could change the design or evidence needed for a consequential decision is missing. Name the assumption or gap and the concrete step that would resolve it. Otherwise mark the plan **Ready**. When a host program such as the unshit CLI runs this workflow, brief approval is the host's to enforce: the host keeps the plan **Draft** until a person approves the final requirements and acceptance criteria, so do not set shouldDraft or report a finding because the brief is not approved. Without such a host, keep the plan **Draft** until the user approves them. When Draft reflects an evidence gap rather than unanswered business decisions, finish the detailed plan and identify the verification needed.

Continue according to the [execution scope](../SKILL.md). Unresolved gaps block only the work that depends on them.
