import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { extractExistingCommands, isSafeLocalFile, readLocalSource, redactLikelySecrets, scanLocalTree } from "../src/local.ts";

describe("bounded local baseline", () => {
  test("excludes nested dotenv files and redacts quoted JSON credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-local-"));
    try {
      await mkdir(path.join(root, "config"), { recursive: true });
      await writeFile(path.join(root, "config", ".env.json"), "{}\n");
      await writeFile(path.join(root, "config.json"), '{"password":"longProductionPassword123","apiKey":"plainCredentialValue123456"}\n');
      const index = await scanLocalTree(root);
      expect(index.files.map((file) => file.path)).not.toContain("config/.env.json");
      const config = index.files.find((file) => file.path === "config.json");
      expect(config).toBeDefined();
      const read = await readLocalSource(root, config!);
      expect(read.redactions).toBe(2);
      expect(new TextDecoder().decode(read.bytes)).toBe('{"password":"[redacted by unshit]","apiKey":"[redacted by unshit]"}\n');
      expect(isSafeLocalFile("config/.env.json")).toBe(false);
      expect(isSafeLocalFile("config/.envrc")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps excluding a file that holds a private key block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-local-"));
    try {
      // Built at run time so this test file does not itself contain a private key header.
      const marker = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
      await writeFile(path.join(root, "deploy.txt"), `notes\n${marker}\nb3BlbnNzaC1rZXktdjE=\n`);
      const index = await scanLocalTree(root);
      const key = index.files.find((file) => file.path === "deploy.txt");
      expect(key).toBeDefined();
      await expect(readLocalSource(root, key!)).rejects.toThrow("source was excluded because it contains a private key block");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("replaces token-shaped values and credential assignments in place", () => {
    const token = `ghp_${"A".repeat(36)}`;
    expect(redactLikelySecrets(`first line\nconst header = \`Bearer ${token}\`;\nlast line\n`)).toEqual({
      text: "first line\nconst header = `Bearer [redacted by unshit]`;\nlast line\n",
      count: 1,
    });
    expect(redactLikelySecrets('const githubToken = "SENTINEL_GITHUB_7f3b9d2a4c6e8f10";\n')).toEqual({ text: 'const githubToken = "[redacted by unshit]";\n', count: 1 });
    expect(redactLikelySecrets('const label = "a plain sentence with no secret";\n')).toEqual({ text: 'const label = "a plain sentence with no secret";\n', count: 0 });
  });

  test("redacts a whole quoted value with other quotes, escaped quotes or no closing quote", () => {
    const mixed = redactLikelySecrets(`{"token": "MARKER_VALUE_0123456789'MARKER_TAIL_0123456789"}\n`);
    expect(mixed).toEqual({ text: '{"token": "[redacted by unshit]"}\n', count: 1 });

    const escaped = redactLikelySecrets('{"token": "MARKER_VALUE_0123456789\\"MARKER_TAIL_0123456789", "scripts": {"test": "bun test"}}\n');
    expect(escaped.text).toBe('{"token": "[redacted by unshit]", "scripts": {"test": "bun test"}}\n');
    expect(JSON.parse(escaped.text)).toEqual({ token: "[redacted by unshit]", scripts: { test: "bun test" } });

    expect(redactLikelySecrets('password = "MARKER_VALUE_0123456789 MARKER_TAIL\nnext line\n')).toEqual({ text: 'password = "[redacted by unshit]\nnext line\n', count: 1 });
  });

  test("keeps valid JSON valid and never restarts the scan inside a value", () => {
    const shortValue = `{"token":"token='","scripts":{"test":"bun test"}}\r\n`;
    const insideString = `{"text":"token='MARKER_VALUE_0123456789","scripts":{"test":"bun test"}}\r\n`;
    const laterQuote = `{"text":"token='MARKER_VALUE_0123456789","note":"it's","scripts":{"test":"bun test"}}\n`;
    const escapedQuote = `{"text":"say \\"hi token='MARKER_VALUE_0123456789","scripts":{"test":"bun test"}}\n`;
    const keyQuote = `{"token=": 12345678901234567890, "scripts": {"test": "bun test"}}\n`;

    expect(redactLikelySecrets(shortValue)).toEqual({ text: shortValue, count: 0 });
    expect(redactLikelySecrets(insideString)).toEqual({ text: `{"text":"token='[redacted by unshit]","scripts":{"test":"bun test"}}\r\n`, count: 1 });
    expect(redactLikelySecrets(laterQuote)).toEqual({ text: `{"text":"token='[redacted by unshit]","note":"it's","scripts":{"test":"bun test"}}\n`, count: 1 });
    expect(redactLikelySecrets(escapedQuote)).toEqual({ text: `{"text":"say \\"hi token='[redacted by unshit]","scripts":{"test":"bun test"}}\n`, count: 1 });
    expect(redactLikelySecrets(keyQuote)).toEqual({ text: keyQuote, count: 0 });
    for (const input of [shortValue, insideString, laterQuote, escapedQuote, keyQuote]) {
      expect((JSON.parse(redactLikelySecrets(input).text) as { scripts: unknown }).scripts).toEqual({ test: "bun test" });
    }

    const yaml = `token: "token='"  # the scan continues after this short value\n`;
    expect(redactLikelySecrets(yaml)).toEqual({ text: yaml, count: 0 });
    expect(redactLikelySecrets(`const password = 'MARKER_VALUE_0123456789"MARKER_TAIL_0123456789';\n`)).toEqual({ text: "const password = '[redacted by unshit]';\n", count: 1 });
  });

  test("excludes valid JSON whose member name holds a credential-like value", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-local-"));
    try {
      // Built at run time so this test file does not itself contain a token-shaped value.
      const token = `ghp_${"A".repeat(36)}`;
      await writeFile(path.join(root, "names.json"), `{"token='MARKER_VALUE_0123456789":1,"token='MARKER_TAIL_0123456789":[2],"scripts":{"test":"bun test"}}\n`);
      await writeFile(path.join(root, "token-name.json"), `{"${token}" : true}\n`);
      await writeFile(path.join(root, "values.json"), `{"names":["token='MARKER_VALUE_0123456789"],"token":"MARKER_VALUE_0123456789"}\n`);

      for (const name of ["names.json", "token-name.json"]) {
        await expect(readLocalSource(root, { id: name, path: name, size: 0 })).rejects.toThrow("source was excluded because a JSON member name holds a credential-like value");
      }
      const values = await readLocalSource(root, { id: "values.json", path: "values.json", size: 0 });
      expect(new TextDecoder().decode(values.bytes)).toBe(`{"names":["token='[redacted by unshit]"],"token":"[redacted by unshit]"}\n`);
      expect(values.redactions).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("attributes existing commands only to exact root scripts and the correct source line", () => {
    const rootManifest = `{
  "dependencies": {
    "test": "some-library"
  },
  "scripts": {
    "test": "bun test",
    "check": "bun run typecheck && bun test"
  }
}\n`;
    const nestedManifest = `{
  "scripts": {
    "test": "nested test command"
  }
}\n`;
    const commands = extractExistingCommands([
      { id: "S1", path: "package.json", bytes: new TextEncoder().encode(rootManifest) },
      { id: "S2", path: "packages/app/package.json", bytes: new TextEncoder().encode(nestedManifest) },
    ]);
    expect(commands.map((command) => command.command)).toEqual(["bun run test", "bun run check"]);
    expect(commands[0]).toEqual({ id: "CMD1", command: "bun run test", sourceId: "S1", line: 6 });
    expect(commands[1]?.line).toBe(7);
  });
});
