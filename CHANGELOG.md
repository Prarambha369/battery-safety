# Changelog

## v2: 2026-11

Rewrite. Threshold changes in v1 never took effect on most systems. This release fixes that and prepares the extension for extensions.gnome.org.

### Fixed
- **Threshold changes now actually apply.** With a stock `/etc/tlp.conf`, v1's `sed` rewrote the commented-out `#START/STOP_CHARGE_THRESH_BAT0=` lines but left them commented, so nothing changed. v2 uses `tlp setcharge` for an immediate change and a `/etc/tlp.d/99-battery-safety.conf` drop-in so it persists. Active values in `/etc/tlp.conf` still take precedence over drop-ins, and v2 warns when that happens.
- Batteries named with a hyphen, such as `macsmc-battery` on Apple Silicon, are accepted.
- *Open TLP battery report* runs `tlp-stat -b` with `sudo`, because it needs root.
- One password prompt per change. v1 asked twice, and four times for presets, and its two commands could run out of order.
- Notifications only report success when the change succeeded. Cancelling the password prompt is silent, and errors show TLP's message.
- Temperature comes from the battery's own sensor. v1 showed the CPU thermal zone. It's hidden when the battery has no sensor.
- The displayed limits are the ones the firmware is using, not hard-coded defaults.
- The battery is detected automatically instead of assuming `BAT0`.

### Changed
- All status is read from sysfs. The extension no longer spawns `upower` or `cat` synchronously, which blocked the whole shell.
- TLP profiles (Stream/Coding/Normal) are merged into the presets. They needed an external `/usr/local/bin/tlp-profile` script that was never shipped.
- The *Open TLP battery report* item works with Ptyxis, Console, GNOME Terminal, kitty, Alacritty, foot or xterm.
- The extension no longer restyles every popup menu in the shell.
- New brand icon and tray icons that show whether a limit is active.
- Licensed GPL-2.0-or-later.

### Added
- Hardware with only a stop threshold is supported, and the start controls are hidden on it.
- Health falls back to `charge_full` / `charge_full_design`, and the cycle count is shown when reported.
- Warns when `/etc/tlp.conf` overrides the drop-in at boot.
- The `refresh-interval` setting is now honoured, and the menu refreshes whenever it opens.
- Unit tests, a headless GNOME Shell smoke test in Docker, and CI.

## v1
- Initial release.
