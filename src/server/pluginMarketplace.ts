import fs from "node:fs";
import path from "node:path";
import { parsePluginManifest } from "./plugins.js";

export interface MarketplacePlugin {
  name: string;
  repository: string;
  description: string | null;
  url: string;
  stars: number;
  updatedAt: string;
  defaultBranch: string;
}

export interface MarketplaceManifestPreview {
  id: string;
  name: string;
  version: string;
  manifestPath: string;
  manifestUrl: string;
  actions: Array<{ id: string; title: string }>;
  builds: number;
}

export interface MarketplaceCache {
  version: 1;
  updatedAt: string;
  query: string;
  total: number;
  plugins: MarketplacePlugin[];
}

interface GitHubRepository {
  name?: unknown;
  full_name?: unknown;
  description?: unknown;
  html_url?: unknown;
  stargazers_count?: unknown;
  pushed_at?: unknown;
  updated_at?: unknown;
  default_branch?: unknown;
}

interface GitHubSearchResponse {
  total_count?: unknown;
  items?: unknown;
}

interface GitHubTreeResponse {
  sha?: unknown;
  tree?: unknown;
}

interface GitHubTreeEntry {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
}

export async function searchPluginMarketplace(
  query: string,
  limit = 25,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  total: number;
  plugins: MarketplacePlugin[];
}> {
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const terms = ["topic:shepherd-plugin"];
  const trimmed = query.trim();
  if (trimmed) terms.push(trimmed);
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", terms.join(" "));
  url.searchParams.set("per_page", String(safeLimit));

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "shepherd-plugin-search",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub plugin search failed with status ${response.status}`,
    );
  }
  const value = await response.json() as GitHubSearchResponse;
  const total = typeof value.total_count === "number"
    ? value.total_count
    : 0;
  const items = Array.isArray(value.items) ? value.items : [];
  return {
    total,
    plugins: items.flatMap((item) => {
      const repository = item as GitHubRepository;
      const name = stringOrEmpty(repository.name);
      const repositoryName = stringOrEmpty(repository.full_name);
      const repositoryUrl = stringOrEmpty(repository.html_url);
      if (!name || !repositoryName || !repositoryUrl) return [];
      return [{
        name,
        repository: repositoryName,
        description:
          typeof repository.description === "string"
            ? repository.description
            : null,
        url: repositoryUrl,
        stars: typeof repository.stargazers_count === "number"
          ? repository.stargazers_count
          : 0,
        updatedAt: stringOrEmpty(repository.pushed_at || repository.updated_at),
        defaultBranch: stringOrEmpty(repository.default_branch) || "main",
      }];
    }),
  };
}

export async function inspectMarketplaceRepository(
  repository: string,
  branch = "main",
  fetchImpl: typeof fetch = fetch,
): Promise<{
  repository: string;
  branch: string;
  commit: string;
  manifests: MarketplaceManifestPreview[];
}> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must look like owner/repo");
  }
  const treeUrl = new URL(
    `https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(branch)}`,
  );
  treeUrl.searchParams.set("recursive", "1");
  const response = await fetchImpl(treeUrl, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub repository tree failed with status ${response.status}`,
    );
  }
  const value = await response.json() as GitHubTreeResponse;
  const commit = typeof value.sha === "string" ? value.sha : "";
  const entries = (Array.isArray(value.tree) ? value.tree : [])
    .map((entry) => entry as GitHubTreeEntry)
    .filter((entry) =>
      entry.type === "blob" &&
      typeof entry.path === "string" &&
      path.basename(entry.path) === "shepherd-plugin.toml"
    )
    .slice(0, 20);

  const manifests: MarketplaceManifestPreview[] = [];
  for (const entry of entries) {
    const manifestPath = typeof entry.path === "string" ? entry.path : "";
    if (!manifestPath || typeof entry.sha !== "string") continue;
    const manifestUrl = new URL(
      `https://raw.githubusercontent.com/${repository}/${entry.sha}/${manifestPath}`,
    );
    const manifestResponse = await fetchImpl(manifestUrl, {
      headers: githubHeaders(),
    });
    if (!manifestResponse.ok) continue;
    const content = await manifestResponse.text();
    try {
      const parsed = parsePluginManifest(
        content,
        `github:${repository}@${entry.sha}`,
        manifestPath,
      );
      manifests.push({
        id: parsed.id,
        name: parsed.name,
        version: parsed.version,
        manifestPath,
        manifestUrl: manifestUrl.toString(),
        actions: parsed.actions.map((action) => ({
          id: action.id,
          title: action.title,
        })),
        builds: parsed.builds.length,
      });
    } catch {
      // Shepherd's marketplace similarly excludes malformed manifests rather
      // than rejecting the entire repository.
    }
  }

  return {
    repository,
    branch,
    commit,
    manifests,
  };
}

export function marketplaceCachePath(stateDirectory: string): string {
  return path.join(stateDirectory, "marketplace.json");
}

export function saveMarketplaceCache(
  stateDirectory: string,
  cache: MarketplaceCache,
): void {
  const target = marketplaceCachePath(stateDirectory);
  fs.mkdirSync(stateDirectory, { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temporary, target);
}

export function loadMarketplaceCache(
  stateDirectory: string,
): MarketplaceCache | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(marketplaceCachePath(stateDirectory), "utf8"),
    ) as MarketplaceCache;
    return value.version === 1 && Array.isArray(value.plugins)
      ? value
      : null;
  } catch {
    return null;
  }
}

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "shepherd-plugin-marketplace",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
