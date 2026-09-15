import { describe, it, expect, vi, beforeEach } from 'vitest';

// extension.ts is the activation entry point — heavily vscode-bound. We can't
// run the real extension host, but we can verify the wiring: which commands and
// tree views get registered, the no-workspace fallback, and the pure git-path
// resolver. Everything it imports is stubbed so activate() runs to completion.
const H = vi.hoisted(() => ({
  registeredCommands: [] as string[],
  commandHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
  treeViewsCreated: [] as string[],
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  gitPathConfig: null as string | string[] | null,
  worktreeList: [] as Array<{ path: string; isMain: boolean }>,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === 'git' && key === 'path') return H.gitPathConfig;
        return def;
      },
    }),
    get workspaceFolders() { return H.workspaceFolders; },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
  window: {
    createTreeView: (id: string) => { H.treeViewsCreated.push(id); return { description: '', dispose() {} }; },
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(async () => undefined),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    activeTextEditor: undefined,
  },
  commands: {
    registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => { H.registeredCommands.push(id); H.commandHandlers[id] = cb; return { dispose() {} }; },
    executeCommand: vi.fn(),
  },
  extensions: { getExtension: () => undefined },
  env: { language: 'en' },
  l10n: { t: (s: string) => s },
  Uri: { joinPath: () => ({}), file: (p: string) => ({ fsPath: p }), parse: () => ({}) },
  ViewColumn: { One: 1 },
}));

vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../git/git-binary', () => ({ setGitBinaryPath: vi.fn() }));
vi.mock('../panels/MainPanel', () => ({
  MainPanel: class {
    static currentPanel: unknown = undefined;
    static setExtraEnv = vi.fn();
    static setAvatarCacheDir = vi.fn();
    static createOrShow = vi.fn();
    static showModalWithPanel = vi.fn();
    static onSidebarRefresh: unknown = null;
    static onRepoChange: unknown = null;
  },
}));
vi.mock('../git/git-service', () => ({ GitService: class { setExtraEnv() {} setDefaultTimeout() {} get rootPath() { return '/repo'; } worktreeList() { return Promise.resolve(H.worktreeList); } } }));
vi.mock('../services/file-watcher', () => ({ FileWatcher: class { enabled = true; suppress() {} dispose() {} } }));
const viewStub = () => ({ ViewProvider: undefined });
vi.mock('../views/branches-view', () => ({ BranchesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } getCurrentItem() { return null; } } }));
vi.mock('../views/remotes-view', () => ({ RemotesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/tags-view', () => ({ TagsViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/stashes-view', () => ({ StashesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/worktrees-view', () => ({ WorktreesViewProvider: class { refresh() {} dispose() {} setGitService() {} prefetch() { return Promise.resolve(); } } }));
vi.mock('../views/status-bar', () => ({ StatusBarManager: class { dispose() {} } }));
vi.mock('../services/repo-discovery', () => ({ RepoDiscoveryService: { discoverRepos: vi.fn(async () => []), clearCache: vi.fn() } }));
void viewStub;

import { activate, resolveConfiguredGitPath } from '../extension';
import { existsSync } from 'fs';

function makeContext() {
  return { subscriptions: [] as Array<{ dispose(): void }>, extensionUri: {} } as unknown as import('vscode').ExtensionContext;
}

beforeEach(() => {
  H.registeredCommands = [];
  H.commandHandlers = {};
  H.treeViewsCreated = [];
  H.workspaceFolders = undefined;
  H.gitPathConfig = null;
  H.worktreeList = [];
  vi.mocked(existsSync).mockReturnValue(true);
});

describe('resolveConfiguredGitPath', () => {
  it('returns undefined when nothing is configured', () => {
    H.gitPathConfig = null;
    expect(resolveConfiguredGitPath()).toBeUndefined();
  });

  it('returns a single configured path when it exists', () => {
    H.gitPathConfig = '/usr/local/bin/git';
    vi.mocked(existsSync).mockReturnValue(true);
    expect(resolveConfiguredGitPath()).toBe('/usr/local/bin/git');
  });

  it('returns the first existing candidate from an array', () => {
    H.gitPathConfig = ['/missing/git', '/real/git'];
    vi.mocked(existsSync).mockImplementation((p) => p === '/real/git');
    expect(resolveConfiguredGitPath()).toBe('/real/git');
  });

  it('returns undefined when no configured candidate exists', () => {
    H.gitPathConfig = ['/a/git', '/b/git'];
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveConfiguredGitPath()).toBeUndefined();
  });
});

describe('activate', () => {
  it('with no workspace folder, registers only the open fallbacks and no tree views', () => {
    H.workspaceFolders = undefined;
    const ctx = makeContext();
    activate(ctx);
    expect(H.registeredCommands).toContain('git-graph-plus.open');
    expect(H.registeredCommands).toContain('gitGraphPlus.open');
    expect(H.treeViewsCreated).toEqual([]);
    expect(ctx.subscriptions.length).toBeGreaterThan(0);
  });

  it('with a workspace folder, registers the full command set and all five tree views', () => {
    H.workspaceFolders = [{ uri: { fsPath: '/repo' } }];
    const ctx = makeContext();
    expect(() => activate(ctx)).not.toThrow();

    for (const id of ['gitGraphPlus.open', 'gitGraphPlus.refresh', 'gitGraphPlus.fetch', 'gitGraphPlus.pull', 'gitGraphPlus.push', 'gitGraphPlus.createBranch']) {
      expect(H.registeredCommands).toContain(id);
    }
    expect(H.registeredCommands.length).toBeGreaterThan(15);
    expect(H.treeViewsCreated).toEqual([
      'gitGraphPlus.branches',
      'gitGraphPlus.remotes',
      'gitGraphPlus.tags',
      'gitGraphPlus.stashes',
      'gitGraphPlus.worktrees',
    ]);
  });

  it('addWorktree defaults beside the main worktree even when active repo is linked worktree', async () => {
    H.workspaceFolders = [{ uri: { fsPath: '/repos/project.worktrees/custom.worktrees' } }];
    H.worktreeList = [
      { path: '/repos/project', isMain: true },
      { path: '/repos/project.worktrees/custom.worktrees', isMain: false },
    ];
    const ctx = makeContext();
    activate(ctx);

    await H.commandHandlers['gitGraphPlus.addWorktree']();

    const { MainPanel } = await import('../panels/MainPanel');
    expect(MainPanel.showModalWithPanel).toHaveBeenCalledWith(ctx.extensionUri, {
      modal: 'addWorktree',
      defaultPath: '/repos/project.worktrees',
    });
  });
});
