---
name: reference-plan
description: Create minimal, evidence-backed, traceable software implementation plans using local code and a small set of comparable repositories, or review an existing reference-based plan or system against its brief and artifacts. Use before implementation when requirements, architecture, or reference choices need resolution, or when asked for this focused review.
---

# Reference plan

Produce a reviewable plan grounded in the user's brief, the local repository, and verified source evidence.

For planning or review alone, finish with the requested plan or findings. When implementation is already explicitly authorized, continue through the appropriate implementation workflow within that scope without requesting the same authorization again.

## Choose the mode

- **Plan** when the user asks what to build, how to build it, or asks for a reference-informed implementation plan. A software brief such as "build a ticketing system" supplies the subject of the plan; apply the execution scope above when deciding whether to continue into implementation.
- **Review** only when the user asks to assess an existing plan or system. Compare that plan or implementation with the supplied brief, cited references, and actual artifacts. Return actionable, source-backed findings and an ordered improvement plan. Keep this review focused on whether the reference-based design and implementation satisfy the brief; do not turn it into a general pull request review.

If the requested mode is ambiguous, infer it from the deliverable the user asks for and state the interpretation briefly.

## Read the current module

Read modules when their phase becomes necessary. Keep later-phase details out of context until the current phase is complete; do not load every module at invocation.

For a new plan, follow these phases in order:

| Phase | Module | Continue when |
| --- | --- | --- |
| Clarify scope and material decisions | [intake](references/intake.md) | The business decision gate has passed |
| Inspect the local baseline and relevant comparators | [research](references/research.md) | Inspected evidence or explicit retrieval gaps are recorded |
| Select the smallest sufficient architecture | [design](references/design.md) | Consequential additions have a requirement, verified gap, and simpler-option rationale |
| Write tasks, acceptance, verification, and readiness | [plan](references/plan.md) | Requirements reach observable acceptance and verification, and remaining blockers are explicit |

For an existing plan or system review, begin with [review](references/review.md). Follow its pointers when checking design, source claims, or delivery coverage. A review does not restart the entire planning workflow.

Resolve resource links relative to the containing file. Keep each rule in its owning module rather than copying it into the entrypoint or other modules.
