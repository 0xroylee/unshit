# Choose the smallest sufficient design

Use the inspected baseline and comparator findings to adopt one coherent design. Do not combine incompatible architectures or copy a candidate mechanically.

Before expanding the task list, check the design against the primary user journey:

- Start with the smallest public interface that completes that journey. Supporting actions can use defaults, flags, or inline output. Add commands or screens for distinct user tasks or explicitly requested interfaces, rather than exposing every internal stage.
- Give consequential new modules, services, storage, caches, or abstractions a short justification: the requirement or concrete failure case they address, the verified gap in existing behavior, and why a simpler option is insufficient. Future growth alone belongs outside the first release unless requested.
- Assign each state and capability one owner. Reuse native authentication, conversation history, continuation, streaming, and cancellation where they meet the requirements. Keep application-owned evidence or workflow state when the platform does not preserve the required information; conversation history alone does not prove that it does.

Remove redundant elements one at a time and keep each removal only when required behavior and quality are preserved. Recheck requirement and verification coverage after a removal. Preserve explicit user choices; simplify the supporting implementation rather than discarding the requested behavior. If a consequential capability remains uncertain, propose the smallest focused verification task and record the gap for the [readiness check](plan.md#readiness).
