#!/usr/bin/env bash
# Pulls new code from GitHub and restarts the agent, only when something changed.
# setup-server.sh runs this every 5 minutes from cron. Output goes to data/update.log.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
export GIT_TERMINAL_PROMPT=0   # never wait for a password in the background

branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$branch" || { echo "$(date -Is) update: could not reach GitHub (private repo without a saved token?)"; exit 0; }
old="$(git rev-parse HEAD)"
new="$(git rev-parse FETCH_HEAD)"
[[ "$old" == "$new" ]] && exit 0

# npm can rewrite package-lock.json on the server; that is not a real local change, so it never blocks an update.
git checkout -q -- package-lock.json 2>/dev/null || true
if ! git merge -q --ff-only FETCH_HEAD 2>/dev/null; then
  # Files edited on the server would block the update: keep them aside (git stash list) and update anyway.
  git -c user.name=auto-update -c user.email=auto-update@localhost stash push -q -m "auto-update $(date -Is)" && echo "$(date -Is) update: local file changes kept aside (see: git stash list)"
  if ! git merge -q --ff-only FETCH_HEAD; then
    echo "$(date -Is) update: could not update. Run: cd $(pwd) && git status"
    exit 0
  fi
fi
if git diff --name-only "$old" HEAD | grep -qE '^package(-lock)?\.json$'; then
  if ! npm ci --omit=dev --no-audit --no-fund; then
    echo "$(date -Is) update: npm install failed, going back to the old version"
    git reset -q --hard "$old"
    npm ci --omit=dev --no-audit --no-fund
    exit 1
  fi
fi
pm2 restart agent >/dev/null
echo "$(date -Is) update: ${old:0:7} -> ${new:0:7} $(git log -1 --format=%s)"
