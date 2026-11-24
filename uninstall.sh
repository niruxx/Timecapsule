#!/usr/bin/env bash
# Remove a Linux TimeCapsule installation and its local data.
set -Eeuo pipefail

UNIT=timecapsule.service
DRY_RUN=0
ASSUME_YES=0
INSTALL_DIR=""

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
TimeCapsule uninstaller for Linux

Usage: bash uninstall.sh [--dry-run] [--yes] [--install-dir PATH]

  --dry-run           List what would be removed without making changes
  -y, --yes           Permanently delete without prompting
  --install-dir PATH  Target a TimeCapsule checkout (default: this script's directory)
  -h, --help           Show this help

Removes matching systemd and PM2 registrations and the entire checkout,
including all archives, configuration, logs, dependencies, and Git data.
Run from the account that installed TimeCapsule. System files may require sudo.
EOF
}

while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --install-dir)
      [[ $# -ge 2 && -n "$2" ]] || die "--install-dir requires a path."
      INSTALL_DIR="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1. See --help." ;;
  esac
  shift
done

[[ "$(uname -s)" == Linux ]] || die "This uninstaller supports Linux."
[[ -n "$INSTALL_DIR" ]] || INSTALL_DIR="$(dirname -- "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(CDPATH= cd -P -- "$INSTALL_DIR" && pwd -P)" || die "Cannot open $INSTALL_DIR."
USER_HOME="$(CDPATH= cd -P -- "$HOME" && pwd -P)" || die "Cannot resolve the current user's home directory."
[[ "$PROJECT_DIR" != / && "$PROJECT_DIR" != "$USER_HOME" && "$USER_HOME" != "$PROJECT_DIR/"* ]] \
  || die "The target cannot be the home directory or one of its parents."
[[ -f "$PROJECT_DIR/server.js" && -f "$PROJECT_DIR/lib/history.js" && -f "$PROJECT_DIR/package.json" ]] \
  && grep -Eq '"name"[[:space:]]*:[[:space:]]*"timecapsule"' "$PROJECT_DIR/package.json" \
  || die "The target is not a TimeCapsule checkout: $PROJECT_DIR"

# A bind mount can share the same device number as the checkout. Check mount
# targets explicitly before removal and also constrain the final recursive rm.
MOUNTS="$(findmnt --noheadings --raw --output TARGET)" || die "Cannot check for mounted data."
while IFS= read -r target; do
  printf -v target '%b' "$target"
  if [[ "$target" == "$PROJECT_DIR" || "$target" == "$PROJECT_DIR/"* ]]; then
    die "Mounted path found at $target. Unmount it and handle its data separately before uninstalling."
  fi
done <<< "$MOUNTS"

run() {
  if (( DRY_RUN )); then
    printf '  [dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

system_run() {
  if (( EUID == 0 )); then run "$@"; else run sudo "$@"; fi
}

unit_matches() {
  [[ -f "$1" ]] && TIMECAPSULE_TARGET="$PROJECT_DIR" awk '
    /^[[:space:]]*WorkingDirectory[[:space:]]*=/ {
      sub(/^[^=]*=[[:space:]]*/, "")
      sub(/[[:space:]]+$/, "")
      gsub(/^"|"$/, "")
      working = $0
    }
    END { exit (working == ENVIRON["TIMECAPSULE_TARGET"] ? 0 : 1) }
  ' "$1"
}

SYSTEM_UNIT="/etc/systemd/system/$UNIT"
USER_UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
LOGROTATE=/etc/logrotate.d/timecapsule
PM2_DIR="${PM2_HOME:-$HOME/.pm2}"

remove_unit() {
  local unit_path="$1" scope="$2"
  local -a ctl=(systemctl)
  local execute=system_run online=0
  if [[ "$scope" == user ]]; then
    ctl+=(--user)
    execute=run
    [[ -S "${XDG_RUNTIME_DIR:-/run/user/$UID}/systemd/private" ]] && online=1
  else
    [[ -d /run/systemd/system ]] && online=1
  fi

  if unit_matches "$unit_path"; then
    command -v systemctl >/dev/null || die "systemctl is required to remove $unit_path."
    if (( online )); then "$execute" "${ctl[@]}" stop "$UNIT"; fi
    "$execute" "${ctl[@]}" --no-reload disable "$UNIT"
    "$execute" rm -f -- "$unit_path"
    if (( online )); then "$execute" "${ctl[@]}" daemon-reload; fi
  fi
  if unit_matches "$unit_path.bak"; then "$execute" rm -f -- "$unit_path.bak"; fi
}

# Read PM2's app list or remove this checkout's entries from a saved boot list.
# Updating only those entries preserves other apps' saved startup configuration.
pm2_entries() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [project, file, mode] = process.argv.slice(1);
    const entries = JSON.parse(fs.readFileSync(file === "-" ? 0 : file, "utf8"));
    const matches = (entry) => {
      const app = entry.pm2_env ?? entry;
      return app.name === "timecapsule" && app.pm_cwd === project &&
        typeof app.pm_exec_path === "string" &&
        path.resolve(project, app.pm_exec_path) === path.join(project, "server.js");
    };
    if (mode === "ids") {
      for (const entry of entries.filter(matches)) {
        if (Number.isInteger(entry.pm_id)) console.log(entry.pm_id);
      }
    } else if (entries.some(matches)) {
      if (mode === "plan") {
        console.log("  [dry-run] Remove TimeCapsule entries from " + file);
      } else {
        const folder = fs.mkdtempSync(path.join(path.dirname(file), ".timecapsule-uninstall-"));
        const tmp = path.join(folder, "dump");
        try {
          fs.writeFileSync(tmp, JSON.stringify(entries.filter(entry => !matches(entry)), null, 2),
            { flag: "wx", mode: fs.statSync(file).mode & 0o777 });
          fs.renameSync(tmp, file);
        } finally {
          fs.rmSync(tmp, { force: true });
          fs.rmdirSync(folder);
        }
      }
    }
  ' "$PROJECT_DIR" "$1" "$2"
}

remove_pm2() {
  local pid ids id file
  if [[ -r "$PM2_DIR/pm2.pid" ]]; then
    pid="$(<"$PM2_DIR/pm2.pid")"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null && [[ -S "$PM2_DIR/rpc.sock" ]]; then
      command -v pm2 >/dev/null && command -v node >/dev/null \
        || die "PM2 and Node.js are required to check the running PM2 instance."
      ids="$(pm2 jlist | pm2_entries - ids)"
      while IFS= read -r id; do
        if [[ -n "$id" ]]; then run pm2 delete "$id"; fi
      done <<< "$ids"
    fi
  fi
  for file in "$PM2_DIR/dump.pm2" "$PM2_DIR/dump.pm2.bak"; do
    [[ -f "$file" ]] || continue
    command -v node >/dev/null || die "Node.js is required to inspect $file."
    if (( DRY_RUN )); then pm2_entries "$file" plan; else pm2_entries "$file" remove; fi
  done
}

check_foreground() {
  local process cwd arg
  for process in /proc/[0-9]*; do
    [[ -r "$process/comm" && -r "$process/cmdline" ]] || continue
    [[ "$(cat "$process/comm" 2>/dev/null || true)" == node ]] || continue
    cwd="$(readlink -- "$process/cwd" 2>/dev/null || true)"
    while IFS= read -r -d '' arg; do
      if [[ "$arg" == "$PROJECT_DIR/server.js" || ( "$cwd" == "$PROJECT_DIR" && ( "$arg" == server.js || "$arg" == ./server.js ) ) ]]; then
        die "TimeCapsule is still running (PID ${process##*/}). Stop it and rerun this script."
      fi
    done < "$process/cmdline" 2>/dev/null || true
  done
}

printf 'TimeCapsule installation: %s\n' "$PROJECT_DIR"
printf 'The entire directory will be permanently deleted, including every saved snapshot.\n'
if (( ! DRY_RUN && ! ASSUME_YES )); then
  [[ -t 0 ]] || die "Use --yes to confirm permanent deletion in a non-interactive session."
  read -r -p 'Type DELETE to continue: ' reply
  [[ "$reply" == DELETE ]] || die "Uninstall cancelled."
fi

remove_unit "$SYSTEM_UNIT" system
remove_unit "$USER_UNIT" user
remove_pm2
if (( ! DRY_RUN )); then check_foreground; fi

if [[ -f "$LOGROTATE" ]] && TIMECAPSULE_LOG="$PROJECT_DIR/traffic.log" awk '
  /^[[:space:]]*#/ { next }
  $NF == "{" {
    blocks++
    if (NF == 2 && $1 == ENVIRON["TIMECAPSULE_LOG"]) matched = 1
  }
  END { exit (blocks == 1 && matched ? 0 : 1) }
' "$LOGROTATE"; then
  system_run rm -f -- "$LOGROTATE"
fi

cd /
run rm -rf --one-file-system -- "$PROJECT_DIR"
if (( ! DRY_RUN )); then printf 'TimeCapsule installation and local data removed.\n'; fi
