import { describe, expect, test } from "bun:test";
import { parseIntake } from "../src/model-schema.ts";
import {
  DEFAULT_QUALITY_BAR,
  candidateFromSearchItem,
  domainMaterialFromBrief,
  identifiedLicenseId,
  judgeQuality,
  judgeTree,
  orderCandidates,
  planSearches,
} from "../src/repository-screening.ts";
import type { RepositoryCandidate, RepositoryQualitySignals, RepositorySnapshot } from "../src/types.ts";

const NOW = new Date("2026-10-10T00:00:00.000Z");

function brief(overrides: Record<string, unknown> = {}) {
  return parseIntake({
    summary: "Build an event ticketing system.",
    requirements: [{ description: "Sell and verify event tickets.", observableAcceptance: ["A ticket purchase can be completed."] }],
    outOfScope: [],
    assumptions: [],
    materialQuestions: [],
    researchQueries: ["event ticketing workflow"],
    domainTerms: ["event ticketing", "ticket sales"],
    topicSlugs: ["event-ticketing"],
    ...overrides,
  });
}

function signals(overrides: Partial<RepositoryQualitySignals> = {}): RepositoryQualitySignals {
  return {
    stars: 200,
    forks: 30,
    archived: false,
    fork: false,
    licenseSpdxId: "MIT",
    language: "Python",
    topics: ["ticketing"],
    pushedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(paths: string[], overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    candidate: {
      id: "C1",
      provider: "github",
      fullName: "org/ticketing",
      description: "",
      defaultBranch: "main",
      webUrl: "https://github.com/org/ticketing",
    },
    commitSha: "a".repeat(40),
    treeTruncated: false,
    files: paths.map((path, index) => ({ id: `F${index + 1}`, path, size: 12 })),
    ...overrides,
  };
}

describe("host-built repository screening", () => {
  test("builds the exact ticketing query tiers and stays within GitHub query limits", () => {
    const searches = planSearches(domainMaterialFromBrief(brief()), NOW);
    expect(searches.github).toEqual([
      { tier: 0, query: "event ticketing in:name,description,topics archived:false fork:false stars:>=200 pushed:>=2025-10-10" },
      { tier: 0, query: "ticket sales in:name,description,topics archived:false fork:false stars:>=200 pushed:>=2025-10-10" },
      { tier: 0, query: "topic:event-ticketing archived:false fork:false stars:>=200 pushed:>=2025-10-10" },
      { tier: 1, query: "event ticketing in:name,description,topics archived:false fork:false stars:>=50 pushed:>=2024-10-10" },
      { tier: 1, query: "ticket sales in:name,description,topics archived:false fork:false stars:>=50 pushed:>=2024-10-10" },
      { tier: 1, query: "topic:event-ticketing archived:false fork:false stars:>=50 pushed:>=2024-10-10" },
      { tier: 2, query: "event ticketing in:name,description,topics archived:false fork:false stars:>=20 pushed:>=2023-10-10" },
      { tier: 2, query: "ticket sales in:name,description,topics archived:false fork:false stars:>=20 pushed:>=2023-10-10" },
      { tier: 2, query: "topic:event-ticketing archived:false fork:false stars:>=20 pushed:>=2023-10-10" },
    ]);
    expect(searches.github.every((entry) => entry.query.length <= 256)).toBe(true);
    expect(searches.github).toHaveLength(9);
  });

  test("strips search qualifiers and uppercase operators from model-supplied terms", () => {
    const polluted = brief({
      domainTerms: ["stars:>5 NOT \"root\" foo:bar", "--ticket event"],
      topicSlugs: ["../topic:ticket", "event-ticketing"],
    });
    const material = domainMaterialFromBrief(polluted);
    expect(material.phrases).toEqual(["stars5 not root", "ticket event"]);
    expect(material.topics).toEqual(["event-ticketing"]);
    const queries = planSearches(material, NOW).github.map((entry) => entry.query);
    expect(queries.join(" ")).not.toContain(":>5");
    expect(queries.join(" ")).not.toContain("\"");
    expect(queries.join(" ")).not.toMatch(/\b(?:AND|OR|NOT)\b/);
    expect(queries.flatMap((query) => query.split(/\s+/)).every((word) => !word.startsWith("-"))).toBe(true);
  });

  test("keeps up to four identifier-shaped code patterns and drops search syntax", () => {
    const material = domainMaterialFromBrief({
      ...brief(),
      codePatterns: ["OrderRefund", "orderrefund", "stars:>5", "refund amount", "check_in", "x", "TicketType", "seat_map", "refund_line"],
    });
    expect(material.codePatterns).toEqual(["OrderRefund", "check_in", "TicketType", "seat_map"]);
    expect("codePatterns" in domainMaterialFromBrief(brief())).toBe(false);
    expect("codePatterns" in domainMaterialFromBrief({ ...brief(), codePatterns: ["stars:>5", "a b"] })).toBe(false);

    const normalized = domainMaterialFromBrief({
      ...brief(),
      codePatterns: ["  OrderRefund  ", "ＯrderRefund", "refund_amount", "a".repeat(41), "check_in", "TicketType", "seat_map"],
    });
    expect(normalized.codePatterns).toEqual(["OrderRefund", "refund_amount", "check_in", "TicketType"]);
  });

  test("normalizes leading hyphens per word, keeps interior hyphens, and is idempotent", () => {
    const cases: Array<[string, string[]]> = [
      [" -ticket", ["ticket"]],
      ["ticket -refund", ["ticket refund"]],
      ["--- ", []],
      ["check-in desk", ["check-in desk"]],
      ["stars:>5 NOT \"event ticketing\" extra words", ["stars5 not event"]],
    ];
    for (const [raw, expected] of cases) {
      const first = domainMaterialFromBrief(brief({ summary: raw.trim() || "---", researchQueries: [raw.trim() || "---"], domainTerms: [raw], topicSlugs: [" Event-Ticketing "] }));
      expect(first.phrases).toEqual(expected);
      const second = domainMaterialFromBrief(brief({
        summary: raw.trim() || "---",
        researchQueries: [raw.trim() || "---"],
        domainTerms: first.phrases,
        topicSlugs: first.topics,
      }));
      expect(second.phrases).toEqual(first.phrases);
      expect(second.topics).toEqual(first.topics);
      const queries = planSearches(first, NOW).github.map((entry) => entry.query);
      expect(queries.flatMap((query) => query.split(/\s+/)).every((word) => !word.startsWith("-"))).toBe(true);
    }
  });

  test("maps provider result metadata into candidate signals", () => {
    const github = candidateFromSearchItem("github", {
      full_name: "org/tickets",
      default_branch: "main",
      description: "Tickets",
      stargazers_count: 321,
      forks_count: 47,
      archived: false,
      fork: false,
      license: { spdx_id: "NOASSERTION" },
      language: "Java",
      topics: ["event-ticketing"],
      pushed_at: "2026-09-01T00:00:00Z",
      created_at: "2020-01-01T00:00:00Z",
    });
    expect(github?.signals).toEqual({
      stars: 321,
      forks: 47,
      archived: false,
      fork: false,
      licenseSpdxId: "NOASSERTION",
      language: "Java",
      topics: ["event-ticketing"],
      pushedAt: "2026-09-01T00:00:00.000Z",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const gitlab = candidateFromSearchItem("gitlab", {
      id: 42,
      path_with_namespace: "org/tickets",
      default_branch: "main",
      star_count: 88,
      forks_count: 9,
      last_activity_at: "2026-08-01T00:00:00Z",
      created_at: "2020-01-01T00:00:00Z",
      topics: ["ticketing"],
    });
    expect(gitlab?.signals).toMatchObject({ stars: 88, forks: 9, archived: null, fork: null, licenseSpdxId: null, pushedAt: "2026-08-01T00:00:00.000Z" });
  });

  test("applies maturity thresholds and records unknown-age and license metadata signals", () => {
    const seatwise = signals({ stars: 0, createdAt: "2026-08-08T00:00:00.000Z", licenseSpdxId: "MIT" });
    const seatwiseJudgment = judgeQuality(seatwise, DEFAULT_QUALITY_BAR, NOW);
    expect(seatwiseJudgment.pass).toBe(false);
    expect(seatwiseJudgment.reasons).toEqual(expect.arrayContaining(["stars 0 is below the minimum of 20", expect.stringContaining("younger than 180 days")]));

    for (const licenseSpdxId of ["MIT", "GPL-3.0-only"]) {
      const judgment = judgeQuality(signals({ licenseSpdxId }), DEFAULT_QUALITY_BAR, NOW);
      expect(judgment.pass).toBe(true);
      expect(judgment.licenseFromMetadata).toBe(true);
    }
    expect(judgeQuality(signals({ archived: true }), DEFAULT_QUALITY_BAR, NOW).reasons).toContain("archived");
    expect(judgeQuality(signals({ fork: true }), DEFAULT_QUALITY_BAR, NOW).reasons).toContain("fork of another repository");
    expect(judgeQuality(signals({ pushedAt: "2022-08-20T00:00:00.000Z" }), DEFAULT_QUALITY_BAR, NOW).reasons[0]).toContain("older than 36 months");
    expect(judgeQuality(signals({ licenseSpdxId: null }), DEFAULT_QUALITY_BAR, NOW)).toMatchObject({ pass: true, licenseFromMetadata: false });
    expect(judgeQuality(signals({ stars: null }), DEFAULT_QUALITY_BAR, NOW).reasons).toContain("star count unavailable");
    expect(judgeQuality(signals({ archived: null }), DEFAULT_QUALITY_BAR, NOW).pass).toBe(true);
    expect(judgeQuality(signals({ createdAt: null }), DEFAULT_QUALITY_BAR, NOW)).toMatchObject({ pass: true, reasons: ["age unknown"] });
  });

  test("checks tests and root license evidence in a pinned tree", () => {
    const bar = DEFAULT_QUALITY_BAR;
    expect(judgeTree(snapshot(["tests/ticket.test.ts", "LICENSE"]), bar, false)).toMatchObject({ testFileCount: 1, licensePath: "LICENSE", reasons: [] });
    expect(judgeTree(snapshot(["tests/ticket.test.ts", "COPYING.txt"]), bar, false)).toMatchObject({ licensePath: "COPYING.txt", reasons: [] });
    expect(judgeTree(snapshot(["tests/ticket.test.ts", "NOTICE"]), bar, false).reasons[0]).toContain("GitHub reported no license");
    expect(judgeTree(snapshot(["tests/ticket.test.ts", "COPYING.txt"] , { candidate: { ...snapshot([]).candidate, provider: "gitlab" } }), bar, false).reasons).toEqual([]);
    expect(judgeTree(snapshot(["tests/ticket.test.ts"], { candidate: { ...snapshot([]).candidate, provider: "gitlab" } }), bar, false).reasons[0]).toContain("GitLab search metadata has no license field");
    expect(judgeTree(snapshot(["tests/ticket.test.ts"], { treeTruncated: true }), bar, false).reasons[0]).toContain("readable part of the truncated tree");
    expect(judgeTree(snapshot(["tests/ticket.test.ts"]), bar, true).reasons).toEqual([]);
    expect(judgeTree(snapshot(["src/ticket.ts"]), { ...bar, requireLicense: false }, false).reasons).toEqual([`no test file at ${"a".repeat(40)}`]);
    expect(judgeTree(snapshot(["tests/ticket.test.ts"]), { ...bar, requireLicense: false }, false).reasons).toEqual([]);
  });

  test("does not count NOASSERTION as identified license metadata", () => {
    expect(identifiedLicenseId(signals({ licenseSpdxId: "NOASSERTION" }))).toBeUndefined();
    expect(identifiedLicenseId(signals({ licenseSpdxId: " MIT " }))).toBe("MIT");
    expect(identifiedLicenseId(signals({ licenseSpdxId: null }))).toBeUndefined();
    expect(judgeQuality(signals({ licenseSpdxId: "NOASSERTION" }), DEFAULT_QUALITY_BAR, NOW)).toMatchObject({ pass: true, licenseFromMetadata: false });
  });

  test("requires a root license file for NOASSERTION and picks the standard name", () => {
    const unidentified = { ...snapshot([]).candidate, signals: signals({ licenseSpdxId: "NOASSERTION" }) };
    const { licenseFromMetadata } = judgeQuality(unidentified.signals, DEFAULT_QUALITY_BAR, NOW);

    expect(judgeTree(snapshot(["tests/ticket.test.ts"], { candidate: unidentified }), DEFAULT_QUALITY_BAR, licenseFromMetadata).reasons).toEqual([
      `no license: GitHub could not identify the license (NOASSERTION) and the tree at ${"a".repeat(40)} has no root LICENSE, LICENCE, UNLICENSE or COPYING file`,
    ]);
    expect(judgeTree(snapshot(["tests/ticket.test.ts", "LICENSE-adaic.org.txt", "LICENSE.txt"], { candidate: unidentified }), DEFAULT_QUALITY_BAR, licenseFromMetadata))
      .toMatchObject({ licensePath: "LICENSE.txt", reasons: [] });
  });

  test("orders candidate repositories by brief-term matches, then stars and name", () => {
    const candidate = (id: string, fullName: string, description: string, stars: number): RepositoryCandidate => ({
      id,
      provider: "github",
      fullName,
      description,
      defaultBranch: "main",
      webUrl: `https://github.com/${fullName}`,
      signals: signals({ stars }),
    });
    const ordered = orderCandidates([
      candidate("C1", "org/random", "General web service", 900),
      candidate("C2", "org/ticketing", "Event ticket sales", 100),
      candidate("C3", "org/ticketing-alt", "Event ticketing", 200),
    ], { phrases: ["event ticketing", "ticket sales"], topics: [] });
    expect(ordered.map((entry) => entry.id)).toEqual(["C2", "C3", "C1"]);
  });

  test("matches brief words as whole words and plain plurals", () => {
    const candidate = (id: string, fullName: string, description: string, stars: number): RepositoryCandidate => ({
      id,
      provider: "github",
      fullName,
      description,
      defaultBranch: "main",
      webUrl: `https://github.com/${fullName}`,
      signals: signals({ stars, topics: [] }),
    });
    const wholeWords = orderCandidates([
      candidate("C1", "acme/guardrails", "LLM guardrails", 9_000),
      candidate("C2", "org/rail-planner", "Rail timetables", 100),
    ], { phrases: ["rail"], topics: [] });
    expect(wholeWords.map((entry) => entry.id)).toEqual(["C2", "C1"]);

    const plurals = orderCandidates([
      candidate("C3", "acme/payments", "Payment processing", 9_000),
      candidate("C4", "org/desk", "Handles refunds", 100),
    ], { phrases: ["refund"], topics: [] });
    expect(plurals.map((entry) => entry.id)).toEqual(["C4", "C3"]);
  });

  test("weights generic words and plain-word code patterns below specific ones", () => {
    const candidate = (id: string, description: string, stars: number, patterns: string[] = []): RepositoryCandidate => ({
      id,
      provider: "github",
      fullName: `org/${id}`,
      description,
      defaultBranch: "main",
      webUrl: `https://github.com/org/${id}`,
      signals: signals({ stars, topics: [] }),
      ...(patterns.length > 0 ? { codeMatches: patterns.map((pattern) => ({ pattern, path: `src/${pattern}.ts` })) } : {}),
    });
    const byWords = orderCandidates([
      candidate("monorepo", "Reference code for everything", 390_000),
      candidate("provenance-kit", "Evidence provenance tracking", 900),
    ], { phrases: ["reference code", "evidence provenance"], topics: [] });
    expect(byWords.map((entry) => entry.id)).toEqual(["provenance-kit", "monorepo"]);

    const byPatterns = orderCandidates([
      candidate("plain", "", 390_000, ["evidence", "commit"]),
      candidate("identifiers", "", 900, ["ProvenanceRecord", "commit_sha"]),
    ], { phrases: [], topics: [] });
    expect(byPatterns.map((entry) => entry.id)).toEqual(["identifiers", "plain"]);
  });

  test("adds distinct code-search patterns to the brief-term score", () => {
    const candidate = (id: string, fullName: string, stars: number, codeMatches?: RepositoryCandidate["codeMatches"]): RepositoryCandidate => ({
      id,
      provider: "github",
      fullName,
      description: "Event ticket sales",
      defaultBranch: "main",
      webUrl: `https://github.com/${fullName}`,
      signals: signals({ stars }),
      ...(codeMatches ? { codeMatches } : {}),
    });
    const ordered = orderCandidates([
      candidate("C1", "org/popular", 900),
      candidate("C2", "org/implementer", 100, [
        { pattern: "OrderRefund", path: "src/refund.py" },
        { pattern: "OrderRefund", path: "src/refund_line.py" },
        { pattern: "TicketType", path: "src/tickets.py" },
      ]),
    ], { phrases: ["ticket sales"], topics: [] });
    expect(ordered.map((entry) => entry.id)).toEqual(["C2", "C1"]);

    const tied = orderCandidates([
      candidate("C3", "org/distinct", 500, [
        { pattern: "OrderRefund", path: "src/refund.py" },
        { pattern: "TicketType", path: "src/tickets.py" },
      ]),
      candidate("C4", "org/duplicates", 100, [
        { pattern: "OrderRefund", path: "src/refund.py" },
        { pattern: "OrderRefund", path: "src/refund_line.py" },
        { pattern: "TicketType", path: "src/tickets.py" },
      ]),
    ], { phrases: ["ticket sales"], topics: [] });
    expect(tied.map((entry) => entry.id)).toEqual(["C3", "C4"]);
  });
});
