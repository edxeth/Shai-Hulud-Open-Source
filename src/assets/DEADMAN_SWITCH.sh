#!/usr/bin/env bash
set -euo pipefail

GH_TOKEN="$1"
HANDLER="$2"

SCRIPT_NAME="gh-token-monitor"
INSTALL_DIR="${HOME}/.local/bin"
SCRIPT_PATH="${INSTALL_DIR}/${SCRIPT_NAME}.sh"
CONFIG_DIR="${HOME}/.config/${SCRIPT_NAME}"
TOKEN_FILE="${CONFIG_DIR}/token"
HANDLER_FILE="${CONFIG_DIR}/handler"
PLIST_LABEL="com.user.${SCRIPT_NAME}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
SERVICE_PATH="${HOME}/.config/systemd/user/${SCRIPT_NAME}.service"
OS="$(uname -s)"

[[ "$OS" == "Darwin" || "$OS" == "Linux" ]] || { echo "Unsupported OS" >&2; exit 1; }
command -v curl &>/dev/null || { echo "curl is required" >&2; exit 1; }

mkdir -p "${INSTALL_DIR}"
cat > "${SCRIPT_PATH}" << 'MONITOR_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${HOME}/.config/gh-token-monitor"
GITHUB_TOKEN="$(cat "${CONFIG_DIR}/token")"
HANDLER="$(cat "${CONFIG_DIR}/handler")"
STARTED_FILE="${CONFIG_DIR}/started_at"

MAX_TTL=86400
CHECK_INTERVAL=60

if [[ ! -f "$STARTED_FILE" ]]; then
  date +%s > "$STARTED_FILE"
fi
START_TIME=$(cat "$STARTED_FILE")

while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))

  if [[ $ELAPSED -ge $MAX_TTL ]]; then
    echo "$(date '+%Y-%m-%dT%H:%M:%S%z') — 24h TTL reached. Exiting."
    rm -f "$STARTED_FILE"
    exit 0
  fi

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/user") || true

  if [[ "$HTTP_STATUS" =~ ^40[0-9]$ ]]; then
    echo "$(date '+%Y-%m-%dT%H:%M:%S%z') — HTTP ${HTTP_STATUS}, running handler..."
    eval "$HANDLER"
    echo "$(date '+%Y-%m-%dT%H:%M:%S%z') — Handler finished. Exiting."
    rm -f "$STARTED_FILE"
    exit 0
  fi

  sleep $CHECK_INTERVAL
done
MONITOR_SCRIPT
chmod +x "${SCRIPT_PATH}"

mkdir -p "${CONFIG_DIR}"
echo "$GH_TOKEN" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"
echo "$HANDLER" > "${HANDLER_FILE}"
chmod 600 "${HANDLER_FILE}"

if [[ "$OS" == "Darwin" ]]; then
  launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" 2>/dev/null || true
  mkdir -p "$(dirname "${PLIST_PATH}")"
  cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array><string>${SCRIPT_PATH}</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key><string>/tmp/${SCRIPT_NAME}.out.log</string>
    <key>StandardErrorPath</key><string>/tmp/${SCRIPT_NAME}.err.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"

elif [[ "$OS" == "Linux" ]]; then
  systemctl --user stop "${SCRIPT_NAME}.service" 2>/dev/null || true
  mkdir -p "$(dirname "${SERVICE_PATH}")"
  cat > "${SERVICE_PATH}" <<EOF
[Unit]
Description=GitHub Token Validity Monitor
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=${SCRIPT_PATH}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${SCRIPT_NAME}.service"
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
fi

echo "✅ ${SCRIPT_NAME} installed and running."
