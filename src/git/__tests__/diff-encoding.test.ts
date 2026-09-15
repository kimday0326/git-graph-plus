import { describe, it, expect, afterEach } from 'vitest';
import {
  decodeDiffOutput,
  getDiffFallbackEncodings,
  legacyEncodingForLocale,
  normalizeEncoding,
  resolveDiffFallbackEncodings,
  setDiffFallbackEncodings,
} from '../diff-encoding';

// "한글" in EUC-KR/CP949 — not valid UTF-8.
const HANGUL_EUCKR = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
// "test 한국어어어어어" in EUC-KR/CP949.
const SENTENCE_EUCKR = Buffer.concat([
  Buffer.from('test '),
  Buffer.from([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee, 0xbe, 0xee, 0xbe, 0xee, 0xbe, 0xee, 0xbe, 0xee]),
]);

function diffFor(path: string, removed: Buffer | string, added: Buffer | string): Buffer {
  const bytes = (v: Buffer | string) => (typeof v === 'string' ? Buffer.from(v) : v);
  return Buffer.concat([
    Buffer.from(`diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-`),
    bytes(removed),
    Buffer.from('\n+'),
    bytes(added),
    Buffer.from('\n'),
  ]);
}

describe('normalizeEncoding', () => {
  it('maps VS Code / common Korean ids to euc-kr', () => {
    for (const id of ['cp949', 'CP949', 'euckr', 'EUC-KR', 'windows949']) {
      expect(normalizeEncoding(id)).toBe('euc-kr');
    }
  });

  it('maps windows/iso ids and utf8 variants', () => {
    expect(normalizeEncoding('windows1252')).toBe('windows-1252');
    expect(normalizeEncoding('iso88591')).toBe('iso-8859-1');
    expect(normalizeEncoding('utf8bom')).toBe('utf-8');
  });

  it('returns null for auto, blank, and unknown encodings', () => {
    expect(normalizeEncoding('auto')).toBeNull();
    expect(normalizeEncoding('')).toBeNull();
    expect(normalizeEncoding(undefined)).toBeNull();
    expect(normalizeEncoding('not-an-encoding')).toBeNull();
  });
});

describe('legacyEncodingForLocale', () => {
  it('picks the CJK legacy encoding for the locale', () => {
    expect(legacyEncodingForLocale('ko')).toBe('euc-kr');
    expect(legacyEncodingForLocale('ko-KR')).toBe('euc-kr');
    expect(legacyEncodingForLocale('ja')).toBe('shift_jis');
    expect(legacyEncodingForLocale('zh-cn')).toBe('gbk');
    expect(legacyEncodingForLocale('zh-tw')).toBe('big5');
    expect(legacyEncodingForLocale('en')).toBeNull();
  });
});

describe('resolveDiffFallbackEncodings', () => {
  it('uses only an explicit setting', () => {
    expect(resolveDiffFallbackEncodings('cp949', 'shiftjis', ['ja'])).toEqual(['euc-kr']);
  });

  it('disables the fallback for an explicit utf8 setting', () => {
    expect(resolveDiffFallbackEncodings('utf8', 'cp949', ['ko'])).toEqual([]);
  });

  it('auto puts files.encoding and locale hints first', () => {
    expect(resolveDiffFallbackEncodings('auto', 'shiftjis', ['en', 'zh-tw']))
      .toEqual(['shift_jis', 'big5', 'euc-kr', 'gbk', 'windows-1252']);
  });

  it('auto without hints still tries CJK encodings before windows-1252', () => {
    expect(resolveDiffFallbackEncodings('auto', 'utf8', ['en', 'en-US']))
      .toEqual(['euc-kr', 'shift_jis', 'gbk', 'big5', 'windows-1252']);
  });
});

describe('decodeDiffOutput', () => {
  afterEach(() => setDiffFallbackEncodings([]));

  it('decodes valid UTF-8 output as UTF-8 even with fallbacks set', () => {
    const buf = diffFor('a.txt', '한글', '글자');
    expect(decodeDiffOutput(buf, ['euc-kr'])).toBe(buf.toString('utf8'));
  });

  it('decodes EUC-KR file contents with the fallback encoding', () => {
    const text = decodeDiffOutput(diffFor('a.txt', HANGUL_EUCKR, 'ascii'), ['euc-kr']);
    expect(text).toContain('\n-한글\n+ascii\n');
  });

  it('auto with no locale hint decodes EUC-KR instead of windows-1252 mojibake', () => {
    const encodings = resolveDiffFallbackEncodings('auto', 'utf8', ['en-US']);
    const text = decodeDiffOutput(diffFor('a.txt', SENTENCE_EUCKR, 'x'), encodings);
    expect(text).toContain('-test 한국어어어어어\n');
  });

  it('skips a candidate that fails and uses the next one that fits', () => {
    // 0xFF is not a valid EUC-KR byte, so windows-1252 is used.
    const text = decodeDiffOutput(diffFor('a.txt', Buffer.from([0xff]), 'x'), ['euc-kr', 'windows-1252']);
    expect(text).toContain('-ÿ\n');
  });

  it('keeps UTF-8 paths in the header of a non-UTF-8 section', () => {
    const text = decodeDiffOutput(diffFor('문서.txt', HANGUL_EUCKR, 'x'), ['euc-kr']);
    expect(text).toContain('+++ b/문서.txt\n');
    expect(text).toContain('-한글\n');
  });

  it('chooses the encoding per file section', () => {
    const buf = Buffer.concat([diffFor('utf.txt', '가나', 'x'), diffFor('legacy.txt', HANGUL_EUCKR, 'y')]);
    const text = decodeDiffOutput(buf, ['euc-kr']);
    expect(text).toContain('-가나\n');
    expect(text).toContain('-한글\n');
  });

  it('without fallbacks, decodes lossily as UTF-8', () => {
    const text = decodeDiffOutput(diffFor('a.txt', HANGUL_EUCKR, 'x'), []);
    expect(text).toContain('�');
  });

  it('uses the configured fallbacks by default', () => {
    setDiffFallbackEncodings(['cp949', 'utf8']);
    expect(getDiffFallbackEncodings()).toEqual(['euc-kr']);
    expect(decodeDiffOutput(diffFor('a.txt', HANGUL_EUCKR, 'x'))).toContain('-한글\n');
  });
});
