// Builds profile/top-langs.svg.
//
// The stock top-languages card lists repositories through the user's
// affiliations (owner, collaborator, organization member). An organization
// owner's access does not count as any of those, so most organization repos
// never reach the card. This script gathers the repositories itself:
//   - every repository the user owns (forks excluded, like the card), plus
//   - every repository in ORGS where the user has at least one commit on the
//     default branch,
// aggregates language bytes the same way the card does, and renders it with
// the card's own renderer so it looks identical.
//
// Env: GH_TOKEN, USER, ORGS (space separated), CORE_DIR (where the core
// package is installed), OUT (output path), plus the card options below.

import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";

const graphql = async (token, query, variables) => {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "readme-stats-workflow",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL failed: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
};

const REPO_FIELDS = `
  name
  owner { login }
  isFork
  isArchived
  languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
    edges { size node { name color } }
  }`;

/** Repositories owned by the user, forks excluded. */
export const fetchOwnRepos = async (token, login) => {
  const repos = [];
  let cursor = null;
  do {
    const data = await graphql(
      token,
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER], isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes { ${REPO_FIELDS} }
          }
        }
      }`,
      { login, cursor },
    );
    const page = data.user.repositories;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
};

/** Every repository of an organization the token can see, forks excluded. */
export const fetchOrgRepos = async (token, org) => {
  const repos = [];
  let cursor = null;
  do {
    const data = await graphql(
      token,
      `query($org: String!, $cursor: String) {
        organization(login: $org) {
          repositories(first: 100, after: $cursor, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes { ${REPO_FIELDS} }
          }
        }
      }`,
      { org, cursor },
    );
    const page = data.organization.repositories;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
};

/** Whether the user has at least one commit on the repository's default branch. */
export const hasCommitBy = async (token, owner, repo, login) => {
  const url = `${API}/repos/${owner}/${repo}/commits?author=${encodeURIComponent(login)}&per_page=1`;
  const res = await fetch(url, {
    headers: { authorization: `bearer ${token}`, "user-agent": "readme-stats-workflow" },
  });
  if (!res.ok) return false; // empty repository (409), no access (404) and so on
  const commits = await res.json();
  return Array.isArray(commits) && commits.length > 0;
};

/** Same aggregation as the card's fetcher: bytes summed, repos counted. */
export const aggregateLanguages = (repos) => {
  const langs = {};
  for (const repo of repos) {
    for (const edge of repo.languages?.edges ?? []) {
      const { name, color } = edge.node;
      const current = langs[name] ?? { name, color, size: 0, count: 0 };
      current.size += edge.size;
      current.count += 1;
      langs[name] = current;
    }
  }
  return Object.fromEntries(Object.entries(langs).sort(([, a], [, b]) => b.size - a.size));
};

export const loadRenderer = async (coreDir) => {
  const req = createRequire(path.join(coreDir, "package.json"));
  // the package only exports its entry point (build/index.js); the renderer
  // lives next to it
  const entry = req.resolve("@stats-organization/github-readme-stats-core");
  const mod = await import(pathToFileURL(path.join(path.dirname(entry), "cards/top-languages.js")).href);
  return mod.renderTopLanguages;
};

export const collectRepos = async ({ token, login, orgs, log = () => {} }) => {
  const own = (await fetchOwnRepos(token, login)).filter((r) => !r.isArchived);
  log(`own repositories: ${own.length}`);
  const picked = [...own];
  for (const org of orgs) {
    const all = (await fetchOrgRepos(token, org)).filter((r) => !r.isArchived);
    let kept = 0;
    for (const repo of all) {
      if (await hasCommitBy(token, repo.owner.login, repo.name, login)) {
        picked.push(repo);
        kept += 1;
      }
    }
    log(`organization #${orgs.indexOf(org) + 1}: ${all.length} repositories, ${kept} with commits by the user`);
  }
  return picked;
};

const main = async () => {
  const token = process.env.GH_TOKEN;
  const login = process.env.USER;
  const orgs = (process.env.ORGS ?? "").split(/\s+/).filter(Boolean);
  const out = process.env.OUT ?? "profile/top-langs.svg";
  if (!token || !login || !process.env.CORE_DIR) {
    throw new Error("GH_TOKEN, USER and CORE_DIR are required");
  }

  const repos = await collectRepos({ token, login, orgs, log: console.log });
  const langs = aggregateLanguages(repos);
  const total = Object.values(langs).reduce((sum, l) => sum + l.size, 0);
  console.log(
    "languages: " +
      Object.values(langs)
        .map((l) => `${l.name} ${((l.size / total) * 100).toFixed(2)}%`)
        .join(", "),
  );

  const renderTopLanguages = await loadRenderer(process.env.CORE_DIR);
  // explicit colors win over the theme, like the card's own query params
  const colors = Object.fromEntries(
    [["title_color", "TITLE_COLOR"], ["text_color", "TEXT_COLOR"], ["bg_color", "BG_COLOR"], ["border_color", "BORDER_COLOR"]]
      .filter(([, env]) => process.env[env])
      .map(([key, env]) => [key, process.env[env]]),
  );
  const svg = renderTopLanguages(langs, {
    theme: process.env.THEME ?? "default",
    ...colors,
    layout: process.env.LAYOUT ?? "compact",
    langs_count: Number(process.env.LANGS_COUNT ?? 10),
    hide: (process.env.HIDE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, svg, "utf8");
  console.log(`Wrote ${out}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
