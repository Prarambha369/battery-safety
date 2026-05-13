import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const PROFILE_CMD = '/usr/local/bin/tlp-profile';
const TLP_PROFILES = [
    {id: 'stream', label: 'Stream'},
    {id: 'coding', label: 'Coding'},
    {id: 'normal', label: 'Normal'},
];

const BatterySafetyIndicator = GObject.registerClass(
class BatterySafetyIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Battery Safety Controls');
        
        this._icon = new St.Icon({
            icon_name: 'battery-good-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._createMenu();
        this._updateBatteryStatus();
        this._refreshCurrentProfile();
        
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._updateBatteryStatus();
            this._refreshCurrentProfile();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _createMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('Battery Status', { reactive: false });
        this._statusItem.label.style_class = 'battery-status-header';
        this.menu.addMenuItem(this._statusItem);
        
        this._chargeItem = new PopupMenu.PopupMenuItem('Charge: ---%', { reactive: false });
        this._healthItem = new PopupMenu.PopupMenuItem('Health: ---%', { reactive: false });
        this._tempItem = new PopupMenu.PopupMenuItem('Temperature: --°C', { reactive: false });
        
        this.menu.addMenuItem(this._chargeItem);
        this.menu.addMenuItem(this._healthItem);
        this.menu.addMenuItem(this._tempItem);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        const thresholdHeader = new PopupMenu.PopupMenuItem('Charging Thresholds', { reactive: false });
        thresholdHeader.label.style_class = 'battery-threshold-header';
        this.menu.addMenuItem(thresholdHeader);
        
        const startThresholdItem = new PopupMenu.PopupSubMenuMenuItem('Start Charging: 40%');
        this._startThresholdItem = startThresholdItem;
        
        const startValues = [20, 30, 40, 50, 60];
        startValues.forEach(value => {
            const item = new PopupMenu.PopupMenuItem(`${value}%`);
            item.connect('activate', () => this._setStartThreshold(value));
            startThresholdItem.menu.addMenuItem(item);
        });
        
        this.menu.addMenuItem(startThresholdItem);
        
        const stopThresholdItem = new PopupMenu.PopupSubMenuMenuItem('Stop Charging: 80%');
        this._stopThresholdItem = stopThresholdItem;
        
        const stopValues = [70, 75, 80, 85, 90, 95, 100];
        stopValues.forEach(value => {
            const item = new PopupMenu.PopupMenuItem(`${value}%`);
            item.connect('activate', () => this._setStopThreshold(value));
            stopThresholdItem.menu.addMenuItem(item);
        });
        
        this.menu.addMenuItem(stopThresholdItem);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        const conservationItem = new PopupMenu.PopupMenuItem('🛡️ Conservation Mode (40-80%)');
        conservationItem.connect('activate', () => this._setConservationMode());
        this.menu.addMenuItem(conservationItem);
        
        const balancedItem = new PopupMenu.PopupMenuItem('⚖️ Balanced Mode (20-90%)');
        balancedItem.connect('activate', () => this._setBalancedMode());
        this.menu.addMenuItem(balancedItem);
        
        const fullChargeItem = new PopupMenu.PopupMenuItem('🔋 Full Charge Mode (0-100%)');
        fullChargeItem.connect('activate', () => this._setFullChargeMode());
        this.menu.addMenuItem(fullChargeItem);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const profileHeader = new PopupMenu.PopupMenuItem('TLP Profile', { reactive: false });
        profileHeader.label.style_class = 'battery-threshold-header';
        this.menu.addMenuItem(profileHeader);

        this._tlpCurrentItem = new PopupMenu.PopupMenuItem('Current: loading…', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._tlpCurrentItem);
        
        this._profileSelectorItem = new PopupMenu.PopupSubMenuMenuItem('Select profile');
        this._profileMenuItems = new Map();
        for (const profileConfig of TLP_PROFILES) {
            const item = new PopupMenu.PopupMenuItem(`○ ${profileConfig.label}`);
            item.connect('activate', async () => {
                await this._switchProfile(profileConfig.id);
            });
            this._profileSelectorItem.menu.addMenuItem(item);
            this._profileMenuItems.set(profileConfig.id, item);
        }
        this.menu.addMenuItem(this._profileSelectorItem);

        const refreshProfileItem = new PopupMenu.PopupMenuItem('Refresh profile status');
        refreshProfileItem.connect('activate', () => {
            this._refreshCurrentProfile();
        });
        this.menu.addMenuItem(refreshProfileItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        const tlpStatusItem = new PopupMenu.PopupMenuItem('📊 View TLP Status');
        tlpStatusItem.connect('activate', () => this._showTLPStatus());
        this.menu.addMenuItem(tlpStatusItem);
    }

    _updateBatteryStatus() {
        try {
            const [success, stdout] = GLib.spawn_command_line_sync('upower -i /org/freedesktop/UPower/devices/battery_BAT0');
            
            if (success) {
                const output = new TextDecoder().decode(stdout);
                
                const chargeMatch = output.match(/percentage:\s*(\d+)%/);
                const capacityMatch = output.match(/capacity:\s*([\d.]+)%/);
                const stateMatch = output.match(/state:\s*(.+)/);
                
                if (chargeMatch) {
                    const charge = parseInt(chargeMatch[1]);
                    this._chargeItem.label.text = `Charge: ${charge}%`;
                    
                    if (charge > 80) {
                        this._icon.icon_name = 'battery-full-symbolic';
                    } else if (charge > 50) {
                        this._icon.icon_name = 'battery-good-symbolic';
                    } else if (charge > 20) {
                        this._icon.icon_name = 'battery-low-symbolic';
                    } else {
                        this._icon.icon_name = 'battery-caution-symbolic';
                    }
                }
                
                if (capacityMatch) {
                    const capacity = parseFloat(capacityMatch[1]);
                    this._healthItem.label.text = `Health: ${capacity.toFixed(1)}%`;
                }
                
                if (stateMatch) {
                    const state = stateMatch[1].trim();
                    if (state === 'charging') {
                        this._icon.icon_name = 'battery-full-charging-symbolic';
                    }
                }
            }
            
            const [tempSuccess, tempStdout] = GLib.spawn_command_line_sync('cat /sys/class/thermal/thermal_zone0/temp');
            if (tempSuccess) {
                const temp = parseInt(new TextDecoder().decode(tempStdout)) / 1000;
                this._tempItem.label.text = `Temperature: ${temp.toFixed(1)}°C`;
            }
            
        } catch (e) {
            console.error('Failed to update battery status:', e);
        }
    }

    _setStartThreshold(value) {
        try {
            GLib.spawn_command_line_async(`pkexec sed -i 's/START_CHARGE_THRESH_BAT0=.*/START_CHARGE_THRESH_BAT0=${value}/' /etc/tlp.conf`);
            GLib.spawn_command_line_async('pkexec tlp start');
            this._startThresholdItem.label.text = `Start Charging: ${value}%`;
            Main.notify('Battery Safety', `Start charging threshold set to ${value}%`);
        } catch (e) {
            console.error('Failed to set start threshold:', e);
        }
    }

    _setStopThreshold(value) {
        try {
            GLib.spawn_command_line_async(`pkexec sed -i 's/STOP_CHARGE_THRESH_BAT0=.*/STOP_CHARGE_THRESH_BAT0=${value}/' /etc/tlp.conf`);
            GLib.spawn_command_line_async('pkexec tlp start');
            this._stopThresholdItem.label.text = `Stop Charging: ${value}%`;
            Main.notify('Battery Safety', `Stop charging threshold set to ${value}%`);
        } catch (e) {
            console.error('Failed to set stop threshold:', e);
        }
    }

    _setConservationMode() {
        this._setStartThreshold(40);
        this._setStopThreshold(80);
        Main.notify('Battery Safety', 'Conservation mode activated (40-80%)');
    }

    _setBalancedMode() {
        this._setStartThreshold(20);
        this._setStopThreshold(90);
        Main.notify('Battery Safety', 'Balanced mode activated (20-90%)');
    }

    _setFullChargeMode() {
        this._setStartThreshold(0);
        this._setStopThreshold(100);
        Main.notify('Battery Safety', 'Full charge mode activated (0-100%)');
    }

    async _switchProfile(profile) {
        const result = await this._runCommand([PROFILE_CMD, profile]);
        
        if (result.ok) {
            Main.notify('Battery Safety', `Applied profile: ${profile}`);
            await this._refreshCurrentProfile();
            return;
        }

        Main.notify('Battery Safety', `Failed to apply ${profile}: ${result.stderr || 'unknown error'}`);
    }

    async _refreshCurrentProfile() {
        const result = await this._runCommand([PROFILE_CMD, 'current']);
        if (!result.ok) {
            console.error('Failed to get profile:', result.stderr);
            this._setCurrentProfile('unknown');
            return;
        }

        const output = result.stdout.trim();
        console.log('TLP profile output:', output);
        
        // More flexible regex - handles en-dash, hyphen, or space
        const match = output.match(/Thresholds:\s*(\d+)\s*[%\s]*[-–—]\s*(\d+)\s*%/);
        let profileLabel = 'unknown';
        
        if (match) {
            const start = parseInt(match[1], 10);
            const stop = parseInt(match[2], 10);
            console.log(`Parsed: ${start}% to ${stop}%`);
            
            if (start === 0 && stop === 100) profileLabel = 'stream';
            else if (start === 40 && stop === 80) profileLabel = 'coding';
            else if (start === 20 && stop === 90) profileLabel = 'normal';
            else profileLabel = `${start}-${stop}%`;
        } else {
            console.error('Could not parse:', JSON.stringify(output));
        }
        
        this._setCurrentProfile(profileLabel);
    }

    _setCurrentProfile(profile) {
        if (!this._tlpCurrentItem) return;
        this._tlpCurrentItem.label.text = `Current: ${profile}`;

        if (this._profileSelectorItem) {
            this._profileSelectorItem.label.text = `Select profile (current: ${profile})`;
        }

        if (!this._profileMenuItems) return;
        for (const profileConfig of TLP_PROFILES) {
            const menuItem = this._profileMenuItems.get(profileConfig.id);
            if (!menuItem) continue;
            const marker = profile === profileConfig.id ? '●' : '○';
            menuItem.label.text = `${marker} ${profileConfig.label}`;
        }
    }

    _runCommand(argv) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, stdout, stderr] = p.communicate_utf8_finish(res);
                        resolve({
                            ok: p.get_successful(),
                            stdout: stdout ?? '',
                            stderr: stderr ?? '',
                        });
                    } catch (e) {
                        resolve({
                            ok: false,
                            stdout: '',
                            stderr: e.message,
                        });
                    }
                });
            } catch (e) {
                resolve({
                    ok: false,
                    stdout: '',
                    stderr: e.message,
                });
            }
        });
    }

    _showTLPStatus() {
        try {
            // Keep terminal open with bash -c and read prompt
            GLib.spawn_command_line_async('gnome-terminal -- bash -c "tlp-stat -b; echo; echo \'Press Enter to close...\'; read"');
        } catch (e) {
            console.error('Failed to show TLP status:', e);
        }
    }

    destroy() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
        super.destroy();
    }
});

export default class BatterySafetyExtension extends Extension {
    enable() {
        this._indicator = new BatterySafetyIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
