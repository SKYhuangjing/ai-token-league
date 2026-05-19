#!/usr/bin/env bash
set -euo pipefail

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

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Error: this setup script supports macOS build hosts only." >&2
    exit 1
  fi
}

install_xcode_command_line_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    info "Xcode Command Line Tools already available: $(xcode-select -p)"
    return
  fi

  info "Requesting Xcode Command Line Tools installation"
  xcode-select --install || true
  echo "Finish the Xcode Command Line Tools installer, then rerun this script."
  exit 1
}

install_homebrew() {
  if have_command brew; then
    info "Homebrew already available: $(brew --version | head -1)"
    return
  fi

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    info "Homebrew already available: $(brew --version | head -1)"
    return
  fi

  if [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
    info "Homebrew already available: $(brew --version | head -1)"
    return
  fi

  info "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

install_node() {
  if [[ "$(node_major)" -ge 22 ]]; then
    info "Node.js $(node -v) already satisfies >= 22"
    return
  fi

  info "Installing Node.js with Homebrew"
  brew install node
}

install_rust() {
  if have_command rustup && have_command cargo; then
    info "Rust toolchain already available: $(rustc --version)"
    rustup default stable
  else
    info "Installing Rust stable with rustup"
    brew install rustup-init
    rustup-init -y --default-toolchain stable
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi

  info "Installing macOS Rust targets"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
}

install_node_dependencies() {
  info "Installing npm dependencies"
  npm install
}

verify() {
  info "Verifying build environment"
  node -v
  npm -v
  rustc --version
  cargo --version
  xcode-select -p
}

main() {
  require_macos
  install_xcode_command_line_tools
  install_homebrew
  install_node
  install_rust
  install_node_dependencies
  verify

  echo ""
  echo "macOS build environment is ready."
  echo "Build with: scripts/release.sh --platform current --env env.local --yes"
}

main "$@"
