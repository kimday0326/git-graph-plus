import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Spins up a fresh git repository in a temp directory for one test, plus a
 * tearDown that the caller is expected to invoke from `afterEach`. Repos are
 * always created with a deterministic identity, `main` as the initial
 * branch, and `commit.gpgsign=false` so signing prompts never block tests.
 */
export interface TempRepo {
  path: string;
  cleanup(): void;
}

const NOISY_ENV_OVERRIDES = {
  // Prevent CI / user config from interfering with deterministic repos.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00+00:00',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00+00:00',
  // `LC_ALL=C` makes porcelain output deterministic across locales.
  LC_ALL: 'C',
};

export function runGit(cwd: string, args: string[], input?: string): string {
  return execSync(`git ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    input,
    env: { ...process.env, ...NOISY_ENV_OVERRIDES },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function createTempRepo(opts: { bare?: boolean } = {}): TempRepo {
  const path = mkdtempSync(join(tmpdir(), 'ggp-it-'));
  if (opts.bare) {
    runGit(path, ['init', '--bare', '--initial-branch=main']);
  } else {
    runGit(path, ['init', '--initial-branch=main']);
    runGit(path, ['config', 'commit.gpgsign', 'false']);
    runGit(path, ['config', 'tag.gpgsign', 'false']);
    runGit(path, ['config', 'user.name', 'Test User']);
    runGit(path, ['config', 'user.email', 'test@example.com']);
  }
  return {
    path,
    cleanup() {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

export function writeFile(repoPath: string, relPath: string, content: string | Buffer): void {
  const full = join(repoPath, relPath);
  const dir = full.substring(0, full.lastIndexOf('/'));
  if (dir && dir !== repoPath) mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

/**
 * Writes the given files (path → content) and creates a single commit. With
 * no files, creates an `--allow-empty` commit so tests can build chains of
 * empty commits cheaply.
 */
export function commit(repoPath: string, message: string, files?: Record<string, string | Buffer>): string {
  if (files) {
    for (const [name, content] of Object.entries(files)) writeFile(repoPath, name, content);
    runGit(repoPath, ['add', '-A']);
    runGit(repoPath, ['commit', '-m', message]);
  } else {
    runGit(repoPath, ['commit', '--allow-empty', '-m', message]);
  }
  return runGit(repoPath, ['rev-parse', 'HEAD']).trim();
}

/** Returns HEAD's full SHA. */
export function head(repoPath: string): string {
  return runGit(repoPath, ['rev-parse', 'HEAD']).trim();
}

/** Returns the current branch name (empty if detached). */
export function currentBranch(repoPath: string): string {
  return runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/**
 * Builds a repo with the topology: `main` (3 commits) and `feature` (2
 * additional commits branched from the second main commit). Useful as a
 * common starting point for branch/merge/rebase tests.
 */
export function seedBranches(repoPath: string): { mainTip: string; featureBase: string; featureTip: string } {
  commit(repoPath, 'init', { 'README.md': 'init\n' });
  const base = commit(repoPath, 'main second', { 'a.txt': 'a\n' });
  const mainTip = commit(repoPath, 'main third', { 'b.txt': 'b\n' });
  runGit(repoPath, ['checkout', '-b', 'feature', base]);
  commit(repoPath, 'feature first', { 'feature1.txt': 'f1\n' });
  const featureTip = commit(repoPath, 'feature second', { 'feature2.txt': 'f2\n' });
  runGit(repoPath, ['checkout', 'main']);
  return { mainTip, featureBase: base, featureTip };
}
