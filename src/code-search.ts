import { isDemoPath } from "./file-ranking.ts";
import type { CodePatternMatch, CodeSearchSummary, GrepResponseProblem } from "./types.ts";

export const GREP_ENDPOINT = "https://mcp.grep.app";

export interface CodeSearchQuery {
  query: string;
  repo?: string;
}

export interface CodeSearchHit {
  repository: string;
  path: string;
}

export interface RankedCodeSearchRepository {
  repository: string;
  matches: CodePatternMatch[];
}

export function grepRequestBody(id: number, query: CodeSearchQuery): string {
  let queryText = "";
  let repository: string | undefined;
  try {
    if (typeof query?.query === "string") queryText = query.query;
    if (typeof query?.repo === "string" && query.repo.length > 0) repository = query.repo;
  } catch {
    queryText = "";
    repository = undefined;
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id: Number.isSafeInteger(id) ? id : 0,
    method: "tools/call",
    params: {
      name: "searchGitHub",
      arguments: { query: queryText, ...(repository ? { repo: repository } : {}) },
    },
  });
}

export type GrepResponse = { hits: CodeSearchHit[] } | { problem: GrepResponseProblem; rpcErrorCode?: number };

// Returns the hits of a successful searchGitHub result, or the first check that the body failed.
export function parseGrepResponse(text: string, contentType: string | null): GrepResponse {
  try {
    if (typeof text !== "string") return { problem: "not_json_rpc" };
    const payload = (typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream")) ? eventPayload(text) : jsonValue(text);
    if (!isRecord(payload) || !("result" in payload || "error" in payload)) return { problem: "not_json_rpc" };
    if ("error" in payload) {
      const code = isRecord(payload.error) ? payload.error.code : undefined;
      return Number.isSafeInteger(code) ? { problem: "rpc_error", rpcErrorCode: code as number } : { problem: "rpc_error" };
    }
    const result = payload.result;
    if (isRecord(result) && result.isError === true) return { problem: "tool_error" };
    if (!isRecord(result) || !Array.isArray(result.content)) return { problem: "no_hits" };
    const hits: CodeSearchHit[] = [];
    let noResults = false;
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      if (item.text.trimStart().startsWith("No results found for your query.")) {
        noResults = true;
        continue;
      }
      // Snippets are untrusted source text, so the fields come only from the header above them.
      const header = item.text.split(/\r?\n\s*Snippets:/)[0] ?? "";
      const repository = /^Repository: *(\S+) *$/m.exec(header)?.[1];
      const path = /^Path: *(.+?) *$/m.exec(header)?.[1];
      if (!repository || !path || repository.length > 201 || path.length > 600) continue;
      hits.push({ repository, path });
      if (hits.length === 20) break;
    }
    return hits.length > 0 || noResults ? { hits } : { problem: "no_hits" };
  } catch {
    return { problem: "not_json_rpc" };
  }
}

export function isGitHubRepositoryName(value: string): boolean {
  try {
    return typeof value === "string"
      && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
      && value.split("/").every((part) => part !== "." && part !== "..");
  } catch {
    return false;
  }
}

export function rankCodeSearchRepositories(hits: Array<{ pattern: string; hit: CodeSearchHit }>): RankedCodeSearchRepository[] {
  try {
    if (!Array.isArray(hits)) return [];
    const byRepository = new Map<string, RankedCodeSearchRepository>();
    for (const value of hits) {
      if (!isRecord(value) || typeof value.pattern !== "string" || !isRecord(value.hit)) continue;
      const { pattern, hit } = value;
      if (typeof hit.repository !== "string" || typeof hit.path !== "string" || isDemoPath(hit.path)) continue;
      const key = hit.repository.toLowerCase();
      const entry = byRepository.get(key) ?? { repository: hit.repository, matches: [] };
      const known = entry.matches.some((match) => match.pattern === pattern && match.path === hit.path);
      if (!known && entry.matches.length < 20) entry.matches.push({ pattern, path: hit.path });
      byRepository.set(key, entry);
    }
    const patternCount = (entry: RankedCodeSearchRepository): number => new Set(entry.matches.map((match) => match.pattern)).size;
    return [...byRepository.values()].sort((left, right) => patternCount(right) - patternCount(left)
      || right.matches.length - left.matches.length
      || left.repository.localeCompare(right.repository));
  } catch {
    return [];
  }
}

export function repositoryMetadataQuery(repositories: string[], maxLength = 256): { query: string; included: string[] } {
  try {
    if (!Array.isArray(repositories) || !Number.isFinite(maxLength) || maxLength < 0) return { query: "", included: [] };
    let query = "";
    const included: string[] = [];
    for (const repository of repositories) {
      if (typeof repository !== "string") continue;
      const next = query ? `${query} repo:${repository}` : `repo:${repository}`;
      if (next.length > maxLength) break;
      query = next;
      included.push(repository);
    }
    return { query, included };
  } catch {
    return { query: "", included: [] };
  }
}

export function emptyCodeSearchSummary(budget: number): CodeSearchSummary {
  return { queries: [], requests: 0, budget: Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0, repositoriesMatched: 0, repositoriesScreened: 0, metadataRequests: 0 };
}

export function mergeCodeSearchSummaries(first: CodeSearchSummary | undefined, second: CodeSearchSummary): CodeSearchSummary {
  try {
    if (!second || !Array.isArray(second.queries)) return first ?? emptyCodeSearchSummary(0);
    if (!first) return second;
    return {
      queries: [...first.queries, ...second.queries],
      requests: first.requests + second.requests,
      budget: Math.max(first.budget, second.budget),
      repositoriesMatched: first.repositoriesMatched + second.repositoriesMatched,
      repositoriesScreened: first.repositoriesScreened + second.repositoriesScreened,
      metadataRequests: first.metadataRequests + second.metadataRequests,
    };
  } catch {
    return emptyCodeSearchSummary(0);
  }
}

function eventPayload(text: string): unknown {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = jsonValue(line.slice(5).trim());
    if (isRecord(value) && ("result" in value || "error" in value)) return value;
  }
  return undefined;
}

function jsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
