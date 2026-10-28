// Builds a repository ("pin") card for a repository the token can see.
//
// The stock pin card refuses private repositories. This one renders the same
// card from a direct repository query, so a private repository can be shown
// on purpose. Env: GH_TOKEN, REPO (owner/name), CORE_DIR, OUT, THEME,
// SHOW_OWNER (true/false).

import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const fetchRepo = async (token, owner, name) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "readme-stats-workflow",
    },
    body: JSON.stringify({
      query: `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          name nameWithOwner description isArchived isTemplate
          stargazerCount forkCount
          primaryLanguage { name color }
        }
      }`,
      variables: { owner, name },
    }),
  });
  const body = await res.json();
  if (!res.ok || body.errors || !body.data?.repository) {
    throw new Error(`Could not fetch the repository: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data.repository;
};

export const loadRenderer = async (coreDir) => {
  const req = createRequire(path.join(coreDir, "package.json"));
  const entry = req.resolve("@stats-organization/github-readme-stats-core");
  const mod = await import(pathToFileURL(path.join(path.dirname(entry), "cards/repo.js")).href);
  return mod.renderRepoCard;
};

const main = async () => {
  const { GH_TOKEN: token, REPO: repo, CORE_DIR: coreDir } = process.env;
  const out = process.env.OUT ?? "profile/repo.svg";
  if (!token || !repo || !coreDir || !repo.includes("/")) {
    throw new Error("GH_TOKEN, REPO (owner/name) and CORE_DIR are required");
  }
  const [owner, name] = repo.split("/");
  const data = await fetchRepo(token, owner, name);
  const renderRepoCard = await loadRenderer(coreDir);
  const svg = renderRepoCard(data, {
    theme: process.env.THEME ?? "default_repocard",
    show_owner: (process.env.SHOW_OWNER ?? "false") === "true",
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
