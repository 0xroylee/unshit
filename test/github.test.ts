import { describe, expect, test } from "bun:test";
import { GitHubResearcher } from "../src/github.ts";
import type { RepositoryCandidate } from "../src/types.ts";

const COMMIT = "8e0d33a8257952f4d02d92fd566297082b9a7f2e";

function json(value: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

describe("GitLab public source adapter", () => {
  test("discovers a public project, resolves its exact branch commit, tree, and pinned file bytes", async () => {
    const urls: URL[] = [];
    const researcher = new GitHubResearcher({
      fetch: async (input) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.origin === "https://api.github.com") return json({ items: [] });
        if (url.pathname === "/api/v4/projects") {
          return json([{ id: 60510562, path_with_namespace: "org/refunds", default_branch: "main", description: "Refund service" }]);
        }
        if (url.pathname === "/api/v4/projects/60510562/repository/commits/main") {
          return json({ id: COMMIT, created_at: "2026-06-01T10:00:00Z" });
        }
        if (url.pathname === "/api/v4/projects/60510562/repository/tree") {
          return json([{ type: "blob", path: "src/handler.ts", size: 23 }], { "x-next-page": "" });
        }
        if (url.pathname === "/api/v4/projects/60510562/repository/files/src%2Fhandler.ts/raw") {
          return new Response("export const handler = true;\n", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const discovery = await researcher.discover(["refund service"]);
    expect(discovery.candidates).toHaveLength(1);
    expect(discovery.candidates[0]).toMatchObject({ provider: "gitlab", fullName: "org/refunds", providerProjectId: "60510562" });

    const resolution = await researcher.resolveSelected(discovery.candidates, [discovery.candidates[0]!.id]);
    expect(resolution.gaps).toEqual([]);
    expect(resolution.snapshots).toHaveLength(1);
    expect(resolution.snapshots[0]).toMatchObject({ commitSha: COMMIT, commitDate: "2026-06-01T10:00:00.000Z" });

    const file = await researcher.fetchSource(resolution.snapshots[0]!, "src/handler.ts");
    expect(new TextDecoder().decode(file)).toBe("export const handler = true;\n");
    expect(urls.some((url) => url.pathname === `/api/v4/projects/60510562/repository/commits/${COMMIT}`)).toBe(false);
    expect(urls.some((url) => url.pathname === "/api/v4/projects/60510562/repository/commits/main")).toBe(true);
    expect(urls.some((url) => url.pathname === "/api/v4/projects/60510562/repository/commits" && url.searchParams.has("per_page"))).toBe(false);
  });

  test("reports the provider HTTP status when exact commit resolution fails", async () => {
    const candidate: RepositoryCandidate = {
      id: "C1",
      provider: "gitlab",
      fullName: "org/refunds",
      description: "",
      defaultBranch: "main",
      webUrl: "https://gitlab.com/org/refunds",
      providerProjectId: "60510562",
    };
    const researcher = new GitHubResearcher({
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname.endsWith("/repository/commits/main")) return new Response("upstream access denied", { status: 403 });
        return new Response("unexpected request", { status: 500 });
      },
    });

    const result = await researcher.resolveSelected([candidate], [candidate.id]);

    expect(result.snapshots).toEqual([]);
    expect(result.gaps).toEqual([{ kind: "tree", message: "Could not read a commit-pinned file tree for org/refunds: HTTP 403.", material: true }]);
  });
});
