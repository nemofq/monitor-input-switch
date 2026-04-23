import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { QuickMenuToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { Ddcutil } from './ddcutil.js';

const ICON = 'video-display-symbolic';
const MONITORS_CHANGED_SETTLE_MS = 5000;

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

        this._scheduleInitialScan();
    }

    disable() {
        this._clearTimeout('_scanTimeoutId');
        this._clearTimeout('_startupTimeoutId');

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
                    this._scan();
                });
        } else {
            this._startupTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, MONITORS_CHANGED_SETTLE_MS, () => {
                    this._startupTimeoutId = 0;
                    this._scan();
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _onMonitorsChanged() {
        this._clearTimeout('_scanTimeoutId');
        this._scanTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, MONITORS_CHANGED_SETTLE_MS, () => {
                this._scanTimeoutId = 0;
                this._recheckTarget();
                return GLib.SOURCE_REMOVE;
            });
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

    async _recheckTarget() {
        if (!this._currentBus || !this._ddcutil || !this._indicator)
            return;
        const ok = await this._ddcutil.probe(this._currentBus);
        if (!this._indicator)
            return;
        this._indicator.tile.reactive = ok;
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
        await this._ddcutil.setInput(this._currentBus, code);
    }

    _clearTimeout(prop) {
        if (this[prop]) {
            GLib.source_remove(this[prop]);
            this[prop] = 0;
        }
    }
}
