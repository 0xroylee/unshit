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

describe("GitHub and GitLab repository research", () => {
  test("normalizes each failure field from a single read", () => {
    const cases: Array<{ field: keyof RequestFailure; base: RequestFailure }> = [
      { field: "provider", base: { provider: "github", endpoint: "search", category: "network", attempts: 1, retryRefused: false } },
      { field: "endpoint", base: { provider: "github", endpoint: "search", category: "network", attempts: 1, retryRefused: false } },
      { field: "category", base: { provider: "github", endpoint: "search", category: "network", attempts: 1, retryRefused: false } },
      { field: "status", base: { provider: "github", endpoint: "search", category: "http_status", status: 503, attempts: 1, retryRefused: false } },
      { field: "limitBytes", base: { provider: "github", endpoint: "source", category: "size_limit", limitBytes: 1_000_001, attempts: 1, retryRefused: false } },
      { field: "page", base: { provider: "gitlab", endpoint: "tree", category: "network", page: 2, attempts: 1, retryRefused: false } },
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
    expect(thrown.failure).toMatchObject({ provider: "github", endpoint: "source", category: "size_limit", limitBytes: 1_000_000, attempts: 2 });
    expect(thrown.message).toContain("1 MB source limit");
    expect(urls.filter((url) => url.origin === "https://raw.githubusercontent.com" && url.pathname.endsWith("/src/large.ts"))).toHaveLength(2);
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
