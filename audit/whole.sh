#!/bin/sh
# Lints each audit app whole, without and with designguard, in a 12 GB container, one at a time.
cd "$(dirname "$0")" && mkdir -p out
for app in immich vendure openstatus calcom; do ./memory.sh $app . 12g whole-$app; done
