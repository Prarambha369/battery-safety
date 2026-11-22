#!/bin/sh
# Load the extension in a real headless GNOME Shell inside a Fedora container.
#
#   scripts/smoke-test.sh [fedora-release ...]      e.g. scripts/smoke-test.sh 40 45
#
# Checks: the extension reaches the ACTIVE state, survives a disable/enable
# cycle, and logs no JS errors. Docker shares the host's /sys, so the
# extension reads the host battery (or none, e.g. on CI runners). Thresholds
# are never changed: pkexec has no polkit agent in the container.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC=${SRC:-$ROOT}   # directory containing the extension to test
UUID=battery-safety@misterbashyal
RELEASES=${*:-45}
EOL_BEFORE=43   # Fedora releases older than this are fetched from the archive.

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/Dockerfile" <<'EOF'
ARG FEDORA=45
FROM fedora:${FEDORA}
ARG ARCHIVE=0
RUN if [ "$ARCHIVE" = 1 ]; then \
      sed -i -e 's/^metalink=/#metalink=/' \
             -e 's|^#baseurl=http://download.example/pub/fedora/linux|baseurl=https://archives.fedoraproject.org/pub/archive/fedora/linux|' \
             /etc/yum.repos.d/fedora*.repo; \
      rm -f /etc/yum.repos.d/fedora-cisco-openh264.repo; \
    fi; \
    dnf -y --setopt=retries=10 install gnome-shell glib2 dbus-daemon procps-ng findutils unzip >/dev/null && dnf clean all
# No systemd-logind in the container: make GNOME Shell use its dummy login manager.
RUN useradd -m tester && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    && rm -rf /run/systemd/seats
EOF

cat > "$WORK/run.sh" <<EOF
#!/bin/sh
set -u
UUID=$UUID
EOF
cat >> "$WORK/run.sh" <<'EOF'
export XDG_RUNTIME_DIR=/tmp/xdg-$(id -u)
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
echo "GNOME Shell: $(gnome-shell --version)"
ZIPDIR=$(mktemp -d)
EXTRA=""
for f in lib icons LICENSE; do [ -e "/src/$f" ] && EXTRA="$EXTRA --extra-source=$f"; done
gnome-extensions pack /src --force --out-dir="$ZIPDIR" $EXTRA >/dev/null
gnome-extensions install --force "$ZIPDIR/$UUID.shell-extension.zip"

state() { gnome-extensions info "$UUID" 2>/dev/null | sed -n 's/.*State: //p'; }

dbus-run-session -- sh -c '
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions "[\"'"$UUID"'\"]"
  gnome-shell --headless --virtual-monitor 1280x800 >/tmp/shell.log 2>&1 &
  SHELL_PID=$!
  for i in $(seq 60); do
    s=$(gnome-extensions info '"$UUID"' 2>/dev/null | sed -n "s/.*State: //p")
    [ -n "$s" ] && [ "$s" != INITIALIZED ] && break
    sleep 1
  done
  sleep 3
  st() { for _ in 1 2 3 4 5; do v=$(gnome-extensions info '"$UUID"' 2>/dev/null | sed -n "s/.*State: //p"); [ -n "$v" ] && { echo "$v"; return; }; sleep 1; done; }
  echo "after start: $(st)"
  gnome-extensions disable '"$UUID"'; sleep 2
  echo "after disable: $(st)"
  gnome-extensions enable '"$UUID"'; sleep 3
  echo "after re-enable: $(st)"
  kill $SHELL_PID; wait $SHELL_PID 2>/dev/null
' > /tmp/result.txt 2>&1
grep '^after' /tmp/result.txt
echo "--- shell log lines mentioning the extension or JS errors:"
grep -iE "battery|JS ERROR|JS WARNING|$UUID|SyntaxError|TypeError|ReferenceError" /tmp/shell.log || echo "(none)"

ok=1
# GNOME 45 reports ENABLED/DISABLED; 46+ reports ACTIVE/INACTIVE.
grep -qE "after start: (ACTIVE|ENABLED)$" /tmp/result.txt || ok=0
grep -qE "after disable: (INACTIVE|DISABLED)$" /tmp/result.txt || ok=0
grep -qE "after re-enable: (ACTIVE|ENABLED)$" /tmp/result.txt || ok=0
grep -qiE "JS ERROR|Battery Safety:|$UUID.*(error|exception)" /tmp/shell.log && ok=0
[ $ok = 1 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
EOF
chmod +x "$WORK/run.sh"

status=0
for rel in $RELEASES; do
    archive=0; [ "$rel" -lt "$EOL_BEFORE" ] && archive=1
    echo "=== Fedora $rel"
    docker build -q --build-arg FEDORA="$rel" --build-arg ARCHIVE="$archive" \
        -t "battery-safety-smoke:$rel" "$WORK" >/dev/null
    docker run --rm -v "$SRC:/src:ro" -v "$WORK/run.sh:/run.sh:ro" \
        "battery-safety-smoke:$rel" sh -c \
        'mkdir -p /run/dbus && dbus-daemon --system --fork && runuser -u tester -- /run.sh' \
        || status=1
done
exit $status
