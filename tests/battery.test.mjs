// Run with: node --test tests/
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    pickBattery, parseBattery, matchPreset, normaliseThresholds,
    buildApplyArgv, formatRange, isValidBatteryName, APPLY_SCRIPT,
} from '../lib/battery.js';

// Real values from a laptop with a stop-only threshold and charge_* attributes.
const STOP_ONLY = {
    capacity: '79\n',
    status: 'Not charging\n',
    cycle_count: '0\n',
    charge_full: '2708000\n',
    charge_full_design: '3550000\n',
    charge_control_end_threshold: '80\n',
};

// Typical ThinkPad: energy_* attributes, start and stop thresholds, temp.
const THINKPAD = {
    capacity: '64',
    status: 'Charging',
    cycle_count: '312',
    temp: '312',
    energy_full: '45120000',
    energy_full_design: '57000000',
    charge_control_start_threshold: '40',
    charge_control_end_threshold: '80',
};

test('pickBattery ignores mains and peripheral batteries', () => {
    assert.equal(pickBattery([
        {name: 'AC0', type: 'Mains\n', scope: undefined},
        {name: 'hidpp_battery_0', type: 'Battery', scope: 'Device\n'},
        {name: 'BAT1', type: 'Battery\n', scope: 'System'},
        {name: 'BAT0', type: 'Battery\n', scope: undefined},
    ]), 'BAT0');
    assert.equal(pickBattery([{name: 'AC', type: 'Mains'}]), null);
    assert.equal(pickBattery([]), null);
});

test('parseBattery: stop-only hardware with charge_* attributes', () => {
    const s = parseBattery(STOP_ONLY);
    assert.equal(s.capacity, 79);
    assert.equal(s.status, 'Not charging');
    assert.equal(s.charging, false);
    assert.equal(s.health.toFixed(1), '76.3');
    assert.equal(s.temperature, null);
    assert.equal(s.cycles, null, 'zero cycle count means unreported');
    assert.equal(s.start, null);
    assert.equal(s.stop, 80);
    assert.equal(s.supportsStart, false);
    assert.equal(s.supportsStop, true);
});

test('parseBattery: ThinkPad with energy_* and both thresholds', () => {
    const s = parseBattery(THINKPAD);
    assert.equal(s.charging, true);
    assert.equal(s.health.toFixed(1), '79.2');
    assert.equal(s.temperature, 31.2);
    assert.equal(s.cycles, 312);
    assert.deepEqual([s.start, s.stop, s.supportsStart], [40, 80, true]);
});

test('parseBattery: legacy ThinkPad threshold names', () => {
    const s = parseBattery({charge_start_threshold: '75', charge_stop_threshold: '80'});
    assert.deepEqual([s.start, s.stop], [75, 80]);
});

test('parseBattery: nothing readable', () => {
    const s = parseBattery({});
    assert.equal(s.capacity, null);
    assert.equal(s.health, null);
    assert.equal(s.supportsStop, false);
    assert.equal(s.status, 'Unknown');
});

test('parseBattery: health is capped at 100% for new batteries', () => {
    assert.equal(parseBattery({energy_full: '60', energy_full_design: '50'}).health, 100);
});

test('matchPreset', () => {
    assert.equal(matchPreset(40, 80, true).id, 'conservation');
    assert.equal(matchPreset(20, 90, true).id, 'balanced');
    assert.equal(matchPreset(0, 100, true).id, 'full');
    assert.equal(matchPreset(null, 100, true).id, 'full');
    assert.equal(matchPreset(75, 80, true), null);
    assert.equal(matchPreset(null, 80, false).id, 'conservation');
    assert.equal(matchPreset(null, null, false), null);
});

test('normaliseThresholds', () => {
    assert.deepEqual(normaliseThresholds(40, 80, true), {start: 40, stop: 80});
    assert.deepEqual(normaliseThresholds(40, 80, false), {start: 0, stop: 80});
    assert.throws(() => normaliseThresholds(80, 80, true), /lower/);
    assert.throws(() => normaliseThresholds(70, 60, true), /lower/);
    assert.throws(() => normaliseThresholds(0, 101, true), /between/);
    assert.throws(() => normaliseThresholds(0, 0, true), /between/);
    assert.throws(() => normaliseThresholds('4; rm -rf /', 80, true), /whole/);
    assert.throws(() => normaliseThresholds(1.5, 80, true), /whole/);
});

test('battery names are restricted', () => {
    assert.ok(isValidBatteryName('BAT0'));
    assert.ok(isValidBatteryName('CMB1'));
    assert.ok(!isValidBatteryName('BAT0; reboot'));
    assert.ok(!isValidBatteryName('../BAT0'));
    assert.ok(!isValidBatteryName(''));
    assert.throws(() => buildApplyArgv(40, 80, 'BAT0 x'), /Invalid battery/);
});

test('buildApplyArgv passes values as arguments, not in the script', () => {
    const argv = buildApplyArgv(40, 80, 'BAT0');
    assert.deepEqual(argv.slice(0, 3), ['pkexec', '/bin/sh', '-c']);
    assert.equal(argv[3], APPLY_SCRIPT);
    assert.deepEqual(argv.slice(4), ['battery-safety', '40', '80', 'BAT0']);
    assert.ok(!APPLY_SCRIPT.includes('${'), 'script must not contain JS interpolation');
});

test('APPLY_SCRIPT only persists thresholds after tlp accepted them', () => {
    const setcharge = APPLY_SCRIPT.indexOf('tlp setcharge');
    const write = APPLY_SCRIPT.indexOf('> /etc/tlp.d/99-battery-safety.conf');
    assert.ok(setcharge > 0 && write > 0);
    assert.ok(setcharge < write, 'a failed setcharge must not leave a new drop-in behind');
    assert.match(APPLY_SCRIPT, /^set -eu/);
});

test('APPLY_SCRIPT writes TLP config keys with BAT0/BAT1 qualifiers only', () => {
    // TLP ignores qualifiers such as _BATT or _CMB0 in its config.
    assert.match(APPLY_SCRIPT, /case "\$b" in BAT1\) k=BAT1;; \*\) k=BAT0;; esac/);
    assert.match(APPLY_SCRIPT, /STOP_CHARGE_THRESH_\$k=\$e/);
    assert.ok(!/THRESH_\$b/.test(APPLY_SCRIPT));
});

test('formatRange', () => {
    assert.equal(formatRange(40, 80, true), '40–80%');
    assert.equal(formatRange(0, 100, true), 'up to 100%');
    assert.equal(formatRange(null, 80, false), 'up to 80%');
    assert.equal(formatRange(null, null, false), 'not supported');
});
