#!/usr/bin/env bash
# Remove the `Co-Authored-By: Claude …` trailer from every commit so GitHub
# stops listing "claude" as a contributor. The trailer is the only thing that
# changes: every tree stays byte-identical, every author stays the founder.
#
# Two steps, run from the repository root:
#
#   bash scripts/maintenance/strip-claude-coauthor.sh rewrite   # local only
#   bash scripts/maintenance/strip-claude-coauthor.sh push      # force-push
#
# `rewrite` rewrites all local refs and tags, verifies that no trailer remains
# and that HEAD's, main's and every tag's tree is unchanged, and stops.
# `push` force-pushes the working branch, main and the tags. `rewrite` first
# writes a full bundle of the pre-rewrite refs to .codex/audit-20260910/
# handoff/m0/ (untracked); `git fetch <bundle> '+refs/*:refs/*'` restores it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
STATE=".git/strip-claude-coauthor.state"

case "${1:-}" in
  rewrite)
    [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "commit or discard changes first"; exit 1; }
    git fetch -q origin main
    git branch -f main origin/main
    # The backup: every ref as it stands, restorable with `git fetch <bundle>`.
    mkdir -p .codex/audit-20260910/handoff/m0
    BUNDLE=".codex/audit-20260910/handoff/m0/pre-rewrite-$(date -u +%Y%m%dT%H%M%SZ).bundle"
    git bundle create "$BUNDLE" --all
    git bundle verify "$BUNDLE"
    echo "backup: $BUNDLE"
    {
      echo "head $(git rev-parse HEAD)"
      echo "main $(git rev-parse main)"
      for t in $(git tag -l); do echo "tag $t $(git rev-parse "$t^{}")"; done
    } > "$STATE"
    echo "before: $(git log --format=%B --all | grep -ci '^co-authored-by: claude' || true) commits carry the trailer"
    export FILTER_BRANCH_SQUELCH_WARNING=1
    git filter-branch -f \
      --msg-filter 'sed -E "/^[Cc]o-[Aa]uthored-[Bb]y:.*([Cc]laude|anthropic\.com)/d"' \
      --tag-name-filter cat -- --all
    left="$(git log --format=%B --all | grep -ci '^co-authored-by: claude' || true)"
    echo "after:  $left commits carry the trailer"
    [ "$left" = "0" ] || { echo "trailers remain — stopping"; exit 1; }
    while read -r kind name sha; do
      case "$kind" in
        head) new="$(git rev-parse HEAD^{tree})"; old="$(git rev-parse "$name^{tree}")"; label=HEAD ;;
        main) new="$(git rev-parse main^{tree})"; old="$(git rev-parse "$name^{tree}")"; label=main ;;
        tag)  new="$(git rev-parse "$name^{}^{tree}")"; old="$(git rev-parse "$sha^{tree}")"; label="tag $name" ;;
      esac
      [ "$new" = "$old" ] && echo "tree unchanged: $label" || { echo "TREE CHANGED: $label — stopping"; exit 1; }
    done < "$STATE"
    # filter-branch keeps its own backups under refs/original; the bundle in
    # .codex/ is the backup this repo keeps, so drop the refs it would push.
    git for-each-ref --format='%(refname)' refs/original/ | while read -r r; do git update-ref -d "$r"; done
    echo "rewrite done and verified locally. Next: bash $0 push"
    ;;
  push)
    [ -f "$STATE" ] || { echo "run 'rewrite' first"; exit 1; }
    git push --force origin "$BRANCH"
    git push --force origin main
    git push --force origin --tags
    echo "pushed. GitHub recomputes the contributors graph in the background; the avatar can take a while to disappear."
    echo "Rebuild the installed binary afterwards: bash scripts/install.sh"
    ;;
  *)
    echo "usage: $0 rewrite | push"; exit 2 ;;
esac
