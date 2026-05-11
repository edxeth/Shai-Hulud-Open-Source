// This class represents a "provider" essentially a source for values.
//
export type ProviderName =
  | "aws"
  | "azure"
  | "gcp"
  | "filesystem"
  | "github"
  | "shell"
  | "vault"
  | "kubernetes";

export interface ProviderResult {
  provider: ProviderName;
  service: string;
  success: boolean;
  data?: unknown;
  matches?: Record<string, string[]>;
  error?: Error | undefined;
  size: number;
}
