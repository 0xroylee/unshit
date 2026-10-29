import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { AgentProtocolError, createAgentProtocol } from "../src/agent-protocol.ts";
import { parseIntake } from "../src/model-schema.ts";
import { createPreviewRecorder } from "../src/preview.ts";

const brief = parseIntake({ summary: "Save records.", requirements: [{ description: "Save records.", observableAcceptance: ["A record is saved."] }], outOfScope: [], assumptions: [], materialQuestions: [{ question: "Who may save?", whyMaterial: "This sets the permission boundary." }], researchQueries: ["record service"] });

function fixture() {
  const input = new PassThrough();
  const controller = new AbortController();
  const records: Record<string, any>[] = [];
  const protocol = createAgentProtocol({ input, controller, write: (line) => records.push(JSON.parse(line)) });
  return { input, controller, records, protocol, reply: (value: unknown) => input.write(`${JSON.stringify(value)}\n`) };
}

describe("agent protocol", () => {
  test("requests one exact material batch, full brief, and published preview with fresh host IDs", async () => {
    const f = fixture();
    try {
      const answers = f.protocol.answerQuestions(brief.materialQuestions);
      const first = f.records[0]!;
      expect(first).toMatchObject({ type: "input_request", kind: "material_answers", questions: brief.materialQuestions });
      f.reply({ type: "input_response", requestId: first.requestId, answers: { [brief.materialQuestions[0]!.id]: " Managers " } });
      expect(await answers).toEqual({ [brief.materialQuestions[0]!.id]: "Managers" });
      const approval = f.protocol.approveBrief(brief);
      expect(f.records[1]!.brief).toEqual(brief);
      expect(f.records[1]!.requestId).not.toBe(first.requestId);
      f.reply({ type: "input_response", requestId: f.records[1]!.requestId, approved: true });
      expect(await approval).toBe(true);
      const preview = createPreviewRecorder().snapshot();
      const confirmation = f.protocol.confirmPreview(preview, "/project/.unshit/run/preview.html");
      expect(f.records[2]).toMatchObject({ kind: "preview_confirmation", preview, revision: preview.revision, pagePath: "/project/.unshit/run/preview.html" });
      f.reply({ type: "input_response", requestId: f.records[2]!.requestId, approved: false });
      expect(await confirmation).toBe(false);
      expect(f.controller.signal.aborted).toBe(false);
    } finally { f.protocol.close(); f.input.destroy(); }
  });

  test("rejects malformed, early, stale, duplicate and wrong-kind input without exposing its contents", async () => {
    for (const invalid of ["malformed", "early", "stale", "duplicate", "wrong kind", "extra field", "nonboolean", "missing answer", "unknown answer", "blank answer"]) {
      const f = fixture();
      try {
        let result: Promise<unknown> | undefined;
        if (invalid !== "early") result = (invalid.includes("answer") ? f.protocol.answerQuestions(brief.materialQuestions) : f.protocol.approveBrief(brief)).catch((error) => error);
        const requestId = f.records[0]?.requestId ?? "early";
        if (invalid === "malformed") f.input.write("secret raw input is not JSON\n");
        else if (invalid === "duplicate") {
          const line = JSON.stringify({ type: "input_response", requestId, approved: true });
          f.input.write(`${line}\n${line}\n`);
        } else if (invalid === "wrong kind") f.reply({ type: "input_response", requestId, answers: {} });
        else if (invalid === "extra field") f.reply({ type: "input_response", requestId, approved: true, secret: "raw secret" });
        else if (invalid === "nonboolean") f.reply({ type: "input_response", requestId, approved: "yes" });
        else if (invalid.includes("answer")) f.reply({ type: "input_response", requestId, answers: invalid === "unknown answer" ? { other: "raw secret" } : invalid === "blank answer" ? { [brief.materialQuestions[0]!.id]: " " } : {} });
        else f.reply({ type: "input_response", requestId: "stale", approved: true });
        if (result) await result;
        expect(f.protocol.failure(), invalid).toBeInstanceOf(AgentProtocolError);
        expect(f.protocol.failure()?.code, invalid).toBe("agent_protocol_error");
        expect(f.protocol.failure()?.message, invalid).not.toContain("secret");
        expect(f.controller.signal.aborted, invalid).toBe(true);
        await expect(f.protocol.approveBrief(brief)).rejects.toBeInstanceOf(AgentProtocolError);
        expect(f.records).toHaveLength(invalid === "early" ? 0 : 1);
      } finally { f.protocol.close(); f.input.destroy(); }
    }
  });

  test("cancel, EOF between gates, EOF at a gate and SIGINT's abort settle pending input as interruption", async () => {
    for (const action of ["cancel", "EOF at gate", "EOF between gates", "abort"]) {
      const f = fixture();
      try {
        const waiting = action === "EOF between gates" ? undefined : f.protocol.approveBrief(brief).catch((error) => error);
        if (action === "cancel") f.reply({ type: "cancel" });
        else if (action === "abort") f.controller.abort();
        else { f.input.end(); await new Promise<void>((resolve) => f.input.once("end", resolve)); }
        if (waiting) expect(await waiting).toBeInstanceOf(Error);
        expect(f.controller.signal.aborted, action).toBe(true);
        expect(f.protocol.failure(), action).toBeUndefined();
        await expect(f.protocol.approveBrief(brief)).rejects.toThrow("interrupted");
      } finally { f.protocol.close(); f.input.destroy(); }
    }
  });

  test("cleanup removes listeners and EOF after completion does not cancel the result", async () => {
    const f = fixture();
    f.protocol.finish();
    f.input.end();
    await new Promise<void>((resolve) => f.input.once("end", resolve));
    expect(f.controller.signal.aborted).toBe(false);
    f.protocol.close();
    expect(f.input.listenerCount("data")).toBe(0);
    expect(f.input.listenerCount("error")).toBe(0);
    f.input.destroy();
  });

  test("a forwarded stdin stream error rejects the pending gate with a fixed failure and no raw error text", async () => {
    const f = fixture();
    try {
      let error: unknown;
      const pending = f.protocol.approveBrief(brief).catch((caught) => { error = caught; });
      f.input.destroy(new Error("SECRET_RAW_STREAM_ERROR"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(error).toBeInstanceOf(AgentProtocolError);
      expect((error as AgentProtocolError).message).toBe("Invalid agent protocol input. No downstream work started after the failure.");
      expect(f.controller.signal.aborted).toBe(true);
      expect(f.protocol.failure()?.code).toBe("agent_protocol_error");
      await pending;
    } finally { f.protocol.close(); f.input.destroy(); }
  });
});
