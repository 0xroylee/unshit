import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { extractExistingCommands, isSafeLocalFile, readLocalSource, scanLocalTree } from "../src/local.ts";

describe("bounded local baseline", () => {
  test("excludes nested dotenv files and refuses quoted JSON credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "unshit-local-"));
    try {
      await mkdir(path.join(root, "config"), { recursive: true });
      await writeFile(path.join(root, "config", ".env.json"), "{}\n");
      await writeFile(path.join(root, "config.json"), '{"password":"longProductionPassword123","apiKey":"plainCredentialValue123456"}\n');
      const index = await scanLocalTree(root);
      expect(index.files.map((file) => file.path)).not.toContain("config/.env.json");
      const config = index.files.find((file) => file.path === "config.json");
      expect(config).toBeDefined();
      await expect(readLocalSource(root, config!)).rejects.toThrow("secret-content filter");
      const error = await readLocalSource(root, config!).catch((caught: Error) => caught.message);
      expect(error).not.toContain("longProductionPassword123");
      expect(error).not.toContain("plainCredentialValue123456");
      expect(isSafeLocalFile("config/.env.json")).toBe(false);
      expect(isSafeLocalFile("config/.envrc")).toBe(false);
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
