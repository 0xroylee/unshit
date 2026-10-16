import type { AppServerSpawner, SubprocessLike } from "../../src/app-server.ts";

export interface MockRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface MockProcessOptions {
  onClientMessage?: (message: MockRpcMessage, process: MockAppServerProcess) => void;
  endBehavior?: "exit" | "ignore";
  ignoredSignals?: readonly string[];
}

type MessageListener = (message: MockRpcMessage) => void;

export class MockAppServerProcess implements SubprocessLike {
  readonly messages: MockRpcMessage[] = [];
  readonly serverMessages: MockRpcMessage[] = [];
  readonly signals: string[] = [];
  readonly exited: Promise<number>;
  readonly stdin: NonNullable<SubprocessLike["stdin"]>;
  readonly stdout: ReadableStream<Uint8Array>;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly encoder = new TextEncoder();
  private output: ReadableStreamDefaultController<Uint8Array> | undefined;
  private inputBuffer = "";
  private streamClosed = false;
  private exitCode: number | undefined;
  private resolveExit!: (code: number) => void;

  constructor(private readonly options: MockProcessOptions = {}) {
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => { this.output = controller; },
      cancel: () => { this.streamClosed = true; },
    });
    this.stdin = {
      write: (value) => { this.inputBuffer += value; },
      flush: () => this.flushInput(),
      end: () => {
        if ((this.options.endBehavior ?? "exit") === "exit") this.exit(0);
      },
    };
  }

  get isExited(): boolean {
    return this.exitCode !== undefined;
  }

  get isOutputClosed(): boolean {
    return this.streamClosed;
  }

  kill(signal = "SIGTERM"): void {
    this.signals.push(signal);
    if (!this.options.ignoredSignals?.includes(signal)) {
      this.exit(signal === "SIGKILL" ? 137 : 143);
    }
  }

  sendJsonChunk(...messages: MockRpcMessage[]): void {
    this.serverMessages.push(...messages);
    this.enqueue(this.encoder.encode(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`));
  }

  sendJsonFragmented(messages: MockRpcMessage[], splitInside: string): void {
    this.serverMessages.push(...messages);
    const frame = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    const bytes = this.encoder.encode(frame);
    const markerOffset = frame.indexOf(splitInside);
    if (markerOffset < 0) throw new Error(`UTF-8 split marker was not present: ${splitInside}`);
    const markerByteOffset = this.encoder.encode(frame.slice(0, markerOffset)).length;
    const splitAt = markerByteOffset + 1;
    this.enqueue(bytes.slice(0, splitAt));
    this.enqueue(bytes.slice(splitAt));
  }

  sendRawChunk(value: string): void {
    this.enqueue(this.encoder.encode(value));
  }

  disconnect(): void {
    this.closeOutput();
  }

  exit(code = 0): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.closeOutput();
    this.resolveExit(code);
  }

  // Exits while stdout stays open, as when another process still holds the pipe.
  exitWithOpenOutput(code = 0): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.resolveExit(code);
  }

  async waitForMessage(predicate: (message: MockRpcMessage) => boolean, timeoutMs = 1_000): Promise<MockRpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const listener: MessageListener = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.messageListeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.messageListeners.delete(listener);
        reject(new Error("Timed out waiting for a mock app-server message."));
      }, timeoutMs);
      this.messageListeners.add(listener);
    });
  }

  private flushInput(): void {
    while (true) {
      const newline = this.inputBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.inputBuffer.slice(0, newline).trim();
      this.inputBuffer = this.inputBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as MockRpcMessage;
      this.messages.push(message);
      for (const listener of this.messageListeners) listener(message);
      this.options.onClientMessage?.(message, this);
    }
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.streamClosed || !this.output) throw new Error("The mock app-server stdout is closed.");
    this.output.enqueue(bytes);
  }

  private closeOutput(): void {
    if (this.streamClosed) return;
    this.streamClosed = true;
    try { this.output?.close(); } catch { /* stream already cancelled */ }
  }
}

export function createMockSpawner(
  makeOptions: (index: number) => MockProcessOptions = () => ({}),
): { spawn: AppServerSpawner; processes: MockAppServerProcess[]; commands: string[][] } {
  const processes: MockAppServerProcess[] = [];
  const commands: string[][] = [];
  const spawn: AppServerSpawner = (command) => {
    commands.push([...command]);
    if (!isSupportedAppServerCommand(command)) {
      throw new Error(`Unsupported Codex App Server launch command: ${command.join(" ")}`);
    }
    const process = new MockAppServerProcess(makeOptions(processes.length));
    processes.push(process);
    return process;
  };
  return { spawn, processes, commands };
}

function isSupportedAppServerCommand(command: string[]): boolean {
  return (command.length === 4
      && command[0] === "codex"
      && command[1] === "app-server"
      && command[2] === "--listen"
      && command[3] === "stdio://")
    || (command.length === 2 && command[0] === "codex" && command[1] === "app-server");
}
