const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devHub', {
  app: {
    onFocusCommandBar: (callback) => {
      const channel = 'app:focus-command-bar';
      const handler = () => callback();
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  workspaces: {
    list: () => ipcRenderer.invoke('workspaces:list'),
    create: (name) => ipcRenderer.invoke('workspaces:create', { name }),
    switch: (id) => ipcRenderer.invoke('workspaces:switch', { id }),
    rename: (id, name) => ipcRenderer.invoke('workspaces:rename', { id, name }),
    delete: (id) => ipcRenderer.invoke('workspaces:delete', { id }),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  },

  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    showError: (message, title) => ipcRenderer.invoke('dialog:showError', { message, title }),
    showConfirm: (opts) => ipcRenderer.invoke('dialog:showConfirm', opts),
  },

  fs: {
    checkDirectory: (dirPath) => ipcRenderer.invoke('fs:checkDirectory', dirPath),
  },

  terminal: {
    create: (opts) => ipcRenderer.invoke('terminal:create', opts),
    input: (id, data) => ipcRenderer.send('terminal:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (id, callback) => {
      const channel = `terminal:data:${id}`;
      const handler = (_event, data) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onExit: (id, callback) => {
      const channel = `terminal:exit:${id}`;
      const handler = () => callback();
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  repos: {
    scan: () => ipcRenderer.invoke('repos:scan'),
    clone: (opts) => ipcRenderer.invoke('repos:clone', opts),
    onCloneProgress: (cloneId, callback) => {
      const channel = `repos:clone-progress:${cloneId}`;
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    delete: (repoPath) => ipcRenderer.invoke('repos:delete', { repoPath }),
    readme: (repoPath) => ipcRenderer.invoke('repos:readme', { repoPath }),
    recentCommits: (repoPath) => ipcRenderer.invoke('repos:recentCommits', { repoPath }),
    recentBranches: (repoPath) => ipcRenderer.invoke('repos:recentBranches', { repoPath }),
    mainAheadOfLastRelease: (repoPath, fetchRemote = true) => ipcRenderer.invoke(
      'repos:mainAheadOfLastRelease',
      { repoPath, fetchRemote },
    ),
    listBranches: (repoPath, fetchRemote = false) =>
      ipcRenderer.invoke('repos:listBranches', { repoPath, fetchRemote }),
    checkout: (repoPath, branch) => ipcRenderer.invoke('repos:checkout', { repoPath, branch }),
    pull: (repoPath) => ipcRenderer.invoke('repos:pull', { repoPath }),
    gitHistoryReportStatus: (repoPath) => ipcRenderer.invoke('repos:gitHistoryReportStatus', { repoPath }),
    generateGitHistoryReport: (repoPath, repoName) =>
      ipcRenderer.invoke('repos:generateGitHistoryReport', { repoPath, repoName }),
    openGitHistoryReport: (repoPath) => ipcRenderer.invoke('repos:openGitHistoryReport', { repoPath }),
  },

  projects: {
    get: (repoPath) => ipcRenderer.invoke('projects:get', { repoPath }),
    summaries: () => ipcRenderer.invoke('projects:summaries'),
    saveAnnotations: (repoPath, annotations) =>
      ipcRenderer.invoke('projects:saveAnnotations', { repoPath, annotations }),
    addTodo: (repoPath, text) => ipcRenderer.invoke('projects:addTodo', { repoPath, text }),
    updateTodo: (repoPath, todoId, updates) =>
      ipcRenderer.invoke('projects:updateTodo', { repoPath, todoId, ...updates }),
    deleteTodo: (repoPath, todoId) => ipcRenderer.invoke('projects:deleteTodo', { repoPath, todoId }),
  },

  ide: {
    open: (ide, repoPath) => ipcRenderer.invoke('ide:open', { ide, repoPath }),
  },

  azure: {
    listRepositories: () => ipcRenderer.invoke('azure:listRepositories'),
    fetchTasks: () => ipcRenderer.invoke('azure:fetchTasks'),
    fetchPullRequests: (repoPath) => ipcRenderer.invoke('azure:fetchPullRequests', { repoPath }),
    fetchPullRequestsAwaitingReview: () => ipcRenderer.invoke('azure:fetchPullRequestsAwaitingReview'),
    testConnection: () => ipcRenderer.invoke('azure:testConnection'),
  },
});
