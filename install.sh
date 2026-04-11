#!/usr/bin/env sh
# wairon installer for Linux / macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/SYW-Apps/Waffle-AIron/main/install.sh | sh

set -eu

REPO="SYW-Apps/Waffle-AIron"
BIN_NAME="wairon"
INSTALL_DIR="${WAIRON_INSTALL_DIR:-$HOME/.local/bin}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()    { printf "\033[0;36m%s\033[0m\n" "$1"; }
success() { printf "\033[0;32m%s\033[0m\n" "$1"; }
warn()    { printf "\033[0;33m%s\033[0m\n" "$1"; }
error()   { printf "\033[0;31mError: %s\033[0m\n" "$1" >&2; exit 1; }

need_cmd() {
    if ! command -v "$1" > /dev/null 2>&1; then
        error "Required command not found: $1"
    fi
}

# ---------------------------------------------------------------------------
# Detect OS and arch
# ---------------------------------------------------------------------------

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$OS" in
        linux)  PLATFORM="linux" ;;
        darwin) PLATFORM="macos" ;;
        *)      error "Unsupported OS: $OS" ;;
    esac

    case "$ARCH" in
        x86_64 | amd64) ARCH_LABEL="x64" ;;
        aarch64 | arm64) ARCH_LABEL="arm64" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac
}

# ---------------------------------------------------------------------------
# Fetch latest release version from GitHub API
# ---------------------------------------------------------------------------

fetch_latest_version() {
    need_cmd curl

    RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
    VERSION=$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')

    if [ -z "$VERSION" ]; then
        error "Could not determine latest version from GitHub API."
    fi
}

# ---------------------------------------------------------------------------
# Download and install
# ---------------------------------------------------------------------------

main() {
    info "wairon installer"
    printf "\n"

    need_cmd curl
    need_cmd tar

    detect_platform
    fetch_latest_version

    VERSION_NUM="${VERSION#v}"
    ASSET_NAME="wairon-${VERSION_NUM}-${PLATFORM}-${ARCH_LABEL}.tar.gz"
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"

    info "Latest version: $VERSION"
    info "Downloading $ASSET_NAME..."

    TMP_DIR=$(mktemp -d)
    TMP_FILE="${TMP_DIR}/${ASSET_NAME}"

    curl -fsSL --output "$TMP_FILE" "$DOWNLOAD_URL" || error "Download failed: $DOWNLOAD_URL"

    # Extract
    tar -xzf "$TMP_FILE" -C "$TMP_DIR"

    EXTRACTED_BIN="${TMP_DIR}/${BIN_NAME}"
    if [ ! -f "$EXTRACTED_BIN" ]; then
        error "Extracted binary not found at $EXTRACTED_BIN"
    fi

    # Install
    mkdir -p "$INSTALL_DIR"
    install -m 755 "$EXTRACTED_BIN" "${INSTALL_DIR}/${BIN_NAME}"

    rm -rf "$TMP_DIR"

    success "Installed to: ${INSTALL_DIR}/${BIN_NAME}"

    # PATH notice
    case ":${PATH}:" in
        *":${INSTALL_DIR}:"*)
            # Already on PATH
            ;;
        *)
            warn ""
            warn "${INSTALL_DIR} is not on your PATH."
            warn "Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
            warn ""
            warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
            warn ""
            ;;
    esac

    # Record the install directory in ~/.wairon/config.json
    WAIRON_CFG_DIR="$HOME/.wairon"
    WAIRON_CFG_FILE="$WAIRON_CFG_DIR/config.json"
    mkdir -p "$WAIRON_CFG_DIR"
    if [ -f "$WAIRON_CFG_FILE" ]; then
        # Preserve existing config, just update/add installDir
        # Simple sed approach — avoids requiring jq
        if grep -q '"installDir"' "$WAIRON_CFG_FILE" 2>/dev/null; then
            sed -i.bak "s|\"installDir\":[^,}]*|\"installDir\": \"${INSTALL_DIR}\"|" "$WAIRON_CFG_FILE" && rm -f "${WAIRON_CFG_FILE}.bak"
        else
            # Append before closing brace
            sed -i.bak "s|}$|,\n  \"installDir\": \"${INSTALL_DIR}\"\n}|" "$WAIRON_CFG_FILE" && rm -f "${WAIRON_CFG_FILE}.bak"
        fi
    else
        printf '{\n  "installDir": "%s"\n}\n' "$INSTALL_DIR" > "$WAIRON_CFG_FILE"
    fi

    # Create aliases: wai → wairon (symlink)
    # Read disabled aliases from config if jq is available, otherwise default to none
    DISABLED_ALIASES=""
    if command -v jq > /dev/null 2>&1 && [ -f "$WAIRON_CFG_FILE" ]; then
        DISABLED_ALIASES=$(jq -r '(.disabledAliases // []) | join(" ")' "$WAIRON_CFG_FILE" 2>/dev/null || echo "")
    fi

    for ALIAS in wai; do
        case " $DISABLED_ALIASES " in
            *" $ALIAS "*) info "Alias $ALIAS is disabled — skipping."; continue ;;
        esac

        ALIAS_PATH="${INSTALL_DIR}/${ALIAS}"
        EXISTING=$(command -v "$ALIAS" 2>/dev/null || true)

        if [ -n "$EXISTING" ] && [ "$EXISTING" != "$ALIAS_PATH" ]; then
            warn "  $ALIAS already exists at $EXISTING — skipping (run 'wairon aliases enable $ALIAS' to override)"
        else
            ln -sf "${INSTALL_DIR}/wairon" "$ALIAS_PATH"
            chmod +x "$ALIAS_PATH"
            info "  Created alias: $ALIAS_PATH"
        fi
    done

    printf "\n"
    success "wairon ${VERSION} installed successfully!"
    info "Run: wairon --help  (or: wai --help)"
}

main
