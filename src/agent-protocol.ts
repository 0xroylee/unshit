import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { IntakeBrief, MaterialQuestion, WorkflowPreview } from "./types.ts";

export class AgentProtocolError extends Error {
  readonly code = "agent_protocol_error";

  constructor() {
    super("Invalid agent protocol input. No downstream work started after the failure.");
    this.name = "AgentProtocolError";
  }
}

type InputRequest =
  | { kind: "material_answers"; questions: MaterialQuestion[] }
  | { kind: "brief_approval"; brief: IntakeBrief }
  | { kind: "preview_confirmation"; preview: WorkflowPreview; revision: number; pagePath: string };

interface PendingInput {
  requestId: string;
  request: InputRequest;
  resolve: (value: Record<string, string> | boolean) => void;
  reject: (error: Error) => void;
}

// Reads throughout a live run, including between requests, so an early or duplicate reply cannot approve a later gate.
export function createAgentProtocol(options: {
  input: Readable;
  write: (line: string) => void;
  controller: AbortController;
}) {
  const readline = createInterface({ input: options.input, terminal: false, crlfDelay: Infinity });
  let pending: PendingInput | undefined;
  let failure: AgentProtocolError | undefined;
  let finished = false;

  const rejectPending = (error: Error): void => {
    const current = pending;
    pending = undefined;
    current?.reject(error);
  };
  const interrupt = (): void => {
    if (finished) return;
    options.controller.abort();
    rejectPending(new Error("The agent run was interrupted."));
  };
  const fail = (): void => {
    if (finished || failure) return;
    failure = new AgentProtocolError();
    rejectPending(failure);
    options.controller.abort();
  };
  const onAbort = (): void => rejectPending(failure ?? new Error("The agent run was interrupted."));
  const onLine = (line: string): void => {
    if (finished || failure || options.controller.signal.aborted) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { fail(); return; }
    if (!isRecord(value)) { fail(); return; }
    if (value.type === "cancel" && onlyKeys(value, ["type"])) { interrupt(); return; }
    const current = pending;
    if (!current || value.type !== "input_response" || value.requestId !== current.requestId) { fail(); return; }
    let response: Record<string, string> | boolean;
    if (current.request.kind === "material_answers") {
      if (!onlyKeys(value, ["type", "requestId", "answers"]) || !isRecord(value.answers)) { fail(); return; }
      const answers = value.answers;
      const ids = current.request.questions.map((question) => question.id);
      if (!onlyKeys(answers, ids) || ids.some((id) => typeof answers[id] !== "string" || !answers[id].trim())) { fail(); return; }
      response = Object.fromEntries(ids.map((id) => [id, (answers[id] as string).trim()]));
    } else {
      if (!onlyKeys(value, ["type", "requestId", "approved"]) || typeof value.approved !== "boolean") { fail(); return; }
      response = value.approved;
    }
    pending = undefined;
    current.resolve(response);
  };
  readline.on("line", onLine);
  readline.on("close", interrupt);
  readline.on("error", fail);
  options.input.on("error", fail);
  options.controller.signal.addEventListener("abort", onAbort);
  if (options.input.readableEnded || options.input.destroyed) interrupt();

  const request = (input: InputRequest): Promise<Record<string, string> | boolean> => {
    if (failure) return Promise.reject(failure);
    if (finished || pending) { fail(); return Promise.reject(failure ?? new AgentProtocolError()); }
    if (options.controller.signal.aborted) return Promise.reject(new Error("The agent run was interrupted."));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      pending = { requestId, request: input, resolve, reject };
      options.write(`${JSON.stringify({ type: "input_request", requestId, ...input })}\n`);
    });
  };

  return {
    answerQuestions: async (questions: MaterialQuestion[]): Promise<Record<string, string>> => request({ kind: "material_answers", questions }) as Promise<Record<string, string>>,
    approveBrief: async (brief: IntakeBrief): Promise<boolean> => request({ kind: "brief_approval", brief }) as Promise<boolean>,
    confirmPreview: async (preview: WorkflowPreview, pagePath: string): Promise<boolean> => request({ kind: "preview_confirmation", preview, revision: preview.revision, pagePath }) as Promise<boolean>,
    failure: (): AgentProtocolError | undefined => failure,
    finish: (): void => { finished = true; },
    close: (): void => {
      finished = true;
      rejectPending(new Error("The agent protocol was closed."));
      options.controller.signal.removeEventListener("abort", onAbort);
      options.input.off("error", fail);
      readline.off("line", onLine);
      readline.off("close", interrupt);
      readline.off("error", fail);
      readline.close();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
