import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Keep in sync with INPUTS in extension.js
const INPUT_KEYS = ['show-hdmi', 'show-dp', 'show-usbc'];

function inputTitle(key) {
    switch (key) {
        case 'show-hdmi': return 'HDMI';
        case 'show-dp':   return 'DisplayPort';
        case 'show-usbc': return 'USB-C';
        default:          return key;
    }
}

function parseMonitors(json) {
    try {
        return JSON.parse(json || '{}');
    } catch (_e) {
        return {};
    }
}

export default class MonitorInputSwitchPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const signalIds = [];
        const timerIds = new Set();
        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'video-display-symbolic',
        });
        page.add(this._buildMonitorGroup(settings, signalIds));
        page.add(this._buildInputsGroup(settings, window, signalIds, timerIds));
        window.add(page);
        window.connect('close-request', () => {
            signalIds.forEach(id => settings.disconnect(id));
            timerIds.forEach(id => GLib.source_remove(id));
            return false;
        });
    }

    _buildMonitorGroup(settings, signalIds) {
        const group = new Adw.PreferencesGroup({ title: _('Monitor') });

        const model = new Gtk.StringList();
        const combo = new Adw.ComboRow({
            title: _('Target monitor'),
            model,
        });
        const buses = [];
        let syncing = false;

        const rebuild = () => {
            const monitors = parseMonitors(settings.get_string('detected-monitors'));
            syncing = true;
            while (model.get_n_items() > 0)
                model.remove(0);
            buses.length = 0;
            const entries = Object.entries(monitors);
            if (entries.length === 0) {
                model.append(_('None detected'));
                combo.sensitive = false;
            } else {
                combo.sensitive = true;
                for (const [bus, name] of entries) {
                    model.append(name);
                    buses.push(bus);
                }
                const target = settings.get_string('target-bus');
                const idx = buses.indexOf(target);
                combo.selected = idx >= 0 ? idx : 0;
            }
            syncing = false;
        };

        combo.connect('notify::selected', () => {
            if (syncing || buses.length === 0)
                return;
            const bus = buses[combo.selected];
            if (bus && settings.get_string('target-bus') !== bus)
                settings.set_string('target-bus', bus);
        });

        signalIds.push(settings.connect('changed::detected-monitors', rebuild));
        signalIds.push(settings.connect('changed::target-bus', rebuild));
        rebuild();

        const rescanRow = new Adw.ActionRow({
            title: _('Rescan monitors'),
            subtitle: _('Re-run ddcutil detect'),
        });
        const rescanBtn = new Gtk.Button({
            iconName: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            cssClasses: ['flat'],
        });
        rescanBtn.connect('clicked', () => {
            settings.set_uint('rescan-trigger', settings.get_uint('rescan-trigger') + 1);
        });
        rescanRow.add_suffix(rescanBtn);
        rescanRow.activatableWidget = rescanBtn;

        group.add(combo);
        group.add(rescanRow);
        return group;
    }

    _buildInputsGroup(settings, window, signalIds, timerIds) {
        const group = new Adw.PreferencesGroup({
            title: _('Inputs shown in menu'),
            description: _('At least one input must stay enabled.'),
        });

        const rows = INPUT_KEYS.map(key => {
            const row = new Adw.SwitchRow({
                title: inputTitle(key),
                active: settings.get_boolean(key),
            });
            row._key = key;
            return row;
        });

        const countActive = () => rows.filter(r => r.active).length;

        for (const row of rows) {
            row.connect('notify::active', () => {
                if (!row.active && countActive() < 1) {
                    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        timerIds.delete(id);
                        row.active = true;
                        return GLib.SOURCE_REMOVE;
                    });
                    timerIds.add(id);
                    window.add_toast(new Adw.Toast({
                        title: _('At least one input must stay enabled'),
                        timeout: 3,
                    }));
                    return;
                }
                if (settings.get_boolean(row._key) !== row.active)
                    settings.set_boolean(row._key, row.active);
            });
            signalIds.push(settings.connect(`changed::${row._key}`, () => {
                const val = settings.get_boolean(row._key);
                if (row.active !== val)
                    row.active = val;
            }));
            group.add(row);
        }
        return group;
    }
}
