import { describe, expect, it } from 'vitest';

import { parseCsv, toCsv } from './csv';

// These two are each other's inverse, and both directions carry user text --
// glossary terms and translation results -- so the cases that matter are the
// ones where the text contains the delimiters themselves.

describe('toCsv', () => {
    it('quotes every field and writes a BOM', () => {
        expect(toCsv(['a', 'b'], [{ a: '1', b: '2' }])).toBe('﻿"a","b"\r\n"1","2"');
    });

    it('doubles embedded quotes', () => {
        expect(toCsv(['t'], [{ t: 'say "hi"' }])).toContain('"say ""hi"""');
    });

    it('writes missing and null fields as empty', () => {
        expect(toCsv(['a', 'b'], [{ a: null }])).toBe('﻿"a","b"\r\n"",""');
    });
});

describe('parseCsv', () => {
    it('reads a plain file', () => {
        expect(parseCsv('term,replacement\r\nbug,缺陷')).toEqual([{ term: 'bug', replacement: '缺陷' }]);
    });

    it('keeps commas and newlines inside quoted fields', () => {
        const rows = parseCsv('a,b\r\n"one, two","line\nbreak"');
        expect(rows).toEqual([{ a: 'one, two', b: 'line\nbreak' }]);
    });

    it('reads a doubled quote as one quote', () => {
        expect(parseCsv('t\r\n"say ""hi"""')).toEqual([{ t: 'say "hi"' }]);
    });

    it('ignores the BOM so the first column is addressable by name', () => {
        expect(parseCsv('﻿"term"\r\n"bug"')).toEqual([{ term: 'bug' }]);
    });

    it('pads a short row and drops a blank trailing line', () => {
        expect(parseCsv('a,b\r\nonly\r\n')).toEqual([{ a: 'only', b: '' }]);
    });

    it('returns nothing for an empty file', () => {
        expect(parseCsv('')).toEqual([]);
    });

    it('round-trips what toCsv writes', () => {
        const columns = ['term', 'replacement'];
        const rows = [
            { term: 'bug', replacement: '缺陷' },
            { term: 'say "hi"', replacement: 'one, two' },
            { term: 'multi\nline', replacement: '' },
        ];
        expect(parseCsv(toCsv(columns, rows))).toEqual(rows);
    });
});
