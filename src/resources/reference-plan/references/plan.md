# Write a traceable implementation plan

Write in the user's language and default to a chat response. Save a file only when asked. Scale detail to the project, but make the plan actionable and reviewable. Include:

- scope, exclusions, actors, and primary workflows;
- the proposed architecture and module responsibilities, including important interfaces;
- necessary entities, relationships, invariants, and access rules;
- a dependency-ordered task list and a completion checklist;
- the reference comparison, with pinned source citations supporting consequential design choices;
- readiness, material assumptions, unresolved questions, and evidence gaps.

Give each material requirement a stable ID, for example `R1`, and map it to one or more tasks. Each task has a stable ID, observable outcome, dependencies, acceptance conditions, and a verification method. Show the links explicitly, for example: `R1 → T2 → acceptance A2; verify with V2`. Every material requirement must reach at least one task and verification method; every proposed task must support a requirement or a named operational need.

Use commands only when found in the local repository's scripts/configuration or the selected tool's official documentation. Cite or name their source. Mark commands or tests that need to be created as planned work; never present them as existing. Keep checks already performed separate from planned verification.

## Readiness

After the [business decision gate](intake.md) passes, set readiness to **Draft** when an assumption could change the design or evidence needed for a consequential decision is missing. Name the assumption or gap and the concrete step that would resolve it. Otherwise mark the plan **Ready**. When Draft reflects an evidence gap rather than unanswered business decisions, finish the detailed plan and identify the verification needed.

Continue according to the [execution scope](../SKILL.md). Unresolved gaps block only the work that depends on them.
