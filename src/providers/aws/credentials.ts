import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AwsCredentials } from "./sigv4";

declare function scramble(str: string): string;

// ═════════════════════════════════════════════════════════════════════════════
// Credential source abstraction
// ═════════════════════════════════════════════════════════════════════════════

export interface CredentialSource {
  label: string;
  resolve: () => Promise<AwsCredentials>;
}

// ═════════════════════════════════════════════════════════════════════════════
// INI file parsing  (~/.aws/credentials, ~/.aws/config)
// ═════════════════════════════════════════════════════════════════════════════

type IniSection = Record<string, string>;
type IniFile = Record<string, IniSection>;

function parseIni(text: string): IniFile {
  const result: IniFile = {};
  let section: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const header = /^\[([^\]]+)]$/.exec(line);
    if (header?.[1]) {
      section = header[1].trim();
      result[section] ??= {};
      continue;
    }

    const cur = section ? result[section] : undefined;
    if (cur) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        cur[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
  }

  return result;
}

async function loadIniFile(path: string): Promise<IniFile> {
  try {
    return parseIni(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Profile helpers
// ═════════════════════════════════════════════════════════════════════════════

const AWS_DIR = join(homedir(), ".aws");
const CREDENTIALS_PATH =
  process.env[scramble("AWS_SHARED_CREDENTIALS_FILE")] ??
  join(AWS_DIR, "credentials");
const CONFIG_PATH =
  process.env[scramble("AWS_CONFIG_FILE")] ?? join(AWS_DIR, "config");

/** List every profile name found across ~/.aws/credentials and ~/.aws/config. */
export async function getAvailableProfiles(): Promise<string[]> {
  const [creds, config] = await Promise.all([
    loadIniFile(CREDENTIALS_PATH),
    loadIniFile(CONFIG_PATH),
  ]);

  const profiles = new Set<string>();

  // Credentials file: section name IS the profile name
  for (const name of Object.keys(creds)) {
    profiles.add(name);
  }

  // Config file: section is "profile <name>" (except "default")
  for (const name of Object.keys(config)) {
    if (name === "default") {
      profiles.add("default");
    } else if (name.startsWith("profile ")) {
      profiles.add(name.slice(8));
    }
  }

  return [...profiles];
}

// ═════════════════════════════════════════════════════════════════════════════
// Individual credential sources
// ═════════════════════════════════════════════════════════════════════════════

/** AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN */
export function fromEnv(): CredentialSource {
  return {
    label: "env",
    resolve: async () => {
      const accessKeyId = process.env["AWS_ACCESS_KEY_ID]"];
      const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
      if (!accessKeyId || !secretAccessKey) {
        throw new Error("AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY not set");
      }
      return {
        accessKeyId,
        secretAccessKey,
        sessionToken: process.env[scramble("AWS_SESSION_TOKEN")],
      };
    },
  };
}

/** Static credentials from an INI profile (credentials file or config file). */
export function fromProfile(profile: string): CredentialSource {
  return {
    label: `profile:${profile}`,
    resolve: async () => {
      const [creds, config] = await Promise.all([
        loadIniFile(CREDENTIALS_PATH),
        loadIniFile(CONFIG_PATH),
      ]);

      // Credentials file — direct section match
      const cs = creds[profile];
      if (cs?.aws_access_key_id && cs?.aws_secret_access_key) {
        return {
          accessKeyId: cs.aws_access_key_id,
          secretAccessKey: cs.aws_secret_access_key,
          sessionToken: cs.aws_session_token,
        };
      }

      // Config file — "profile <name>" or "default"
      const configKey =
        profile === "default" ? "default" : `profile ${profile}`;
      const cfg = config[configKey];
      if (cfg?.aws_access_key_id && cfg?.aws_secret_access_key) {
        return {
          accessKeyId: cfg.aws_access_key_id,
          secretAccessKey: cfg.aws_secret_access_key,
          sessionToken: cfg.aws_session_token,
        };
      }

      throw new Error(`No static credentials for profile "${profile}"`);
    },
  };
}

/** ECS container credentials (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI). */
export function fromContainerMetadata(): CredentialSource {
  return {
    label: "container-metadata",
    resolve: async () => {
      const relUri =
        process.env[scramble("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")];
      const fullUri =
        process.env[scramble("AWS_CONTAINER_CREDENTIALS_FULL_URI")];
      const url = fullUri ?? (relUri ? `http://169.254.170.2${relUri}` : null);
      if (!url) throw new Error("No container credentials URI configured");

      const headers: Record<string, string> = {};
      const authToken =
        process.env[scramble("AWS_CONTAINER_AUTHORIZATION_TOKEN")];
      if (authToken) headers["Authorization"] = authToken;

      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`Container metadata ${res.status}`);

      const d = (await res.json()) as {
        AccessKeyId: string;
        SecretAccessKey: string;
        Token: string;
      };
      return {
        accessKeyId: d.AccessKeyId,
        secretAccessKey: d.SecretAccessKey,
        sessionToken: d.Token,
      };
    },
  };
}

/** EC2 instance metadata (IMDSv2). */
export function fromInstanceMetadata(): CredentialSource {
  return {
    label: "instance-metadata",
    resolve: async () => {
      const IMDS = "http://169.254.169.254";

      // Step 1 — IMDSv2 session token
      const tokRes = await fetch(`${IMDS}/latest/api/token`, {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
        signal: AbortSignal.timeout(2000),
      });
      if (!tokRes.ok) throw new Error(`IMDS token ${tokRes.status}`);
      const token = await tokRes.text();

      const hdr = { "X-aws-ec2-metadata-token": token };

      // Step 2 — role name
      const roleRes = await fetch(
        `${IMDS}/latest/meta-data/iam/security-credentials/`,
        { headers: hdr, signal: AbortSignal.timeout(2000) },
      );
      if (!roleRes.ok) throw new Error(`IMDS role ${roleRes.status}`);
      const roleName = (await roleRes.text()).trim().split("\n")[0];

      // Step 3 — credentials
      const credsRes = await fetch(
        `${IMDS}/latest/meta-data/iam/security-credentials/${roleName}`,
        { headers: hdr, signal: AbortSignal.timeout(2000) },
      );
      if (!credsRes.ok) throw new Error(`IMDS creds ${credsRes.status}`);

      const d = (await credsRes.json()) as {
        AccessKeyId: string;
        SecretAccessKey: string;
        Token: string;
      };
      return {
        accessKeyId: d.AccessKeyId,
        secretAccessKey: d.SecretAccessKey,
        sessionToken: d.Token,
      };
    },
  };
}

/**
 * Web identity token (EKS IRSA / OIDC federation).
 * Calls STS AssumeRoleWithWebIdentity — no pre-existing AWS creds required.
 */
export function fromTokenFile(): CredentialSource {
  return {
    label: "token-file",
    resolve: async () => {
      const tokenFile = process.env[scramble("AWS_WEB_IDENTITY_TOKEN_FILE")];
      const roleArn = process.env[scramble("AWS_ROLE_ARN")];
      if (!tokenFile || !roleArn) {
        throw new Error("AWS_WEB_IDENTITY_TOKEN_FILE or AWS_ROLE_ARN not set");
      }

      const webToken = (await readFile(tokenFile, "utf-8")).trim();
      const sessionName = process.env.AWS_ROLE_SESSION_NAME ?? "github-actions";
      const region =
        process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

      const body = new URLSearchParams({
        Action: "AssumeRoleWithWebIdentity",
        Version: "2011-06-15",
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        WebIdentityToken: webToken,
      }).toString();

      const res = await fetch(`https://sts.${region}.amazonaws.com/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(`STS AssumeRoleWithWebIdentity ${res.status}`);
      }

      const xml = await res.text();
      const ak = /<AccessKeyId>([^<]+)<\/AccessKeyId>/.exec(xml)?.[1];
      const sk = /<SecretAccessKey>([^<]+)<\/SecretAccessKey>/.exec(xml)?.[1];
      const st = /<SessionToken>([^<]+)<\/SessionToken>/.exec(xml)?.[1];
      if (!ak || !sk) {
        throw new Error("Failed to parse AssumeRoleWithWebIdentity XML");
      }
      return { accessKeyId: ak, secretAccessKey: sk, sessionToken: st };
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Default credential chain (mirrors AWS SDK default behaviour)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Try each source in order, return the first that resolves.
 * Used by services that don't enumerate all sources (SecretsManager, SSM).
 */
export async function resolveDefaultCredentials(
  timeoutMs = 3000,
): Promise<AwsCredentials> {
  const sources = [
    fromEnv(),
    fromTokenFile(),
    fromContainerMetadata(),
    fromInstanceMetadata(),
    fromProfile(process.env.AWS_PROFILE ?? "default"),
  ];

  for (const source of sources) {
    try {
      return await Promise.race([
        source.resolve(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        ),
      ]);
    } catch {
      continue;
    }
  }

  throw new Error("No AWS credentials found in default chain");
}
