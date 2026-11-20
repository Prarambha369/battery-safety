// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure helpers with no GNOME imports, so they can be unit tested with node.

export const PRESETS = [
    {id: 'conservation', label: 'Conservation', start: 40, stop: 80},
    {id: 'balanced', label: 'Balanced', start: 20, stop: 90},
    {id: 'full', label: 'Full Charge', start: 0, stop: 100},
];

export const START_VALUES = [20, 30, 40, 50, 60, 70];
export const STOP_VALUES = [60, 70, 75, 80, 85, 90, 95, 100];

// sysfs attribute names, newest first. Older ThinkPads use charge_*_threshold.
export const START_ATTRS = ['charge_control_start_threshold', 'charge_start_threshold'];
export const STOP_ATTRS = ['charge_control_end_threshold', 'charge_stop_threshold'];

export const SYSFS_ATTRS = [
    'capacity', 'status', 'cycle_count', 'temp',
    'energy_full', 'energy_full_design', 'charge_full', 'charge_full_design',
    ...START_ATTRS, ...STOP_ATTRS,
];

function toInt(value) {
    if (value === undefined || value === null)
        return null;
    const n = parseInt(String(value).trim(), 10);
    return Number.isFinite(n) ? n : null;
}

function firstInt(raw, names) {
    for (const name of names) {
        const n = toInt(raw[name]);
        if (n !== null)
            return n;
    }
    return null;
}

/**
 * Pick the system battery from a list of power supplies.
 *
 * @param {Array<{name: string, type: string, scope?: string}>} supplies
 * @returns {string|null} the power supply name, e.g. "BAT0"
 */
export function pickBattery(supplies) {
    const batteries = supplies
        .filter(s => s.type?.trim() === 'Battery' && s.scope?.trim() !== 'Device')
        .map(s => s.name)
        .sort();
    return batteries[0] ?? null;
}

/**
 * Turn raw sysfs attribute strings into battery state.
 *
 * @param {Object<string, string|undefined>} raw attribute name -> file content
 * @returns {object}
 */
export function parseBattery(raw) {
    const capacity = toInt(raw.capacity);
    const status = raw.status?.trim() || 'Unknown';

    let full = toInt(raw.energy_full);
    let design = toInt(raw.energy_full_design);
    if (full === null || !design) {
        full = toInt(raw.charge_full);
        design = toInt(raw.charge_full_design);
    }
    const health = full !== null && design ? Math.min(100, (full / design) * 100) : null;

    // power_supply "temp" is in tenths of a degree Celsius.
    const tempRaw = toInt(raw.temp);
    const temperature = tempRaw !== null ? tempRaw / 10 : null;

    const cycles = toInt(raw.cycle_count);

    const start = firstInt(raw, START_ATTRS);
    const stop = firstInt(raw, STOP_ATTRS);

    return {
        capacity,
        status,
        charging: status === 'Charging',
        health,
        temperature,
        cycles: cycles !== null && cycles > 0 ? cycles : null,
        start,
        stop,
        supportsStart: start !== null,
        supportsStop: stop !== null,
    };
}

/**
 * Name the preset matching the current thresholds, if any.
 *
 * Hardware without a start threshold matches on the stop value alone.
 */
export function matchPreset(start, stop, supportsStart = true) {
    if (stop === null || stop === undefined)
        return null;
    return PRESETS.find(p => p.stop === stop && (!supportsStart || p.start === (start ?? 0))) ?? null;
}

/**
 * Validate a requested threshold pair and normalise it for `tlp setcharge`.
 *
 * @returns {{start: number, stop: number}}
 * @throws {Error} on invalid input
 */
export function normaliseThresholds(start, stop, supportsStart) {
    const s = supportsStart ? Number(start) : 0;
    const e = Number(stop);
    if (!Number.isInteger(s) || !Number.isInteger(e))
        throw new Error('Thresholds must be whole numbers');
    if (e < 1 || e > 100)
        throw new Error('Stop threshold must be between 1 and 100');
    if (s < 0 || s > 99)
        throw new Error('Start threshold must be between 0 and 99');
    if (supportsStart && s >= e)
        throw new Error('Start threshold must be lower than stop threshold');
    return {start: s, stop: e};
}

export function isValidBatteryName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);
}

// Printed by APPLY_SCRIPT when /etc/tlp.conf, which TLP reads after drop-ins,
// sets its own thresholds that will win at the next boot.
export const OVERRIDE_MARKER = 'tlp-conf-overrides';

// Runs as root via pkexec. Values arrive as positional arguments, never
// interpolated into the script, and are re-validated before use.
export const APPLY_SCRIPT = `set -eu
s="$1"; e="$2"; b="$3"
case "$s" in ''|*[!0-9]*) echo "invalid start" >&2; exit 2;; esac
case "$e" in ''|*[!0-9]*) echo "invalid stop" >&2; exit 2;; esac
case "$b" in ''|*[!A-Za-z0-9_]*) echo "invalid battery" >&2; exit 2;; esac
tlp setcharge "$s" "$e" "$b"
# TLP config keys only use the qualifiers BAT0 (main) and BAT1 (secondary),
# whatever the sysfs name is (e.g. ASUS maps BATT/BATC to BAT0).
case "$b" in BAT1) k=BAT1;; *) k=BAT0;; esac
mkdir -p /etc/tlp.d
cat > /etc/tlp.d/99-battery-safety.conf <<EOF
# Managed by the Battery Safety GNOME Shell extension.
# Delete this file to return to your own TLP configuration.
START_CHARGE_THRESH_$k=$s
STOP_CHARGE_THRESH_$k=$e
EOF
if grep -Eq "^[[:space:]]*(START|STOP)_CHARGE_THRESH_$k=" /etc/tlp.conf 2>/dev/null; then
  echo "tlp-conf-overrides"
fi
`;

/**
 * Build the argv for applying thresholds persistently with one auth prompt.
 */
export function buildApplyArgv(start, stop, battery) {
    if (!isValidBatteryName(battery))
        throw new Error(`Invalid battery name: ${battery}`);
    return ['pkexec', '/bin/sh', '-c', APPLY_SCRIPT, 'battery-safety',
        String(start), String(stop), battery];
}

/** Human-readable range, e.g. "40–80%" or "up to 80%". */
export function formatRange(start, stop, supportsStart) {
    if (stop === null || stop === undefined)
        return 'not supported';
    if (!supportsStart || !start)
        return `up to ${stop}%`;
    return `${start}–${stop}%`;
}
