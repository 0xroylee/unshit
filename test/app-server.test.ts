import { describe, expect, test } from "bun:test";
import { AppServerClient, NativeModelGateway, type JsonRecord, type ModelTurnResult } from "../src/app-server.ts";
import { createMockSpawner, type MockAppServerProcess, type MockRpcMessage } from "./helpers/mock-process.ts";

const CONFIG = {
  mcp_servers: { "repo-reader": { enabled: true }, "calendar-reader": { enabled: true } },
  plugins: { planner: { enabled: true } },
};

function answerHandshake(message: MockRpcMessage, process: MockAppServerProcess, threadId = "thread-1"): boolean {
  if (message.method === "initialize") {
    process.sendJsonChunk(response(message, {}));
    return true;
  }
  if (message.method === "config/read") {
    process.sendJsonChunk(response(message, { config: CONFIG }));
    return true;
  }
  if (message.method === "thread/start") {
    process.sendJsonChunk(response(message, { thread: { id: threadId } }));
    return true;
  }
  return false;
}

function response(request: MockRpcMessage, result: unknown): MockRpcMessage {
  if (request.id === undefined) throw new Error(`Expected an RPC request ID for ${request.method ?? "unknown"}.`);
  return { jsonrpc: "2.0", id: request.id, result };
}

function notification(method: string, params: Record<string, unknown>): MockRpcMessage {
  return { jsonrpc: "2.0", method, params };
}

function serverRequest(id: string | number, method: string, params: Record<string, unknown>): MockRpcMessage {
  return { jsonrpc: "2.0", id, method, params };
}

function requestMessages(process: MockAppServerProcess, method: string): MockRpcMessage[] {
  return process.messages.filter((message) => message.method === method && message.id !== undefined);
}

function paramsOf(message: MockRpcMessage): Record<string, unknown> {
  if (!message.params) throw new Error(`Expected params for ${message.method ?? "unknown"}.`);
  return message.params;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("native App Server stdio protocol", () => {
  test("uses restricted fresh sessions, reuses a thread across schema turns, and returns authoritative final text", async () => {
    const turnsByProcess = new Map<MockAppServerProcess, number>();
    const fixture = createMockSpawner((processIndex) => ({
      onClientMessage(message, process) {
        const threadId = `thread-${processIndex + 1}`;
        if (answerHandshake(message, process, threadId)) return;
        if (message.method !== "turn/start") return;

        const turnNumber = (turnsByProcess.get(process) ?? 0) + 1;
        turnsByProcess.set(process, turnNumber);
        const turnId = `turn-${processIndex + 1}-${turnNumber}`;
        const finalText = processIndex === 0 && turnNumber === 1
          ? "{\"answer\":\"最终答案\"}"
          : processIndex === 0
            ? "Plan: preserve the approved workflow boundaries."
            : "Second session has its own native thread.";
        const finalItems = processIndex === 0 && turnNumber === 2
          ? [
            { type: "agentMessage", phase: "commentary", text: "A later commentary update." },
            { type: "plan", text: finalText },
          ]
          : [
            { type: "agentMessage", phase: "final_answer", text: finalText },
            { type: "agentMessage", phase: "commentary", text: "The last commentary is not the answer." },
          ];
        const messages = [
          response(message, { turn: { id: turnId } }),
          notification("turn/started", { threadId, turnId }),
          notification("turn/started", { threadId: "foreign-thread", turnId: "foreign-turn" }),
          notification("item/agentMessage/delta", { threadId, turnId, delta: "partial delta" }),
          notification("item/completed", {
            threadId,
            turnId,
            item: { type: "agentMessage", phase: "commentary", text: "An earlier commentary item." },
          }),
          notification("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed", items: finalItems },
          }),
        ];
        if (processIndex === 0 && turnNumber === 1) process.sendJsonFragmented(messages, "最终");
        else process.sendJsonChunk(...messages);
      },
    }));
    const gateway = new NativeModelGateway({
      cwd: "/tmp/unshit-target",
      model: "mock-model",
      effort: "medium",
      spawn: fixture.spawn,
      requestTimeoutMs: 200,
      turnIdleTimeoutMs: 500,
      turnStartTimeoutMs: 150,
      interruptGraceMs: 100,
    });
    const schemaA: JsonRecord = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
    const schemaB: JsonRecord = { type: "object", required: ["plan"], properties: { plan: { type: "string" } } };
    const firstSession = gateway.createSession();
    const secondSession = gateway.createSession();

    try {
      const firstTurn = await firstSession.turn("Return the requested answer.", schemaA);
      const secondTurn = await firstSession.turn("Return the plan.", schemaB);
      const thirdTurn = await secondSession.turn("Return a session-specific answer.", schemaA);

      expect(firstTurn).toMatchObject({ status: "completed", text: "{\"answer\":\"最终答案\"}", threadId: "thread-1", turnId: "turn-1-1" });
      expect(secondTurn).toMatchObject({ status: "completed", text: "Plan: preserve the approved workflow boundaries.", threadId: "thread-1", turnId: "turn-1-2" });
      expect(thirdTurn).toMatchObject({ status: "completed", text: "Second session has its own native thread.", threadId: "thread-2", turnId: "turn-2-1" });
      expect(fixture.processes).toHaveLength(2);
      expect(fixture.commands).toHaveLength(2);

      const firstProcess = fixture.processes[0]!;
      const secondProcess = fixture.processes[1]!;
      expect(firstProcess.messages.map((message) => message.method)).toEqual([
        "initialize", "initialized", "config/read", "thread/start", "turn/start", "turn/start",
      ]);
      expect(requestMessages(firstProcess, "config/read")).toHaveLength(1);
      expect(requestMessages(secondProcess, "config/read")).toHaveLength(1);

      const threadParams = paramsOf(requestMessages(firstProcess, "thread/start")[0]!);
      expect(threadParams).toMatchObject({
        cwd: "/tmp/unshit-target",
        model: "mock-model",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      });
      expect(threadParams.developerInstructions).toContain("Do not call tools");
      expect(threadParams.config).toMatchObject({
        web_search: "disabled",
        features: { shell_tool: false, apps: false, multi_agent: false, hooks: false },
        tools: { view_image: false },
        mcp_servers: {
          "repo-reader": { enabled: false, required: false },
          "calendar-reader": { enabled: false, required: false },
        },
        plugins: { planner: { enabled: false } },
      });

      const firstSessionTurns = requestMessages(firstProcess, "turn/start").map(paramsOf);
      expect(firstSessionTurns).toHaveLength(2);
      expect(firstSessionTurns[0]).toMatchObject({
        threadId: "thread-1",
        outputSchema: schemaA,
        effort: "medium",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        disabledPluginIds: ["planner"],
      });
      expect(firstSessionTurns[1]).toMatchObject({ threadId: "thread-1", outputSchema: schemaB });
      expect(requestMessages(secondProcess, "turn/start")[0]!.params).toMatchObject({ threadId: "thread-2", outputSchema: schemaA });

      const supportedCommands = fixture.commands.every((command) =>
        JSON.stringify(command) === JSON.stringify(["codex", "app-server", "--listen", "stdio://"])
        || JSON.stringify(command) === JSON.stringify(["codex", "app-server"]));
      expect(supportedCommands).toBe(true);
    } finally {
      await Promise.all([firstSession.close(), secondSession.close()]);
    }
    expect(fixture.processes.every((process) => process.isExited)).toBe(true);
  });

  test("a pre-aborted turn never spawns the native process", async () => {
    const fixture = createMockSpawner();
    const client = new AppServerClient({ spawn: fixture.spawn });
    const abort = new AbortController();
    abort.abort();

    const result = await client.turn("Do not start this request.", { type: "object" }, { signal: abort.signal });

    expect(result.status).toBe("interrupted");
    expect(fixture.processes).toHaveLength(0);
    expect(fixture.commands).toHaveLength(0);
  });

  test("a same-chunk native input request is denied by its original ID and returns needs_input", async () => {
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-input")) return;
        if (message.method === "turn/start") {
          process.sendJsonChunk(
            response(message, { turn: { id: "turn-input" } }),
            notification("turn/started", { threadId: "thread-input", turnId: "turn-input" }),
            serverRequest("question-request-71", "item/tool/requestUserInput", {
              threadId: "thread-input",
              turnId: "turn-input",
              questions: [{ id: "Q-REGION", question: "Which launch region should the plan assume?" }],
            }),
          );
          return;
        }
        if (message.method === "turn/interrupt") {
          process.sendJsonChunk(
            response(message, {}),
            notification("turn/completed", { threadId: "thread-input", turn: { id: "turn-input", status: "interrupted", items: [] } }),
          );
        }
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100 });

    const result = await client.turn("Plan a service.", { type: "object" });

    expect(result).toMatchObject({
      status: "needs_input",
      questions: [{ id: "Q-REGION", question: "Which launch region should the plan assume?" }],
      threadId: "thread-input",
      turnId: "turn-input",
    });
    const serverReply = fixture.processes[0]!.messages.find((message) => message.id === "question-request-71" && !message.method);
    expect(serverReply).toMatchObject({ id: "question-request-71", error: { code: -32000 } });
    expect(serverReply).not.toHaveProperty("result");
    expect(requestMessages(fixture.processes[0]!, "turn/interrupt")).toHaveLength(1);
    expect(paramsOf(requestMessages(fixture.processes[0]!, "turn/start")[0]!).approvalPolicy).toBe("never");
    await client.close();
  });

  test("a question before turn/start response is answered by original ID and turn RPC responses may arrive out of order", async () => {
    let pendingStart: MockRpcMessage | undefined;
    let startResponseSent = false;
    let startResponseWasSentAtInterrupt: boolean | undefined;
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-early-question")) return;
        if (message.method === "turn/start") {
          pendingStart = message;
          process.sendJsonChunk(
            notification("turn/started", { threadId: "thread-early-question", turnId: "turn-early-question" }),
            serverRequest("question-before-response", "item/tool/requestUserInput", {
              threadId: "thread-early-question",
              turnId: "turn-early-question",
              questions: [{ id: "Q-OWNER", question: "Who owns the service?" }],
            }),
          );
          return;
        }
        if (message.method === "turn/interrupt") {
          startResponseWasSentAtInterrupt = startResponseSent;
          if (!pendingStart) throw new Error("turn/start request was not retained by the test fixture.");
          const startReply = response(pendingStart, { turn: { id: "turn-early-question" } });
          startResponseSent = true;
          process.sendJsonChunk(
            response(message, {}),
            startReply,
            notification("turn/completed", { threadId: "thread-early-question", turn: { id: "turn-early-question", status: "interrupted", items: [] } }),
          );
        }
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 250, turnStartTimeoutMs: 100, interruptGraceMs: 100 });

    const result = await client.turn("Find out who owns the service.", { type: "object" });

    expect(result).toMatchObject({ status: "needs_input", questions: [{ id: "Q-OWNER", question: "Who owns the service?" }] });
    expect(startResponseWasSentAtInterrupt).toBe(false);
    const numericResponses = fixture.processes[0]!.serverMessages.filter((message) => typeof message.id === "number" && !message.method);
    expect(numericResponses.slice(-2).map((message) => message.id)).toEqual([5, 4]);
    const requestReply = fixture.processes[0]!.messages.find((message) => message.id === "question-before-response" && !message.method);
    expect(requestReply).toMatchObject({ id: "question-before-response", error: { code: -32000 } });
    expect(requestMessages(fixture.processes[0]!, "turn/interrupt")).toHaveLength(1);
    expect(fixture.processes[0]!.isExited).toBe(true);
  });

  test("signal cancellation waits for turn/started before sending turn/interrupt", async () => {
    let startRequest: MockRpcMessage | undefined;
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-start-gate")) return;
        if (message.method === "turn/start") {
          startRequest = message;
          process.sendJsonChunk(response(message, { turn: { id: "turn-start-gate" } }));
        } else if (message.method === "turn/interrupt") {
          process.sendJsonChunk(
            response(message, {}),
            notification("turn/completed", { threadId: "thread-start-gate", turn: { id: "turn-start-gate", status: "interrupted", items: [] } }),
          );
        }
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 500, interruptGraceMs: 300 });
    const abort = new AbortController();
    const pending = client.turn("Cancel before the server announces start.", { type: "object" }, { signal: abort.signal });
    const process = await waitForProcess(fixture);
    await process.waitForMessage((message) => message.method === "turn/start");
    await delay(20);
    abort.abort();
    await delay(20);
    expect(requestMessages(process, "turn/interrupt")).toHaveLength(0);
    expect(startRequest).toBeDefined();

    process.sendJsonChunk(notification("turn/started", { threadId: "thread-start-gate", turnId: "turn-start-gate" }));
    const result = await pending;

    expect(result.status).toBe("interrupted");
    expect(requestMessages(process, "turn/interrupt")).toHaveLength(1);
    await client.close();
  });

  test("cancels promptly while initialize or turn/start is unresponsive", async () => {
    for (const phase of ["initialize", "turn/start"] as const) {
      let turnStarted = false;
      const fixture = createMockSpawner(() => ({
        endBehavior: "ignore",
        onClientMessage(message, process) {
          if (phase === "initialize" && message.method === "initialize") return;
          if (answerHandshake(message, process, `thread-hung-${phase}`)) return;
          if (message.method === "turn/start") turnStarted = true;
        },
      }));
      const client = new AppServerClient({
        spawn: fixture.spawn,
        requestTimeoutMs: 10_000,
        turnIdleTimeoutMs: 10_000,
        turnStartTimeoutMs: 50,
        interruptGraceMs: 40,
      });
      const abort = new AbortController();
      const startedAt = Date.now();
      const pending = client.turn("Cancel a hung request.", { type: "object" }, { signal: abort.signal });
      const process = await waitForProcess(fixture);
      const expectedMethod = phase === "initialize" ? "initialize" : "turn/start";
      await process.waitForMessage((message) => message.method === expectedMethod);
      abort.abort();
      const result = await pending;

      expect(result.status).toBe("interrupted");
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(process.isExited).toBe(true);
      expect(process.signals).toContain("SIGTERM");
      expect(turnStarted).toBe(phase === "turn/start");
      await client.close();
    }
  });

  test("an early forbidden item cannot become a successful turn", async () => {
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-forbidden")) return;
        if (message.method === "turn/start") {
          process.sendJsonChunk(
            notification("turn/started", { threadId: "thread-forbidden", turnId: "turn-forbidden" }),
            notification("item/started", {
              threadId: "thread-forbidden",
              turnId: "turn-forbidden",
              item: { id: "tool-item", type: "commandExecution" },
            }),
            response(message, { turn: { id: "turn-forbidden" } }),
          );
        } else if (message.method === "turn/interrupt") {
          process.sendJsonChunk(
            response(message, {}),
            notification("turn/completed", {
              threadId: "thread-forbidden",
              turn: { id: "turn-forbidden", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "This must not be accepted." }] },
            }),
          );
        }
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100 });

    const result = await client.turn("Do not run tools.", { type: "object" });

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toContain("commandExecution");
    expect(requestMessages(fixture.processes[0]!, "turn/interrupt")).toHaveLength(1);
    await client.close();
  });

  test("failed and interrupted completed turns never return success", async () => {
    for (const terminalStatus of ["failed", "interrupted"] as const) {
      const fixture = createMockSpawner(() => ({
        onClientMessage(message, process) {
          if (answerHandshake(message, process, `thread-${terminalStatus}`)) return;
          if (message.method === "turn/start") {
            process.sendJsonChunk(
              response(message, { turn: { id: `turn-${terminalStatus}` } }),
              notification("turn/started", { threadId: `thread-${terminalStatus}`, turnId: `turn-${terminalStatus}` }),
              notification("turn/completed", {
                threadId: `thread-${terminalStatus}`,
                turn: {
                  id: `turn-${terminalStatus}`,
                  status: terminalStatus,
                  items: [{ type: "agentMessage", phase: "final_answer", text: "A final-looking answer is still not success." }],
                },
              }),
            );
          }
        },
      }));
      const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100 });

      const result = await client.turn("Return only if completed.", { type: "object" });

      expect(result.status).toBe(terminalStatus);
      expect(result.status).not.toBe("completed");
      await client.close();
    }
  });

  test("an unresponsive completion timeout interrupts, reaps with SIGKILL, and disables session reuse", async () => {
    const fixture = createMockSpawner(() => ({
      endBehavior: "ignore",
      ignoredSignals: ["SIGTERM"],
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-timeout")) return;
        if (message.method === "turn/start") {
          process.sendJsonChunk(
            response(message, { turn: { id: "turn-timeout" } }),
            notification("turn/started", { threadId: "thread-timeout", turnId: "turn-timeout" }),
          );
        }
      },
    }));
    const client = new AppServerClient({
      spawn: fixture.spawn,
      requestTimeoutMs: 150,
      turnIdleTimeoutMs: 35,
      turnStartTimeoutMs: 100,
      interruptGraceMs: 35,
    });
    const startedAt = Date.now();

    const firstResult = await client.turn("Wait for a server that never completes.", { type: "object" });

    expect(firstResult).toMatchObject({ status: "timed_out", limit: "idle", limitMs: 35 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const child = fixture.processes[0]!;
    expect(requestMessages(child, "turn/interrupt")).toHaveLength(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.isExited).toBe(true);

    const secondResult = await client.turn("This disposed session must not restart.", { type: "object" });
    expect(secondResult.status).toBe("failed");
    expect(fixture.processes).toHaveLength(1);
    expect(requestMessages(child, "turn/start")).toHaveLength(1);
  });

  test("exit, disconnect, and malformed JSON after turn/start fail promptly and reap the child", async () => {
    for (const failure of ["exit", "disconnect", "malformed"] as const) {
      const fixture = createMockSpawner(() => ({
        onClientMessage(message, process) {
          if (answerHandshake(message, process, `thread-${failure}`)) return;
          if (message.method !== "turn/start") return;
          const turnId = `turn-${failure}`;
          process.sendJsonChunk(
            response(message, { turn: { id: turnId } }),
            notification("turn/started", { threadId: `thread-${failure}`, turnId }),
          );
          if (failure === "exit") process.exit(23);
          else if (failure === "disconnect") process.disconnect();
          else process.sendRawChunk("{ malformed JSON }\n");
        },
      }));
      const client = new AppServerClient({
        spawn: fixture.spawn,
        requestTimeoutMs: 10_000,
        turnIdleTimeoutMs: 10_000,
        turnStartTimeoutMs: 100,
        interruptGraceMs: 50,
      });
      const startedAt = Date.now();

      const result = await client.turn("Fail when the transport fails.", { type: "object" });

      expect(result.status).toBe("failed");
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(fixture.processes[0]!.isExited).toBe(true);
      await client.close();
    }
  });
});

describe("failed turn causes", () => {
  function failingTurn(threadId: string, turnId: string, turn: Record<string, unknown>, before: MockRpcMessage[] = []) {
    return createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, threadId)) return;
        if (message.method !== "turn/start") return;
        process.sendJsonChunk(
          response(message, { turn: { id: turnId } }),
          notification("turn/started", { threadId, turnId }),
          ...before,
          notification("turn/completed", { threadId, turn: { id: turnId, status: "failed", items: [], ...turn } }),
        );
      },
    }));
  }

  async function failedMessage(fixture: ReturnType<typeof createMockSpawner>): Promise<string> {
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100 });
    try {
      const result = await client.turn("Plan the change.", { type: "object" });
      if (result.status !== "failed") throw new Error(`Expected a failed turn, got ${result.status}.`);
      return result.message;
    } finally {
      await client.close();
    }
  }

  test("a failed turn reports the Codex error message and category", async () => {
    const fixture = failingTurn("thread-fail", "turn-fail", {
      error: { message: "Your input exceeds the context window of this model.", codexErrorInfo: "contextWindowExceeded", additionalDetails: null },
    });

    expect(await failedMessage(fixture)).toBe("Codex turn ended with status failed: Your input exceeds the context window of this model. (contextWindowExceeded)");
  });

  test("a failed turn without its own error uses this turn's last error notification and scrubs endpoints and tokens", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const fixture = failingTurn("thread-stream", "turn-stream", { error: null }, [
      notification("error", { threadId: "thread-stream", turnId: "turn-stream", willRetry: true, error: { message: "stream disconnected before completion", codexErrorInfo: null, additionalDetails: null } }),
      notification("error", {
        threadId: "thread-stream",
        turnId: "turn-stream",
        willRetry: false,
        error: { message: `stream disconnected at https://api.example.test/v1/responses using ${token}`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, additionalDetails: "Retries exhausted." },
      }),
      notification("error", { threadId: "thread-stream", turnId: "turn-other", willRetry: false, error: { message: "A different turn failed.", codexErrorInfo: "other", additionalDetails: null } }),
    ]);

    const message = await failedMessage(fixture);

    expect(message).toBe("Codex turn ended with status failed: stream disconnected at remote endpoint using [redacted] (responseStreamDisconnected 502) Retries exhausted.");
    expect(message).not.toContain(token);
  });

  test("caps the reported failure detail at 300 characters", async () => {
    const fixture = failingTurn("thread-long", "turn-long", { error: { message: "Upstream failure.", codexErrorInfo: "other", additionalDetails: "x".repeat(1_000) } });

    const message = await failedMessage(fixture);

    expect(message.startsWith("Codex turn ended with status failed: Upstream failure. (other) xxx")).toBe(true);
    expect(message.length).toBe("Codex turn ended with status failed: ".length + 300);
  });

  test("a rejected turn request keeps the reason Codex gave, scrubbed and bounded", async () => {
    const rejecting = (error: Record<string, unknown>) => createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-reject")) return;
        if (message.method === "turn/start") process.sendJsonChunk({ jsonrpc: "2.0", id: message.id!, error });
      },
    }));
    const token = `ghp_${"A".repeat(36)}`;

    expect(await failedMessage(rejecting({ code: -32600, message: "Input exceeds the maximum length of 1048576 characters." })))
      .toBe("Codex App Server request turn/start failed: Input exceeds the maximum length of 1048576 characters.");
    expect(await failedMessage(rejecting({ code: -32603, message: `Rejected at https://api.example.test/v1/responses using ${token}` })))
      .toBe("Codex App Server request turn/start failed: Rejected at remote endpoint using [redacted]");
    expect(await failedMessage(rejecting({ code: -32603 }))).toBe("Codex App Server request turn/start failed.");
    expect(await failedMessage(rejecting({ code: -32603, message: "y".repeat(1_000) }))).toHaveLength(240);
  });

  test("a rejected turn request keeps its reason when the connection closes right after the answer", async () => {
    for (const close of ["disconnect", "exit"] as const) {
      const fixture = createMockSpawner(() => ({
        onClientMessage(message, process) {
          if (answerHandshake(message, process, "thread-closing")) return;
          if (message.method !== "turn/start") return;
          process.sendJsonChunk({ jsonrpc: "2.0", id: message.id!, error: { code: -32600, message: "Input exceeds the maximum length of 1048576 characters." } });
          if (close === "disconnect") process.disconnect();
          else process.exit(1);
        },
      }));

      expect(await failedMessage(fixture)).toBe("Codex App Server request turn/start failed: Input exceeds the maximum length of 1048576 characters.");
    }
  });

  test("a rejected turn request keeps its reason when the process exits before the reader has read the answer", async () => {
    for (const layout of ["fragmented", "after a notification"] as const) {
      const fixture = createMockSpawner(() => ({
        onClientMessage(message, process) {
          if (answerHandshake(message, process, "thread-draining")) return;
          if (message.method !== "turn/start") return;
          const rejection: MockRpcMessage = { jsonrpc: "2.0", id: message.id!, error: { code: -32600, message: "Input exceeds the maximum length of 1048576 characters." } };
          if (layout === "fragmented") process.sendJsonFragmented([rejection], "maximum");
          else {
            process.sendJsonChunk(notification("thread/tokenUsage/updated", { threadId: "thread-draining" }));
            process.sendJsonChunk(rejection);
          }
          process.exit(1);
        },
      }));

      expect(await failedMessage(fixture)).toBe("Codex App Server request turn/start failed: Input exceeds the maximum length of 1048576 characters.");
    }
  });

  test("pending requests fail about one second after an exit that leaves stdout open", async () => {
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-open")) return;
        if (message.method === "turn/start") process.exitWithOpenOutput(1);
      },
    }));
    // Request limits of 2.5 s stay inside bun's 5 s test limit, so a drain without its own bound fails here.
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 2_500, turnStartTimeoutMs: 2_500, interruptGraceMs: 100 });
    try {
      const started = Date.now();
      const result = await client.turn("Plan the change.", { type: "object" });
      const elapsed = Date.now() - started;

      expect(result.status).toBe("failed");
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await client.close();
    }
  });
});

describe("model turn time limits", () => {
  test("returns timed_out, not interrupted, when Codex acknowledges the interrupt sent at the idle limit", async () => {
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-idle")) return;
        if (message.method === "turn/start") {
          process.sendJsonChunk(
            response(message, { turn: { id: "turn-idle" } }),
            notification("turn/started", { threadId: "thread-idle", turnId: "turn-idle" }),
          );
        } else if (message.method === "turn/interrupt") {
          process.sendJsonChunk(
            response(message, {}),
            notification("turn/completed", { threadId: "thread-idle", turn: { id: "turn-idle", status: "interrupted", items: [] } }),
          );
        }
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100, turnIdleTimeoutMs: 60 });

    const result = await client.turn("Stay silent.", { type: "object" });

    expect(result).toMatchObject({ status: "timed_out", limit: "idle", limitMs: 60, threadId: "thread-idle", turnId: "turn-idle" });
    expect(requestMessages(fixture.processes[0]!, "turn/interrupt")).toHaveLength(1);
    await client.close();
  });

  test("keeps timed_out when the process disconnects during the timeout interrupt", async () => {
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-drop")) return;
        if (message.method === "turn/start") {
          process.sendJsonChunk(
            response(message, { turn: { id: "turn-drop" } }),
            notification("turn/started", { threadId: "thread-drop", turnId: "turn-drop" }),
          );
        } else if (message.method === "turn/interrupt") {
          process.exit(1);
        }
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100, turnIdleTimeoutMs: 60 });

    const result = await client.turn("Stay silent, then drop the connection.", { type: "object" });

    expect(result).toMatchObject({ status: "timed_out", limit: "idle", limitMs: 60 });
    await client.close();
  });

  test("notifications on the thread restart the idle clock", async () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-busy")) return;
        if (message.method !== "turn/start") return;
        const send = (...messages: MockRpcMessage[]): void => {
          if (!process.isOutputClosed) process.sendJsonChunk(...messages);
        };
        send(response(message, { turn: { id: "turn-busy" } }), notification("turn/started", { threadId: "thread-busy", turnId: "turn-busy" }));
        for (let tick = 1; tick <= 6; tick += 1) {
          timers.push(setTimeout(() => send(notification("item/agentMessage/delta", { threadId: "thread-busy", turnId: "turn-busy", itemId: "m1", delta: "." })), tick * 40));
        }
        timers.push(setTimeout(() => send(notification("turn/completed", {
          threadId: "thread-busy",
          turn: { id: "turn-busy", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "{\"done\":true}" }] },
        })), 280));
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100, turnIdleTimeoutMs: 150, turnTotalTimeoutMs: 5_000 });
    try {
      const result = await client.turn("Report progress, then answer.", { type: "object" });

      expect(result).toMatchObject({ status: "completed", text: "{\"done\":true}" });
      expect(requestMessages(fixture.processes[0]!, "turn/interrupt")).toHaveLength(0);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      await client.close();
    }
  });

  test("the total limit ends a turn that keeps reporting activity", async () => {
    let ticker: ReturnType<typeof setInterval> | undefined;
    const fixture = createMockSpawner(() => ({
      onClientMessage(message, process) {
        if (answerHandshake(message, process, "thread-chatty")) return;
        const send = (...messages: MockRpcMessage[]): void => {
          if (!process.isOutputClosed) process.sendJsonChunk(...messages);
        };
        if (message.method === "turn/start") {
          send(response(message, { turn: { id: "turn-chatty" } }), notification("turn/started", { threadId: "thread-chatty", turnId: "turn-chatty" }));
          ticker = setInterval(() => send(notification("item/agentMessage/delta", { threadId: "thread-chatty", turnId: "turn-chatty", itemId: "m1", delta: "." })), 20);
        } else if (message.method === "turn/interrupt") {
          clearInterval(ticker);
          send(response(message, {}), notification("turn/completed", { threadId: "thread-chatty", turn: { id: "turn-chatty", status: "interrupted", items: [] } }));
        }
      },
    }));
    const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 100, interruptGraceMs: 100, turnIdleTimeoutMs: 100 });
    try {
      const result = await Promise.race([
        client.turn("Keep talking.", { type: "object" }),
        delay(2_000).then((): ModelTurnResult => ({ status: "failed", message: "The turn was still running after 2 seconds." })),
      ]);

      expect(result).toMatchObject({ status: "timed_out", limit: "total", limitMs: 300 });
    } finally {
      clearInterval(ticker);
      await client.close();
    }
  });

  test("defaults to a 10-minute idle limit and a total limit of three idle limits", () => {
    expect(new AppServerClient().turnLimits).toEqual({ idleMs: 600_000, totalMs: 1_800_000 });
    expect(new AppServerClient({ turnIdleTimeoutMs: 900_000 }).turnLimits).toEqual({ idleMs: 900_000, totalMs: 2_700_000 });
    expect(new AppServerClient({ turnIdleTimeoutMs: 1_000, turnTotalTimeoutMs: 1_500 }).turnLimits).toEqual({ idleMs: 1_000, totalMs: 1_500 });
  });
});

async function waitForProcess(fixture: ReturnType<typeof createMockSpawner>): Promise<MockAppServerProcess> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fixture.processes[0]) return fixture.processes[0];
    await delay(1);
  }
  throw new Error("The App Server client did not invoke the injected process spawner.");
}
