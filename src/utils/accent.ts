// The accent colour, and the three tokens derived from it.
//
// A theme defines `--accent` alongside `--accent-hover`, `--accent-foreground`,
// `--focus` and `--link`, and those five have to agree or the result is a button
// whose hover state jumps to the theme's blue, or a label that vanishes into its
// own background. So the user picks one colour and this works out the rest,
// rather than asking anyone to pick four that match.

/** The custom properties a chosen accent overrides. */
export interface AccentTokens {
    '--accent': string;
    '--accent-hover': string;
    '--accent-foreground': string;
    '--focus': string;
    '--link': string;
}

/** `#rgb` or `#rrggbb`, with or without the hash. */
export function parseHex(hex: string): [number, number, number] | null {
    const value = hex.trim().replace(/^#/, '');
    const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) {
        return null;
    }
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function toHex([r, g, b]: [number, number, number]): string {
    const channel = (v: number) =>
        Math.max(0, Math.min(255, Math.round(v)))
            .toString(16)
            .padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 *
 * Worth the gamma expansion rather than averaging the channels: sRGB is not
 * linear, and a naive average calls a saturated blue as bright as a yellow of
 * the same numbers, which is exactly the case that decides whether a label on it
 * should be white or black.
 */
export function luminance(rgb: [number, number, number]): number {
    const [r, g, b] = rgb.map((v) => {
        const channel = v / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Where a colour stops wanting white text and starts wanting dark. Both shipped
// themes land on the right side of it: the light theme's #3578e5 is 0.20 and
// carries white, the dark theme's #49cee9 is 0.51 and carries #181818.
const LIGHT_TEXT_BELOW = 0.5;

// How far the hover state moves, as a fraction toward black or white. The
// direction is the theme's, not the colour's: the light theme darkens its accent
// on hover and the dark theme lightens its own, and a hover that moved the other
// way would read as the control lighting up when it should be pressing in.
const HOVER_SHIFT = 0.12;

function mix(rgb: [number, number, number], toward: 0 | 255, amount: number): [number, number, number] {
    return rgb.map((v) => v + (toward - v) * amount) as [number, number, number];
}

/**
 * The five custom properties for `hex`, or null if it does not parse.
 *
 * `isDark` is the *theme*, not the colour -- see `HOVER_SHIFT`.
 */
export function deriveAccent(hex: string, isDark: boolean): AccentTokens | null {
    const rgb = parseHex(hex);
    if (rgb === null) {
        return null;
    }
    const accent = toHex(rgb);
    const hover = toHex(mix(rgb, isDark ? 255 : 0, HOVER_SHIFT));
    // `#181818`, not `#000000`: it is the foreground both themes already use,
    // and full black against a saturated accent reads as a hole in it.
    const foreground = luminance(rgb) > LIGHT_TEXT_BELOW ? '#181818' : '#ffffff';
    return {
        '--accent': accent,
        '--accent-hover': hover,
        '--accent-foreground': foreground,
        '--focus': accent,
        '--link': accent,
    };
}

/** The value meaning "leave the theme's own accent alone". */
export const DEFAULT_ACCENT = 'default';

// Offered as swatches in Settings. Deliberately a short list of colours that
// hold up on both themes -- the point is a quick choice, and anything else is
// what the custom picker beside them is for.
export const ACCENT_PRESETS = [
    '#3578e5', // the light theme's own blue
    '#49cee9', // the dark theme's own cyan
    '#16a34a',
    '#ca8a04',
    '#ea580c',
    '#dc2626',
    '#db2777',
    '#7c3aed',
];
