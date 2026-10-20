// Runs one App Server turn against a mock that ends it the way argv[2] names, then prints the result status. The
// process exits on its own once no timer is left: "disconnect" closes the connection during the turn, and
// "unanswered-cancel" cancels the turn while the mock never answers turn/interrupt.
import { AppServerClient } from "../../src/app-server.ts";
import { createMockSpawner, type MockRpcMessage } from "../helpers/mock-process.ts";

const scenario = process.argv[2];
const answer = (request: MockRpcMessage, result: unknown): MockRpcMessage => ({ jsonrpc: "2.0", id: request.id!, result });
const notification = (method: string, params: Record<string, unknown>): MockRpcMessage => ({ jsonrpc: "2.0", method, params });
const abort = new AbortController();
const fixture = createMockSpawner(() => ({
  onClientMessage(message, process) {
    if (message.method === "initialize") return process.sendJsonChunk(answer(message, {}));
    if (message.method === "config/read") return process.sendJsonChunk(answer(message, { config: { mcp_servers: {}, plugins: {} } }));
    if (message.method === "thread/start") return process.sendJsonChunk(answer(message, { thread: { id: "thread-exit" } }));
    if (message.method !== "turn/start") return;
    process.sendJsonChunk(answer(message, { turn: { id: "turn-exit" } }), notification("turn/started", { threadId: "thread-exit", turnId: "turn-exit" }));
    if (scenario === "disconnect") setTimeout(() => process.exit(1), 30);
    else setTimeout(() => abort.abort(), 30);
  },
}));
const client = new AppServerClient({ spawn: fixture.spawn, requestTimeoutMs: 200, turnStartTimeoutMs: 200, interruptGraceMs: 200, turnIdleTimeoutMs: 4_000 });
const result = await client.turn("End the turn without a completion.", { type: "object" }, { signal: abort.signal });
await client.close();
console.log(result.status);
