#!/bin/zsh
# Install this checkout's two launchd jobs on a Mac: the Claude Code tick every
# two hours and the babysitter every 90 minutes. The plists in contrib/ are the
# templates; this fills in the checkout's own path and gives the jobs labels of
# its own (com.deeptempo.<factory repo name>.claude-code and .babysit), so a
# second factory on the same Mac neither shares nor replaces the first's.
# Usage: contrib/install-launchd.sh             install and start both
#        contrib/install-launchd.sh --uninstall stop and remove both
set -eu
ROOT="${0:A:h:h}"
AGENTS="$HOME/Library/LaunchAgents"
repo="$(git -C "$ROOT" remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#(\.git)?/?$##')"
[[ "$repo" == */* ]] || { echo "cannot tell which factory repo this is from origin" >&2; exit 1; }
PREFIX="${FACTORY_LAUNCHD_PREFIX:-com.deeptempo.${repo:t}}"
domain="gui/$(id -u)"

for job in babysit claude-code; do
  launchctl bootout "$domain/$PREFIX.$job" 2>/dev/null || true
  rm -f "$AGENTS/$PREFIX.$job.plist"
done
if [[ "${1:-}" == --uninstall ]]; then
  echo "removed $PREFIX.claude-code and $PREFIX.babysit"
  exit 0
fi

mkdir -p "$AGENTS" "$ROOT/telemetry/babysit"
install_job() { # <template> <job>
  local template="$1" job="$2" from
  # The path the template was written for is its WorkingDirectory.
  from="$(sed -n 's#.*<key>WorkingDirectory</key><string>\(.*\)</string>.*#\1#p' "$template")"
  [[ -n "$from" ]] || { echo "no WorkingDirectory in $template" >&2; exit 1; }
  sed -e "s#$from#$ROOT#g" \
      -e "s#com\.deeptempo\.factory\.$job#$PREFIX.$job#g" \
      -e "s#^</dict>#  <key>EnvironmentVariables</key><dict><key>FACTORY_LAUNCHD_PREFIX</key><string>$PREFIX</string></dict>\\
</dict>#" "$template" > "$AGENTS/$PREFIX.$job.plist"
  plutil -lint -s "$AGENTS/$PREFIX.$job.plist"
  launchctl bootstrap "$domain" "$AGENTS/$PREFIX.$job.plist"
  echo "installed $PREFIX.$job → $ROOT"
}
# The tick first: the babysitter's first pass looks for it.
install_job "$ROOT/contrib/com.deeptempo.factory.claude-code.plist" claude-code
install_job "$ROOT/contrib/babysit/com.deeptempo.factory.babysit.plist" babysit
echo "logs: $ROOT/telemetry/launchd.log; alerts: $ROOT/telemetry/babysit/ALERTS.md"
