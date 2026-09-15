// Decoding of diff output whose file contents are not UTF-8 (EUC-KR/CP949,
// Shift_JIS, GBK, ...).
//
// git emits file contents byte-for-byte, so a diff of a legacy-encoded file is
// not valid UTF-8. Decoding the whole stdout as UTF-8 irreversibly turns every
// non-ASCII byte into U+FFFD, which is why Korean text in EUC-KR files showed
// up garbled in the diff view. Instead, diffs are kept as raw bytes and decoded
// per file section: a section that is valid UTF-8 stays UTF-8; otherwise its
// header (paths, which `core.quotePath=false` emits as UTF-8) is decoded as
// UTF-8 and its hunk contents with the first fallback encoding that decodes it
// without errors.
//
// Like `git-binary.ts`, this module is free of any `vscode` import. The
// extension entry point resolves the `gitGraphPlus.diffEncoding` setting (and
// VS Code's `files.encoding` / display language for `auto`) and calls
// `setDiffFallbackEncodings`.

/**
 * WHATWG labels tried, in order, for non-UTF-8 diff sections. The first that
 * decodes a section without errors wins; the last is used leniently if none
 * does. Empty disables the fallback (lossy UTF-8).
 */
let fallbackEncodings: string[] = [];

/** CJK legacy encodings `auto` tries when no locale hint names one. */
const AUTO_CANDIDATES = ['euc-kr', 'shift_jis', 'gbk', 'big5'];

// Normalized (lowercase, alphanumerics only) encoding ids — VS Code
// `files.encoding` values and common aliases — mapped to WHATWG labels that
// `TextDecoder` understands.
const ENCODING_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  utf8bom: 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  euckr: 'euc-kr',
  cp949: 'euc-kr',
  windows949: 'euc-kr',
  uhc: 'euc-kr',
  ksc56011987: 'euc-kr',
  shiftjis: 'shift_jis',
  sjis: 'shift_jis',
  cp932: 'shift_jis',
  windows31j: 'shift_jis',
  eucjp: 'euc-jp',
  gbk: 'gbk',
  gb2312: 'gbk',
  cp936: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  big5hkscs: 'big5',
  cp950: 'big5',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
  cp866: 'ibm866',
  macroman: 'macintosh',
  cp437: 'windows-1252',
  cp850: 'windows-1252',
};

/**
 * Normalize a user/VS Code encoding id (`cp949`, `EUC-KR`, `windows1252`,
 * `iso88591`, ...) to a WHATWG label supported by this runtime's `TextDecoder`.
 * Returns null for blank, `auto`, or unsupported values.
 */
export function normalizeEncoding(id: string | undefined | null): string | null {
  if (!id) return null;
  const key = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key || key === 'auto') return null;
  let label = ENCODING_ALIASES[key];
  if (!label) {
    const win = /^(?:windows|cp)(125\d)$/.exec(key);
    const iso = /^iso8859(\d{1,2})$/.exec(key);
    label = win ? `windows-${win[1]}` : iso ? `iso-8859-${iso[1]}` : id.trim();
  }
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return null;
  }
}

/**
 * Legacy encoding conventionally used for a locale (e.g. `ko` → EUC-KR/CP949).
 * Returns null for locales whose legacy files are not commonly non-UTF-8 CJK.
 */
export function legacyEncodingForLocale(locale: string | undefined | null): string | null {
  const l = (locale ?? '').toLowerCase();
  if (l.startsWith('ko')) return 'euc-kr';
  if (l.startsWith('ja')) return 'shift_jis';
  if (l === 'zh-tw' || l === 'zh-hk' || l.startsWith('zh-hant')) return 'big5';
  if (l.startsWith('zh')) return 'gbk';
  return null;
}

/**
 * Resolve the fallback encodings (in try order) from the extension settings.
 *
 * - An explicit `gitGraphPlus.diffEncoding` wins (`utf8` disables the fallback).
 * - `auto` tries VS Code's `files.encoding` when it is not UTF-8, then the
 *   legacy encodings of CJK locales among `locales` (VS Code display language,
 *   OS locale), then EUC-KR/Shift_JIS/GBK/Big5, then windows-1252. Locale hints
 *   are often absent (e.g. an English UI on a machine editing Korean sources),
 *   so the content itself decides among the candidates.
 */
export function resolveDiffFallbackEncodings(
  setting: string | undefined,
  filesEncoding: string | undefined,
  locales: Array<string | undefined>,
): string[] {
  const explicit = normalizeEncoding(setting);
  if (explicit) return explicit === 'utf-8' ? [] : [explicit];

  const candidates: string[] = [];
  const fromFiles = normalizeEncoding(filesEncoding);
  if (fromFiles && fromFiles !== 'utf-8') candidates.push(fromFiles);
  for (const locale of locales) {
    const legacy = legacyEncodingForLocale(locale);
    if (legacy) candidates.push(legacy);
  }
  candidates.push(...AUTO_CANDIDATES, 'windows-1252');
  return [...new Set(candidates)];
}

/** Set the encodings tried (in order) for diff sections that are not valid UTF-8. */
export function setDiffFallbackEncodings(encodings: string[] | null | undefined): void {
  const labels = (encodings ?? []).map(normalizeEncoding).filter((e): e is string => !!e && e !== 'utf-8');
  fallbackEncodings = [...new Set(labels)];
}

/** The current fallback encodings (WHATWG labels); empty when disabled. */
export function getDiffFallbackEncodings(): string[] {
  return fallbackEncodings;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Lenient = new TextDecoder('utf-8');

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    utf8Strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Byte offsets at which each `diff ...` file section starts (always includes 0). */
function sectionStarts(buf: Buffer): number[] {
  const starts = [0];
  let i = buf.indexOf('\ndiff ');
  while (i !== -1) {
    starts.push(i + 1);
    i = buf.indexOf('\ndiff ', i + 1);
  }
  return starts;
}

/** Decode with the first encoding that yields no errors; the last one leniently. */
function decodeContent(bytes: Buffer, encodings: string[]): string {
  for (let i = 0; i < encodings.length - 1; i++) {
    try {
      return new TextDecoder(encodings[i], { fatal: true }).decode(bytes);
    } catch { /* not this encoding (or unsupported label) — try the next */ }
  }
  try {
    return new TextDecoder(encodings[encodings.length - 1]).decode(bytes);
  } catch {
    return utf8Lenient.decode(bytes);
  }
}

function decodeSection(section: Buffer, encodings: string[]): string {
  if (isValidUtf8(section)) return utf8Lenient.decode(section);
  // Header lines (diff --git, index, ---/+++ paths, rename from/to) are UTF-8;
  // everything from the first hunk on is file content.
  const startsWithHunk = section.subarray(0, 2).toString('latin1') === '@@';
  const split = startsWithHunk ? 0 : section.indexOf('\n@@') + 1;
  if (split === 0 && !startsWithHunk) return utf8Lenient.decode(section);
  return utf8Lenient.decode(section.subarray(0, split)) + decodeContent(section.subarray(split), encodings);
}

/**
 * Decode raw `git diff`/`git show` output for display. Valid UTF-8 file
 * sections decode as UTF-8; other sections decode their contents with the
 * first of `encodings` (defaults to the configured fallbacks) that fits.
 */
export function decodeDiffOutput(buf: Buffer, encodings: string[] = fallbackEncodings): string {
  if (encodings.length === 0 || isValidUtf8(buf)) return utf8Lenient.decode(buf);
  const starts = sectionStarts(buf);
  let out = '';
  for (let s = 0; s < starts.length; s++) {
    out += decodeSection(buf.subarray(starts[s], starts[s + 1] ?? buf.length), encodings);
  }
  return out;
}
