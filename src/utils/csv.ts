// CSV, for the two things the app lets the user take out of it: the history and
// the glossary. Both hold text the user wrote or a service returned, so neither
// direction may assume anything about what a field contains -- a term can hold a
// comma, a translation can hold quotes, and an OCR read can hold a newline.

/** A field's value as it goes in or comes out. Everything is text on the wire. */
export type CsvRow = Record<string, string>;

/**
 * Rows to RFC 4180 CSV.
 *
 * Every field is quoted rather than only the ones that need it. Quoting
 * conditionally is the same number of lines and one more thing to get wrong,
 * and a reader has to handle quoted fields either way.
 *
 * The BOM is what makes Excel open the file as UTF-8 instead of guessing the
 * system codepage, which is the difference between a glossary of Chinese terms
 * arriving intact and arriving as mojibake.
 */
export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = [columns.map(escape).join(',')];
    for (const row of rows) {
        lines.push(columns.map((column) => escape(row[column])).join(','));
    }
    // CRLF, per the RFC, and what Excel expects.
    return '﻿' + lines.join('\r\n');
}

/**
 * CSV to rows keyed by the header line.
 *
 * A character-at-a-time parser rather than `split(',')`, because splitting is
 * wrong for exactly the data this is for: a quoted field may contain a comma, a
 * newline, or a doubled quote standing for one quote. Round-trips `toCsv`.
 *
 * Unterminated quotes and ragged rows are tolerated rather than rejected --
 * these files get hand-edited in a spreadsheet, and refusing the whole import
 * over one malformed line helps nobody. A row with fewer fields than the header
 * leaves the rest empty; extra fields are dropped.
 */
export function parseCsv(text: string): CsvRow[] {
    // Strip the BOM `toCsv` writes, or the first column name carries it and no
    // lookup by that name matches.
    const source = text.replace(/^﻿/, '');

    const records: string[][] = [];
    let field = '';
    let record: string[] = [];
    let quoted = false;
    let i = 0;

    const endField = () => {
        record.push(field);
        field = '';
    };
    const endRecord = () => {
        endField();
        records.push(record);
        record = [];
    };

    while (i < source.length) {
        const char = source[i];

        if (quoted) {
            if (char === '"') {
                // A doubled quote inside a quoted field is one literal quote;
                // a single one closes the field.
                if (source[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
                i += 1;
                continue;
            }
            field += char;
            i += 1;
            continue;
        }

        if (char === '"') {
            quoted = true;
            i += 1;
            continue;
        }
        if (char === ',') {
            endField();
            i += 1;
            continue;
        }
        if (char === '\r' || char === '\n') {
            endRecord();
            // CRLF is one break, not two.
            i += char === '\r' && source[i + 1] === '\n' ? 2 : 1;
            continue;
        }
        field += char;
        i += 1;
    }
    // Whatever is still in hand when the text runs out is the last record,
    // unless the file ended on its final newline and there is nothing pending.
    if (field !== '' || record.length > 0) {
        endRecord();
    }

    const [header, ...body] = records;
    if (!header) {
        return [];
    }
    return (
        body
            // A trailing newline leaves a record of one empty field, which is not a row.
            .filter((fields) => fields.some((value) => value !== ''))
            .map((fields) => {
                const row: CsvRow = {};
                header.forEach((column, index) => {
                    row[column] = fields[index] ?? '';
                });
                return row;
            })
    );
}
