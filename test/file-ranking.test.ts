import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { parseIntake } from "../src/model-schema.ts";
import { chooseRootLicensePath, domainTermsFor, isDemoPath, isRootLicensePath, isTestPath, rankTreeFiles, scorePath } from "../src/file-ranking.ts";
import type { ResolvedAnswer, TreeFile } from "../src/types.ts";

const terms = [
  { term: "ticket", weight: 3 },
  { term: "order", weight: 3 },
  { term: "refund", weight: 3 },
  { term: "checkin", weight: 3 },
  { term: "attendee", weight: 3 },
  { term: "reservation", weight: 3 },
  { term: "event", weight: 1 },
  { term: "payment", weight: 1 },
  { term: "admission", weight: 1 },
];

async function fixture(name: string): Promise<TreeFile[]> {
  const paths = (await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean);
  return paths.map((path, index) => ({ id: `F${index + 1}`, path, size: null }));
}

describe("domain-ranked repository file lists", () => {
  test("keeps the ticket implementation in the osTicket shortlist", async () => {
    const files = await fixture("osticket.paths.txt");
    const ranked = rankTreeFiles(files, terms, 30);
    expect(files.length).toBeGreaterThan(30);
    expect(ranked.map((file) => file.path)).toContain("include/class.ticket.php");
    expect(ranked.length).toBeLessThan(files.length);
  });

  test("keeps the reservation manager and test classes in the alf.io shortlist", async () => {
    const files = await fixture("alfio.paths.txt");
    const ranked = rankTreeFiles(files, terms, 30);
    expect(files.length).toBeGreaterThan(30);
    expect(ranked.map((file) => file.path)).toContain("src/main/java/alfio/manager/TicketReservationManager.java");
    expect(ranked.some((file) => isTestPath(file.path) && file.path.includes("TicketReservationManager"))).toBe(true);
  });

  test("keeps pretix order tests and production implementation within a smaller list", async () => {
    const files = await fixture("pretix.paths.txt");
    const ranked = rankTreeFiles(files, terms, 24);
    expect(files.length).toBeGreaterThan(24);
    expect(ranked.some((file) => file.path.startsWith("src/tests/"))).toBe(true);
    expect(ranked.some((file) => !isTestPath(file.path) && file.path === "src/pretix/base/models/orders.py")).toBe(true);
    expect(ranked.length).toBeLessThan(files.length);
  });

  test("uses English domain terms for a Chinese brief without throwing", () => {
    const brief = parseIntake({
      summary: "为活动售票平台记录订单并核验入场。",
      requirements: [{ description: "支持订单支付和入场核验。", observableAcceptance: ["订单可以完成。"] }],
      outOfScope: [],
      assumptions: [],
      materialQuestions: [],
      researchQueries: ["活动售票"],
      domainTerms: ["ticket"],
      topicSlugs: [],
    });
    const rankedTerms = domainTermsFor(brief, []);
    const ticketFile: TreeFile = { id: "F-ticket", path: "src/ticket.ts", size: 10 };
    const unrelated: TreeFile = { id: "F-other", path: "src/profile.ts", size: 10 };
    expect(rankedTerms).toContainEqual({ term: "ticket", weight: 3 });
    expect(rankTreeFiles([unrelated, ticketFile], rankedTerms, 2)[0]?.path).toBe("src/ticket.ts");
  });

  test("deduplicates and caps weighted terms from brief content and answers", () => {
    const summaryTerms = Array.from({ length: 50 }, (_, index) => `summaryterm${String(index).padStart(2, "0")}`);
    expect(summaryTerms).toHaveLength(50);
    const brief = parseIntake({
      summary: summaryTerms.join(" "),
      requirements: [{ description: "Find ticket and order status.", observableAcceptance: ["A ticket can be found."] }],
      outOfScope: [],
      assumptions: [],
      materialQuestions: [],
      researchQueries: ["ticket payment"],
      domainTerms: ["ticket"],
      topicSlugs: [],
    });
    const answers: ResolvedAnswer[] = [{ questionId: "Q1", question: "Which event?", whyMaterial: "It changes access.", answer: "A local event." }];
    const result = domainTermsFor(brief, answers);
    expect(result.filter((term) => term.term === "ticket")).toEqual([{ term: "ticket", weight: 3 }]);
    expect(result).toHaveLength(40);
    expect(new Set(result.map((term) => term.term)).size).toBe(40);
    expect(scorePath("src/TicketReservationManager.java", result)).toBeGreaterThan(scorePath("docs/readme.md", result));
  });

  test("recognizes only supported root license filenames", () => {
    for (const path of ["LICENSE", "LICENCE", "COPYING.txt", "UNLICENSE", "LICENSE-MIT", "LICENSE.md", "LICENSE.rst"]) {
      expect(isRootLicensePath(path)).toBe(true);
    }
    for (const path of ["NOTICE", "docs/LICENSE", "LICENSES/LICENSE-MIT.txt", "LICENSES/"]) {
      expect(isRootLicensePath(path)).toBe(false);
    }
  });

  test("prefers a standard root license name over an ancillary LICENSE-<suffix> file", () => {
    expect(chooseRootLicensePath(["LICENSE-adaic.org.txt", "LICENSE.txt", "src/index.ts"])).toBe("LICENSE.txt");
    expect(chooseRootLicensePath(["COPYING", "LICENSE-MIT"])).toBe("COPYING");
    expect(chooseRootLicensePath(["LICENSE-APACHE", "LICENSE-MIT"])).toBe("LICENSE-APACHE");
    expect(chooseRootLicensePath(["docs/LICENSE", "NOTICE"])).toBeUndefined();
  });

  test("recognizes example, sample, demo, tutorial and documentation paths", () => {
    for (const filePath of ["python/samples/handoff.py", "examples/refund.ts", "docs/refunds.md", "demo/app.ts", "site/tutorials/step1.ts", "Doc/guide.ts"]) {
      expect(isDemoPath(filePath)).toBe(true);
    }
    for (const filePath of ["src/refunds.ts", "tests/refund.test.ts", "src/sample_data.ts", "documentation.ts"]) {
      expect(isDemoPath(filePath)).toBe(false);
    }
  });
});
