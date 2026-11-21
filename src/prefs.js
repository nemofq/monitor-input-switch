import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { INPUTS, inputCode, normalizeInputCode } from './inputs.js';

function parseMonitors(json) {
    try {
        return JSON.parse(json || '{}');
    } catch (_e) {
        return {};
    }
}

// Whether the selected monitor is an LG, going by the maker ID from the last scan.
function isLgTarget(settings) {
    return settings.get_strv('lg-buses').includes(settings.get_string('target-bus'));
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
            lgRow.visible = isLgTarget(settings);
        };

        const rebuild = () => {
            monitorRows.forEach(row => group.remove(row));
            monitorRows.length = 0;
            checks.clear();
            group.remove(lgRow);
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

            [...monitorRows, lgRow, rescanRow].forEach(row => group.add(row));
            syncChecks();
        };

        // Offered only for LG monitors, some of which ignore the standard command.
        const lgRow = new Adw.SwitchRow({
            title: _('LG alternate switching'),
            subtitle: _('For LG monitors that ignore the standard input command'),
        });
        settings.bind('lg-mode', lgRow, 'active', Gio.SettingsBindFlags.DEFAULT);

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
        signalIds.push(settings.connect('changed::lg-buses', syncChecks));
        group.add(lgRow);
        group.add(rescanRow);
        rebuild();
        return group;
    }

    _buildInputsGroup(settings, window, signalIds, timerIds) {
        const addMenu = new Gio.Menu();
        const addActions = new Gio.SimpleActionGroup();
        const addBtn = new Gtk.MenuButton({
            iconName: 'list-add-symbolic',
            menuModel: addMenu,
            valign: Gtk.Align.CENTER,
            cssClasses: ['flat'],
            tooltipText: _('Add or remove inputs'),
        });
        addBtn.insert_action_group('input', addActions);

        const group = new Adw.PreferencesGroup({
            title: _('Inputs shown in menu'),
            description: _('At least one input must stay enabled.'),
            headerSuffix: addBtn,
        });

        // False, with a toast, when hiding this input would leave the menu
        // empty. An input without a code isn't in the menu, so it doesn't count.
        const canHide = input => {
            const inMenu = INPUTS.filter(i =>
                settings.get_boolean(i.key) && inputCode(i, settings));
            if (inMenu.length > 1 || !inMenu.includes(input))
                return true;
            window.add_toast(new Adw.Toast({
                title: _('At least one input must stay enabled'),
                timeout: 3,
            }));
            return false;
        };

        for (const input of INPUTS) {
            const row = new Adw.ExpanderRow({
                title: input.label,
                useMarkup: false,
                showEnableSwitch: true,
                enableExpansion: settings.get_boolean(input.key),
            });
            let syncing = false;

            row.connect('notify::enable-expansion', () => {
                if (syncing)
                    return;
                const active = row.enableExpansion;
                if (!active && !canHide(input)) {
                    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        timerIds.delete(id);
                        syncing = true;
                        row.enableExpansion = true;
                        syncing = false;
                        return GLib.SOURCE_REMOVE;
                    });
                    timerIds.add(id);
                    return;
                }
                if (settings.get_boolean(input.key) !== active)
                    settings.set_boolean(input.key, active);
            });
            signalIds.push(settings.connect(`changed::${input.key}`, () => {
                const val = settings.get_boolean(input.key);
                if (row.enableExpansion !== val) {
                    syncing = true;
                    row.enableExpansion = val;
                    syncing = false;
                }
            }));

            if (input.nameKey) {
                const nameEntry = new Adw.EntryRow({ title: _('Name') });
                settings.bind(input.nameKey, nameEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
                settings.bind(input.nameKey, row, 'subtitle', Gio.SettingsBindFlags.GET);
                row.add_row(nameEntry);
            }

            const entry = new Adw.EntryRow({
                title: _('DDC code'),
                text: settings.get_string(input.codeKey),
                tooltipText: _('Hex (e.g. 0x11) or decimal, 0–255'),
            });

            if (input.defaultCode) {
                const syncHint = () => {
                    const lg = settings.get_boolean('lg-mode') && isLgTarget(settings);
                    entry.title = _('Custom DDC code (default %s)')
                        .replace('%s', lg ? input.lgCode : input.defaultCode);
                };
                for (const key of ['lg-mode', 'target-bus', 'lg-buses'])
                    signalIds.push(settings.connect(`changed::${key}`, syncHint));
                syncHint();

                const resetBtn = new Gtk.Button({
                    iconName: 'edit-undo-symbolic',
                    valign: Gtk.Align.CENTER,
                    cssClasses: ['flat'],
                    tooltipText: _('Restore default'),
                });
                resetBtn.connect('clicked', () => {
                    entry.text = '';
                });
                entry.add_suffix(resetBtn);
            }

            entry.connect('changed', () => {
                if (syncing)
                    return;
                // Empty restores the default; without one, a code is required.
                const text = entry.text.trim();
                const code = text === '' && input.defaultCode ? '' : normalizeInputCode(text);
                if (code === null) {
                    entry.add_css_class('error');
                    return;
                }
                entry.remove_css_class('error');
                if (settings.get_string(input.codeKey) !== code)
                    settings.set_string(input.codeKey, code);
            });
            signalIds.push(settings.connect(`changed::${input.codeKey}`, () => {
                const text = settings.get_string(input.codeKey);
                if (entry.text !== text) {
                    syncing = true;
                    entry.text = text;
                    syncing = false;
                }
                entry.remove_css_class('error');
            }));

            row.add_row(entry);

            if (input.addedKey) {
                // Ticked in the header menu to add the row, clicked again to
                // remove it. Adding switches the input on, removing switches
                // it off; its code and name are kept for when it is added back.
                addActions.add_action(settings.create_action(input.addedKey));
                addMenu.append(input.label, `input.${input.addedKey}`);
                settings.bind(input.addedKey, row, 'visible', Gio.SettingsBindFlags.GET);
                signalIds.push(settings.connect(`changed::${input.addedKey}`, () => {
                    const added = settings.get_boolean(input.addedKey);
                    if (!added && !canHide(input)) {
                        settings.set_boolean(input.addedKey, true);
                        return;
                    }
                    settings.set_boolean(input.key, added);
                    row.expanded = added && !input.defaultCode;
                }));
            }

            group.add(row);
        }

        return group;
    }
}
