import path from "node:path";
import type { IntakeBrief, ResolvedAnswer, TreeFile } from "./types.ts";

export interface RankedTerm {
  term: string;
  weight: number;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "system", "build", "support", "user", "users", "provide", "intended", "domain",
  "from", "into", "that", "this", "these", "those", "their", "there", "then", "when", "where", "what", "which",
  "will", "should", "could", "would", "have", "has", "had", "are", "was", "were", "been", "being", "can",
  "not", "all", "any", "each", "more", "less", "such", "also", "allow", "allows", "using", "use", "used",
  "create", "manage", "application", "app", "software", "project", "service", "implementation", "feature", "features",
]);

const TEXT_SOURCE_PATTERN = /\.(c|cc|cpp|cs|css|go|h|hpp|html?|java|js|jsx|json|kt|md|mjs|php|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|txt|vue|xml|yaml|yml|zig)$/i;
const STANDARD_LICENSE_NAME = /^((un)?licen[sc]e|copying)(\.(txt|md|rst))?$/i;

export function domainTermsFor(brief: IntakeBrief, answers: ResolvedAnswer[]): RankedTerm[] {
  const terms: RankedTerm[] = [];
  const seen = new Set<string>();
  const add = (text: string, weight: number): void => {
    const normalized = text.normalize("NFKC").toLowerCase();
    for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu)) {
      const term = match[0].replace(/^[_-]+|[_-]+$/g, "");
      if (term.length < 3 || STOP_WORDS.has(term) || seen.has(term)) continue;
      seen.add(term);
      terms.push({ term, weight });
      if (terms.length >= 40) return;
    }
  };
  for (const domainTerm of brief.domainTerms) add(domainTerm, 3);
  for (const text of [
    brief.summary,
    ...brief.requirements.map((requirement) => requirement.description),
    ...answers.map((answer) => `${answer.question} ${answer.answer}`),
    ...brief.researchQueries,
  ]) {
    add(text, 1);
    if (terms.length >= 40) break;
  }
  return terms;
}

export function scorePath(filePath: string, terms: RankedTerm[]): number {
  const segments = filePath.split("/");
  const rawBasename = segments.at(-1) ?? filePath;
  const basename = normalizePathTerm(rawBasename.replace(/\.[^.]+$/, ""));
  const directories = segments.slice(0, -1).map(normalizePathTerm);
  let domainScore = 0;
  for (const { term, weight } of terms) {
    const normalizedTerm = normalizePathTerm(term);
    if (!normalizedTerm) continue;
    if (basename.includes(normalizedTerm)) domainScore += weight * 3;
    else if (directories.some((directory) => directory.includes(normalizedTerm))) domainScore += weight;
  }

  const lower = filePath.normalize("NFKC").toLowerCase();
  let structure = 0;
  if (/(^|\/)(src|lib|app|packages|internal|include)\//.test(lower)) structure += 3;
  if (isTestPath(lower)) structure += 2;
  if (/(^|\/)(migrations?|templates?|locale|static|assets?)\//.test(lower)) structure -= 6;
  if (/(^|\/)(docs?|examples?|fixtures?|testdata|vendor|node_modules|third_party)\//.test(lower)) structure -= 8;
  if (/\.(min\.|lock$|svg$|map$|snap$)/.test(lower)) structure -= 10;
  return domainScore * 4 + structure;
}

export function rankTreeFiles(files: TreeFile[], terms: RankedTerm[], limit: number): TreeFile[] {
  const eligible = files.filter((file) => isTextSourcePath(file.path));
  const ranked = [...eligible].sort((left, right) => scorePath(right.path, terms) - scorePath(left.path, terms)
    || left.path.length - right.path.length
    || left.path.localeCompare(right.path));
  const take = Math.max(0, Math.floor(limit));
  if (take === 0) return [];
  const testQuota = Math.floor(take * 0.25);
  const implementationQuota = Math.floor(take * 0.5);
  const tests = ranked.filter((file) => isTestPath(file.path)).slice(0, testQuota);
  const implementation = ranked.filter((file) => !isTestPath(file.path)).slice(0, implementationQuota);
  const selected = new Map<string, TreeFile>();
  for (const file of [...tests, ...implementation]) selected.set(file.id, file);
  for (const file of ranked) {
    if (selected.size >= take) break;
    selected.set(file.id, file);
  }
  return [...selected.values()].sort((left, right) => scorePath(right.path, terms) - scorePath(left.path, terms)
    || left.path.length - right.path.length
    || left.path.localeCompare(right.path));
}

export function isTestPath(filePath: string): boolean {
  const lower = filePath.normalize("NFKC").toLowerCase();
  return /(^|\/)(__tests__|tests?|spec)\//.test(lower)
    || /\.(test|spec)\.[^.]+$/.test(lower)
    || lower.endsWith("_test.go");
}

export function isTextSourcePath(filePath: string): boolean {
  return TEXT_SOURCE_PATTERN.test(filePath) || /(^|\/)(Dockerfile|Makefile|Justfile|Jenkinsfile)$/i.test(filePath);
}

export function pathRoleHint(filePath: string): string {
  if (isTestPath(filePath)) return "likely test";
  if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml)/i.test(filePath)) return "project manifest";
  if (filePath.toLowerCase().startsWith(".github/workflows/")) return "CI";
  if (/(^|\/)(license|licence|unlicense|copying|notice)/i.test(filePath)) return "license";
  return "implementation or project text";
}

export function isRootLicensePath(filePath: string): boolean {
  if (path.posix.dirname(filePath) !== ".") return false;
  return /^((un)?licen[sc]e(-[a-z0-9.]+)?|copying)(\.(txt|md|rst))?$/i.test(path.posix.basename(filePath));
}

// A standard name such as LICENSE.txt wins over an ancillary LICENSE-<suffix> file in the same root.
export function chooseRootLicensePath(paths: Iterable<string>): string | undefined {
  let fallback: string | undefined;
  for (const filePath of paths) {
    if (!isRootLicensePath(filePath)) continue;
    if (STANDARD_LICENSE_NAME.test(path.posix.basename(filePath))) return filePath;
    fallback ??= filePath;
  }
  return fallback;
}

export function isDemoPath(filePath: string): boolean {
  try {
    return typeof filePath === "string" && /(^|\/)(samples?|examples?|demos?|docs?|tutorials?)\//i.test(filePath.normalize("NFKC"));
  } catch {
    return false;
  }
}

function normalizePathTerm(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[-_.]/g, "");
}
