import type {
  CodeMatch,
  CodeSearchQueryRecord,
  CodeSearchSummary,
  QualityBar,
  RepositoryCandidate,
  RepositorySnapshot,
  ResearchSummary,
  RequestFailure,
  SearchQueryRecord,
  TreeFile,
} from "./types.ts";
import { ProviderRequestError, describeRequestFailure, registeredRequestFailure, requestFailureOf, type RequestTarget } from "./request-failure.ts";
import {
  DEFAULT_QUALITY_BAR,
  candidateFromSearchItem,
  judgeQuality,
  judgeTree,
  orderCandidates,
  planSearches,
  type DomainMaterial,
  type SearchTier,
} from "./repository-screening.ts";
import {
  GREP_ENDPOINT,
  emptyCodeSearchSummary,
  grepRequestBody,
  isGitHubRepositoryName,
  parseGrepResponse,
  rankCodeSearchRepositories,
  repositoryMetadataQuery,
  type CodeSearchHit,
  type CodeSearchQuery,
} from "./code-search.ts";
import { isDemoPath } from "./file-ranking.ts";

export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CandidateDiscovery {
  candidates: RepositoryCandidate[];
  excluded: Array<{ candidate: RepositoryCandidate; reasons: string[] }>;
  gaps: Array<{ kind: "search"; message: string; material: boolean }>;
  research: ResearchSummary;
}

export interface ShortlistResolution {
  snapshots: RepositorySnapshot[];
  excluded: Array<{
    candidate: RepositoryCandidate;
    reasons: string[];
    resolution?: {
      commitSha: string;
      commitDate?: string;
      treeFileCount: number;
      testFileCount: number;
      licensePath?: string;
    };
  }>;
  resolutions: number;
  gaps: Array<{ kind: "tree" | "search"; message: string; material: boolean }>;
  rateLimited: boolean;
  codeSearch?: CodeSearchSummary;
}

interface ByteResponse {
  bytes: Uint8Array;
  headers: Headers;
  attempts: number;
}

export class GitHubResearcher {
  private readonly qualityBar: QualityBar;
  private readonly now: () => Date;
  private readonly searchTiers: SearchTier[] | undefined;
  private readonly maxSearchRequests: number;
  private readonly perPage: number;
  private readonly minimumPassing: number;
  private readonly shortlistSize: number;
  private readonly maxTreeResolutions: number;
  private readonly codeSearchEnabled: boolean;
  private readonly maxCodeSearchRequests: number;
  private readonly maxCodeSearchCandidates: number;
  // One researcher serves one run, so these counters hold the run-wide Grep budget.
  private codeSearchRequests = 0;
  private codeSearchStopped = false;
  private nextCodeSearchId = 1;

  constructor(
    private readonly options: {
      fetch?: FetchFunction;
      githubToken?: string;
      gitlabToken?: string;
      timeoutMs?: number;
      now?: () => Date;
      qualityBar?: Partial<QualityBar>;
      searchTiers?: SearchTier[];
      maxSearchRequests?: number;
      perPage?: number;
      minimumPassing?: number;
      shortlistSize?: number;
      maxTreeResolutions?: number;
      codeSearch?: boolean;
      maxCodeSearchRequests?: number;
      maxCodeSearchCandidates?: number;
    } = {},
  ) {
    this.qualityBar = { ...DEFAULT_QUALITY_BAR, ...options.qualityBar };
    this.now = options.now ?? (() => new Date());
    this.searchTiers = options.searchTiers;
    this.maxSearchRequests = options.maxSearchRequests ?? 9;
    this.perPage = options.perPage ?? 20;
    this.minimumPassing = options.minimumPassing ?? 4;
    this.shortlistSize = options.shortlistSize ?? 6;
    this.maxTreeResolutions = options.maxTreeResolutions ?? 8;
    this.codeSearchEnabled = options.codeSearch ?? false;
    this.maxCodeSearchRequests = options.maxCodeSearchRequests ?? 12;
    this.maxCodeSearchCandidates = options.maxCodeSearchCandidates ?? 4;
  }

  // The most candidates one resolveShortlist call tries, so a caller can rank the ones that get checked.
  get treeResolutionLimit(): number {
    return this.maxTreeResolutions;
  }

  async discover(
    material: DomainMaterial,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<CandidateDiscovery> {
    const candidates: RepositoryCandidate[] = [];
    const excluded: CandidateDiscovery["excluded"] = [];
    const gaps: CandidateDiscovery["gaps"] = [];
    const queries: SearchQueryRecord[] = [];
    const byKey = new Map<string, RepositoryCandidate>();
    let githubRequests = 0;
    let gitlabRequests = 0;
    let githubRateLimited = false;
    let rateLimited = false;
    let passedMetadataBar = 0;
    const plan = planSearches(material, this.now(), this.searchTiers);
    const tierGroups = [...new Set(plan.github.map((entry) => entry.tier))];

    for (const tier of tierGroups) {
      const tierQueries = plan.github.filter((entry) => entry.tier === tier);
      for (const entry of tierQueries) {
        if (signal?.aborted) break;
        if (githubRateLimited || githubRequests >= this.maxSearchRequests) {
          queries.push({ provider: "github", tier, query: entry.query, status: "skipped", resultCount: 0, newCandidates: 0 });
          continue;
        }
        try {
          const url = new URL("https://api.github.com/search/repositories");
          url.searchParams.set("q", entry.query);
          url.searchParams.set("per_page", String(this.perPage));
          const result = await this.apiJson(url, { provider: "github", endpoint: "search" }, signal, 1_000_000, () => {
            if (githubRequests >= this.maxSearchRequests) return false;
            githubRequests += 1;
            return true;
          });
          const entries = isRecord(result.value) && Array.isArray(result.value.items) ? result.value.items : [];
          const newCandidates = this.collectEntries("github", entries, entry.query, candidates, excluded, byKey);
          onProgress?.(`GitHub tier ${tier} search returned ${entries.length} results.`);
          queries.push({ provider: "github", tier, query: entry.query, status: "ok", resultCount: entries.length, newCandidates });
        } catch (error) {
          if (signal?.aborted) break;
          const failure = requestFailureOf(error, { provider: "github", endpoint: "search" });
          if (failure.category === "rate_limit") {
            githubRateLimited = true;
            rateLimited = true;
            const priorGithubQueries = queries.filter((query) => query.provider === "github").length;
            const skippedQueryCount = Math.max(0, plan.github.length - priorGithubQueries - 1);
            queries.push({ provider: "github", tier, query: entry.query, status: "rate_limited", resultCount: 0, newCandidates: 0, failure });
            gaps.push({ kind: "search", message: `GitHub search rate limit reached after ${githubRequests} requests; ${skippedQueryCount} planned queries were not sent. Retry later or set GITHUB_TOKEN.`, material: candidates.length === 0 });
          } else {
            queries.push({ provider: "github", tier, query: entry.query, status: "failed", resultCount: 0, newCandidates: 0, failure });
            gaps.push({ kind: "search", message: `${describeRequestFailure(failure)} (tier ${tier} query).`, material: candidates.length === 0 });
          }
        }
      }
      passedMetadataBar = candidates.length;
      if (signal?.aborted || passedMetadataBar >= this.minimumPassing) break;
    }

    const plannedGithub = plan.github;
    const recordedGithub = queries.filter((query) => query.provider === "github").length;
    if (!signal?.aborted && recordedGithub < plannedGithub.length) {
      const recorded = new Set(queries.filter((query) => query.provider === "github").map((query) => query.query));
      for (const entry of plannedGithub) {
        if (recorded.has(entry.query)) continue;
        queries.push({ provider: "github", tier: entry.tier, query: entry.query, status: "skipped", resultCount: 0, newCandidates: 0 });
      }
    }

    const codePatterns = material.codePatterns ?? [];
    const codeSearch = this.codeSearchEnabled && codePatterns.length > 0 && !signal?.aborted
      ? await this.discoverByCode(codePatterns, { candidates, excluded, byKey, gaps }, githubRateLimited, signal, onProgress)
      : undefined;

    if (!signal?.aborted && candidates.length === 0 && plan.gitlab.length > 0) {
      for (const phrase of plan.gitlab.slice(0, 2)) {
        if (signal?.aborted) break;
        const query = phrase;
        if (gitlabRequests >= 2) {
          queries.push({ provider: "gitlab", tier: 2, query, status: "skipped", resultCount: 0, newCandidates: 0 });
          continue;
        }
        try {
          const url = new URL("https://gitlab.com/api/v4/projects");
          url.searchParams.set("search", phrase);
          url.searchParams.set("simple", "true");
          url.searchParams.set("archived", "false");
          url.searchParams.set("order_by", "star_count");
          url.searchParams.set("sort", "desc");
          url.searchParams.set("per_page", String(this.perPage));
          const result = await this.apiJson(url, { provider: "gitlab", endpoint: "search" }, signal, 1_000_000, () => {
            if (gitlabRequests >= 2) return false;
            gitlabRequests += 1;
            return true;
          });
          const entries = Array.isArray(result.value) ? result.value : [];
          const newCandidates = this.collectEntries("gitlab", entries, phrase, candidates, excluded, byKey);
          queries.push({ provider: "gitlab", tier: 2, query, status: "ok", resultCount: entries.length, newCandidates });
          onProgress?.(`GitLab fallback search returned ${entries.length} results.`);
        } catch (error) {
          if (signal?.aborted) break;
          const failure = requestFailureOf(error, { provider: "gitlab", endpoint: "search" });
          const limited = failure.category === "rate_limit";
          if (limited) rateLimited = true;
          queries.push({ provider: "gitlab", tier: 2, query, status: limited ? "rate_limited" : "failed", resultCount: 0, newCandidates: 0, failure });
          const message = limited
            ? "GitLab public fallback rate limit reached for one query: GitLab rate limit reached.."
            : `${describeRequestFailure(failure)} (fallback query).`;
          gaps.push({ kind: "search", message, material: candidates.length === 0 });
          if (limited) {
            for (const remaining of plan.gitlab.slice(plan.gitlab.indexOf(phrase) + 1, 2)) {
              queries.push({ provider: "gitlab", tier: 2, query: remaining, status: "skipped", resultCount: 0, newCandidates: 0 });
            }
            break;
          }
        }
      }
    }

    for (const gap of gaps) gap.material = candidates.length === 0;

    const ordered = orderCandidates(candidates, material);
    const result = ordered;
    const allMatched = result.length + excluded.length;
    if (!signal?.aborted && allMatched === 0 && !gaps.some((gap) => gap.material)) {
      gaps.push({ kind: "search", message: "No public repository matched the host-built queries.", material: true });
    } else if (!signal?.aborted && allMatched > 0 && result.length === 0) {
      gaps.push({ kind: "search", message: "No public repository passed the host metadata quality bar.", material: true });
    }
    const research: ResearchSummary = {
      queries,
      searchRequests: { github: githubRequests, gitlab: gitlabRequests, budget: this.maxSearchRequests },
      treeResolutions: 0,
      qualityBar: { ...this.qualityBar },
      matched: allMatched,
      passedMetadataBar: result.length,
      shortlisted: 0,
      selected: 0,
      excluded: excluded.length,
      rateLimited,
      trustworthyReferenceFound: false,
      ...(codeSearch ? { codeSearch } : {}),
    };
    return { candidates: result, excluded, gaps, research };
  }

  async resolveShortlist(
    candidates: RepositoryCandidate[],
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
    codePatterns: string[] = [],
  ): Promise<ShortlistResolution> {
    const snapshots: RepositorySnapshot[] = [];
    const excluded: ShortlistResolution["excluded"] = [];
    const gaps: ShortlistResolution["gaps"] = [];
    const attempted = new Set<string>();
    const location = emptyCodeSearchSummary(this.maxCodeSearchRequests);
    let resolutions = 0;
    let stoppedForRateLimit = false;
    let stoppedForRequestBudget = false;
    const coreRequestBudget = 2 * this.maxTreeResolutions;
    let coreRequests = 0;
    const allowCoreRequest = (): boolean => {
      if (coreRequests >= coreRequestBudget) return false;
      coreRequests += 1;
      return true;
    };
    for (const candidate of candidates) {
      if (signal?.aborted || snapshots.length >= this.shortlistSize || resolutions >= this.maxTreeResolutions) break;
      resolutions += 1;
      attempted.add(candidate.id);
      const quality = judgeQuality(candidate.signals, this.qualityBar, this.now());
      try {
        const unresolved = await this.resolveTree(candidate, signal, allowCoreRequest);
        const tree = judgeTree(unresolved, this.qualityBar, quality.licenseFromMetadata);
        const snapshot: RepositorySnapshot = {
          ...unresolved,
          testFileCount: tree.testFileCount,
          ...(tree.licensePath ? { licensePath: tree.licensePath } : {}),
        };
        if (tree.reasons.length > 0) {
          excluded.push({
            candidate,
            reasons: tree.reasons,
            resolution: {
              commitSha: snapshot.commitSha,
              ...(snapshot.commitDate ? { commitDate: snapshot.commitDate } : {}),
              treeFileCount: snapshot.files.length,
              testFileCount: tree.testFileCount,
              ...(tree.licensePath ? { licensePath: tree.licensePath } : {}),
            },
          });
          onProgress?.(`Excluded ${candidate.fullName}: ${tree.reasons.join("; ")}.`);
          continue;
        }
        snapshots.push(snapshot);
        onProgress?.(`Verified the commit-pinned tree for ${candidate.fullName} (${tree.testFileCount} test files).`);
        if (this.codeSearchEnabled && codePatterns.length > 0 && candidate.provider === "github" && !signal?.aborted) {
          const codeMatches = await this.locateCode(snapshot, codePatterns, location, gaps, signal);
          if (codeMatches.length > 0) snapshot.codeMatches = codeMatches;
        }
      } catch (error) {
        if (signal?.aborted) break;
        const failure = requestFailureOf(error, { provider: candidate.provider, endpoint: "tree" });
        const description = describeRequestFailure(failure);
        const limited = failure.category === "rate_limit";
        const budgetExhausted = failure.category === "request_budget" || failure.retryRefused;
        const message = limited
          ? `${candidate.provider === "github" ? "GitHub" : "GitLab"} rate limit reached while resolving repository trees; remaining candidates were not resolved.`
          : budgetExhausted
            ? failure.retryRefused
              ? `Could not read a commit-pinned file tree for ${candidate.fullName}; ${description}. Core request budget of ${coreRequestBudget} attempts was exhausted; remaining candidates were not resolved.`
              : `Core request budget of ${coreRequestBudget} attempts was exhausted; remaining candidates were not resolved.`
            : `Could not read a commit-pinned file tree for ${candidate.fullName}; ${description}.`;
        gaps.push({ kind: "tree", message, material: limited && snapshots.length === 0 });
        excluded.push({
          candidate,
          reasons: [limited
            ? "tree resolution stopped at the provider rate limit"
            : failure.category === "request_budget"
              ? `Core request budget of ${coreRequestBudget} attempts was exhausted before this candidate's tree was verified.`
              : `could not resolve commit-pinned tree; ${description}`],
        });
        onProgress?.(`Could not verify ${candidate.fullName}.`);
        if (limited) {
          stoppedForRateLimit = true;
          break;
        }
        if (budgetExhausted) {
          stoppedForRequestBudget = true;
          break;
        }
      }
    }
    for (const candidate of candidates) {
      if (attempted.has(candidate.id) || excluded.some((entry) => entry.candidate.id === candidate.id)) continue;
      excluded.push({
        candidate,
        reasons: [stoppedForRateLimit
          ? "Passed the metadata bar but was not tree-verified after the provider rate limit."
          : stoppedForRequestBudget
            ? `Passed the metadata bar but was not tree-verified because the core request budget of ${coreRequestBudget} attempts was exhausted.`
            : `Passed the quality bar but was outside the shortlist of ${this.shortlistSize} tree-verified candidates.`],
      });
    }
    return {
      snapshots,
      excluded,
      resolutions,
      gaps,
      rateLimited: stoppedForRateLimit,
      ...(location.queries.length > 0 ? { codeSearch: location } : {}),
    };
  }

  async fetchSource(repository: RepositorySnapshot, path: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!isCommitSha(repository.commitSha) || !isSafeTreePath(path) || !repository.files.some((file) => file.path === path)) {
      throw new ProviderRequestError({ provider: repository.candidate.provider, endpoint: "source", category: "invalid_request", attempts: 0, retryRefused: false });
    }
    if (repository.candidate.provider === "github") {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const url = `https://raw.githubusercontent.com/${repository.candidate.fullName}/${repository.commitSha}/${encodedPath}`;
      return (await this.requestBytes(url, { provider: "github", endpoint: "source" }, signal)).bytes;
    }
    const projectId = repository.candidate.providerProjectId;
    if (!projectId || !/^\d+$/.test(projectId)) {
      throw new ProviderRequestError({ provider: "gitlab", endpoint: "source", category: "invalid_request", attempts: 0, retryRefused: false });
    }
    const url = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(path)}/raw`);
    url.searchParams.set("ref", repository.commitSha);
    return (await this.requestBytes(url, { provider: "gitlab", endpoint: "source" }, signal)).bytes;
  }

  private async codeSearchQuery(
    query: CodeSearchQuery,
    purpose: CodeSearchQueryRecord["purpose"],
    summary: CodeSearchSummary,
    gaps: Array<{ kind: "search" | "tree"; message: string; material: boolean }>,
    signal?: AbortSignal,
  ): Promise<CodeSearchHit[]> {
    const record: CodeSearchQueryRecord = {
      provider: "grep",
      purpose,
      query: query.query,
      ...(query.repo ? { repository: query.repo } : {}),
      status: "skipped",
      resultCount: 0,
    };
    summary.queries.push(record);
    if (this.codeSearchStopped || signal?.aborted) return [];
    const target: RequestTarget = { provider: "grep", endpoint: "search" };
    try {
      const response = await this.requestBytes(GREP_ENDPOINT, target, signal, 1_000_000, () => {
        if (this.codeSearchRequests >= this.maxCodeSearchRequests) return false;
        this.codeSearchRequests += 1;
        summary.requests += 1;
        return true;
      }, { body: grepRequestBody(this.nextCodeSearchId++, query) });
      const contentType = response.headers.get("content-type");
      const parsed = parseGrepResponse(new TextDecoder().decode(response.bytes), contentType);
      if ("problem" in parsed) {
        throw new ProviderRequestError({ ...target, category: "invalid_response", responseProblem: parsed.problem, contentType: contentType ?? undefined, rpcErrorCode: parsed.rpcErrorCode, attempts: response.attempts, retryRefused: false });
      }
      record.status = "ok";
      record.resultCount = parsed.hits.length;
      return parsed.hits;
    } catch (error) {
      if (signal?.aborted) return [];
      const failure = requestFailureOf(error, target);
      if (failure.category === "request_budget") return [];
      this.codeSearchStopped = true;
      record.status = failure.category === "rate_limit" ? "rate_limited" : "failed";
      record.failure = failure;
      gaps.push({ kind: "search", message: `${describeRequestFailure(failure)}; code search stopped for this run.`, material: false });
      return [];
    }
  }

  private async discoverByCode(
    patterns: string[],
    state: {
      candidates: RepositoryCandidate[];
      excluded: CandidateDiscovery["excluded"];
      byKey: Map<string, RepositoryCandidate>;
      gaps: CandidateDiscovery["gaps"];
    },
    githubRateLimited: boolean,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<CodeSearchSummary> {
    const summary = emptyCodeSearchSummary(this.maxCodeSearchRequests);
    const hits: Array<{ pattern: string; hit: CodeSearchHit }> = [];
    for (const pattern of patterns.slice(0, 3)) {
      if (signal?.aborted) break;
      for (const hit of await this.codeSearchQuery({ query: pattern }, "discovery", summary, state.gaps, signal)) {
        if (isGitHubRepositoryName(hit.repository) && isSafeTreePath(hit.path)) hits.push({ pattern, hit });
      }
    }
    const ranked = rankCodeSearchRepositories(hits);
    summary.repositoriesMatched = ranked.length;
    if (summary.queries.some((query) => query.status === "ok")) {
      onProgress?.(`Code search matched ${ranked.length} repositories outside example and documentation paths.`);
    }
    const unseen: string[] = [];
    for (const entry of ranked) {
      const existing = state.byKey.get(`github:${entry.repository.toLowerCase()}`);
      if (existing) existing.codeMatches = entry.matches;
      else if (unseen.length < this.maxCodeSearchCandidates) unseen.push(entry.repository);
    }
    if (unseen.length === 0 || signal?.aborted) return summary;
    const lookup = repositoryMetadataQuery(unseen);
    if (lookup.included.length === 0) return summary;
    if (githubRateLimited) {
      state.gaps.push({ kind: "search", message: `GitHub search was rate limited, so ${lookup.included.length} code-search repositories were not screened.`, material: false });
      return summary;
    }
    try {
      const url = new URL("https://api.github.com/search/repositories");
      url.searchParams.set("q", lookup.query);
      url.searchParams.set("per_page", String(this.perPage));
      const result = await this.apiJson(url, { provider: "github", endpoint: "search" }, signal, 1_000_000, () => {
        if (summary.metadataRequests >= 2) return false;
        summary.metadataRequests += 1;
        return true;
      });
      const items = isRecord(result.value) && Array.isArray(result.value.items) ? result.value.items : [];
      summary.repositoriesScreened = this.collectEntries("github", items, lookup.query, state.candidates, state.excluded, state.byKey);
      for (const entry of ranked) {
        const candidate = state.byKey.get(`github:${entry.repository.toLowerCase()}`);
        if (candidate && !candidate.codeMatches) candidate.codeMatches = entry.matches;
      }
    } catch (error) {
      if (signal?.aborted) return summary;
      const failure = requestFailureOf(error, { provider: "github", endpoint: "search" });
      state.gaps.push({ kind: "search", message: `${describeRequestFailure(failure)} (code-search repository metadata).`, material: false });
    }
    return summary;
  }

  private async locateCode(
    snapshot: RepositorySnapshot,
    patterns: string[],
    summary: CodeSearchSummary,
    gaps: ShortlistResolution["gaps"],
    signal?: AbortSignal,
  ): Promise<CodeMatch[]> {
    const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const matches = new Map<string, CodeMatch>();
    const add = (path: string, pattern: string): void => {
      const file = filesByPath.get(path);
      if (!file || isDemoPath(path)) return;
      const match = matches.get(file.id) ?? { fileId: file.id, path, patterns: [] };
      if (!match.patterns.includes(pattern)) match.patterns.push(pattern);
      matches.set(file.id, match);
    };
    const discovered = snapshot.candidate.codeMatches ?? [];
    for (const match of discovered) add(match.path, match.pattern);
    const covered = new Set(discovered.map((match) => match.pattern));
    // Grep's repo filter is a partial match, so keep only hits from this exact repository.
    const repository = snapshot.candidate.fullName.toLowerCase();
    for (const pattern of patterns.filter((entry) => !covered.has(entry)).slice(0, 2)) {
      if (signal?.aborted) break;
      const hits = await this.codeSearchQuery({ query: pattern, repo: snapshot.candidate.fullName }, "location", summary, gaps, signal);
      for (const hit of hits) if (hit.repository.toLowerCase() === repository) add(hit.path, pattern);
    }
    return [...matches.values()].slice(0, 20);
  }

  private collectEntries(
    provider: "github" | "gitlab",
    entries: unknown[],
    query: string,
    candidates: RepositoryCandidate[],
    excluded: CandidateDiscovery["excluded"],
    byKey: Map<string, RepositoryCandidate>,
  ): number {
    let newCandidates = 0;
    for (const [index, item] of entries.entries()) {
      const candidateData = candidateFromSearchItem(provider, item);
      if (!candidateData) continue;
      const key = `${provider}:${candidateData.fullName.toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.matchedQueries = [...new Set([...(existing.matchedQueries ?? []), query])];
        continue;
      }
      const candidate: RepositoryCandidate = {
        ...candidateData,
        id: `C${byKey.size + 1}`,
        searchRank: index + 1,
        matchedQueries: [query],
      };
      byKey.set(key, candidate);
      newCandidates += 1;
      const judgment = judgeQuality(candidate.signals, this.qualityBar, this.now());
      if (!judgment.pass) {
        excluded.push({ candidate, reasons: judgment.reasons });
        continue;
      }
      candidates.push(candidate);
    }
    return newCandidates;
  }

  private async resolveTree(candidate: RepositoryCandidate, signal?: AbortSignal, requestAllowance?: () => boolean): Promise<RepositorySnapshot> {
    const commit = candidate.provider === "github"
      ? await this.githubCommit(candidate, signal, requestAllowance)
      : await this.gitlabCommit(candidate, signal, requestAllowance);
    const commitSha = isCommitSha(commit.sha) ? commit.sha.toLowerCase() : "";
    if (!commitSha) {
      throw new ProviderRequestError({ provider: candidate.provider, endpoint: "commit", category: "invalid_response", attempts: commit.attempts, retryRefused: false });
    }
    const tree = candidate.provider === "github"
      ? await this.githubTree(candidate, commitSha, signal, requestAllowance)
      : await this.gitlabTree(candidate, commitSha, signal, requestAllowance);
    return {
      candidate,
      commitSha,
      ...(commit.date ? { commitDate: commit.date } : {}),
      treeTruncated: tree.truncated,
      files: tree.files,
    };
  }

  private async githubCommit(candidate: RepositoryCandidate, signal?: AbortSignal, requestAllowance?: () => boolean): Promise<{ sha: string; date?: string; attempts: number }> {
    const url = new URL(`https://api.github.com/repos/${candidate.fullName}/commits/${encodeURIComponent(candidate.defaultBranch)}`);
    // The commit response lists the changed files with their patches, per_page of them.
    url.searchParams.set("per_page", "1");
    const response = await this.apiJson(url, { provider: "github", endpoint: "commit" }, signal, 1_000_000, requestAllowance);
    if (!isRecord(response.value)) return { sha: "", attempts: response.attempts };
    const commit = isRecord(response.value.commit) ? response.value.commit : {};
    const committer = isRecord(commit.committer) ? commit.committer : {};
    const author = isRecord(commit.author) ? commit.author : {};
    const date = validTimestamp(committer.date) ?? validTimestamp(author.date);
    return { sha: typeof response.value.sha === "string" ? response.value.sha : "", ...(date ? { date } : {}), attempts: response.attempts };
  }

  private async gitlabCommit(candidate: RepositoryCandidate, signal?: AbortSignal, requestAllowance?: () => boolean): Promise<{ sha: string; date?: string; attempts: number }> {
    const projectId = candidate.providerProjectId;
    if (!projectId) {
      throw new ProviderRequestError({ provider: "gitlab", endpoint: "commit", category: "invalid_request", attempts: 0, retryRefused: false });
    }
    const encodedRef = encodeURIComponent(candidate.defaultBranch);
    const url = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/commits/${encodedRef}`);
    const response = await this.apiJson(url, { provider: "gitlab", endpoint: "commit" }, signal, 1_000_000, requestAllowance);
    if (!isRecord(response.value)) return { sha: "", attempts: response.attempts };
    const date = validTimestamp(response.value.created_at) ?? validTimestamp(response.value.committed_date);
    const sha = typeof response.value.id === "string"
      ? response.value.id
      : typeof response.value.objectid === "string"
        ? response.value.objectid
        : "";
    return { sha, ...(date ? { date } : {}), attempts: response.attempts };
  }

  private async githubTree(candidate: RepositoryCandidate, sha: string, signal?: AbortSignal, requestAllowance?: () => boolean): Promise<{ files: TreeFile[]; truncated: boolean }> {
    const url = new URL(`https://api.github.com/repos/${candidate.fullName}/git/trees/${sha}`);
    url.searchParams.set("recursive", "1");
    const result = await this.apiJson(url, { provider: "github", endpoint: "tree" }, signal, 8_000_000, requestAllowance);
    if (!isRecord(result.value) || !Array.isArray(result.value.tree)) {
      throw new ProviderRequestError({ provider: "github", endpoint: "tree", category: "invalid_response", attempts: result.attempts, retryRefused: false });
    }
    const entries = (result.value.tree as unknown[]).flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== "blob" || entry.mode === "160000" || typeof entry.path !== "string" || !isSafeTreePath(entry.path)) return [];
      return [{ path: entry.path, size: typeof entry.size === "number" && entry.size >= 0 ? entry.size : null }];
    });
    return createTreeFiles(candidate.id, entries, result.value.truncated === true);
  }

  private async gitlabTree(candidate: RepositoryCandidate, sha: string, signal?: AbortSignal, requestAllowance?: () => boolean): Promise<{ files: TreeFile[]; truncated: boolean }> {
    const projectId = candidate.providerProjectId;
    if (!projectId) {
      throw new ProviderRequestError({ provider: "gitlab", endpoint: "tree", category: "invalid_request", attempts: 0, retryRefused: false });
    }
    const entries: Array<{ path: string; size: number | null }> = [];
    let nextPage = "1";
    let pageCount = 0;
    while (nextPage && pageCount < 25 && !signal?.aborted) {
      const url = new URL(`https://gitlab.com/api/v4/projects/${encodeURIComponent(projectId)}/repository/tree`);
      url.searchParams.set("ref", sha);
      url.searchParams.set("recursive", "true");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", nextPage);
      const result = await this.apiJson(url, { provider: "gitlab", endpoint: "tree", page: pageCount + 1 }, signal, 1_000_000, requestAllowance);
      if (!Array.isArray(result.value)) {
        throw new ProviderRequestError({ provider: "gitlab", endpoint: "tree", page: pageCount + 1, category: "invalid_response", attempts: result.attempts, retryRefused: false });
      }
      for (const entry of result.value) {
        if (!isRecord(entry) || entry.type !== "blob" || typeof entry.path !== "string" || !isSafeTreePath(entry.path)) continue;
        entries.push({ path: entry.path, size: typeof entry.size === "number" && entry.size >= 0 ? entry.size : null });
      }
      pageCount += 1;
      const headerNextPage = result.headers.get("x-next-page")?.trim() ?? "";
      nextPage = headerNextPage && /^\d+$/.test(headerNextPage) ? headerNextPage : "";
    }
    return createTreeFiles(candidate.id, entries, Boolean(nextPage));
  }

  private async apiJson(url: URL, target: RequestTarget, signal?: AbortSignal, maxBytes = 1_000_000, requestAllowance?: () => boolean): Promise<{ value: unknown; headers: Headers; attempts: number }> {
    const response = await this.requestBytes(url, target, signal, maxBytes, requestAllowance);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(response.bytes));
    } catch {
      throw new ProviderRequestError({ ...target, category: "invalid_json", attempts: response.attempts, retryRefused: false });
    }
    return { value, headers: response.headers, attempts: response.attempts };
  }

  private async requestBytes(
    url: string | URL,
    target: RequestTarget,
    signal?: AbortSignal,
    maxBytes = 1_000_000,
    requestAllowance?: () => boolean,
    post?: { body: string },
  ): Promise<ByteResponse> {
    const fetcher = this.options.fetch ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new ProviderRequestError({ ...target, category: "invalid_request", attempts: 0, retryRefused: false });
    }
    let attempts = 0;
    let firstFailure: RequestFailure | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal?.aborted) {
        throw new ProviderRequestError({ ...target, category: "cancelled", attempts, retryRefused: false });
      }
      if (requestAllowance && !requestAllowance()) {
        if (firstFailure) throw new ProviderRequestError({ ...firstFailure, retryRefused: true });
        throw new ProviderRequestError({ ...target, category: "request_budget", attempts: 0, retryRefused: false });
      }
      attempts += 1;
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          "User-Agent": "unshit/0.1",
          Accept: post ? "application/json, text/event-stream" : "application/json, text/plain, */*",
          ...(post ? { "Content-Type": "application/json" } : {}),
        };
        if (target.provider === "github" && parsedUrl.origin === "https://api.github.com" && this.options.githubToken) headers.Authorization = `Bearer ${this.options.githubToken}`;
        if (target.provider === "gitlab" && parsedUrl.origin === "https://gitlab.com" && parsedUrl.pathname.startsWith("/api/v4/") && this.options.gitlabToken) headers["PRIVATE-TOKEN"] = this.options.gitlabToken;
        const response = await fetcher(parsedUrl, { ...(post ? { method: "POST", body: post.body } : {}), headers, signal: controller.signal, redirect: "error" });
        if (!isResponseLike(response)) {
          throw new ProviderRequestError({ ...target, category: "invalid_response", attempts, retryRefused: false });
        }
        const status = response.status;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          throw new ProviderRequestError({ ...target, category: "invalid_response", attempts, retryRefused: false });
        }
        if ((status === 403 || status === 429)
          && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))) {
          throw new ProviderRequestError({ ...target, category: "rate_limit", attempts, retryRefused: false });
        }
        if (target.provider === "grep" && status === 429) {
          throw new ProviderRequestError({ ...target, category: "rate_limit", attempts, retryRefused: false });
        }
        if (!response.ok) {
          throw new ProviderRequestError({ ...target, category: "http_status", status, attempts, retryRefused: false });
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          throw new ProviderRequestError({ ...target, category: "size_limit", limitBytes: maxBytes, attempts, retryRefused: false });
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) {
          throw new ProviderRequestError({ ...target, category: "size_limit", limitBytes: maxBytes, attempts, retryRefused: false });
        }
        return { bytes, headers: response.headers, attempts };
      } catch (error) {
        if (signal?.aborted) {
          throw new ProviderRequestError({ ...target, category: "cancelled", attempts, retryRefused: false });
        }
        const caughtFailure = registeredRequestFailure(error)
          ?? (hasErrorName(error, "AbortError")
            ? { ...target, category: "timeout" as const, attempts, retryRefused: false }
            : { ...target, category: "network" as const, attempts, retryRefused: false });
        const failure = { ...caughtFailure, attempts };
        // A rate limit or an oversized response would fail the same way again, so neither is retried.
        if (failure.category === "rate_limit" || failure.category === "size_limit" || attempt === 2) throw new ProviderRequestError(failure);
        firstFailure = failure;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new ProviderRequestError(firstFailure ?? { ...target, category: "internal", attempts, retryRefused: false });
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
): { files: TreeFile[]; truncated: boolean } {
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort((left, right) => left.path.localeCompare(right.path));
  const files = unique.map((entry, index) => ({ id: `F-${candidateId}-${index + 1}`, ...entry }));
  return { files, truncated: providerTruncated };
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

function isResponseLike(value: unknown): value is Response {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (!(value instanceof Response)) return false;
    const response = value as Response;
    return Number.isInteger(response.status)
      && typeof response.ok === "boolean"
      && typeof response.headers?.get === "function"
      && typeof response.headers?.has === "function"
      && typeof response.arrayBuffer === "function";
  } catch {
    return false;
  }
}

function hasErrorName(error: unknown, expectedName: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as { name?: unknown }).name === expectedName;
  } catch {
    return false;
  }
}
