# Shared by every box/ script (sourced). Runs inside the Codespace.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S=".claude/skills/traced-edit/scripts"
JOBS="/workspaces/.jobs"
cd "$REPO_DIR"

# rclone remote "r2:" from the Codespaces secrets (no config file). Secrets are certain only in
# the lifecycle scripts (post-create/post-start), not in every `gh codespace ssh` session, so they
# are kept in a private file whenever they are seen and read back from it otherwise.
BOX_ENV="/workspaces/.box-env"
need_r2() {
  if [ -n "${R2_BUCKET:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
    (umask 077; for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do printf '%s=%q\n' "$k" "${!k:-}"; done > "$BOX_ENV")
  elif [ -r "$BOX_ENV" ]; then
    set -a; . "$BOX_ENV"; set +a
  fi
  for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
    if [ -z "${!k:-}" ]; then
      echo "box: $k is not set. Add it as a Codespaces secret for this repo, then rebuild/restart the codespace." >&2
      exit 2
    fi
  done
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  R2="r2:${R2_BUCKET}"
}

# A project name: one path segment, no tricks.
check_project() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "box: bad project name '$1'" >&2; exit 2; }
}
