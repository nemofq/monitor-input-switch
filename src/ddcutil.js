import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

let _promisified = false;

// Hard wall-clock cap on any ddcutil invocation. detect typically ~3-4s,
// setvcp --noverify is near-instant. A wedged subprocess holding the Lock
// would silently break all future scans for the rest of the session.
const SUBPROCESS_TIMEOUT_MS = 30000;

function oneLine(text) {
    return text?.trim().split(/\s*\n\s*/).join(' | ') || '(no output)';
}

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
            Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
            Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
            Gio._promisify(Gio.File.prototype, 'load_contents_async');
            _promisified = true;
        }
        this._lock = new Lock();
        this._cancellable = new Gio.Cancellable();
        this._currentProc = null;
        this._timeoutId = 0;
        this._launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        this._launcher.setenv('LC_ALL', 'C.UTF-8', true);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._launcher = null;
    }

    // Force-kill an in-flight ddcutil subprocess. Used by PrepareForSleep so a
    // scan that is already mid-execution doesn't trail into the suspend window
    // holding the I2C bus. force_exit (SIGKILL) is the only signal strong enough
    // to halt ddcutil mid-DDC-transaction; cancelling the cancellable alone
    // would only abort our await, not the subprocess.
    cancelInFlight() {
        if (!this._currentProc)
            return;
        console.log('[monitor-input-switch] cancelInFlight: force-exiting in-flight ddcutil subprocess');
        try { this._currentProc.force_exit(); } catch (_e) {}
    }

    async _run(argv) {
        await this._lock.acquire();
        let proc = null;
        try {
            if (this._cancellable.is_cancelled() || !this._launcher)
                return null;
            proc = this._launcher.spawnv(argv);
            this._currentProc = proc;
            // Remove any prior timeout before arming a new one. The Lock already
            // serializes _run so this should be a no-op, but guarding here keeps
            // the source non-leaking regardless of how _run is called.
            if (this._timeoutId)
                GLib.source_remove(this._timeoutId);
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUBPROCESS_TIMEOUT_MS, () => {
                this._timeoutId = 0;
                console.log(`[monitor-input-switch] subprocess timeout after ${SUBPROCESS_TIMEOUT_MS}ms, killing: ${argv[0]}`);
                try { proc.force_exit(); } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
            const [stdout, stderr] = await proc.communicate_utf8_async(null, this._cancellable);
            if (proc.get_successful())
                return stdout;
            const status = proc.get_if_signaled()
                ? `killed by signal ${proc.get_term_sig()}`
                : `exit status ${proc.get_exit_status()}`;
            console.log(`[monitor-input-switch] ${argv.join(' ')} failed (${status}): ${oneLine(stderr)}`);
            return null;
        } catch (e) {
            console.log(`[monitor-input-switch] ${argv.join(' ')} failed: ${e.message}`);
            return null;
        } finally {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this._currentProc = null;
            this._lock.release();
        }
    }

    async hasExternalDisplay() {
        console.log('[monitor-input-switch] sysfs pre-check: scanning /sys/class/drm');
        let enumerator;
        try {
            const drmDir = Gio.File.new_for_path('/sys/class/drm');
            enumerator = await drmDir.enumerate_children_async(
                'standard::name', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (_e) {
            console.log('[monitor-input-switch] sysfs pre-check: enumerate failed, falling through to ddcutil');
            return true;
        }
        try {
            let infos;
            while ((infos = await enumerator.next_files_async(
                    64, GLib.PRIORITY_DEFAULT, this._cancellable)).length > 0) {
                for (const info of infos) {
                    const name = info.get_name();
                    if (!name.includes('-')) continue;
                    if (/-(eDP|LVDS|DSI|Writeback|Virtual)-/i.test(name)) continue;
                    try {
                        const file = Gio.File.new_for_path(`/sys/class/drm/${name}/status`);
                        const [contents] = await file.load_contents_async(this._cancellable);
                        if (new TextDecoder().decode(contents).trim() === 'connected') {
                            console.log(`[monitor-input-switch] sysfs pre-check: found connected external display (${name})`);
                            return true;
                        }
                    } catch (_e) {}
                }
            }
        } catch (_e) {
            console.log('[monitor-input-switch] sysfs pre-check: iteration failed, falling through to ddcutil');
            return true;
        } finally {
            try { enumerator.close(null); } catch (_e) {}
        }
        console.log('[monitor-input-switch] sysfs pre-check: no external display connected');
        return false;
    }

    // Returns null when sysfs reports a connected external display but ddcutil
    // found no usable monitor on it, so the caller can tell it apart from none.
    async detect() {
        if (!(await this.hasExternalDisplay()))
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
        if (count)
            return monitors;
        // Terse output gives no failure reason, but shows whether the display
        // was seen at all and on which bus.
        for (const block of (stdout || '').split(/\n\n+/).filter(b => b.trim()))
            console.log(`[monitor-input-switch] ddcutil detect: ${oneLine(block)}`);
        return null;
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
