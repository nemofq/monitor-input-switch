import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Keep in sync with INPUTS in extension.js
const INPUTS = [
    { defaultCode: '0x11', key: 'show-hdmi', codeKey: 'input-code-hdmi' },
    { defaultCode: '0x0f', key: 'show-dp',   codeKey: 'input-code-dp'   },
    { defaultCode: '0x1b', key: 'show-usbc', codeKey: 'input-code-usbc' },
];

const INPUT_CODE_RE = /^(?:0x[0-9a-fA-F]+|\d+)$/;

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

function monitorName(key, monitor) {
    if (typeof monitor === 'string')
        return monitor;
    return monitor?.name || monitor?.display || key;
}

function monitorLabel(key, monitor) {
    if (typeof monitor === 'string')
        return monitor;

    const details = [];
    if (monitor?.display)
        details.push(`Display ${monitor.display}`);
    if (monitor?.bus)
        details.push(`i2c-${monitor.bus}`);

    const name = monitorName(key, monitor);
    return details.length ? `${name} (${details.join(', ')})` : name;
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
                for (const [bus, monitor] of entries) {
                    model.append(monitorLabel(bus, monitor));
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

        const rows = INPUTS.map(input => {
            const row = new Adw.ExpanderRow({
                title: inputTitle(input.key),
            });
            row._syncingCode = false;
            const toggle = new Gtk.Switch({
                active: settings.get_boolean(input.key),
                valign: Gtk.Align.CENTER,
            });

            const entry = new Adw.EntryRow({
                title: _('DDC input ID'),
                text: this._inputCodeText(settings, input),
            });
            const resetBtn = new Gtk.Button({
                iconName: 'edit-clear-symbolic',
                valign: Gtk.Align.CENTER,
                cssClasses: ['flat'],
                tooltipText: _('Use default DDC input ID'),
            });
            resetBtn.connect('clicked', () => {
                settings.set_string(input.codeKey, '');
                row._syncingCode = true;
                entry.text = input.defaultCode;
                row._syncingCode = false;
                entry.remove_css_class('error');
            });
            entry.add_suffix(resetBtn);
            entry.connect('changed', () => {
                if (row._syncingCode)
                    return;

                const code = entry.text.trim();
                if (!INPUT_CODE_RE.test(code)) {
                    entry.add_css_class('error');
                    return;
                }

                entry.remove_css_class('error');
                if (settings.get_string(input.codeKey) !== code)
                    settings.set_string(input.codeKey, code);
            });

            row.add_suffix(toggle);
            row.add_row(entry);
            row._entry = entry;
            row._switch = toggle;
            row._key = input.key;
            row._input = input;
            return row;
        });

        const countActive = () => rows.filter(r => r._switch.active).length;

        for (const row of rows) {
            row._switch.connect('notify::active', () => {
                if (!row._switch.active && countActive() < 1) {
                    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        timerIds.delete(id);
                        row._switch.active = true;
                        return GLib.SOURCE_REMOVE;
                    });
                    timerIds.add(id);
                    window.add_toast(new Adw.Toast({
                        title: _('At least one input must stay enabled'),
                        timeout: 3,
                    }));
                    return;
                }
                if (settings.get_boolean(row._key) !== row._switch.active)
                    settings.set_boolean(row._key, row._switch.active);
            });
            signalIds.push(settings.connect(`changed::${row._key}`, () => {
                const val = settings.get_boolean(row._key);
                if (row._switch.active !== val)
                    row._switch.active = val;
            }));
            signalIds.push(settings.connect(`changed::${row._input.codeKey}`, () => {
                const text = this._inputCodeText(settings, row._input);
                if (row._entry.text !== text) {
                    row._syncingCode = true;
                    row._entry.text = text;
                    row._syncingCode = false;
                }
                row._entry.remove_css_class('error');
            }));
            group.add(row);
        }

        return group;
    }

    _inputCodeText(settings, input) {
        return settings.get_string(input.codeKey).trim() || input.defaultCode;
    }
}
