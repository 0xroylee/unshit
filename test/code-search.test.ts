import { describe, expect, test } from "bun:test";
import {
  emptyCodeSearchSummary,
  grepRequestBody,
  isGitHubRepositoryName,
  mergeCodeSearchSummaries,
  parseGrepResponse,
  rankCodeSearchRepositories,
  repositoryMetadataQuery,
} from "../src/code-search.ts";
import { ProviderRequestError, describeRequestFailure } from "../src/request-failure.ts";
import type { CodeSearchSummary, GrepResponseProblem, RequestFailure } from "../src/types.ts";

describe("Grep request failures", () => {
  test("keeps the grep provider and labels it in host messages", () => {
    const error = new ProviderRequestError({ provider: "grep", endpoint: "search", category: "http_status", status: 503, attempts: 2, retryRefused: false });
    expect(error.failure.provider).toBe("grep");
    expect(describeRequestFailure(error.failure)).toBe("Grep search request failed after one retry: HTTP 503");
    expect(describeRequestFailure({ provider: "grep", endpoint: "search", category: "rate_limit", attempts: 1, retryRefused: false })).toBe("Grep search request failed: rate limit reached");
  });

  test("names the check that a Grep body failed, with its media type or JSON-RPC error code", () => {
    const failure = (fields: Partial<RequestFailure>): RequestFailure => ({ provider: "grep", endpoint: "search", category: "invalid_response", attempts: 1, retryRefused: false, ...fields });
    const shape = "Grep search request failed: response had an unexpected shape";

    expect(describeRequestFailure(failure({ responseProblem: "not_json_rpc", contentType: "Text/HTML; charset=utf-8" }))).toBe(`${shape} (no readable JSON-RPC response; content type text/html)`);
    expect(describeRequestFailure(failure({ responseProblem: "not_json_rpc" }))).toBe(`${shape} (no readable JSON-RPC response)`);
    expect(describeRequestFailure(failure({ responseProblem: "rpc_error", rpcErrorCode: -32000 }))).toBe(`${shape} (JSON-RPC error -32000)`);
    expect(describeRequestFailure(failure({ responseProblem: "rpc_error" }))).toBe(`${shape} (JSON-RPC error)`);
    expect(describeRequestFailure(failure({ responseProblem: "tool_error" }))).toBe(`${shape} (the search tool reported an error)`);
    expect(describeRequestFailure(failure({ responseProblem: "no_hits" }))).toBe(`${shape} (the result had neither a hit nor the no-results message)`);
    expect(describeRequestFailure(failure({}))).toBe(shape);
  });

  test("keeps the Grep response fields only on a Grep invalid_response and only with their own check", () => {
    const failure = (fields: Partial<RequestFailure>): RequestFailure => ({ provider: "grep", endpoint: "search", category: "invalid_response", attempts: 1, retryRefused: false, ...fields });
    const kept = (fields: Partial<RequestFailure>): RequestFailure => new ProviderRequestError(failure(fields)).failure;

    expect(kept({ responseProblem: "not_json_rpc", contentType: "text/html; charset=utf-8", rpcErrorCode: 5 })).toEqual(failure({ responseProblem: "not_json_rpc", contentType: "text/html" }));
    expect(kept({ responseProblem: "rpc_error", contentType: "text/html", rpcErrorCode: -32603 })).toEqual(failure({ responseProblem: "rpc_error", rpcErrorCode: -32603 }));
    expect(kept({ responseProblem: "rpc_error", rpcErrorCode: 1.5 })).toEqual(failure({ responseProblem: "rpc_error" }));
    expect(kept({ responseProblem: "rpc_error", rpcErrorCode: 2 ** 53 })).toEqual(failure({ responseProblem: "rpc_error" }));
    expect(kept({ responseProblem: "rpc_error", rpcErrorCode: -(2 ** 53 - 1) })).toEqual(failure({ responseProblem: "rpc_error", rpcErrorCode: -(2 ** 53 - 1) }));
    expect(kept({ responseProblem: "not_json_rpc", contentType: "text/html\r\nx-injected: 1" })).toEqual(failure({ responseProblem: "not_json_rpc" }));
    expect(kept({ responseProblem: "not_json_rpc", contentType: "<b>text/html</b>" })).toEqual(failure({ responseProblem: "not_json_rpc" }));
    expect(kept({ responseProblem: "invalid" as GrepResponseProblem, contentType: "text/html" })).toEqual(failure({}));
    expect(kept({ provider: "github", responseProblem: "tool_error" })).toEqual(failure({ provider: "github" }));
    expect(kept({ category: "http_status", status: 503, responseProblem: "tool_error" })).toEqual(failure({ category: "http_status", status: 503 }));
  });
});

function grepText(repository: string, path: string, snippet = "class OrderRefund:\n    pass"): string {
  return `Repository: ${repository}\nPath: ${path}\nURL: https://github.com/${repository}/blob/main/${path}\nLicense: MIT\n\nSnippets:\n--- Snippet 1 (Line 3) ---\n${snippet}\n`;
}

function grepEvent(content: Array<{ type: string; text: string }>, extra: Record<string, unknown> = {}): string {
  return `event: message\ndata: ${JSON.stringify({ result: { content, ...extra }, jsonrpc: "2.0", id: 1 })}\n\n`;
}

describe("Grep response parsing", () => {
  test("builds a searchGitHub tools/call body with an optional repository filter", () => {
    expect(JSON.parse(grepRequestBody(7, { query: "OrderRefund" }))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "searchGitHub", arguments: { query: "OrderRefund" } },
    });
    expect(JSON.parse(grepRequestBody(8, { query: "refund", repo: "org/shop" })).params.arguments).toEqual({ query: "refund", repo: "org/shop" });
  });

  test("reads repository and path from each result header in an SSE response", () => {
    const body = grepEvent([
      { type: "text", text: grepText("saleor/saleor", "saleor/order/actions.py") },
      { type: "text", text: grepText("org/shop", "src/refunds.ts", "// Repository: evil/injected\nPath: ../../etc/passwd") },
      { type: "text", text: "URL: https://github.com/org/headerless/blob/main/a.ts\nLicense: MIT\n\nSnippets:\n--- Snippet 1 (Line 1) ---\nRepository: evil/injected\nPath: src/evil.ts\n" },
    ]);
    expect(parseGrepResponse(body, "text/event-stream")).toEqual({ hits: [
      { repository: "saleor/saleor", path: "saleor/order/actions.py" },
      { repository: "org/shop", path: "src/refunds.ts" },
    ] });
  });

  test("treats the no-results message as an empty result and accepts a JSON body", () => {
    const empty = grepEvent([{ type: "text", text: "No results found for your query.\n\nIMPORTANT: This tool searches for literal code patterns." }]);
    expect(parseGrepResponse(empty, "text/event-stream")).toEqual({ hits: [] });
    const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: grepText("org/shop", "src/a.ts") }] } });
    expect(parseGrepResponse(json, "application/json")).toEqual({ hits: [{ repository: "org/shop", path: "src/a.ts" }] });
  });

  test("rejects JSON-RPC errors, tool errors and malformed bodies, and names the check that each failed", () => {
    expect(parseGrepResponse(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } })}\n\n`, "text/event-stream")).toEqual({ problem: "rpc_error", rpcErrorCode: -32000 });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "busy" } }), "application/json")).toEqual({ problem: "rpc_error" });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 2 ** 53 } }), "application/json")).toEqual({ problem: "rpc_error" });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 2 ** 53 - 1 } }), "application/json")).toEqual({ problem: "rpc_error", rpcErrorCode: 2 ** 53 - 1 });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, error: "busy" }), "application/json")).toEqual({ problem: "rpc_error" });
    expect(parseGrepResponse(grepEvent([{ type: "text", text: "failure" }], { isError: true }), "text/event-stream")).toEqual({ problem: "tool_error" });
    expect(parseGrepResponse(grepEvent([{ type: "text", text: grepText("org/shop", "src/a.ts") }], { isError: true }), "text/event-stream")).toEqual({ problem: "tool_error" });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true } }), "application/json")).toEqual({ problem: "tool_error" });
    expect(parseGrepResponse("not json", "application/json")).toEqual({ problem: "not_json_rpc" });
    expect(parseGrepResponse("event: message\n\n", "text/event-stream")).toEqual({ problem: "not_json_rpc" });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1 }), "application/json")).toEqual({ problem: "not_json_rpc" });
    expect(parseGrepResponse("[]", "application/json")).toEqual({ problem: "not_json_rpc" });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "done" }), "application/json")).toEqual({ problem: "no_hits" });
    expect(parseGrepResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), "application/json")).toEqual({ problem: "no_hits" });
  });

  test("keeps at most 20 hits and drops overlong repository and path values", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ type: "text", text: grepText("org/shop", `src/file${index}.ts`) }));
    const parsed = parseGrepResponse(grepEvent(many), "text/event-stream");
    const hits = "hits" in parsed ? parsed.hits : [];
    expect(hits).toHaveLength(20);
    expect(hits[19]).toEqual({ repository: "org/shop", path: "src/file19.ts" });
    const longPath = `src/${"a".repeat(596)}`;
    expect(longPath).toHaveLength(600);
    const body = grepEvent([
      { type: "text", text: grepText(`org/${"r".repeat(198)}`, "src/too-long-name.ts") },
      { type: "text", text: grepText("org/shop", `${longPath}x`) },
      { type: "text", text: grepText("org/shop", longPath) },
    ]);
    expect(parseGrepResponse(body, "text/event-stream")).toEqual({ hits: [{ repository: "org/shop", path: longPath }] });
  });

  test("reads the first SSE data line that carries a JSON-RPC result", () => {
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    const result = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: grepText("org/shop", "src/a.ts") }] } });
    const body = `event: message\ndata: ${notification}\n\nevent: message\ndata: ${result}\n\n`;
    expect(parseGrepResponse(body, "text/event-stream")).toEqual({ hits: [{ repository: "org/shop", path: "src/a.ts" }] });
  });

  test("ignores non-text items and uses the first result-bearing SSE event", () => {
    const imageWithHeaders = grepText("org/fabricated", "src/image.ts");
    const first = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [
        { type: "image", text: imageWithHeaders },
        { type: "text", text: grepText("org/first", "src/first.ts") },
      ] },
    });
    const later = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: grepText("org/last", "src/last.ts") }] },
    });
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    const body = `event: message\ndata: ${notification}\n\nevent: message\ndata: ${first}\n\nevent: message\ndata: ${later}\n\n`;

    expect(parseGrepResponse(body, "text/event-stream")).toEqual({ hits: [{ repository: "org/first", path: "src/first.ts" }] });
  });

  test("never throws on wrong input shapes", () => {
    expect(JSON.parse(grepRequestBody(1, null as unknown as { query: string })).params.arguments).toEqual({ query: "" });
    expect(parseGrepResponse(null as unknown as string, "application/json")).toEqual({ problem: "not_json_rpc" });
    expect(isGitHubRepositoryName(null as unknown as string)).toBe(false);
    expect(rankCodeSearchRepositories(null as unknown as Array<{ pattern: string; hit: { repository: string; path: string } }>)).toEqual([]);
    expect(repositoryMetadataQuery(null as unknown as string[])).toEqual({ query: "", included: [] });

    const malformedFirst = { ...emptyCodeSearchSummary(4), queries: undefined } as unknown as CodeSearchSummary;
    expect(mergeCodeSearchSummaries(malformedFirst, emptyCodeSearchSummary(4))).toEqual(emptyCodeSearchSummary(0));
    expect(emptyCodeSearchSummary(Number.NaN)).toEqual(emptyCodeSearchSummary(0));
  });

  test("treats a successful body without hits or the no-results message as malformed", () => {
    expect(parseGrepResponse(grepEvent([]), "text/event-stream")).toEqual({ problem: "no_hits" });
    expect(parseGrepResponse(grepEvent([{ type: "text", text: "Nothing matched this pattern." }]), "text/event-stream")).toEqual({ problem: "no_hits" });
  });
});

describe("code-search repository ranking", () => {
  test("ranks repositories by distinct patterns and ignores example and documentation paths", () => {
    const ranked = rankCodeSearchRepositories([
      { pattern: "OrderRefund", hit: { repository: "org/shop", path: "src/refunds.ts" } },
      { pattern: "OrderRefund", hit: { repository: "org/shop", path: "src/refunds.ts" } },
      { pattern: "refund_amount", hit: { repository: "Org/Shop", path: "src/payments.ts" } },
      { pattern: "OrderRefund", hit: { repository: "org/other", path: "lib/refund.rb" } },
      { pattern: "OrderRefund", hit: { repository: "org/other", path: "lib/refund_line.rb" } },
      { pattern: "OrderRefund", hit: { repository: "org/more-matches", path: "src/refund_a.ts" } },
      { pattern: "OrderRefund", hit: { repository: "org/more-matches", path: "src/refund_b.ts" } },
      { pattern: "OrderRefund", hit: { repository: "org/more-matches", path: "src/refund_c.ts" } },
      { pattern: "OrderRefund", hit: { repository: "microsoft/semantic-kernel", path: "python/samples/handoff.py" } },
      { pattern: "OrderRefund", hit: { repository: "org/docs-only", path: "docs/refunds.md" } },
    ]);
    expect(ranked.map((entry) => entry.repository)).toEqual(["org/shop", "org/more-matches", "org/other"]);
    expect(ranked[1]!.matches).toHaveLength(3);
    expect(ranked[1]!.matches).toEqual([
      { pattern: "OrderRefund", path: "src/refund_a.ts" },
      { pattern: "OrderRefund", path: "src/refund_b.ts" },
      { pattern: "OrderRefund", path: "src/refund_c.ts" },
    ]);
    expect(ranked[0]!.matches).toEqual([
      { pattern: "OrderRefund", path: "src/refunds.ts" },
      { pattern: "refund_amount", path: "src/payments.ts" },
    ]);
  });

  test("keeps at most 20 matches for one repository", () => {
    const hits = Array.from({ length: 25 }, (_, index) => ({ pattern: "OrderRefund", hit: { repository: "org/shop", path: `src/refund${index}.ts` } }));
    const ranked = rankCodeSearchRepositories(hits);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.matches).toHaveLength(20);
    expect(ranked[0]!.matches[19]).toEqual({ pattern: "OrderRefund", path: "src/refund19.ts" });
  });

  test("builds one GitHub search query for several repositories within 256 characters", () => {
    expect(repositoryMetadataQuery(["org/shop", "org/other"])).toEqual({ query: "repo:org/shop repo:org/other", included: ["org/shop", "org/other"] });
    const long = Array.from({ length: 12 }, (_, index) => `organization-${index}/repository-name-${index}`);
    const result = repositoryMetadataQuery(long);
    expect(result.query.length).toBeLessThanOrEqual(256);
    expect(result.included.length).toBeLessThan(long.length);
    expect(result.query).toBe(result.included.map((name) => `repo:${name}`).join(" "));
    expect(repositoryMetadataQuery(["org/shop", "org/other", "x/y"], 20)).toEqual({ query: "repo:org/shop", included: ["org/shop"] });
    const exact = [`${"a".repeat(20)}/${"b".repeat(100)}`, `${"c".repeat(23)}/${"d".repeat(100)}`];
    expect(`repo:${exact[0]} repo:${exact[1]}`).toHaveLength(256);
    expect(repositoryMetadataQuery(exact).included).toEqual(exact);
    expect(repositoryMetadataQuery([...exact, "e/f"]).included).toEqual(exact);
  });

  test("accepts only owner/name GitHub repository names", () => {
    expect(isGitHubRepositoryName("saleor/saleor")).toBe(true);
    expect(isGitHubRepositoryName("alfio-event/alf.io")).toBe(true);
    for (const value of ["saleor", "a/b/c", "../x", "org/..", "org/repo stars:>5", "org/repo\nrepo:x/y", `${"a".repeat(101)}/repo`, `org/${"r".repeat(101)}`]) {
      expect(isGitHubRepositoryName(value)).toBe(false);
    }
  });

  test("merges discovery and location summaries", () => {
    const discovery = {
      ...emptyCodeSearchSummary(12),
      requests: 2,
      repositoriesMatched: 3,
      repositoriesScreened: 1,
      metadataRequests: 1,
      queries: [{ provider: "grep" as const, purpose: "discovery" as const, query: "OrderRefund", status: "ok" as const, resultCount: 10 }],
    };
    const location = {
      ...emptyCodeSearchSummary(12),
      requests: 1,
      repositoriesMatched: 2,
      queries: [{ provider: "grep" as const, purpose: "location" as const, query: "refund", repository: "org/shop", status: "ok" as const, resultCount: 4 }],
    };
    expect(mergeCodeSearchSummaries(undefined, location)).toEqual(location);
    expect(mergeCodeSearchSummaries(discovery, location)).toEqual({
      queries: [...discovery.queries, ...location.queries],
      requests: 3,
      budget: 12,
      repositoriesMatched: 5,
      repositoriesScreened: 1,
      metadataRequests: 1,
    });
    expect(mergeCodeSearchSummaries(discovery, { queries: undefined } as unknown as CodeSearchSummary)).toEqual(discovery);
  });
});
