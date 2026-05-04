import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { QuickMenuToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { Ddcutil } from './ddcutil.js';

const ICON = 'video-display-symbolic';
const MONITORS_CHANGED_SETTLE_MS = 30000;

// Sysfs reflects HPD immediately and costs essentially nothing to read, so on
// unplug we can hide the tile in ~2s instead of waiting the full scan. Hide-
// only — showing/updating still requires ddcutil to identify the bus.
const EAGER_HIDE_DELAY_MS = 2000;

// Keep in sync with INPUT_KEYS/inputTitle in prefs.js
const INPUTS = [
    { code: '0x11', label: 'HDMI',        key: 'show-hdmi' },
    { code: '0x0f', label: 'DisplayPort', key: 'show-dp'   },
    { code: '0x1b', label: 'USB-C',       key: 'show-usbc' },
];

const InputTile = GObject.registerClass(
class InputTile extends QuickMenuToggle {
    _init(extension) {
        super._init({
            iconName: ICON,
            toggleMode: false,
        });

        this._extension = extension;

        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._itemsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Settings'), () => extension.openPreferences());

        this.connect('clicked', () => this.menu.open());
    }

    setMonitorName(name) {
        this.title = name || '';
        this.menu.setHeader(ICON, name || '');
    }

    rebuildMenu(visibleInputs) {
        this._itemsSection.removeAll();
        for (const { code, label } of visibleInputs) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._extension.setInput(code));
            this._itemsSection.addMenuItem(item);
        }
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this.tile = new InputTile(extension);
        this.quickSettingsItems.push(this.tile);
    }
});

export default class MonitorInputSwitchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._ddcutil = new Ddcutil();
        this._monitors = {};
        this._currentBus = null;

        this._indicator = new Indicator(this);
        this._indicator.tile.visible = false;
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._settingsSignals = [
            this._settings.connect('changed::rescan-trigger', () => this._scan()),
            this._settings.connect('changed::target-bus', () => this._onTargetBusChanged()),
            this._settings.connect('changed::show-hdmi', () => this._refreshTile()),
            this._settings.connect('changed::show-dp', () => this._refreshTile()),
            this._settings.connect('changed::show-usbc', () => this._refreshTile()),
        ];

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._onMonitorsChanged());

        // Cancel any pending scan and kill any in-flight ddcutil when the
        // system is about to suspend. A scan firing or running into the suspend
        // window has been observed to coincide with mutter hangs that block
        // lid-close suspend.
        this._sleepSignalId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [aboutToSleep] = params.deep_unpack();
                if (!aboutToSleep)
                    return;
                if (this._scanTimeoutId) {
                    console.log('[monitor-input-switch] PrepareForSleep: cancelling pending scan');
                    this._clearTimeout('_scanTimeoutId');
                }
                if (this._eagerHideId) {
                    console.log('[monitor-input-switch] PrepareForSleep: cancelling pending eager hide');
                    this._clearTimeout('_eagerHideId');
                }
                this._ddcutil?.cancelInFlight();
            });

        this._scheduleInitialScan();
    }

    disable() {
        this._clearTimeout('_scanTimeoutId');
        this._clearTimeout('_eagerHideId');

        if (this._sleepSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
            this._sleepSignalId = 0;
        }
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        for (const id of this._settingsSignals ?? [])
            this._settings.disconnect(id);
        this._settingsSignals = null;

        this._indicator?.quickSettingsItems.forEach(i => i.destroy());
        this._indicator?.destroy();
        this._indicator = null;

        this._ddcutil?.destroy();
        this._ddcutil = null;
        this._settings = null;
        this._monitors = null;
    }

    _scheduleInitialScan() {
        if (Main.layoutManager._startingUp) {
            this._startupCompleteId = Main.layoutManager.connect(
                'startup-complete', () => {
                    Main.layoutManager.disconnect(this._startupCompleteId);
                    this._startupCompleteId = 0;
                    this._scheduleScan();
                });
        } else {
            this._scan();
        }
    }

    _onMonitorsChanged() {
        this._scheduleScan();
        this._scheduleEagerHide();
    }

    // Debounce: scanning before the monitor and host finish negotiating can cause race condition issues.
    _scheduleScan() {
        this._clearTimeout('_scanTimeoutId');
        this._scanTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, MONITORS_CHANGED_SETTLE_MS, () => {
                this._scanTimeoutId = 0;
                this._scan();
                return GLib.SOURCE_REMOVE;
            });
    }

    _scheduleEagerHide() {
        this._clearTimeout('_eagerHideId');
        this._eagerHideId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, EAGER_HIDE_DELAY_MS, () => {
                this._eagerHideId = 0;
                this._eagerHide();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _eagerHide() {
        if (!this._ddcutil || !this._currentBus)
            return;
        const hasExternal = await this._ddcutil.hasExternalDisplay();
        if (!this._ddcutil || hasExternal)
            return;
        console.log('[monitor-input-switch] eager hide: no external display, hiding tile');
        this._currentBus = null;
        this._refreshTile();
    }

    async _scan() {
        if (!this._ddcutil)
            return;
        const monitors = await this._ddcutil.detect();
        if (!this._ddcutil)
            return;
        this._monitors = monitors;
        this._settings.set_string('detected-monitors', JSON.stringify(monitors));

        const buses = Object.keys(monitors);
        const preferred = this._settings.get_string('target-bus');
        this._currentBus = buses.includes(preferred) ? preferred : (buses[0] ?? null);
        if (this._currentBus !== preferred)
            this._settings.set_string('target-bus', this._currentBus ?? '');

        this._refreshTile();
    }

    _onTargetBusChanged() {
        const requested = this._settings.get_string('target-bus');
        if (!requested || !(requested in this._monitors) || requested === this._currentBus)
            return;
        this._currentBus = requested;
        this._refreshTile();
    }

    _refreshTile() {
        if (!this._indicator)
            return;
        const tile = this._indicator.tile;
        if (!this._currentBus) {
            tile.visible = false;
            return;
        }
        tile.visible = true;
        tile.reactive = true;
        tile.setMonitorName(this._monitors[this._currentBus] ?? '');
        tile.rebuildMenu(this._visibleInputs());
    }

    _visibleInputs() {
        return INPUTS.filter(i => this._settings.get_boolean(i.key));
    }

    async setInput(code) {
        if (!this._currentBus || !this._ddcutil)
            return;
        const input = INPUTS.find(i => i.code === code);
        console.log(`[monitor-input-switch] setvcp: bus=${this._currentBus} input=${input?.label ?? code} (code=${code})`);
        await this._ddcutil.setInput(this._currentBus, code);
    }

    _clearTimeout(prop) {
        if (this[prop]) {
            GLib.source_remove(this[prop]);
            this[prop] = 0;
        }
    }
}
