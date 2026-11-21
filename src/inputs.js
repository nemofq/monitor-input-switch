// defaultCode is the standard VCP 0x60 value, lgCode its LG side-channel
// counterpart. Inputs with an addedKey are optional: they exist only once
// added in preferences. The one with a nameKey is user-defined and has no
// code until one is entered.
export const INPUTS = [
    { defaultCode: '0x11', lgCode: '0x90', label: 'HDMI',          key: 'show-hdmi',   codeKey: 'input-code-hdmi' },
    { defaultCode: '0x12', lgCode: '0x91', label: 'HDMI 2',        key: 'show-hdmi2',  codeKey: 'input-code-hdmi2', addedKey: 'added-hdmi2' },
    { defaultCode: '0x0f', lgCode: '0xd0', label: 'DisplayPort',   key: 'show-dp',     codeKey: 'input-code-dp' },
    { defaultCode: '0x10', lgCode: '0xd1', label: 'DisplayPort 2', key: 'show-dp2',    codeKey: 'input-code-dp2', addedKey: 'added-dp2' },
    { defaultCode: '0x1b', lgCode: '0xd1', label: 'USB-C',         key: 'show-usbc',   codeKey: 'input-code-usbc' },
    { label: 'Custom', key: 'show-custom', codeKey: 'input-code-custom', nameKey: 'custom-name', addedKey: 'added-custom' },
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

// The code an input sends: the user's own if valid, else the default for the
// switching method. Undefined for a user-defined input without a code yet.
export function inputCode(input, settings, lg) {
    return normalizeInputCode(settings.get_string(input.codeKey)) ??
        (lg ? input.lgCode : input.defaultCode);
}
