import type { ResearchGap, RepositoryCandidate, RepositorySnapshot, TreeFile } from "./types.ts";

export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CandidateDiscovery {
  candidates: RepositoryCandidate[];
  gaps: ResearchGap[];
}

export interface TreeResolution {
  snapshots: RepositorySnapshot[];
  gaps: ResearchGap[];
}

interface ByteResponse {
  bytes: Uint8Array;
  headers: Headers;
}

export class GitHubResearcher {
  constructor(
    private readonly options: {
      fetch?: FetchFunction;
      githubToken?: string;
      gitlabToken?: string;
      timeoutMs?: number;
      treePathLimit?: number;
    } = {},
  ) {}

  async discover(
    queries: string[],
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<CandidateDiscovery> {
    const candidates: RepositoryCandidate[] = [];
    const gaps: ResearchGap[] = [];
    const seen = new Set<string>();
    let triedGitHub = false;
    let usedGitLab = false;
    for (const query of queries.slice(0, 3)) {
      if (signal?.aborted) break;
      const before = candidates.length;
      try {
        const url = new URL("https://api.github.com/search/repositories");
        url.searchParams.set("q", query);
        url.searchParams.set("per_page", "5");
        const result = await this.apiJson(url, "github", signal);
        triedGitHub = true;
        const entries = Array.isArray(result.value) ? result.value : isRecord(result.value) && Array.isArray(result.value.items) ? result.value.items : [];
        for (const entry of entries) {
          if (!isRecord(entry)) continue;
          const fullName = typeof entry.full_name === "string" ? entry.full_name : "";
          const defaultBranch = typeof entry.default_branch === "string" ? entry.default_branch : "";
          if (!isRepositoryName(fullName) || !defaultBranch || seen.has(`github:${fullName.toLowerCase()}`)) continue;
          seen.add(`github:${fullName.toLowerCase()}`);
          candidates.push({
            id: `C${candidates.length + 1}`,
            provider: "github",
            fullName,
            description: typeof entry.description === "string" ? entry.description.slice(0, 360) : "",
            defaultBranch,
            webUrl: `https://github.com/${fullName}`,
            ...(validTimestamp(entry.pushed_at) ? { lastActivityAt: validTimestamp(entry.pushed_at) } : {}),
          });
          if (candidates.length >= 15) break;
        }
        onProgress?.(`GitHub search returned ${Math.min(5, entries.length)} repository candidates.`);
      } catch (error) {
        if (signal?.aborted) break;
        triedGitHub = true;
        gaps.push({ kind: "search", message: `GitHub search failed for one query: ${safeError(error)}.`, material: candidates.length === 0 });
      }

      // GitLab is the public fallback when a GitHub query fails or finds no new candidate.
      if (candidates.length === before && candidates.length < 15 && !signal?.aborted) {
        try {
          const url = new URL("https://gitlab.com/api/v4/projects");
          url.searchParams.set("search", query);
          url.searchParams.set("simple", "true");
          url.searchParams.set("per_page", "5");
          url.searchParams.set("order_by", "star_count");
          url.searchParams.set("sort", "desc");
          const result = await this.apiJson(url, "gitlab", signal);
          usedGitLab = true;
          const entries = Array.isArray(result.value) ? result.value : [];
          for (const entry of entries) {
            if (!isRecord(entry)) continue;
            const fullName = typeof entry.path_with_namespace === "string" ? entry.path_with_namespace : "";
            const defaultBranch = typeof entry.default_branch === "string" ? entry.default_branch : "";
            const projectId = typeof entry.id === "number" || typeof entry.id === "string" ? String(entry.id) : "";
            if (!isRepositoryName(fullName) || !defaultBranch || !/^\d+$/.test(projectId) || seen.has(`gitlab:${fullName.toLowerCase()}`)) continue;
            seen.add(`gitlab:${fullName.toLowerCase()}`);
            candidates.push({
              id: `C${candidates.length + 1}`,
              provider: "gitlab",
              fullName,
              description: typeof entry.description === "string" ? entry.description.slice(0, 360) : "",
              defaultBranch,
              webUrl: `https://gitlab.com/${fullName}`,
              ...(validTimestamp(entry.last_activity_at) ? { lastActivityAt: validTimestamp(entry.last_activity_at) } : {}),
              providerProjectId: projectId,
            });
            if (candidates.length >= 15) break;
          }
          onProgress?.(`GitLab public fallback returned ${Math.min(5, entries.length)} repository candidates.`);
        } catch (error) {
          if (!signal?.aborted) gaps.push({ kind: "search", message: `GitLab public fallback failed for one query: ${safeError(error)}.`, material: candidates.length === 0 });
        }
      }
      if (candidates.length >= 15) break;
    }
    if (!triedGitHub && !signal?.aborted) gaps.push({ kind: "search", message: "No GitHub repository search was completed.", material: true });
    if (triedGitHub && candidates.length === 0 && !signal?.aborted) {
      gaps.push({ kind: "search", message: "Neither public GitHub search nor GitLab fallback returned a repository candidate.", material: true });
    }
    return { candidates, gaps };
  }

  async resolveSelected(
    candidates: RepositoryCandidate[],
    selectedIds: string[],
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<TreeResolution> {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const snapshots: RepositorySnapshot[] = [];
    const gaps: ResearchGap[] = [];
    for (const id of selectedIds.slice(0, 3)) {
      if (signal?.aborted) break;
      const candidate = byId.get(id);
      if (!candidate) continue;
      try {
        snapshots.push(await this.resolveTree(candidate, signal));
        onProgress?.(`Read the commit-pinned tree for ${candidate.fullName}.`);
      } catch (error) {
        if (signal?.aborted) break;
        gaps.push({ kind: "tree", message: `Could not read a commit-pinned file tree for ${candidate.fullName}: ${safeError(error)}.`, material: true });
      }
    }
    return { snapshots, gaps };
  }

  async fetchSource(repository: RepositorySnapshot, path: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!isCommitSha(repository.commitSha) || !isSafeTreePath(path) || !repository.files.some((file) => file.path === path)) {
      throw new Error("The requested source path or commit is invalid.");
    }
    if (repository.candidate.provider === "github") {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const url = `https://raw.githubusercontent.com/${repository.candidate.fullName}/${repository.commitSha}/${encodedPath}`;
      return (await this.requestBytes(url, "none", signal)).bytes;
    }
    const projectId = repository.candidate.providerProjectId;
    if (!projectId || !/^\d+$/.test(projectId)) throw new Error("GitLab repository ID is invalid.");
    const url = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(path)}/raw`);
    url.searchParams.set("ref", repository.commitSha);
    return (await this.requestBytes(url, "gitlab", signal)).bytes;
  }

  private async resolveTree(candidate: RepositoryCandidate, signal?: AbortSignal): Promise<RepositorySnapshot> {
    const commit = candidate.provider === "github"
      ? await this.githubCommit(candidate, signal)
      : await this.gitlabCommit(candidate, signal);
    const commitSha = isCommitSha(commit.sha) ? commit.sha.toLowerCase() : "";
    if (!commitSha) throw new Error("The source provider did not return a valid commit SHA.");
    const tree = candidate.provider === "github"
      ? await this.githubTree(candidate, commitSha, signal)
      : await this.gitlabTree(candidate, commitSha, signal);
    return {
      candidate,
      commitSha,
      ...(commit.date ? { commitDate: commit.date } : {}),
      treeTruncated: tree.truncated,
      files: tree.files,
    };
  }

  private async githubCommit(candidate: RepositoryCandidate, signal?: AbortSignal): Promise<{ sha: string; date?: string }> {
    const url = new URL(`https://api.github.com/repos/${candidate.fullName}/commits/${encodeURIComponent(candidate.defaultBranch)}`);
    const response = await this.apiJson(url, "github", signal);
    if (!isRecord(response.value)) return { sha: "" };
    const commit = isRecord(response.value.commit) ? response.value.commit : {};
    const committer = isRecord(commit.committer) ? commit.committer : {};
    const author = isRecord(commit.author) ? commit.author : {};
    const date = validTimestamp(committer.date) ?? validTimestamp(author.date);
    return { sha: typeof response.value.sha === "string" ? response.value.sha : "", ...(date ? { date } : {}) };
  }

  private async gitlabCommit(candidate: RepositoryCandidate, signal?: AbortSignal): Promise<{ sha: string; date?: string }> {
    const projectId = candidate.providerProjectId;
    if (!projectId) throw new Error("GitLab repository ID is missing.");
    const encodedRef = encodeURIComponent(candidate.defaultBranch);
    const url = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/commits/${encodedRef}`);
    const response = await this.apiJson(url, "gitlab", signal);
    if (!isRecord(response.value)) return { sha: "" };
    const date = validTimestamp(response.value.created_at) ?? validTimestamp(response.value.committed_date);
    const sha = typeof response.value.id === "string"
      ? response.value.id
      : typeof response.value.objectid === "string"
        ? response.value.objectid
        : "";
    return { sha, ...(date ? { date } : {}) };
  }

  private async githubTree(candidate: RepositoryCandidate, sha: string, signal?: AbortSignal): Promise<{ files: TreeFile[]; truncated: boolean }> {
    const url = new URL(`https://api.github.com/repos/${candidate.fullName}/git/trees/${sha}`);
    url.searchParams.set("recursive", "1");
    const result = await this.apiJson(url, "github", signal);
    if (!isRecord(result.value) || !Array.isArray(result.value.tree)) throw new Error("GitHub returned an invalid repository tree.");
    const entries = (result.value.tree as unknown[]).flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== "blob" || entry.mode === "160000" || typeof entry.path !== "string" || !isSafeTreePath(entry.path)) return [];
      return [{ path: entry.path, size: typeof entry.size === "number" && entry.size >= 0 ? entry.size : null }];
    });
    return createTreeFiles(candidate.id, entries, result.value.truncated === true, this.options.treePathLimit ?? 2500);
  }

  private async gitlabTree(candidate: RepositoryCandidate, sha: string, signal?: AbortSignal): Promise<{ files: TreeFile[]; truncated: boolean }> {
    const projectId = candidate.providerProjectId;
    if (!projectId) throw new Error("GitLab repository ID is missing.");
    const entries: Array<{ path: string; size: number | null }> = [];
    let nextPage = "1";
    let pageCount = 0;
    let providerTruncated = false;
    const pathLimit = this.options.treePathLimit ?? 2500;
    while (nextPage && pageCount < 25 && entries.length < pathLimit && !signal?.aborted) {
      const url = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/tree`);
      url.searchParams.set("ref", sha);
      url.searchParams.set("recursive", "true");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", nextPage);
      const result = await this.apiJson(url, "gitlab", signal);
      if (!Array.isArray(result.value)) throw new Error("GitLab returned an invalid repository tree.");
      for (const entry of result.value) {
        if (!isRecord(entry) || entry.type !== "blob" || typeof entry.path !== "string" || !isSafeTreePath(entry.path)) continue;
        entries.push({ path: entry.path, size: typeof entry.size === "number" && entry.size >= 0 ? entry.size : null });
        if (entries.length >= pathLimit) break;
      }
      pageCount += 1;
      const headerNextPage = result.headers.get("x-next-page")?.trim() ?? "";
      nextPage = headerNextPage && /^\d+$/.test(headerNextPage) ? headerNextPage : "";
    }
    if (nextPage || pageCount >= 25 && entries.length >= 2500) providerTruncated = true;
    return createTreeFiles(candidate.id, entries, providerTruncated, pathLimit);
  }

  private async apiJson(url: URL, provider: "github" | "gitlab", signal?: AbortSignal): Promise<{ value: unknown; headers: Headers }> {
    const response = await this.requestBytes(url, provider, signal);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(response.bytes));
    } catch {
      throw new Error(`${provider === "github" ? "GitHub" : "GitLab"} returned invalid JSON.`);
    }
    return { value, headers: response.headers };
  }

  private async requestBytes(url: string | URL, auth: "github" | "gitlab" | "none", signal?: AbortSignal): Promise<ByteResponse> {
    const fetcher = this.options.fetch ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw new Error("request cancelled");
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const parsedUrl = new URL(url);
        const headers: Record<string, string> = { "User-Agent": "unshit/0.1", Accept: "application/json, text/plain, */*" };
        if (auth === "github" && parsedUrl.origin === "https://api.github.com" && this.options.githubToken) headers.Authorization = `Bearer ${this.options.githubToken}`;
        if (auth === "gitlab" && parsedUrl.origin === "https://gitlab.com" && parsedUrl.pathname.startsWith("/api/v4/") && this.options.gitlabToken) headers["PRIVATE-TOKEN"] = this.options.gitlabToken;
        const response = await fetcher(parsedUrl, { headers, signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > 1_000_000) throw new Error("response exceeded the 1 MB source limit");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 1_000_000) throw new Error("response exceeded the 1 MB source limit");
        return { bytes, headers: response.headers };
      } catch (error) {
        if (signal?.aborted) throw new Error("request cancelled");
        lastError = error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new Error(safeError(lastError));
  }
}

export function isSafeTreePath(path: string): boolean {
  if (!path || path.length > 600 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

export function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function createTreeFiles(
  candidateId: string,
  entries: Array<{ path: string; size: number | null }>,
  providerTruncated: boolean,
  pathLimit: number,
): { files: TreeFile[]; truncated: boolean } {
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort((left, right) => left.path.localeCompare(right.path));
  const files = unique.slice(0, pathLimit).map((entry, index) => ({ id: `F-${candidateId}-${index + 1}`, ...entry }));
  return { files, truncated: providerTruncated || unique.length > pathLimit };
}

function isRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value);
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timed out";
    return error.message.replace(/https?:\/\/\S+/g, "remote endpoint").slice(0, 180);
  }
  return "request failed";
}
