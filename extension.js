// SPDX-License-Identifier: GPL-2.0-or-later
// Battery Safety: charge thresholds for GNOME Shell, powered by TLP.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    PRESETS, START_VALUES, STOP_VALUES, SYSFS_ATTRS,
    pickBattery, parseBattery, matchPreset, normaliseThresholds,
    buildApplyArgv, formatRange, OVERRIDE_MARKER,
} from './lib/battery.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const POWER_SUPPLY = '/sys/class/power_supply';
const TITLE = 'Battery Safety';

async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return undefined;
    }
}

async function findBattery() {
    const dir = Gio.File.new_for_path(POWER_SUPPLY);
    let names = [];
    try {
        const iter = await dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        for (;;) {
            const infos = await iter.next_files_async(32, GLib.PRIORITY_DEFAULT, null);
            if (infos.length === 0)
                break;
            names.push(...infos.map(i => i.get_name()));
        }
    } catch {
        return null;
    }
    const supplies = await Promise.all(names.map(async name => ({
        name,
        type: await readText(`${POWER_SUPPLY}/${name}/type`),
        scope: await readText(`${POWER_SUPPLY}/${name}/scope`),
    })));
    return pickBattery(supplies);
}

async function readBattery(name) {
    const raw = {};
    await Promise.all(SYSFS_ATTRS.map(async attr => {
        raw[attr] = await readText(`${POWER_SUPPLY}/${name}/${attr}`);
    }));
    return parseBattery(raw);
}

async function run(argv) {
    try {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
        return {ok: proc.get_successful(), status: proc.get_exit_status(),
            stdout: stdout ?? '', stderr: stderr ?? ''};
    } catch (e) {
        return {ok: false, status: -1, stdout: '', stderr: e.message};
    }
}

const BatterySafetyIndicator = GObject.registerClass(
class BatterySafetyIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, TITLE);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._battery = null;
        this._state = null;
        this._busy = false;

        this._gicons = {
            protected: Gio.FileIcon.new(extension.dir.resolve_relative_path('icons/battery-safety-symbolic.svg')),
            unprotected: Gio.FileIcon.new(extension.dir.resolve_relative_path('icons/battery-safety-off-symbolic.svg')),
        };
        this._icon = new St.Icon({gicon: this._gicons.protected, style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._buildMenu();

        this._settingsChangedId = this._settings.connect('changed::refresh-interval',
            () => this._scheduleRefresh());
        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

        this._scheduleRefresh();
        this._refresh();
    }

    _buildMenu() {
        this._headerItem = new PopupMenu.PopupMenuItem(TITLE, {reactive: false, can_focus: false});
        this._headerItem.label.add_style_class_name('battery-safety-header');
        this.menu.addMenuItem(this._headerItem);

        this._chargeItem = this._infoItem();
        this._healthItem = this._infoItem();
        this._tempItem = this._infoItem();
        this._cyclesItem = this._infoItem();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Charge limit'));

        this._limitItem = this._infoItem();

        this._presetItems = new Map();
        for (const preset of PRESETS) {
            const item = new PopupMenu.PopupMenuItem(preset.label);
            item.connect('activate', () => this._apply(preset.start, preset.stop, preset.label));
            this.menu.addMenuItem(item);
            this._presetItems.set(preset.id, item);
        }

        this._startMenu = new PopupMenu.PopupSubMenuMenuItem('Start charging at');
        for (const value of START_VALUES) {
            const item = new PopupMenu.PopupMenuItem(`${value}%`);
            item.connect('activate', () => this._apply(value, this._state?.stop ?? 100));
            this._startMenu.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(this._startMenu);

        this._stopMenu = new PopupMenu.PopupSubMenuMenuItem('Stop charging at');
        for (const value of STOP_VALUES) {
            const item = new PopupMenu.PopupMenuItem(`${value}%`);
            item.connect('activate', () => this._apply(this._state?.start ?? 0, value));
            this._stopMenu.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(this._stopMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const statusItem = new PopupMenu.PopupMenuItem('Open TLP battery report');
        statusItem.connect('activate', () => this._openReport());
        this.menu.addMenuItem(statusItem);
    }

    _infoItem() {
        const item = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        item.add_style_class_name('battery-safety-info');
        this.menu.addMenuItem(item);
        return item;
    }

    _scheduleRefresh() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        const seconds = Math.max(5, this._settings.get_int('refresh-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        try {
            if (!this._battery)
                this._battery = await findBattery();
            const state = this._battery ? await readBattery(this._battery) : null;
            if (this._destroyed)
                return;
            this._state = state;
            this._render();
        } catch (e) {
            console.error(`${TITLE}: refresh failed: ${e}`);
        }
    }

    _render() {
        const s = this._state;
        if (!s) {
            this._chargeItem.label.text = 'No battery found';
            for (const item of [this._healthItem, this._tempItem, this._cyclesItem])
                item.visible = false;
            this._limitItem.label.text = 'Charge limit: unavailable';
            this._setControlsSensitive(false);
            this._icon.gicon = this._gicons.unprotected;
            return;
        }

        const pct = s.capacity !== null ? `${s.capacity}%` : '—';
        this._chargeItem.label.text = `Charge: ${pct} · ${s.status}`;

        this._healthItem.visible = s.health !== null;
        if (s.health !== null)
            this._healthItem.label.text = `Health: ${s.health.toFixed(1)}%`;

        this._tempItem.visible = s.temperature !== null;
        if (s.temperature !== null)
            this._tempItem.label.text = `Temperature: ${s.temperature.toFixed(1)} °C`;

        this._cyclesItem.visible = s.cycles !== null;
        if (s.cycles !== null)
            this._cyclesItem.label.text = `Cycles: ${s.cycles}`;

        this._limitItem.label.text = `Current limit: ${formatRange(s.start, s.stop, s.supportsStart)}`;
        this._setControlsSensitive(s.supportsStop);
        this._startMenu.visible = s.supportsStart;

        const active = matchPreset(s.start, s.stop, s.supportsStart);
        for (const preset of PRESETS) {
            const item = this._presetItems.get(preset.id);
            item.setOrnament(active?.id === preset.id
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.label.text = `${preset.label} (${formatRange(preset.start, preset.stop, s.supportsStart)})`;
        }

        const isProtected = s.supportsStop && s.stop !== null && s.stop < 100;
        this._icon.gicon = isProtected ? this._gicons.protected : this._gicons.unprotected;
    }

    _setControlsSensitive(sensitive) {
        for (const item of this._presetItems.values())
            item.setSensitive(sensitive && !this._busy);
        this._startMenu.setSensitive(sensitive && !this._busy);
        this._stopMenu.setSensitive(sensitive && !this._busy);
    }

    async _apply(start, stop, label = null) {
        if (this._busy || !this._state || !this._battery)
            return;

        let values;
        try {
            values = normaliseThresholds(start, stop, this._state.supportsStart);
        } catch (e) {
            Main.notify(TITLE, e.message);
            return;
        }

        this._busy = true;
        this._setControlsSensitive(false);
        const result = await run(buildApplyArgv(values.start, values.stop, this._battery));
        this._busy = false;
        if (this._destroyed)
            return;

        if (result.ok) {
            const range = formatRange(values.start, values.stop, this._state.supportsStart);
            const msg = label ? `${label} mode: charging ${range}` : `Charge limit set: ${range}`;
            Main.notify(TITLE, result.stdout.includes(OVERRIDE_MARKER)
                ? `${msg}. Applied until reboot: /etc/tlp.conf sets its own thresholds, which take precedence.`
                : msg);
        } else if (result.status === 126 || result.status === 127) {
            // pkexec: authorization dismissed or not obtained.
        } else {
            const detail = result.stderr.trim().split('\n').pop() || `exit status ${result.status}`;
            Main.notify(TITLE, `Could not change charge limit: ${detail}`);
        }
        await this._refresh();
    }

    _openReport() {
        const cmd = 'tlp-stat -b; echo; read -r -p "Press Enter to close…" _';
        const terminals = [
            ['ptyxis', '--'], ['kgx', '--'], ['gnome-terminal', '--'],
            ['kitty'], ['alacritty', '-e'], ['foot'], ['xterm', '-e'],
        ];
        for (const [bin, ...flags] of terminals) {
            if (GLib.find_program_in_path(bin)) {
                try {
                    Gio.Subprocess.new([bin, ...flags, 'bash', '-c', cmd], Gio.SubprocessFlags.NONE);
                    return;
                } catch (e) {
                    console.error(`${TITLE}: failed to launch ${bin}: ${e}`);
                }
            }
        }
        Main.notify(TITLE, 'No supported terminal found to show the TLP report');
    }

    destroy() {
        this._destroyed = true;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;
        super.destroy();
    }
});

export default class BatterySafetyExtension extends Extension {
    enable() {
        this._indicator = new BatterySafetyIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
