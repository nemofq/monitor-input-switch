import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

let _promisified = false;

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
        if (this._sleepId) {
            GLib.source_remove(this._sleepId);
            this._sleepId = 0;
        }
        this._cancellable.cancel();
        this._launcher = null;
    }

    async _run(argv) {
        await this._lock.acquire();
        try {
            if (this._cancellable.is_cancelled() || !this._launcher)
                return null;
            const proc = this._launcher.spawnv(argv);
            const [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
            return proc.get_successful() ? stdout : null;
        } catch (_e) {
            return null;
        } finally {
            this._lock.release();
        }
    }

    async detect(retries = 3) {
        for (let i = 0; i < retries; i++) {
            if (this._cancellable.is_cancelled())
                return {};
            const stdout = await this._run(['ddcutil', 'detect', '--terse']);
            const monitors = this._parseDetect(stdout || '');
            if (Object.keys(monitors).length || i === retries - 1)
                return monitors;
            await this._sleep(1000);
        }
        return {};
    }

    async probe(bus) {
        const stdout = await this._run(['ddcutil', '--bus', bus, 'getvcp', '10', '--terse']);
        return stdout !== null;
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

    _sleep(ms) {
        return new Promise(resolve => {
            this._sleepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sleepId = 0;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}
