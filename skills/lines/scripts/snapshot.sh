#!/bin/bash
# Records a directory's working tree as a commit without touching its index,
# HEAD or files: tracked changes, deletions, and untracked files that are not
# ignored. Prints the commit id. With a ref name it also points that ref at the
# commit, so git gc keeps it while lines are built on it.
#
#   snapshot.sh <dir> [ref]
set -euo pipefail

dir=${1:?usage: snapshot.sh <dir> [ref]}
ref=${2:-}
cd "$dir"
top=$(git rev-parse --show-toplevel)
cd "$top"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# A private index, so the person's staged changes stay exactly as they are.
export GIT_INDEX_FILE="$tmp/index"
export GIT_AUTHOR_NAME=task-lines GIT_AUTHOR_EMAIL=task-lines@localhost
export GIT_COMMITTER_NAME=task-lines GIT_COMMITTER_EMAIL=task-lines@localhost

parent=()
if head=$(git rev-parse --verify --quiet 'HEAD^{commit}'); then
  git read-tree "$head"
  parent=(-p "$head")
fi
git add -A -- . 2>/dev/null
# Nested repositories go in as bare commit pointers. The app makes each line's
# worktree under <repo>/.claude/worktrees, so leave every one of them out,
# except submodules HEAD already tracks.
git ls-files -s -z > "$tmp/entries"
while IFS= read -r -d '' entry; do
  [ "${entry%% *}" = 160000 ] || continue
  path=${entry#*$'\t'}
  git cat-file -e "HEAD:$path" 2>/dev/null || git update-index --force-remove -- "$path"
done < "$tmp/entries"
tree=$(git write-tree)
# macOS ships bash 3.2, where an empty array under set -u is an error.
commit=$(git commit-tree "$tree" ${parent[@]+"${parent[@]}"} -m "task-lines snapshot of $top")
if [ -n "$ref" ]; then git update-ref "$ref" "$commit"; fi
echo "$commit"
