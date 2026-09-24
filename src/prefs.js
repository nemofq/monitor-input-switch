import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { INPUTS, normalizeInputCode } from './inputs.js';

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
        const group = new Adw.PreferencesGroup({ title: _('Target monitor') });

        // One radio row per detected monitor, so long names and bus numbers
        // are never truncated the way an AdwComboRow's label is.
        const monitorRows = [];
        const checks = new Map();
        let syncing = false;

        const syncChecks = () => {
            const target = settings.get_string('target-bus');
            const bus = checks.has(target) ? target : checks.keys().next().value;
            syncing = true;
            for (const [b, check] of checks)
                check.active = b === bus;
            syncing = false;
        };

        const rebuild = () => {
            monitorRows.forEach(row => group.remove(row));
            monitorRows.length = 0;
            checks.clear();
            group.remove(rescanRow);

            const entries = Object.entries(
                parseMonitors(settings.get_string('detected-monitors')));
            if (entries.length === 0) {
                monitorRows.push(new Adw.ActionRow({
                    title: _('None detected'),
                    sensitive: false,
                }));
            }
            // Never shown: a GtkCheckButton only draws as a radio (and can't
            // be unticked) when grouped, so this keeps a lone monitor's row
            // consistent with the multi-monitor case.
            const anchor = new Gtk.CheckButton();
            for (const [bus, name] of entries) {
                const check = new Gtk.CheckButton({
                    valign: Gtk.Align.CENTER,
                    group: anchor,
                });
                check.connect('toggled', () => {
                    if (syncing || !check.active)
                        return;
                    if (settings.get_string('target-bus') !== bus)
                        settings.set_string('target-bus', bus);
                });
                const row = new Adw.ActionRow({
                    title: name,
                    useMarkup: false,
                    activatableWidget: check,
                });
                row.add_prefix(check);
                row.add_suffix(new Gtk.Label({
                    label: _('Bus %s').replace('%s', bus),
                    cssClasses: ['dim-label'],
                }));
                checks.set(bus, check);
                monitorRows.push(row);
            }

            monitorRows.forEach(row => group.add(row));
            group.add(rescanRow);
            syncChecks();
        };

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

        signalIds.push(settings.connect('changed::detected-monitors', rebuild));
        signalIds.push(settings.connect('changed::target-bus', syncChecks));
        group.add(rescanRow);
        rebuild();
        return group;
    }

    _buildInputsGroup(settings, window, signalIds, timerIds) {
        const group = new Adw.PreferencesGroup({
            title: _('Inputs shown in menu'),
            description: _('At least one input must stay enabled.'),
        });

        const rows = INPUTS.map(input => {
            const row = new Adw.ExpanderRow({
                title: input.label,
                showEnableSwitch: true,
                enableExpansion: settings.get_boolean(input.key),
            });
            row._input = input;
            row._syncing = false;

            const entry = new Adw.EntryRow({
                title: _('Custom DDC code (default %s)').replace('%s', input.defaultCode),
                text: settings.get_string(input.codeKey),
                tooltipText: _('Hex (e.g. 0x11) or decimal, 0–255'),
            });

            const resetBtn = new Gtk.Button({
                iconName: 'edit-undo-symbolic',
                valign: Gtk.Align.CENTER,
                cssClasses: ['flat'],
                tooltipText: _('Restore default'),
            });
            resetBtn.connect('clicked', () => {
                row._syncing = true;
                entry.text = '';
                row._syncing = false;
                entry.remove_css_class('error');
                if (settings.get_string(input.codeKey) !== '')
                    settings.set_string(input.codeKey, '');
            });
            entry.add_suffix(resetBtn);

            entry.connect('changed', () => {
                if (row._syncing)
                    return;
                const text = entry.text.trim();
                if (text === '') {
                    entry.remove_css_class('error');
                    if (settings.get_string(input.codeKey) !== '')
                        settings.set_string(input.codeKey, '');
                    return;
                }
                const normalized = normalizeInputCode(text);
                if (normalized === null) {
                    entry.add_css_class('error');
                    return;
                }
                entry.remove_css_class('error');
                if (settings.get_string(input.codeKey) !== normalized)
                    settings.set_string(input.codeKey, normalized);
            });

            row.add_row(entry);
            row._entry = entry;
            return row;
        });

        const countActive = () => rows.filter(r => r.enableExpansion).length;

        for (const row of rows) {
            const input = row._input;

            row.connect('notify::enable-expansion', () => {
                if (row._syncing)
                    return;
                const active = row.enableExpansion;
                if (!active && countActive() < 1) {
                    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        timerIds.delete(id);
                        row._syncing = true;
                        row.enableExpansion = true;
                        row._syncing = false;
                        return GLib.SOURCE_REMOVE;
                    });
                    timerIds.add(id);
                    window.add_toast(new Adw.Toast({
                        title: _('At least one input must stay enabled'),
                        timeout: 3,
                    }));
                    return;
                }
                if (settings.get_boolean(input.key) !== active)
                    settings.set_boolean(input.key, active);
            });

            signalIds.push(settings.connect(`changed::${input.key}`, () => {
                const val = settings.get_boolean(input.key);
                if (row.enableExpansion !== val) {
                    row._syncing = true;
                    row.enableExpansion = val;
                    row._syncing = false;
                }
            }));

            signalIds.push(settings.connect(`changed::${input.codeKey}`, () => {
                const text = settings.get_string(input.codeKey);
                if (row._entry.text !== text) {
                    row._syncing = true;
                    row._entry.text = text;
                    row._syncing = false;
                }
                row._entry.remove_css_class('error');
            }));

            group.add(row);
        }

        return group;
    }
}
