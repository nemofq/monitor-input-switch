export const INPUTS = [
    { defaultCode: '0x11', label: 'HDMI',        key: 'show-hdmi', codeKey: 'input-code-hdmi' },
    { defaultCode: '0x0f', label: 'DisplayPort', key: 'show-dp',   codeKey: 'input-code-dp'   },
    { defaultCode: '0x1b', label: 'USB-C',       key: 'show-usbc', codeKey: 'input-code-usbc' },
];

const INPUT_CODE_RE = /^(?:0x[0-9a-fA-F]{1,2}|\d{1,3})$/;

// Returns the trimmed code string if it parses to a byte (0–255), else null.
export function normalizeInputCode(text) {
    const t = (text ?? '').trim();
    if (!INPUT_CODE_RE.test(t))
        return null;
    const n = t.startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10);
    return n >= 0 && n <= 255 ? t : null;
}
