import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GitService } from '../../git-service';
import { setDiffFallbackEncodings } from '../../diff-encoding';
import { TempRepo, commit, createTempRepo } from './helpers';

// "안녕\n" and "한글\n" encoded as EUC-KR/CP949.
const ANNYEONG_EUCKR = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0x0a]);
const HANGUL_EUCKR = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]);

describe('GitService integration — non-UTF-8 diffs', () => {
  let repo: TempRepo;
  let svc: GitService;
  let hash: string;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    setDiffFallbackEncodings(['cp949']);
    commit(repo.path, 'base', { 'legacy.txt': ANNYEONG_EUCKR, 'modern.txt': '안녕\n' });
    hash = commit(repo.path, 'change', { 'legacy.txt': HANGUL_EUCKR, 'modern.txt': '한글\n' });
  });
  afterEach(() => {
    setDiffFallbackEncodings([]);
    repo.cleanup();
  });

  it('shows EUC-KR file contents readably in a commit diff', async () => {
    const [diff] = await svc.showCommitDiff(hash, 'legacy.txt');
    const lines = diff.hunks[0].lines.map(l => l.content);
    expect(lines).toContain('안녕');
    expect(lines).toContain('한글');
  });

  it('decodes each file of a whole-commit diff with its own encoding', async () => {
    const diffs = await svc.showCommitDiff(hash);
    for (const file of ['legacy.txt', 'modern.txt']) {
      const d = diffs.find(x => x.file === file)!;
      expect(d.hunks[0].lines.map(l => l.content)).toEqual(expect.arrayContaining(['안녕', '한글']));
    }
  });

  it('reverses a change to an EUC-KR file byte-exactly', async () => {
    await svc.reverseCommitChanges(hash, 'legacy.txt');
    expect(readFileSync(join(repo.path, 'legacy.txt')).equals(ANNYEONG_EUCKR)).toBe(true);
  });

  it('exports a patch that keeps the original EUC-KR bytes', async () => {
    const patch = await svc.formatPatch(hash, ['legacy.txt']);
    expect(patch.includes(HANGUL_EUCKR)).toBe(true);
  });
});
