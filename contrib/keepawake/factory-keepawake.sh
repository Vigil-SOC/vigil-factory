#!/bin/sh
# Keep the Mac awake with the lid closed while it is on AC power, so the
# babysitter's launchd passes keep firing; on battery, lid-close sleeps as usual.
# Runs as root from com.deeptempo.factory.keepawake every 30s.
if pmset -g ps | grep -q "AC Power"; then want=1; else want=0; fi
have=$(pmset -g | awk '/SleepDisabled/ {print $2}')
[ "${have:-0}" = "$want" ] || pmset -a disablesleep "$want"
