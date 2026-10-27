import type {
  IntakeBrief,
  QualityBar,
  RepositoryCandidate,
  RepositoryQualitySignals,
  RepositorySnapshot,
  TreeFile,
} from "./types.ts";
import { chooseRootLicensePath, isTestPath } from "./file-ranking.ts";

export interface DomainMaterial {
  phrases: string[];
  topics: string[];
  codePatterns?: string[];
  // Sanitized brief material that no host-built GitHub query uses; discover() reports it as an informational gap.
  omitted?: string[];
}

export interface SearchTier {
  tier: 0 | 1 | 2;
  minStars: number;
  maxMonthsSincePush: number;
}

export interface SearchPlan {
  github: Array<{ tier: 0 | 1 | 2; query: string }>;
  gitlab: string[];
}

export interface QualityJudgment {
  pass: boolean;
  reasons: string[];
  licenseFromMetadata: boolean;
}

export interface TreeJudgment {
  testFileCount: number;
  licensePath: string | null;
  reasons: string[];
}

export const DEFAULT_QUALITY_BAR: QualityBar = {
  minStars: 20,
  maxMonthsSincePush: 36,
  minAgeDays: 180,
  requireTests: true,
  requireLicense: true,
};

const CODE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{2,39}$/;

// Words that appear across many unrelated repositories. A match on one says little about fit.
const GENERIC_WORDS = new Set([
  "api", "app", "application", "apps", "based", "code", "data", "framework", "library", "management",
  "manager", "open", "platform", "project", "reference", "service", "simple", "software", "source",
  "system", "tool", "tools", "web",
]);

// Function words carry no domain meaning, so they never make a domain term specific.
const SHORT_STOP_WORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "with"]);

const DEFAULT_SEARCH_TIERS: SearchTier[] = [
  { tier: 0, minStars: 200, maxMonthsSincePush: 12 },
  { tier: 1, minStars: 50, maxMonthsSincePush: 24 },
  { tier: 2, minStars: 20, maxMonthsSincePush: 36 },
];

export function domainMaterialFromBrief(brief: IntakeBrief): DomainMaterial {
  // A term says little about fit when every word that is not a SHORT_STOP_WORDS entry, short ones such as "qr"
  // included, is in GENERIC_WORDS; a term of stop words only counts as generic too. Specific terms take the two phrase
  // slots first. omitted names every term and topic that no query uses; brief text is quoted as JSON.
  const terms = [...new Set(brief.domainTerms.map((raw) => sanitizePhrase(raw)).filter(Boolean))];
  const generic = (term: string): boolean => term.split(/[^\p{L}\p{N}]+/u).filter((word) => word && !SHORT_STOP_WORDS.has(word)).every((word) => GENERIC_WORDS.has(word));
  const phrases = [...terms.filter((term) => !generic(term)), ...terms.filter(generic)].slice(0, 2);
  const specificSlots = phrases.every((phrase) => !generic(phrase));
  const omitted = [
    ...new Set(brief.domainTerms.filter((raw) => raw.trim() && !sanitizePhrase(raw)).map((raw) => `domain term ${JSON.stringify(raw.trim())} (no searchable words)`)),
    ...terms.filter((term) => !phrases.includes(term))
      .map((term) => `domain term "${term}" (${generic(term) && specificSlots ? "generic words only; specific terms took the two phrase slots" : "over the two-phrase limit"})`),
  ];
  if (phrases.length === 0) {
    const fallback = sanitizePhrase(brief.researchQueries[0] ?? "") || sanitizePhrase(brief.summary);
    if (fallback) phrases.push(fallback.split(" ").slice(0, 3).join(" ").slice(0, 40));
  }

  const topics: string[] = [];
  const seenTopics = new Set<string>();
  for (const raw of brief.topicSlugs) {
    const topic = raw.normalize("NFKC").trim().toLowerCase();
    if (!topic || seenTopics.has(topic)) continue;
    seenTopics.add(topic);
    if (!/^[a-z0-9-]{1,50}$/.test(topic)) omitted.push(`topic ${JSON.stringify(raw.trim())} (not a GitHub topic slug)`);
    else if (topics.length < 2) topics.push(topic);
    else omitted.push(`topic "${topic}" (over the two-topic limit)`);
  }
  const codePatterns: string[] = [];
  const seenPatterns = new Set<string>();
  for (const raw of brief.codePatterns ?? []) {
    const pattern = raw.normalize("NFKC").trim();
    const key = pattern.toLowerCase();
    if (!CODE_PATTERN.test(pattern) || seenPatterns.has(key)) continue;
    seenPatterns.add(key);
    codePatterns.push(pattern);
    if (codePatterns.length === 4) break;
  }
  return { phrases, topics, ...(codePatterns.length > 0 ? { codePatterns } : {}), ...(omitted.length > 0 ? { omitted } : {}) };
}

export function planSearches(material: DomainMaterial, now: Date, tiers: SearchTier[] = DEFAULT_SEARCH_TIERS): SearchPlan {
  const phrases = material.phrases.slice(0, 2);
  const topics = material.topics.slice(0, 2);
  const github: SearchPlan["github"] = [];
  for (const tier of tiers.slice(0, 3)) {
    const pushedDate = dateMonthsBefore(now, tier.maxMonthsSincePush);
    const qualifiers = `archived:false fork:false stars:>=${tier.minStars} pushed:>=${pushedDate}`;
    for (const phrase of phrases) github.push({ tier: tier.tier, query: `${phrase} in:name,description,topics ${qualifiers}` });
    // Only the strictest tier spends a request on the second topic; GitHubResearcher's budget of 9 records any excess as skipped.
    for (const topic of tier.tier === 0 ? topics : topics.slice(0, 1)) github.push({ tier: tier.tier, query: `topic:${topic} ${qualifiers}` });
  }
  return { github, gitlab: phrases.slice(0, 2) };
}

export function candidateFromSearchItem(provider: "github" | "gitlab", item: unknown): Omit<RepositoryCandidate, "id"> | undefined {
  if (!isRecord(item)) return undefined;
  const fullName = provider === "github" ? text(item.full_name) : text(item.path_with_namespace);
  const defaultBranch = text(item.default_branch);
  if (!isRepositoryName(fullName) || !defaultBranch) return undefined;
  const signals: RepositoryQualitySignals = provider === "github"
    ? {
        stars: nonNegativeNumber(item.stargazers_count),
        forks: nonNegativeNumber(item.forks_count),
        archived: booleanOrNull(item.archived),
        fork: booleanOrNull(item.fork),
        licenseSpdxId: licenseId(item.license),
        language: nullableText(item.language),
        topics: stringList(item.topics),
        pushedAt: timestamp(item.pushed_at),
        createdAt: timestamp(item.created_at),
      }
    : {
        stars: nonNegativeNumber(item.star_count),
        forks: nonNegativeNumber(item.forks_count),
        archived: null,
        fork: null,
        licenseSpdxId: null,
        language: null,
        topics: stringList(item.topics),
        pushedAt: timestamp(item.last_activity_at),
        createdAt: timestamp(item.created_at),
      };
  const projectId = provider === "gitlab" && (typeof item.id === "number" || typeof item.id === "string") ? String(item.id) : "";
  if (provider === "gitlab" && !/^\d+$/.test(projectId)) return undefined;
  const activity = signals.pushedAt;
  return {
    provider,
    fullName,
    description: nullableText(item.description)?.slice(0, 360) ?? "",
    defaultBranch,
    webUrl: `https://${provider === "github" ? "github.com" : "gitlab.com"}/${fullName}`,
    ...(activity ? { lastActivityAt: activity } : {}),
    ...(provider === "gitlab" ? { providerProjectId: projectId } : {}),
    signals,
  };
}

// GitHub reports NOASSERTION when it found a license file but could not identify the license.
export function identifiedLicenseId(signals: RepositoryQualitySignals | undefined): string | undefined {
  const id = signals?.licenseSpdxId?.trim();
  return id && id.toUpperCase() !== "NOASSERTION" ? id : undefined;
}

export function judgeQuality(signals: RepositoryQualitySignals | undefined, bar: QualityBar, now: Date): QualityJudgment {
  const reasons: string[] = [];
  const licenseFromMetadata = identifiedLicenseId(signals) !== undefined;
  if (!signals) {
    return { pass: false, reasons: ["search metadata unavailable"], licenseFromMetadata };
  }
  if (signals.archived === true) reasons.push("archived");
  if (signals.fork === true) reasons.push("fork of another repository");
  if (signals.stars === null) reasons.push("star count unavailable");
  else if (signals.stars < bar.minStars) reasons.push(`stars ${signals.stars} is below the minimum of ${bar.minStars}`);
  if (signals.pushedAt === null) reasons.push("activity date unavailable");
  else {
    const pushed = Date.parse(signals.pushedAt);
    const cutoff = addUtcMonths(now, -bar.maxMonthsSincePush).getTime();
    if (!Number.isFinite(pushed) || pushed < cutoff) reasons.push(`no push since ${new Date(cutoff).toISOString().slice(0, 10)}, older than ${bar.maxMonthsSincePush} months`);
  }
  if (signals.createdAt === null) {
    reasons.push("age unknown");
  } else {
    const created = Date.parse(signals.createdAt);
    const ageDays = (now.getTime() - created) / 86_400_000;
    if (!Number.isFinite(created) || ageDays < bar.minAgeDays) reasons.push(`created ${signals.createdAt.slice(0, 10)}, younger than ${bar.minAgeDays} days`);
  }
  return { pass: reasons.every((reason) => reason === "age unknown"), reasons, licenseFromMetadata };
}

export function judgeTree(snapshot: RepositorySnapshot, bar: QualityBar, licenseFromMetadata: boolean): TreeJudgment {
  const testFileCount = snapshot.files.filter((file) => isTestPath(file.path)).length;
  const licensePath = chooseRootLicensePath(snapshot.files.map((file) => file.path)) ?? null;
  const reasons: string[] = [];
  if (bar.requireTests && testFileCount === 0) reasons.push(`no test file at ${snapshot.commitSha}`);
  if (bar.requireLicense && !licenseFromMetadata && !licensePath) {
    const location = snapshot.treeTruncated ? `the readable part of the truncated tree at ${snapshot.commitSha}` : `the tree at ${snapshot.commitSha}`;
    const provider = snapshot.candidate.provider === "gitlab"
      ? "GitLab search metadata has no license field"
      : snapshot.candidate.signals?.licenseSpdxId?.trim().toUpperCase() === "NOASSERTION"
        ? "GitHub could not identify the license (NOASSERTION)"
        : "GitHub reported no license";
    reasons.push(`no license: ${provider} and ${location} has no root LICENSE, LICENCE, UNLICENSE or COPYING file`);
  }
  return { testFileCount, licensePath, reasons };
}

export function orderCandidates(candidates: RepositoryCandidate[], material: DomainMaterial): RepositoryCandidate[] {
  const words = [...new Set(material.phrases.flatMap(wordTokens))];
  const score = (candidate: RepositoryCandidate): number => {
    const tokens = new Set(wordTokens(`${candidate.fullName} ${candidate.description} ${candidate.signals?.topics.join(" ") ?? ""}`));
    const termScore = words.reduce((sum, word) => sum + (matchesWord(tokens, word) ? (GENERIC_WORDS.has(word) ? 0.25 : 1) : 0), 0);
    const patterns = new Set((candidate.codeMatches ?? []).map((match) => match.pattern));
    const patternScore = [...patterns].reduce((sum, pattern) => sum + (isIdentifierPattern(pattern) ? 1 : 0.5), 0);
    return termScore + patternScore;
  };
  const scores = new Map(candidates.map((candidate) => [candidate.id, score(candidate)]));
  return [...candidates].sort((left, right) => scores.get(right.id)! - scores.get(left.id)!
    || (right.signals?.stars ?? -1) - (left.signals?.stars ?? -1)
    || left.fullName.localeCompare(right.fullName));
}

function wordTokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3);
}

// A plain plural still matches: "refund" matches "refunds", but "code" does not match "codeguy".
function matchesWord(tokens: Set<string>, word: string): boolean {
  return tokens.has(word) || tokens.has(`${word}s`) || tokens.has(`${word}es`);
}

// OrderRefund and refund_amount name code; refund and evidence are ordinary words.
function isIdentifierPattern(pattern: string): boolean {
  return pattern.includes("_") || /[a-z0-9][A-Z]/.test(pattern);
}

function sanitizePhrase(value: string): string {
  const trimmed = value.normalize("NFKC").trim().toLowerCase();
  const words = trimmed
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .split(/\s+/)
    .map((word) => word.replace(/^-+/, ""))
    .filter(Boolean);
  return words.slice(0, 3).join(" ").slice(0, 40).trim();
}

function dateMonthsBefore(now: Date, months: number): string {
  return addUtcMonths(now, -months).toISOString().slice(0, 10);
}

function addUtcMonths(date: Date, delta: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + delta);
  const finalDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, finalDay));
  return result;
}

function licenseId(value: unknown): string | null {
  if (!isRecord(value) || typeof value.spdx_id !== "string" || !value.spdx_id.trim()) return null;
  return value.spdx_id.trim();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 100)).slice(0, 100) : [];
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
