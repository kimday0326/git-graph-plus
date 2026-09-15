import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync } from 'fs';
import { setGitBinaryPath } from './git/git-binary';
import { MainPanel } from './panels/MainPanel';
import { GitService } from './git/git-service';
import { FileWatcher } from './services/file-watcher';
import { BranchesViewProvider } from './views/branches-view';
import { RemotesViewProvider } from './views/remotes-view';
import { TagsViewProvider } from './views/tags-view';
import { StashesViewProvider } from './views/stashes-view';
import { WorktreesViewProvider } from './views/worktrees-view';
import { StatusBarManager } from './views/status-bar';
import { RepoDiscoveryService } from './services/repo-discovery';
import { samePath } from './utils/path';
import { resolveDefaultWorktreePath } from './utils/worktree-path';
import { readDiffFallbackEncoding, readTimeoutMs } from './utils/config';
import { setDiffFallbackEncoding } from './git/diff-encoding';

/**
 * Resolve the `git.path` setting to an existing executable. The setting may be
 * a single path or an array of candidates (VS Code uses the first that exists).
 * Returns undefined when nothing is configured or none of the candidates exist.
 */
export function resolveConfiguredGitPath(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
  const candidates = Array.isArray(cfg) ? cfg : cfg ? [cfg] : [];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
  // Status bar is always visible regardless of workspace state
  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // Persistent avatar cache lives under globalStorage so every window reuses
  // the same avatars instead of re-fetching from gravatar.com (issue #38).
  MainPanel.setAvatarCacheDir(vscode.Uri.joinPath(context.globalStorageUri, 'avatars').fsPath);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    context.subscriptions.push(
      vscode.commands.registerCommand('git-graph-plus.open', () => {
        vscode.window.showWarningMessage('Git Graph+: No workspace folder open.');
      }),
      vscode.commands.registerCommand('gitGraphPlus.open', () => {
        vscode.window.showWarningMessage('Git Graph+: No workspace folder open.');
      }),
    );
    // VS Code does not re-run activate() when the user opens a folder later
    // (e.g. starts from an empty window and uses File → Open Folder). The
    // extension would silently stay in no-workspace mode forever. When a
    // folder appears, prompt to reload so a fresh activate runs against the
    // new workspace.
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        if (e.added.length === 0) return;
        const reload = await vscode.window.showInformationMessage(
          vscode.l10n.t('Git Graph+: Reload window to activate the extension for the newly opened folder?'),
          vscode.l10n.t('Reload'),
        );
        if (reload) {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }),
    );
    return;
  }

  let activeRepoPath = workspaceFolder.uri.fsPath;

  // Resolve the git executable so the extension works when git is not on PATH
  // (e.g. portable/MSYS2 installs configured via `git.path`). The configured
  // path takes precedence; otherwise we fall back to the path the built-in git
  // extension resolved (set below once its API is available), then to PATH. #18
  let apiGitPath: string | undefined;
  const applyGitPath = () => setGitBinaryPath(resolveConfiguredGitPath() ?? apiGitPath);
  applyGitPath();
  setDiffFallbackEncoding(readDiffFallbackEncoding());

  let activeGitService = new GitService(activeRepoPath);
  activeGitService.setDefaultTimeout(readTimeoutMs());

  // Inject VS Code's built-in git extension askpass env so authentication prompts work
  const builtinGit = vscode.extensions.getExtension('vscode.git');
  if (builtinGit) {
    const waitForGit = builtinGit.isActive ? Promise.resolve(builtinGit.exports) : Promise.resolve(builtinGit.activate());
    waitForGit.then((ext: { getAPI(version: number): { git: { env?: Record<string, string>; path?: string } } }) => {
      try {
        const git = ext.getAPI(1)?.git;
        if (git?.env) {
          activeGitService.setExtraEnv(git.env);
          MainPanel.setExtraEnv(git.env);
        }
        // The built-in extension's resolved path already honors `git.path`; adopt
        // it as the fallback for when the user hasn't set a valid `git.path`.
        if (typeof git?.path === 'string' && git.path) {
          apiGitPath = git.path;
          applyGitPath();
        }
      } catch { /* built-in git extension API unavailable */ }
    }).catch(() => {});
  }

  // Re-resolve when the user changes `git.path` at runtime.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('git.path')) applyGitPath();
      if (e.affectsConfiguration('gitGraphPlus.timeout')) activeGitService.setDefaultTimeout(readTimeoutMs());
      if (e.affectsConfiguration('gitGraphPlus.diffEncoding') || e.affectsConfiguration('files.encoding')) {
        setDiffFallbackEncoding(readDiffFallbackEncoding());
      }
    }),
  );

  // --- Tree View Providers ---
  const branchesProvider = new BranchesViewProvider(activeGitService);
  const remotesProvider = new RemotesViewProvider(activeGitService);
  const tagsProvider = new TagsViewProvider(activeGitService);
  const stashesProvider = new StashesViewProvider(activeGitService);
  const worktreesProvider = new WorktreesViewProvider(activeGitService);

  const branchesView = vscode.window.createTreeView('gitGraphPlus.branches', { treeDataProvider: branchesProvider });
  const remotesView = vscode.window.createTreeView('gitGraphPlus.remotes', { treeDataProvider: remotesProvider });
  const tagsView = vscode.window.createTreeView('gitGraphPlus.tags', { treeDataProvider: tagsProvider });
  const stashesView = vscode.window.createTreeView('gitGraphPlus.stashes', { treeDataProvider: stashesProvider });
  const worktreesView = vscode.window.createTreeView('gitGraphPlus.worktrees', { treeDataProvider: worktreesProvider });

  const initialRepoName = path.basename(activeRepoPath);
  branchesView.description = initialRepoName;
  remotesView.description = initialRepoName;
  tagsView.description = initialRepoName;
  stashesView.description = initialRepoName;
  worktreesView.description = initialRepoName;

  context.subscriptions.push(
    branchesProvider,
    remotesProvider,
    tagsProvider,
    stashesProvider,
    worktreesProvider,
    branchesView,
    remotesView,
    tagsView,
    stashesView,
    worktreesView,
  );

  // Prefetch all tree view data in parallel so first expand is instant
  Promise.all([
    branchesProvider.prefetch(),
    remotesProvider.prefetch(),
    tagsProvider.prefetch(),
    stashesProvider.prefetch(),
    worktreesProvider.prefetch(),
  ]).catch((err) => { console.warn('Git Graph+: sidebar prefetch failed:', err instanceof Error ? err.message : err); });

  // --- File Watcher ---
  // This watcher owns the sidebar; the graph panel runs its own FileWatcher
  // (with a smarter partial-refresh path). When the panel is open, calling
  // postRefresh() here just duplicated that panel watcher's graph refresh;
  // when it's closed there's no panel to refresh. So this only refreshes the
  // sidebar. (The sidebar refresh shares one debounce timer with the panel
  // watcher's onSidebarRefresh, so they coalesce rather than double up.)
  let fileWatcher = new FileWatcher(activeRepoPath, () => {
    refreshAll();
  });
  fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
  context.subscriptions.push({ dispose: () => fileWatcher.dispose() });

  // Working-tree saves are already caught by FileWatcher's '**' watcher (it
  // classifies them as 'status' and refreshes both the sidebar and the panel,
  // debounced and gated on the autoRefresh setting). A separate
  // onDidSaveTextDocument handler here only duplicated that work — firing an
  // immediate, un-debounced full refresh on every save in any workspace repo,
  // even when autoRefresh was off — so it was removed.

  // --- Auto-detect Git Repo if root isn't one ---
  RepoDiscoveryService.discoverRepos([activeRepoPath]).then(repos => {
    if (repos.length > 0 && !repos.some(r => samePath(r.path, activeRepoPath))) {
      const firstRepo = repos[0].path;
      activeRepoPath = firstRepo;
      activeGitService = new GitService(activeRepoPath);
      activeGitService.setDefaultTimeout(readTimeoutMs());

      // Re-inject environment if needed
      if (builtinGit && builtinGit.exports) {
        try {
          const env = (builtinGit.exports as any).getAPI(1)?.git?.env;
          if (env) { activeGitService.setExtraEnv(env); }
        } catch { /* ignore */ }
      }
      
      // Update providers
      branchesProvider.setGitService(activeGitService);
      remotesProvider.setGitService(activeGitService);
      tagsProvider.setGitService(activeGitService);
      stashesProvider.setGitService(activeGitService);
      worktreesProvider.setGitService(activeGitService);

      // Update view descriptions
      const repoName = path.basename(activeRepoPath);
      branchesView.description = repoName;
      remotesView.description = repoName;
      tagsView.description = repoName;
      stashesView.description = repoName;
      worktreesView.description = repoName;

      // Update file watcher (sidebar-only; see the watcher above for why).
      fileWatcher.dispose();
      fileWatcher = new FileWatcher(activeRepoPath, () => {
        refreshAll();
      });
      fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);
    }
  }).catch((err) => { console.warn('Git Graph+: repo discovery failed:', err instanceof Error ? err.message : err); });

  // When workspace folders change (multi-root add/remove), re-discover repos
  // so the repo dropdown in the panel reflects reality. The panel-side
  // discovery cache is invalidated by sendRepoList(true).
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      RepoDiscoveryService.clearCache();
      MainPanel.currentPanel?.sendRepoList(true).catch(() => {});
      doSidebarRefresh();
    }),
  );

  let sidebarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let sidebarRefreshing = false;
  let sidebarRefreshQueued = false;
  context.subscriptions.push({
    dispose: () => {
      if (sidebarRefreshTimer) {
        clearTimeout(sidebarRefreshTimer);
        sidebarRefreshTimer = null;
      }
    },
  });
  async function doSidebarRefresh() {
    if (sidebarRefreshing) { sidebarRefreshQueued = true; return; }
    sidebarRefreshing = true;
    try {
      await Promise.all([
        branchesProvider.refresh(),
        remotesProvider.refresh(),
        tagsProvider.refresh(),
        stashesProvider.refresh(),
        worktreesProvider.refresh(),
      ]);

      // Reveal current branch in sidebar (auto-expands folders)
      // ONLY if the view is already visible to prevent jumping to the SCM tab
      const currentItem = branchesProvider.getCurrentItem();
      if (currentItem && branchesView.visible) {
        // Small delay to ensure the tree view has processed the data change
        setTimeout(() => {
          branchesView.reveal(currentItem, { select: false, focus: false, expand: true }).then(undefined, () => {});
        }, 100);
      }
    } finally {
      sidebarRefreshing = false;
      if (sidebarRefreshQueued) {
        sidebarRefreshQueued = false;
        // Re-run once more to pick up changes that arrived during refresh.
        doSidebarRefresh();
      }
    }
  }
  function refreshAll() {
    if (sidebarRefreshTimer) { clearTimeout(sidebarRefreshTimer); }
    sidebarRefreshTimer = setTimeout(() => {
      sidebarRefreshTimer = null;
      doSidebarRefresh();
    }, 300);
  }

  function switchToRepo(newPath: string) {
    if (samePath(newPath, activeRepoPath)) { return; }
    activeRepoPath = newPath;
    activeGitService = new GitService(newPath);
    activeGitService.setDefaultTimeout(readTimeoutMs());

    if (builtinGit) {
      const ext = builtinGit.exports;
      if (ext) {
        try {
          const env = ext.getAPI(1)?.git?.env;
          if (env) { activeGitService.setExtraEnv(env); }
        } catch { /* ignore */ }
      }
    }

    branchesProvider.setGitService(activeGitService);
    remotesProvider.setGitService(activeGitService);
    tagsProvider.setGitService(activeGitService);
    stashesProvider.setGitService(activeGitService);
    worktreesProvider.setGitService(activeGitService);

    const repoName = path.basename(newPath);
    branchesView.description = repoName;
    remotesView.description = repoName;
    tagsView.description = repoName;
    stashesView.description = repoName;
    worktreesView.description = repoName;

    fileWatcher.dispose();
    fileWatcher = new FileWatcher(newPath, () => {
      refreshAll();
    });
    fileWatcher.enabled = vscode.workspace.getConfiguration('gitGraphPlus').get<boolean>('autoRefresh', true);

    // If the webview panel is open, sync it to the new repo as well.
    // MainPanel.switchRepo() will call onRepoChange → switchToRepo again,
    // but the path.resolve guard above prevents an infinite loop.
    MainPanel.currentPanel?.switchRepo(newPath);

    refreshAll();
  }

  MainPanel.onSidebarRefresh = refreshAll;
  MainPanel.onRepoChange = switchToRepo;

  function getWorktreeUri(wtItem: { worktree?: { path?: string } } | undefined): vscode.Uri | undefined {
    const wtPath = wtItem?.worktree?.path;
    return wtPath ? vscode.Uri.file(wtPath) : undefined;
  }

  function openWorktree(wtItem: { worktree?: { path?: string } } | undefined): void {
    const uri = getWorktreeUri(wtItem);
    if (!uri) { return; }
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  }

  function openWorktreeInFileExplorer(wtItem: { worktree?: { path?: string } } | undefined): void {
    const uri = getWorktreeUri(wtItem);
    if (!uri) { return; }
    vscode.env.openExternal(uri);
  }

  // Auto-switch sidebar when the active editor moves to a different repo
  if (builtinGit) {
    const waitForGitApi = builtinGit.isActive
      ? Promise.resolve(builtinGit.exports)
      : Promise.resolve(builtinGit.activate());
    waitForGitApi.then((ext: {
      getAPI(version: number): {
        repositories: { rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }[];
        onDidOpenRepository: vscode.Event<{ rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }>;
        getRepository(uri: vscode.Uri): { rootUri: vscode.Uri } | null;
      }
    }) => {
      try {
        const gitApi = ext.getAPI(1);

        function watchRepo(repo: { rootUri: vscode.Uri; ui: { selected: boolean; onDidChange: vscode.Event<void> } }) {
          context.subscriptions.push(
            repo.ui.onDidChange(() => {
              if (repo.ui.selected) { switchToRepo(repo.rootUri.fsPath); }
            })
          );
        }

        for (const repo of gitApi.repositories) { watchRepo(repo); }
        context.subscriptions.push(gitApi.onDidOpenRepository(watchRepo));

        context.subscriptions.push(
          vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor) { return; }
            const repo = gitApi.getRepository(editor.document.uri);
            if (repo?.rootUri) { switchToRepo(repo.rootUri.fsPath); }
          })
        );
      } catch { /* git API unavailable */ }
    }).catch(() => {});
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('git-graph-plus.open', (sourceControl?: vscode.SourceControl) => {
      if (sourceControl?.rootUri) { switchToRepo(sourceControl.rootUri.fsPath); }
      MainPanel.createOrShow(context.extensionUri, activeRepoPath);
    }),
    vscode.commands.registerCommand('gitGraphPlus.open', (sourceControl?: vscode.SourceControl) => {
      if (sourceControl?.rootUri) { switchToRepo(sourceControl.rootUri.fsPath); }
      MainPanel.createOrShow(context.extensionUri, activeRepoPath);
    }),
    vscode.commands.registerCommand('gitGraphPlus.refresh', () => {
      refreshAll();
      MainPanel.currentPanel?.postRefresh();
    }),
    vscode.commands.registerCommand('gitGraphPlus.fetch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'fetch' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pull', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'pull' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.push', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'push' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.publishBranch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'push' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutBranch', (branchItem) => {
      if (branchItem?.branch) {
        activeGitService.checkout(branchItem.branch.name).then(() => {
          refreshAll();
          MainPanel.currentPanel?.postRefresh();
        }).catch(err => vscode.window.showErrorMessage(err.message));
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutRemoteBranch', (branchItem) => {
      if (branchItem?.branch) {
        const ref = branchItem.branch.name; // e.g. origin/main
        const localName = ref.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: ref, localName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.mergeBranch', (branchItem) => {
      const branchName = branchItem?.branch?.name;
      if (branchName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'mergeBranch', branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashApply', (stashItem) => {
      const index = stashItem?.index ?? 0;
      activeGitService.stashApply(index).then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
      }).catch(err => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashPop', (stashItem) => {
      const index = stashItem?.index ?? 0;
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashPop', index, message: stashItem?.stash?.message ?? `stash@{${index}}` });
    }),
    vscode.commands.registerCommand('gitGraphPlus.createBranch', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'createBranch' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashSave', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashSave' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.createTag', () => {
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'createTag' });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pushTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        activeGitService.pushTag(tagName).then(() => {
          refreshAll();
          MainPanel.currentPanel?.postRefresh();
          vscode.window.showInformationMessage(`Pushed tag ${tagName}`);
        }).catch(err => vscode.window.showErrorMessage(err.message));
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.pushAllTags', () => {
      activeGitService.pushAllTags().then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
        vscode.window.showInformationMessage(`Pushed all tags`);
      }).catch(err => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteRemoteTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteTag', tagName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteBranch', (branchItem) => {
      const branchName = branchItem?.branch?.name;
      if (branchName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteBranch', branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.renameBranch', (branchItem) => {
      const oldName = branchItem?.branch?.name;
      if (oldName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'renameBranch', branchName: oldName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteTag', (tagItem) => {
      const tagName = tagItem?.tag?.name;
      if (tagName) {
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteTag', tagName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.stashDrop', (stashItem) => {
      const index = stashItem?.index ?? 0;
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'stashDrop', index, message: stashItem?.stash?.message ?? `stash@{${index}}` });
    }),
    vscode.commands.registerCommand('gitGraphPlus.addWorktree', async () => {
      const defaultPath = await resolveDefaultWorktreePath(activeGitService, activeRepoPath);
      MainPanel.showModalWithPanel(context.extensionUri, { modal: 'addWorktree', defaultPath });
    }),
    vscode.commands.registerCommand('gitGraphPlus.pruneWorktrees', () => {
      activeGitService.worktreePrune().then(() => {
        refreshAll();
        MainPanel.currentPanel?.postRefresh();
        vscode.window.showInformationMessage(`Pruned worktrees`);
      }).catch((err: Error) => vscode.window.showErrorMessage(err.message));
    }),
    vscode.commands.registerCommand('gitGraphPlus.showRemoteBranchMenu', (branchItem) => {
      const branch = branchItem?.branch;
      if (branch) {
        const remote = branch.name.split('/')[0];
        const branchName = branch.name.split('/').slice(1).join('/');
        vscode.window.showQuickPick([
          { label: `Checkout as local branch...`, id: 'checkout' },
          { label: `Delete remote branch ${branch.name}`, id: 'delete' },
        ]).then(selected => {
          if (selected?.id === 'delete') {
            MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteBranch', remote, name: branchName });
          } else if (selected?.id === 'checkout') {
            const localName = branchName;
            MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: branch.name, localName });
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.showBranchMenu', (branchItem) => {
      const branch = branchItem?.branch;
      if (branch) {
        vscode.window.showQuickPick([
          { label: `Checkout ${branch.name}`, id: 'checkout' },
          { label: `Merge into current branch...`, id: 'merge' },
          { label: `Rename ${branch.name}...`, id: 'rename' },
          { label: `Delete ${branch.name}...`, id: 'delete' },
        ]).then(selected => {
          if (!selected) return;
          switch (selected.id) {
            case 'checkout': vscode.commands.executeCommand('gitGraphPlus.checkoutBranch', branchItem); break;
            case 'merge': vscode.commands.executeCommand('gitGraphPlus.mergeBranch', branchItem); break;
            case 'rename': vscode.commands.executeCommand('gitGraphPlus.renameBranch', branchItem); break;
            case 'delete': vscode.commands.executeCommand('gitGraphPlus.deleteBranch', branchItem); break;
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.showTagMenu', (tagItem) => {
      const tag = tagItem?.tag;
      if (tag) {
        vscode.window.showQuickPick([
          { label: `Push ${tag.name} to remote`, id: 'push' },
          { label: `Delete tag ${tag.name}`, id: 'delete' },
          { label: `Delete remote tag ${tag.name}`, id: 'deleteRemote' },
        ]).then(selected => {
          if (!selected) return;
          switch (selected.id) {
            case 'push': vscode.commands.executeCommand('gitGraphPlus.pushTag', tagItem); break;
            case 'delete': vscode.commands.executeCommand('gitGraphPlus.deleteTag', tagItem); break;
            case 'deleteRemote': vscode.commands.executeCommand('gitGraphPlus.deleteRemoteTag', tagItem); break;
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.showStashMenu', (stashItem) => {
      const stash = stashItem?.stash;
      if (stash) {
        vscode.window.showQuickPick([
          { label: `Apply stash@{${stash.index}}`, id: 'apply' },
          { label: `Pop stash@{${stash.index}}`, id: 'pop' },
          { label: `Drop stash@{${stash.index}}`, id: 'drop' },
        ]).then(selected => {
          if (!selected) return;
          switch (selected.id) {
            case 'apply': vscode.commands.executeCommand('gitGraphPlus.stashApply', stashItem); break;
            case 'pop': vscode.commands.executeCommand('gitGraphPlus.stashPop', stashItem); break;
            case 'drop': vscode.commands.executeCommand('gitGraphPlus.stashDrop', stashItem); break;
          }
        });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.checkoutRemoteBranchExplicit', (branch) => {
      if (branch) {
        const localName = branch.name.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'checkoutRemote', remoteName: branch.name, localName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.deleteRemoteBranchExplicit', (branch) => {
      if (branch) {
        const remote = branch.name.split('/')[0];
        const branchName = branch.name.split('/').slice(1).join('/');
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'deleteRemoteBranch', remote, name: branchName });
      }
    }),
    vscode.commands.registerCommand('gitGraphPlus.openWorktree', openWorktree),
    vscode.commands.registerCommand('gitGraphPlus.openWorktreeInFileExplorer', openWorktreeInFileExplorer),
    vscode.commands.registerCommand('gitGraphPlus.removeWorktree', (wtItem) => {
      if (wtItem?.worktree) {
        const wtPath = wtItem.worktree.path;
        const wtBranch = wtItem.worktree.branch;
        MainPanel.showModalWithPanel(context.extensionUri, { modal: 'removeWorktree', path: wtPath, branch: wtBranch });
      }
    }),
  );
}

export function deactivate() {
  MainPanel.onSidebarRefresh = null;
  MainPanel.onRepoChange = null;
}
