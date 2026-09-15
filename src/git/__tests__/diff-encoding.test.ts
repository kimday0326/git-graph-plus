import { describe, it, expect, afterEach } from 'vitest';
import {
  decodeDiffOutput,
  getDiffFallbackEncoding,
  legacyEncodingForLocale,
  normalizeEncoding,
  resolveDiffFallbackEncoding,
  setDiffFallbackEncoding,
} from '../diff-encoding';

// "한글" in EUC-KR/CP949 — not valid UTF-8.
const HANGUL_EUCKR = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);

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

describe('resolveDiffFallbackEncoding', () => {
  it('uses an explicit setting over everything else', () => {
    expect(resolveDiffFallbackEncoding('cp949', 'shiftjis', ['ja'])).toBe('euc-kr');
  });

  it('disables the fallback for an explicit utf8 setting', () => {
    expect(resolveDiffFallbackEncoding('utf8', 'cp949', ['ko'])).toBeNull();
  });

  it('auto follows a non-UTF-8 files.encoding', () => {
    expect(resolveDiffFallbackEncoding('auto', 'euckr', ['en'])).toBe('euc-kr');
  });

  it('auto falls back to the first CJK locale, then windows-1252', () => {
    expect(resolveDiffFallbackEncoding('auto', 'utf8', ['en', 'ko-KR'])).toBe('euc-kr');
    expect(resolveDiffFallbackEncoding('auto', 'utf8', ['en', 'en-US'])).toBe('windows-1252');
  });
});

describe('decodeDiffOutput', () => {
  afterEach(() => setDiffFallbackEncoding(null));

  it('decodes valid UTF-8 output as UTF-8 even with a fallback set', () => {
    const buf = diffFor('a.txt', '한글', '글자');
    expect(decodeDiffOutput(buf, 'euc-kr')).toBe(buf.toString('utf8'));
  });

  it('decodes EUC-KR file contents with the fallback encoding', () => {
    const text = decodeDiffOutput(diffFor('a.txt', HANGUL_EUCKR, 'ascii'), 'euc-kr');
    expect(text).toContain('\n-한글\n+ascii\n');
  });

  it('keeps UTF-8 paths in the header of a non-UTF-8 section', () => {
    const text = decodeDiffOutput(diffFor('문서.txt', HANGUL_EUCKR, 'x'), 'euc-kr');
    expect(text).toContain('+++ b/문서.txt\n');
    expect(text).toContain('-한글\n');
  });

  it('chooses the encoding per file section', () => {
    const buf = Buffer.concat([diffFor('utf.txt', '가나', 'x'), diffFor('legacy.txt', HANGUL_EUCKR, 'y')]);
    const text = decodeDiffOutput(buf, 'euc-kr');
    expect(text).toContain('-가나\n');
    expect(text).toContain('-한글\n');
  });

  it('without a fallback, decodes lossily as UTF-8', () => {
    const text = decodeDiffOutput(diffFor('a.txt', HANGUL_EUCKR, 'x'), null);
    expect(text).toContain('�');
  });

  it('uses the configured fallback by default', () => {
    setDiffFallbackEncoding('cp949');
    expect(getDiffFallbackEncoding()).toBe('euc-kr');
    expect(decodeDiffOutput(diffFor('a.txt', HANGUL_EUCKR, 'x'))).toContain('-한글\n');
  });

  it('treats utf8 as no fallback', () => {
    setDiffFallbackEncoding('utf8');
    expect(getDiffFallbackEncoding()).toBeNull();
  });
});
