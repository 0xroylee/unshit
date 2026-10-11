import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ResearchGap, TreeFile } from "./types.ts";

export interface LocalIndex {
  root: string;
  files: TreeFile[];
  gaps: ResearchGap[];
}

const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", "vendor", "target",
  ".next", ".turbo", ".cache", ".venv", "venv", "__pycache__", ".unshit", ".codex", ".idea",
]);
const SECRET_FILE = /^(?:id_rsa|id_ed25519|credentials?(?:[.-].*)?|secrets?(?:[.-].*)?)$|\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore)$/i;
const TEXT_FILE = /\.(c|cc|cpp|cs|css|csv|go|h|hpp|html?|java|js|jsx|json|kt|md|mjs|php|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|txt|vue|xml|yaml|yml|zig)$/i;

export type LocalReadReason = "unsafe_path" | "escaped_path" | "size_limit" | "invalid_utf8" | "secret_content";

const LOCAL_READ_REASONS = new WeakMap<object, LocalReadReason>();

const LOCAL_READ_ERROR_MESSAGES: Record<LocalReadReason, string> = {
  unsafe_path: "The selected local path is not allowed.",
  escaped_path: "The selected local path escaped the project directory.",
  size_limit: "source exceeded the 256 KB local-file limit",
  invalid_utf8: "the content is not valid UTF-8 text",
  secret_content: "source was excluded by the local secret-content filter",
};

export function localReadFailureText(error: unknown): string | undefined {
  const reason = LOCAL_READ_REASONS.get(error as object);
  if (reason === undefined) return undefined;
  if (typeof reason !== "string" || !Object.hasOwn(LOCAL_READ_ERROR_MESSAGES, reason)) return undefined;
  return LOCAL_READ_ERROR_MESSAGES[reason as LocalReadReason];
}

export class LocalReadError extends Error {
  readonly reason: LocalReadReason;

  constructor(reason: LocalReadReason) {
    super(LOCAL_READ_ERROR_MESSAGES[reason]);
    this.name = "LocalReadError";
    this.reason = reason;
    LOCAL_READ_REASONS.set(this, reason);
  }
}

export async function scanLocalTree(rootPath: string, options: { maxFiles?: number } = {}): Promise<LocalIndex> {
  const root = path.resolve(rootPath);
  const limit = options.maxFiles ?? 480;
  const gaps: ResearchGap[] = [];
  const files: TreeFile[] = [];
  let ignoreRules: IgnoreRule[] = [];
  try {
    const text = await readFile(path.join(root, ".gitignore"), "utf8");
    ignoreRules = parseIgnoreRules(text);
  } catch {
    // A project without .gitignore still receives the standard generated-directory exclusions.
  }

  async function walk(directory: string): Promise<void> {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      gaps.push({ kind: "local", message: `Could not list a local source directory under ${relativeLabel(root, directory)}.`, material: false });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || isIgnored(relative, true, ignoreRules)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !isSafeLocalFile(relative) || isIgnored(relative, false, ignoreRules)) continue;
      if (!TEXT_FILE.test(entry.name) && !isKnownTextConfig(entry.name)) continue;
      try {
        const metadata = await stat(absolute);
        if (metadata.size > 1_000_000) continue;
        files.push({ id: `LFILE${files.length + 1}`, path: relative, size: metadata.size });
      } catch {
        gaps.push({ kind: "local", message: `Could not inspect ${relative}.`, material: false });
      }
    }
  }

  await walk(root);
  if (files.length === limit) gaps.push({ kind: "local", message: `The local file list was capped at ${limit} files.`, material: true });
  return { root, files, gaps };
}

export async function readLocalSource(root: string, file: TreeFile): Promise<Uint8Array> {
  if (!isSafeLocalFile(file.path)) throw new LocalReadError("unsafe_path");
  const absolute = path.resolve(root, file.path);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new LocalReadError("escaped_path");
  const bytes = await readFile(absolute);
  if (bytes.byteLength > 256_000) throw new LocalReadError("size_limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalReadError("invalid_utf8");
  }
  if (containsLikelySecret(text)) throw new LocalReadError("secret_content");
  return bytes;
}

export function chooseLocalReferenceFiles(files: TreeFile[]): Array<{ file: TreeFile; role: "manifest" | "ci" | "license" | "config" }> {
  const lower = files.map((file) => ({ file, name: file.path.toLowerCase() }));
  const selected: Array<{ file: TreeFile; role: "manifest" | "ci" | "license" | "config" }> = [];
  const add = (match: (name: string) => boolean, role: "manifest" | "ci" | "license" | "config"): void => {
    const entry = lower.find(({ name }) => match(name));
    if (entry && !selected.some((item) => item.file.id === entry.file.id)) selected.push({ file: entry.file, role });
  };
  add((name) => /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|composer\.json)$/.test(name), "manifest");
  add((name) => /^(license|copying|notice)(\.txt|\.md)?$/.test(name.split("/").at(-1) ?? ""), "license");
  add((name) => name === ".github/workflows" || name.startsWith(".github/workflows/" ) || name === ".gitlab-ci.yml" || name === "jenkinsfile", "ci");
  add((name) => name === "readme.md" || name === "agents.md", "config");
  return selected;
}

export function extractExistingCommands(sources: Array<{ id: string; path: string; bytes: Uint8Array }>): Array<{ id: string; command: string; sourceId: string; line: number }> {
  const commands: Array<{ id: string; command: string; sourceId: string; line: number }> = [];
  for (const source of sources) {
    if (path.posix.normalize(source.path) !== "package.json") continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(source.bytes));
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) continue;
    const scripts = (manifest as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) continue;
    for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof command !== "string" || !/^[a-zA-Z0-9:_-]+$/.test(name)) continue;
      const text = new TextDecoder().decode(source.bytes);
      const scriptsRange = rootObjectPropertyRange(text, "scripts");
      if (!scriptsRange) continue;
      const lineNumber = objectMemberLine(text, scriptsRange.start, scriptsRange.end, name);
      if (!lineNumber) continue;
      const id = `CMD${commands.length + 1}`;
      commands.push({ id, command: `bun run ${name}`, sourceId: source.id, line: lineNumber });
      if (commands.length >= 40) return commands;
    }
  }
  return commands;
}

export function isSafeLocalFile(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith("../") || relativePath.includes("\\")) return false;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return false;
  return !segments.some((segment) => SECRET_FILE.test(segment) || /^\.env/i.test(segment) || SKIP_DIRECTORIES.has(segment));
}

function isKnownTextConfig(name: string): boolean {
  const lower = name.toLowerCase();
  return ["dockerfile", "makefile", "justfile", ".gitignore", ".npmrc", ".nvmrc", ".editorconfig", ".prettierrc", ".eslintrc", ".gitlab-ci.yml"].includes(lower);
}

function containsLikelySecret(text: string): boolean {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:sk-[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9_]{24,}|AKIA[0-9A-Z]{16})\b/,
    /["']?[a-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|password|private[_-]?key|secret|token)[a-z0-9_-]*["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

interface IgnoreRule { pattern: RegExp; negate: boolean; }

function parseIgnoreRules(text: string): IgnoreRule[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    let line = raw.trim();
    if (!line || line.startsWith("#")) return [];
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    line = line.replace(/^\//, "").replace(/\/$/, "");
    if (!line) return [];
    return [{ pattern: globToRegExp(line), negate }];
  });
}

function globToRegExp(glob: string): RegExp {
  const hasSlash = glob.includes("/");
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return hasSlash ? new RegExp(`^${source}(?:/.*)?$`) : new RegExp(`(?:^|/)${source}(?:/.*)?$`);
}

function isIgnored(relative: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  const candidate = isDirectory ? `${relative}/` : relative;
  let ignored = false;
  for (const rule of rules) {
    if (rule.pattern.test(relative) || (isDirectory && rule.pattern.test(candidate))) ignored = !rule.negate;
  }
  return ignored;
}

function rootObjectPropertyRange(text: string, property: string): { start: number; end: number } | undefined {
  let cursor = skipWhitespace(text, 0);
  if (text[cursor] !== "{") return undefined;
  cursor += 1;
  while (cursor < text.length) {
    cursor = skipWhitespaceAndCommas(text, cursor);
    if (text[cursor] === "}") return undefined;
    const key = readJsonString(text, cursor);
    if (!key) return undefined;
    cursor = skipWhitespace(text, key.end);
    if (text[cursor] !== ":") return undefined;
    const valueStart = skipWhitespace(text, cursor + 1);
    const valueEnd = skipJsonValue(text, valueStart);
    if (key.value === property && text[valueStart] === "{") return { start: valueStart, end: valueEnd };
    cursor = valueEnd;
  }
  return undefined;
}

function objectMemberLine(text: string, objectStart: number, objectEnd: number, property: string): number | undefined {
  let cursor = objectStart + 1;
  while (cursor < objectEnd - 1) {
    cursor = skipWhitespaceAndCommas(text, cursor);
    if (text[cursor] === "}") return undefined;
    const keyStart = cursor;
    const key = readJsonString(text, cursor);
    if (!key) return undefined;
    cursor = skipWhitespace(text, key.end);
    if (text[cursor] !== ":") return undefined;
    const valueStart = skipWhitespace(text, cursor + 1);
    const valueEnd = skipJsonValue(text, valueStart);
    if (key.value === property && text[valueStart] === '"') {
      return text.slice(0, keyStart).split("\n").length;
    }
    cursor = valueEnd;
  }
  return undefined;
}

function readJsonString(text: string, start: number): { value: string; end: number } | undefined {
  if (text[start] !== '"') return undefined;
  let cursor = start + 1;
  let escaped = false;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') {
      const token = text.slice(start, cursor + 1);
      try { return { value: JSON.parse(token) as string, end: cursor + 1 }; } catch { return undefined; }
    }
    cursor += 1;
  }
  return undefined;
}

function skipJsonValue(text: string, start: number): number {
  if (text[start] === '"') return readJsonString(text, start)?.end ?? text.length;
  if (text[start] !== "{" && text[start] !== "[") {
    let cursor = start;
    while (cursor < text.length && ![",", "}", "]"].includes(text[cursor]!)) cursor += 1;
    return cursor;
  }
  const stack = [text[start] === "{" ? "}" : "]"];
  let cursor = start + 1;
  while (cursor < text.length && stack.length > 0) {
    if (text[cursor] === '"') {
      cursor = readJsonString(text, cursor)?.end ?? text.length;
      continue;
    }
    if (text[cursor] === "{") stack.push("}");
    else if (text[cursor] === "[") stack.push("]");
    else if (text[cursor] === stack.at(-1)) stack.pop();
    cursor += 1;
  }
  return cursor;
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function skipWhitespaceAndCommas(text: string, start: number): number {
  let cursor = start;
  while (text[cursor] === "," || /\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function relativeLabel(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}
