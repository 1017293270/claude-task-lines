#!/bin/bash
# Brings one line's work into the main working tree, file by file, three ways:
# base is the snapshot the line started from, ours the main tree as it is now,
# theirs the line's result. The main tree's index, HEAD and branches are never
# touched. Where both sides changed the same lines, conflict markers are left
# in the file for the coordinator to resolve.
#
#   merge-line.sh [--check] <main dir> <base commit> <line worktree dir | commit>
#
# --check only reports what would happen. Exit 0: clean; 1: conflicts or files
# to handle by hand; 2: wrong arguments, or the line did not start from base.
set -uo pipefail

check=0
if [ "${1:-}" = --check ]; then check=1; shift; fi
if [ $# -ne 3 ]; then
  echo "用法：merge-line.sh [--check] <主目录> <基线提交> <线的 worktree 目录 | 提交>" >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
line=$3

cd "$1" 2>/dev/null || { echo "找不到主目录 $1" >&2; exit 2; }
main=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "$1 不在 git 仓库里" >&2; exit 2; }
cd "$main" || exit 2
base=$(git rev-parse --verify --quiet "$2^{commit}") || { echo "基线 $2 不是这个仓库里的提交" >&2; exit 2; }
if [ -d "$line" ]; then
  theirs=$("$here/snapshot.sh" "$line") || { echo "没能给 $line 拍快照" >&2; exit 2; }
else
  theirs=$(git rev-parse --verify --quiet "$line^{commit}") || { echo "$line 既不是目录，也不是这个仓库里的提交" >&2; exit 2; }
fi
# A line that never reset to the base would make every difference between
# HEAD and the main tree look like the line's own change, and merging it would
# undo the person's uncommitted work.
if ! git merge-base --is-ancestor "$base" "$theirs"; then
  echo "线的代码不是从基线 ${base:0:12} 开始的（开工时没有 reset 到基线），不能合并。先让那条线确认基线。" >&2
  exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
: > "$tmp/empty"

echo "基线 ${base:0:12} → 线 ${theirs:0:12}"
[ $check = 1 ] && echo "（只检查，不改文件）"

updated=0 merged=0 added=0 deleted=0 same=0 trouble=0

report() { printf '  %-8s %s\n' "$1" "$2"; }
# Blob id of path in a commit, empty when absent.
blob() { git rev-parse --verify --quiet "$1:$2" 2>/dev/null; }
mode() { git ls-tree "$1" -- "$2" | awk '{print $1}'; }
present() { [ -e "$1" ] || [ -L "$1" ]; }
ours_id() { git hash-object -- "$1"; }
is_binary() { [ "$(git diff --numstat "$base" "$theirs" -- "$1" | cut -f1)" = "-" ]; }
take_theirs() {
  mkdir -p "$(dirname "$1")"
  git cat-file blob "$theirs:$1" > "$1"
  if [ "$(mode "$theirs" "$1")" = 100755 ]; then chmod +x "$1"; else chmod -x "$1"; fi
}
# Three-way text merge into the file in place; prints the number of conflicts.
merge_into() {
  local path=$1 base_file=$2
  git cat-file blob "$theirs:$path" > "$tmp/theirs"
  if [ $check = 1 ]; then
    git merge-file -p -L 当前 -L 基线 -L 线 "$path" "$base_file" "$tmp/theirs" > /dev/null
  else
    git merge-file -L 当前 -L 基线 -L 线 "$path" "$base_file" "$tmp/theirs"
  fi
  echo $?
}

while IFS= read -r -d '' status && IFS= read -r -d '' path; do
  theirs_id=$(blob "$theirs" "$path")
  base_id=$(blob "$base" "$path")
  if [ "$(mode "$theirs" "$path")" = 120000 ] || [ "$(mode "$base" "$path")" = 120000 ] || [ -L "$path" ] || [ "$status" = T ]; then
    report 手动处理 "$path（符号链接或类型变了）"; trouble=$((trouble + 1)); continue
  fi
  case $status in
    A)
      if ! present "$path"; then
        [ $check = 1 ] || take_theirs "$path"; report 新增 "$path"; added=$((added + 1))
      elif [ "$(ours_id "$path")" = "$theirs_id" ]; then
        report 已相同 "$path"; same=$((same + 1))
      elif is_binary "$path"; then
        report 冲突 "$path（两边都新建了这个二进制文件，保留了当前的；线的版本：git show ${theirs:0:12}:$path）"; trouble=$((trouble + 1))
      else
        n=$(merge_into "$path" "$tmp/empty")
        report 冲突 "$path（两边都新建了这个文件，$n 处）"; trouble=$((trouble + 1))
      fi
      ;;
    M)
      if ! present "$path"; then
        report 冲突 "$path（主目录删了，线改了；线的版本：git show ${theirs:0:12}:$path）"; trouble=$((trouble + 1))
        continue
      fi
      ours=$(ours_id "$path")
      if [ "$ours" = "$base_id" ]; then
        [ $check = 1 ] || take_theirs "$path"; report 更新 "$path"; updated=$((updated + 1))
      elif [ "$ours" = "$theirs_id" ]; then
        report 已相同 "$path"; same=$((same + 1))
      elif is_binary "$path"; then
        report 冲突 "$path（二进制文件两边都改了，保留了当前的；线的版本：git show ${theirs:0:12}:$path）"; trouble=$((trouble + 1))
      else
        git cat-file blob "$base:$path" > "$tmp/base"
        n=$(merge_into "$path" "$tmp/base")
        if [ "$n" = 0 ]; then
          report 合并 "$path"; merged=$((merged + 1))
        else
          report 冲突 "$path（$n 处）"; trouble=$((trouble + 1))
        fi
      fi
      ;;
    D)
      if ! present "$path"; then
        report 已相同 "$path（两边都删了）"; same=$((same + 1))
      elif [ "$(ours_id "$path")" = "$base_id" ]; then
        [ $check = 1 ] || rm -f -- "$path"; report 删除 "$path"; deleted=$((deleted + 1))
      else
        report 冲突 "$path（线删了这个文件，主目录又改过它，保留了当前的）"; trouble=$((trouble + 1))
      fi
      ;;
    *)
      report 手动处理 "$path（状态 $status）"; trouble=$((trouble + 1))
      ;;
  esac
done < <(git diff --name-status --no-renames -z "$base" "$theirs")

echo "更新 $updated，三方合并 $merged，新增 $added，删除 $deleted，已相同 $same；冲突或需手动处理 $trouble"
[ $trouble -gt 0 ] && [ $check = 0 ] && echo "冲突的文件里留了冲突标记（<<<<<<< 当前 / >>>>>>> 线），逐个解决后再跑测试。"
echo "线的全部改动：git -C \"$main\" diff ${base:0:12} ${theirs:0:12}"
[ $trouble -gt 0 ] && exit 1
exit 0
