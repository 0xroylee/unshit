import { createHash } from "node:crypto";
import path from "node:path";
import { describeRequestFailure, registeredRequestFailure } from "./request-failure.ts";
import { encodeRepositoryPath, type GitHubResearcher } from "./github.ts";
import { chooseRootLicensePath, isTestPath, isTextSourcePath, rankTreeFiles, type RankedTerm } from "./file-ranking.ts";
import { REDACTED_VALUE, chooseLocalReferenceFiles, localReadFailureText, readLocalSource, type LocalIndex } from "./local.ts";
import type {
  EvidenceExcerpt,
  EvidenceRequest,
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

// All excerpts that a plan turn receives fit in this many characters.
export const EXCERPT_BUDGET = 260_000;

export async function loadSelectedEvidence(options: {
  local: LocalIndex;
  repositories: RepositorySnapshot[];
  modelSelection: SelectedFile[];
  github: GitHubResearcher;
  relevantText: string;
  // The characters these excerpts can use, EXCERPT_BUDGET when not given. `runWorkflow` keeps part of the budget for
  // the excerpts that the model asks for afterwards (`addRequestedEvidence`).
  excerptBudget?: number;
  // The brief's code patterns. Excerpt scoring uses them in every planned file, local or remote (see `lineScore`).
  codePatterns?: string[];
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
  const maxContextCharacters = options.excerptBudget ?? EXCERPT_BUDGET;
  let excerptNumber = 0;

  const items = [...planned.values()];
  for (const [index, item] of items.entries()) {
    if (options.signal?.aborted) {
      gaps.push({ kind: item.kind === "local" ? "local" : "file", message: "Source reading stopped after cancellation.", material: true });
      break;
    }
    try {
      const { source, bytes, text, lines, redactionGap } = await readSource(item, `S${sources.length + 1}`, options);
      const sourceId = source.id;
      sources.push(source);
      bytesBySourceId.set(sourceId, bytes);
      textBySourceId.set(sourceId, text);
      if (redactionGap) gaps.push(redactionGap);

      // Each file gets an equal share of what is left, so a small file passes its unused share to the files after it.
      const share = Math.floor(Math.max(0, maxContextCharacters - excerptCharacters) / (items.length - index));
      const ranges = chooseExcerptRanges(lines, options.relevantText, share, options.codePatterns ?? []);
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

// Reads one file, checks its size and text, and describes it as source `sourceId`. Throws when the file cannot be used.
async function readSource(
  item: FileToRead,
  sourceId: string,
  options: { local: LocalIndex; github: GitHubResearcher; signal?: AbortSignal },
): Promise<{ source: EvidenceSource; bytes: Uint8Array; text: string; lines: string[]; redactionGap?: ResearchGap }> {
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
  const source: EvidenceSource = {
    id: sourceId,
    kind: item.kind,
    path: item.file.path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
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
  const redactionGap: ResearchGap | undefined = redactions > 0
    ? { kind: "local", message: `Replaced ${redactions} likely secret value(s) in ${item.file.path} with ${REDACTED_VALUE} before any model turn; the saved snapshot and its SHA-256 cover the redacted text.`, material: false }
    : undefined;
  return { source, bytes, text, lines, ...(redactionGap ? { redactionGap } : {}) };
}

// At most this many unread files can be added on request.
export const MAX_REQUESTED_FILES = 6;

export interface AddedEvidence {
  // The given evidence with the added sources and excerpts after its own; its `gaps` are the given evidence's.
  evidence: LoadedEvidence;
  // A non-material gap for each request that the host could not serve, and for each redacted file it added.
  gaps: ResearchGap[];
  // The requests whose source is in the excerpts afterwards, added now or there before.
  served: number;
  // The excerpts added.
  added: number;
}

// Adds what the model asked for after reading the first excerpts, within what is left of EXCERPT_BUDGET. Requests are
// served in order. A `definition` request takes the line from `requestedDefinitionLine` and the first of its
// regionChoices whose lines not yet excerpted fit what is left. A `lines` request takes its range when the lines not
// yet excerpted fit. A `file` request reads a file from `unreadFileIds`, at most MAX_REQUESTED_FILES of them, and
// excerpts it with `chooseExcerptRanges` within an equal share of what is left. Lines that are already excerpted are
// not added again.
export async function addRequestedEvidence(
  loaded: LoadedEvidence,
  requests: EvidenceRequest[],
  options: {
    local: LocalIndex;
    repositories: RepositorySnapshot[];
    // The IDs of the unread files that the request prompt listed; only these can be read.
    unreadFileIds: Set<string>;
    github: GitHubResearcher;
    relevantText: string;
    codePatterns?: string[];
    signal?: AbortSignal;
  },
): Promise<AddedEvidence> {
  const sources = [...loaded.sources];
  const excerpts = [...loaded.excerpts];
  const bytesBySourceId = new Map(loaded.bytesBySourceId);
  const textBySourceId = new Map(loaded.textBySourceId);
  const gaps: ResearchGap[] = [];
  let used = excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
  let served = 0;
  let added = 0;
  let filesRead = 0;
  const requestedFileIds = new Set<string>();
  const localById = new Map(options.local.files.map((file) => [file.id, file]));
  const remoteById = new Map(options.repositories.flatMap((repository) => repository.files.map((file) => [file.id, { file, repository }] as const)));
  const skip = (request: EvidenceRequest, why: string): void => {
    gaps.push({ kind: "file", material: false, message: `The model asked for ${describeRequest(request)}; ${why}` });
  };
  const addWindows = (sourceId: string, lines: string[], windows: LineWindow[]): void => {
    for (const window of windows) {
      const text = lines.slice(window.start, window.end).join("\n");
      excerpts.push({ id: `E${excerpts.length + 1}`, sourceId, startLine: window.start + 1, endLine: window.end, text });
      used += text.length;
      added += 1;
    }
  };

  for (const [index, request] of requests.entries()) {
    if (options.signal?.aborted) break;
    const left = EXCERPT_BUDGET - used;
    if (request.kind === "file") {
      const later = requests.slice(index).filter((entry) => entry.kind === "file").length;
      if (filesRead === MAX_REQUESTED_FILES) {
        skip(request, `at most ${MAX_REQUESTED_FILES} unread files can be added.`);
        continue;
      }
      if (!options.unreadFileIds.has(request.id) || requestedFileIds.has(request.id)) {
        skip(request, "it is not in the unread file list.");
        continue;
      }
      const local = localById.get(request.id);
      const remote = remoteById.get(request.id);
      const file = local ?? remote?.file;
      if (!file) {
        skip(request, "it is not in the unread file list.");
        continue;
      }
      requestedFileIds.add(request.id);
      filesRead += 1;
      const role: SelectedFileRole = isTestPath(file.path) ? "test" : isImplementationSourceFile(file.path) ? "production" : "config";
      const item: FileToRead = local ? { file, roles: [role], kind: "local" } : { file, roles: [role], kind: "remote", repository: remote!.repository };
      try {
        const { source, bytes, text, lines, redactionGap } = await readSource(item, `S${sources.length + 1}`, options);
        sources.push(source);
        bytesBySourceId.set(source.id, bytes);
        textBySourceId.set(source.id, text);
        if (redactionGap) gaps.push(redactionGap);
        const share = Math.floor(left / Math.min(later, MAX_REQUESTED_FILES - filesRead + 1));
        const ranges = chooseExcerptRanges(lines, options.relevantText, share, options.codePatterns ?? []);
        if (ranges.length === 0) {
          skip(request, `no excerpt of ${file.path} fit the ${share} characters of its share.`);
          continue;
        }
        addWindows(source.id, lines, ranges.map((range) => ({ start: range.startLine - 1, end: range.endLine })));
        served += 1;
      } catch (error) {
        if (options.signal?.aborted) break;
        skip(request, `the host could not read it; ${describeReadFailure(error)}.`);
      }
      continue;
    }
    const source = sources.find((entry) => entry.id === request.id);
    const text = source ? textBySourceId.get(source.id) : undefined;
    if (!source || text === undefined) {
      skip(request, "no source has that ID.");
      continue;
    }
    const lines = splitLines(text);
    const taken = excerpts.filter((excerpt) => excerpt.sourceId === source.id);
    let choices: LineWindow[];
    if (request.kind === "lines") {
      if (request.startLine < 1 || request.endLine < request.startLine || request.endLine > lines.length) {
        skip(request, `${source.path} has lines 1 to ${lines.length}.`);
        continue;
      }
      choices = [{ start: request.startLine - 1, end: request.endLine }];
    } else {
      const hit = requestedDefinitionLine(lines, request.name);
      if (hit === undefined) {
        skip(request, `no line of ${source.path} holds ${request.name}.`);
        continue;
      }
      choices = regionChoices(lines, hit);
    }
    const parts = choices.map((choice) => uncoveredParts(choice, taken));
    if (parts[0]!.length === 0) {
      served += 1;
      continue;
    }
    const cost = (windows: LineWindow[]): number => windows.reduce((sum, window) => sum + lines.slice(window.start, window.end).join("\n").length, 0);
    const fitting = parts.find((windows) => cost(windows) <= left);
    if (!fitting) {
      skip(request, `it does not fit the ${left} characters left.`);
      continue;
    }
    addWindows(source.id, lines, fitting);
    served += 1;
  }
  return { evidence: { sources, excerpts, bytesBySourceId, textBySourceId, gaps: loaded.gaps }, gaps, served, added };
}

function describeRequest(request: EvidenceRequest): string {
  if (request.kind === "file") return `file ${request.id}`;
  if (request.kind === "lines") return `lines ${request.startLine} to ${request.endLine} of ${request.id}`;
  return `${request.name} in ${request.id}`;
}

// The line that a definition request points at: the first line that matches BLOCK_START and holds `name` as a whole
// word, or else the first line that holds it as a whole word. A word here is a run of letters, digits, `_` and `$`.
function requestedDefinitionLine(lines: string[], name: string): number | undefined {
  const word = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  let mention: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (!word.test(line)) continue;
    if (BLOCK_START.test(line)) return index;
    mention ??= index;
  }
  return mention;
}

// The parts of `window` that no range in `taken` holds, in line order.
function uncoveredParts(window: LineWindow, taken: Array<{ startLine: number; endLine: number }>): LineWindow[] {
  const parts: LineWindow[] = [];
  let start = window.start;
  for (const range of [...taken].sort((left, right) => left.startLine - right.startLine)) {
    if (range.endLine <= start || range.startLine - 1 >= window.end) continue;
    if (range.startLine - 1 > start) parts.push({ start, end: range.startLine - 1 });
    start = Math.max(start, range.endLine);
  }
  if (start < window.end) parts.push({ start, end: window.end });
  return parts;
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

// Lines that hold one of these words get the larger anchor bonus in `lineScore`. This list differs from BLOCK_START's.
const DEFINITION_LINE = /\b(class|def|function|func|fn|interface|struct|type|enum|const|let|var)\b/;

const HEAD_LINES = 30;
const MAX_REGION_LINES = 150;
const AROUND_LINES = 60;
// How far the search for a definition's start or end may go.
const SCAN_LINES = 600;
// The first line of a definition, for `enclosingDefinition`. It matches `class`, `def`, `function`, `func`, `fn`,
// `interface`, `struct`, `enum`, `impl` or `trait` as the first word after indentation and optional modifiers (`export`,
// `default`, `abstract`, `async`, `public`, `private`, `protected`, `static`, `pub`, `final`, `override`); `type` as the
// first word, after an optional `export`, on a line whose last non-blank character is `{`; and some `const`, `let` or
// `var` lines whose value is a function (the pattern gives the exact forms). This keyword list differs from
// DEFINITION_LINE's.
const BLOCK_START = /^\s*(?:(?:export|default|abstract|async|public|private|protected|static|pub|final|override)\s+)*(?:class|def|function|func|fn|interface|struct|enum|impl|trait)\b|^\s*(?:export\s+)?type\b.*\{\s*$|^\s*(?:export\s+)?(?:const|let|var)\b[^=]*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;

// Lines `start` to `end - 1` of a file, counted from 0.
interface LineWindow {
  start: number;
  end: number;
}

// An empty file, or a budget of 0 or less, gives no excerpt. A file whose whole text fits the budget is one window. Any
// other file gives its first HEAD_LINES lines (all of them in a shorter file), cut from the end while they do not fit;
// if its first line alone does not fit, the file gets no excerpt. Then the lines with a score above 0 come in order of
// score, higher first, then of position, earlier first, skipping lines that a taken window already holds. Each such
// line takes the first of its regionChoices that fits what is left of the budget, and the first line for which none
// fits ends the file's excerpt. Ranges come back in line order, with overlapping windows merged.
function chooseExcerptRanges(lines: string[], relevantText: string, budget: number, anchors: string[] = []): Array<{ startLine: number; endLine: number }> {
  if (lines.length === 0 || budget <= 0) return [];
  // The excerpt joins its lines with newlines and has none after the last line.
  const cost = (window: LineWindow): number => lines.slice(window.start, window.end).reduce((sum, line) => sum + line.length + 1, 0) - 1;
  if (cost({ start: 0, end: lines.length }) <= budget) return [{ startLine: 1, endLine: lines.length }];
  const head = { start: 0, end: Math.min(HEAD_LINES, lines.length) };
  while (head.end > 1 && cost(head) > budget) head.end -= 1;
  let used = cost(head);
  if (used > budget) return [];
  const windows: LineWindow[] = [head];
  const matchTerms = [...new Set(relevantText.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])].slice(0, 30);
  const anchorTerms = anchors.map((anchor) => anchor.toLowerCase());
  const hits = lines
    .map((line, index) => ({ index, score: lineScore(line.toLowerCase(), matchTerms, anchorTerms) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  for (const hit of hits) {
    if (windows.some((window) => hit.index >= window.start && hit.index < window.end)) continue;
    const region = regionChoices(lines, hit.index).find((choice) => used + cost(choice) <= budget);
    if (!region) break;
    windows.push(region);
    used += cost(region);
  }
  windows.sort((left, right) => left.start - right.start);
  const merged: Array<{ startLine: number; endLine: number }> = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.start < last.endLine) last.endLine = Math.max(last.endLine, window.end);
    else merged.push({ startLine: window.start + 1, endLine: window.end });
  }
  return merged;
}

// A line's score: 1 for each match term that the line holds, plus, for each anchor that it holds, 20 if the line
// matches DEFINITION_LINE and 10 if it does not.
function lineScore(lower: string, matchTerms: string[], anchorTerms: string[]): number {
  const termScore = matchTerms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
  const anchorScore = anchorTerms.reduce((sum, anchor) => sum + (!lower.includes(anchor) ? 0 : DEFINITION_LINE.test(lower) ? 20 : 10), 0);
  return termScore + anchorScore;
}

// The windows that can show line `hit`, in the order they are tried. First the window that `enclosingDefinition`
// returns, if any. Then, if that window is longer than MAX_REGION_LINES, MAX_REGION_LINES of its lines, starting a
// third of that many lines above `hit` where the window allows. Last, AROUND_LINES lines starting a third of that many
// lines above `hit` where the file allows (the whole file if it is shorter). Every window holds `hit`.
function regionChoices(lines: string[], hit: number): LineWindow[] {
  const choices: LineWindow[] = [];
  const definition = enclosingDefinition(lines, hit);
  if (definition) {
    choices.push(definition);
    if (definition.end - definition.start > MAX_REGION_LINES) {
      const start = Math.max(definition.start, Math.min(definition.end - MAX_REGION_LINES, hit - Math.floor(MAX_REGION_LINES / 3)));
      choices.push({ start, end: start + MAX_REGION_LINES });
    }
  }
  const aroundStart = Math.max(0, Math.min(lines.length - AROUND_LINES, hit - Math.floor(AROUND_LINES / 3)));
  choices.push({ start: aroundStart, end: Math.min(lines.length, aroundStart + AROUND_LINES) });
  return choices;
}

// The window from the nearest line at or at most SCAN_LINES lines above `hit` that matches BLOCK_START and whose
// definitionEnd lies after `hit`, to that end. Undefined if there is none.
function enclosingDefinition(lines: string[], hit: number): LineWindow | undefined {
  for (let start = hit; start >= Math.max(0, hit - SCAN_LINES); start -= 1) {
    if (!BLOCK_START.test(lines[start]!)) continue;
    const end = definitionEnd(lines, start);
    if (end > hit) return { start, end };
  }
  return undefined;
}

// The exclusive end of the definition whose first line is `start`. If that line begins with `def` or `async def` after
// indentation, or ends with `:` before an optional `#` comment, braces are not counted. While no `{` has been counted,
// the definition ends before the next non-blank line that is not indented deeper than `start` and does not begin with
// `)`, `]` or `}`. After a `{`, it ends after the line where the count of `{` minus `}` falls to 0 or below. Without an
// end within the SCAN_LINES lines from `start`, the end is SCAN_LINES lines after `start`, or the end of the file.
function definitionEnd(lines: string[], start: number): number {
  const limit = Math.min(lines.length, start + SCAN_LINES);
  const indentedSuite = /^\s*(?:async\s+)?def\b/.test(lines[start]!) || /:\s*(?:#.*)?$/.test(lines[start]!);
  let depth = 0;
  let opened = false;
  for (let index = start; index < limit; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!opened && index > start && trimmed && indentOf(line) <= indentOf(lines[start]!) && !/^[)\]}]/.test(trimmed)) return index;
    if (indentedSuite) continue;
    for (const character of line) {
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}") depth -= 1;
    }
    if (opened && depth <= 0) return index + 1;
  }
  return limit;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
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
