// csv-reader-speed-01: a faster drop-in for csv-reader 1.0.0.
//
// Same answers as make.fun's csv-reader 1.0.0 for every input (same broken-row
// policy, same error records, same line/row bookkeeping), reached faster:
// the reference builds every field one character at a time; this reader
// jumps from delimiter to delimiter with one regex scan and slices whole
// fields out of the text, so a field costs one slice instead of one string
// append per character. Quoted fields find their closing quote with
// indexOf and normalise doubled quotes and line breaks on the slice.
//
// The policy, restated from the competition rules:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote, each CRLF or lone CR inside it
//     is read as LF; what follows the closing quote up to the next comma or
//     line break is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     padded with "" (short_row, with fields: its count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on, row its record's index in rows (null for the header), in
//     the order met.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** One regex scan finds the next field delimiter: comma, LF or CR. */
const DELIM = /[,\n\r]/g;
/** Line breaks inside a quoted field: CRLF counts once, lone CR once, LF once. */
const INNER_BREAK = /\r\n|\r|\n/g;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `first` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field,
  // how it ended, and how many characters were kept after `first`.
  function readUnquoted(first) {
    let value = first;
    let start = pos;
    DELIM.lastIndex = pos;
    for (;;) {
      const m = DELIM.exec(text);
      if (m === null) {
        if (n > start) value += text.slice(start, n);
        pos = n;
        return { value, ended: END, added: value.length - first.length };
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (i > start) value += text.slice(start, i);
        pos = i + 1;
        return { value, ended: COMMA, added: value.length - first.length };
      }
      if (c === '\n') {
        if (i > start) value += text.slice(start, i);
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added: value.length - first.length };
      }
      // c === '\r'
      if (i > start) value += text.slice(start, i);
      if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added: value.length - first.length };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = i + 1;
      start = i + 1;
      DELIM.lastIndex = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: a quote followed by another quote is one
    // literal quote inside the field, not its end.
    let q = pos + 1;
    for (;;) {
      q = text.indexOf('"', q);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        q += 2;
        continue;
      }
      break;
    }
    const raw = text.slice(pos + 1, q);
    let value = raw;
    const hasQuote = raw.indexOf('"') !== -1;
    const hasBreak = raw.indexOf('\r') !== -1 || raw.indexOf('\n') !== -1;
    if (hasBreak) {
      const breaks = raw.match(INNER_BREAK);
      line += breaks.length;
      value = raw.replace(/\r\n?/g, '\n');
    }
    if (hasQuote) value = value.split('""').join('"');
    pos = q + 1;
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
