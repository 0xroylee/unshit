import type { RequestEndpoint, RequestFailure, RequestFailureCategory } from "./types.ts";

export type RequestTarget = Pick<RequestFailure, "provider" | "endpoint"> & { page?: number };

const REGISTRY = new WeakMap<object, RequestFailure>();
const INTERNAL_FALLBACK: RequestFailure = Object.freeze({
  provider: "github",
  endpoint: "search",
  category: "internal",
  attempts: 0,
  retryRefused: false,
});

const PROVIDERS = ["github", "gitlab"] as const;
const ENDPOINTS = ["search", "commit", "tree", "source"] as const;
const CATEGORIES = [
  "http_status",
  "rate_limit",
  "timeout",
  "size_limit",
  "invalid_json",
  "invalid_response",
  "network",
  "cancelled",
  "request_budget",
  "invalid_request",
  "internal",
] as const;

export class ProviderRequestError extends Error {
  readonly failure: RequestFailure;

  constructor(failure: RequestFailure) {
    const safeFailure = normalizeFailure(failure);
    super(describeRequestFailure(safeFailure));
    this.name = "ProviderRequestError";
    this.failure = safeFailure;
    REGISTRY.set(this, safeFailure);
  }
}

export function registeredRequestFailure(error: unknown): RequestFailure | undefined {
  return REGISTRY.get(error as object);
}

export function requestFailureOf(error: unknown, target: RequestTarget): RequestFailure {
  return registeredRequestFailure(error) ?? internalFailure(target);
}

function internalFailure(target: RequestTarget): RequestFailure {
  try {
    const provider = isProvider(target?.provider) ? target.provider : "github";
    const endpoint = isEndpoint(target?.endpoint) ? target.endpoint : "search";
    const page = isValidPage(target?.page) ? target.page : undefined;
    return Object.freeze({
      provider,
      endpoint,
      ...(page === undefined ? {} : { page }),
      category: "internal",
      attempts: 0,
      retryRefused: false,
    });
  } catch {
    return INTERNAL_FALLBACK;
  }
}

export function describeRequestFailure(failure: RequestFailure): string {
  try {
    const safeFailure = normalizeFailure(failure);
    const provider = safeFailure.provider === "github" ? "GitHub" : "GitLab";
    const label = `${provider} ${safeFailure.endpoint} request${safeFailure.page === undefined ? "" : ` (page ${safeFailure.page})`}`;
    const retry = safeFailure.attempts === 2 ? " after one retry" : "";
    const retryRefused = safeFailure.retryRefused
      ? "; the retry was not sent because the request budget was exhausted"
      : "";

    switch (safeFailure.category) {
      case "http_status":
        return `${label} failed${retry}: HTTP ${safeFailure.status ?? 500}${retryRefused}`;
      case "rate_limit":
        return `${label} failed: rate limit reached`;
      case "timeout":
        return `${label} failed${retry}: request timed out${retryRefused}`;
      case "size_limit":
        return `${label} failed${retry}: response exceeded the ${(safeFailure.limitBytes ?? 1_000_000) / 1_000_000} MB ${safeFailure.endpoint} limit${retryRefused}`;
      case "invalid_json":
        return `${label} failed${retry}: response was not valid JSON${retryRefused}`;
      case "invalid_response":
        return `${label} failed${retry}: response had an unexpected shape${retryRefused}`;
      case "network":
        return `${label} failed${retry}: no response (network failure)${retryRefused}`;
      case "cancelled":
        return `${label} was cancelled`;
      case "request_budget":
        return `${label} was not sent: the request budget was exhausted`;
      case "invalid_request":
        return `${label} was not sent: the request was invalid`;
      case "internal":
      default:
        return `${label} failed: internal host error`;
    }
  } catch {
    return "GitHub search request failed: internal host error";
  }
}

function normalizeFailure(failure: RequestFailure): RequestFailure {
  let read: Record<"provider" | "endpoint" | "category" | "status" | "limitBytes" | "page" | "attempts" | "retryRefused", unknown>;
  try {
    const source = failure as unknown as Record<string, unknown> | null | undefined;
    read = {
      provider: source?.provider,
      endpoint: source?.endpoint,
      category: source?.category,
      status: source?.status,
      limitBytes: source?.limitBytes,
      page: source?.page,
      attempts: source?.attempts,
      retryRefused: source?.retryRefused,
    };
  } catch {
    return INTERNAL_FALLBACK;
  }

  const provider = isProvider(read.provider) ? read.provider : "github";
  const endpoint = isEndpoint(read.endpoint) ? read.endpoint : "search";
  const category = isCategory(read.category) ? read.category : "internal";
  const attempts = Number.isInteger(read.attempts) && (read.attempts as number) >= 0 && (read.attempts as number) <= 2
    ? read.attempts as number
    : 0;
  const normalized: RequestFailure = {
    provider,
    endpoint,
    category,
    attempts,
    retryRefused: read.retryRefused === true,
  };
  if (category === "http_status" && Number.isInteger(read.status) && (read.status as number) >= 100 && (read.status as number) <= 599) {
    normalized.status = read.status as number;
  }
  if (category === "size_limit" && Number.isInteger(read.limitBytes) && (read.limitBytes as number) > 0) {
    normalized.limitBytes = read.limitBytes as number;
  }
  if (endpoint === "tree" && provider === "gitlab" && isValidPage(read.page)) normalized.page = read.page;
  return Object.freeze(normalized);
}

function isProvider(value: unknown): value is RequestFailure["provider"] {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function isEndpoint(value: unknown): value is RequestEndpoint {
  return typeof value === "string" && (ENDPOINTS as readonly string[]).includes(value);
}

function isCategory(value: unknown): value is RequestFailureCategory {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

function isValidPage(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 1;
}
