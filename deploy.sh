#!/usr/bin/env bash
# Push pending changes to GitHub. GitHub Pages auto-rebuilds.
# Usage: ./deploy.sh "your commit message"
#
# The app offers an update once the complete new offline shell is ready.

set -euo pipefail

cd "$(dirname "$0")"

if [ -z "$(git status --porcelain)" ]; then
  echo "No changes to deploy."
  exit 0
fi

MSG="${1:-update}"
if [ "$(git branch --show-current)" != "main" ]; then
  echo "Deploy from main after reviewing and merging your changes."
  exit 1
fi
if git diff --cached --quiet; then
  echo "Stage the files you intend to release first (git add <paths>)."
  exit 1
fi
if ! git diff --quiet; then
  echo "Unstaged tracked changes exist. Stage or set them aside before releasing."
  exit 1
fi
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Untracked files exist. Stage release files or move unrelated files before releasing."
  exit 1
fi
npm test
npm run test:browser
git -c color.ui=never commit -m "$MSG

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push

echo ""
echo "Pushed. GitHub Pages will rebuild in ~30–60 seconds."
echo "URL: https://plotline.day/app/"
