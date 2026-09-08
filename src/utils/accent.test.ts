import { describe, expect, it } from 'vitest';

import type { AccentTokens } from './accent';
import { deriveAccent, luminance, parseHex } from './accent';

// Both of these return `| null` for input they cannot read, and every call below
// passes input they can. Throwing rather than asserting non-null keeps the type
// checker satisfied without `!`, and turns a regression that started returning
// null into a named failure rather than a `cannot read property of null`.
function mustDerive(hex: string, isDark: boolean): AccentTokens {
    const tokens = deriveAccent(hex, isDark);
    if (tokens === null) {
        throw new Error(`deriveAccent unexpectedly rejected ${hex}`);
    }
    return tokens;
}

function mustLuminance(hex: string): number {
    const rgb = parseHex(hex);
    if (rgb === null) {
        throw new Error(`parseHex unexpectedly rejected ${hex}`);
    }
    return luminance(rgb);
}

describe('parseHex', () => {
    it('reads both lengths, with or without the hash', () => {
        expect(parseHex('#3578e5')).toEqual([53, 120, 229]);
        expect(parseHex('3578e5')).toEqual([53, 120, 229]);
        expect(parseHex('#abc')).toEqual([170, 187, 204]);
    });

    it('rejects anything else', () => {
        for (const bad of ['', '#', 'red', '#12', '#1234567', '#gggggg']) {
            expect(parseHex(bad)).toBeNull();
        }
    });
});

describe('luminance', () => {
    it('anchors at black and white', () => {
        expect(luminance([0, 0, 0])).toBeCloseTo(0, 5);
        expect(luminance([255, 255, 255])).toBeCloseTo(1, 5);
    });

    // The threshold in `deriveAccent` is only defensible if it puts the two
    // shipped accents on the sides they are actually on, so those are pinned.
    it('places both shipped accents where their themes put them', () => {
        expect(luminance([53, 120, 229])).toBeLessThan(0.5); // light theme, white text
        expect(luminance([73, 206, 233])).toBeGreaterThan(0.5); // dark theme, #181818 text
    });
});

describe('deriveAccent', () => {
    it('reproduces the foreground each shipped theme chose by hand', () => {
        expect(deriveAccent('#3578e5', false)?.['--accent-foreground']).toBe('#ffffff');
        expect(deriveAccent('#49cee9', true)?.['--accent-foreground']).toBe('#181818');
    });

    it('darkens on a light theme and lightens on a dark one', () => {
        const light = mustDerive('#3578e5', false);
        const dark = mustDerive('#3578e5', true);
        expect(mustLuminance(light['--accent-hover'])).toBeLessThan(luminance([53, 120, 229]));
        expect(mustLuminance(dark['--accent-hover'])).toBeGreaterThan(luminance([53, 120, 229]));
    });

    it('points focus and link at the accent itself', () => {
        const tokens = mustDerive('#16a34a', false);
        expect(tokens['--accent']).toBe('#16a34a');
        expect(tokens['--focus']).toBe('#16a34a');
        expect(tokens['--link']).toBe('#16a34a');
    });

    it('normalises shorthand and case', () => {
        expect(deriveAccent('ABC', false)?.['--accent']).toBe('#aabbcc');
    });

    it('stays in gamut at the extremes', () => {
        // White on a light theme darkens; black on a dark theme lightens. Neither
        // may produce a channel outside 00..ff.
        for (const [hex, isDark] of [
            ['#ffffff', false],
            ['#000000', true],
            ['#000000', false],
            ['#ffffff', true],
        ] as const) {
            const hover = mustDerive(hex, isDark)['--accent-hover'];
            expect(hover).toMatch(/^#[0-9a-f]{6}$/);
            expect(parseHex(hover)).not.toBeNull();
        }
    });

    it('returns null for a colour it cannot read', () => {
        expect(deriveAccent('not a colour', false)).toBeNull();
    });
});
