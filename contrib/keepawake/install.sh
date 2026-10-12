#!/bin/sh
# sudo contrib/keepawake/install.sh        — install and start
# sudo contrib/keepawake/install.sh remove — stop, uninstall, re-enable lid sleep
set -e
cd "$(dirname "$0")"
L=/Library/LaunchDaemons/com.deeptempo.factory.keepawake.plist
launchctl bootout system "$L" 2>/dev/null || true
if [ "${1:-}" = remove ]; then
  rm -f "$L" /usr/local/sbin/factory-keepawake.sh
  pmset -a disablesleep 0
  echo "removed; lid-close sleep restored"; exit 0
fi
install -d /usr/local/sbin
install -o root -g wheel -m 755 factory-keepawake.sh /usr/local/sbin/
install -o root -g wheel -m 644 com.deeptempo.factory.keepawake.plist "$L"
launchctl bootstrap system "$L"
sleep 1; pmset -g | grep -q 'SleepDisabled.*1' && echo "on: lid-closed sleep is off while plugged in" || echo "installed; sleep stays normal (on battery?)"
