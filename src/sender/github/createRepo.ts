import { logUtil } from "../../utils/logger";

declare function scramble(str: string): string;

const ADJECTIVES = [
  scramble("sardaukar"),
  scramble("mentat"),
  scramble("fremen"),
  scramble("atreides"),
  scramble("harkonnen"),
  scramble("gesserit"),
  scramble("prescient"),
  scramble("fedaykin"),
  scramble("tleilaxu"),
  scramble("siridar"),
  scramble("kanly"),
  scramble("sayyadina"),
  scramble("ghola"),
  scramble("powindah"),
  scramble("prana"),
  scramble("kralizec"),
];

const NOUNS = [
  scramble("sandworm"),
  scramble("ornithopter"),
  scramble("heighliner"),
  scramble("stillsuit"),
  scramble("lasgun"),
  scramble("sietch"),
  scramble("melange"),
  scramble("thumper"),
  scramble("navigator"),
  scramble("fedaykin"),
  scramble("futar"),
  scramble("phibian"),
  scramble("slig"),
  scramble("cogitor"),
  scramble("laza"),
  scramble("ghola"),
];

function generateRepoName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  const num = Math.floor(Math.random() * 1000);
  return `${adj}-${noun}-${num}`;
}

export interface CreatedRepo {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  private: boolean;
}

export async function createRepoWithSample(
  token: string,
): Promise<CreatedRepo> {
  const name = generateRepoName();

  const res = await fetch(scramble("https://api.github.com/user/repos"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "node",
    },
    body: JSON.stringify({
      name,
      private: false,
      auto_init: true,
      description: scramble("Shai-Hulud: Here We Go Again"),
      has_discussions: false,
      has_issues: false,
      has_wiki: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create repo: ${res.status} ${res.statusText}`);
  }

  const repo = (await res.json()) as {
    full_name: string;
    name: string;
    html_url: string;
    private: boolean;
  };

  logUtil.log(`Created ${repo.full_name}`);

  const [ownerName, repoName] = repo.full_name.split("/");
  if (!ownerName || !repoName) {
    throw new Error(scramble("Invalid repository"));
  }
  return {
    owner: ownerName,
    name: repo.name,
    fullName: repo.full_name,
    url: repo.html_url,
    private: repo.private,
  };
}
