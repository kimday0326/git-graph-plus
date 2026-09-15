// Decoding of diff output whose file contents are not UTF-8 (EUC-KR/CP949,
// Shift_JIS, GBK, ...).
//
// git emits file contents byte-for-byte, so a diff of a legacy-encoded file is
// not valid UTF-8. Decoding the whole stdout as UTF-8 irreversibly turns every
// non-ASCII byte into U+FFFD, which is why Korean text in EUC-KR files showed
// up garbled in the diff view. Instead, diffs are kept as raw bytes and decoded
// per file section: a section that is valid UTF-8 stays UTF-8; otherwise its
// header (paths, which `core.quotePath=false` emits as UTF-8) is decoded as
// UTF-8 and its hunk contents with the configured fallback encoding.
//
// Like `git-binary.ts`, this module is free of any `vscode` import. The
// extension entry point resolves the `gitGraphPlus.diffEncoding` setting (and
// VS Code's `files.encoding` / display language for `auto`) and calls
// `setDiffFallbackEncoding`.

/** WHATWG encoding label used for non-UTF-8 diff sections, or null for none. */
let fallbackEncoding: string | null = null;

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
 * Resolve the fallback encoding from the extension settings.
 *
 * - An explicit `gitGraphPlus.diffEncoding` wins (`utf8` disables the fallback).
 * - `auto` follows VS Code's `files.encoding` when it is not UTF-8, otherwise
 *   the legacy encoding of the first CJK locale among `locales` (VS Code display
 *   language, OS locale), otherwise windows-1252.
 */
export function resolveDiffFallbackEncoding(
  setting: string | undefined,
  filesEncoding: string | undefined,
  locales: Array<string | undefined>,
): string | null {
  const explicit = normalizeEncoding(setting);
  if (explicit) return explicit === 'utf-8' ? null : explicit;

  const fromFiles = normalizeEncoding(filesEncoding);
  if (fromFiles && fromFiles !== 'utf-8') return fromFiles;

  for (const locale of locales) {
    const legacy = legacyEncodingForLocale(locale);
    if (legacy) return legacy;
  }
  return 'windows-1252';
}

/** Set the encoding used for diff sections that are not valid UTF-8. */
export function setDiffFallbackEncoding(encoding: string | null | undefined): void {
  fallbackEncoding = encoding ? normalizeEncoding(encoding) : null;
  if (fallbackEncoding === 'utf-8') fallbackEncoding = null;
}

/** The current fallback encoding (WHATWG label), or null when disabled. */
export function getDiffFallbackEncoding(): string | null {
  return fallbackEncoding;
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

function decodeSection(section: Buffer, encoding: string | null): string {
  if (!encoding || isValidUtf8(section)) return utf8Lenient.decode(section);
  // Header lines (diff --git, index, ---/+++ paths, rename from/to) are UTF-8;
  // everything from the first hunk on is file content.
  const hunkAt = section.subarray(0, 2).toString('latin1') === '@@' ? 0 : section.indexOf('\n@@');
  const split = hunkAt <= 0 ? hunkAt : hunkAt + 1;
  if (split === -1) return utf8Lenient.decode(section);
  return utf8Lenient.decode(section.subarray(0, split)) + new TextDecoder(encoding).decode(section.subarray(split));
}

/**
 * Decode raw `git diff`/`git show` output for display. Valid UTF-8 file
 * sections decode as UTF-8; other sections decode their contents with
 * `encoding` (defaults to the configured fallback).
 */
export function decodeDiffOutput(buf: Buffer, encoding: string | null = fallbackEncoding): string {
  if (!encoding || isValidUtf8(buf)) return utf8Lenient.decode(buf);
  const starts = sectionStarts(buf);
  let out = '';
  for (let s = 0; s < starts.length; s++) {
    out += decodeSection(buf.subarray(starts[s], starts[s + 1] ?? buf.length), encoding);
  }
  return out;
}
