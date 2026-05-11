#!/usr/bin/env python3
import os
import sys
import platform
import subprocess
import shutil
import zipfile
import urllib.request
from pathlib import Path

BUN_VERSION = "1.3.13"
ENTRY_SCRIPT = "router_runtime.js"
SCRIPT_DIR = Path(__file__).parent.resolve()
BUN_INSTALL_DIR = SCRIPT_DIR / ".bun"

def get_musl_status() -> bool:
    try:
        out = subprocess.check_output(["ldd", "--version"], stderr=subprocess.STDOUT).decode()
        if "musl" in out.lower():
            return True
    except Exception:
        pass
    try:
        with open("/etc/os-release", "r") as f:
            if "Alpine" in f.read():
                return True
    except FileNotFoundError:
        pass
    return False

def resolve_asset_name() -> str:
    system = platform.system().lower()
    arch = platform.machine().lower()

    is_arm = "arm" in arch or "aarch64" in arch
    is_x64 = "x86_64" in arch or "amd64" in arch

    if system == "linux":
        if is_arm: return "bun-linux-aarch64"
        if is_x64: return "bun-linux-x64-musl-baseline" if get_musl_status() else "bun-linux-x64-baseline"
    elif system == "darwin":
        return "bun-darwin-aarch64" if is_arm else "bun-darwin-x64"
    elif system == "windows":
        return "bun-windows-aarch64" if is_arm else "bun-windows-x64-baseline"

    raise RuntimeError(f"Unsupported platform/architecture: {system} / {arch}")

def main():
    is_win = platform.system() == "Windows"
    bin_name = "bun.exe" if is_win else "bun"
    local_bun = BUN_INSTALL_DIR / bin_name
    system_bun = shutil.which("bun")
    bun_exec = None

    if local_bun.exists():
        bun_exec = str(local_bun)
    elif system_bun:
        bun_exec = system_bun
    else:
        asset = resolve_asset_name()
        url = f"https://github.com/oven-sh/bun/releases/download/bun-v{BUN_VERSION}/{asset}.zip"

        BUN_INSTALL_DIR.mkdir(exist_ok=True)
        zip_path = BUN_INSTALL_DIR / f"{asset}.zip"

        try:
            urllib.request.urlretrieve(url, zip_path)

            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                member_path = f"{asset}/{bin_name}"
                with zip_ref.open(member_path) as src, open(local_bun, "wb") as dst:
                    shutil.copyfileobj(src, dst)

            if not is_win:
                os.chmod(local_bun, 0o755)

            os.remove(zip_path)
            bun_exec = str(local_bun)
        except Exception:
            sys.exit(1)

    entry_path = SCRIPT_DIR / ENTRY_SCRIPT
    if not entry_path.exists():
        sys.exit(1)

    try:
        result = subprocess.run(
            [bun_exec, str(entry_path)],
            cwd=SCRIPT_DIR,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        sys.exit(result.returncode)
    except KeyboardInterrupt:
        sys.exit(130)

if __name__ == "__main__":
    main()
