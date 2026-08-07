#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
PREFIX="packages/bench-harness"
REPOSITORY="https://github.com/OpenRouterTeam/benchmark-harness.git"
REF="${1:-main}"

if ! git -C "${ROOT}" diff --quiet -- "${PREFIX}" || ! git -C "${ROOT}" diff --cached --quiet -- "${PREFIX}"; then
  echo "Refusing to update a dirty ${PREFIX}" >&2
  exit 1
fi

git -C "${ROOT}" subtree pull --prefix="${PREFIX}" "${REPOSITORY}" "${REF}" --squash

UPSTREAM="$(git -C "${ROOT}" show -s --format=%B HEAD^2 | perl -ne 'print "$1\n" if /^git-subtree-split: ([0-9a-f]{40})$/' | tail -1)"
if [[ -z "${UPSTREAM}" ]]; then
  echo "The subtree merge did not record git-subtree-split" >&2
  exit 1
fi

TREE="$(git -C "${ROOT}" rev-parse "HEAD:${PREFIX}")"
cat > "${ROOT}/packages/bench-harness.upstream.json" <<EOF
{
  "repository": "${REPOSITORY}",
  "commit": "${UPSTREAM}",
  "tree": "${TREE}"
}
EOF

echo "Updated ${PREFIX} to ${UPSTREAM} (${TREE})"
