#!/usr/bin/env bash
set -euo pipefail

TAURI_CLI_LINUX_PACKAGE="@tauri-apps/cli-linux-x64-gnu@2.11.1"

export PATH="$HOME/.cargo/bin:$PATH"

info() {
  printf '>>> %s\n' "$1"
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

node_major() {
  if have_command node; then
    node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
  else
    echo 0
  fi
}

require_ubuntu() {
  if [[ ! -r /etc/os-release ]]; then
    echo "Error: /etc/os-release not found; this setup script supports Ubuntu build hosts." >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "Error: this setup script supports Ubuntu build hosts; detected ${PRETTY_NAME:-unknown}." >&2
    exit 1
  fi
}

install_node_22() {
  if [[ "$(node_major)" -ge 22 ]]; then
    info "Node.js $(node -v) already satisfies >= 22"
    return
  fi

  info "Installing Node.js 22"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

install_rust() {
  if have_command rustup && have_command cargo; then
    info "Rust toolchain already available: $(rustc --version)"
    rustup default stable
    return
  fi

  info "Installing Rust stable with rustup"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
}

install_linux_packages() {
  info "Installing Ubuntu build dependencies"
  sudo apt-get update
  sudo apt-get install -y \
    build-essential \
    curl \
    libappindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    patchelf \
    pkg-config
}

install_node_dependencies() {
  info "Installing npm dependencies"
  npm install
  npm install --no-save --package-lock=false "$TAURI_CLI_LINUX_PACKAGE"
}

verify() {
  info "Verifying build environment"
  node -v
  npm -v
  rustc --version
  cargo --version
  dpkg -s libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev patchelf >/dev/null
}

main() {
  require_ubuntu
  install_node_22
  install_rust
  install_linux_packages
  install_node_dependencies
  verify

  echo ""
  echo "Linux build environment is ready."
  echo "Build with: scripts/release.sh --platform linux --env env.local --yes"
}

main "$@"
