#!/usr/bin/env bash
# Regenerates the macOS tray status icons from assets/tray-icon.template.svg.
#
# The PNGs are checked in, so this only needs to run when the artwork changes:
#   npm run icons
#
# Produces tray-{connected,connecting,offline}-{light,dark}.png plus @2x. The
# "light"/"dark" suffix names the menu-bar appearance, so the glyph is black for
# light and white for dark. assets/trayTemplate.png is deliberately untouched —
# it still serves Windows and Linux, and the fallback path in main.ts.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert not found. Install it with: brew install librsvg" >&2
  exit 1
fi

template=$(cat assets/tray-icon.template.svg)
tmp=$(mktemp -t tray-icon).svg
trap 'rm -f "$tmp"' EXIT

# Apple system colours: green / red / orange.
badge_connected='<circle cx="17.5" cy="17.5" r="3.7" fill="#34C759"/>'
badge_offline='<circle cx="17.5" cy="17.5" r="3.7" fill="#FF3B30"/>'
# A stroked circular arrow rather than a filled disc, so the three states are
# also distinguishable by silhouette and not only by hue. A 270-degree arc
# leaves a clear gap at the top-right, with the arrowhead on the arc's end.
badge_connecting='<g transform="translate(17.5,17.5)">
    <path d="M 2.9,0 A 2.9,2.9 0 1 1 0,-2.9" fill="none" stroke="#FF9F0A" stroke-width="1.5"/>
    <polygon points="1.7,-2.9 -0.5,-4.1 -0.5,-1.7" fill="#FF9F0A"/>
  </g>'

for status in connected connecting offline; do
  case "$status" in
    connected)  badge=$badge_connected ;;
    connecting) badge=$badge_connecting ;;
    offline)    badge=$badge_offline ;;
  esac

  for appearance in light dark; do
    [ "$appearance" = light ] && fg='#000000' || fg='#FFFFFF'

    svg=${template//\{\{FG\}\}/$fg}
    svg=${svg//\{\{BADGE\}\}/$badge}
    printf '%s' "$svg" > "$tmp"

    out="assets/tray-$status-$appearance"
    rsvg-convert -w 22 -h 22 "$tmp" -o "$out.png"
    rsvg-convert -w 44 -h 44 "$tmp" -o "$out@2x.png"
    echo "wrote $out.png + @2x"
  done
done
