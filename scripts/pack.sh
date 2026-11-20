#!/bin/sh
# Build the installable extension zip in dist/.
# Uses `gnome-extensions pack` when available, otherwise plain zip.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
UUID=battery-safety@misterbashyal
OUT="$ROOT/dist"
ZIP="$OUT/$UUID.shell-extension.zip"

mkdir -p "$OUT"
rm -f "$ZIP"

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions pack "$ROOT" --force --out-dir="$OUT" \
        --extra-source=lib --extra-source=icons --extra-source=LICENSE
else
    # GNOME 45+ compiles extension schemas itself, so ship only the XML.
    glib-compile-schemas --strict --dry-run "$ROOT/schemas"
    (CDPATH= cd -- "$ROOT" && zip -qr "$ZIP" \
        metadata.json extension.js stylesheet.css LICENSE lib icons \
        schemas/org.gnome.shell.extensions.battery-safety.gschema.xml)
fi

echo "$ZIP"
unzip -l "$ZIP"
