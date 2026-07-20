#!/usr/bin/env bash
# Golden-file tests for the groundplan Helm chart (GP-169).
#
#   values/<case>.yaml   rendered with a fixed release/namespace and compared
#                        byte-for-byte against golden/<case>.yaml
#   invalid/<case>.yaml  must FAIL to render; its first line is
#                        "# expect: <substring>" asserted against the error
#
# Run:            deploy/chart/tests/run.sh
# Refresh golden: deploy/chart/tests/run.sh --update
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
chart="$here/../groundplan"
update=false
[[ "${1:-}" == "--update" ]] && update=true

render() { # $1 = values file
  helm template groundplan "$chart" \
    --namespace groundplan \
    --values "$1"
}

fail=0

for values in "$here"/values/*.yaml; do
  case="$(basename "$values" .yaml)"
  golden="$here/golden/$case.yaml"

  helm lint "$chart" --namespace groundplan --values "$values" --quiet >/dev/null

  if $update; then
    mkdir -p "$here/golden"
    render "$values" > "$golden"
    echo "updated  $case"
    continue
  fi

  if [[ ! -f "$golden" ]]; then
    echo "MISSING  $case (run with --update to create the golden file)"
    fail=1
    continue
  fi

  if diff -u "$golden" <(render "$values") > /tmp/groundplan-chart-diff; then
    echo "ok       $case"
  else
    echo "DIFFERS  $case"
    cat /tmp/groundplan-chart-diff
    fail=1
  fi
done

for values in "$here"/invalid/*.yaml; do
  [[ -e "$values" ]] || continue
  case="$(basename "$values" .yaml)"
  expect="$(head -1 "$values" | sed 's/^# expect: //')"

  if err="$(render "$values" 2>&1)"; then
    echo "NO-FAIL  $case (expected rendering to fail: $expect)"
    fail=1
  elif [[ "$err" == *"$expect"* ]]; then
    echo "ok       $case (fails: $expect)"
  else
    echo "WRONG-ERR $case"
    echo "  expected substring: $expect"
    echo "  got: $err"
    fail=1
  fi
done

exit $fail
