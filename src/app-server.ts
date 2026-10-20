import { DEVELOPER_INSTRUCTIONS } from "./instructions.ts";

export type JsonRecord = Record<string, unknown>;

export interface SubprocessLike {
  stdin: { write(value: string): unknown; flush(): unknown; end(): unknown } | null;
  stdout: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: string): void;
}

export type AppServerSpawner = (command: string[]) => SubprocessLike;

export interface AppServerClientOptions {
  cwd?: string;
  model?: string;
  effort?: string;
  spawn?: AppServerSpawner;
  requestTimeoutMs?: number;
  turnIdleTimeoutMs?: number;
  turnTotalTimeoutMs?: number;
  turnStartTimeoutMs?: number;
  interruptGraceMs?: number;
}

export interface ModelTurnOptions {
  signal?: AbortSignal;
}

// A turn times out after this long without any notification on its thread.
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 600_000;
// A turn may run at most this many idle limits in total, even while Codex keeps reporting activity.
export const TURN_TOTAL_TIMEOUT_FACTOR = 3;

export type TurnTimeoutLimit = "idle" | "total";

export interface ServerInputQuestion {
  id: string;
  question: string;
}

export type ModelTurnResult =
  | { status: "completed"; text: string; threadId: string; turnId: string }
  | { status: "interrupted"; message: string; threadId?: string; turnId?: string }
  | { status: "timed_out"; message: string; limit: TurnTimeoutLimit; limitMs: number; threadId?: string; turnId?: string }
  | { status: "needs_input"; questions: ServerInputQuestion[]; threadId?: string; turnId?: string }
  | { status: "failed"; message: string; threadId?: string; turnId?: string };

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface Notification {
  method: string;
  params: JsonRecord;
}

type CancelReason =
  | { kind: "signal"; message: string }
  | { kind: "needs_input"; questions: ServerInputQuestion[] }
  | { kind: "tool_forbidden"; message: string }
  | { kind: "transport_failure"; message: string };

// After the process exits, the reader gets this long to reach EOF before pending requests fail.
const EXIT_DRAIN_MS = 1_000;
// Before a turn's ID is known, `turn` holds the result evidence of at most this many turn IDs on its thread.
const MAX_HELD_TURNS = 500;

// What a turn's result needs: its turn/completed notification, the latest item/completed of each final-message rank
// (see `finalMessageRank`), in arrival order, and the latest error notification.
interface HeldEvidence {
  completion?: Notification;
  finals: Notification[];
  error?: Notification;
}

class RequestAbortedError extends Error {
  constructor() {
    super("Codex App Server request was interrupted.");
    this.name = "RequestAbortedError";
  }
}

// Codex answered a request with a JSON-RPC error. Its reason outranks a disconnect that follows the answer.
class RequestRejectedError extends Error {}

class TurnControl {
  reason: CancelReason | undefined;
  private resolveCancel!: (reason: CancelReason) => void;
  readonly canceled = new Promise<CancelReason>((resolve) => { this.resolveCancel = resolve; });

  cancel(reason: CancelReason): void {
    if (this.reason) return;
    this.reason = reason;
    this.resolveCancel(reason);
  }
}

class NotificationBuffer {
  private readonly items: Notification[] = [];
  private readonly listeners = new Set<(notification: Notification) => void>();

  push(notification: Notification): void {
    this.items.push(notification);
    if (this.items.length > 500) this.items.shift();
    for (const listener of this.listeners) listener(notification);
  }

  find(predicate: (notification: Notification) => boolean): Notification | undefined {
    return [...this.items].reverse().find(predicate);
  }

  all(): Notification[] {
    return [...this.items];
  }

  waitFor(
    predicate: (notification: Notification) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Notification | "aborted" | undefined> {
    const existing = this.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: Notification | "aborted" | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(onNotification);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onNotification = (notification: Notification): void => {
        if (predicate(notification)) finish(notification);
      };
      const onAbort = (): void => finish("aborted");
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      this.listeners.add(onNotification);
      signal?.addEventListener("abort", onAbort, { once: true });
      const raced = this.find(predicate);
      if (raced) finish(raced);
    });
  }
}

export class AppServerClient {
  private readonly options: Required<Pick<AppServerClientOptions, "requestTimeoutMs" | "turnIdleTimeoutMs" | "turnTotalTimeoutMs" | "turnStartTimeoutMs" | "interruptGraceMs">> & AppServerClientOptions;
  private process: SubprocessLike | undefined;
  private readerTask: Promise<void> | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private threadId: string | undefined;
  private disabledPluginIds: string[] = [];
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(notification: Notification) => void>();
  private writeChain = Promise.resolve();
  private failed = false;
  private closing = false;
  private currentTurn: { threadId: string; turnId?: string; control: TurnControl; started: boolean } | undefined;
  private terminationPromise: Promise<void> | undefined;

  constructor(options: AppServerClientOptions = {}) {
    const turnIdleTimeoutMs = options.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS;
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
      turnStartTimeoutMs: options.turnStartTimeoutMs ?? 20_000,
      interruptGraceMs: options.interruptGraceMs ?? 5_000,
      ...options,
      turnIdleTimeoutMs,
      turnTotalTimeoutMs: options.turnTotalTimeoutMs ?? TURN_TOTAL_TIMEOUT_FACTOR * turnIdleTimeoutMs,
    };
  }

  get turnLimits(): { idleMs: number; totalMs: number } {
    return { idleMs: this.options.turnIdleTimeoutMs, totalMs: this.options.turnTotalTimeoutMs };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.process) return;
    if (this.failed) throw new Error("Codex App Server session cannot be reused after connection termination.");
    if (signal?.aborted) throw new RequestAbortedError();
    const spawn = this.options.spawn ?? defaultSpawner;
    try {
      this.process = spawn(["codex", "app-server", "--listen", "stdio://"]);
    } catch {
      throw new Error("Could not start `codex app-server --listen stdio`. Install Codex CLI and sign in first.");
    }
    if (!this.process.stdout || !this.process.stdin) {
      await this.terminateProcess();
      throw new Error("Codex App Server did not provide stdio pipes.");
    }
    this.reader = this.process.stdout.getReader();
    this.readerTask = this.readLoop();
    void this.process.exited.then(async (code) => {
      // Buffered stdout can still hold answers. The reader handles them and ends at EOF; a pipe that stays open after
      // the exit gets at most EXIT_DRAIN_MS before pending requests fail.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.readerTask, new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_DRAIN_MS); })]);
      clearTimeout(timer);
      if (!this.closing && !this.failed) this.failAll(new Error(`Codex App Server exited (${code}).`));
    });

    try {
      await this.requestWithSignal("initialize", {
        clientInfo: { name: "unshit", title: "unshit", version: "0.1.0" },
        capabilities: null,
      }, signal);
      await this.notify("initialized");
      const configResponse = await this.requestWithSignal("config/read", { includeLayers: false, cwd: this.options.cwd ?? process.cwd() }, signal);
      const config = asRecord(asRecord(configResponse, "config/read response").config, "effective config");
      const disabled = buildDisabledToolsConfig(config);
      this.disabledPluginIds = disabled.pluginIds;
      const params: JsonRecord = {
        cwd: this.options.cwd ?? process.cwd(),
        approvalPolicy: "never",
        sandbox: "read-only",
        developerInstructions: DEVELOPER_INSTRUCTIONS,
        config: disabled.overrides,
        ephemeral: true,
      };
      if (this.options.model) params.model = this.options.model;
      const threadResponse = asRecord(await this.requestWithSignal("thread/start", params, signal), "thread/start response");
      const thread = asRecord(threadResponse.thread, "thread/start response.thread");
      if (typeof thread.id !== "string" || !thread.id) throw new Error("Codex App Server returned no thread ID.");
      this.threadId = thread.id;
    } catch (error) {
      await this.terminateProcess();
      if (signal?.aborted || error instanceof RequestAbortedError) throw new RequestAbortedError();
      if (error instanceof Error && error.message.startsWith("Could not start")) throw error;
      throw new Error("Could not initialize a tool-restricted Codex planning thread.");
    }
  }

  async turn(prompt: string, outputSchema: JsonRecord, turnOptions: ModelTurnOptions = {}): Promise<ModelTurnResult> {
    if (turnOptions.signal?.aborted) return { status: "interrupted", message: "The run was interrupted before Codex App Server started." };
    try {
      if (!this.process) await this.start(turnOptions.signal);
    } catch (error) {
      if (turnOptions.signal?.aborted || error instanceof RequestAbortedError) return { status: "interrupted", message: "The run was interrupted while Codex App Server was starting." };
      return { status: "failed", message: safeError(error) };
    }
    if (!this.threadId) return { status: "failed", message: "Codex App Server has no active thread." };
    if (this.failed) return { status: "failed", message: "Codex App Server connection failed." };
    if (this.currentTurn) return { status: "failed", message: "A turn is already active in this Codex session." };

    const threadId = this.threadId;
    const buffer = new NotificationBuffer();
    const turnStartedAt = Date.now();
    let lastActivityAt = turnStartedAt;
    // Result evidence by turn ID, apart from the rolling buffer, which can push it out. Once the active turn's ID is
    // known, only its entry changes; before that, the oldest entry goes when more than MAX_HELD_TURNS turn IDs are held.
    const held = new Map<string, HeldEvidence>();
    const completionOf = (id: string | undefined): Notification | undefined => (id ? held.get(id)?.completion : undefined);
    const unsubscribe = this.subscribe((notification) => {
      if (isTurnNotification(notification)) buffer.push(notification);
      // Any notification on this thread is activity: reasoning, message deltas, token counts, retries. The held
      // evidence below takes only this thread's notifications.
      if (notificationThreadId(notification) !== threadId) return;
      lastActivityAt = Date.now();
      const rank = notification.method === "item/completed" ? finalMessageRank(notification.params.item) : undefined;
      const evidence = notification.method === "turn/completed" || notification.method === "error" || rank !== undefined;
      const heldId = evidence ? notificationTurnId(notification) : undefined;
      const activeId = this.currentTurn?.turnId;
      if (heldId && (!activeId || heldId === activeId)) {
        const entry = held.get(heldId) ?? { finals: [] };
        if (notification.method === "turn/completed") entry.completion = notification;
        else if (notification.method === "error") entry.error = notification;
        else entry.finals = [...entry.finals.filter((final) => finalMessageRank(final.params.item) !== rank), notification];
        held.delete(heldId);
        held.set(heldId, entry);
        if (held.size > MAX_HELD_TURNS) held.delete(held.keys().next().value!);
      }
    });
    const control = new TurnControl();
    const abortListener = (): void => control.cancel({ kind: "signal", message: "The run was interrupted." });
    if (turnOptions.signal?.aborted) abortListener();
    else turnOptions.signal?.addEventListener("abort", abortListener, { once: true });

    let turnId: string | undefined;
    let started = false;
    let finish: Notification | undefined;
    let turnStartRequested = false;
    let timedOut: TurnTimeoutLimit | undefined;
    const activeTurn = { threadId, control, started: false } as { threadId: string; turnId?: string; control: TurnControl; started: boolean };
    this.currentTurn = activeTurn;
    try {
      turnStartRequested = true;
      const startRequest = this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        disabledPluginIds: this.disabledPluginIds,
        outputSchema,
        ...(this.options.effort ? { effort: this.options.effort } : {}),
      });
      let startOutcome = await Promise.race([
        startRequest.then((response) => ({ kind: "response" as const, response })),
        control.canceled.then((reason) => ({ kind: "cancelled" as const, reason })),
      ]);
      if (startOutcome.kind === "cancelled" && startOutcome.reason.kind === "transport_failure") {
        // Codex can answer and then close the connection. A disconnect settles every pending request, so waiting is
        // brief, and the answer wins over the disconnect: a rejection ends the turn, a response continues it.
        const answer = await startRequest.then(
          (response) => ({ kind: "response" as const, response }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        if (answer.kind === "error" && answer.error instanceof RequestRejectedError) throw answer.error;
        if (answer.kind === "response") startOutcome = answer;
      }
      if (startOutcome.kind === "cancelled" && startOutcome.reason.kind === "transport_failure") {
        // After a transport failure the turn does not wait for more messages: the held completion of the active turn,
        // if there is one, is the turn's result.
        turnId = activeTurn.turnId;
        await this.terminateProcess();
        const completion = completionOf(turnId);
        if (completion) return this.completionResult(completion, held.get(turnId!), threadId, turnId!, undefined);
        return this.cancelResult(startOutcome.reason, threadId, turnId);
      }
      if (startOutcome.kind === "cancelled") {
        const belongsToActiveTurn = (notification: Notification): boolean => {
          const notificationId = notificationTurnId(notification);
          return notificationThreadId(notification) === threadId
            && (!activeTurn.turnId || notificationId === activeTurn.turnId)
            && (notification.method === "turn/started" || notification.method === "turn/completed");
        };
        const turnEvent = await buffer.waitFor(belongsToActiveTurn, Math.min(this.options.interruptGraceMs, 2_000));
        if (isNotification(turnEvent)) {
          turnId = notificationTurnId(turnEvent);
          if (turnEvent.method === "turn/started" && turnId) {
            await this.interrupt(threadId, turnId);
            await this.waitForCompletion(buffer, (notification) => notificationThreadId(notification) === threadId && notificationTurnId(notification) === turnId, this.options.interruptGraceMs);
          }
        }
        await this.terminateProcess();
        return this.cancelResult(startOutcome.reason, threadId, turnId);
      }
      const response = asRecord(startOutcome.response, "turn/start response");
      const turn = asRecord(response.turn, "turn/start response.turn");
      if (typeof turn.id !== "string" || !turn.id) throw new Error("Codex App Server returned no turn ID.");
      turnId = turn.id;
      if (activeTurn.turnId && activeTurn.turnId !== turnId) throw new Error("Codex notifications did not match the turn/start response.");
      activeTurn.turnId = turnId;
      const isForTurn = (notification: Notification): boolean => notificationThreadId(notification) === threadId && notificationTurnId(notification) === turnId;
      const isStartedOrCompleted = (notification: Notification): boolean => isForTurn(notification) && (notification.method === "turn/started" || notification.method === "turn/completed");

      for (const notification of buffer.all()) {
        const item = notification.method === "item/started" && isRecord(notification.params.item) ? notification.params.item : undefined;
        if (isForTurn(notification) && item && typeof item.type === "string" && !ALLOWED_ITEM_TYPES.has(item.type)) {
          control.cancel({ kind: "tool_forbidden", message: `Codex attempted a ${item.type} tool action. The action was blocked and the turn was interrupted.` });
          break;
        }
      }

      const initialController = new AbortController();
      const initialWait = buffer.waitFor(isStartedOrCompleted, this.options.turnStartTimeoutMs, initialController.signal);
      const initial = await Promise.race([
        initialWait.then((notification) => ({ kind: "notification" as const, notification })),
        control.canceled.then((reason) => ({ kind: "cancelled" as const, reason })),
      ]);
      if (initial.kind === "cancelled") {
        initialController.abort();
        if (initial.reason.kind === "transport_failure") {
          // A completion that the rolling buffer pushed out is not found by the wait above; the held one still counts.
          finish = completionOf(turnId);
          if (!finish) {
            await this.terminateProcess();
            return { status: "failed", message: initial.reason.message, threadId, turnId };
          }
        } else {
          const afterCancel = await buffer.waitFor(isStartedOrCompleted, Math.min(this.options.interruptGraceMs, 2_000));
          if (isNotification(afterCancel) && afterCancel.method === "turn/completed") finish = afterCancel;
          else if (isNotification(afterCancel) && afterCancel.method === "turn/started") {
            started = true;
            await this.interrupt(threadId, turnId);
            finish = await this.waitForCompletion(buffer, isForTurn, this.options.interruptGraceMs);
          } else {
            await this.terminateProcess();
            return this.cancelResult(control.reason!, threadId, turnId);
          }
        }
      } else if (initial.notification === undefined || initial.notification === "aborted") {
        await this.terminateProcess();
        return { status: "failed", message: "Codex App Server did not announce the active turn.", threadId, turnId };
      } else if (initial.notification.method === "turn/completed") {
        finish = initial.notification;
      } else {
        started = true;
      }

      if (!finish && started) {
        this.currentTurn.started = true;
        const turnEnd = new AbortController();
        const ended = await Promise.race([
          this.waitForTurnEnd(buffer, isForTurn, () => lastActivityAt, turnStartedAt, turnEnd.signal).then((outcome) => ({ kind: "ended" as const, outcome })),
          control.canceled.then((reason) => ({ kind: "cancelled" as const, reason })),
        ]);
        // The wait that lost the race stops here, and its timer with it.
        turnEnd.abort();
        if (ended.kind === "cancelled" && ended.reason.kind === "transport_failure") {
          // No interrupt and no wait after a transport failure; only the held completion counts.
          finish = completionOf(turnId);
        } else if (ended.kind === "cancelled") {
          await this.interrupt(threadId, turnId);
          finish = await this.waitForCompletion(buffer, isForTurn, this.options.interruptGraceMs);
        } else if ("notification" in ended.outcome) {
          finish = ended.outcome.notification;
        } else if ("limit" in ended.outcome) {
          timedOut = ended.outcome.limit;
          await this.interrupt(threadId, turnId);
          finish = await this.waitForCompletion(buffer, isForTurn, this.options.interruptGraceMs);
        }
      }

      if (!finish && (turnStartRequested || started || control.reason)) await this.terminateProcess();
      if (control.reason?.kind === "needs_input") return { status: "needs_input", questions: control.reason.questions, threadId, turnId };
      if (control.reason?.kind === "tool_forbidden") return { status: "failed", message: control.reason.message, threadId, turnId };
      if (control.reason?.kind === "signal") return this.cancelResult(control.reason, threadId, turnId);
      if (control.reason?.kind === "transport_failure") {
        await this.terminateProcess();
        // After a transport failure, a completion that the turn already has is its result, unless a time limit ran out
        // first.
        if (timedOut) return this.timeoutResult(timedOut, threadId, turnId);
        if (!finish) return { status: "failed", message: control.reason.message, threadId, turnId };
      }
      if (!finish) return timedOut ? this.timeoutResult(timedOut, threadId, turnId) : { status: "failed", message: "Codex App Server did not complete the active turn before the timeout.", threadId, turnId };
      return this.completionResult(finish, held.get(turnId), threadId, turnId, timedOut);
    } catch (error) {
      if (turnStartRequested) await this.terminateProcess();
      if (control.reason?.kind === "needs_input") return { status: "needs_input", questions: control.reason.questions, threadId, ...(turnId ?? activeTurn.turnId ? { turnId: turnId ?? activeTurn.turnId } : {}) };
      if (control.reason?.kind === "tool_forbidden") return { status: "failed", message: control.reason.message, threadId, ...(turnId ? { turnId } : {}) };
      if (control.reason?.kind === "signal") return this.cancelResult(control.reason, threadId, turnId);
      if (control.reason?.kind === "transport_failure" && !(error instanceof RequestRejectedError)) return timedOut ? this.timeoutResult(timedOut, threadId, turnId) : { status: "failed", message: control.reason.message, threadId, ...(turnId ? { turnId } : {}) };
      return { status: "failed", message: safeError(error), threadId, ...(turnId ? { turnId } : {}) };
    } finally {
      this.currentTurn = undefined;
      unsubscribe();
      turnOptions.signal?.removeEventListener("abort", abortListener);
    }
  }

  async close(): Promise<void> {
    if (!this.process) return;
    this.closing = true;
    try {
      this.process.stdin?.end();
    } catch {
      // The process may already have closed its input stream.
    }
    await this.waitForExit(1_200);
    if (this.process) await this.terminateProcess();
  }

  private subscribe(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async readLoop(): Promise<void> {
    if (!this.reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const result = await this.reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        if (buffer.length > 8_000_000) throw new Error("Codex App Server sent an oversized protocol line.");
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            throw new Error("Codex App Server sent invalid JSON.");
          }
          if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("Codex App Server sent an invalid message.");
          this.handleMessage(message as RpcMessage);
        }
      }
      if (buffer.trim()) throw new Error("Codex App Server disconnected in the middle of a protocol message.");
      if (!this.closing) this.failAll(new Error("Codex App Server disconnected."));
    } catch (error) {
      if (!this.closing) this.failAll(error instanceof Error ? error : new Error("Codex App Server transport failed."));
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
      void this.handleServerRequest(message).catch(() => {
        this.failAll(new Error("Codex App Server could not answer a server request."));
      });
      return;
    }
    if (typeof message.method === "string") {
      const notification = { method: message.method, params: isRecord(message.params) ? message.params : {} };
      this.handleNotification(notification);
      return;
    }
    if (typeof message.id === "string" || typeof message.id === "number") {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new RequestRejectedError(requestFailureText(pending.method, message.error)));
      else pending.resolve(message.result);
    }
  }

  private handleNotification(notification: Notification): void {
    const current = this.currentTurn;
    const eventThreadId = notificationThreadId(notification);
    const eventTurnId = notificationTurnId(notification);
    const canBindTurn = notification.method === "turn/started" || notification.method === "item/started";
    if (current && eventThreadId === current.threadId && eventTurnId && (!current.turnId || eventTurnId === current.turnId)) {
      if (!current.turnId && canBindTurn) current.turnId = eventTurnId;
      if (notification.method === "turn/started") current.started = true;
      if (notification.method === "item/started") {
        const item = isRecord(notification.params.item) ? notification.params.item : {};
        const type = item.type;
        if (typeof type === "string" && !ALLOWED_ITEM_TYPES.has(type)) {
          current.control.cancel({ kind: "tool_forbidden", message: `Codex attempted a ${type} tool action. The action was blocked and the turn was interrupted.` });
        }
      }
    }
    for (const listener of this.listeners) listener(notification);
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    const method = message.method ?? "unknown";
    const params = isRecord(message.params) ? message.params : {};
    const current = this.currentTurn;
    const requestThreadId = notificationThreadId({ method, params });
    const requestTurnId = notificationTurnId({ method, params });
    if (current && requestThreadId === current.threadId && requestTurnId && (!current.turnId || requestTurnId === current.turnId)) {
      if (!current.turnId) current.turnId = requestTurnId;
      if (method === "item/tool/requestUserInput") {
        current.control.cancel({ kind: "needs_input", questions: parseServerQuestions(params) });
      } else {
        current.control.cancel({ kind: "tool_forbidden", message: `Codex requested a blocked server action (${method}); no permission was granted.` });
      }
    }
    if (message.id === undefined) return;
    await this.send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "unshit does not grant tools, permissions, or file changes." },
    });
  }

  private async request(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    if (this.failed) throw new Error("Codex App Server connection failed.");
    const id = this.nextRequestId++;
    const key = String(id);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Codex App Server request ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(key, { method, resolve, reject, timeout });
    });
    try {
      await this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(key);
      }
      throw error;
    }
    return promise;
  }

  private requestWithSignal(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new RequestAbortedError());
    const request = this.request(method, params);
    if (!signal) return request;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = (): void => finish(() => reject(new RequestAbortedError()));
      signal.addEventListener("abort", onAbort, { once: true });
      request.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal.aborted) onAbort();
    });
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private async send(message: unknown): Promise<void> {
    const process = this.process;
    if (!process?.stdin) throw new Error("Codex App Server input is closed.");
    const encoded = `${JSON.stringify(message)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      process.stdin!.write(encoded);
      await process.stdin!.flush();
    });
    await this.writeChain;
  }

  private async waitForCompletion(
    buffer: NotificationBuffer,
    isForTurn: (notification: Notification) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Notification | undefined> {
    const result = await buffer.waitFor((notification) => isForTurn(notification) && notification.method === "turn/completed", timeoutMs, signal);
    return isNotification(result) ? result : undefined;
  }

  // Resolves with turn/completed, with the limit that ran out first, or with `stopped` once `signal` aborts; an abort
  // also clears the pending wait's timer. Activity resets only the idle limit.
  private async waitForTurnEnd(
    buffer: NotificationBuffer,
    isForTurn: (notification: Notification) => boolean,
    lastActivityAt: () => number,
    turnStartedAt: number,
    signal: AbortSignal,
  ): Promise<{ notification: Notification } | { limit: TurnTimeoutLimit } | { stopped: true }> {
    for (;;) {
      if (signal.aborted) return { stopped: true };
      const now = Date.now();
      const totalLeft = turnStartedAt + this.options.turnTotalTimeoutMs - now;
      if (totalLeft <= 0) return { limit: "total" };
      const idleLeft = lastActivityAt() + this.options.turnIdleTimeoutMs - now;
      if (idleLeft <= 0) return { limit: "idle" };
      const notification = await this.waitForCompletion(buffer, isForTurn, Math.min(idleLeft, totalLeft), signal);
      if (notification) return { notification };
    }
  }

  private async interrupt(threadId: string, turnId: string): Promise<void> {
    try {
      await this.request("turn/interrupt", { threadId, turnId }, Math.min(this.options.requestTimeoutMs, this.options.interruptGraceMs));
    } catch {
      // Completion or a bounded process kill below remains the cleanup path.
    }
  }

  private cancelResult(reason: CancelReason, threadId: string, turnId?: string): ModelTurnResult {
    if (reason.kind === "needs_input") return { status: "needs_input", questions: reason.questions, threadId, ...(turnId ? { turnId } : {}) };
    if (reason.kind === "tool_forbidden") return { status: "failed", message: reason.message, threadId, ...(turnId ? { turnId } : {}) };
    if (reason.kind === "transport_failure") return { status: "failed", message: reason.message, threadId, ...(turnId ? { turnId } : {}) };
    return { status: "interrupted", message: reason.message, threadId, ...(turnId ? { turnId } : {}) };
  }

  // The result of a turn/completed notification. A notification for another turn fails. Status `completed` gives the
  // authoritative final text, or a failure without one. Any other status gives the timeout when `timedOut` is set;
  // otherwise `interrupted` stays interrupted and every other status is a failure that names it.
  // The final text and the error detail come from `evidence`, the turn's held notifications.
  private completionResult(finish: Notification, evidence: HeldEvidence | undefined, threadId: string, turnId: string, timedOut: TurnTimeoutLimit | undefined): ModelTurnResult {
    const completedTurn = asRecord(asRecord(finish.params, "turn/completed params").turn, "completed turn");
    const completedId = typeof completedTurn.id === "string" ? completedTurn.id : "";
    const status = completedTurn.status;
    if (finish.method !== "turn/completed" || notificationThreadId(finish) !== threadId || completedId !== turnId) {
      return { status: "failed", message: "Codex App Server completion did not match the active turn.", threadId, turnId };
    }
    if (status !== "completed") {
      if (timedOut) return this.timeoutResult(timedOut, threadId, turnId);
      if (status === "interrupted") return { status: "interrupted", message: "Codex turn ended with status interrupted.", threadId, turnId };
      const detail = turnFailureDetail(completedTurn, evidence?.error);
      return { status: "failed", message: `Codex turn ended with status ${String(status)}${detail ? `: ${detail}` : "."}`, threadId, turnId };
    }
    const text = authoritativeFinalText(completedTurn, evidence?.finals ?? []);
    if (!text) return { status: "failed", message: "Codex completed without an authoritative final assistant message.", threadId, turnId };
    return { status: "completed", text, threadId, turnId };
  }

  private timeoutResult(limit: TurnTimeoutLimit, threadId: string, turnId?: string): ModelTurnResult {
    const limitMs = limit === "idle" ? this.options.turnIdleTimeoutMs : this.options.turnTotalTimeoutMs;
    const message = limit === "idle"
      ? `Codex reported no activity on the turn for ${formatDuration(limitMs)}.`
      : `The turn reached its total limit of ${formatDuration(limitMs)}.`;
    return { status: "timed_out", message, limit, limitMs, threadId, ...(turnId ? { turnId } : {}) };
  }

  private failAll(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = true;
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(key);
    }
    this.currentTurn?.control.cancel({ kind: "transport_failure", message: "Codex App Server disconnected during the active turn." });
    void this.terminateProcess();
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.process) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.process.exited.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (timeout) clearTimeout(timeout);
    return result;
  }

  private async terminateProcess(): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationPromise = this.doTerminateProcess();
    try {
      await this.terminationPromise;
    } finally {
      this.terminationPromise = undefined;
    }
  }

  private async doTerminateProcess(): Promise<void> {
    const process = this.process;
    if (!process) return;
    this.closing = true;
    this.failed = true;
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server connection was closed."));
      this.pending.delete(key);
    }
    try { process.stdin?.end(); } catch { /* stream already closed */ }
    if (!await this.waitForExit(250)) {
      try { process.kill("SIGTERM"); } catch { /* exited concurrently */ }
      if (!await this.waitForExit(300)) {
        try { process.kill("SIGKILL"); } catch { /* exited concurrently */ }
        await this.waitForExit(300);
      }
    }
    try { await this.reader?.cancel(); } catch { /* reader already closed */ }
    this.process = undefined;
    this.threadId = undefined;
    this.currentTurn = undefined;
  }
}

export interface ModelSession {
  turn(prompt: string, schema: JsonRecord, options?: ModelTurnOptions): Promise<ModelTurnResult>;
  close(): Promise<void>;
}

export interface ModelGateway {
  createSession(): ModelSession;
}

export class NativeModelGateway implements ModelGateway {
  constructor(private readonly options: AppServerClientOptions = {}) {}

  createSession(): AppServerClient {
    return new AppServerClient(this.options);
  }
}

function defaultSpawner(command: string[]): SubprocessLike {
  return Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" }) as unknown as SubprocessLike;
}

function buildDisabledToolsConfig(config: JsonRecord): { overrides: JsonRecord; pluginIds: string[] } {
  const mcpServers = keyList(config.mcp_servers);
  const plugins = keyList(config.plugins);
  const mcpOverrides: JsonRecord = {};
  for (const id of mcpServers) mcpOverrides[id] = { enabled: false, required: false };
  const pluginOverrides: JsonRecord = {};
  for (const id of plugins) pluginOverrides[id] = { enabled: false };
  return {
    overrides: {
      web_search: "disabled",
      features: { shell_tool: false, apps: false, multi_agent: false, hooks: false },
      tools: { view_image: false },
      mcp_servers: mcpOverrides,
      plugins: pluginOverrides,
    },
    pluginIds: plugins,
  };
}

function keyList(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).filter((id) => id.length > 0 && id.length < 120);
}

// The notifications that the rolling buffer takes, from every thread: the waits read turn/started and turn/completed,
// the forbidden-item scan reads item/started, and item/completed and error notifications take their places as well, so
// the buffer pushes notifications out at the same points as before held evidence. What a turn's result needs is held
// apart (`HeldEvidence`).
function isTurnNotification(notification: Notification): boolean {
  return notification.method === "turn/started" || notification.method === "turn/completed" || notification.method === "item/started" || notification.method === "item/completed" || notification.method === "error";
}

// The failed turn's own error comes first; otherwise the last error notification Codex sent for this turn.
function turnFailureDetail(completedTurn: JsonRecord, error: Notification | undefined): string | undefined {
  const fromTurn = describeTurnError(completedTurn.error);
  if (fromTurn) return fromTurn;
  return error ? describeTurnError(error.params.error) : undefined;
}

function describeTurnError(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.message !== "string" || !value.message.trim()) return undefined;
  const label = codexErrorLabel(value.codexErrorInfo);
  const details = typeof value.additionalDetails === "string" ? value.additionalDetails.trim() : "";
  const text = [value.message.trim(), label ? `(${label})` : "", details].filter(Boolean).join(" ");
  return scrubSensitiveText(text).slice(0, 300);
}

// Codex's own reason for a rejected request. safeError scrubs endpoints and tokens and bounds the text before it
// leaves the client.
function requestFailureText(method: string, error: unknown): string {
  const reason = isRecord(error) && typeof error.message === "string" ? error.message.trim() : "";
  return reason ? `Codex App Server request ${method} failed: ${reason}` : `Codex App Server request ${method} failed.`;
}

// codexErrorInfo is a variant name, or an object keyed by the variant name with fields such as httpStatusCode.
function codexErrorLabel(value: unknown): string | undefined {
  if (typeof value === "string") return /^[A-Za-z]{1,60}$/.test(value) ? value : undefined;
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !/^[A-Za-z]{1,60}$/.test(keys[0]!)) return undefined;
  const fields = value[keys[0]!];
  const status = isRecord(fields) && Number.isInteger(fields.httpStatusCode) ? ` ${fields.httpStatusCode}` : "";
  return `${keys[0]}${status}`;
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;
  if (ms % 1_000 === 0) return `${ms / 1_000} seconds`;
  return `${ms} ms`;
}

function notificationThreadId(notification: { method: string; params: JsonRecord }): string | undefined {
  return typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
}

function notificationTurnId(notification: { method: string; params: JsonRecord }): string | undefined {
  if (typeof notification.params.turnId === "string") return notification.params.turnId;
  if (isRecord(notification.params.turn) && typeof notification.params.turn.id === "string") return notification.params.turn.id;
  return undefined;
}

function authoritativeFinalText(completedTurn: JsonRecord, finals: readonly Notification[]): string | undefined {
  const candidates: Array<{ text: string; priority: number; sequence: number }> = [];
  let sequence = 0;
  const items = Array.isArray(completedTurn.items) ? completedTurn.items : [];
  for (const item of [...items, ...finals.map((notification) => notification.params.item)]) {
    const priority = finalMessageRank(item);
    if (priority !== undefined) candidates.push({ text: (item as JsonRecord).text as string, priority, sequence: sequence++ });
  }
  candidates.sort((left, right) => right.priority - left.priority || right.sequence - left.sequence);
  const text = candidates[0]?.text.trim();
  return text || undefined;
}

// An item's rank as a turn's final message: 3 for an agentMessage in phase final_answer, 2 for an agentMessage whose
// phase is null, 1 for a plan; undefined for any other item and for an item without text.
function finalMessageRank(item: unknown): number | undefined {
  if (!isRecord(item) || typeof item.text !== "string") return undefined;
  if (item.type === "agentMessage" && item.phase === "final_answer") return 3;
  if (item.type === "agentMessage" && item.phase === null) return 2;
  if (item.type === "plan") return 1;
  return undefined;
}

function parseServerQuestions(params: JsonRecord): ServerInputQuestion[] {
  if (!Array.isArray(params.questions)) return [{ id: "Q1", question: "Codex requested additional input." }];
  return params.questions.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const id = typeof value.id === "string" ? value.id.slice(0, 100) : `Q${index + 1}`;
    const question = typeof value.question === "string" ? value.question.slice(0, 1000) : "Additional information is required.";
    return [{ id, question }];
  }).slice(0, 6);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function isNotification(value: Notification | "aborted" | undefined): value is Notification {
  return typeof value === "object" && value !== null;
}

function scrubSensitiveText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "remote endpoint").replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+)\b/g, "[redacted]");
}

function safeError(error: unknown): string {
  if (error instanceof Error) return scrubSensitiveText(error.message).slice(0, 240);
  return "Codex App Server request failed.";
}

const ALLOWED_ITEM_TYPES = new Set(["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"]);
