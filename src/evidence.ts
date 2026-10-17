import { createHash } from "node:crypto";
import path from "node:path";
import { describeRequestFailure, registeredRequestFailure } from "./request-failure.ts";
import { encodeRepositoryPath, type GitHubResearcher } from "./github.ts";
import { chooseRootLicensePath, isTestPath, isTextSourcePath, rankTreeFiles, type RankedTerm } from "./file-ranking.ts";
import { REDACTED_VALUE, chooseLocalReferenceFiles, localReadFailureText, readLocalSource, type LocalIndex } from "./local.ts";
import type {
  EvidenceExcerpt,
  EvidenceSource,
  FinalSource,
  RepositorySnapshot,
  ResearchGap,
  SelectedFile,
  SelectedFileRole,
  TreeFile,
} from "./types.ts";

export interface LoadedEvidence {
  sources: EvidenceSource[];
  excerpts: EvidenceExcerpt[];
  bytesBySourceId: Map<string, Uint8Array>;
  textBySourceId: Map<string, string>;
  gaps: ResearchGap[];
}

interface FileToRead {
  file: TreeFile;
  roles: SelectedFileRole[];
  kind: "local" | "remote";
  repository?: RepositorySnapshot;
}

interface FilePlanInput {
  file: TreeFile;
  role: SelectedFileRole;
  kind: "local" | "remote";
  repository?: RepositorySnapshot;
}

export async function loadSelectedEvidence(options: {
  local: LocalIndex;
  repositories: RepositorySnapshot[];
  modelSelection: SelectedFile[];
  github: GitHubResearcher;
  relevantText: string;
  domainTerms?: RankedTerm[];
  signal?: AbortSignal;
}): Promise<LoadedEvidence> {
  const remoteTrees = options.repositories.flatMap((repository) => repository.files.map((file) => ({ file, repository })));
  const remoteById = new Map(remoteTrees.map((entry) => [entry.file.id, entry]));
  const localById = new Map(options.local.files.map((file) => [file.id, file]));
  const planned = new Map<string, FileToRead>();
  const gaps: ResearchGap[] = [];

  const add = (entry: FilePlanInput): boolean => {
    const existing = planned.get(entry.file.id);
    if (existing) {
      if (!existing.roles.includes(entry.role)) existing.roles.push(entry.role);
      return true;
    }
    if (entry.kind === "remote" && remoteReadCount(planned) >= 24) return false;
    planned.set(entry.file.id, { ...entry, roles: [entry.role] });
    return true;
  };

  const localReferences = chooseLocalReferenceFiles(options.local.files);
  for (const category of ["manifest", "license", "ci"] as const) {
    if (!localReferences.some((entry) => entry.role === category)) {
      gaps.push({ kind: "local", message: `The local project has no indexed ${category} file; new-project verification commands will be planned as to_create.`, material: false });
    }
  }
  for (const { file, role } of localReferences) {
    if (!add({ file, role, kind: "local" })) gaps.push({ kind: "local", message: `The local ${role} reference ${file.path} exceeded the evidence read budget.`, material: true });
  }

  for (const repository of options.repositories) {
    const references = chooseRepositoryReferenceFiles(repository.files);
    if (repository.treeTruncated) {
      gaps.push({ kind: "tree", message: `The indexed tree for ${repository.candidate.fullName} was truncated at ${repository.commitSha}.`, material: true });
    }
    for (const category of ["manifest", "license", "ci"] as const) {
      if (!references.some((entry) => entry.role === category)) {
        gaps.push({ kind: "repository", message: `${repository.candidate.fullName} has no indexed ${category} file at ${repository.commitSha}.`, material: category === "manifest" });
      }
    }
    const selectedFromRepository = options.modelSelection.flatMap((selection) => {
      const entry = remoteById.get(selection.fileId);
      return entry?.repository.candidate.id === repository.candidate.id ? [{ selection, file: entry.file }] : [];
    });
    const ranked = rankTreeFiles(repository.files, options.domainTerms ?? [], repository.files.length);
    const filesById = new Map(repository.files.map((file) => [file.id, file]));
    const codeMatched = (repository.codeMatches ?? []).flatMap((match) => filesById.get(match.fileId) ?? []);
    const selectedProduction = selectedFromRepository.find(({ selection, file }) => selection.role === "production" && isImplementationSourceFile(file.path));
    const production = selectedProduction?.file
      ?? codeMatched.find((file) => isImplementationSourceFile(file.path))
      ?? ranked.find((file) => isImplementationSourceFile(file.path));
    const selectedTest = selectedFromRepository.find(({ selection, file }) => selection.role === "test" && isTestPath(file.path) && isTextSourcePath(file.path));
    const test = selectedTest?.file
      ?? codeMatched.find((file) => isTestPath(file.path) && isTextSourcePath(file.path))
      ?? ranked.find((file) => isTestPath(file.path));
    if (production) {
      if (!add({ file: production, role: "production", kind: "remote", repository })) {
        gaps.push({ kind: "repository", message: `Production source ${production.path} for ${repository.candidate.fullName} exceeded the 24-file remote source budget.`, material: true });
      }
    } else {
      gaps.push({ kind: "repository", message: `No readable production source file was found for ${repository.candidate.fullName}.`, material: true });
    }
    if (test) {
      if (!add({ file: test, role: "test", kind: "remote", repository })) {
        gaps.push({ kind: "repository", message: `Test source ${test.path} for ${repository.candidate.fullName} exceeded the 24-file remote source budget.`, material: true });
      }
    } else {
      gaps.push({ kind: "repository", message: `No readable test source file was found for ${repository.candidate.fullName}.`, material: true });
    }
    if (!references.some((entry) => entry.role === "config")) {
      gaps.push({ kind: "repository", message: `${repository.candidate.fullName} has no indexed test configuration file; test conventions must be established from its tests.`, material: false });
    }
    for (const { file, role } of references) {
      if (!add({ file, role, kind: "remote", repository })) {
        gaps.push({ kind: "repository", message: `The ${role} reference for ${repository.candidate.fullName} exceeded the 24-file remote source budget.`, material: true });
      }
    }
  }

  for (const selected of options.modelSelection) {
    const localFile = localById.get(selected.fileId);
    if (localFile) {
      if (selected.role === "test" && !isTestPath(localFile.path)) continue;
      if (selected.role === "production" && !isImplementationSourceFile(localFile.path)) continue;
      if (!add({ file: localFile, role: selected.role, kind: "local" })) {
        gaps.push({ kind: "local", message: `The selected local file ${localFile.path} exceeded the evidence budget.`, material: true });
      }
      continue;
    }
    const remoteFile = remoteById.get(selected.fileId);
    if (!remoteFile || (selected.role === "test" && !isTestPath(remoteFile.file.path)) || (selected.role === "production" && !isImplementationSourceFile(remoteFile.file.path))) continue;
    if (!add({ file: remoteFile.file, role: selected.role, kind: "remote", repository: remoteFile.repository })) {
      gaps.push({ kind: "repository", message: `The selected file ${remoteFile.file.path} from ${remoteFile.repository.candidate.fullName} exceeded the 24-file remote source budget.`, material: true });
    }
  }

  const sources: EvidenceSource[] = [];
  const excerpts: EvidenceExcerpt[] = [];
  const bytesBySourceId = new Map<string, Uint8Array>();
  const textBySourceId = new Map<string, string>();
  let excerptCharacters = 0;
  const maxContextCharacters = 260_000;
  let sourceNumber = 0;
  let excerptNumber = 0;

  for (const item of planned.values()) {
    if (options.signal?.aborted) {
      gaps.push({ kind: item.kind === "local" ? "local" : "file", message: "Source reading stopped after cancellation.", material: true });
      break;
    }
    try {
      let redactions = 0;
      let bytes: Uint8Array;
      if (item.kind === "local") {
        const local = await readLocalSource(options.local.root, item.file);
        bytes = local.bytes;
        redactions = local.redactions;
      } else {
        bytes = await options.github.fetchSource(item.repository!, item.file.path, options.signal);
      }
      if (bytes.byteLength > (item.kind === "local" ? 256_000 : 1_000_000)) {
        throw new EvidenceReadError(item.kind === "local" ? "local_size_limit" : "remote_size_limit");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new EvidenceReadError("invalid_utf8");
      }
      if (text.includes("\u0000")) throw new EvidenceReadError("binary");
      const lines = splitLines(text);
      const sourceId = `S${++sourceNumber}`;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const source: EvidenceSource = {
        id: sourceId,
        kind: item.kind,
        path: item.file.path,
        sha256,
        lineCount: lines.length,
        byteCount: bytes.byteLength,
        snapshotPath: `sources/${sourceId}.txt`,
        roles: item.roles,
      };
      if (item.kind === "remote") {
        const repository = item.repository!;
        source.provider = repository.candidate.provider;
        source.repository = repository.candidate.fullName;
        source.commitSha = repository.commitSha;
        if (repository.commitDate) source.commitDate = repository.commitDate;
        if (repository.candidate.lastActivityAt) source.lastActivityAt = repository.candidate.lastActivityAt;
        source.permalink = repositoryPermalink(repository, item.file.path);
      }
      sources.push(source);
      bytesBySourceId.set(sourceId, bytes);
      textBySourceId.set(sourceId, text);
      if (redactions > 0) {
        gaps.push({ kind: "local", message: `Replaced ${redactions} likely secret value(s) in ${item.file.path} with ${REDACTED_VALUE} before any model turn; the saved snapshot and its SHA-256 cover the redacted text.`, material: false });
      }

      const anchors = item.kind === "remote"
        ? item.repository!.codeMatches?.find((match) => match.fileId === item.file.id)?.patterns
        : undefined;
      const ranges = chooseExcerptRanges(lines, options.relevantText, Math.max(0, maxContextCharacters - excerptCharacters), anchors);
      if (ranges.length === 0) {
        gaps.push({ kind: item.kind === "local" ? "local" : "file", message: `No excerpt context remained for ${item.file.path}.`, material: true });
        continue;
      }
      for (const range of ranges) {
        const chunk = lines.slice(range.startLine - 1, range.endLine).join("\n");
        if (excerptCharacters + chunk.length > maxContextCharacters) {
          gaps.push({ kind: item.kind === "local" ? "local" : "file", message: `The excerpt for ${item.file.path} exceeded the total context budget.`, material: true });
          continue;
        }
        excerptCharacters += chunk.length;
        excerpts.push({ id: `E${++excerptNumber}`, sourceId, startLine: range.startLine, endLine: range.endLine, text: chunk });
      }
    } catch (error) {
      if (options.signal?.aborted) break;
      const repository = item.kind === "remote" ? ` from ${item.repository!.candidate.fullName}` : "";
      gaps.push({
        kind: item.kind === "local" ? "local" : "file",
        message: `Could not read ${item.file.path}${repository}; ${describeReadFailure(error)}.`,
        material: true,
      });
    }
  }

  return { sources, excerpts, bytesBySourceId, textBySourceId, gaps };
}

export function finalSources(sources: EvidenceSource[], excerpts: EvidenceExcerpt[]): FinalSource[] {
  return sources.map((source) => ({
    id: source.id,
    kind: source.kind,
    path: source.path,
    location: source.kind === "remote" && source.permalink ? source.permalink : source.path,
    snapshotPath: source.snapshotPath,
    sha256: source.sha256,
    lineCount: source.lineCount,
    byteCount: source.byteCount,
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.repository ? { repository: source.repository } : {}),
    ...(source.commitSha ? { commitSha: source.commitSha } : {}),
    ...(source.commitDate ? { commitDate: source.commitDate } : {}),
    ...(source.lastActivityAt ? { lastActivityAt: source.lastActivityAt } : {}),
    ...(source.permalink ? { permalink: source.permalink } : {}),
    roles: source.roles,
    excerpts: excerpts.filter((excerpt) => excerpt.sourceId === source.id).map(({ id, startLine, endLine }) => ({ id, startLine, endLine })),
  }));
}

export function excerptPromptData(sources: EvidenceSource[], excerpts: EvidenceExcerpt[]): string {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return JSON.stringify({
    sources: sources.map((source) => ({
      sourceId: source.id,
      kind: source.kind,
      provider: source.provider ?? null,
      path: source.path,
      repository: source.repository ?? null,
      commitSha: source.commitSha ?? null,
      commitDate: source.commitDate ?? null,
      lastActivityAt: source.lastActivityAt ?? null,
      sha256: source.sha256,
      roles: source.roles,
      excerptIds: excerpts.filter((excerpt) => excerpt.sourceId === source.id).map((excerpt) => excerpt.id),
    })),
    excerpts: excerpts.map((excerpt) => ({
      excerptId: excerpt.id,
      sourceId: excerpt.sourceId,
      path: sourceById.get(excerpt.sourceId)?.path ?? "",
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      untrustedSourceText: excerpt.text,
    })),
  });
}

export function sourceLocation(source: EvidenceSource, startLine: number, endLine: number): string {
  const range = source.provider === "gitlab" ? `#L${startLine}-${endLine}` : `#L${startLine}-L${endLine}`;
  if (source.permalink) return `${source.permalink}${range}`;
  return `${source.path}#L${startLine}-L${endLine}`;
}

function chooseRepositoryReferenceFiles(files: TreeFile[]): Array<{ file: TreeFile; role: "manifest" | "ci" | "license" | "config" }> {
  const choose = (predicate: (file: TreeFile) => boolean): TreeFile | undefined => files.find(predicate);
  const rootFile = (name: string): ((file: TreeFile) => boolean) => (file) => path.posix.dirname(file.path) === "." && path.posix.basename(file.path).toLowerCase() === name;
  const result: Array<{ file: TreeFile; role: "manifest" | "ci" | "license" | "config" }> = [];
  const manifest = choose((file) => path.posix.dirname(file.path) === "." && /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|composer\.json)$/i.test(path.posix.basename(file.path)));
  if (manifest) result.push({ file: manifest, role: "manifest" });
  const licensePath = chooseRootLicensePath(files.map((file) => file.path));
  const license = (licensePath ? files.find((file) => file.path === licensePath) : undefined)
    ?? choose((file) => path.posix.dirname(file.path) === "." && /^notice(\.txt|\.md|\.rst)?$/i.test(path.posix.basename(file.path)));
  if (license && !result.some((entry) => entry.file.id === license.id)) result.push({ file: license, role: "license" });
  const ci = choose((file) => file.path.startsWith(".github/workflows/") || rootFile(".gitlab-ci.yml")(file) || rootFile("jenkinsfile")(file));
  if (ci && !result.some((entry) => entry.file.id === ci.id)) result.push({ file: ci, role: "ci" });
  const testConfig = choose((file) => /(^|\/)(jest|vitest|playwright|cypress|karma|mocha|pytest|tox)\.config\.[^/]+$/i.test(file.path)
    || /(^|\/)(pytest\.ini|tox\.ini|phpunit\.xml|\.mocharc(?:\.[^/]+)?)$/i.test(file.path));
  if (testConfig && !result.some((entry) => entry.file.id === testConfig.id)) result.push({ file: testConfig, role: "config" });
  return result;
}

function isImplementationSourceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (!isTextSourcePath(lower) || isTestPath(lower)) return false;
  if (/(^|\/)(docs?|examples?|fixtures|testdata|vendor|node_modules|third_party)\//.test(lower)) return false;
  if (/^(\.github|\.gitlab|\.circleci|\.buildkite)\//.test(lower) || /(^|\/)\.github\/workflows\//.test(lower)) return false;
  const basename = path.posix.basename(lower);
  if (/^(readme|license|licen[sc]e|unlicense|copying|notice)(\.|$)/.test(basename)) return false;
  if (/^(package(-lock)?\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|cargo\.(toml|lock)|go\.(mod|sum)|pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock)|tsconfig[^/]*\.json)$/.test(basename)) return false;
  if (/^(jest|vitest|playwright|cypress|karma|mocha|webpack|vite|rollup|babel|postcss|tailwind|eslint|prettier)\.config\./.test(basename)
    || /^(pytest\.ini|tox\.ini|phpunit\.xml|\.mocharc)/.test(basename)) return false;
  return /\.(c|cc|cpp|cs|css|go|h|hpp|html?|java|js|jsx|kt|mjs|php|py|rb|rs|scss|sh|sql|swift|ts|tsx|vue|zig)$/i.test(basename);
}

function remoteReadCount(planned: Map<string, FileToRead>): number {
  return [...planned.values()].filter((item) => item.kind === "remote").length;
}

function repositoryPermalink(repository: RepositorySnapshot, filePath: string): string {
  const encodedRepository = encodeRepositoryPath(repository.candidate.fullName);
  const encodedPath = encodeRepositoryPath(filePath);
  if (repository.candidate.provider === "gitlab") {
    return `https://gitlab.com/${encodedRepository}/-/blob/${repository.commitSha}/${encodedPath}`;
  }
  return `https://github.com/${encodedRepository}/blob/${repository.commitSha}/${encodedPath}`;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "" && /\r?\n$/.test(text)) lines.pop();
  return lines;
}

const DEFINITION_LINE = /\b(class|def|function|func|fn|interface|struct|type|enum|const|let|var)\b/;

function chooseExcerptRanges(lines: string[], relevantText: string, remainingCharacters: number, anchors: string[] = []): Array<{ startLine: number; endLine: number }> {
  if (lines.length === 0 || remainingCharacters <= 0) return [];
  const maxChunkLines = 90;
  const maxChunkChars = Math.min(9_000, remainingCharacters);
  const matchTerms = [...new Set(relevantText.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])].slice(0, 30);
  const anchorTerms = anchors.map((anchor) => anchor.toLowerCase());
  let bestLine = 0;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const lower = lines[index]!.toLowerCase();
    const termScore = matchTerms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    // A definition of a code-search pattern beats an import or a call that only mentions it.
    const anchorScore = anchorTerms.reduce((sum, anchor) => sum + (!lower.includes(anchor) ? 0 : DEFINITION_LINE.test(lower) ? 20 : 10), 0);
    const score = termScore + anchorScore;
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  }
  const windows: Array<{ start: number; end: number }> = [];
  if (lines.length <= maxChunkLines) windows.push({ start: 0, end: lines.length });
  else {
    const firstEnd = Math.min(maxChunkLines, lines.length);
    windows.push({ start: 0, end: firstEnd });
    const aroundStart = Math.max(0, Math.min(lines.length - maxChunkLines, bestLine - Math.floor(maxChunkLines / 3)));
    const aroundEnd = Math.min(lines.length, aroundStart + maxChunkLines);
    if (aroundStart > 0 || aroundEnd > firstEnd) windows.push({ start: aroundStart, end: aroundEnd });
  }
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let used = 0;
  for (const window of windows) {
    if (ranges.some((range) => window.start + 1 === range.startLine && window.end === range.endLine)) continue;
    let end = window.end;
    let chars = lines.slice(window.start, end).reduce((sum, line) => sum + line.length + 1, 0);
    while (end > window.start + 1 && chars > maxChunkChars) {
      chars -= lines[end - 1]!.length + 1;
      end -= 1;
    }
    if (chars <= 0 || used + chars > remainingCharacters) continue;
    ranges.push({ startLine: window.start + 1, endLine: end });
    used += chars;
  }
  return ranges;
}

type EvidenceReadReason = "remote_size_limit" | "local_size_limit" | "invalid_utf8" | "binary";

const EVIDENCE_READ_ERROR_MESSAGES: Record<EvidenceReadReason, string> = {
  remote_size_limit: "the content exceeded the 1 MB remote file limit",
  local_size_limit: "the content exceeded the 256 KB local file limit",
  invalid_utf8: "the content is not valid UTF-8 text",
  binary: "the content is binary",
};

const EVIDENCE_READ_REASONS = new WeakMap<object, EvidenceReadReason>();

function evidenceReadFailureText(error: unknown): string | undefined {
  const reason = EVIDENCE_READ_REASONS.get(error as object);
  if (reason === undefined) return undefined;
  if (!Object.hasOwn(EVIDENCE_READ_ERROR_MESSAGES, reason)) return undefined;
  return EVIDENCE_READ_ERROR_MESSAGES[reason];
}

class EvidenceReadError extends Error {
  readonly reason: EvidenceReadReason;

  constructor(reason: EvidenceReadReason) {
    super(EVIDENCE_READ_ERROR_MESSAGES[reason]);
    this.name = "EvidenceReadError";
    this.reason = reason;
    EVIDENCE_READ_REASONS.set(this, reason);
  }
}

function describeReadFailure(error: unknown): string {
  const failure = registeredRequestFailure(error);
  if (failure) return describeRequestFailure(failure);
  return localReadFailureText(error) ?? evidenceReadFailureText(error) ?? "the file could not be read";
}
