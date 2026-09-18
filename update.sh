#!/usr/bin/env bash
#
# TimeCapsule updater.
#
# Pulls the latest commits from git, reinstalls dependencies only if they changed, and restarts the
# service - without touching your data. archived/, data/, bin/ and traffic.log are untracked
# (see .gitignore), so git never sees them, and this script never runs anything like
# `git clean` or `git reset` against them.
#
# Your own edits to tracked files (typically config.js) are set aside before updating and put back
# afterwards. If they can't be merged with the new version, the update is rolled back completely
# and nothing changes - you're never left with half an update or conflict markers in a file the
# server loads.
#
#   bash update.sh              update and restart
#   bash update.sh --check      just say whether an update is available
#   bash update.sh --help       all options
#
set -Eeuo pipefail

SERVICE_NAME="timecapsule"

CHECK_ONLY=0
NO_RESTART=0
FORCE_DEPS=0

SERVICE_KIND="none"   # system | user | pm2 | none
WAS_ACTIVE=0
STASHED=0
OLD_HEAD=""
NEW_HEAD=""
PROJECT_DIR=""

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

usage() {
  cat <<'EOF'
TimeCapsule updater

Usage: bash update.sh [options]

      --check        Fetch and report what an update would bring, but change nothing
      --no-restart   Update the code and dependencies but leave the service as it is
      --force-deps   Reinstall npm dependencies even if package.json / package-lock.json didn't change
  -h, --help         Show this help

What is never touched: archived/, data/, bin/ and traffic.log.
What is preserved: your local edits to tracked files such as config.js (re-applied after the update;
if they can't be merged cleanly, the whole update is rolled back and you're told how to proceed).
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check)       CHECK_ONLY=1 ;;
      --no-restart)  NO_RESTART=1 ;;
      --force-deps)  FORCE_DEPS=1 ;;
      -h|--help)     usage; exit 0 ;;
      *)             die "Unknown option: $1 (try --help)" ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------------------------
# Service control (systemd system unit, systemd user unit, or pm2)
# ---------------------------------------------------------------------------------------------

detect_service() {
  SERVICE_KIND="none"
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then SERVICE_KIND="system"; return 0; fi
    if systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then SERVICE_KIND="user"; return 0; fi
  fi
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
    SERVICE_KIND="pm2"
  fi
  return 0
}

service_is_active() {
  case "$SERVICE_KIND" in
    system) systemctl is-active --quiet "$SERVICE_NAME" ;;
    user)   systemctl --user is-active --quiet "$SERVICE_NAME" ;;
    pm2)    pm2 describe "$SERVICE_NAME" 2>/dev/null | grep -qi 'status.*online' ;;
    *)      return 1 ;;
  esac
}

service_ctl() {   # service_ctl stop|start|restart
  local action="$1"
  case "$SERVICE_KIND" in
    system) sudo systemctl "$action" "$SERVICE_NAME" ;;
    user)   systemctl --user "$action" "$SERVICE_NAME" ;;
    pm2)    pm2 "$action" "$SERVICE_NAME" >/dev/null ;;
  esac
}

# The port the running service is actually using: an explicit PORT in the unit wins over
# config.js, mirroring how server.js resolves it (env var first, then config.js).
service_port() {
  local env_line=""
  case "$SERVICE_KIND" in
    system) env_line="$(systemctl show "$SERVICE_NAME" -p Environment --value 2>/dev/null || true)" ;;
    user)   env_line="$(systemctl --user show "$SERVICE_NAME" -p Environment --value 2>/dev/null || true)" ;;
  esac
  if [[ "$env_line" =~ (^|[[:space:]])PORT=([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
  else
    node -p "require('./config').PORT || 3000" 2>/dev/null || printf '3000'
  fi
}

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

# ---------------------------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------------------------

# True when tracked files differ from HEAD (staged or unstaged). Untracked and ignored files -
# which is where all user data lives - are deliberately not considered.
has_local_edits() { ! git diff --quiet HEAD -- 2>/dev/null; }

short() { git rev-parse --short "$1"; }

# Puts the tree back exactly as it was before the update started: previous commit, local edits
# re-applied on top. Used when something goes wrong after the new code has been merged.
restore_previous_version() {
  local had_edits=0
  if has_local_edits; then
    git stash push --quiet -m "timecapsule-update-rollback $(date +%Y%m%d-%H%M%S)" && had_edits=1
  fi
  git reset --hard --quiet "$OLD_HEAD"
  if (( had_edits )); then
    git stash pop --quiet || warn "Couldn't re-apply your local edits automatically - they're saved in 'git stash list'."
  fi
}

# ---------------------------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------------------------

preflight() {
  if (( EUID == 0 )); then
    die "Please run this as the regular user that owns the checkout, not root - running git as root would leave root-owned files in it.
    (The script uses sudo itself when it needs to restart a system service.)"
  fi

  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  cd "$PROJECT_DIR"

  command -v git  >/dev/null 2>&1 || die "git isn't installed."
  command -v node >/dev/null 2>&1 || die "node isn't installed."
  command -v npm  >/dev/null 2>&1 || die "npm isn't installed."
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "$PROJECT_DIR isn't a git checkout, so there's nothing to pull from. (Installed from a zip? Clone the repository instead.)"
  [[ -f package.json && -f server.js ]] || die "This doesn't look like a TimeCapsule checkout."
}

main() {
  parse_args "$@"
  preflight

  local branch upstream remote
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  [[ -n "$branch" ]] || die "You're on a detached HEAD (no branch checked out). Check out a branch first, e.g.:  git checkout main"

  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  [[ -n "$upstream" ]] || upstream="origin/$branch"
  remote="${upstream%%/*}"

  step "Checking for updates"
  git fetch --quiet "$remote" || die "Couldn't reach '$remote'. Check your network connection and try again."
  git rev-parse --verify --quiet "${upstream}^{commit}" >/dev/null \
    || die "Branch '$upstream' doesn't exist on the remote."

  OLD_HEAD="$(git rev-parse HEAD)"
  NEW_HEAD="$(git rev-parse "$upstream")"

  if [[ "$OLD_HEAD" == "$NEW_HEAD" ]]; then
    ok "Already up to date ($(short HEAD))"
    exit 0
  fi
  if git merge-base --is-ancestor "$NEW_HEAD" "$OLD_HEAD"; then
    ok "Nothing to update - this checkout is ahead of $upstream (local commits not pushed)"
    exit 0
  fi
  if ! git merge-base --is-ancestor "$OLD_HEAD" "$NEW_HEAD"; then
    die "This checkout has local commits that aren't in $upstream, so it can't be fast-forwarded.
    Nothing was changed. Sort that out by hand (e.g. 'git pull --rebase'), then run this again."
  fi

  local count
  count="$(git rev-list --count "$OLD_HEAD..$NEW_HEAD")"
  info "$count new commit(s) on $upstream:"
  git log --no-decorate -n 15 --format='        %h %s' "$OLD_HEAD..$NEW_HEAD"
  if (( count > 15 )); then info "        ... and $(( count - 15 )) more"; fi

  if (( CHECK_ONLY )); then
    printf '\n'
    info "An update is available. Run 'bash update.sh' to install it."
    exit 0
  fi

  detect_service
  if service_is_active; then WAS_ACTIVE=1; fi

  # ---- 1. New code, with local edits set aside and re-applied ---------------------------------
  step "Updating the code"

  if has_local_edits; then
    local patch_file
    patch_file="$(git rev-parse --git-dir)/timecapsule-pre-update-$(date +%Y%m%d-%H%M%S).patch"
    git diff HEAD >"$patch_file"
    info "Setting aside your local edits to: $(git diff --name-only HEAD | tr '\n' ' ')"
    info "(a copy is also saved as $patch_file)"
    git stash push --quiet -m "timecapsule-update $(date +%Y%m%d-%H%M%S)"
    STASHED=1
  fi

  if ! git merge --ff-only --quiet "$NEW_HEAD"; then
    if (( STASHED )); then git stash pop --quiet || true; fi
    die "Couldn't fast-forward to $upstream (a file you created may be in the way of a new one). Nothing was changed."
  fi

  if (( STASHED )); then
    if git stash pop --quiet >/dev/null 2>&1; then
      ok "Your local edits were re-applied on top of the new version"
    else
      # The new version and the local edits touch the same lines. Put everything back the way it
      # was rather than leave conflict markers in a file the server loads.
      git reset --hard --quiet "$OLD_HEAD"
      git stash pop --quiet >/dev/null 2>&1 || true
      die "Your local edits conflict with the new version, so the update was NOT applied - everything is exactly as it was.
    Your edits are still in place. To take the update anyway:
      1. Note your changes:   git diff
      2. Set them aside:      git stash
      3. Update:              bash update.sh
      4. Re-apply by hand:    git stash show -p | less     (then edit config.js to taste; 'git stash drop' when done)"
    fi
  fi
  ok "Now at $(short HEAD)"

  # ---- 2. Dependencies, only if they changed --------------------------------------------------
  local deps_changed=0
  if (( FORCE_DEPS )) || [[ ! -d node_modules ]] \
     || ! git diff --quiet "$OLD_HEAD" "$NEW_HEAD" -- package.json package-lock.json; then
    deps_changed=1
  fi

  if (( deps_changed )); then
    step "Updating dependencies"
    # A running server has node_modules open; stop it while they change.
    if (( WAS_ACTIVE && ! NO_RESTART )); then
      info "Stopping the service while dependencies change..."
      service_ctl stop
    fi
    if npm install --no-audit --no-fund; then
      ok "Dependencies up to date"
    else
      warn "npm install failed - rolling back to the previous version."
      restore_previous_version
      npm install --no-audit --no-fund >/dev/null 2>&1 || warn "Couldn't reinstall the previous dependencies either - check your network, then run: npm install"
      if (( WAS_ACTIVE && ! NO_RESTART )); then service_ctl start || true; fi
      die "Update failed and was rolled back to $(short "$OLD_HEAD"). Your data was not touched."
    fi
  else
    info "Dependencies unchanged - skipping npm install"
  fi

  # ---- 3. Restart -----------------------------------------------------------------------------
  restart_service

  step "Done"
  ok "Updated $(short "$OLD_HEAD") -> $(short "$NEW_HEAD")  ($count commit(s))"
  info "archived/, data/, bin/ and traffic.log were not touched."
}

restart_service() {
  if (( NO_RESTART )); then
    step "Restart"
    warn "Skipped (--no-restart). Restart TimeCapsule yourself to run the new version."
    return 0
  fi

  step "Restarting"
  case "$SERVICE_KIND" in
    none)
      info "No '$SERVICE_NAME' service found (systemd or pm2), so nothing was restarted."
      info "If TimeCapsule is running in a terminal, stop it (Ctrl+C) and run 'npm start' again."
      return 0
      ;;
  esac

  if (( ! WAS_ACTIVE )); then
    info "The $SERVICE_KIND service wasn't running before, so it's been left stopped."
    info "Start it when you're ready:  $( [[ "$SERVICE_KIND" == user ]] && echo 'systemctl --user' || echo 'sudo systemctl' ) start $SERVICE_NAME"
    return 0
  fi

  service_ctl restart
  ok "Restarted the $SERVICE_KIND service"

  local port
  port="$(service_port)"
  if wait_for_http "http://127.0.0.1:${port}/api/settings" 30; then
    ok "Responding on port $port"
  else
    warn "It didn't respond on port $port within 30 seconds. Recent log lines:"
    case "$SERVICE_KIND" in
      system) journalctl -u "$SERVICE_NAME" -n 25 --no-pager 2>/dev/null | sed 's/^/          /' >&2 || true ;;
      user)   journalctl --user-unit "$SERVICE_NAME" -n 25 --no-pager 2>/dev/null | sed 's/^/          /' >&2 || true ;;
      pm2)    pm2 logs "$SERVICE_NAME" --lines 25 --nostream 2>/dev/null | sed 's/^/          /' >&2 || true ;;
    esac
    die "The update was applied, but the service isn't answering. Check the log above (a config.js problem is the usual cause)."
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
