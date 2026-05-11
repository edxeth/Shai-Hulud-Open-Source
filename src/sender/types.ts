export type SenderName = "github" | "domain" | "session";

export type SenderDestination = {
  domain: string;
  port: number;
  path: string;
  dry_run?: boolean;
};

export type EncryptedPackage = {
  key: string;
  envelope: string;
  token?: string;
};

export type SendPackage = {
  sender: SenderName;
  envelope: EncryptedPackage;
};
