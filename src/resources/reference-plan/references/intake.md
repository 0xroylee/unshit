# Resolve material requirements

Read the request and inspect the local repository and applicable `AGENTS.md` or other project instructions. Use indexed CodeGraph results for symbol definitions, callers, dependencies, and impact when CodeGraph is available; use `rg` and source reads for literal searches and as fallback when the index is unavailable or incomplete.

Separate material business decisions from researchable technical facts and routine engineering choices. Business decisions change product scope, actor capabilities, workflows, permissions, or acceptance. Resolve facts such as the existing identity or agent-roster interface, stack, and repository commands from source or available tools. When a fact is absent, make a routine engineering choice within the stated constraints; ask only if the unresolved choice changes product scope, permissions, workflow, or an external integration commitment. For example, whether admins may edit or reassign tickets is a permissions decision, while the shape of an existing roster interface is a discoverable technical fact. Ground permissions and role behavior in the user's brief or existing project behavior; do not invent role policies as generic defaults.

Identify only the unanswered business decisions that could change scope, access, or acceptance. Depending on the brief, clarify:

- who uses the system and what each role needs to do;
- the main workflows, state changes, and exceptional paths;
- permissions, data boundaries, integrations, and operational constraints;
- the required platform or stack, if one exists, and constraints such as scale, reliability, or deployment.

Do not make the user answer questions whose answers are clear in the brief or discoverable from the repository and tools. If material business decisions remain unanswered and the user has not asked you to proceed with assumptions, end this invocation with the known brief, **Draft** status, and concise questions. Stop before choosing architecture or comparator repositories; a Draft label does not bypass this gate. If the user asks you to proceed with assumptions, record each material assumption and keep readiness at Draft when it leaves a material gap.

Label every requirement with the user's own words that state it, copied exactly from the request or a confirmed answer, or mark it inferred when the user did not state it. Never present an inferred requirement as something the user said. After the business decision gate passes, in an interactive terminal run the host shows the user the final requirements and acceptance criteria with these labels and asks for their approval before research starts. If they do not approve, the host stops with the brief so they can correct it. In other runs the host asks nothing before research and saves the brief in an answers file where the user can approve it for a rerun. The host keeps a plan built on a brief that nobody approved **Draft**. Without a host program such as the unshit CLI, show the user the final requirements and acceptance criteria with these labels yourself and ask for their approval before research starts.
