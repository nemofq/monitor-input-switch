import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

let _promisified = false;

// Hard wall-clock cap on any ddcutil invocation. detect typically ~3-4s,
// setvcp --noverify is near-instant. A wedged subprocess holding the Lock
// would silently break all future scans for the rest of the session.
const SUBPROCESS_TIMEOUT_MS = 30000;

class Lock {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    acquire() {
        return new Promise(resolve => {
            if (!this._locked) {
                this._locked = true;
                resolve();
            } else {
                this._queue.push(resolve);
            }
        });
    }

    release() {
        if (this._queue.length)
            this._queue.shift()();
        else
            this._locked = false;
    }
}

export class Ddcutil {
    constructor() {
        if (!_promisified) {
            Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
            _promisified = true;
        }
        this._lock = new Lock();
        this._cancellable = new Gio.Cancellable();
        this._launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        this._launcher.setenv('LC_ALL', 'C.UTF-8', true);
    }

    destroy() {
        this._cancellable.cancel();
        this._launcher = null;
    }

    async _run(argv) {
        await this._lock.acquire();
        let proc = null;
        let timeoutId = 0;
        try {
            if (this._cancellable.is_cancelled() || !this._launcher)
                return null;
            proc = this._launcher.spawnv(argv);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUBPROCESS_TIMEOUT_MS, () => {
                timeoutId = 0;
                console.log(`[monitor-input-switch] subprocess timeout after ${SUBPROCESS_TIMEOUT_MS}ms, killing: ${argv[0]}`);
                try { proc.force_exit(); } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
            const [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
            return proc.get_successful() ? stdout : null;
        } catch (_e) {
            return null;
        } finally {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            this._lock.release();
        }
    }

    async _hasExternalDisplay() {
        console.log('[monitor-input-switch] sysfs pre-check: scanning /sys/class/drm');
        let enumerator;
        try {
            const drmDir = Gio.File.new_for_path('/sys/class/drm');
            enumerator = drmDir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch (_e) {
            console.log('[monitor-input-switch] sysfs pre-check: sysfs read failed, falling through to ddcutil');
            return true;
        }
        try {
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.includes('-')) continue;
                if (/-(eDP|LVDS|DSI|Writeback|Virtual)-/i.test(name)) continue;
                try {
                    const [, contents] = GLib.file_get_contents(
                        `/sys/class/drm/${name}/status`);
                    if (new TextDecoder().decode(contents).trim() === 'connected') {
                        console.log(`[monitor-input-switch] sysfs pre-check: found connected external display (${name})`);
                        return true;
                    }
                } catch (_e) {}
            }
        } catch (_e) {
            console.log('[monitor-input-switch] sysfs pre-check: sysfs read failed, falling through to ddcutil');
            return true;
        } finally {
            try { enumerator.close(null); } catch (_e) {}
        }
        console.log('[monitor-input-switch] sysfs pre-check: no external display connected');
        return false;
    }

    async detect() {
        if (!(await this._hasExternalDisplay()))
            return {};
        if (this._cancellable.is_cancelled())
            return {};
        console.log('[monitor-input-switch] ddcutil detect: starting');
        const stdout = await this._run([
            'ddcutil', 'detect', '--terse',
            '--disable-dynamic-sleep',
        ]);
        const monitors = this._parseDetect(stdout || '');
        const count = Object.keys(monitors).length;
        console.log(`[monitor-input-switch] ddcutil detect: found ${count} monitor(s)`);
        return monitors;
    }

    async setInput(bus, code) {
        await this._run(['ddcutil', '--bus', bus, 'setvcp', '60', code, '--noverify']);
    }

    _parseDetect(stdout) {
        const monitors = {};
        for (const block of stdout.split(/\n\n/)) {
            let bus = null;
            let name = null;
            let started = false;
            for (const line of block.split('\n')) {
                if (!started) {
                    if (line.startsWith('Invalid display') || line.startsWith('Phantom display'))
                        break;
                    if (line.startsWith('Display '))
                        started = true;
                    continue;
                }
                const t = line.trim();
                if (t.startsWith('I2C bus:')) {
                    const m = t.match(/i2c-(\d+)/);
                    if (m)
                        bus = m[1];
                } else if (t.startsWith('Monitor:')) {
                    name = this._friendlyName(t.substring(t.indexOf(':') + 1).trim());
                }
            }
            if (bus)
                monitors[bus] = name || `Bus ${bus}`;
        }
        return monitors;
    }

    _friendlyName(raw) {
        const parts = raw.split(':');
        return parts.length >= 2 ? parts[1].trim() || raw : raw;
    }
}
