import { describe, expect, it } from 'vitest';
import { csvCell, csvObjects, parseCsv, toCsv } from '../src/ui/csv';

describe('CSV', () => {
  it('neutralises formula injection and quotes when needed', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });
  it('parses quoted fields, escaped quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿name,email\r\n"Perera, Nimal","n@x.co"\n"Say ""hi""",b@x.co\n\n')).toEqual([
      ['name', 'email'],
      ['Perera, Nimal', 'n@x.co'],
      ['Say "hi"', 'b@x.co'],
    ]);
    expect(csvObjects('Name,Email,Department\nA,a@x.co,Ops')).toEqual([{ name: 'A', email: 'a@x.co', department: 'Ops' }]);
  });
});
