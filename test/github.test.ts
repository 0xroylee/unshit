import { describe, expect, test } from "bun:test";
import { GitHubResearcher } from "../src/github.ts";
import { ProviderRequestError, describeRequestFailure, registeredRequestFailure, requestFailureOf } from "../src/request-failure.ts";
import type { RequestEndpoint, RequestFailure, RepositoryCandidate, RepositoryQualitySignals, RepositorySnapshot } from "../src/types.ts";

const COMMIT = "8e0d33a8257952f4d02d92fd566297082b9a7f2e";
const NOW = new Date("2026-10-10T00:00:00.000Z");

function json(value: unknown, headers: HeadersInit = {}, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function signals(overrides: Partial<RepositoryQualitySignals> = {}): RepositoryQualitySignals {
  return {
    stars: 250,
    forks: 20,
    archived: false,
    fork: false,
    licenseSpdxId: "MIT",
    language: "TypeScript",
    topics: ["refunds"],
    pushedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<RepositoryCandidate> = {}): RepositoryCandidate {
  const fullName = `org/repo-${id}`;
  return {
    id,
    provider: "github",
    fullName,
    description: "Refund workflow",
    defaultBranch: "main",
    webUrl: `https://github.com/${fullName}`,
    signals: signals(),
    ...overrides,
  };
}

const material = { phrases: ["refund workflow", "refund request"], topics: ["refunds"] };

function treeFor(name: string, options: { tests?: boolean; license?: boolean; licensePath?: string; truncated?: boolean } = {}): unknown {
  const tree: unknown[] = [{ path: "src/handler.ts", type: "blob", size: 23 }];
  if (options.tests !== false) tree.push({ path: "tests/handler.test.ts", type: "blob", size: 30 });
  if (options.license !== false) tree.push({ path: options.licensePath ?? "LICENSE", type: "blob", size: 15 });
  return { sha: COMMIT, truncated: options.truncated ?? false, tree, name };
}

function treeFetch(options: { noTests?: Set<string>; noLicense?: Set<string>; licensePath?: string; truncated?: boolean } = {}) {
  const urls: URL[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    urls.push(url);
    if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT, commit: { committer: { date: "2026-06-01T00:00:00Z" } } });
    if (url.pathname.includes("/git/trees/")) {
      const repository = url.pathname.split("/")[3] ?? "";
      return json(treeFor(repository, {
        tests: !options.noTests?.has(repository),
        license: !options.noLicense?.has(repository),
        licensePath: options.licensePath,
        truncated: options.truncated,
      }));
    }
    if (url.origin === "https://raw.githubusercontent.com") return new Response("export const handler = true;\n", { status: 200 });
    return new Response("unexpected request", { status: 404 });
  };
  return { fetch, urls };
}

function expectNoCredentialFragments(value: string, tokens: string[]): void {
  for (const token of tokens) {
    for (let index = 0; index <= token.length - 8; index += 1) {
      if (value.includes(token.slice(index, index + 8))) throw new Error("output contains a credential fragment");
    }
  }
}

interface ExtractionFailure {
  value: unknown;
  reads: () => number;
}

function providerFailureWithThrowingGetter(marker: string, endpoint: RequestEndpoint = "source"): ExtractionFailure {
  const error = new ProviderRequestError({
    provider: "github",
    endpoint,
    category: "network",
    attempts: 1,
    retryRefused: false,
  });
  let reads = 0;
  Object.defineProperty(error, "failure", {
    get() {
      reads += 1;
      throw new Error(marker);
    },
  });
  return { value: error, reads: () => reads };
}

function valueWithThrowingPrototypeLookup(marker: string, _endpoint?: RequestEndpoint): ExtractionFailure {
  let reads = 0;
  const value = new Proxy({}, {
    getPrototypeOf() {
      reads += 1;
      throw new Error(marker);
    },
  });
  return { value, reads: () => reads };
}

function forgedProviderError(marker: string, _endpoint?: RequestEndpoint): ExtractionFailure {
  let failureReads = 0;
  let statusReads = 0;
  const failure = {
    provider: "github",
    endpoint: "search",
    category: "http_status",
    attempts: 1,
    retryRefused: false,
  } as Record<string, unknown>;
  Object.defineProperty(failure, "status", {
    get() {
      statusReads += 1;
      return statusReads === 1 ? 503 : marker;
    },
  });
  const value = Object.create(ProviderRequestError.prototype) as object;
  Object.defineProperty(value, "message", { value: marker, enumerable: true });
  Object.defineProperty(value, "failure", {
    get() {
      failureReads += 1;
      return failure;
    },
  });
  return { value, reads: () => failureReads + statusReads };
}

function statefulRecord(field: keyof RequestFailure, base: RequestFailure, marker: string): { record: RequestFailure; reads: () => number } {
  let reads = 0;
  const record = { ...base } as RequestFailure;
  Object.defineProperty(record, field, {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? (base as unknown as Record<string, unknown>)[field] : marker;
    },
  });
  return { record, reads: () => reads };
}

const extractionFailureCases = [
  {
    name: "ProviderRequestError failure getter",
    marker: "MARKER_ALPHA_7Q2W9E4R",
    category: "network",
    create: providerFailureWithThrowingGetter,
  },
  {
    name: "prototype lookup",
    marker: "MARKER_BRAVO_3X8N5K1P",
    category: "network",
    create: valueWithThrowingPrototypeLookup,
  },
  {
    name: "forged ProviderRequestError with stateful fields",
    marker: "MARKER_CHARLIE_4V7N2K9P",
    category: "network",
    create: forgedProviderError,
  },
] as const;

type FailureEndpoint = "github search" | "gitlab search" | "github commit" | "github tree" | "gitlab tree page 2" | "github source" | "gitlab source";
type FailureFault = "sentinel at start" | "crossing 180" | "beyond 180" | "thrown non-Error" | "500 body and statusText" | "invalid JSON body" | "AbortError";

const GITHUB_SENTINEL = "SENTINEL_GITHUB_7f3b9d2a4c6e8f10";
const GITLAB_SENTINEL = "SENTINEL_GITLAB_2a4c6e8f0b1d3f57";
const FAILURE_TOKENS = [GITHUB_SENTINEL, GITLAB_SENTINEL];
const FAILURE_FAULTS: FailureFault[] = [
  "sentinel at start",
  "crossing 180",
  "beyond 180",
  "thrown non-Error",
  "500 body and statusText",
  "invalid JSON body",
  "AbortError",
];
const FAILURE_ENDPOINTS: FailureEndpoint[] = [
  "github search",
  "gitlab search",
  "github commit",
  "github tree",
  "gitlab tree page 2",
  "github source",
  "gitlab source",
];

function expectedFailureCategory(fault: FailureFault): string {
  if (fault === "500 body and statusText") return "http_status";
  if (fault === "invalid JSON body") return "invalid_json";
  if (fault === "AbortError") return "timeout";
  return "network";
}

function expectedFailureText(fault: FailureFault): string {
  if (fault === "500 body and statusText") return "HTTP 500";
  if (fault === "invalid JSON body") return "response was not valid JSON";
  if (fault === "AbortError") return "request timed out";
  return "no response (network failure)";
}

function failureResponse(fault: FailureFault): Response {
  const payload = `${GITHUB_SENTINEL} ${GITLAB_SENTINEL}`;
  if (fault === "500 body and statusText") return new Response(payload, { status: 500, statusText: payload });
  if (fault === "invalid JSON body") return new Response(payload, { status: 200 });
  throwFault(fault, payload);
  throw new Error("unreachable fault fixture");
}

function throwFault(fault: FailureFault, payload: string): never {
  if (fault === "sentinel at start") throw new Error(payload);
  if (fault === "crossing 180") throw new Error(`${"x".repeat(164)}${GITHUB_SENTINEL}${GITLAB_SENTINEL}`);
  if (fault === "beyond 180") throw new Error(`${"x".repeat(181)}${payload}`);
  if (fault === "thrown non-Error") throw payload;
  if (fault === "AbortError") {
    const error = new Error(payload);
    error.name = "AbortError";
    throw error;
  }
  throw new Error("unexpected fault fixture");
}

async function exerciseFailure(endpoint: FailureEndpoint, fault: FailureFault): Promise<void> {
  const urls: URL[] = [];
  const isTarget = (url: URL): boolean => {
    switch (endpoint) {
      case "github search": return url.origin === "https://api.github.com" && url.pathname === "/search/repositories";
      case "gitlab search": return url.origin === "https://gitlab.com" && url.pathname === "/api/v4/projects" && url.searchParams.has("search");
      case "github commit": return url.origin === "https://api.github.com" && url.pathname.endsWith("/repos/org/repo-x/commits/main");
      case "github tree": return url.origin === "https://api.github.com" && url.pathname.includes("/repos/org/repo-x/git/trees/");
      case "gitlab tree page 2": return url.origin === "https://gitlab.com" && url.pathname.endsWith("/repository/tree") && url.searchParams.get("page") === "2";
      case "github source": return url.origin === "https://raw.githubusercontent.com" && url.pathname.includes(`/org/repo-x/${COMMIT}/src/secret.ts`);
      case "gitlab source": return url.origin === "https://gitlab.com" && url.pathname.includes("/repository/files/") && url.pathname.endsWith("/raw");
    }
  };
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = requestUrl(input);
    urls.push(url);
    if (isTarget(url)) return failureResponse(fault);
    if (url.origin === "https://api.github.com" && url.pathname === "/search/repositories") return json({ items: [] });
    if (url.origin === "https://gitlab.com" && url.pathname === "/api/v4/projects" && url.searchParams.has("search")) return json([]);
    if (url.pathname.endsWith("/repos/org/repo-x/commits/main")) return json({ sha: COMMIT });
    if (url.pathname.endsWith("/repository/commits/main")) return json({ id: COMMIT });
    if (url.pathname.endsWith("/repository/tree") && url.searchParams.get("page") === "1") {
      return json([{ type: "blob", path: "src/index.ts", size: 10 }], { "x-next-page": "2" });
    }
    return new Response("unexpected request", { status: 404 });
  };
  const researcher = new GitHubResearcher({
    fetch,
    githubToken: GITHUB_SENTINEL,
    gitlabToken: GITLAB_SENTINEL,
    now: () => NOW,
    minimumPassing: 20,
    searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
  });
  const expectedCategory = expectedFailureCategory(fault);
  let output = "";

  if (endpoint === "github search" || endpoint === "gitlab search") {
    const result = await researcher.discover({ phrases: ["refund"], topics: [] });
    const provider = endpoint === "github search" ? "github" : "gitlab";
    const query = result.research.queries.find((entry) => entry.provider === provider && entry.status !== "skipped");
    expect(query?.failure).toMatchObject({
      provider,
      endpoint: "search",
      category: expectedCategory,
      attempts: fault === "invalid JSON body" ? 1 : 2,
      retryRefused: false,
    });
    expect(query?.status).toBe("failed");
    output = JSON.stringify(result);
  } else if (endpoint === "github source" || endpoint === "gitlab source") {
    const provider = endpoint === "github source" ? "github" : "gitlab";
    const repo: RepositorySnapshot = {
      candidate: candidate("x", {
        provider,
        fullName: "org/repo-x",
        ...(provider === "gitlab" ? { providerProjectId: "60510562" } : {}),
      }),
      commitSha: COMMIT,
      treeTruncated: false,
      files: [{ id: "F-secret", path: "src/secret.ts", size: 10 }],
    };
    let thrown: unknown;
    let sourceBytes: Uint8Array | undefined;
    try {
      sourceBytes = await researcher.fetchSource(repo, "src/secret.ts");
    } catch (error) {
      thrown = error;
    }
    if (fault === "invalid JSON body") {
      // Source endpoints return file bytes; JSON syntax is not part of that response contract.
      expect(thrown).toBeUndefined();
      expect(new TextDecoder().decode(sourceBytes)).toBe(`${GITHUB_SENTINEL} ${GITLAB_SENTINEL}`);
      output = JSON.stringify(sourceBytes);
      expect(urls.some(isTarget)).toBe(true);
      expectNoCredentialFragments(output, FAILURE_TOKENS);
      return;
    }
    expect(thrown).toBeInstanceOf(ProviderRequestError);
    if (!(thrown instanceof ProviderRequestError)) throw new Error("source failure was not typed");
    expect(thrown.failure).toMatchObject({ provider, endpoint: "source", category: expectedCategory });
    expect(thrown.message).toContain(expectedFailureText(fault));
    expect(thrown.message).toBe(describeRequestFailure(thrown.failure));
    output = thrown.message;
  } else {
    const provider = endpoint === "gitlab tree page 2" ? "gitlab" : "github";
    const targetCandidate = candidate("x", {
      provider,
      fullName: "org/repo-x",
      ...(provider === "gitlab" ? { providerProjectId: "60510562" } : {}),
    });
    const result = await researcher.resolveShortlist([targetCandidate]);
    const diagnosis = `${result.gaps.map((gap) => gap.message).join(" ")} ${result.excluded.flatMap((entry) => entry.reasons).join(" ")}`;
    expect(diagnosis).toContain(expectedFailureText(fault));
    output = JSON.stringify(result);
  }

  expect(urls.some(isTarget)).toBe(true);
  expectNoCredentialFragments(output, FAILURE_TOKENS);
}

function searchItem(fullName: string, stars: number, description = "Refund service") {
  return {
    full_name: fullName,
    default_branch: "main",
    description,
    stargazers_count: stars,
    forks_count: 10,
    archived: false,
    fork: false,
    license: { spdx_id: "MIT" },
    language: "TypeScript",
    topics: ["refunds"],
    pushed_at: "2026-06-01T00:00:00Z",
    created_at: "2020-01-01T00:00:00Z",
  };
}

function grepResponse(hits: Array<{ repository: string; path: string }>, status = 200): Response {
  const content = hits.length === 0
    ? [{ type: "text", text: "No results found for your query." }]
    : hits.map((hit) => ({ type: "text", text: `Repository: ${hit.repository}\nPath: ${hit.path}\nURL: https://github.com/${hit.repository}/blob/main/${hit.path}\nLicense: MIT\n\nSnippets:\n--- Snippet 1 (Line 1) ---\nmatch\n` }));
  return new Response(`event: message\ndata: ${JSON.stringify({ result: { content }, jsonrpc: "2.0", id: 1 })}\n\n`, { status, headers: { "content-type": "text/event-stream" } });
}

interface GrepCall {
  name: string;
  arguments: Record<string, unknown>;
  headers: Headers;
  method: string;
}

function codeSearchFetch(options: { grep: (args: Record<string, unknown>) => Response; github?: (url: URL) => Response }) {
  const grepCalls: GrepCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url.origin === "https://mcp.grep.app") {
      const body = JSON.parse(String(init?.body)) as { params: { name: string; arguments: Record<string, unknown> } };
      grepCalls.push({ name: body.params.name, arguments: body.params.arguments, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
      return options.grep(body.params.arguments);
    }
    return options.github?.(url) ?? new Response("unexpected request", { status: 404 });
  };
  return { fetch, grepCalls };
}

function requestedRepositories(query: string): string[] {
  return query.split(/\s+/).filter((token) => token.startsWith("repo:")).map((token) => token.slice(5));
}

describe("GitHub and GitLab repository research", () => {
  test("normalizes each failure field from a single read", () => {
    const cases: Array<{ field: keyof RequestFailure; base: RequestFailure }> = [
      { field: "provider", base: { provider: "github", endpoint: "search", category: "network", attempts: 1, retryRefused: false } },
      { field: "endpoint", base: { provider: "github", endpoint: "search", category: "network", attempts: 1, retryRefused: false } },
      { field: "category", base: { provider: "github", endpoint: "search", category: "network", attempts: 1, retryRefused: false } },
      { field: "status", base: { provider: "github", endpoint: "search", category: "http_status", status: 503, attempts: 1, retryRefused: false } },
      { field: "limitBytes", base: { provider: "github", endpoint: "source", category: "size_limit", limitBytes: 1_000_001, attempts: 1, retryRefused: false } },
      { field: "page", base: { provider: "gitlab", endpoint: "tree", category: "network", page: 2, attempts: 1, retryRefused: false } },
      { field: "responseProblem", base: { provider: "grep", endpoint: "search", category: "invalid_response", responseProblem: "tool_error", attempts: 1, retryRefused: false } },
      { field: "contentType", base: { provider: "grep", endpoint: "search", category: "invalid_response", responseProblem: "not_json_rpc", contentType: "text/html", attempts: 1, retryRefused: false } },
      { field: "rpcErrorCode", base: { provider: "grep", endpoint: "search", category: "invalid_response", responseProblem: "rpc_error", rpcErrorCode: -32000, attempts: 1, retryRefused: false } },
      { field: "attempts", base: { provider: "github", endpoint: "search", category: "network", attempts: 2, retryRefused: false } },
      { field: "retryRefused", base: { provider: "github", endpoint: "search", category: "network", attempts: 2, retryRefused: true } },
    ];
    const marker = "MARKER_DELTA_4H7J2L9Q";

    for (const { field, base } of cases) {
      const expected = new ProviderRequestError(base);
      const expectedDescription = describeRequestFailure(base);
      const described = statefulRecord(field, base, marker);
      const description = describeRequestFailure(described.record);
      expect(description).toBe(expectedDescription);
      expect(described.reads()).toBe(1);
      expectNoCredentialFragments(description, [marker]);

      const constructed = statefulRecord(field, base, marker);
      const error = new ProviderRequestError(constructed.record);
      expect(error.failure).toEqual(expected.failure);
      expect(Object.isFrozen(error.failure)).toBe(true);
      expect(error.message).toBe(expectedDescription);
      expect(constructed.reads()).toBe(1);
      expect(requestFailureOf(error, { provider: "gitlab", endpoint: "tree", page: 2 })).toEqual(error.failure);
    }
  });

  test("ignores every property of a forged or hostile caught value", () => {
    const target = { provider: "gitlab", endpoint: "tree", page: 2 } as const;
    const internal: RequestFailure = { ...target, category: "internal", attempts: 0, retryRefused: false };
    const forged = forgedProviderError("MARKER_ECHO_7M4N2P8Q");
    let getterReads = 0;
    const throwingGetter = Object.defineProperty({}, "failure", {
      get() { getterReads += 1; throw new Error("MARKER_ECHO_7M4N2P8Q"); },
    });
    const hostileProxy = new Proxy({}, {
      get() { throw new Error("MARKER_ECHO_7M4N2P8Q"); },
      getPrototypeOf() { throw new Error("MARKER_ECHO_7M4N2P8Q"); },
      ownKeys() { throw new Error("MARKER_ECHO_7M4N2P8Q"); },
      has() { throw new Error("MARKER_ECHO_7M4N2P8Q"); },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const unregistered = [forged.value, throwingGetter, hostileProxy, revoked.proxy, null, undefined, "text", 7, Symbol("x")];

    for (const value of unregistered) {
      expect(registeredRequestFailure(value)).toBeUndefined();
      expect(requestFailureOf(value, target)).toEqual(internal);
    }
    expect(forged.reads()).toBe(0);
    expect(getterReads).toBe(0);

    const registered = new ProviderRequestError({
      provider: "github", endpoint: "source", category: "network", attempts: 1, retryRefused: false,
    });
    const expected = registered.failure;
    Object.defineProperty(registered, "failure", { get() { throw new Error("must not read"); } });
    expect(registeredRequestFailure(registered)).toBe(expected);
    expect(requestFailureOf(registered, target)).toBe(expected);
  });

  for (const fixture of extractionFailureCases) {
    test(`keeps ${fixture.name} on a fixed source failure`, async () => {
      const injected = fixture.create(fixture.marker, "source");
      const urls: URL[] = [];
      const researcher = new GitHubResearcher({
        fetch: async (input) => {
          const url = requestUrl(input);
          urls.push(url);
          throw injected.value;
        },
      });
      const repo: RepositorySnapshot = {
        candidate: candidate("x", { fullName: "org/repo-x" }),
        commitSha: COMMIT,
        treeTruncated: false,
        files: [{ id: "F-secret", path: "src/secret.ts", size: 10 }],
      };
      let thrown: unknown;
      try {
        await researcher.fetchSource(repo, "src/secret.ts");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProviderRequestError);
      if (!(thrown instanceof ProviderRequestError)) throw new Error("source failure was not typed");
      expect(thrown.failure).toMatchObject({ provider: "github", endpoint: "source", category: fixture.category, attempts: 2 });
      const sourceRequests = urls.filter((url) => url.origin === "https://raw.githubusercontent.com");
      expect(sourceRequests).toHaveLength(2);
      expect(sourceRequests.every((url) => url.pathname === `/org/repo-x/${COMMIT}/src/secret.ts`)).toBe(true);
      expect(injected.reads()).toBe(0);
      expectNoCredentialFragments(String(thrown), [fixture.marker]);
      expectNoCredentialFragments(JSON.stringify(thrown), [fixture.marker]);
    });

    test(`contains ${fixture.name} on a search request`, async () => {
      const injected = fixture.create(fixture.marker, "search");
      const urls: URL[] = [];
      const researcher = new GitHubResearcher({
        fetch: async (input) => {
          const url = requestUrl(input);
          urls.push(url);
          if (url.origin === "https://api.github.com" && url.pathname === "/search/repositories") throw injected.value;
          return url.origin === "https://gitlab.com" && url.pathname === "/api/v4/projects" ? json([]) : json({ items: [] });
        },
        now: () => NOW,
        minimumPassing: 20,
        searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
      });

      const result = await researcher.discover({ phrases: ["refund"], topics: [] });
      const failedQuery = result.research.queries.find((query) => query.provider === "github" && query.status === "failed");

      expect(failedQuery?.failure).toMatchObject({ provider: "github", endpoint: "search", category: "network", attempts: 2, retryRefused: false });
      expect(urls.filter((url) => url.origin === "https://api.github.com" && url.pathname === "/search/repositories")).toHaveLength(2);
      expect(injected.reads()).toBe(0);
      expectNoCredentialFragments(JSON.stringify(result), [fixture.marker]);
    });

    test(`contains ${fixture.name} on a tree request`, async () => {
      const injected = fixture.create(fixture.marker, "tree");
      const urls: URL[] = [];
      const researcher = new GitHubResearcher({
        fetch: async (input) => {
          const url = requestUrl(input);
          urls.push(url);
          if (url.pathname.includes("/git/trees/")) throw injected.value;
          if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
          return new Response("unexpected request", { status: 404 });
        },
        now: () => NOW,
        shortlistSize: 1,
        maxTreeResolutions: 1,
      });

      const result = await researcher.resolveShortlist([candidate("x", { fullName: "org/repo-x" })]);
      const treeRequests = urls.filter((url) => url.origin === "https://api.github.com" && url.pathname.includes("/git/trees/"));

      const commitRequests = urls.filter((url) => url.origin === "https://api.github.com" && url.pathname.endsWith("/repos/org/repo-x/commits/main"));
      expect(commitRequests).toHaveLength(1);
      expect(treeRequests).toHaveLength(1);
      expect(treeRequests.every((url) => url.pathname.startsWith("/repos/org/repo-x/git/trees/"))).toBe(true);
      expect(result.excluded[0]?.reasons[0]).toContain("no response (network failure)");
      expect(result.excluded[0]?.reasons[0]).toContain("the retry was not sent because the request budget was exhausted");
      expect(result.gaps[0]?.message).toContain("Core request budget of 2 attempts");
      expect(result.resolutions).toBe(1);
      expect(injected.reads()).toBe(0);
      expectNoCredentialFragments(JSON.stringify(result), [fixture.marker]);
    });
  }

  test("reports how many candidates one shortlist resolution tries", () => {
    expect(new GitHubResearcher().treeResolutionLimit).toBe(8);
    expect(new GitHubResearcher({ maxTreeResolutions: 3 }).treeResolutionLimit).toBe(3);
  });

  test("uses GitLab as fallback and parses signals before requiring a pinned root license", async () => {
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.origin === "https://api.github.com") return json({ items: [] });
        if (url.pathname === "/api/v4/projects") {
          return json([{
            id: 60510562,
            path_with_namespace: "org/refunds",
            default_branch: "main",
            description: "Refund service",
            star_count: 180,
            forks_count: 11,
            last_activity_at: "2026-08-01T10:00:00Z",
            created_at: "2021-06-01T10:00:00Z",
            topics: ["refunds"],
          }]);
        }
        if (url.pathname === "/api/v4/projects/60510562/repository/commits/main") return json({ id: COMMIT, created_at: "2026-06-01T10:00:00Z" });
        if (url.pathname === "/api/v4/projects/60510562/repository/tree") {
          return json([
            { type: "blob", path: "src/handler.ts", size: 23 },
            { type: "blob", path: "tests/handler.test.ts", size: 30 },
            { type: "blob", path: "LICENSE", size: 18 },
          ], { "x-next-page": "" });
        }
        if (url.pathname.includes("/repository/files/")) return new Response("export const handler = true;\n", { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });

    const discovery = await researcher.discover(material);
    expect(discovery.candidates).toHaveLength(1);
    expect(discovery.candidates[0]).toMatchObject({ provider: "gitlab", fullName: "org/refunds", providerProjectId: "60510562" });
    expect(discovery.candidates[0]?.signals).toEqual({
      stars: 180,
      forks: 11,
      archived: null,
      fork: null,
      licenseSpdxId: null,
      language: null,
      topics: ["refunds"],
      pushedAt: "2026-08-01T10:00:00.000Z",
      createdAt: "2021-06-01T10:00:00.000Z",
    });
    expect(urls.filter((url) => url.origin === "https://api.github.com").length).toBe(9);
    const gitlabSearch = urls.find((url) => url.pathname === "/api/v4/projects")!;
    expect(gitlabSearch.searchParams.get("simple")).toBe("true");
    expect(gitlabSearch.searchParams.get("archived")).toBe("false");
    expect(gitlabSearch.searchParams.get("per_page")).toBe("20");

    const resolution = await researcher.resolveShortlist(discovery.candidates);
    expect(resolution.gaps).toEqual([]);
    expect(resolution.snapshots).toHaveLength(1);
    expect(resolution.snapshots[0]).toMatchObject({ commitSha: COMMIT, commitDate: "2026-06-01T10:00:00.000Z", licensePath: "LICENSE", testFileCount: 1 });
    const file = await researcher.fetchSource(resolution.snapshots[0]!, "src/handler.ts");
    expect(new TextDecoder().decode(file)).toBe("export const handler = true;\n");
    expect(urls.some((url) => url.pathname === `/api/v4/projects/60510562/repository/commits/${COMMIT}`)).toBe(false);
    expect(urls.some((url) => url.pathname === "/api/v4/projects/60510562/repository/commits/main")).toBe(true);
    expect(resolution.snapshots[0]?.candidate.signals?.licenseSpdxId).toBeNull();
  });

  test("widens by tiers and stops after the tier with four metadata-passing candidates", async () => {
    const calls: URL[] = [];
    const entries = Array.from({ length: 4 }, (_, index) => ({
      full_name: `org/refund-${index + 1}`,
      default_branch: "main",
      description: "Refund workflow service",
      stargazers_count: 80 + index,
      forks_count: 10,
      archived: false,
      fork: false,
      license: { spdx_id: "MIT" },
      language: "TypeScript",
      topics: ["refunds"],
      pushed_at: "2026-06-01T00:00:00Z",
      created_at: "2020-01-01T00:00:00Z",
    }));
    const researcher = new GitHubResearcher({
      now: () => NOW,
      fetch: async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        const query = url.searchParams.get("q") ?? "";
        return json({ items: query.includes("stars:>=50") ? entries : [] });
      },
    });

    const result = await researcher.discover(material);

    expect(calls).toHaveLength(6);
    expect(calls.every((url) => url.searchParams.get("per_page") === "20")).toBe(true);
    expect(result.candidates).toHaveLength(4);
    const sentQueries = result.research.queries.filter((query) => query.status === "ok");
    expect(sentQueries).toHaveLength(6);
    expect(sentQueries.every((query) => query.resultCount === (query.tier === 0 ? 0 : 4))).toBe(true);
    expect(sentQueries.map((query) => query.tier)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(result.research.queries).toHaveLength(9);
    expect(result.research.queries.filter((query) => query.status === "skipped").every((query) => query.tier === 2)).toBe(true);
    expect(result.research.searchRequests.github).toBe(6);
  });

  test("honors the search request budget and records unsent queries as skipped", async () => {
    const calls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      maxSearchRequests: 4,
      minimumPassing: 20,
      fetch: async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        return json(url.pathname === "/search/repositories" ? { items: [] } : []);
      },
    });

    const result = await researcher.discover(material);

    expect(calls.filter((url) => url.pathname === "/search/repositories")).toHaveLength(4);
    expect(result.research.searchRequests.github).toBe(4);
    expect(result.research.queries.filter((query) => query.status === "skipped")).toHaveLength(5);
    expect(result.research.queries).toHaveLength(11);
  });

  test("counts a retried HTTP failure against the actual GitHub request budget", async () => {
    let githubCalls = 0;
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      maxSearchRequests: 2,
      minimumPassing: 20,
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.origin === "https://api.github.com") {
          githubCalls += 1;
          return githubCalls === 1 ? new Response("server error", { status: 500 }) : json({ items: [] });
        }
        return json([]);
      },
    });

    const result = await researcher.discover({ phrases: ["refund"], topics: [] });

    expect(githubCalls).toBe(2);
    expect(urls.filter((url) => url.pathname === "/search/repositories")).toHaveLength(2);
    expect(result.research.searchRequests.github).toBe(2);
    expect(result.research.queries.find((query) => query.provider === "github")?.status).toBe("ok");
    expect(result.research.queries.find((query) => query.provider === "github")?.failure).toBeUndefined();
    expect(result.research.queries.filter((query) => query.provider === "github" && query.status === "skipped")).toHaveLength(2);
  });

  test("keeps the first attempt's failure when the budget refuses the search retry", async () => {
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      maxSearchRequests: 1,
      minimumPassing: 20,
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.pathname === "/search/repositories") return new Response("adapter body", { status: 500, statusText: "adapter status" });
        return json([]);
      },
    });

    const result = await researcher.discover({ phrases: ["refund"], topics: [] });

    expect(urls.filter((url) => url.pathname === "/search/repositories")).toHaveLength(1);
    expect(result.research.queries[0]).toMatchObject({
      status: "failed",
      failure: { provider: "github", endpoint: "search", category: "http_status", status: 500, attempts: 1, retryRefused: true },
    });
    expect(result.gaps[0]?.message).toContain("HTTP 500");
    expect(result.gaps[0]?.message).toContain("the retry was not sent because the request budget was exhausted");
    expect(result.research.queries.filter((query) => query.provider === "github").slice(1).every((query) => query.status === "skipped")).toBe(true);
  });

  test("keeps the first tree failure when the core budget refuses the retry", async () => {
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return new Response("adapter body", { status: 500 });
        return new Response("unexpected", { status: 404 });
      },
      now: () => NOW,
      maxTreeResolutions: 1,
    });

    const result = await researcher.resolveShortlist([candidate("first"), candidate("second")]);
    const treeUrls = urls.filter((url) => url.pathname.includes("/git/trees/"));
    const commitUrls = urls.filter((url) => url.pathname.endsWith("/commits/main"));

    expect(treeUrls).toHaveLength(1);
    expect(commitUrls).toHaveLength(1);
    expect(result.excluded[0]?.reasons[0]).toContain("HTTP 500");
    expect(result.excluded[0]?.reasons[0]).toContain("the retry was not sent");
    expect(result.gaps[0]?.message).toContain("HTTP 500");
    expect(result.gaps[0]?.message).toContain("Core request budget of 2 attempts");
    expect(result.excluded[1]?.reasons[0]).toContain("core request budget");
    expect(result.resolutions).toBe(1);
  });

  test("does not retry a GitHub search rate limit and records the remaining queries as skipped", async () => {
    let calls = 0;
    const urls: URL[] = [];
    const tokenSentinel = "SYNTHETIC_GITHUB_TOKEN_SENTINEL";
    const researcher = new GitHubResearcher({
      now: () => NOW,
      githubToken: tokenSentinel,
      fetch: async (input) => {
        calls += 1;
        urls.push(requestUrl(input));
        return json({ message: `limit ${tokenSentinel}` }, { "x-ratelimit-remaining": "0" }, 403);
      },
    });

    const result = await researcher.discover({ phrases: [], topics: ["refunds"] });

    expect(calls).toBe(1);
    expect(urls.map((url) => url.pathname)).toEqual(["/search/repositories"]);
    expect(result.research.searchRequests.github).toBe(1);
    expect(result.research.rateLimited).toBe(true);
    expect(result.research.queries[0]?.failure).toMatchObject({ provider: "github", endpoint: "search", category: "rate_limit", attempts: 1 });
    expect(result.gaps[0]?.message).toContain("rate limit");
    expect(JSON.stringify(result)).not.toContain(tokenSentinel);
    expect(result.research.queries.filter((query) => query.status === "skipped")).toHaveLength(2);
  });

  test("expectNoFragment rejects the REV2 16-character prefix leak", () => {
    const priorToken = "REV2_GITHUB_SENTINEL_0123456789XYZ";
    const priorPrefixLeak = `${"x".repeat(164)}${priorToken.slice(0, 16)}`;
    expect(() => expectNoCredentialFragments(priorPrefixLeak, [priorToken])).toThrow("credential fragment");
  });

  for (const endpoint of FAILURE_ENDPOINTS) {
    for (const fault of FAILURE_FAULTS) {
      test(`host failure categories carry no adapter text at ${endpoint}: ${fault}`, async () => {
        await exerciseFailure(endpoint, fault);
      });
    }
  }

  test("resolves the next candidates after tree failures to fill six verified slots", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(String(index + 1), {
      fullName: `org/repo-${index + 1}`,
    }));
    const { fetch, urls } = treeFetch({ noTests: new Set(["repo-2", "repo-5"]) });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW });

    const result = await researcher.resolveShortlist(candidates);

    expect(result.snapshots.map((snapshot) => snapshot.candidate.id)).toEqual(["1", "3", "4", "6", "7", "8"]);
    expect(result.excluded).toEqual(expect.arrayContaining([
      {
        candidate: candidates[1],
        reasons: [`no test file at ${COMMIT}`],
        resolution: { commitSha: COMMIT, commitDate: "2026-06-01T00:00:00.000Z", treeFileCount: 2, testFileCount: 0, licensePath: "LICENSE" },
      },
      {
        candidate: candidates[4],
        reasons: [`no test file at ${COMMIT}`],
        resolution: { commitSha: COMMIT, commitDate: "2026-06-01T00:00:00.000Z", treeFileCount: 2, testFileCount: 0, licensePath: "LICENSE" },
      },
    ]));
    expect(result.resolutions).toBe(8);
    expect(urls.filter((url) => url.pathname.includes("/commits/") || url.pathname.includes("/git/trees/")).length).toBeLessThanOrEqual(16);
  });

  test("counts every retried commit-pinned core attempt and excludes candidates at the core budget", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(String(index + 1), {
      fullName: `org/repo-${index + 1}`,
    }));
    const treeAttempts = new Map<string, number>();
    const coreUrls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname.includes("/commits/") || url.pathname.includes("/git/trees/")) coreUrls.push(url);
        if (url.pathname.endsWith("/commits/main")) {
          return json({ sha: COMMIT, commit: { committer: { date: "2026-06-01T00:00:00Z" } } });
        }
        if (url.pathname.includes("/git/trees/")) {
          const repo = url.pathname.split("/")[3] ?? "";
          const attempts = (treeAttempts.get(repo) ?? 0) + 1;
          treeAttempts.set(repo, attempts);
          return attempts === 1 ? new Response("server error", { status: 500 }) : json(treeFor(repo));
        }
        return new Response("unexpected request", { status: 404 });
      },
    });

    const result = await researcher.resolveShortlist(candidates);

    expect(coreUrls).toHaveLength(16);
    expect(coreUrls.some((url) => url.pathname.includes("/commits/main"))).toBe(true);
    expect(coreUrls.some((url) => url.pathname.includes("/git/trees/"))).toBe(true);
    expect(result.snapshots.map((snapshot) => snapshot.candidate.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.excluded.map((entry) => entry.candidate.id)).toEqual(["6", "7", "8"]);
    expect(result.excluded.every((entry) => entry.reasons.join(" ").toLowerCase().includes("core request budget"))).toBe(true);
    expect([...treeAttempts.values()].every((attempts) => attempts === 2)).toBe(true);
    expect(result.resolutions).toBe(6);
  });

  test("keeps tree read failures as non-material diagnostics and continues resolving later candidates", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(String(index + 1), {
      fullName: `org/repo-${index + 1}`,
    }));
    const urls: URL[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
      if (url.pathname.includes("/git/trees/")) {
        if (url.pathname.includes("/repo-1/")) return new Response("server error", { status: 500 });
        const repo = url.pathname.split("/")[3] ?? "";
        return json(treeFor(repo));
      }
      return new Response("unexpected request", { status: 404 });
    };
    const researcher = new GitHubResearcher({ fetch, now: () => NOW });

    const result = await researcher.resolveShortlist(candidates);

    expect(result.snapshots.map((snapshot) => snapshot.candidate.id)).toEqual(["2", "3", "4", "5", "6", "7"]);
    expect(result.excluded[0]?.candidate.id).toBe("1");
    expect(urls.filter((url) => url.pathname.includes("/repos/org/repo-1/git/trees/")).length).toBe(2);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ kind: "tree", material: false });
    expect(result.gaps[0]?.message).toContain("Could not read a commit-pinned file tree for org/repo-1; GitHub tree request failed after one retry: HTTP 500.");
  });

  test("marks a shortlist rate limit material only before any snapshot is verified", async () => {
    const candidates = [candidate("1"), candidate("2")];
    const afterUrls: URL[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = requestUrl(input);
      afterUrls.push(url);
      if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
      if (url.pathname.includes("/git/trees/")) {
        if (url.pathname.includes("/repo-1/")) return json(treeFor("repo-1"));
        return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
      }
      return new Response("unexpected request", { status: 404 });
    };
    const researcher = new GitHubResearcher({ fetch, now: () => NOW });
    const afterVerified = await researcher.resolveShortlist(candidates);

    expect(afterVerified.snapshots).toHaveLength(1);
    expect(afterVerified.rateLimited).toBe(true);
    expect(afterVerified.gaps[0]).toMatchObject({ kind: "tree", material: false });
    expect(afterUrls.some((url) => url.pathname.includes("/repos/org/repo-1/git/trees/"))).toBe(true);
    expect(afterUrls.some((url) => url.pathname.includes("/repos/org/repo-2/git/trees/"))).toBe(true);

    const beforeUrls: URL[] = [];
    const beforeVerified = await new GitHubResearcher({
      now: () => NOW,
      fetch: async (input) => {
        const url = requestUrl(input);
        beforeUrls.push(url);
        return url.pathname.endsWith("/commits/main")
          ? json({ sha: COMMIT })
          : new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
      },
    }).resolveShortlist([candidate("first-limited")]);
    expect(beforeVerified.snapshots).toHaveLength(0);
    expect(beforeVerified.rateLimited).toBe(true);
    expect(beforeVerified.gaps[0]).toMatchObject({ kind: "tree", material: true });
    expect(beforeUrls.some((url) => url.pathname.includes("/repos/org/repo-first-limited/git/trees/"))).toBe(true);
  });

  test("excludes a null-license repository without a root license and keeps the following verified candidates", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(String(index + 1), {
      fullName: `org/repo-${index + 1}`,
      signals: signals(index === 6 ? { licenseSpdxId: null } : {}),
    }));
    const { fetch, urls } = treeFetch({ noTests: new Set(["repo-2"]), noLicense: new Set(["repo-7"]) });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW });
    const result = await researcher.resolveShortlist(candidates);
    expect(result.snapshots.map((snapshot) => snapshot.candidate.id)).toEqual(["1", "3", "4", "5", "6", "8"]);
    expect(result.excluded.find((entry) => entry.candidate.id === "2")?.reasons).toEqual([`no test file at ${COMMIT}`]);
    expect(result.excluded.find((entry) => entry.candidate.id === "7")?.reasons[0]).toContain("no license: GitHub reported no license");
    expect(result.resolutions).toBe(8);
    expect(urls.filter((url) => url.pathname.includes("/commits/") || url.pathname.includes("/git/trees/")).length).toBeLessThanOrEqual(16);
  });

  test("excludes a NOASSERTION repository whose pinned tree has no root license file", async () => {
    const unidentified = candidate("unidentified", { signals: signals({ licenseSpdxId: "NOASSERTION" }) });
    const { fetch } = treeFetch({ noLicense: new Set(["repo-unidentified"]) });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, shortlistSize: 1, maxTreeResolutions: 1 });

    const result = await researcher.resolveShortlist([unidentified]);

    expect(result.snapshots).toEqual([]);
    expect(result.excluded[0]?.reasons[0]).toContain("no license: GitHub could not identify the license (NOASSERTION)");
  });

  test("accepts a root LICENSE.md when GitHub did not report license metadata", async () => {
    const licenseCandidate = candidate("licensed", { signals: signals({ licenseSpdxId: null }) });
    const { fetch } = treeFetch({ licensePath: "LICENSE.md" });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, shortlistSize: 1, maxTreeResolutions: 1 });
    const result = await researcher.resolveShortlist([licenseCandidate]);
    expect(result.snapshots[0]).toMatchObject({ licensePath: "LICENSE.md", testFileCount: 1 });
  });

  test("reaches a ninth reordered null-license candidate and keeps its root LICENSE.md evidence", async () => {
    const byId = new Map(Array.from({ length: 9 }, (_, index) => {
      const id = String(index + 1);
      return [id, candidate(id, {
        fullName: `org/repo-${id}`,
        signals: signals(id === "7" ? { licenseSpdxId: null } : {}),
      })] as const;
    }));
    const ordered = ["1", "2", "3", "4", "5", "6", "8", "9", "7"].map((id) => byId.get(id)!);
    const { fetch, urls } = treeFetch({ noTests: new Set(["repo-2", "repo-8", "repo-9"]), licensePath: "LICENSE.md" });
    const researcher = new GitHubResearcher({
      fetch,
      now: () => NOW,
      maxTreeResolutions: 9,
      shortlistSize: 6,
    });

    const result = await researcher.resolveShortlist(ordered);

    expect(result.snapshots.map((snapshot) => snapshot.candidate.id)).toEqual(["1", "3", "4", "5", "6", "7"]);
    expect(result.snapshots.at(-1)).toMatchObject({
      candidate: { id: "7" },
      licensePath: "LICENSE.md",
      testFileCount: 1,
    });
    expect(result.resolutions).toBe(9);
    expect(urls.filter((url) => url.pathname.includes("/commits/") || url.pathname.includes("/git/trees/")).length).toBe(18);
  });

  test("loads a 1.5 MB non-truncated tree with every file and keeps provider truncation", async () => {
    const candidateValue = candidate("large");
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      path: `src/${String(index).padStart(4, "0")}-${"x".repeat(260)}.ts`,
      type: "blob",
      size: 20,
    }));
    entries.push({ path: "tests/index.test.ts", type: "blob", size: 20 }, { path: "LICENSE", type: "blob", size: 20 });
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json({ tree: entries, truncated: false });
        return new Response("unexpected", { status: 404 });
      },
      now: () => NOW,
      shortlistSize: 1,
      maxTreeResolutions: 1,
    });
    const result = await researcher.resolveShortlist([candidateValue]);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.files).toHaveLength(5_002);
    expect(result.snapshots[0]?.treeTruncated).toBe(false);
    expect(urls.some((url) => url.pathname.includes("/git/trees/"))).toBe(true);

    const truncated = new GitHubResearcher({
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json({ tree: [{ path: "tests/a.test.ts", type: "blob" }], truncated: true });
        return new Response("unexpected", { status: 404 });
      },
      now: () => NOW,
      shortlistSize: 1,
      maxTreeResolutions: 1,
    });
    const truncatedResult = await truncated.resolveShortlist([candidateValue]);
    expect(truncatedResult.snapshots[0]?.treeTruncated).toBe(true);
    expect(truncatedResult.gaps.some((gap) => gap.message.includes("truncated at"))).toBe(false);
  });

  test("makes a recovered search failure non-material when a later query finds passing candidates", async () => {
    let githubCalls = 0;
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      minimumPassing: 1,
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.origin !== "https://api.github.com") return json([]);
        githubCalls += 1;
        if (githubCalls <= 2) throw new Error("temporary network failure");
        return json({ items: [{
          full_name: "org/refund-ready",
          default_branch: "main",
          description: "Refund workflow",
          stargazers_count: 250,
          forks_count: 10,
          archived: false,
          fork: false,
          license: { spdx_id: "MIT" },
          language: "TypeScript",
          topics: ["refunds"],
          pushed_at: "2026-06-01T00:00:00Z",
          created_at: "2020-01-01T00:00:00Z",
        }] });
      },
    });

    const result = await researcher.discover(material);

    expect(result.candidates).toHaveLength(1);
    expect(urls.filter((url) => url.pathname === "/search/repositories")).toHaveLength(githubCalls);
    expect(githubCalls).toBeGreaterThan(2);
    expect(result.gaps[0]).toMatchObject({ kind: "search", material: false });
  });

  test("retains the 1 MB source response limit", async () => {
    const repo: RepositorySnapshot = {
      candidate: candidate("source"),
      commitSha: COMMIT,
      treeTruncated: false,
      files: [{ id: "F1", path: "src/large.ts", size: 1_200_000 }],
    };
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      fetch: async (input) => {
        urls.push(requestUrl(input));
        return new Response("x".repeat(1_200_000), { status: 200 });
      },
    });
    let thrown: unknown;
    try {
      await researcher.fetchSource(repo, "src/large.ts");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderRequestError);
    if (!(thrown instanceof ProviderRequestError)) throw new Error("oversized source failure was not typed");
    expect(thrown.failure).toMatchObject({ provider: "github", endpoint: "source", category: "size_limit", limitBytes: 1_000_000, attempts: 1 });
    expect(thrown.message).toBe("GitHub source request failed: response exceeded the 1 MB source limit");
    expect(urls.filter((url) => url.origin === "https://raw.githubusercontent.com" && url.pathname.endsWith("/src/large.ts"))).toHaveLength(1);
  });

  test("does not retry a tree response over the 8 MB limit and moves on to the next candidate", async () => {
    const coreUrls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname.includes("/commits/") || url.pathname.includes("/git/trees/")) coreUrls.push(url);
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/repos/org/repo-huge/git/trees/")) return new Response("x".repeat(8_000_001), { status: 200 });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-small"));
        return new Response("unexpected request", { status: 404 });
      },
    });

    const result = await researcher.resolveShortlist([candidate("huge"), candidate("small")]);

    expect(coreUrls.filter((url) => url.pathname.includes("/repos/org/repo-huge/git/trees/"))).toHaveLength(1);
    expect(coreUrls).toHaveLength(4);
    expect(result.gaps).toContainEqual({ kind: "tree", message: "Could not read a commit-pinned file tree for org/repo-huge; GitHub tree request failed: response exceeded the 8 MB tree limit.", material: false });
    expect(result.snapshots.map((snapshot) => snapshot.candidate.id)).toEqual(["small"]);
  });

  test("reports provider status after a failed commit resolution", async () => {
    const value = candidate("blocked", { provider: "gitlab", providerProjectId: "60510562", fullName: "org/refunds" });
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        return url.pathname.endsWith("/repository/commits/main")
          ? new Response("upstream access denied", { status: 403 })
          : new Response("unexpected request", { status: 500 });
      },
      now: () => NOW,
    });

    const result = await researcher.resolveShortlist([value]);

    expect(result.snapshots).toEqual([]);
    expect(urls.filter((url) => url.pathname.endsWith("/repository/commits/main"))).toHaveLength(2);
    expect(urls.filter((url) => url.pathname.endsWith("/repository/tree"))).toHaveLength(0);
    expect(result.gaps).toEqual([{ kind: "tree", message: "Could not read a commit-pinned file tree for org/refunds; GitLab commit request failed after one retry: HTTP 403.", material: false }]);
    expect(result.excluded[0]?.candidate.id).toBe("blocked");
  });
});

describe("Grep code search", () => {
  test("adds code-matched repositories through one batched GitHub metadata search", async () => {
    const metadataQueries: string[] = [];
    const known = new Map([
      ["org/refunds-b", searchItem("org/refunds-b", 120)],
      ["org/refunds-c", searchItem("org/refunds-c", 90)],
    ]);
    const { fetch, grepCalls } = codeSearchFetch({
      grep: (args) => args.query === "OrderRefund"
        ? grepResponse([
          { repository: "org/refunds-a", path: "src/refund.ts" },
          { repository: "org/refunds-b", path: "app/models/refund.py" },
          { repository: "org/refunds-c", path: "lib/refund.rb" },
          { repository: "microsoft/semantic-kernel", path: "python/samples/handoff.py" },
        ])
        : grepResponse([{ repository: "org/refunds-b", path: "app/services/refunds.py" }]),
      github: (url) => {
        const query = url.searchParams.get("q") ?? "";
        if (query.startsWith("repo:")) {
          metadataQueries.push(query);
          return json({ items: requestedRepositories(query).flatMap((name) => known.get(name) ?? []) });
        }
        return json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] });
      },
    });
    const researcher = new GitHubResearcher({
      fetch,
      githubToken: "SENTINEL_GITHUB_c0de5ea7c4b1e2d3",
      gitlabToken: "SENTINEL_GITLAB_0f1e2d3c4b5a6978",
      now: () => NOW,
      codeSearch: true,
      minimumPassing: 1,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund", "refund_amount"] });

    expect(discovery.candidates.map((entry) => entry.fullName).sort()).toEqual(["org/refunds-a", "org/refunds-b", "org/refunds-c"]);
    expect(metadataQueries).toEqual(["repo:org/refunds-b repo:org/refunds-c"]);
    expect(discovery.candidates.find((entry) => entry.fullName === "org/refunds-b")?.codeMatches).toEqual([
      { pattern: "OrderRefund", path: "app/models/refund.py" },
      { pattern: "refund_amount", path: "app/services/refunds.py" },
    ]);
    expect(discovery.candidates.find((entry) => entry.fullName === "org/refunds-c")?.codeMatches).toEqual([
      { pattern: "OrderRefund", path: "lib/refund.rb" },
    ]);
    expect(discovery.candidates.find((entry) => entry.fullName === "org/refunds-a")?.codeMatches).toEqual([
      { pattern: "OrderRefund", path: "src/refund.ts" },
    ]);
    expect(discovery.research.codeSearch).toMatchObject({ requests: 2, budget: 12, repositoriesMatched: 3, repositoriesScreened: 2, metadataRequests: 1 });
    expect(discovery.research.codeSearch?.queries.map((query) => [query.purpose, query.query, query.status, query.resultCount])).toEqual([
      ["discovery", "OrderRefund", "ok", 4],
      ["discovery", "refund_amount", "ok", 1],
    ]);
    expect(grepCalls.map((call) => call.arguments)).toEqual([{ query: "OrderRefund" }, { query: "refund_amount" }]);
    for (const call of grepCalls) {
      expect(call.name).toBe("searchGitHub");
      expect(call.method).toBe("POST");
      expect(call.headers.get("accept")).toContain("text/event-stream");
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("authorization")).toBeNull();
      expect(call.headers.get("private-token")).toBeNull();
    }
    expect(discovery.gaps).toEqual([]);
  });

  test("sends no token on repository-scoped Grep requests", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => grepResponse([]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-token"));
        return new Response("unexpected request", { status: 404 });
      },
    });
    const researcher = new GitHubResearcher({
      fetch,
      githubToken: "SENTINEL_GITHUB_scoped_123456",
      gitlabToken: "SENTINEL_GITLAB_scoped_654321",
      now: () => NOW,
      codeSearch: true,
    });

    const resolution = await researcher.resolveShortlist([candidate("token")], undefined, undefined, ["OrderRefund"]);

    expect(grepCalls).toHaveLength(1);
    expect(grepCalls[0]?.arguments).toEqual({ query: "OrderRefund", repo: "org/repo-token" });
    expect(grepCalls[0]?.headers.get("authorization")).toBeNull();
    expect(grepCalls[0]?.headers.get("private-token")).toBeNull();
    expect(resolution.codeSearch?.queries.map((query) => query.status)).toEqual(["ok"]);
  });

  test("screens Grep-only repositories with the metadata bar", async () => {
    const archived = searchItem("org/archived", 800, "Refund workflow service");
    archived.archived = true;
    const metadataQueries: string[] = [];
    const { fetch } = codeSearchFetch({
      grep: () => grepResponse([{ repository: "org/archived", path: "src/refunds.ts" }]),
      github: (url) => {
        if (url.searchParams.get("q")?.startsWith("repo:")) {
          const query = url.searchParams.get("q")!;
          metadataQueries.push(query);
          return json({ items: requestedRepositories(query).map(() => archived) });
        }
        if (url.origin === "https://gitlab.com") return json([]);
        return json({ items: [] });
      },
    });
    const researcher = new GitHubResearcher({
      fetch,
      now: () => NOW,
      codeSearch: true,
      minimumPassing: 1,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    expect(metadataQueries).toEqual(["repo:org/archived"]);
    expect(discovery.candidates.map((entry) => entry.fullName)).not.toContain("org/archived");
    expect(discovery.excluded.map((entry) => entry.candidate.fullName)).toContain("org/archived");
    expect(discovery.excluded.find((entry) => entry.candidate.fullName === "org/archived")?.reasons).toContain("archived");
  });

  test("reports how many repositories code search matched", async () => {
    const { fetch } = codeSearchFetch({
      grep: () => grepResponse([{ repository: "org/one", path: "src/refunds.ts" }, { repository: "org/two", path: "src/refund-service.ts" }]),
      github: (url) => {
        if (url.searchParams.get("q")?.startsWith("repo:")) return json({ items: [] });
        if (url.origin === "https://gitlab.com") return json([]);
        return json({ items: [] });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });
    const messages: string[] = [];

    await researcher.discover({ ...material, codePatterns: ["OrderRefund"] }, undefined, (message) => messages.push(message));

    expect(messages).toContain("Code search matched 2 repositories outside example and documentation paths.");
  });

  test("skips the GitLab fallback when a Grep-added candidate passes", async () => {
    let gitlabRequests = 0;
    const { fetch } = codeSearchFetch({
      grep: () => grepResponse([{ repository: "org/refunds-grep", path: "src/refunds.ts" }]),
      github: (url) => {
        if (url.searchParams.get("q")?.startsWith("repo:")) {
          const query = url.searchParams.get("q")!;
          return json({ items: requestedRepositories(query).map((name) => searchItem(name, 300)) });
        }
        if (url.origin === "https://gitlab.com") {
          gitlabRequests += 1;
          return json([]);
        }
        return json({ items: [] });
      },
    });
    const researcher = new GitHubResearcher({
      fetch,
      now: () => NOW,
      codeSearch: true,
      minimumPassing: 1,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    expect(discovery.candidates.map((entry) => entry.fullName)).toEqual(["org/refunds-grep"]);
    expect(discovery.candidates[0]?.codeMatches).toEqual([{ pattern: "OrderRefund", path: "src/refunds.ts" }]);
    expect(gitlabRequests).toBe(0);
  });

  test("records no discovery summary without code patterns", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => grepResponse([]),
      github: (url) => url.origin === "https://gitlab.com" ? json([]) : json({ items: [] }),
    });
    const researcher = new GitHubResearcher({
      fetch,
      now: () => NOW,
      codeSearch: true,
      minimumPassing: 1,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });

    const absent = await researcher.discover(material);
    const empty = await researcher.discover({ ...material, codePatterns: [] });

    expect(absent.research.codeSearch).toBeUndefined();
    expect(empty.research.codeSearch).toBeUndefined();
    expect(grepCalls).toHaveLength(0);
  });

  test("counts retries and every repository against the run-wide Grep budget", async () => {
    let retryAttempts = 0;
    const retryFixture = codeSearchFetch({
      grep: (args) => {
        if (args.query === "OrderRefund" && retryAttempts++ === 0) return new Response("temporary failure", { status: 503 });
        return grepResponse([]);
      },
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-retry"));
        return new Response("unexpected request", { status: 404 });
      },
    });
    const retryResearcher = new GitHubResearcher({ fetch: retryFixture.fetch, now: () => NOW, codeSearch: true, maxCodeSearchRequests: 2 });
    const retryResolution = await retryResearcher.resolveShortlist([candidate("retry")], undefined, undefined, ["OrderRefund", "refund_amount"]);

    expect(retryFixture.grepCalls.map((call) => call.arguments.query)).toEqual(["OrderRefund", "OrderRefund"]);
    expect(retryResolution.codeSearch?.requests).toBe(2);
    expect(retryResolution.codeSearch?.queries.map((query) => [query.query, query.status])).toEqual([
      ["OrderRefund", "ok"],
      ["refund_amount", "skipped"],
    ]);

    const repositoryFixture = codeSearchFetch({
      grep: () => grepResponse([]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-budget"));
        return new Response("unexpected request", { status: 404 });
      },
    });
    const repositoryResearcher = new GitHubResearcher({ fetch: repositoryFixture.fetch, now: () => NOW, codeSearch: true, maxCodeSearchRequests: 1 });
    const repositoryResolution = await repositoryResearcher.resolveShortlist(
      [candidate("first"), candidate("second")],
      undefined,
      undefined,
      ["OrderRefund"],
    );

    expect(repositoryFixture.grepCalls).toHaveLength(1);
    expect(repositoryResolution.codeSearch?.requests).toBe(1);
    expect(repositoryResolution.codeSearch?.queries.map((query) => [query.repository, query.status])).toEqual([
      ["org/repo-first", "ok"],
      ["org/repo-second", "skipped"],
    ]);
  });

  test("stops code search after a location failure and keeps the verified tree", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: (args) => args.query === "OrderRefund" ? new Response("unavailable", { status: 503 }) : grepResponse([]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-location-failure"));
        return new Response("unexpected request", { status: 404 });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true });

    const resolution = await researcher.resolveShortlist([candidate("location-failure")], undefined, undefined, ["OrderRefund", "refund_amount"]);

    expect(grepCalls.map((call) => call.arguments.query)).toEqual(["OrderRefund", "OrderRefund"]);
    expect(resolution.snapshots.map((snapshot) => snapshot.candidate.fullName)).toEqual(["org/repo-location-failure"]);
    expect(resolution.excluded).toEqual([]);
    expect(resolution.codeSearch?.queries.map((query) => query.status)).toEqual(["failed", "skipped"]);
    expect(resolution.gaps).toHaveLength(1);
    expect(resolution.gaps[0]?.kind).toBe("search");
    expect(resolution.gaps[0]?.message).toContain("Grep search request failed after one retry: HTTP 503");
  });

  test("marks a Grep failure material when no candidate passes", async () => {
    const { fetch } = codeSearchFetch({
      grep: () => new Response("unavailable", { status: 503 }),
      github: (url) => url.origin === "https://gitlab.com" ? json([]) : json({ items: [] }),
    });
    const researcher = new GitHubResearcher({
      fetch,
      now: () => NOW,
      codeSearch: true,
      minimumPassing: 1,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    const grepGap = discovery.gaps.find((gap) => gap.message.startsWith("Grep search request failed"));
    expect(grepGap?.material).toBe(true);
    expect(discovery.research.codeSearch?.queries[0]?.failure?.provider).toBe("grep");
  });

  test("keeps earlier Grep hits when a later discovery query fails", async () => {
    const metadataQueries: string[] = [];
    const { fetch } = codeSearchFetch({
      grep: (args) => args.query === "OrderRefund"
        ? grepResponse([{ repository: "org/new", path: "src/refunds.ts" }])
        : new Response("unavailable", { status: 503 }),
      github: (url) => {
        const query = url.searchParams.get("q") ?? "";
        if (query.startsWith("repo:")) {
          metadataQueries.push(query);
          return json({ items: [searchItem("org/new", 300)] });
        }
        return json({ items: [] });
      },
    });
    const researcher = new GitHubResearcher({
      fetch,
      now: () => NOW,
      codeSearch: true,
      minimumPassing: 1,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund", "refund_amount"] });

    expect(metadataQueries).toEqual(["repo:org/new"]);
    expect(discovery.candidates.map((entry) => entry.fullName)).toEqual(["org/new"]);
    expect(discovery.candidates[0]?.codeMatches).toEqual([{ pattern: "OrderRefund", path: "src/refunds.ts" }]);
    expect(discovery.research.codeSearch?.queries.map((query) => query.status)).toEqual(["ok", "failed"]);
  });

  test("applies the 1 MB response cap to Grep responses", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => new Response("x".repeat(1_000_001), { headers: { "content-type": "text/event-stream" } }),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-large-grep"));
        return new Response("unexpected request", { status: 404 });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true });

    const resolution = await researcher.resolveShortlist([candidate("large-grep")], undefined, undefined, ["OrderRefund"]);

    expect(grepCalls).toHaveLength(1);
    expect(resolution.codeSearch?.queries[0]?.status).toBe("failed");
    expect(resolution.codeSearch?.queries[0]?.failure).toMatchObject({ provider: "grep", category: "size_limit", limitBytes: 1_000_000, attempts: 1 });
  });

  test("keeps redirect rejection, the timeout and cancellation on Grep requests", async () => {
    const scheduledTimeouts: number[] = [];
    const grepRedirects: Array<RequestRedirect | undefined> = [];
    const grepTimeouts: number[] = [];
    const controller = new AbortController();
    let grepStarted = false;
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledTimeouts.push(Number(timeout));
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof globalThis.setTimeout;
    try {
      const researcher = new GitHubResearcher({
        now: () => NOW,
        codeSearch: true,
        timeoutMs: 37,
        fetch: async (input, init) => {
          const url = requestUrl(input);
          if (url.origin === "https://mcp.grep.app") {
            grepStarted = true;
            grepRedirects.push(init?.redirect);
            grepTimeouts.push(scheduledTimeouts.at(-1) ?? -1);
            const requestSignal = init?.signal;
            controller.abort();
            return await new Promise<Response>((_resolve, reject) => {
              const abort = (): void => {
                const error = new Error("request aborted");
                error.name = "AbortError";
                reject(error);
              };
              if (requestSignal?.aborted) abort();
              else requestSignal?.addEventListener("abort", abort, { once: true });
            });
          }
          if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
          if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-protections"));
          return new Response("unexpected request", { status: 404 });
        },
      });
      const cancelled = await researcher.resolveShortlist([candidate("protections")], controller.signal, undefined, ["OrderRefund"]);
      expect(grepStarted).toBe(true);
      expect(grepRedirects).toEqual(["error"]);
      expect(grepTimeouts).toEqual([37]);
      expect(cancelled.codeSearch?.queries.map((query) => query.status)).toEqual(["skipped"]);
      expect(cancelled.gaps).toEqual([]);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("omits code matches when location finds nothing", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => grepResponse([]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-no-match"));
        return new Response("unexpected request", { status: 404 });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true });

    const resolution = await researcher.resolveShortlist([candidate("no-match")], undefined, undefined, ["OrderRefund"]);

    expect(grepCalls).toHaveLength(1);
    expect(resolution.snapshots[0]?.codeMatches).toBeUndefined();
    expect(resolution.codeSearch?.queries[0]).toMatchObject({ status: "ok", resultCount: 0 });
  });

  test("keeps GitHub candidates and stops code search after a Grep failure", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => new Response("unavailable", { status: 503 }),
      github: () => json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] }),
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund", "refund_amount"] });

    expect(discovery.candidates.map((entry) => entry.fullName)).toEqual(["org/refunds-a"]);
    expect(grepCalls).toHaveLength(2);
    expect(grepCalls.every((call) => call.arguments.query === "OrderRefund")).toBe(true);
    expect(discovery.research.codeSearch?.queries.map((query) => query.status)).toEqual(["failed", "skipped"]);
    expect(discovery.gaps).toEqual([{ kind: "search", material: false, message: "Grep search request failed after one retry: HTTP 503; code search stopped for this run." }]);
  });

  test("sends no Grep request unless code search is enabled", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => grepResponse([]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("refunds-a"));
        return json({ items: [searchItem("org/refunds-a", 250)] });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, minimumPassing: 1 });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });
    const resolution = await researcher.resolveShortlist(discovery.candidates, undefined, undefined, ["OrderRefund"]);

    expect(grepCalls).toHaveLength(0);
    expect(discovery.research.codeSearch).toBeUndefined();
    expect(resolution.snapshots).toHaveLength(1);
    expect(resolution.codeSearch).toBeUndefined();
    expect(resolution.snapshots[0]?.codeMatches).toBeUndefined();
  });

  test("locates pinned-tree files for a verified repository and reuses discovery matches", async () => {
    const tree = ["src/refund.ts", "src/refund_service.ts", "src/refund_line.ts", "src/plugin_only.ts", "tests/refund.test.ts", "docs/refunds.md", "LICENSE"];
    const { fetch, grepCalls } = codeSearchFetch({
      grep: (args) => args.query === "refund_amount"
        ? grepResponse([
          { repository: "org/repo-A", path: "src/refund_service.ts" },
          { repository: "org/repo-A-plugin", path: "src/plugin_only.ts" },
          { repository: "org/repo-A", path: "docs/refunds.md" },
          { repository: "org/repo-A", path: "src/missing.ts" },
        ])
        : args.query === "RefundStatus"
          ? grepResponse([{ repository: "ORG/REPO-A", path: "tests/refund.test.ts" }])
          : grepResponse([{ repository: "org/repo-A", path: "src/refund_line.ts" }]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT, commit: { committer: { date: "2026-06-01T00:00:00Z" } } });
        if (url.pathname.includes("/git/trees/")) return json({ sha: COMMIT, truncated: false, tree: tree.map((path) => ({ path, type: "blob", size: 10 })) });
        return new Response("unexpected request", { status: 404 });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true });
    const discovered = candidate("A", { codeMatches: [{ pattern: "OrderRefund", path: "src/refund.ts" }] });

    const resolution = await researcher.resolveShortlist([discovered], undefined, undefined, ["OrderRefund", "refund_amount", "RefundStatus", "refund_line"]);

    const ids = new Map(resolution.snapshots[0]!.files.map((file) => [file.path, file.id]));
    expect(resolution.snapshots[0]?.codeMatches).toEqual([
      { fileId: ids.get("src/refund.ts")!, path: "src/refund.ts", patterns: ["OrderRefund"] },
      { fileId: ids.get("src/refund_service.ts")!, path: "src/refund_service.ts", patterns: ["refund_amount"] },
      { fileId: ids.get("tests/refund.test.ts")!, path: "tests/refund.test.ts", patterns: ["RefundStatus"] },
    ]);
    expect(grepCalls.map((call) => call.arguments)).toEqual([
      { query: "refund_amount", repo: "org/repo-A" },
      { query: "RefundStatus", repo: "org/repo-A" },
    ]);
    expect(resolution.codeSearch?.queries.map((query) => [query.purpose, query.repository, query.status])).toEqual([
      ["location", "org/repo-A", "ok"],
      ["location", "org/repo-A", "ok"],
    ]);
  });

  test("records location queries beyond the run-wide code-search budget as skipped", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: (args) => args.repo
        ? grepResponse([{ repository: "org/refunds-a", path: "src/handler.ts" }])
        : args.query === "OrderRefund"
          ? grepResponse([{ repository: "org/refunds-a", path: "src/refund.ts" }])
          : grepResponse([]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("refunds-a"));
        return json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, maxCodeSearchRequests: 3, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });
    const patterns = ["OrderRefund", "refund_amount", "handler", "RefundLine"];

    const discovery = await researcher.discover({ ...material, codePatterns: patterns });
    const resolution = await researcher.resolveShortlist(discovery.candidates, undefined, undefined, patterns);

    expect(grepCalls.map((call) => [call.arguments.query, call.arguments.repo ?? null])).toEqual([
      ["OrderRefund", null],
      ["refund_amount", null],
      ["handler", null],
    ]);
    expect(discovery.research.codeSearch?.requests).toBe(3);
    expect(resolution.codeSearch?.queries.map((query) => [query.query, query.status])).toEqual([
      ["refund_amount", "skipped"],
      ["handler", "skipped"],
    ]);
  });

  test("uses at most three patterns and four unseen repositories in discovery", async () => {
    const metadataQueries: string[] = [];
    const { fetch, grepCalls } = codeSearchFetch({
      grep: (args) => args.query === "OrderRefund"
        ? grepResponse(["one", "two", "three", "four", "five"].map((name) => ({ repository: `org/${name}`, path: "src/refund.ts" })))
        : grepResponse([]),
      github: (url) => {
        const query = url.searchParams.get("q") ?? "";
        if (query.startsWith("repo:")) {
          metadataQueries.push(query);
          return json({ items: requestedRepositories(query).map((name) => searchItem(name, 100)) });
        }
        return json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    await researcher.discover({ ...material, codePatterns: ["OrderRefund", "refund_amount", "RefundLine", "refund_reason"] });

    expect(grepCalls.map((call) => call.arguments.query)).toEqual(["OrderRefund", "refund_amount", "RefundLine"]);
    expect(metadataQueries).toEqual(["repo:org/five repo:org/four repo:org/one repo:org/three"]);

    metadataQueries.length = 0;
    grepCalls.length = 0;
    const twoCandidateResearcher = new GitHubResearcher({
      fetch,
      now: () => NOW,
      codeSearch: true,
      minimumPassing: 1,
      maxCodeSearchCandidates: 2,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
    });
    await twoCandidateResearcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    expect(grepCalls.map((call) => call.arguments.query)).toEqual(["OrderRefund"]);
    expect(metadataQueries).toEqual(["repo:org/five repo:org/four"]);
  });

  test("drops Grep hits with invalid repository names or unsafe paths before the metadata query", async () => {
    const metadataQueries: string[] = [];
    const { fetch } = codeSearchFetch({
      grep: () => grepResponse([
        { repository: "evil/repo/../x", path: "src/a.ts" },
        { repository: "org/unsafe", path: "../../etc/passwd" },
        { repository: "org/refunds-b", path: "app/models/refund.py" },
      ]),
      github: (url) => {
        const query = url.searchParams.get("q") ?? "";
        if (query.startsWith("repo:")) {
          metadataQueries.push(query);
          return json({ items: requestedRepositories(query).map((name) => searchItem(name, 100)) });
        }
        return json({ items: [] });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    expect(metadataQueries).toEqual(["repo:org/refunds-b"]);
    expect(discovery.research.codeSearch?.repositoriesMatched).toBe(1);
    expect(discovery.candidates.map((entry) => entry.fullName)).toEqual(["org/refunds-b"]);
  });

  test("does not screen code-search repositories when GitHub search is rate limited", async () => {
    const metadataQueries: string[] = [];
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => grepResponse([{ repository: "org/refunds-b", path: "app/models/refund.py" }]),
      github: (url) => {
        const query = url.searchParams.get("q") ?? "";
        if (query.startsWith("repo:")) metadataQueries.push(query);
        return new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    expect(grepCalls).toHaveLength(1);
    expect(metadataQueries).toEqual([]);
    expect(discovery.gaps.map((gap) => gap.message)).toContain("GitHub search was rate limited, so 1 code-search repositories were not screened.");
  });

  test("keeps discovery results when the code-search metadata request fails", async () => {
    const { fetch } = codeSearchFetch({
      grep: () => grepResponse([{ repository: "org/refunds-b", path: "app/models/refund.py" }]),
      github: (url) => (url.searchParams.get("q") ?? "").startsWith("repo:")
        ? new Response("server error", { status: 500 })
        : json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] }),
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    expect(discovery.candidates.map((entry) => entry.fullName)).toEqual(["org/refunds-a"]);
    expect(discovery.research.codeSearch?.metadataRequests).toBe(2);
    expect(discovery.gaps).toEqual([{ kind: "search", material: false, message: "GitHub search request failed after one retry: HTTP 500 (code-search repository metadata)." }]);
  });

  test("stops code search without a retry when Grep rate limits", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => new Response("slow down", { status: 429 }),
      github: () => json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] }),
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund", "refund_amount"] });

    expect(grepCalls).toHaveLength(1);
    expect(discovery.research.codeSearch?.queries.map((query) => query.status)).toEqual(["rate_limited", "skipped"]);
    expect(discovery.gaps).toEqual([{ kind: "search", material: false, message: "Grep search request failed: rate limit reached; code search stopped for this run." }]);
  });

  test("treats an unparseable Grep body as a failure and stops code search", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => new Response("event: message\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
      github: () => json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] }),
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund", "refund_amount"] });

    expect(grepCalls).toHaveLength(1);
    expect(discovery.research.codeSearch?.queries.map((query) => query.status)).toEqual(["failed", "skipped"]);
    expect(discovery.research.codeSearch?.queries[0]?.failure).toEqual({ provider: "grep", endpoint: "search", category: "invalid_response", responseProblem: "not_json_rpc", contentType: "text/event-stream", attempts: 1, retryRefused: false });
    expect(discovery.gaps).toEqual([{ kind: "search", material: false, message: "Grep search request failed: response had an unexpected shape (no readable JSON-RPC response; content type text/event-stream); code search stopped for this run." }]);
  });

  test("records why a Grep body failed, and none of its text, in the query record and the gap", async () => {
    const marker = "MARKER_VALUE_0123456789";
    const event = (payload: Record<string, unknown>): string => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload })}\n\n`;
    const cases: Array<{ body: string; contentType: string; failure: Partial<RequestFailure>; reason: string }> = [
      { body: `<html>${marker}</html>`, contentType: "text/html; charset=utf-8", failure: { responseProblem: "not_json_rpc", contentType: "text/html" }, reason: "no readable JSON-RPC response; content type text/html" },
      { body: event({ error: { code: -32603, message: marker } }), contentType: "text/event-stream", failure: { responseProblem: "rpc_error", rpcErrorCode: -32603 }, reason: "JSON-RPC error -32603" },
      { body: event({ result: { isError: true, content: [{ type: "text", text: marker }] } }), contentType: "text/event-stream", failure: { responseProblem: "tool_error" }, reason: "the search tool reported an error" },
      { body: event({ result: { content: [{ type: "text", text: marker }] } }), contentType: "text/event-stream", failure: { responseProblem: "no_hits" }, reason: "the result had neither a hit nor the no-results message" },
    ];

    for (const entry of cases) {
      const { fetch, grepCalls } = codeSearchFetch({
        grep: () => new Response(entry.body, { status: 200, headers: { "content-type": entry.contentType } }),
        github: () => json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] }),
      });
      const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

      const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund", "refund_amount"] });

      expect(grepCalls).toHaveLength(1);
      expect(discovery.research.codeSearch?.queries.map((query) => query.status)).toEqual(["failed", "skipped"]);
      expect(discovery.research.codeSearch?.queries[0]?.failure).toEqual({ provider: "grep", endpoint: "search", category: "invalid_response", ...entry.failure, attempts: 1, retryRefused: false });
      expect(discovery.gaps).toEqual([{ kind: "search", material: false, message: `Grep search request failed: response had an unexpected shape (${entry.reason}); code search stopped for this run.` }]);
      expect(JSON.stringify(discovery)).not.toContain(marker);
    }
  });

  test("keeps at most 20 code matches for one repository", async () => {
    const paths = Array.from({ length: 22 }, (_, index) => `src/refund${String(index).padStart(2, "0")}.ts`);
    const { fetch } = codeSearchFetch({
      grep: () => grepResponse([]),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json({ sha: COMMIT, truncated: false, tree: [...paths, "tests/refund.test.ts", "LICENSE"].map((path) => ({ path, type: "blob", size: 10 })) });
        return new Response("unexpected request", { status: 404 });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true });
    const discovered = candidate("A", { codeMatches: paths.map((path) => ({ pattern: "OrderRefund", path })) });

    const resolution = await researcher.resolveShortlist([discovered], undefined, undefined, ["OrderRefund"]);

    expect(resolution.snapshots[0]?.codeMatches).toHaveLength(20);
    expect(resolution.snapshots[0]?.codeMatches?.[19]?.path).toBe("src/refund19.ts");
  });

  test("sends no location query for a GitLab repository or a repository that failed the tree checks", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => grepResponse([{ repository: "org/repo-A", path: "src/handler.ts" }]),
      github: (url) => {
        if (url.pathname === "/repos/org/repo-A/commits/main") return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("repo-A", { tests: false }));
        if (url.pathname === "/api/v4/projects/42/repository/commits/main") return json({ id: COMMIT });
        if (url.pathname === "/api/v4/projects/42/repository/tree") {
          return json([
            { type: "blob", path: "src/handler.ts", size: 23 },
            { type: "blob", path: "tests/handler.test.ts", size: 30 },
            { type: "blob", path: "LICENSE", size: 18 },
          ], { "x-next-page": "" });
        }
        return new Response("unexpected request", { status: 404 });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true });
    const gitlab = candidate("G", { provider: "gitlab", fullName: "group/refunds", providerProjectId: "42", webUrl: "https://gitlab.com/group/refunds" });

    const resolution = await researcher.resolveShortlist([candidate("A"), gitlab], undefined, undefined, ["handler"]);

    expect(resolution.snapshots.map((snapshot) => snapshot.candidate.fullName)).toEqual(["group/refunds"]);
    expect(resolution.excluded.map((entry) => entry.candidate.fullName)).toEqual(["org/repo-A"]);
    expect(grepCalls).toHaveLength(0);
    expect(resolution.codeSearch).toBeUndefined();
  });

  test("stops location queries after a discovery failure", async () => {
    const { fetch, grepCalls } = codeSearchFetch({
      grep: () => new Response("unavailable", { status: 503 }),
      github: (url) => {
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json(treeFor("refunds-a"));
        return json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] });
      },
    });
    const researcher = new GitHubResearcher({ fetch, now: () => NOW, codeSearch: true, minimumPassing: 1, searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }] });

    const discovery = await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });
    const resolution = await researcher.resolveShortlist(discovery.candidates, undefined, undefined, ["OrderRefund", "handler"]);

    expect(grepCalls).toHaveLength(2);
    expect(resolution.codeSearch?.queries.map((query) => query.status)).toEqual(["skipped", "skipped"]);
    expect(resolution.gaps).toEqual([]);
  });

  test("keeps GET request headers and init unchanged", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      codeSearch: true,
      githubToken: "SENTINEL_GITHUB_c0de5ea7c4b1e2d3",
      minimumPassing: 1,
      searchTiers: [{ tier: 0, minStars: 200, maxMonthsSincePush: 12 }],
      fetch: async (input, init) => {
        const url = requestUrl(input);
        requests.push({ url, init });
        if (url.origin === "https://mcp.grep.app") return grepResponse([]);
        return json({ items: [searchItem("org/refunds-a", 250, "Refund workflow service")] });
      },
    });

    await researcher.discover({ ...material, codePatterns: ["OrderRefund"] });

    const get = requests.find((entry) => entry.url.origin === "https://api.github.com")!;
    expect(get.init?.method).toBeUndefined();
    expect(get.init?.body).toBeUndefined();
    expect(get.init?.redirect).toBe("error");
    expect(get.init?.headers).toEqual({
      "User-Agent": "unshit/0.1",
      Accept: "application/json, text/plain, */*",
      Authorization: "Bearer SENTINEL_GITHUB_c0de5ea7c4b1e2d3",
    });
    expect(requests.find((entry) => entry.url.origin === "https://mcp.grep.app")?.init?.method).toBe("POST");
  });
});

describe("discovery material allocation", () => {
  const twoTopics = { phrases: ["refund workflow", "refund request"], topics: ["refunds", "payments"], omitted: ['topic "billing" (over the two-topic limit)'] };

  test("keeps nine GitHub search requests with a second topic and records the query past the budget as skipped", async () => {
    const calls: URL[] = [];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      minimumPassing: 20,
      fetch: async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        return json({ items: [] });
      },
    });
    const result = await researcher.discover(twoTopics);
    expect(calls.filter((url) => url.origin === "https://api.github.com")).toHaveLength(9);
    expect(result.research.searchRequests.github).toBe(9);
    const github = result.research.queries.filter((query) => query.provider === "github");
    expect(github.map((query) => `${query.tier} ${query.status} ${query.query.split(" ")[0]}`)).toEqual([
      "0 ok refund", "0 ok refund", "0 ok topic:refunds", "0 ok topic:payments",
      "1 ok refund", "1 ok refund", "1 ok topic:refunds",
      "2 ok refund", "2 ok refund", "2 skipped topic:refunds",
    ]);
  });

  test("records brief material that no query searched as one informational search gap", async () => {
    const items = [1, 2, 3, 4].map((index) => searchItem(`org/refund-${index}`, 300));
    const researcher = new GitHubResearcher({ now: () => NOW, fetch: async () => json({ items }) });
    const result = await researcher.discover(twoTopics);
    expect(result.research.searchRequests.github).toBe(4);
    const note = { kind: "search" as const, material: false, message: 'Brief material not searched on GitHub: topic "billing" (over the two-topic limit).' };
    expect(result.gaps).toEqual([note]);

    // With no candidate at all, the note stays informational and the material no-match gap is still added.
    const empty = await new GitHubResearcher({ now: () => NOW, fetch: async () => json({ items: [] }) }).discover(twoTopics);
    expect(empty.gaps).toEqual([note, { kind: "search", material: true, message: "No public repository matched the host-built queries." }]);
  });
});

describe("commit-pinned reads", () => {
  test("reads trees and sources at the resolved SHA after the default branch moves", async () => {
    const pinnedFiles = ["src/handler.ts", "tests/handler.test.ts", "LICENSE"];
    const researcher = new GitHubResearcher({
      now: () => NOW,
      fetch: async (input) => {
        const url = requestUrl(input);
        // After the commit read, the branch names a commit with no tests and different source.
        const pinned = url.pathname.includes(COMMIT) || url.searchParams.get("ref") === COMMIT;
        if (url.pathname.endsWith("/commits/main")) return json({ sha: COMMIT, id: COMMIT });
        if (url.pathname.includes("/git/trees/")) return json({ truncated: false, tree: (pinned ? pinnedFiles : ["src/handler.ts"]).map((path) => ({ path, type: "blob", size: 7 })) });
        if (url.pathname.endsWith("/repository/tree")) return json((pinned ? pinnedFiles : ["src/handler.ts"]).map((path) => ({ path, type: "blob" })));
        if (url.origin === "https://raw.githubusercontent.com" || url.pathname.endsWith("/raw")) return new Response(pinned ? "pinned\n" : "moved\n");
        return new Response("unexpected request", { status: 404 });
      },
    });
    const resolution = await researcher.resolveShortlist([
      candidate("x"),
      candidate("g", { provider: "gitlab", fullName: "org/repo-g", webUrl: "https://gitlab.com/org/repo-g", providerProjectId: "42" }),
    ]);
    expect(resolution.snapshots.map((snapshot) => `${snapshot.candidate.provider}@${snapshot.commitSha}`)).toEqual([`github@${COMMIT}`, `gitlab@${COMMIT}`]);
    for (const snapshot of resolution.snapshots) {
      expect(new TextDecoder().decode(await researcher.fetchSource(snapshot, "src/handler.ts"))).toBe("pinned\n");
    }
  });
});
