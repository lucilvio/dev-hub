const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawn, spawnSync } = require('child_process');
const os = require('os');
const Store = require('electron-store');

let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('node-pty unavailable — terminal line editing may not work:', err.message);
  pty = null;
}

const store = new Store();

const terminals = new Map();
let mainWindow = null;
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

// node-pty on Windows can throw asynchronously (e.g. invalid cwd → error 267).
// Keep the app alive and surface the failure in logs / the terminal UI.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:error', {
      message: err?.message || String(err),
      context: 'Main process',
    });
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

function createWorkspace(name) {
  return {
    id: crypto.randomUUID(),
    name,
    clonePath: '',
    links: [],
    projects: {},
    azure: {
      organization: '',
      project: '',
      pat: '',
    },
  };
}

function migrateToWorkspaces() {
  if (store.get('workspaces')) return;

  const workspace = createWorkspace('Default');

  if (store.has('repoScanPaths')) {
    const legacyPaths = store.get('repoScanPaths') || [];
    workspace.clonePath = legacyPaths[0] || '';
  }
  if (store.has('links')) {
    workspace.links = store.get('links') || [];
  }
  if (store.has('azure')) {
    workspace.azure = store.get('azure') || workspace.azure;
  }

  store.set('workspaces', [workspace]);
  store.set('activeWorkspaceId', workspace.id);
  store.delete('repoScanPaths');
  store.delete('links');
  store.delete('azure');
}

function migrateWorkspaceClonePath(workspace) {
  if (workspace.clonePath === undefined) {
    const legacyPaths = workspace.repoScanPaths;
    workspace.clonePath = Array.isArray(legacyPaths) ? (legacyPaths[0] || '') : '';
  }
  delete workspace.repoScanPaths;
}

function ensureWorkspaces() {
  migrateToWorkspaces();
  let workspaces = store.get('workspaces') || [];
  if (workspaces.length === 0) {
    const workspace = createWorkspace('Default');
    workspaces = [workspace];
    store.set('workspaces', workspaces);
    store.set('activeWorkspaceId', workspace.id);
  }

  let migrated = false;
  workspaces.forEach((workspace) => {
    if (workspace.repoScanPaths !== undefined || workspace.clonePath === undefined) {
      migrateWorkspaceClonePath(workspace);
      migrated = true;
    }
  });
  if (migrated) {
    store.set('workspaces', workspaces);
  }

  const activeId = store.get('activeWorkspaceId');
  if (!workspaces.some((ws) => ws.id === activeId)) {
    store.set('activeWorkspaceId', workspaces[0].id);
  }
}

function getWorkspaces() {
  ensureWorkspaces();
  return store.get('workspaces');
}

function getActiveWorkspace() {
  const workspaces = getWorkspaces();
  const activeId = store.get('activeWorkspaceId');
  const workspace = workspaces.find((ws) => ws.id === activeId) || workspaces[0];
  if (!workspace.projects) workspace.projects = {};
  return workspace;
}

function saveWorkspaces(workspaces) {
  store.set('workspaces', workspaces);
}

function setActiveWorkspace(id) {
  const workspaces = getWorkspaces();
  if (!workspaces.some((ws) => ws.id === id)) {
    throw new Error('Workspace not found.');
  }
  store.set('activeWorkspaceId', id);
}

function updateActiveWorkspace(updates) {
  const workspaces = getWorkspaces();
  const activeId = store.get('activeWorkspaceId');
  const index = workspaces.findIndex((ws) => ws.id === activeId);
  if (index === -1) return;

  const current = workspaces[index];
  if (!current.projects) current.projects = {};
  const next = { ...current, ...updates };

  if (updates.azure) {
    next.azure = {
      organization: updates.azure.organization ?? current.azure.organization,
      project: updates.azure.project ?? current.azure.project,
      pat: updates.azure.pat !== undefined && updates.azure.pat !== ''
        ? updates.azure.pat
        : current.azure.pat,
    };
  }

  if (updates.projects) {
    next.projects = updates.projects;
  }

  workspaces[index] = next;
  saveWorkspaces(workspaces);
}

function sanitizeWorkspace(workspace) {
  migrateWorkspaceClonePath(workspace);
  return {
    id: workspace.id,
    name: workspace.name,
    clonePath: workspace.clonePath || '',
    links: workspace.links,
    azure: {
      organization: workspace.azure.organization,
      project: workspace.azure.project,
      patConfigured: Boolean(workspace.azure.pat),
      patOwner: null,
    },
  };
}

async function sanitizeWorkspaceForClient(workspace) {
  const sanitized = sanitizeWorkspace(workspace);
  try {
    sanitized.azure.patOwner = await resolveAzurePatOwner(workspace.azure);
  } catch {
    sanitized.azure.patOwner = null;
  }
  return sanitized;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: '#0f1117',
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    titleBarOverlay: {
      color: '#0f1117',
      symbolColor: '#e2e8f0',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  registerCommandBarShortcut(mainWindow);

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (process.platform === 'darwin' && fs.existsSync(APP_ICON)) {
    app.dock.setIcon(APP_ICON);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  terminals.forEach((session) => session.proc.kill());
  terminals.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Workspaces ────────────────────────────────────────────────────────────────

ipcMain.handle('workspaces:list', () => {
  const workspaces = getWorkspaces();
  return {
    activeId: store.get('activeWorkspaceId'),
    workspaces: workspaces.map((ws) => ({ id: ws.id, name: ws.name })),
  };
});

ipcMain.handle('workspaces:create', (_event, { name }) => {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Workspace name is required.' };
  }

  const workspace = createWorkspace(trimmed);
  const workspaces = getWorkspaces();
  workspaces.push(workspace);
  saveWorkspaces(workspaces);
  setActiveWorkspace(workspace.id);

  return { ok: true, workspace: sanitizeWorkspace(workspace) };
});

ipcMain.handle('workspaces:switch', (_event, { id }) => {
  try {
    setActiveWorkspace(id);
    return { ok: true, workspace: sanitizeWorkspace(getActiveWorkspace()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('workspaces:rename', (_event, { id, name }) => {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Workspace name is required.' };
  }

  const workspaces = getWorkspaces();
  const index = workspaces.findIndex((ws) => ws.id === id);
  if (index === -1) {
    return { ok: false, error: 'Workspace not found.' };
  }

  workspaces[index].name = trimmed;
  saveWorkspaces(workspaces);
  return { ok: true };
});

ipcMain.handle('workspaces:delete', (_event, { id }) => {
  const workspaces = getWorkspaces();
  if (workspaces.length <= 1) {
    return { ok: false, error: 'You must keep at least one workspace.' };
  }

  const index = workspaces.findIndex((ws) => ws.id === id);
  if (index === -1) {
    return { ok: false, error: 'Workspace not found.' };
  }

  workspaces.splice(index, 1);
  saveWorkspaces(workspaces);

  const activeId = store.get('activeWorkspaceId');
  if (activeId === id) {
    store.set('activeWorkspaceId', workspaces[0].id);
  }

  return { ok: true, activeId: store.get('activeWorkspaceId') };
});

// ── Settings (active workspace) ───────────────────────────────────────────────

ipcMain.handle('settings:get', async () => sanitizeWorkspaceForClient(getActiveWorkspace()));

ipcMain.handle('settings:save', (_event, settings) => {
  const updates = {};

  if (settings.clonePath !== undefined) {
    updates.clonePath = settings.clonePath;
  }
  if (settings.links !== undefined) {
    updates.links = settings.links;
  }
  if (settings.azure !== undefined) {
    updates.azure = settings.azure;
  }

  updateActiveWorkspace(updates);
  return { ok: true };
});

function normalizeRepoPath(repoPath) {
  return path.normalize(repoPath);
}

function getWorkspaceProjects() {
  const workspace = getActiveWorkspace();
  if (!workspace.projects) workspace.projects = {};
  return workspace.projects;
}

function getProjectData(repoPath) {
  const projects = getWorkspaceProjects();
  const key = normalizeRepoPath(repoPath);
  return projects[key] || {
    annotations: '',
    todos: [],
    lastPullAt: null,
    gitHistoryReportAt: null,
    gitHistoryReportPath: null,
    gitHistoryReportSummary: null,
  };
}

function setProjectData(repoPath, data) {
  const workspaces = getWorkspaces();
  const activeId = store.get('activeWorkspaceId');
  const index = workspaces.findIndex((ws) => ws.id === activeId);
  if (index === -1) return;

  if (!workspaces[index].projects) workspaces[index].projects = {};
  const key = normalizeRepoPath(repoPath);
  workspaces[index].projects[key] = data;
  saveWorkspaces(workspaces);
}

function deleteProjectData(repoPath) {
  const workspaces = getWorkspaces();
  const activeId = store.get('activeWorkspaceId');
  const index = workspaces.findIndex((ws) => ws.id === activeId);
  if (index === -1) return;

  const key = normalizeRepoPath(repoPath);
  if (workspaces[index].projects?.[key]) {
    delete workspaces[index].projects[key];
    saveWorkspaces(workspaces);
  }

  deleteGitHistoryReport(repoPath);
}

function isRepoWithinClonePath(repoPath, clonePath) {
  if (!clonePath) return false;

  const normalizedRepo = path.normalize(repoPath);
  const normalizedClone = path.normalize(clonePath);
  const relative = path.relative(normalizedClone, normalizedRepo);

  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function projectSummary(data) {
  const todos = data.todos || [];
  const openTodos = todos.filter((todo) => !todo.completed).length;
  const annotations = data.annotations || '';
  return {
    openTodos,
    totalTodos: todos.length,
    annotationPreview: annotations.trim().slice(0, 120),
    hasAnnotations: annotations.trim().length > 0,
  };
}

ipcMain.handle('projects:get', (_event, { repoPath }) => {
  const data = getProjectData(repoPath);
  return {
    ...data,
    summary: projectSummary(data),
  };
});

ipcMain.handle('projects:summaries', () => {
  const projects = getWorkspaceProjects();
  const summaries = {};

  for (const [repoPath, data] of Object.entries(projects)) {
    summaries[repoPath] = projectSummary(data);
  }

  return summaries;
});

ipcMain.handle('projects:saveAnnotations', (_event, { repoPath, annotations }) => {
  const data = getProjectData(repoPath);
  data.annotations = annotations;
  setProjectData(repoPath, data);
  return { ok: true };
});

ipcMain.handle('projects:addTodo', (_event, { repoPath, text }) => {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'To-do text is required.' };
  }

  const data = getProjectData(repoPath);
  const todo = {
    id: crypto.randomUUID(),
    text: trimmed,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  data.todos = [...(data.todos || []), todo];
  setProjectData(repoPath, data);
  return { ok: true, todo };
});

ipcMain.handle('projects:updateTodo', (_event, { repoPath, todoId, text, completed }) => {
  const data = getProjectData(repoPath);
  const todos = data.todos || [];
  const index = todos.findIndex((todo) => todo.id === todoId);
  if (index === -1) {
    return { ok: false, error: 'To-do not found.' };
  }

  if (text !== undefined) {
    todos[index].text = text.trim();
  }
  if (completed !== undefined) {
    todos[index].completed = completed;
  }

  data.todos = todos;
  setProjectData(repoPath, data);
  return { ok: true, todo: todos[index] };
});

ipcMain.handle('projects:deleteTodo', (_event, { repoPath, todoId }) => {
  const data = getProjectData(repoPath);
  data.todos = (data.todos || []).filter((todo) => todo.id !== todoId);
  setProjectData(repoPath, data);
  return { ok: true };
});

ipcMain.handle('shell:openExternal', (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('shell:openPath', (_event, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('dialog:pickFolder', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder containing git repositories',
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false };
  }

  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('fs:checkDirectory', (_event, dirPath) => {
  const trimmed = typeof dirPath === 'string' ? dirPath.trim() : '';
  if (!trimmed) {
    return { ok: false, empty: true, error: 'No folder set.' };
  }

  try {
    if (!fs.existsSync(trimmed)) {
      return { ok: false, empty: false, error: 'This folder does not exist.' };
    }
    if (!fs.statSync(trimmed).isDirectory()) {
      return { ok: false, empty: false, error: 'This path is not a folder.' };
    }
    return { ok: true, empty: false };
  } catch (err) {
    return { ok: false, empty: false, error: err.message || 'Invalid folder path.' };
  }
});

function findVSCodeExecutable() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft VS Code', 'Code.exe'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const result = execSync('where code', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const first = result.split(/\r?\n/)[0];
    if (first) return first;
  } catch {
    // not on PATH
  }

  return null;
}

function findVisualStudioExecutable() {
  const roots = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft Visual Studio'),
    path.join(process.env.ProgramFiles || '', 'Microsoft Visual Studio'),
  ];
  const editions = ['Community', 'Professional', 'Enterprise', 'BuildTools', 'Preview'];

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;

    let versions;
    try {
      versions = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      continue;
    }

    for (const version of versions) {
      for (const edition of editions) {
        const devenv = path.join(root, version, edition, 'Common7', 'IDE', 'devenv.exe');
        if (fs.existsSync(devenv)) {
          return devenv;
        }
      }
    }
  }

  return null;
}

function findSolutionFile(repoPath) {
  try {
    const sln = fs.readdirSync(repoPath).find((entry) => entry.endsWith('.sln'));
    if (sln) return path.join(repoPath, sln);
  } catch {
    // ignore
  }
  return null;
}

function launchDetached(command, args) {
  spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

function openInVSCode(repoPath) {
  const codeExecutable = findVSCodeExecutable();
  if (!codeExecutable) {
    throw new Error('Visual Studio Code was not found. Install it or add the "code" command to PATH.');
  }

  if (codeExecutable.toLowerCase().endsWith('.cmd')) {
    launchDetached('cmd', ['/c', codeExecutable, repoPath]);
  } else {
    launchDetached(codeExecutable, [repoPath]);
  }
}

function openInVisualStudio(repoPath) {
  const devenv = findVisualStudioExecutable();
  if (!devenv) {
    throw new Error('Visual Studio was not found. Install Visual Studio with the desktop development workload.');
  }

  const solution = findSolutionFile(repoPath);
  launchDetached(devenv, [solution || repoPath]);
}

ipcMain.handle('ide:open', (_event, { ide, repoPath }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }

    if (ide === 'vscode') {
      openInVSCode(repoPath);
    } else if (ide === 'visualstudio') {
      openInVisualStudio(repoPath);
    } else {
      return { ok: false, error: `Unknown IDE: ${ide}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dialog:showError', async (_event, { message, title }) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const text = String(message || 'Something went wrong.').trim();
  const options = {
    type: 'error',
    title: title || 'Dev Hub',
    buttons: ['OK'],
    defaultId: 0,
    message: text,
  };

  if (text.length > 240) {
    options.message = title || 'Dev Hub';
    options.detail = text;
  }

  await dialog.showMessageBox(win, options);
});

ipcMain.handle('dialog:showConfirm', async (_event, { message, title, detail, confirmLabel }) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title: title || 'Dev Hub',
    message: message || 'Are you sure?',
    detail: detail || '',
    buttons: ['Cancel', confirmLabel || 'Delete'],
    defaultId: 0,
    cancelId: 0,
  });

  return { confirmed: result.response === 1 };
});

function registerCommandBarShortcut(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && !input.alt && !input.shift && !input.meta && input.key?.toLowerCase() === 'q') {
      event.preventDefault();
      if (!win.isDestroyed()) {
        win.webContents.send('app:focus-command-bar');
      }
    }
  });
}

function resolveShellCwd(cwd) {
  const candidates = [
    typeof cwd === 'string' ? cwd.trim() : '',
    getActiveWorkspace().clonePath?.trim() || '',
    os.homedir(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore invalid paths and try the next candidate.
    }
  }

  return os.tmpdir();
}

function spawnShell(cwd) {
  const workDir = resolveShellCwd(cwd);

  if (pty) {
    const shell = process.platform === 'win32'
      ? 'powershell.exe'
      : (process.env.SHELL || '/bin/bash');
    const args = process.platform === 'win32' ? ['-NoLogo'] : ['--login'];

    return {
      kind: 'pty',
      proc: pty.spawn(shell, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: workDir,
        env: process.env,
      }),
      cwd: workDir,
    };
  }

  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      proc: spawn('powershell.exe', ['-NoLogo', '-NoExit'], {
        cwd: workDir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      cwd: workDir,
    };
  }

  return {
    kind: 'pipe',
    proc: spawn(process.env.SHELL || '/bin/bash', ['--login'], {
      cwd: workDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    cwd: workDir,
  };
}

function attachTerminalOutput(id, session) {
  const sendData = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal:data:${id}`, data.toString());
    }
  };

  const notifyExit = () => {
    terminals.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal:exit:${id}`);
    }
  };

  if (session.kind === 'pty') {
    session.proc.onData(sendData);
    session.proc.onExit(notifyExit);
  } else {
    session.proc.stdout.on('data', sendData);
    session.proc.stderr.on('data', sendData);
    session.proc.on('exit', notifyExit);
    session.proc.on('error', (err) => {
      sendData(`\r\n[Failed to start shell: ${err.message}]\r\n`);
    });
  }
}

ipcMain.handle('terminal:create', (_event, { id, cwd }) => {
  if (terminals.has(id)) {
    const existing = terminals.get(id);
    try {
      existing.proc.kill();
    } catch {
      // Session may already be gone.
    }
    terminals.delete(id);
  }

  try {
    const session = spawnShell(cwd);
    attachTerminalOutput(id, session);
    terminals.set(id, session);
    return { ok: true, cwd: session.cwd };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.on('terminal:input', (_event, { id, data }) => {
  const session = terminals.get(id);
  if (!session) return;

  if (session.kind === 'pty') {
    session.proc.write(data);
    return;
  }

  if (session.proc.stdin?.writable) {
    session.proc.stdin.write(data);
  }
});

ipcMain.on('terminal:resize', (_event, { id, cols, rows }) => {
  const session = terminals.get(id);
  if (!session || session.kind !== 'pty') return;
  if (!cols || !rows) return;

  try {
    session.proc.resize(cols, rows);
  } catch {
    // Ignore resize errors while the terminal is still settling.
  }
});

ipcMain.handle('terminal:kill', (_event, id) => {
  const session = terminals.get(id);
  if (session) {
    session.proc.kill();
    terminals.delete(id);
  }
  return { ok: true };
});

function isGitRepo(dirPath) {
  return fs.existsSync(path.join(dirPath, '.git'));
}

function scanForRepos(rootPath, maxDepth = 3) {
  const repos = [];

  function walk(currentPath, depth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    if (isGitRepo(currentPath)) {
      repos.push(getRepoInfo(currentPath));
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(path.join(currentPath, entry.name), depth + 1);
    }
  }

  walk(rootPath, 0);
  return repos;
}

function getCurrentBranch(repoPath) {
  try {
    const branch = execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branch) return branch;
  } catch {
    // fall through
  }

  try {
    const ref = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (ref && ref !== 'HEAD') return ref;

    return execSync('git rev-parse --short HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function parseAzureDevOpsRemote(remote, repoName, azure) {
  if (remote) {
    let normalized = remote.trim();
    if (normalized.toLowerCase().endsWith('.git')) {
      normalized = normalized.slice(0, -4);
    }

    let match = normalized.match(/(?:git@)?ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/i);
    if (match) {
      return { organization: match[1], project: match[2], repository: match[3] };
    }

    match = normalized.match(/dev\.azure\.com\/([^/@]+)\/([^/]+)\/_git\/([^/?#]+)/i);
    if (match) {
      return { organization: match[1], project: match[2], repository: match[3] };
    }

    match = normalized.match(/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/i);
    if (match) {
      return { organization: match[1], project: match[2], repository: match[3] };
    }
  }

  if (azure?.organization && azure?.project) {
    return {
      organization: azure.organization,
      project: azure.project,
      repository: repoName || '',
    };
  }

  return null;
}

function normalizeGitRemoteForMatch(url) {
  if (!url) return '';

  let value = url.trim().toLowerCase();
  if (value.endsWith('.git')) {
    value = value.slice(0, -4);
  }

  const sshMatch = value.match(/(?:git@)?ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (sshMatch) {
    return `dev.azure.com/${sshMatch[1]}/${sshMatch[2]}/_git/${sshMatch[3]}`;
  }

  return value
    .replace(/^https?:\/\//, '')
    .replace(/^git@/i, '')
    .replace(/\/+$/, '');
}

function extractAzureGitTriple(url) {
  const normalized = normalizeGitRemoteForMatch(url);
  const match = normalized.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/i);
  if (!match) return null;

  return {
    organization: decodeURIComponent(match[1]).toLowerCase(),
    project: decodeURIComponent(match[2]).toLowerCase(),
    repository: decodeURIComponent(match[3]).toLowerCase(),
  };
}

function azureRemotesMatch(leftUrl, rightUrl) {
  const left = extractAzureGitTriple(leftUrl);
  const right = extractAzureGitTriple(rightUrl);
  if (!left || !right) return false;

  return left.organization === right.organization
    && left.project === right.project
    && left.repository === right.repository;
}

function azureAuthHeaders(pat) {
  return { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` };
}

async function fetchAzureJson(url, pat) {
  const res = await fetch(url, { headers: azureAuthHeaders(pat) });
  if (!res.ok) return null;
  return res.json();
}

function formatAzureUserDisplayName(user) {
  if (!user) return null;

  const accountEmail = user.properties?.Account?.$value
    || user.coreAttributes?.EmailAddress?.value
    || user.emailAddress;

  return user.providerDisplayName
    || user.customDisplayName
    || user.displayName
    || accountEmail
    || user.uniqueName
    || null;
}

async function getAzureAuthenticatedUser(organization, pat) {
  const org = encodeURIComponent(organization);
  const connectionUrls = [
    `https://dev.azure.com/${org}/_apis/connectiondata?connectOptions=IncludeServices&api-version=7.0`,
    `https://vssps.dev.azure.com/${org}/_apis/connectiondata?connectOptions=IncludeServices&api-version=7.1`,
    'https://app.vssps.visualstudio.com/_apis/connectiondata?connectOptions=IncludeServices&api-version=7.1',
  ];

  for (const url of connectionUrls) {
    try {
      const data = await fetchAzureJson(url, pat);
      if (data?.authenticatedUser) {
        return data.authenticatedUser;
      }
    } catch {
      // Try the next identity endpoint.
    }
  }

  const profileUrls = [
    'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1-preview.3',
    `https://vssps.dev.azure.com/${org}/_apis/profile/profiles/me?api-version=7.1-preview.3`,
  ];

  for (const url of profileUrls) {
    try {
      const profile = await fetchAzureJson(url, pat);
      if (!profile) continue;
      return {
        providerDisplayName: profile.displayName,
        uniqueName: profile.emailAddress || profile.coreAttributes?.EmailAddress?.value || null,
        properties: profile.coreAttributes?.EmailAddress?.value
          ? { Account: { $value: profile.coreAttributes.EmailAddress.value } }
          : undefined,
      };
    } catch {
      // Try the next profile endpoint.
    }
  }

  return null;
}

async function resolveAzurePatOwner(azure) {
  const { organization, pat } = azure || {};
  if (!organization || !pat) return null;

  const user = await getAzureAuthenticatedUser(organization, pat);
  if (!user) return null;

  const displayName = formatAzureUserDisplayName(user);
  if (!displayName) return null;

  return {
    displayName,
    uniqueName: user.uniqueName || user.properties?.Account?.$value || null,
  };
}

function parseAzureApiError(text, status) {
  try {
    const data = JSON.parse(text);
    if (data.message) {
      return `${data.message} (HTTP ${status})`;
    }
  } catch {
    // keep raw text
  }
  return `Request failed (HTTP ${status}): ${text}`;
}

async function listAzureGitRepositories(organization, project, pat) {
  const url = `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.0`;
  const res = await fetch(url, { headers: azureAuthHeaders(pat) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseAzureApiError(text, res.status));
  }

  const data = await res.json();
  return data.value || [];
}

function scanAllWorkspaceRepos() {
  const clonePath = getActiveWorkspace().clonePath || '';
  if (!clonePath || !fs.existsSync(clonePath)) {
    return [];
  }

  const repos = scanForRepos(clonePath);
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

function findLocalRepoForAzureRepository(azureRepo, localRepos) {
  const candidates = [azureRepo.remoteUrl, azureRepo.url, azureRepo.webUrl, azureRepo.sshUrl]
    .filter(Boolean);

  for (const local of localRepos) {
    if (local.remote && candidates.some((candidate) => azureRemotesMatch(local.remote, candidate))) {
      return local;
    }
  }

  return localRepos.find((local) => local.name.toLowerCase() === azureRepo.name.toLowerCase()) || null;
}

function buildAuthenticatedCloneUrl(remoteUrl, pat) {
  const trimmed = String(remoteUrl || '').trim();
  if (!trimmed) {
    throw new Error('Repository has no clone URL.');
  }

  const normalized = trimmed.replace(/\.git$/i, '');
  const url = new URL(normalized);
  url.username = '';
  url.password = pat;
  return url.toString();
}

const azureRepoCache = new Map();

async function resolveAzureGitRepository(repoPath) {
  const cacheKey = path.normalize(repoPath);
  if (azureRepoCache.has(cacheKey)) {
    return azureRepoCache.get(cacheKey);
  }

  const azure = getActiveWorkspace().azure;
  const { pat } = azure;

  if (!pat) {
    throw new Error('Azure DevOps is not configured for this workspace. Add your PAT in Settings.');
  }

  const folderName = path.basename(repoPath);
  const remote = getRepoOriginRemote(repoPath);
  const parsed = parseAzureDevOpsRemote(remote, folderName, azure);

  if (!parsed?.organization || !parsed?.project) {
    throw new Error('Could not determine Azure DevOps organization/project from the remote URL or workspace settings.');
  }

  const { organization, project } = parsed;
  const repositories = await listAzureGitRepositories(organization, project, pat);

  if (repositories.length === 0) {
    throw new Error(`No Git repositories found in project "${project}".`);
  }

  if (remote) {
    const byRemote = repositories.find((repo) => {
      const candidates = [repo.remoteUrl, repo.url, repo.webUrl, repo.sshUrl].filter(Boolean);
      return candidates.some((candidate) => azureRemotesMatch(remote, candidate));
    });
    if (byRemote) {
      const resolved = { organization, project, repository: byRemote.name, repositoryId: byRemote.id };
      azureRepoCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  const nameCandidates = [parsed.repository, folderName]
    .filter(Boolean)
    .map((name) => name.toLowerCase());

  const byName = repositories.find((repo) =>
    nameCandidates.includes(repo.name.toLowerCase()),
  );
  if (byName) {
    const resolved = { organization, project, repository: byName.name, repositoryId: byName.id };
    azureRepoCache.set(cacheKey, resolved);
    return resolved;
  }

  const available = repositories.map((repo) => repo.name).sort().join(', ');
  throw new Error(
    `Could not match "${remote || folderName}" to an Azure DevOps repository in project "${project}". Available repositories: ${available}`,
  );
}

function parseAzureDevOpsWebUrl(remote, repoName, azure) {
  const parsed = parseAzureDevOpsRemote(remote, repoName, azure);
  if (!parsed) return '';
  return `https://dev.azure.com/${parsed.organization}/${parsed.project}/_git/${parsed.repository}`;
}

function getRepoOriginRemote(repoPath) {
  try {
    return execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function sanitizeGitRemoteUrl(remote) {
  if (!remote) return '';

  const trimmed = String(remote).trim();
  if (!trimmed.includes('://')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.username && !parsed.password) {
      return trimmed;
    }

    parsed.username = '';
    parsed.password = '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return trimmed.replace(/^(https?:\/\/)(?:[^@/]+@)/i, '$1');
  }
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absSec < 60) return rtf.format(diffSec, 'second');
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const diffHour = Math.round(diffSec / 3600);
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
  const diffDay = Math.round(diffSec / 86400);
  if (Math.abs(diffDay) < 30) return rtf.format(diffDay, 'day');
  const diffMonth = Math.round(diffSec / (86400 * 30));
  if (Math.abs(diffMonth) < 12) return rtf.format(diffMonth, 'month');
  return rtf.format(Math.round(diffSec / (86400 * 365)), 'year');
}

function getRepoInfo(repoPath) {
  const azure = getActiveWorkspace().azure;
  const info = {
    name: path.basename(repoPath),
    path: repoPath,
    branch: '',
    dirty: false,
    remote: '',
    azureUrl: '',
    lastCommit: '',
    lastReleaseBranch: '',
  };

  try {
    info.branch = getCurrentBranch(repoPath);

    const status = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    info.dirty = status.length > 0;

    try {
      info.remote = sanitizeGitRemoteUrl(getRepoOriginRemote(repoPath));
    } catch {
      info.remote = '';
    }

    info.azureUrl = parseAzureDevOpsWebUrl(info.remote, info.name, azure);

    info.lastCommit = execSync('git log -1 --format=%cr', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    info.lastReleaseBranch = findLastReleaseBranch(repoPath);
  } catch {
    // repo may be in a broken state
  }

  return info;
}

function gitOutput(repoPath, args) {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || 'git command failed');
  }
  return result.stdout.trim();
}

function parseTabSeparatedLines(output, fieldCount) {
  if (!output) return [];
  return output.split('\n').filter(Boolean).map((line) => {
    const parts = line.includes('\t')
      ? line.split('\t')
      : line.split('%x09');
    if (fieldCount === 3) {
      return { a: parts[0] || '', b: parts[1] || '', c: parts.slice(2).join('\t') || '' };
    }
    if (fieldCount === 4) {
      return {
        a: parts[0] || '',
        b: parts[1] || '',
        c: parts[2] || '',
        d: parts.slice(3).join('\t') || '',
      };
    }
    return parts;
  });
}

const GIT_FIELD_SEP = '\t';
const BUG_FIX_PATTERN = /\b(fix|fixes|fixed|bug|hotfix|patch|regression|issue|defect|repair)\b/i;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOCAL_GIT_LOG_ARGS = ['--branches', '--no-merges'];
const CODE_FILE_EXTENSIONS = new Set([
  '.cs', '.cshtml', '.razor', '.vb', '.fs', '.fsx',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.xhtml',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.json', '.xml', '.yaml', '.yml', '.toml',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift', '.dart',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh',
  '.php', '.lua', '.pl', '.r',
  '.sql', '.ps1', '.sh', '.bash', '.bat', '.cmd',
]);

function isCodeFile(filePath) {
  const normalized = String(filePath).split(/[?#]/)[0];
  const ext = path.extname(normalized).toLowerCase();
  return CODE_FILE_EXTENSIONS.has(ext);
}

function getGitHistoryReportPath(repoPath) {
  const workspaceId = getActiveWorkspace().id;
  const key = crypto.createHash('sha256').update(normalizeRepoPath(repoPath)).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'git-reports', workspaceId, key, 'git-history-report.md');
}

function deleteGitHistoryReport(repoPath) {
  try {
    const reportPath = getGitHistoryReportPath(repoPath);
    fs.rmSync(path.dirname(reportPath), { recursive: true, force: true });
  } catch {
    // ignore missing report folder
  }
}

function formatReportNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(digits);
}

function formatReportPercent(value, total) {
  if (!total) return '0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function analyzeGitHistory(repoPath) {
  const logOutput = gitOutput(repoPath, [
    'log',
    ...LOCAL_GIT_LOG_ARGS,
    `--pretty=format:%aN${GIT_FIELD_SEP}%aI${GIT_FIELD_SEP}%s`,
  ]);

  const commits = [];
  for (const line of logOutput.split('\n').filter(Boolean)) {
    const tab1 = line.indexOf(GIT_FIELD_SEP);
    const tab2 = line.indexOf(GIT_FIELD_SEP, tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;

    const author = line.slice(0, tab1);
    const isoDate = line.slice(tab1 + 1, tab2);
    const subject = line.slice(tab2 + 1);
    const date = new Date(isoDate);
    commits.push({ author, isoDate, subject, date });
  }

  const authorCounts = new Map();
  const dayOfWeekCounts = new Map(DAY_NAMES.map((day) => [day, 0]));

  for (const commit of commits) {
    authorCounts.set(commit.author, (authorCounts.get(commit.author) || 0) + 1);
    if (!Number.isNaN(commit.date.getTime())) {
      const day = DAY_NAMES[commit.date.getDay()];
      dayOfWeekCounts.set(day, dayOfWeekCounts.get(day) + 1);
    }
  }

  const contributors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([author, count]) => ({ author, count }));

  const validDates = commits
    .map((commit) => commit.date)
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a - b);

  const totalCommits = commits.length;
  const firstDate = validDates[0] || null;
  const lastDate = validDates[validDates.length - 1] || null;
  const spanDays = firstDate && lastDate
    ? Math.max(1, Math.ceil((lastDate - firstDate) / (1000 * 60 * 60 * 24)) + 1)
    : 1;

  const activityRates = {
    perDay: totalCommits / spanDays,
    perWeek: (totalCommits / spanDays) * 7,
    perMonth: (totalCommits / spanDays) * 30.437,
    spanDays,
    firstDate: firstDate?.toISOString() || null,
    lastDate: lastDate?.toISOString() || null,
  };

  const dayOfWeekActivity = [...dayOfWeekCounts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => b.count - a.count || DAY_NAMES.indexOf(a.day) - DAY_NAMES.indexOf(b.day));

  const fileStats = new Map();
  let currentIsBugFix = false;

  const numstatOutput = gitOutput(repoPath, [
    'log',
    ...LOCAL_GIT_LOG_ARGS,
    '--numstat',
    `--pretty=format:%H${GIT_FIELD_SEP}%aI${GIT_FIELD_SEP}%s`,
  ]);

  for (const line of numstatOutput.split('\n')) {
    if (!line) continue;

    const hashMatch = line.match(/^[0-9a-f]{7,40}\t/);
    if (hashMatch) {
      const tab1 = line.indexOf(GIT_FIELD_SEP);
      const tab2 = line.indexOf(GIT_FIELD_SEP, tab1 + 1);
      const subject = line.slice(tab2 + 1);
      currentIsBugFix = BUG_FIX_PATTERN.test(subject);
      continue;
    }

    const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!numstatMatch) continue;

    const additions = numstatMatch[1] === '-' ? 0 : Number.parseInt(numstatMatch[1], 10);
    const deletions = numstatMatch[2] === '-' ? 0 : Number.parseInt(numstatMatch[2], 10);
    const filePath = numstatMatch[3];

    if (!fileStats.has(filePath)) {
      fileStats.set(filePath, {
        filePath,
        commits: 0,
        additions: 0,
        deletions: 0,
        fixCommits: 0,
      });
    }

    const stat = fileStats.get(filePath);
    stat.commits += 1;
    stat.additions += additions;
    stat.deletions += deletions;
    if (currentIsBugFix) stat.fixCommits += 1;
  }

  const fileList = [...fileStats.values()].map((stat) => ({
    ...stat,
    lineChanges: stat.additions + stat.deletions,
  }));

  const codeFileList = fileList.filter((stat) => isCodeFile(stat.filePath));

  const topChangedFiles = [...codeFileList]
    .sort((a, b) => b.lineChanges - a.lineChanges || b.commits - a.commits || a.filePath.localeCompare(b.filePath))
    .slice(0, 10);

  const bugFixFiles = [...codeFileList]
    .filter((stat) => stat.fixCommits > 0)
    .sort((a, b) => b.fixCommits - a.fixCommits || b.lineChanges - a.lineChanges || a.filePath.localeCompare(b.filePath))
    .slice(0, 10);

  const leastChangedFile = [...codeFileList]
    .sort((a, b) => a.lineChanges - b.lineChanges || a.commits - b.commits || a.filePath.localeCompare(b.filePath))[0] || null;

  return {
    totalCommits,
    contributors,
    topContributor: contributors[0] || null,
    topContributors: contributors.slice(0, 5),
    activityRates,
    dayOfWeekActivity,
    topChangedFiles,
    bugFixFiles,
    leastChangedFile,
  };
}

function buildGitHistoryReportMarkdown(repoPath, repoName, analysis) {
  const generatedAt = new Date();
  const lines = [
    '# Git History Report',
    '',
    `**Project:** ${repoName}`,
    `**Repository:** \`${repoPath}\``,
    `**Generated:** ${generatedAt.toLocaleString()}`,
    '**Scope:** Local repository only (local branches; remote-tracking refs excluded)',
    `**Total commits (no merges):** ${analysis.totalCommits}`,
    '',
  ];

  if (analysis.activityRates.firstDate && analysis.activityRates.lastDate) {
    lines.push(
      `**History span:** ${new Date(analysis.activityRates.firstDate).toLocaleDateString()} → ${new Date(analysis.activityRates.lastDate).toLocaleDateString()} (${analysis.activityRates.spanDays} days)`,
      '',
    );
  }

  lines.push('## Greatest contributor', '');
  if (analysis.topContributor) {
    lines.push(
      `${analysis.topContributor.author} — **${analysis.topContributor.count}** commits (${formatReportPercent(analysis.topContributor.count, analysis.totalCommits)})`,
      '',
    );
  } else {
    lines.push('_No commits found._', '');
  }

  lines.push('## Top 5 contributors', '');
  if (analysis.topContributors.length > 0) {
    lines.push('| Rank | Author | Commits | Share |', '| --- | --- | ---: | ---: |');
    analysis.topContributors.forEach((entry, index) => {
      lines.push(`| ${index + 1} | ${entry.author} | ${entry.count} | ${formatReportPercent(entry.count, analysis.totalCommits)} |`);
    });
    lines.push('');
  } else {
    lines.push('_No contributors found._', '');
  }

  lines.push('## Commit activity', '');
  lines.push('| Metric | Average |', '| --- | ---: |');
  lines.push(`| Commits per day | ${formatReportNumber(analysis.activityRates.perDay)} |`);
  lines.push(`| Commits per week | ${formatReportNumber(analysis.activityRates.perWeek)} |`);
  lines.push(`| Commits per month | ${formatReportNumber(analysis.activityRates.perMonth)} |`);
  lines.push('');

  lines.push('## Days of the week with the most activity', '');
  if (analysis.dayOfWeekActivity.some((entry) => entry.count > 0)) {
    lines.push('| Day | Commits |', '| --- | ---: |');
    for (const entry of analysis.dayOfWeekActivity) {
      lines.push(`| ${entry.day} | ${entry.count} |`);
    }
    lines.push('');
  } else {
    lines.push('_No commit activity found._', '');
  }

  lines.push('## Top 10 most changed code files', '');
  lines.push('_Includes source and markup files such as .cs, .js, .ts, .css, .html, and similar code extensions._', '');
  if (analysis.topChangedFiles.length > 0) {
    lines.push('| Rank | File | Commits | Lines changed |', '| --- | --- | ---: | ---: |');
    analysis.topChangedFiles.forEach((entry, index) => {
      lines.push(`| ${index + 1} | \`${entry.filePath}\` | ${entry.commits} | ${entry.lineChanges} |`);
    });
    lines.push('');
  } else {
    lines.push('_No code file changes found._', '');
  }

  lines.push('## Files with the most bug fixes', '');
  lines.push('_Bug-fix commits are detected when the commit message contains words like fix, bug, hotfix, patch, or issue. Code files only._', '');
  if (analysis.bugFixFiles.length > 0) {
    lines.push('| Rank | File | Fix commits | Total commits |', '| --- | --- | ---: | ---: |');
    analysis.bugFixFiles.forEach((entry, index) => {
      lines.push(`| ${index + 1} | \`${entry.filePath}\` | ${entry.fixCommits} | ${entry.commits} |`);
    });
    lines.push('');
  } else {
    lines.push('_No bug-fix-related code file changes detected._', '');
  }

  lines.push('## Least changed code file', '');
  if (analysis.leastChangedFile) {
    const entry = analysis.leastChangedFile;
    lines.push(
      `\`${entry.filePath}\` — **${entry.commits}** commits, **${entry.lineChanges}** lines changed`,
      '',
    );
  } else {
    lines.push('_No code file changes found._', '');
  }

  lines.push('---', '', '_Generated by Dev Hub_');
  return { markdown: lines.join('\n'), generatedAt, analysis };
}

function buildGitHistoryReportSummary(analysis) {
  return {
    totalCommits: analysis.totalCommits,
    topContributor: analysis.topContributor,
    topContributors: analysis.topContributors,
    activityRates: {
      perDay: analysis.activityRates.perDay,
      perWeek: analysis.activityRates.perWeek,
      perMonth: analysis.activityRates.perMonth,
    },
    busiestDay: analysis.dayOfWeekActivity[0] || null,
    topChangedFile: analysis.topChangedFiles[0] || null,
    bugFixFile: analysis.bugFixFiles[0] || null,
    leastChangedFile: analysis.leastChangedFile,
  };
}

function generateGitHistoryReport(repoPath, repoName) {
  if (!repoPath || !fs.existsSync(repoPath)) {
    throw new Error('Repository folder not found.');
  }
  if (!isGitRepo(repoPath)) {
    throw new Error('This folder is not a git repository.');
  }

  const analysis = analyzeGitHistory(repoPath);
  const { markdown, generatedAt } = buildGitHistoryReportMarkdown(repoPath, repoName, analysis);
  const reportPath = getGitHistoryReportPath(repoPath);

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown, 'utf8');

  const projectData = getProjectData(repoPath);
  projectData.gitHistoryReportAt = generatedAt.toISOString();
  projectData.gitHistoryReportPath = reportPath;
  projectData.gitHistoryReportSummary = buildGitHistoryReportSummary(analysis);
  setProjectData(repoPath, projectData);

  return {
    path: reportPath,
    generatedAt: generatedAt.toISOString(),
    summary: buildGitHistoryReportSummary(analysis),
  };
}

function getGitHistoryReportStatus(repoPath) {
  const projectData = getProjectData(repoPath);
  const reportPath = projectData.gitHistoryReportPath || getGitHistoryReportPath(repoPath);
  const exists = Boolean(reportPath && fs.existsSync(reportPath));

  let summary = exists ? (projectData.gitHistoryReportSummary || null) : null;
  let generatedAt = exists ? (projectData.gitHistoryReportAt || null) : null;

  if (exists && !summary && isGitRepo(repoPath)) {
    try {
      summary = buildGitHistoryReportSummary(analyzeGitHistory(repoPath));
      projectData.gitHistoryReportSummary = summary;
      projectData.gitHistoryReportPath = reportPath;
      if (!generatedAt) {
        generatedAt = fs.statSync(reportPath).mtime.toISOString();
        projectData.gitHistoryReportAt = generatedAt;
      }
      setProjectData(repoPath, projectData);
    } catch {
      // Report file exists but history could not be analyzed.
    }
  }

  return {
    exists,
    generatedAt: exists ? generatedAt : null,
    path: exists ? reportPath : null,
    summary: exists ? summary : null,
  };
}

const RELEASE_BRANCH_PATTERN = /^(?:release\/|releases\/|release-)/i;

function tryGenerateGitHistoryReport(repoPath, repoName) {
  try {
    const result = generateGitHistoryReport(repoPath, repoName);
    return {
      ok: true,
      generatedAt: result.generatedAt,
      path: result.path,
      summary: result.summary,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function normalizeReleaseBranchName(ref) {
  return ref.replace(/^origin\//, '');
}

function findLastReleaseBranch(repoPath) {
  try {
    const output = gitOutput(repoPath, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads/',
      'refs/remotes/origin/',
    ]);
    const refs = output.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const ref of refs) {
      const shortName = normalizeReleaseBranchName(ref);
      if (RELEASE_BRANCH_PATTERN.test(shortName)) {
        return shortName;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

function getProjectWarningCount(repoPath) {
  try {
    const status = getMainAheadOfLastRelease(repoPath, false);
    if (status.isAhead && status.commitsAhead > 0) {
      return status.commitsAhead;
    }
  } catch {
    // ignore git errors for individual repos
  }
  return 0;
}

ipcMain.handle('repos:scan', () => {
  return scanAllWorkspaceRepos().map((repo) => ({
    ...repo,
    warningCount: getProjectWarningCount(repo.path),
    project: projectSummary(getProjectData(repo.path)),
  }));
});

function parseGitCloneProgress(line) {
  const trimmed = line.replace(/\r/g, '').trim();
  if (!trimmed) return null;

  if (/^Cloning into /i.test(trimmed)) {
    return { phase: 'starting', label: 'Starting clone', percent: 0, indeterminate: false };
  }

  let match = trimmed.match(/Receiving objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s+(.+))?/);
  if (match) {
    return {
      phase: 'receiving',
      label: 'Receiving objects',
      percent: Number.parseInt(match[1], 10),
      current: Number.parseInt(match[2], 10),
      total: Number.parseInt(match[3], 10),
      detail: match[4]?.trim() || '',
      indeterminate: false,
    };
  }

  match = trimmed.match(/Resolving deltas:\s+(\d+)%\s+\((\d+)\/(\d+)\)/);
  if (match) {
    return {
      phase: 'resolving',
      label: 'Resolving deltas',
      percent: Number.parseInt(match[1], 10),
      current: Number.parseInt(match[2], 10),
      total: Number.parseInt(match[3], 10),
      indeterminate: false,
    };
  }

  match = trimmed.match(/Checking out files:\s+(\d+)%\s+\((\d+)\/(\d+)\)/);
  if (match) {
    return {
      phase: 'checkout',
      label: 'Checking out files',
      percent: Number.parseInt(match[1], 10),
      current: Number.parseInt(match[2], 10),
      total: Number.parseInt(match[3], 10),
      indeterminate: false,
    };
  }

  match = trimmed.match(/(?:remote:\s+)?(Enumerating|Counting|Compressing) objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)/i);
  if (match) {
    return {
      phase: match[1].toLowerCase(),
      label: `${match[1]} objects`,
      percent: Number.parseInt(match[2], 10),
      current: Number.parseInt(match[3], 10),
      total: Number.parseInt(match[4], 10),
      indeterminate: false,
    };
  }

  match = trimmed.match(/(?:remote:\s+)?(Enumerating|Counting|Compressing) objects:\s+(\d+)/i);
  if (match) {
    return {
      phase: match[1].toLowerCase(),
      label: `${match[1]} objects`,
      indeterminate: true,
    };
  }

  if (/remote:\s+Total\s+\d+/i.test(trimmed)) {
    return { phase: 'remote', label: 'Preparing remote', indeterminate: true };
  }

  return null;
}

function sanitizeCloneOutput(text, pat) {
  if (!text) return '';
  const escapedPat = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escapedPat, 'g'), '***').trim();
}

function runGitCloneWithProgress(cloneUrl, targetPath, pat, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', '--progress', cloneUrl, targetPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';

    const handleChunk = (chunk) => {
      const text = chunk.toString();
      stderr += text;

      for (const line of text.split(/\r|\n/)) {
        const progress = parseGitCloneProgress(line);
        if (progress) {
          onProgress(progress);
        }
      }
    };

    proc.stderr.on('data', handleChunk);
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const details = sanitizeCloneOutput(stderr || stdout, pat);
      reject(new Error(details || 'Git clone failed.'));
    });
  });
}

ipcMain.handle('repos:clone', async (event, { remoteUrl, repoName, targetParent, cloneId }) => {
  try {
    const azure = getActiveWorkspace().azure;
    const { pat } = azure;
    if (!pat) {
      return { ok: false, error: 'Azure DevOps PAT is not configured. Add one in Settings.' };
    }

    const trimmedName = String(repoName || '').trim();
    if (!trimmedName) {
      return { ok: false, error: 'Repository name is required.' };
    }

    const clonePath = getActiveWorkspace().clonePath || '';
    const parent = targetParent || clonePath;
    if (!parent) {
      return {
        ok: false,
        error: 'Choose where to clone repositories on the Projects page.',
      };
    }

    if (!fs.existsSync(parent)) {
      return { ok: false, error: `Target folder does not exist: ${parent}` };
    }

    const targetPath = path.join(parent, trimmedName);
    if (fs.existsSync(targetPath)) {
      return { ok: false, error: `A folder named "${trimmedName}" already exists at ${parent}` };
    }

    const cloneUrl = buildAuthenticatedCloneUrl(remoteUrl, pat);
    const progressChannel = cloneId ? `repos:clone-progress:${cloneId}` : null;

    const sendProgress = (progress) => {
      if (!progressChannel || event.sender.isDestroyed()) return;
      event.sender.send(progressChannel, progress);
    };

    sendProgress({ phase: 'starting', label: 'Starting clone', percent: 0, indeterminate: false });

    await runGitCloneWithProgress(cloneUrl, targetPath, pat, sendProgress);

    sendProgress({ phase: 'done', label: 'Clone complete', percent: 100, indeterminate: false });

    azureRepoCache.clear();

    const gitHistoryReport = tryGenerateGitHistoryReport(targetPath, trimmedName);

    return { ok: true, path: targetPath, gitHistoryReport };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('repos:delete', async (_event, { repoPath }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Project folder not found.' };
    }

    const clonePath = getActiveWorkspace().clonePath || '';
    if (!isRepoWithinClonePath(repoPath, clonePath)) {
      return { ok: false, error: 'This project is outside the configured clone folder.' };
    }

    if (!isGitRepo(repoPath)) {
      return { ok: false, error: 'This folder is not a git repository.' };
    }

    fs.rmSync(repoPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    deleteProjectData(repoPath);
    azureRepoCache.delete(path.normalize(repoPath));

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function readProjectReadme(repoPath) {
  const candidates = ['README.md', 'Readme.md', 'readme.md', 'README.MD', 'README'];

  for (const name of candidates) {
    const filePath = path.join(repoPath, name);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return {
          ok: true,
          filename: name,
          content: fs.readFileSync(filePath, 'utf8'),
        };
      }
    } catch {
      // try next candidate
    }
  }

  return { ok: false, filename: null, content: '' };
}

ipcMain.handle('repos:readme', (_event, { repoPath }) => {
  if (!repoPath || !fs.existsSync(repoPath)) {
    return { ok: false, error: 'Repository folder not found.', filename: null, content: '' };
  }
  return readProjectReadme(repoPath);
});

function getRecentCommits(repoPath, count = 5) {
  const output = gitOutput(repoPath, [
    'log',
    '--all',
    '--date-order',
    `-${count}`,
    `--pretty=format:%h${GIT_FIELD_SEP}%an${GIT_FIELD_SEP}%cr${GIT_FIELD_SEP}%s`,
  ]);

  return parseTabSeparatedLines(output, 4).map(({ a, b, c, d }) => ({
    hash: a,
    author: b,
    date: c,
    subject: d,
  }));
}

function resolveMainRemoteRef(repoPath) {
  const candidates = [
    'origin/main',
    'origin/master',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
  ];

  for (const ref of candidates) {
    const result = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  }

  try {
    const originHead = gitOutput(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const result = spawnSync('git', ['rev-parse', '--verify', originHead], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  } catch {
    // ignore missing origin/HEAD
  }

  return null;
}

function getRemoteBranchShortName(refName) {
  return refName.replace(/^origin\//, '').replace(/^refs\/remotes\/origin\//, '');
}

function resolveBranchRef(repoPath, branchName) {
  const normalized = branchName.replace(/^origin\//, '');
  const candidates = [
    branchName,
    `origin/${normalized}`,
    `refs/heads/${normalized}`,
    `refs/remotes/origin/${normalized}`,
  ];

  for (const ref of candidates) {
    const result = spawnSync('git', ['rev-parse', '--verify', ref], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  }

  return null;
}

function getMainAheadOfLastRelease(repoPath, fetchRemote = true) {
  if (fetchRemote) {
    spawnSync('git', ['fetch', '--prune', 'origin'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const mainRef = resolveMainRemoteRef(repoPath);
  if (!mainRef) {
    return {
      mainBranch: '',
      releaseBranch: '',
      commitsAhead: 0,
      isAhead: false,
      message: 'Could not resolve main branch.',
    };
  }

  const mainBranch = getRemoteBranchShortName(
    gitOutput(repoPath, ['rev-parse', '--abbrev-ref', mainRef]),
  );

  const releaseBranch = findLastReleaseBranch(repoPath);
  if (!releaseBranch) {
    return {
      mainBranch,
      releaseBranch: '',
      commitsAhead: 0,
      isAhead: false,
      message: '',
    };
  }

  const releaseRef = resolveBranchRef(repoPath, releaseBranch);
  if (!releaseRef) {
    return {
      mainBranch,
      releaseBranch,
      commitsAhead: 0,
      isAhead: false,
      message: `Could not resolve release branch "${releaseBranch}".`,
    };
  }

  let commitsAhead = 0;
  try {
    const countStr = gitOutput(repoPath, ['rev-list', '--count', `${releaseRef}..${mainRef}`]);
    commitsAhead = Number.parseInt(countStr, 10) || 0;
  } catch (err) {
    return {
      mainBranch,
      releaseBranch,
      commitsAhead: 0,
      isAhead: false,
      message: err.message || 'Could not compare branches.',
    };
  }

  return {
    mainBranch,
    releaseBranch,
    commitsAhead,
    isAhead: commitsAhead > 0,
    message: '',
  };
}

function getRecentBranches(repoPath, count = 5) {
  const output = gitOutput(repoPath, [
    'for-each-ref',
    'refs/heads/',
    'refs/remotes/origin/',
    '--sort=-committerdate',
    `--format=%(refname:short)${GIT_FIELD_SEP}%(committername)${GIT_FIELD_SEP}%(committerdate:relative)`,
  ]);

  const seen = new Set();
  const branches = [];

  for (const { a, b, c } of parseTabSeparatedLines(output, 3)) {
    const refName = a.trim();
    if (!refName || refName.endsWith('/HEAD')) continue;

    const displayName = refName.replace(/^origin\//, '');
    const dedupeKey = displayName.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    branches.push({
      name: displayName,
      author: b.trim(),
      created: c.trim(),
    });

    if (branches.length >= count) break;
  }

  return branches;
}

ipcMain.handle('repos:recentCommits', (_event, { repoPath }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }
    return { ok: true, commits: getRecentCommits(repoPath) };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
});

ipcMain.handle('repos:recentBranches', (_event, { repoPath }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }
    return { ok: true, branches: getRecentBranches(repoPath) };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
});

ipcMain.handle('repos:mainAheadOfLastRelease', (_event, { repoPath, fetchRemote = true }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }
    return { ok: true, ...getMainAheadOfLastRelease(repoPath, fetchRemote) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('repos:gitHistoryReportStatus', (_event, { repoPath }) => {
  try {
    return { ok: true, ...getGitHistoryReportStatus(repoPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('repos:generateGitHistoryReport', (_event, { repoPath, repoName }) => {
  try {
    const result = generateGitHistoryReport(repoPath, repoName || path.basename(repoPath));
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('repos:openGitHistoryReport', async (_event, { repoPath }) => {
  try {
    const status = getGitHistoryReportStatus(repoPath);
    if (!status.exists || !status.path) {
      return { ok: false, error: 'No git history report found for this project.' };
    }
    await shell.openPath(status.path);
    return { ok: true, path: status.path };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function remoteBranchLocalName(remoteBranch) {
  const slashIndex = remoteBranch.indexOf('/');
  if (slashIndex === -1) return remoteBranch;
  return remoteBranch.slice(slashIndex + 1);
}

function listRepoBranches(repoPath, fetchRemote = false) {
  if (fetchRemote) {
    spawnSync('git', ['fetch', '--prune'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const localOutput = execSync('git branch --format=%(refname:short)', {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const local = [...new Set(
    localOutput.split('\n').map((line) => line.trim()).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));

  const remoteOutput = execSync('git branch -r --format=%(refname:short)', {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const remoteOnly = [...new Set(
    remoteOutput.split('\n').map((line) => line.trim()).filter((line) => line && !line.endsWith('/HEAD')),
  )]
    .filter((remote) => !local.includes(remoteBranchLocalName(remote)))
    .sort((a, b) => a.localeCompare(b))
    .map((remote) => ({ value: remote, label: remote }));

  const current = getCurrentBranch(repoPath);
  if (current && !local.includes(current)) {
    local.unshift(current);
  }

  return { local, remoteOnly, current, branches: local };
}

function checkoutRepoBranch(repoPath, branch) {
  const trimmed = branch.trim();
  const isRemote = trimmed.includes('/');

  let result = spawnSync('git', isRemote ? ['checkout', '--track', trimmed] : ['checkout', trimmed], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0 && isRemote) {
    const localName = remoteBranchLocalName(trimmed);
    result = spawnSync('git', ['checkout', '-b', localName, trimmed], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  return result;
}

ipcMain.handle('repos:listBranches', (_event, { repoPath, fetchRemote = false }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }
    return { ok: true, ...listRepoBranches(repoPath, fetchRemote) };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
});

ipcMain.handle('repos:checkout', (_event, { repoPath, branch }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }
    if (!branch?.trim()) {
      return { ok: false, error: 'Branch name is required.' };
    }

    const result = checkoutRepoBranch(repoPath, branch);

    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || 'Checkout failed.').trim();
      return { ok: false, error: message };
    }

    return { ok: true, branch: getCurrentBranch(repoPath), repo: getRepoInfo(repoPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('repos:pull', (_event, { repoPath }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }

    spawnSync('git', ['fetch', '--prune'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result = spawnSync('git', ['pull'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || 'Pull failed.').trim();
      return { ok: false, error: message };
    }

    const output = (result.stdout || result.stderr || '').trim();
    const lastPullAt = new Date().toISOString();
    const projectData = getProjectData(repoPath);
    projectData.lastPullAt = lastPullAt;
    setProjectData(repoPath, projectData);

    const gitHistoryReport = tryGenerateGitHistoryReport(
      repoPath,
      path.basename(repoPath),
    );

    return {
      ok: true,
      output,
      lastPullAt,
      repo: getRepoInfo(repoPath),
      branches: listRepoBranches(repoPath, false),
      gitHistoryReport,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function fetchActivePullRequestsForRepository(organization, project, repository, pat) {
  const repoKey = encodeURIComponent(repository.id || repository.name);
  const url = new URL(
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_apis/git/repositories/${repoKey}/pullrequests`,
  );
  url.searchParams.set('searchCriteria.status', 'active');
  url.searchParams.set('$top', '100');
  url.searchParams.set('api-version', '7.0');

  const res = await fetch(url.toString(), {
    headers: azureAuthHeaders(pat),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseAzureApiError(text, res.status));
  }

  const data = await res.json();
  return data.value || [];
}

function isPullRequestAwaitingReview(pullRequest) {
  if (pullRequest.status !== 'active' || pullRequest.isDraft) {
    return false;
  }

  const reviewers = (pullRequest.reviewers || []).filter((reviewer) => !reviewer.isContainer);
  if (reviewers.length === 0) {
    return true;
  }

  const requiredReviewers = reviewers.filter((reviewer) => reviewer.isRequired);
  const pendingReview = (reviewer) => reviewer.vote === 0;
  const reviewTargets = requiredReviewers.length > 0 ? requiredReviewers : reviewers;

  return reviewTargets.some(pendingReview);
}

async function fetchPullRequestsAwaitingReviewCount() {
  const azure = getActiveWorkspace().azure;
  const { organization, project, pat } = azure;

  if (!organization || !project) {
    throw new Error('Configure Azure DevOps organization and project in Settings.');
  }

  if (!pat) {
    throw new Error('Azure DevOps is not configured for this workspace. Add your PAT in Settings.');
  }

  const repositories = await listAzureGitRepositories(organization, project, pat);
  const results = await Promise.allSettled(
    repositories.map((repository) =>
      fetchActivePullRequestsForRepository(organization, project, repository, pat),
    ),
  );

  let count = 0;
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push(`${repositories[index].name}: ${result.reason.message}`);
      return;
    }

    count += result.value.filter(isPullRequestAwaitingReview).length;
  });

  if (errors.length === repositories.length) {
    throw new Error(errors[0] || 'Could not load pull requests.');
  }

  return { count, warnings: errors };
}

async function fetchAzurePullRequests(repoPath) {
  const azure = getActiveWorkspace().azure;
  const { pat } = azure;

  if (!pat) {
    throw new Error('Azure DevOps is not configured for this workspace. Add your PAT in Settings.');
  }

  const { organization, project, repository, repositoryId } = await resolveAzureGitRepository(repoPath);
  const repoKey = encodeURIComponent(repositoryId || repository);
  const url = new URL(
    `https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_apis/git/repositories/${repoKey}/pullrequests`,
  );
  url.searchParams.set('searchCriteria.status', 'active');
  url.searchParams.set('$top', '5');
  url.searchParams.set('api-version', '7.0');

  const res = await fetch(url.toString(), {
    headers: azureAuthHeaders(pat),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseAzureApiError(text, res.status));
  }

  const data = await res.json();
  const webBase = `https://dev.azure.com/${organization}/${project}/_git/${repository}`;

  return (data.value || [])
    .sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate))
    .slice(0, 5)
    .map((pr) => ({
      id: pr.pullRequestId,
      title: pr.title || '',
      author: pr.createdBy?.displayName || 'Unknown',
      date: formatRelativeTime(pr.creationDate),
      url: `${webBase}/pullrequest/${pr.pullRequestId}`,
    }));
}

function isAssignedToCurrentUser(assignedTo, currentUser) {
  if (!assignedTo) return false;
  if (!currentUser) return true;

  const assignedId = String(assignedTo.id || '').toLowerCase();
  const currentId = String(currentUser.id || '').toLowerCase();
  if (assignedId && currentId && assignedId === currentId) return true;

  const assignedName = (assignedTo.displayName || assignedTo.uniqueName || '').toLowerCase();
  const currentName = (
    currentUser.providerDisplayName
    || currentUser.customDisplayName
    || currentUser.displayName
    || ''
  ).toLowerCase();

  return Boolean(assignedName && currentName && assignedName === currentName);
}

async function fetchAzureTasks() {
  const azure = getActiveWorkspace().azure;
  const { organization, project, pat } = azure;

  if (!organization || !project || !pat) {
    throw new Error('Azure DevOps is not configured for this workspace. Add your org, project, and PAT in Settings.');
  }

  const auth = Buffer.from(`:${pat}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
  };

  const wiqlUrl = `https://dev.azure.com/${organization}/${project}/_apis/wit/wiql?api-version=7.0`;
  const wiqlBody = {
    query: "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC",
  };

  const currentUser = await getAzureAuthenticatedUser(organization, pat);

  const wiqlRes = await fetch(wiqlUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(wiqlBody),
  });

  if (!wiqlRes.ok) {
    const text = await wiqlRes.text();
    throw new Error(`Azure DevOps query failed (${wiqlRes.status}): ${text}`);
  }

  const wiqlData = await wiqlRes.json();
  const ids = (wiqlData.workItems || []).map((w) => w.id);

  if (ids.length === 0) return [];

  const batchUrl = `https://dev.azure.com/${organization}/${project}/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.0`;
  const batchRes = await fetch(batchUrl, { headers });

  if (!batchRes.ok) {
    const text = await batchRes.text();
    throw new Error(`Failed to fetch work items (${batchRes.status}): ${text}`);
  }

  const batchData = await batchRes.json();

  return (batchData.value || [])
    .filter((item) => isAssignedToCurrentUser(item.fields?.['System.AssignedTo'], currentUser))
    .map((item) => {
    const fields = item.fields || {};
    const createdBy = fields['System.CreatedBy'];
    const assignedTo = fields['System.AssignedTo'];
    return {
      id: item.id,
      title: fields['System.Title'] || '',
      state: fields['System.State'] || '',
      type: fields['System.WorkItemType'] || '',
      creator: createdBy?.displayName || createdBy?.uniqueName || 'Unknown',
      assignee: assignedTo?.displayName || assignedTo?.uniqueName || 'Unassigned',
      url: `https://dev.azure.com/${organization}/${project}/_workitems/edit/${item.id}`,
    };
  });
}

ipcMain.handle('azure:listRepositories', async () => {
  try {
    const azure = getActiveWorkspace().azure;
    const { organization, project, pat } = azure;

    if (!organization || !project) {
      return {
        ok: false,
        error: 'Configure Azure DevOps organization and project in Settings.',
        repositories: [],
      };
    }

    if (!pat) {
      return {
        ok: false,
        error: 'Add an Azure DevOps PAT in Settings to list remote repositories.',
        repositories: [],
      };
    }

    const azureRepos = await listAzureGitRepositories(organization, project, pat);
    const localRepos = scanAllWorkspaceRepos();

    const repositories = azureRepos.map((repo) => {
      const local = findLocalRepoForAzureRepository(repo, localRepos);
      return {
        id: repo.id,
        name: repo.name,
        webUrl: repo.webUrl || '',
        remoteUrl: repo.remoteUrl || '',
        defaultBranch: repo.defaultBranch || '',
        isLocal: Boolean(local),
        localPath: local?.path || null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return {
      ok: true,
      organization,
      project,
      repositories,
    };
  } catch (err) {
    return { ok: false, error: err.message, repositories: [] };
  }
});

ipcMain.handle('azure:fetchPullRequestsAwaitingReview', async () => {
  try {
    const { count, warnings } = await fetchPullRequestsAwaitingReviewCount();
    return { ok: true, count, warnings };
  } catch (err) {
    return { ok: false, error: err.message, count: 0 };
  }
});

ipcMain.handle('azure:fetchPullRequests', async (_event, { repoPath }) => {
  try {
    if (!repoPath || !fs.existsSync(repoPath)) {
      return { ok: false, error: 'Repository folder not found.' };
    }
    const pullRequests = await fetchAzurePullRequests(repoPath);
    return { ok: true, pullRequests };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('azure:fetchTasks', async () => {
  try {
    const tasks = await fetchAzureTasks();
    return { ok: true, tasks };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('azure:testConnection', async () => {
  try {
    const azure = getActiveWorkspace().azure;
    const { organization, project, pat } = azure;
    if (!organization || !project || !pat) {
      return { ok: false, error: 'Missing organization, project, or PAT.' };
    }

    const auth = Buffer.from(`:${pat}`).toString('base64');
    const url = `https://dev.azure.com/${organization}/_apis/projects/${project}?api-version=7.0`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Connection failed (${res.status}): ${text}` };
    }

    const data = await res.json();
    const currentUser = await getAzureAuthenticatedUser(organization, pat);
    const patOwner = formatAzureUserDisplayName(currentUser);
    return { ok: true, projectName: data.name, patOwner };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
