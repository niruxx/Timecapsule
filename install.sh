#!/usr/bin/env bash
#
# TimeCapsule installer for Linux.
#
# Sets up everything TimeCapsule needs to run - Node.js, the system libraries headless Chromium
# depends on, the npm dependencies - and (optionally) registers it as a systemd service so it
# starts on boot and restarts itself if it crashes.
#
# Safe to re-run: every step checks what's already done first, and nothing here ever touches
# archived/, data/, bin/ or traffic.log.
#
#   bash install.sh                 interactive
#   bash install.sh --yes           accept every default, ask nothing
#   bash install.sh --help          all options
#
set -Eeuo pipefail

SERVICE_NAME="timecapsule"
NODE_MIN_MAJOR=18
NODE_INSTALL_MAJOR="${NODE_MAJOR:-22}" # only used if Node has to be installed; override: NODE_MAJOR=24 bash install.sh

ASSUME_YES=0
DRY_RUN=0
SKIP_DEPS=0
NO_START=0
SERVICE_MODE="" # system | user | none ("" = ask)
PORT_CHOICE=""

PM=""             # apt | dnf | yum | pacman | "" (unknown)
SUDO_READY=0
BROWSER_OK=1
PROJECT_DIR=""
NODE_BIN=""
RUN_USER=""
RUN_GROUP=""
CONFIG_PORT=""
UNIT_INSTALLED=""  # system | user | "" - which kind of unit ended up installed

# ---------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s+%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '\n%sError:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# Only the top-level shell reports (a failing command inside $(...) also trips the inherited trap in
# its subshell, which would otherwise print the message twice).
on_error() {
  [[ "$BASHPID" == "$$" ]] || return 0
  printf '\n%sInstall stopped unexpectedly (line %s). Nothing has been deleted; it is safe to re-run.%s\n' "$C_RED" "$1" "$C_RESET" >&2
}
trap 'on_error $LINENO' ERR

usage() {
  cat <<'EOF'
TimeCapsule installer for Linux

Usage: bash install.sh [options]

  -y, --yes            Answer "yes" to every question and use every default (non-interactive)
      --port N         Port the server should listen on (default: PORT in config.js)
      --service MODE   system  - systemd service, starts at boot (needs sudo)
                       user    - systemd user service (no root; optional "linger" for boot start)
                       none    - don't set up a service
                       (default: ask; with --yes, "system" if sudo is available, else "user")
      --skip-deps      Don't install Node.js or system libraries (you've already done that)
      --no-start       Set the service up and enable it, but don't start it now
      --dry-run        Print what would be done without changing anything
  -h, --help           Show this help

Environment:
  NODE_MAJOR           Node.js major version to install if none is found (default: 22)

Your archives (archived/), search index and settings (data/), yt-dlp binary (bin/) and
traffic.log are never modified or removed by this script.
EOF
}

# ---------------------------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------------------------

is_interactive() { [[ -t 0 && -t 1 ]]; }

# ask_yes_no "Question?" y|n  ->  exit status 0 for yes. --yes answers yes to everything; with no
# terminal to ask on, the default answer is used.
ask_yes_no() {
  local question="$1" default="${2:-y}" reply hint
  if (( ASSUME_YES )); then return 0; fi
  if ! is_interactive; then
    if [[ "$default" == y ]]; then return 0; else return 1; fi
  fi
  if [[ "$default" == y ]]; then hint="[Y/n]"; else hint="[y/N]"; fi
  read -r -p "    $question $hint " reply || reply=""
  reply="${reply:-$default}"
  if [[ "$reply" =~ ^[Yy] ]]; then return 0; else return 1; fi
}

# Runs a command, or just prints it under --dry-run.
run() {
  if (( DRY_RUN )); then
    printf '    %s[dry-run]%s %s\n' "$C_DIM" "$C_RESET" "$*"
    return 0
  fi
  "$@"
}

# Makes sure `sudo` works before a step that needs it, so a password prompt shows up at a
# predictable moment instead of in the middle of package-manager output.
need_sudo() {
  if (( SUDO_READY )); then return 0; fi
  command -v sudo >/dev/null 2>&1 || return 1
  if (( DRY_RUN )); then SUDO_READY=1; return 0; fi
  info "Administrator access is needed for the next step (sudo may ask for your password)."
  sudo -v || return 1
  SUDO_READY=1
}

have_systemd() { [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; }

# ---------------------------------------------------------------------------------------------
# Argument parsing and preflight
# ---------------------------------------------------------------------------------------------

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes)     ASSUME_YES=1 ;;
      --skip-deps)  SKIP_DEPS=1 ;;
      --no-start)   NO_START=1 ;;
      --dry-run)    DRY_RUN=1 ;;
      -h|--help)    usage; exit 0 ;;
      --port)       [[ $# -ge 2 ]] || die "--port needs a value"; PORT_CHOICE="$2"; shift ;;
      --port=*)     PORT_CHOICE="${1#*=}" ;;
      --service)    [[ $# -ge 2 ]] || die "--service needs a value (system, user or none)"; SERVICE_MODE="$2"; shift ;;
      --service=*)  SERVICE_MODE="${1#*=}" ;;
      *)            die "Unknown option: $1 (try --help)" ;;
    esac
    shift
  done

  case "$SERVICE_MODE" in
    ""|system|user|none) ;;
    *) die "--service must be one of: system, user, none" ;;
  esac
}

preflight() {
  step "Checking your environment"

  [[ "$(uname -s)" == "Linux" ]] || die "This installer only supports Linux (found: $(uname -s))."

  if (( EUID == 0 )); then
    die "Please run this as a regular user, not root.
    Headless Chromium refuses to start as root without disabling its sandbox, and the service
    shouldn't run as root anyway. The script uses sudo itself for the few steps that need it.
    On a fresh server, create a user first, e.g.:  adduser timecapsule && su - timecapsule"
  fi

  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  [[ -f "$PROJECT_DIR/package.json" && -f "$PROJECT_DIR/server.js" ]] \
    || die "This doesn't look like a TimeCapsule checkout (package.json / server.js not found next to install.sh)."
  [[ -w "$PROJECT_DIR" ]] || die "$PROJECT_DIR isn't writable by $(id -un)."

  # These end up inside a systemd unit file, where whitespace and % have special meaning.
  case "$PROJECT_DIR" in
    *[[:space:]]*|*%*|*'$'*|*'"'*|*"'"*|*'\'*)
      die "The install path contains a space or a special character ($PROJECT_DIR).
    systemd unit files don't cope with that - move the checkout somewhere simpler, e.g. ~/timecapsule."
      ;;
  esac

  RUN_USER="$(id -un)"
  # A primary group with no name (containers, flaky LDAP) makes `id -gn` fail; the numeric id works in a unit's Group=
  RUN_GROUP="$(id -gn 2>/dev/null || id -g)"
  cd "$PROJECT_DIR"

  ok "Linux, running as $RUN_USER"
  ok "Install directory: $PROJECT_DIR"
  if (( DRY_RUN )); then warn "Dry run - nothing will be changed."; fi
}

# ---------------------------------------------------------------------------------------------
# System packages (git, curl, and the libraries headless Chromium needs)
# ---------------------------------------------------------------------------------------------

# Chromium's runtime dependencies - the same list as the README's Requirements section, plus the
# handful (pango/cairo/X11) that are normally pulled in transitively but cost nothing to name.
APT_PKGS=(git curl ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0
          libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0
          libcairo2 libx11-6 libxcb1 libxext6 libxcomposite1 libxdamage1 libxfixes3
          libxkbcommon0 libxrandr2 xdg-utils)
RPM_PKGS=(git curl ca-certificates alsa-lib atk at-spi2-atk cups-libs gtk3 libdrm libXcomposite
          libXdamage libXfixes libXrandr libxkbcommon mesa-libgbm nspr nss pango cairo
          liberation-fonts xdg-utils)
PACMAN_PKGS=(git curl ca-certificates nss nspr atk at-spi2-core cups libdrm gtk3 alsa-lib
             libxcomposite libxdamage libxfixes libxkbcommon libxrandr mesa pango cairo
             ttf-liberation xdg-utils)

detect_pkg_manager() {
  if   command -v apt-get >/dev/null 2>&1; then PM=apt
  elif command -v dnf     >/dev/null 2>&1; then PM=dnf
  elif command -v yum     >/dev/null 2>&1; then PM=yum
  elif command -v pacman  >/dev/null 2>&1; then PM=pacman
  else PM=""
  fi
}

apt_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q '^install ok installed'; }

# Debian/Ubuntu renamed a batch of library packages with a "t64" suffix (Ubuntu 24.04, Debian 13);
# pick whichever spelling this system actually has. Prints nothing if neither exists.
apt_pick() {
  local pkg="$1"
  if   apt-cache show "${pkg}t64" >/dev/null 2>&1; then printf '%s' "${pkg}t64"
  elif apt-cache show "$pkg"      >/dev/null 2>&1; then printf '%s' "$pkg"
  fi
}

APT_MISSING=()
APT_UNAVAILABLE=()
apt_resolve() {
  APT_MISSING=(); APT_UNAVAILABLE=()
  local pkg name
  for pkg in "${APT_PKGS[@]}"; do
    name="$(apt_pick "$pkg")"
    if [[ -z "$name" ]]; then APT_UNAVAILABLE+=("$pkg"); continue; fi
    apt_installed "$name" || APT_MISSING+=("$name")
  done
}

install_system_packages() {
  step "Installing system packages"
  detect_pkg_manager

  local -a missing=()
  case "$PM" in
    apt)
      apt_resolve
      if (( ${#APT_UNAVAILABLE[@]} )); then
        # Most likely just stale/empty package lists (fresh image) - refresh once and look again.
        if need_sudo; then
          info "Refreshing package lists..."
          run sudo apt-get update
          apt_resolve
        fi
        (( ${#APT_UNAVAILABLE[@]} == 0 )) || warn "Not available on this system, skipping: ${APT_UNAVAILABLE[*]}"
      fi
      missing=(${APT_MISSING[@]+"${APT_MISSING[@]}"})
      ;;
    dnf|yum)
      local pkg
      for pkg in "${RPM_PKGS[@]}"; do rpm -q "$pkg" >/dev/null 2>&1 || missing+=("$pkg"); done
      ;;
    pacman)
      local pkg
      for pkg in "${PACMAN_PKGS[@]}"; do pacman -Qi "$pkg" >/dev/null 2>&1 || missing+=("$pkg"); done
      ;;
    *)
      warn "No supported package manager found (apt, dnf, yum, pacman)."
      warn "Install git, curl and Chromium's shared libraries yourself (see the README's Requirements), then re-run with --skip-deps."
      return 0
      ;;
  esac

  if (( ${#missing[@]} == 0 )); then
    ok "All required system packages are already installed"
    return 0
  fi

  info "Missing: ${missing[*]}"
  if ! ask_yes_no "Install them now?" y; then
    warn "Skipped. If Chromium later fails to start, this is the first place to look."
    return 0
  fi
  need_sudo || die "sudo isn't available. Install the packages above as an administrator, then re-run with --skip-deps."

  # A failure here shouldn't abort the whole install: one unavailable package name on an unusual
  # distro isn't fatal, and verify_browser below reports whether Chromium actually works.
  case "$PM" in
    apt)     run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" || warn "apt-get reported a problem - continuing; the Chromium check below will say if it matters." ;;
    dnf)     run sudo dnf install -y "${missing[@]}"                                        || warn "dnf reported a problem - continuing; the Chromium check below will say if it matters." ;;
    yum)     run sudo yum install -y "${missing[@]}"                                        || warn "yum reported a problem - continuing; the Chromium check below will say if it matters." ;;
    pacman)  run sudo pacman -S --needed --noconfirm "${missing[@]}"                        || warn "pacman reported a problem - continuing; the Chromium check below will say if it matters." ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Node.js
# ---------------------------------------------------------------------------------------------

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

node_is_usable() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && (( $(node_major) >= NODE_MIN_MAJOR ))
}

install_node() {
  info "Node.js $NODE_MIN_MAJOR or newer is required, and it isn't installed (or is too old)."
  detect_pkg_manager
  case "$PM" in
    apt)
      info "Will install Node.js $NODE_INSTALL_MAJOR from NodeSource (https://github.com/nodesource/distributions)."
      ask_yes_no "Go ahead?" y || die "Node.js is required. Install it (https://nodejs.org/) and re-run."
      need_sudo || die "sudo isn't available. Install Node.js $NODE_MIN_MAJOR+ yourself and re-run."
      if (( DRY_RUN )); then
        info "[dry-run] curl -fsSL https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x | sudo -E bash -"
      else
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | sudo -E bash -
      fi
      run sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
      ;;
    dnf|yum)
      info "Will install Node.js $NODE_INSTALL_MAJOR from NodeSource (https://github.com/nodesource/distributions)."
      ask_yes_no "Go ahead?" y || die "Node.js is required. Install it (https://nodejs.org/) and re-run."
      need_sudo || die "sudo isn't available. Install Node.js $NODE_MIN_MAJOR+ yourself and re-run."
      if (( DRY_RUN )); then
        info "[dry-run] curl -fsSL https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x | sudo bash -"
      else
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_INSTALL_MAJOR}.x" | sudo bash -
      fi
      run sudo "$PM" install -y nodejs
      ;;
    pacman)
      info "Will install Node.js and npm with pacman."
      ask_yes_no "Go ahead?" y || die "Node.js is required. Install it and re-run."
      need_sudo || die "sudo isn't available. Install Node.js $NODE_MIN_MAJOR+ yourself and re-run."
      run sudo pacman -S --needed --noconfirm nodejs npm
      ;;
    *)
      die "Can't install Node.js automatically on this system. Install Node.js $NODE_MIN_MAJOR+ from https://nodejs.org/ and re-run."
      ;;
  esac
}

ensure_node() {
  step "Checking Node.js"
  if node_is_usable; then
    ok "Node.js $(node -v) / npm $(npm -v)"
  else
    if (( SKIP_DEPS )); then
      die "Node.js $NODE_MIN_MAJOR+ with npm is required (--skip-deps was given, so it wasn't installed)."
    fi
    install_node
    if (( DRY_RUN )); then NODE_BIN="/usr/bin/node"; return 0; fi
    hash -r
    node_is_usable || die "Node.js $NODE_MIN_MAJOR+ (with npm) still isn't available after installing. Check the output above."
    ok "Node.js $(node -v) / npm $(npm -v)"
  fi

  NODE_BIN="$(command -v node || true)"
  if [[ "$NODE_BIN" == *"/.nvm/"* ]]; then
    warn "Node.js is managed by nvm ($NODE_BIN). The service will pin this exact version;"
    warn "if you switch Node versions later, re-run install.sh so the service picks up the new path."
  fi
}

# ---------------------------------------------------------------------------------------------
# Application dependencies
# ---------------------------------------------------------------------------------------------

install_npm_deps() {
  step "Installing TimeCapsule's dependencies"
  info "First install downloads a copy of Chromium for Puppeteer (~150 MB) - this can take a few minutes."
  if [[ -f package-lock.json ]]; then
    run npm ci --no-audit --no-fund || {
      warn "npm ci failed (lockfile out of sync?) - retrying with npm install"
      run npm install --no-audit --no-fund
    }
  else
    run npm install --no-audit --no-fund
  fi
  if (( ! DRY_RUN )); then ok "Dependencies installed"; fi
}

verify_browser() {
  step "Checking that headless Chromium can start"
  if (( DRY_RUN )); then info "[dry-run] would launch headless Chromium once to verify its system libraries"; return 0; fi

  local chrome_path output
  chrome_path="$(node -e "process.stdout.write(require('puppeteer').executablePath())" 2>/dev/null || true)"
  if [[ -z "$chrome_path" || ! -x "$chrome_path" ]]; then
    warn "Puppeteer's Chromium wasn't downloaded (an install-script guard, or a blocked download?) - fetching it now."
    npx --yes puppeteer browsers install chrome || warn "Couldn't download Chromium. Try:  npx puppeteer browsers install chrome"
    chrome_path="$(node -e "process.stdout.write(require('puppeteer').executablePath())" 2>/dev/null || true)"
  fi

  if output="$(node -e "
    const puppeteer = require('puppeteer');
    puppeteer.launch({ headless: 'new' })
      .then((browser) => browser.close())
      .then(() => process.exit(0), (err) => { console.error(err.message || err); process.exit(1); });
  " 2>&1)"; then
    BROWSER_OK=1
    ok "Chromium starts fine"
    return 0
  fi

  BROWSER_OK=0
  warn "Chromium failed to start:"
  printf '%s\n' "$output" | sed -n '1,8s/^/          /p' >&2

  if [[ -n "$chrome_path" && -x "$chrome_path" ]] && command -v ldd >/dev/null 2>&1; then
    local missing_libs
    missing_libs="$(ldd "$chrome_path" 2>/dev/null | grep 'not found' || true)"
    if [[ -n "$missing_libs" ]]; then
      warn "Shared libraries Chromium needs but can't find:"
      printf '%s\n' "$missing_libs" | sed 's/^/          /' >&2
    fi
  fi
  if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" == "1" ]]; then
    warn "This system restricts unprivileged user namespaces (AppArmor, Ubuntu 23.10+), which blocks Chromium's sandbox."
    warn "It needs an AppArmor profile - see the 'Chrome doesn't launch on Linux' section at https://pptr.dev/troubleshooting"
  fi
  warn "TimeCapsule can't archive anything until this is fixed. The rest of the install will continue."
}

# ---------------------------------------------------------------------------------------------
# Port + systemd service
# ---------------------------------------------------------------------------------------------

choose_port() {
  local default reply
  default="$(node -p "require('./config').PORT || 3000" 2>/dev/null || echo 3000)"
  CONFIG_PORT="$default"

  if [[ -z "$PORT_CHOICE" ]]; then
    if is_interactive && (( ! ASSUME_YES )); then
      read -r -p "    Port to listen on [$default]: " reply || reply=""
      PORT_CHOICE="${reply:-$default}"
    else
      PORT_CHOICE="$default"
    fi
  fi

  # 10# stops a value like "0800" being read as (invalid) octal
  [[ "$PORT_CHOICE" =~ ^[0-9]{1,5}$ ]] && (( 10#$PORT_CHOICE >= 1 && 10#$PORT_CHOICE <= 65535 )) \
    || die "'$PORT_CHOICE' isn't a valid port (1-65535)."
  PORT_CHOICE=$(( 10#$PORT_CHOICE ))
}

# Prints a systemd unit for the given kind (system|user). The port is only written into the unit
# when it differs from config.js - otherwise config.js stays the single source of truth.
render_unit() {
  local kind="$1"
  printf '[Unit]\n'
  printf 'Description=TimeCapsule - self-hosted web archiver\n'
  if [[ "$kind" == system ]]; then
    printf 'After=network-online.target\n'
    printf 'Wants=network-online.target\n'
  fi
  printf '\n[Service]\n'
  printf 'Type=simple\n'
  if [[ "$kind" == system ]]; then
    printf 'User=%s\n' "$RUN_USER"
    printf 'Group=%s\n' "$RUN_GROUP"
  fi
  printf 'WorkingDirectory=%s\n' "$PROJECT_DIR"
  printf 'ExecStart=%s %s/server.js\n' "$NODE_BIN" "$PROJECT_DIR"
  if [[ "$PORT_CHOICE" != "$CONFIG_PORT" ]]; then
    printf 'Environment=PORT=%s\n' "$PORT_CHOICE"
  fi
  if [[ "$kind" == system ]] && (( PORT_CHOICE < 1024 )); then
    printf 'AmbientCapabilities=CAP_NET_BIND_SERVICE\n'
  fi
  printf 'Restart=on-failure\n'
  printf 'RestartSec=5\n'
  # server.js closes the headless browser on SIGINT (it has no SIGTERM handler), so ask systemd to
  # stop it that way; anything still alive after the timeout is killed with the whole cgroup.
  printf 'KillSignal=SIGINT\n'
  printf 'TimeoutStopSec=30\n'
  printf '\n[Install]\n'
  if [[ "$kind" == system ]]; then
    printf 'WantedBy=multi-user.target\n'
  else
    printf 'WantedBy=default.target\n'
  fi
}

choose_service_mode() {
  if [[ -n "$SERVICE_MODE" ]]; then return 0; fi

  local sudo_ok=0 reply
  command -v sudo >/dev/null 2>&1 && sudo_ok=1

  if (( ASSUME_YES )) || ! is_interactive; then
    if (( sudo_ok )); then SERVICE_MODE=system; else SERVICE_MODE=user; fi
    return 0
  fi

  info "How should TimeCapsule run?"
  info "  1) System service - starts at boot, restarts if it crashes (recommended; uses sudo once)"
  info "  2) User service   - runs as $RUN_USER, no root needed"
  info "  3) No service     - skip this; start it yourself with:  npm start"
  read -r -p "    Choose [1]: " reply || reply=""
  case "${reply:-1}" in
    1) SERVICE_MODE=system ;;
    2) SERVICE_MODE=user ;;
    3) SERVICE_MODE=none ;;
    *) die "Please answer 1, 2 or 3." ;;
  esac
}

install_system_unit() {
  local unit_path="/etc/systemd/system/${SERVICE_NAME}.service" tmp changed=1
  tmp="$(mktemp)"
  render_unit system >"$tmp"

  if (( DRY_RUN )); then
    info "Would write $unit_path:"
    sed 's/^/          | /' "$tmp"
    rm -f "$tmp"
    run sudo systemctl daemon-reload
    run sudo systemctl enable "$SERVICE_NAME"
    if (( ! NO_START )); then run sudo systemctl restart "$SERVICE_NAME"; fi
    UNIT_INSTALLED=system
    return 0
  fi

  need_sudo || { rm -f "$tmp"; die "sudo isn't available. Re-run with --service user, or create $unit_path as an administrator."; }

  if [[ -f "$unit_path" ]]; then
    if cmp -s "$tmp" "$unit_path"; then
      ok "$unit_path is already up to date"
      changed=0
    else
      warn "$unit_path already exists and differs from what this installer would write:"
      diff -u "$unit_path" "$tmp" | sed 's/^/          /' || true
      if ask_yes_no "Overwrite it? (the current file is kept as ${unit_path}.bak)" y; then
        sudo cp -p "$unit_path" "${unit_path}.bak"
      else
        rm -f "$tmp"
        warn "Left the existing service file alone."
        UNIT_INSTALLED=system
        return 0
      fi
    fi
  fi

  if (( changed )); then
    sudo install -m 0644 "$tmp" "$unit_path"
    ok "Wrote $unit_path"
  fi
  rm -f "$tmp"

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  ok "Enabled - it will start automatically on boot"
  if (( ! NO_START )); then
    sudo systemctl restart "$SERVICE_NAME"
    ok "Started"
  fi
  UNIT_INSTALLED=system
}

install_user_unit() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit_path="$unit_dir/${SERVICE_NAME}.service" tmp
  tmp="$(mktemp)"
  render_unit user >"$tmp"

  if (( PORT_CHOICE < 1024 )); then
    warn "Port $PORT_CHOICE is below 1024, which a non-root user service can't bind. Pick a higher port, or use --service system."
  fi

  if (( DRY_RUN )); then
    info "Would write $unit_path:"
    sed 's/^/          | /' "$tmp"
    rm -f "$tmp"
    run systemctl --user daemon-reload
    run systemctl --user enable "$SERVICE_NAME"
    if (( ! NO_START )); then run systemctl --user restart "$SERVICE_NAME"; fi
    UNIT_INSTALLED=user
    return 0
  fi

  mkdir -p "$unit_dir"
  if [[ -f "$unit_path" ]] && ! cmp -s "$tmp" "$unit_path"; then
    cp -p "$unit_path" "${unit_path}.bak"
    warn "Replaced an existing user service file (previous one kept as ${unit_path}.bak)."
  fi
  install -m 0644 "$tmp" "$unit_path"
  rm -f "$tmp"
  ok "Wrote $unit_path"

  if ! systemctl --user daemon-reload 2>/dev/null; then
    die "Couldn't talk to your systemd user manager (are you in a real login session, not su/sudo?). Log in directly and re-run, or use --service system."
  fi
  systemctl --user enable "$SERVICE_NAME"
  ok "Enabled"
  if (( ! NO_START )); then
    systemctl --user restart "$SERVICE_NAME"
    ok "Started"
  fi

  # Without "linger", a user service only lives while that user has a login session open.
  if [[ "$(loginctl show-user "$RUN_USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
    info "A user service normally stops when you log out. \"Linger\" keeps it running and starts it at boot."
    if ask_yes_no "Enable linger for $RUN_USER?" y; then
      if need_sudo; then
        sudo loginctl enable-linger "$RUN_USER" && ok "Linger enabled" || warn "Couldn't enable linger - run: sudo loginctl enable-linger $RUN_USER"
      else
        warn "sudo isn't available - ask an administrator to run: loginctl enable-linger $RUN_USER"
      fi
    fi
  fi
  UNIT_INSTALLED=user
}

setup_service() {
  step "Setting up the background service"

  choose_port

  if [[ "$SERVICE_MODE" == none ]]; then
    info "Skipping the service (--service none). Start TimeCapsule by hand with:  npm start"
    return 0
  fi
  if ! have_systemd; then
    warn "systemd isn't running on this machine (a container or WSL without systemd?), so no service can be set up."
    warn "Start TimeCapsule by hand with:  PORT=$PORT_CHOICE npm start"
    SERVICE_MODE=none
    return 0
  fi

  choose_service_mode
  case "$SERVICE_MODE" in
    system) install_system_unit ;;
    user)   install_user_unit ;;
    none)   info "Skipping the service. Start TimeCapsule by hand with:  npm start" ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Finish
# ---------------------------------------------------------------------------------------------

wait_for_http() {
  local url="$1" tries="$2" i
  for (( i = 0; i < tries; i++ )); do
    if node -e "
      const req = require('http').get(process.argv[1], { timeout: 3000 }, (res) => { res.resume(); process.exit(res.statusCode < 500 ? 0 : 1); });
      req.on('timeout', () => req.destroy());
      req.on('error', () => process.exit(1));
    " "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

show_service_logs() {
  if [[ "$UNIT_INSTALLED" == system ]]; then
    journalctl -u "$SERVICE_NAME" -n 25 --no-pager 2>/dev/null | sed 's/^/          /' >&2 || true
  else
    journalctl --user-unit "$SERVICE_NAME" -n 25 --no-pager 2>/dev/null | sed 's/^/          /' >&2 || true
  fi
}

finish() {
  local ctl="systemctl" logs="journalctl -u $SERVICE_NAME -f" lan_ip
  if [[ "$UNIT_INSTALLED" == user ]]; then ctl="systemctl --user"; logs="journalctl --user-unit $SERVICE_NAME -f"; fi

  if [[ -n "$UNIT_INSTALLED" ]] && (( ! NO_START && ! DRY_RUN )); then
    step "Waiting for TimeCapsule to come up"
    if wait_for_http "http://127.0.0.1:${PORT_CHOICE}/api/settings" 30; then
      ok "Responding on port $PORT_CHOICE"
    else
      warn "It didn't respond within 30 seconds. Recent log lines:"
      show_service_logs
      warn "Check it with:  $ctl status $SERVICE_NAME    /    $logs"
    fi
  fi

  lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

  printf '\n%sTimeCapsule is installed.%s\n\n' "$C_BOLD" "$C_RESET"
  if [[ -n "$UNIT_INSTALLED" ]]; then
    info "Open:      http://localhost:${PORT_CHOICE}${lan_ip:+   (or http://${lan_ip}:${PORT_CHOICE} from another machine)}"
    info "Status:    $ctl status $SERVICE_NAME"
    info "Logs:      $logs"
    info "Restart:   $ctl restart $SERVICE_NAME"
  else
    info "Start it:  cd $PROJECT_DIR && PORT=${PORT_CHOICE} npm start"
    info "Then open: http://localhost:${PORT_CHOICE}"
  fi
  info "Update:    bash $PROJECT_DIR/update.sh"
  printf '\n'
  info "Your archives live in $PROJECT_DIR/archived, alongside data/, bin/ and traffic.log."
  info "None of those are ever touched by updates - back up archived/ (or use Export in the UI)."
  printf '\n'
  warn "TimeCapsule has no login of its own and listens on every network interface."
  warn "If this machine is reachable beyond your own network, put it behind a firewall, VPN or an"
  warn "authenticating reverse proxy - see \"Hosting as a Server\" in the README."
  if (( ! BROWSER_OK )); then
    printf '\n'
    warn "Reminder: Chromium couldn't start earlier (see above) - archiving won't work until that's fixed."
  fi
}

main() {
  parse_args "$@"
  preflight

  if (( SKIP_DEPS )); then
    step "Installing system packages"
    info "Skipped (--skip-deps)"
  else
    install_system_packages
  fi
  ensure_node
  install_npm_deps
  verify_browser
  setup_service
  finish
}

# Only run when executed, not when sourced (lets the functions above be exercised on their own).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
