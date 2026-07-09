/* global Terminal, FitAddon, WebLinksAddon, marked */

const api = window.devHub;

const DEFAULT_ERROR_TITLE = 'Dev Hub';

function formatErrorMessage(error) {
  if (!error) return 'Something went wrong.';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || 'Something went wrong.';
  if (typeof error === 'object' && error.message) return error.message;
  return String(error);
}

async function reportError(error, title = DEFAULT_ERROR_TITLE) {
  await api.dialog.showError(formatErrorMessage(error), title);
}

async function ensureApiOk(result, title = DEFAULT_ERROR_TITLE) {
  if (!result || result.ok !== false) return true;
  await reportError(result.error, title);
  return false;
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled rejection:', event.reason);
  });
}

let settings = null;
let workspaces = { activeId: null, workspaces: [] };
let currentProject = null;
let cachedRepos = [];
let repoScanFetchedAt = 0;
let repoScanRequestId = 0;
const REPO_SCAN_CACHE_MS = 30_000;
let lastListView = 'dashboard';
let terminalSessions = [];
let activeTerminalId = null;
let terminalCounter = 0;
let projectRenderSeq = 0;
let openProjectSeq = 0;
let resizeTimer = null;

// ── Navigation ────────────────────────────────────────────────────────────────

const PROJECTS_EXPANDED_KEY = 'devhub:projectsExpanded';
const navProjectsGroup = document.getElementById('nav-projects-group');
const navProjectsToggle = document.getElementById('nav-projects-toggle');
let projectsExpanded = localStorage.getItem(PROJECTS_EXPANDED_KEY) !== 'false';

function setProjectsExpanded(expanded, { persist = true } = {}) {
  projectsExpanded = expanded;
  navProjectsGroup?.classList.toggle('expanded', expanded);
  navProjectsToggle?.setAttribute('aria-expanded', String(expanded));
  if (persist) {
    localStorage.setItem(PROJECTS_EXPANDED_KEY, String(expanded));
  }
}

function toggleProjectsExpanded() {
  setProjectsExpanded(!projectsExpanded);
}

document.querySelectorAll('.nav-list > li > .nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    if (view === 'repos') return;
    showView(view);
  });
});

navProjectsToggle?.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="toggle-projects"]')) {
    toggleProjectsExpanded();
    return;
  }
  currentProject = null;
  updateProjectsSubmenuActive();
  if (!projectsExpanded) setProjectsExpanded(true);
  showView('repos');
});

function updateNavActiveState(viewName) {
  document.querySelectorAll('.nav-btn:not(.nav-btn-sub)').forEach((b) => {
    const isProjectsParent = b.dataset.view === 'repos';
    const isActive = b.dataset.view === viewName
      || (isProjectsParent && viewName === 'project');
    b.classList.toggle('active', isActive);
  });
  updateProjectsSubmenuActive();
}

function updateProjectsSubmenuActive() {
  const onProjectView = document.getElementById('view-project').classList.contains('active');
  document.querySelectorAll('.nav-btn-sub').forEach((btn) => {
    const isActive = onProjectView
      && Boolean(currentProject && btn.dataset.repoPath === currentProject.path);
    btn.classList.toggle('active', isActive);
  });
}

function renderProjectsSubmenu(repos = cachedRepos) {
  cachedRepos = repos;
  const submenuEl = document.getElementById('nav-projects-submenu');
  if (!submenuEl) return;

  submenuEl.innerHTML = '';

  if (repos.length === 0) {
    const hint = document.createElement('li');
    hint.className = 'nav-submenu-empty';
    hint.textContent = 'No projects yet — open Projects to add folders.';
    submenuEl.appendChild(hint);
    return;
  }

  repos.forEach((repo) => {
    const item = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-btn nav-btn-sub';
    btn.dataset.repoPath = repo.path;
    btn.title = repo.path;

    const label = document.createElement('span');
    label.className = 'nav-sub-label';
    label.textContent = repo.name;

    btn.appendChild(label);
    btn.addEventListener('click', () => {
      setProjectsExpanded(true);
      openProject(repo);
    });

    item.appendChild(btn);
    submenuEl.appendChild(item);
  });

  updateProjectsSubmenuActive();
}

function showView(name, { focusContent = false } = {}) {
  updateNavActiveState(name);
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${name}`);
  });

  if (name === 'terminal') {
    resizeActiveTerminal();
  }

  if (name === 'dashboard') {
    void refreshDashboard({ preferCache: true });
  }

  if (name === 'repos') {
    void loadProjectsPage({ preferCache: true });
  }

  if (name === 'tasks') {
    void loadTasks();
  }

  if (focusContent) {
    focusViewContent(name);
  }
}

function focusElement(el) {
  if (!el) return;
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
  }
  el.focus({ preventScroll: false });
}

function focusActiveTerminal() {
  if (terminalSessions.length === 0) {
    createTerminalSession();
    return;
  }

  const session = terminalSessions.find((s) => s.id === activeTerminalId);
  if (!session) return;

  window.setTimeout(() => {
    try {
      session.fitAddon.fit();
      session.term.focus();
    } catch {
      // Ignore while the pane is still settling.
    }
  }, 50);
}

function focusViewContent(name) {
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      const viewEl = document.getElementById(`view-${name}`);
      if (!viewEl?.classList.contains('active')) return;

      if (name === 'terminal') {
        focusActiveTerminal();
        return;
      }

      let target = null;

      switch (name) {
        case 'dashboard':
          target = document.querySelector('#view-dashboard .dash-nav-card')
            || document.getElementById('links-add')
            || viewEl;
          break;
        case 'repos':
          target = document.querySelector('#local-repos-list .repo-item')
            || document.querySelector('#remote-repos-list .remote-repo-item')
            || document.getElementById('repos-refresh')
            || document.getElementById('local-repos-list');
          break;
        case 'tasks':
          target = document.querySelector('#tasks-list .dash-task-link')
            || document.getElementById('tasks-list');
          break;
        case 'settings':
          target = document.getElementById('settings-workspace-name');
          break;
        case 'project':
          target = document.getElementById('project-back')
            || document.getElementById('project-readme')
            || viewEl;
          break;
        default:
          target = viewEl;
      }

      if (target?.focus && target.tagName !== 'DIV' && target.tagName !== 'UL') {
        target.focus({ preventScroll: false });
      } else {
        focusElement(target || viewEl);
      }
    }, name === 'repos' || name === 'tasks' ? 80 : 0);
  });
}

function navigateToView(name, { focusContent = false } = {}) {
  showView(name, { focusContent });
}

function initDashboardNavigation() {
  document.querySelectorAll('.dash-widget-title, .dash-nav-card').forEach((el) => {
    const view = el.dataset.view;
    if (!view) return;

    const go = () => navigateToView(view);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
}

// ── Projects ──────────────────────────────────────────────────────────────────

function rememberListView() {
  const activeNav = document.querySelector('.nav-btn.active');
  if (activeNav?.dataset.view) {
    lastListView = activeNav.dataset.view;
  }
}

async function openProject(repo, { focusContent = false } = {}) {
  const openId = ++openProjectSeq;

  rememberListView();
  currentProject = repo;
  setProjectsExpanded(true);

  document.getElementById('project-title').textContent = repo.name;
  document.getElementById('project-path').textContent = repo.path;

  updateNavActiveState('project');
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === 'view-project');
  });

  try {
    await renderProjectView(repo, openId);
    if (focusContent && openId === openProjectSeq) {
      focusViewContent('project');
    }
  } catch (err) {
    if (openId === openProjectSeq) {
      await reportError(err, 'Project');
    }
  }
}

function isProjectRenderCurrent(renderId, openId) {
  return renderId === projectRenderSeq && openId === openProjectSeq;
}

async function renderProjectView(repo, openId = openProjectSeq) {
  const renderId = ++projectRenderSeq;

  document.getElementById('project-title').textContent = repo.name;
  document.getElementById('project-path').textContent = repo.path;

  const projectData = await api.projects.get(repo.path);
  if (!isProjectRenderCurrent(renderId, openId)) return;

  const metaBar = document.getElementById('project-meta-bar');
  metaBar.replaceChildren();

  const widget = await createProjectMetaWidget(repo, projectData, { renderId, openId });
  if (!isProjectRenderCurrent(renderId, openId)) return;

  metaBar.replaceChildren(widget);

  const headerActions = document.getElementById('project-header-actions');
  headerActions.replaceChildren();
  headerActions.appendChild(createIdeButtons(repo.path));

  if (repo.azureUrl) {
    const azureBtn = document.createElement('button');
    azureBtn.type = 'button';
    azureBtn.className = 'btn btn-secondary';
    azureBtn.textContent = 'Azure DevOps';
    azureBtn.addEventListener('click', () => api.shell.openExternal(repo.azureUrl));
    headerActions.appendChild(azureBtn);
  }

  const openFolderBtn = document.createElement('button');
  openFolderBtn.type = 'button';
  openFolderBtn.className = 'btn btn-secondary';
  openFolderBtn.textContent = 'Open folder';
  openFolderBtn.addEventListener('click', () => api.shell.openPath(repo.path));
  headerActions.appendChild(openFolderBtn);

  const openTerminalBtn = document.createElement('button');
  openTerminalBtn.type = 'button';
  openTerminalBtn.className = 'btn btn-secondary';
  openTerminalBtn.textContent = 'Terminal';
  openTerminalBtn.addEventListener('click', () => {
    showView('terminal');
    createTerminalSession(repo.path);
  });
  headerActions.appendChild(openTerminalBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-secondary btn-danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteLocalProject(repo));
  headerActions.appendChild(deleteBtn);

  if (!isProjectRenderCurrent(renderId, openId)) return;

  await Promise.all([
    renderProjectGitActivity(repo.path, { quiet: true }),
    renderProjectPullRequests(repo, { quiet: true }),
    renderProjectReadme(repo.path, { quiet: true }),
    renderProjectGitHistoryReport(repo, { quiet: true }),
  ]);
}

async function renderProjectGitActivity(repoPath, { quiet = false } = {}) {
  const commitsEl = document.getElementById('project-commits');
  const branchesEl = document.getElementById('project-recent-branches');
  const releaseStatusEl = document.getElementById('project-main-release-status');

  commitsEl.innerHTML = '<li class="list-empty">Loading commits…</li>';
  branchesEl.innerHTML = '<li class="list-empty">Loading branches…</li>';
  if (releaseStatusEl) {
    releaseStatusEl.innerHTML = '<p class="list-empty">Loading…</p>';
  }

  const [commitsResult, branchesResult, releaseStatusResult] = await Promise.all([
    api.repos.recentCommits(repoPath),
    api.repos.recentBranches(repoPath),
    api.repos.mainAheadOfLastRelease(repoPath, false),
  ]);

  if (!commitsResult.ok) {
    commitsEl.innerHTML = '<li class="list-empty">Could not load commits.</li>';
    if (!quiet) await reportError(commitsResult.error, 'Recent commits');
  } else if (commitsResult.commits.length === 0) {
    commitsEl.innerHTML = '<li class="list-empty">No commits found.</li>';
  } else {
    commitsEl.innerHTML = '';
    commitsResult.commits.forEach((commit) => {
      const item = document.createElement('li');
      item.className = 'commit-item';
      item.innerHTML = `
        <div class="commit-header">
          <span class="commit-hash">${escapeHtml(commit.hash)}</span>
          <span class="commit-date">${escapeHtml(commit.date)}</span>
        </div>
        <div class="commit-meta">${escapeHtml(commit.author)}</div>
        <div class="commit-subject">${escapeHtml(commit.subject)}</div>`;
      commitsEl.appendChild(item);
    });
  }

  if (!branchesResult.ok) {
    branchesEl.innerHTML = '<li class="list-empty">Could not load branches.</li>';
    if (!quiet) await reportError(branchesResult.error, 'Recent branches');
  } else if (branchesResult.branches.length === 0) {
    branchesEl.innerHTML = '<li class="list-empty">No branches found.</li>';
  } else {
    branchesEl.innerHTML = '';
    branchesResult.branches.forEach((branch) => {
      const item = document.createElement('li');
      item.className = 'commit-item';
      item.innerHTML = `
        <div class="commit-header">
          <span class="commit-hash">${escapeHtml(branch.name)}</span>
          <span class="commit-date">${escapeHtml(branch.created)}</span>
        </div>
        <div class="commit-meta">${escapeHtml(branch.author)}</div>`;
      branchesEl.appendChild(item);
    });
  }

  if (!releaseStatusEl) return;

  if (!releaseStatusResult.ok) {
    releaseStatusEl.innerHTML = '<p class="list-empty">Could not load release status.</p>';
    if (!quiet) await reportError(releaseStatusResult.error, 'Main vs last release');
    return;
  }

  if (releaseStatusResult.message) {
    releaseStatusEl.innerHTML = `<p class="list-empty">${escapeHtml(releaseStatusResult.message)}</p>`;
    return;
  }

  if (!releaseStatusResult.releaseBranch) {
    releaseStatusEl.innerHTML = '<p class="list-empty">No release branch found.</p>';
    return;
  }

  const { mainBranch, releaseBranch, commitsAhead, isAhead } = releaseStatusResult;
  if (isAhead) {
    const commitLabel = commitsAhead === 1 ? '1 commit' : `${commitsAhead} commits`;
    releaseStatusEl.innerHTML = `
      <p class="main-release-status-line">
        <span class="badge badge-branch">${escapeHtml(mainBranch)}</span>
        is <span class="branch-ahead-count">${escapeHtml(commitLabel)} ahead</span>
        of <span class="badge badge-branch">${escapeHtml(releaseBranch)}</span>
      </p>
      <p class="field-feedback warning">There may be one pending release to be generated.</p>`;
  } else {
    releaseStatusEl.innerHTML = `
      <p class="main-release-status-line">
        <span class="badge badge-branch">${escapeHtml(mainBranch)}</span>
        is not ahead of <span class="badge badge-branch">${escapeHtml(releaseBranch)}</span>
      </p>`;
  }
}

function appendProjectPullRequestItem(container, pr) {
  const item = document.createElement('li');
  item.className = 'commit-item pr-item pr-item-awaiting-review';
  item.innerHTML = `
    <div class="commit-header">
      <span class="commit-hash">#${escapeHtml(String(pr.id))}</span>
      <span class="commit-date">${escapeHtml(pr.date)}</span>
    </div>
    <div class="commit-meta">${escapeHtml(pr.author)}</div>
    <div class="commit-subject">${escapeHtml(pr.title)}</div>`;
  item.title = 'Pull request awaiting review — open in Azure DevOps';
  item.addEventListener('click', () => api.shell.openExternal(pr.url));
  container.appendChild(item);
}

async function renderProjectPullRequests(repo, { quiet = false } = {}) {
  const prEl = document.getElementById('project-pull-requests');
  const statusEl = document.getElementById('project-pr-review-status');
  prEl.innerHTML = '<li class="list-empty">Loading pull requests…</li>';
  if (statusEl) {
    statusEl.textContent = '';
    statusEl.className = 'inline-status hidden';
  }

  const result = await api.azure.fetchPullRequests(repo.path);

  if (!result.ok) {
    prEl.innerHTML = '<li class="list-empty">Could not load pull requests.</li>';
    if (!quiet) await reportError(result.error, 'Pull requests awaiting review');
    return;
  }

  const awaitingReview = result.awaitingReview || [];

  if (statusEl && awaitingReview.length > 0) {
    statusEl.textContent = `${awaitingReview.length} open`;
    statusEl.className = 'inline-status warning';
  }

  if (awaitingReview.length === 0) {
    prEl.innerHTML = '<li class="list-empty">No pull requests awaiting review.</li>';
    return;
  }

  prEl.innerHTML = '';
  awaitingReview.forEach((pr) => {
    appendProjectPullRequestItem(prEl, pr);
  });
}

function formatGitReportDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

function formatGitReportRate(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

function buildGitHistoryReportStatsHtml(summary) {
  if (!summary) return '';

  const topContributor = summary.topContributor
    ? `${escapeHtml(summary.topContributor.author)} (${summary.topContributor.count} commits)`
    : '—';
  const busiestDay = summary.busiestDay?.count
    ? `${escapeHtml(summary.busiestDay.day)} (${summary.busiestDay.count})`
    : '—';
  const topFile = summary.topChangedFile
    ? escapeHtml(summary.topChangedFile.filePath)
    : '—';

  return `
    <div class="git-history-report-stats">
      <div class="git-history-stat">
        <span class="git-history-stat-label">Top contributor</span>
        <span class="git-history-stat-value">${topContributor}</span>
      </div>
      <div class="git-history-stat">
        <span class="git-history-stat-label">Commits / day</span>
        <span class="git-history-stat-value">${formatGitReportRate(summary.activityRates?.perDay)}</span>
      </div>
      <div class="git-history-stat">
        <span class="git-history-stat-label">Busiest day</span>
        <span class="git-history-stat-value">${busiestDay}</span>
      </div>
      <div class="git-history-stat">
        <span class="git-history-stat-label">Commits / week</span>
        <span class="git-history-stat-value">${formatGitReportRate(summary.activityRates?.perWeek)}</span>
      </div>
      <div class="git-history-stat">
        <span class="git-history-stat-label">Commits / month</span>
        <span class="git-history-stat-value">${formatGitReportRate(summary.activityRates?.perMonth)}</span>
      </div>
      <div class="git-history-stat">
        <span class="git-history-stat-label">Most changed code file</span>
        <span class="git-history-stat-value">${topFile}</span>
      </div>
    </div>`;
}

function renderGitHistoryReportActions(repo, actionsEl, status) {
  actionsEl.innerHTML = '';

  if (!status.exists) return;

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn-secondary';
  openBtn.textContent = 'Open report';
  openBtn.addEventListener('click', () => openGitHistoryReport(repo));
  actionsEl.appendChild(openBtn);
}

function renderGitHistoryReportContent(reportEl, status) {
  if (!status.exists) {
    reportEl.innerHTML = '<p class="list-empty">Analyzing git history…</p>';
    return;
  }

  const statsHtml = buildGitHistoryReportStatsHtml(status.summary);
  reportEl.innerHTML = `
    <p class="git-history-report-meta">
      Report updated ${escapeHtml(formatGitReportDate(status.generatedAt))}.
      Pull again to refresh the analysis.
    </p>
    ${statsHtml || '<p class="list-empty">No report data available yet.</p>'}
    <p class="git-history-report-path">${escapeHtml(status.path || '')}</p>`;
}

function gitHistoryReportStatusFromResult(result) {
  if (!result?.ok) return null;
  return {
    exists: true,
    generatedAt: result.generatedAt,
    path: result.path,
    summary: result.summary,
  };
}

function updateGitHistoryReportWidget(repo, status) {
  const reportEl = document.getElementById('project-git-report');
  const actionsEl = document.getElementById('project-git-report-actions');
  if (!reportEl || !actionsEl) return;

  renderGitHistoryReportActions(repo, actionsEl, status);
  renderGitHistoryReportContent(reportEl, status);
}

async function openGitHistoryReport(repo) {
  const result = await api.repos.openGitHistoryReport(repo.path);
  if (!(await ensureApiOk(result, 'Git history report'))) return;
}

async function regenerateGitHistoryReportForProject(repo, { quiet = false } = {}) {
  const reportEl = document.getElementById('project-git-report');
  const actionsEl = document.getElementById('project-git-report-actions');

  if (reportEl) {
    reportEl.innerHTML = '<p class="list-empty">Analyzing git history…</p>';
  }
  if (actionsEl) {
    actionsEl.innerHTML = '';
  }

  const result = await api.repos.generateGitHistoryReport(repo.path, repo.name);

  if (!result.ok) {
    if (reportEl) {
      reportEl.innerHTML = '<p class="list-empty">Could not generate git history report.</p>';
    }
    if (!quiet) await reportError(result.error, 'Git history report');
    return null;
  }

  const status = gitHistoryReportStatusFromResult(result);
  updateGitHistoryReportWidget(repo, status);
  return status;
}

async function renderProjectGitHistoryReport(repo, { quiet = false } = {}) {
  const reportEl = document.getElementById('project-git-report');
  const actionsEl = document.getElementById('project-git-report-actions');

  reportEl.innerHTML = '<p class="list-empty">Loading report…</p>';
  actionsEl.innerHTML = '';

  const status = await api.repos.gitHistoryReportStatus(repo.path);
  if (!status.ok) {
    reportEl.innerHTML = '<p class="list-empty">Could not load report status.</p>';
    if (!quiet) await reportError(status.error, 'Git history report');
    return;
  }

  if (status.exists && status.summary) {
    updateGitHistoryReportWidget(repo, status);
    return;
  }

  await regenerateGitHistoryReportForProject(repo, { quiet });
}

async function renderProjectReadme(repoPath, { quiet = false } = {}) {
  const readmeEl = document.getElementById('project-readme');
  readmeEl.textContent = 'Loading README…';
  readmeEl.classList.remove('empty');

  const result = await api.repos.readme(repoPath);

  if (!result.ok) {
    readmeEl.textContent = 'Could not load README.';
    readmeEl.classList.add('empty');
    if (!quiet) await reportError(result.error, 'README');
    return;
  }

  if (!result.content) {
    readmeEl.textContent = 'No README found in this repository.';
    readmeEl.classList.add('empty');
    return;
  }

  readmeEl.innerHTML = renderMarkdown(result.content);
}

function renderMarkdown(content) {
  if (typeof marked !== 'undefined') {
    return marked.parse(content, { breaks: true, gfm: true });
  }
  return escapeHtml(content).replace(/\n/g, '<br>');
}

document.getElementById('project-readme').addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (!link?.href) return;
  e.preventDefault();
  api.shell.openExternal(link.href);
});

document.getElementById('project-back').addEventListener('click', () => {
  currentProject = null;
  showView(lastListView);
});

function getSummaryForRepo(summaries, repoPath) {
  return summaries[repoPath] || summaries[repoPath.replace(/\//g, '\\')] || {
    openTodos: 0,
    totalTodos: 0,
    annotationPreview: '',
    hasAnnotations: false,
  };
}

function createProjectCard(repo, summary = {}) {
  const openTodos = summary.openTodos || 0;
  const card = document.createElement('div');
  card.className = 'project-card';
  if ((repo.warningCount || 0) > 1) {
    card.classList.add('project-card-warn');
  }

  const nameEl = document.createElement('div');
  nameEl.className = 'project-card-name';
  nameEl.textContent = repo.name;

  if ((repo.warningCount || 0) > 1) {
    const warnDot = document.createElement('span');
    warnDot.className = 'project-card-warning';
    warnDot.setAttribute('aria-label', 'Release may be pending');
    warnDot.title = 'Release may be pending';
    nameEl.appendChild(warnDot);
  }

  const metaEl = document.createElement('div');
  metaEl.className = 'project-card-meta';
  metaEl.appendChild(createBranchBadge(repo.branch));

  if (openTodos > 0) {
    const todoBadge = document.createElement('span');
    todoBadge.className = 'badge dirty';
    todoBadge.textContent = `${openTodos} to-do${openTodos === 1 ? '' : 's'}`;
    metaEl.appendChild(todoBadge);
  }

  card.appendChild(nameEl);
  card.appendChild(metaEl);
  card.addEventListener('click', () => openProject(repo));
  return card;
}

// ── Workspaces ────────────────────────────────────────────────────────────────

async function loadWorkspaces() {
  workspaces = await api.workspaces.list();
  return workspaces;
}

function renderWorkspaceSwitcher() {
  const select = document.getElementById('workspace-select');
  select.innerHTML = '';

  workspaces.workspaces.forEach((ws) => {
    const option = document.createElement('option');
    option.value = ws.id;
    option.textContent = ws.name;
    option.selected = ws.id === workspaces.activeId;
    select.appendChild(option);
  });

  const workspaceName = workspaces.workspaces.find((ws) => ws.id === workspaces.activeId)?.name;
  const dashSubtitle = document.getElementById('dash-workspace-name');
  if (dashSubtitle && workspaceName) {
    dashSubtitle.textContent = `Workspace: ${workspaceName}`;
  }

  document.title = workspaceName ? `Dev Hub — ${workspaceName}` : 'Dev Hub';
  renderWorkspacePatOwner();
}

function renderWorkspacePatOwner() {
  const containerEl = document.getElementById('sidebar-user');
  const ownerEl = document.getElementById('workspace-pat-owner');
  const avatarEl = document.getElementById('sidebar-user-avatar');
  const dashUserEl = document.getElementById('dash-user-name');
  const owner = settings?.azure?.patOwner;
  const patConfigured = settings?.azure?.patConfigured;

  if (containerEl && ownerEl && avatarEl) {
    if (owner?.displayName) {
      ownerEl.textContent = owner.displayName;
      containerEl.title = owner.uniqueName
        ? `Azure DevOps: ${owner.uniqueName}`
        : 'Azure DevOps account';
      avatarEl.textContent = owner.displayName.trim().charAt(0).toUpperCase() || '?';
      containerEl.classList.remove('hidden');
    } else if (patConfigured) {
      ownerEl.textContent = 'Unknown user';
      containerEl.title = 'Open Settings and click Test Connection to refresh';
      avatarEl.textContent = '?';
      containerEl.classList.remove('hidden');
    } else {
      ownerEl.textContent = '';
      containerEl.title = '';
      avatarEl.textContent = '';
      containerEl.classList.add('hidden');
    }
  }

  if (!dashUserEl) return;

  if (owner?.displayName) {
    dashUserEl.textContent = `Signed in as ${owner.displayName}`;
    dashUserEl.title = owner.uniqueName || owner.displayName;
    dashUserEl.classList.remove('hidden');
    return;
  }

  if (patConfigured) {
    dashUserEl.textContent = 'Signed in with Azure DevOps PAT';
    dashUserEl.title = 'Open Settings and click Test Connection to refresh the signed-in user';
    dashUserEl.classList.remove('hidden');
    return;
  }

  dashUserEl.textContent = '';
  dashUserEl.title = '';
  dashUserEl.classList.add('hidden');
}

function renderAzurePatOwnerInSettings() {
  const ownerEl = document.getElementById('settings-azure-pat-owner');
  if (!ownerEl) return;

  const owner = settings?.azure?.patOwner;
  if (owner?.displayName) {
    ownerEl.textContent = `Signed in as ${owner.displayName}`;
    ownerEl.title = owner.uniqueName || owner.displayName;
    ownerEl.classList.remove('hidden');
    return;
  }

  if (settings?.azure?.patConfigured) {
    ownerEl.textContent = 'PAT is configured. Click Test Connection to refresh the signed-in user.';
    ownerEl.title = '';
    ownerEl.classList.remove('hidden');
    return;
  }

  ownerEl.textContent = '';
  ownerEl.title = '';
  ownerEl.classList.add('hidden');
}

function invalidateRepoCache() {
  repoScanFetchedAt = 0;
}

function applyRepoReleaseWarnings(repos, warnings) {
  const warningByPath = new Map(
    (warnings || []).map((entry) => [entry.repoPath, entry.warningCount]),
  );

  return repos.map((repo) => ({
    ...repo,
    warningCount: warningByPath.has(repo.path)
      ? warningByPath.get(repo.path)
      : (repo.warningCount ?? 0),
  }));
}

async function enrichRepoReleaseWarnings(repos, requestId = repoScanRequestId) {
  if (!repos.length || requestId !== repoScanRequestId) return repos;

  try {
    const result = await api.repos.scanReleaseWarnings(repos.map((repo) => repo.path));
    if (!result.ok || requestId !== repoScanRequestId) return repos;

    const enriched = applyRepoReleaseWarnings(repos, result.warnings);
    cachedRepos = enriched;
    repoScanFetchedAt = Date.now();
    renderProjectsSubmenu(enriched);

    if (document.getElementById('view-repos')?.classList.contains('active')) {
      renderLocalProjectsList(enriched);
    }

    if (document.getElementById('view-dashboard')?.classList.contains('active')) {
      renderDashboardProjectCards(enriched);
    }

    return enriched;
  } catch {
    return repos;
  }
}

async function fetchRepos({ force = false } = {}) {
  const hasFreshCache = !force
    && cachedRepos.length > 0
    && Date.now() - repoScanFetchedAt < REPO_SCAN_CACHE_MS;

  if (hasFreshCache) {
    return cachedRepos;
  }

  const requestId = ++repoScanRequestId;
  const repos = await api.repos.scan();
  if (requestId !== repoScanRequestId) {
    return cachedRepos;
  }

  cachedRepos = repos;
  repoScanFetchedAt = Date.now();
  renderProjectsSubmenu(repos);
  void enrichRepoReleaseWarnings(repos, requestId);
  return repos;
}

function renderDashboardProjectCards(repos) {
  const projectsGrid = document.getElementById('dash-projects');
  if (!projectsGrid) return;

  projectsGrid.innerHTML = '';

  if (repos.length === 0) {
    projectsGrid.appendChild(createDashboardProjectsEmptyState());
    return;
  }

  repos.forEach((repo) => {
    projectsGrid.appendChild(createProjectCard(repo, repo.project || {}));
  });
}

async function onWorkspaceChanged() {
  try {
    currentProject = null;
    invalidateRepoCache();
    await loadSettings();
    await loadWorkspaces();
    renderWorkspaceSwitcher();
    renderSettingsForm();
    renderLinks();
    renderClonePathFields();
    await refreshDashboard({ force: true });

    if (document.getElementById('view-project').classList.contains('active')) {
      showView('dashboard');
    }

    if (document.getElementById('view-repos').classList.contains('active')) {
      await loadProjectsPage({ force: true });
    }
    if (document.getElementById('view-tasks').classList.contains('active')) {
      await loadTasks();
    }
  } catch (err) {
    await reportError(err, 'Workspace');
  }
}

async function switchToWorkspace(id) {
  if (id === workspaces.activeId) return;

  const result = await api.workspaces.switch(id);
  if (!(await ensureApiOk(result, 'Workspace'))) return;

  commandBarProjectContext = null;
  updateCommandBarPlaceholder();
  await onWorkspaceChanged();
}

document.getElementById('workspace-select').addEventListener('change', async (e) => {
  await switchToWorkspace(e.target.value);
});

document.getElementById('workspace-new').addEventListener('click', () => {
  openWorkspaceModal();
});

const workspaceModal = document.getElementById('workspace-modal');
const workspaceModalName = document.getElementById('workspace-modal-name');
const workspaceModalError = document.getElementById('workspace-modal-error');

function openWorkspaceModal() {
  workspaceModalName.value = '';
  workspaceModalError.textContent = '';
  workspaceModalError.classList.add('hidden');
  workspaceModal.classList.remove('hidden');
  workspaceModalName.focus();
}

function closeWorkspaceModal() {
  workspaceModal.classList.add('hidden');
}

async function submitWorkspaceModal() {
  const name = workspaceModalName.value.trim();
  if (!name) {
    workspaceModalError.textContent = 'Enter a workspace name.';
    workspaceModalError.classList.remove('hidden');
    workspaceModalName.focus();
    return;
  }

  const createBtn = document.getElementById('workspace-modal-create');
  createBtn.disabled = true;

  try {
    const result = await api.workspaces.create(name);
    if (!(await ensureApiOk(result, 'Workspace'))) {
      workspaceModalError.textContent = formatErrorMessage(result.error);
      workspaceModalError.classList.remove('hidden');
      return;
    }

    closeWorkspaceModal();
    await onWorkspaceChanged();
  } catch (err) {
    workspaceModalError.textContent = formatErrorMessage(err);
    workspaceModalError.classList.remove('hidden');
    await reportError(err, 'Workspace');
  } finally {
    createBtn.disabled = false;
  }
}

document.getElementById('workspace-modal-cancel').addEventListener('click', closeWorkspaceModal);

document.getElementById('workspace-modal-create').addEventListener('click', submitWorkspaceModal);

workspaceModalName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitWorkspaceModal();
  }
  if (e.key === 'Escape') {
    closeWorkspaceModal();
  }
});

workspaceModal.addEventListener('click', (e) => {
  if (e.target === workspaceModal) {
    closeWorkspaceModal();
  }
});

document.getElementById('settings-workspace-rename').addEventListener('click', async () => {
  const statusEl = document.getElementById('settings-workspace-status');
  const name = document.getElementById('settings-workspace-name').value.trim();
  if (!name) {
    statusEl.textContent = 'Enter a workspace name.';
    statusEl.className = 'inline-status error';
    return;
  }

  const result = await api.workspaces.rename(settings.id, name);
  if (!(await ensureApiOk(result, 'Workspace'))) {
    statusEl.textContent = formatErrorMessage(result.error);
    statusEl.className = 'inline-status error';
    return;
  }

  await onWorkspaceChanged();
  statusEl.textContent = 'Renamed!';
  statusEl.className = 'inline-status ok';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
});

document.getElementById('settings-workspace-delete').addEventListener('click', async () => {
  const statusEl = document.getElementById('settings-workspace-status');
  const workspaceName = settings?.name || 'this workspace';

  if (!confirm(`Delete workspace "${workspaceName}"? This cannot be undone.`)) {
    return;
  }

  const result = await api.workspaces.delete(settings.id);
  if (!(await ensureApiOk(result, 'Workspace'))) {
    statusEl.textContent = formatErrorMessage(result.error);
    statusEl.className = 'inline-status error';
    return;
  }

  await onWorkspaceChanged();
});

// ── Clone path ────────────────────────────────────────────────────────────────

function getClonePath() {
  return settings?.clonePath || '';
}

function resolveTerminalCwd(explicitCwd) {
  if (explicitCwd) return explicitCwd;
  const clonePath = getClonePath();
  return clonePath || undefined;
}

function disposeTerminalSession(id, { recreateIfEmpty = true } = {}) {
  const index = terminalSessions.findIndex((s) => s.id === id);
  if (index === -1) return;

  const session = terminalSessions[index];
  const wasActive = activeTerminalId === id;

  session.dataCleanup?.();
  session.exitCleanup?.();
  session.dataCleanup = null;
  session.exitCleanup = null;

  void api.terminal.kill(id);
  session.term.dispose();
  session.tabEl.remove();
  session.pane.remove();
  terminalSessions.splice(index, 1);

  if (terminalSessions.length === 0) {
    activeTerminalId = null;
    if (recreateIfEmpty) {
      createTerminalSession();
    }
    return;
  }

  if (wasActive) {
    const nextIndex = Math.min(index, terminalSessions.length - 1);
    activateTerminal(terminalSessions[nextIndex].id);
  }
}

/** Recreate shells that use the workspace default cwd so they pick up a new clone path. */
function syncDefaultTerminalsToClonePath() {
  const defaults = terminalSessions.filter((s) => s.defaultCwd);
  if (defaults.length === 0) return;

  const count = defaults.length;
  const ids = defaults.map((s) => s.id);
  for (const id of ids) {
    disposeTerminalSession(id, { recreateIfEmpty: false });
  }
  for (let i = 0; i < count; i += 1) {
    createTerminalSession();
  }
}

function renderClonePathFields() {
  const clonePath = getClonePath();
  const projectsInput = document.getElementById('clone-path-input');
  const settingsInput = document.getElementById('settings-clone-path-input');

  if (projectsInput && document.activeElement !== projectsInput) {
    projectsInput.value = clonePath;
  }
  if (settingsInput && document.activeElement !== settingsInput) {
    settingsInput.value = clonePath;
  }

  void refreshClonePathWarnings();
}

function setFieldFeedback(el, message) {
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

async function validateClonePathValue(folderPath) {
  const trimmed = (folderPath || '').trim();
  if (!trimmed) {
    return '';
  }

  try {
    const result = await api.fs.checkDirectory(trimmed);
    if (result?.ok) return '';
    return result?.error || 'This folder does not exist.';
  } catch (err) {
    return formatErrorMessage(err) || 'Could not check this folder.';
  }
}

async function refreshClonePathWarnings({ projectsValue, settingsValue } = {}) {
  const projectsInput = document.getElementById('clone-path-input');
  const settingsInput = document.getElementById('settings-clone-path-input');
  const projectsWarning = document.getElementById('clone-path-warning');
  const settingsWarning = document.getElementById('settings-clone-path-warning');

  const projectsPath = projectsValue !== undefined
    ? projectsValue
    : (projectsInput?.value ?? getClonePath());
  const settingsPath = settingsValue !== undefined
    ? settingsValue
    : (settingsInput?.value ?? getClonePath());

  const [projectsMessage, settingsMessage] = await Promise.all([
    validateClonePathValue(projectsPath),
    validateClonePathValue(settingsPath),
  ]);

  setFieldFeedback(projectsWarning, projectsMessage);
  setFieldFeedback(settingsWarning, settingsMessage);
}

let clonePathWarningTimer = null;
function scheduleClonePathWarningCheck() {
  window.clearTimeout(clonePathWarningTimer);
  clonePathWarningTimer = window.setTimeout(() => {
    void refreshClonePathWarnings();
  }, 250);
}

async function saveClonePath(folderPath) {
  const trimmed = folderPath.trim();

  try {
    await api.settings.save({ clonePath: trimmed });
    await loadSettings();
    invalidateRepoCache();
    renderClonePathFields();
    syncDefaultTerminalsToClonePath();

    if (document.getElementById('view-repos').classList.contains('active')) {
      await loadProjectsPage({ force: true });
    } else {
      await fetchRepos({ force: true });
    }
    return true;
  } catch (err) {
    await reportError(err, 'Clone location');
    return false;
  }
}

async function pickCloneFolder({ saveTo = 'projects' } = {}) {
  const result = await api.dialog.pickFolder();
  if (!result.ok) return false;

  if (saveTo === 'settings') {
    document.getElementById('settings-clone-path-input').value = result.path;
    return saveClonePath(result.path);
  }

  document.getElementById('clone-path-input').value = result.path;
  return saveClonePath(result.path);
}

// ── Settings ────────────────────────────────────────────────────────────────

async function loadSettings() {
  settings = await api.settings.get();
  renderWorkspacePatOwner();
  renderAzurePatOwnerInSettings();
  return settings;
}

function renderSettingsForm() {
  renderClonePathFields();
  document.getElementById('settings-workspace-name').value = settings?.name || '';
  document.getElementById('settings-azure-org').value =
    settings.azure?.organization || '';
  document.getElementById('settings-azure-project').value =
    settings.azure?.project || '';
  document.getElementById('settings-azure-pat').placeholder =
    settings.azure?.patConfigured ? '••••••••  (configured — leave blank to keep)' : 'Enter your PAT';
  renderAzurePatOwnerInSettings();
}

document.getElementById('clone-path-input').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    await saveClonePath(e.target.value);
  }
});

document.getElementById('clone-path-input').addEventListener('blur', async (e) => {
  if (e.relatedTarget?.id === 'clone-path-browse') return;
  const value = e.target.value.trim();
  if (value === getClonePath()) return;
  await saveClonePath(value);
});

document.getElementById('clone-path-input').addEventListener('input', () => {
  scheduleClonePathWarningCheck();
});

document.getElementById('settings-clone-path-input').addEventListener('input', () => {
  scheduleClonePathWarningCheck();
});

document.getElementById('clone-path-browse').addEventListener('click', async () => {
  await pickCloneFolder({ saveTo: 'projects' });
});

document.getElementById('settings-clone-path-browse').addEventListener('click', async () => {
  await pickCloneFolder({ saveTo: 'settings' });
});

document.getElementById('settings-save').addEventListener('click', async () => {
  const statusEl = document.getElementById('settings-save-status');

  try {
    const payload = {
      clonePath: document.getElementById('settings-clone-path-input').value.trim(),
      azure: {
        organization: document.getElementById('settings-azure-org').value.trim(),
        project: document.getElementById('settings-azure-project').value.trim(),
      },
    };

    const pat = document.getElementById('settings-azure-pat').value.trim();
    if (pat) payload.azure.pat = pat;

    await api.settings.save(payload);
    await loadSettings();
    renderSettingsForm();
    renderLinks();
    syncDefaultTerminalsToClonePath();

    if (document.getElementById('view-repos').classList.contains('active')) {
      await loadProjectsPage();
    }

    statusEl.textContent = 'Saved!';
    statusEl.className = 'inline-status ok';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = formatErrorMessage(err);
    statusEl.className = 'inline-status error';
    await reportError(err, 'Settings');
  }
});

document.getElementById('settings-azure-test').addEventListener('click', async () => {
  const statusEl = document.getElementById('settings-azure-status');
  statusEl.textContent = 'Testing…';
  statusEl.className = 'inline-status';

  const pat = document.getElementById('settings-azure-pat').value.trim();
  if (pat) {
    await api.settings.save({
      azure: {
        organization: document.getElementById('settings-azure-org').value.trim(),
        project: document.getElementById('settings-azure-project').value.trim(),
        pat,
      },
    });
  }

  const result = await api.azure.testConnection();
  if (result.ok) {
    await loadSettings();
    const ownerLabel = result.patOwner ? ` as ${result.patOwner}` : '';
    statusEl.textContent = `Connected to "${result.projectName}"${ownerLabel}`;
    statusEl.className = 'inline-status ok';
  } else {
    statusEl.textContent = formatErrorMessage(result.error);
    statusEl.className = 'inline-status error';
    await reportError(result.error, 'Azure DevOps connection');
  }
});

// ── Terminal ──────────────────────────────────────────────────────────────────

function createTerminalSession(cwd) {
  const id = `term-${++terminalCounter}`;
  const usesDefaultCwd = !cwd;
  const sessionCwd = resolveTerminalCwd(cwd);
  const tabsEl = document.getElementById('terminal-tabs');
  const containerEl = document.getElementById('terminal-container');

  const tabEl = document.createElement('div');
  tabEl.className = 'terminal-tab';
  tabEl.dataset.id = id;

  const tabLabel = document.createElement('span');
  tabLabel.className = 'terminal-tab-label';
  tabLabel.textContent = `Shell ${terminalCounter}`;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'terminal-tab-close';
  closeBtn.title = 'Close tab';
  closeBtn.setAttribute('aria-label', 'Close tab');
  closeBtn.textContent = '✕';

  tabEl.appendChild(tabLabel);
  tabEl.appendChild(closeBtn);

  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.id = `pane-${id}`;

  tabsEl.appendChild(tabEl);
  containerEl.appendChild(pane);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: 14,
    theme: {
      background: '#000000',
      foreground: '#e2e8f0',
      cursor: '#6366f1',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
    api.shell.openExternal(uri);
  });

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(pane);

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 'q') {
      focusCommandBar();
      return false;
    }
    return true;
  });

  const session = {
    id,
    term,
    fitAddon,
    pane,
    tabEl,
    defaultCwd: usesDefaultCwd,
    dataCleanup: null,
    exitCleanup: null,
  };

  api.terminal.create({ id, cwd: sessionCwd }).then(async (result) => {
    if (!result?.ok) {
      const message = result?.error || 'Could not start shell';
      await reportError(message, 'Terminal');
      term.write(`\r\n\r\n[Failed to start shell: ${formatErrorMessage(message)}]\r\n`);
      return;
    }

    session.dataCleanup = api.terminal.onData(id, (data) => term.write(data));
    session.exitCleanup = api.terminal.onExit(id, () => {
      term.write('\r\n\r\n[Process exited]\r\n');
    });
    term.onData((data) => api.terminal.input(id, data));
    fitAddon.fit();
  }).catch(async (err) => {
    await reportError(err, 'Terminal');
    term.write(`\r\n\r\n[Failed to start shell: ${formatErrorMessage(err)}]\r\n`);
  });

  tabEl.addEventListener('click', (e) => {
    if (!e.target.closest('.terminal-tab-close')) {
      activateTerminal(id);
    }
  });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTerminalSession(id);
  });
  terminalSessions.push(session);
  activateTerminal(id);
  if (document.getElementById('view-terminal').classList.contains('active')) {
    window.setTimeout(() => term.focus(), 50);
  }
  return session;
}

function closeTerminalSession(id) {
  disposeTerminalSession(id, { recreateIfEmpty: true });
}

function activateTerminal(id) {
  activeTerminalId = id;
  terminalSessions.forEach((s) => {
    s.tabEl.classList.toggle('active', s.id === id);
    s.pane.classList.toggle('active', s.id === id);
  });
  const session = terminalSessions.find((s) => s.id === id);
  if (session) {
    setTimeout(() => {
      try {
        session.fitAddon.fit();
      } catch {
        // Ignore while the pane is still settling.
      }
    }, 50);
  }
}

function resizeActiveTerminal() {
  const session = terminalSessions.find((s) => s.id === activeTerminalId);
  if (!session?.pane?.offsetParent) return;

  try {
    session.fitAddon.fit();
    api.terminal.resize(session.id, session.term.cols, session.term.rows);
  } catch {
    // Ignore resize errors while the layout is settling.
  }
}

document.getElementById('terminal-new').addEventListener('click', () => {
  createTerminalSession();
});

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (document.getElementById('view-terminal').classList.contains('active')) {
      resizeActiveTerminal();
    }
  }, 100);
});

// ── Repositories ──────────────────────────────────────────────────────────────

function createLocalRepoItem(repo) {
  const item = document.createElement('div');
  item.className = 'repo-item repo-item-local';
  item.innerHTML = `
    <div class="repo-item-main">
      <div class="repo-name-row">
        <div class="repo-name">${escapeHtml(repo.name)}</div>
      </div>
      <div class="repo-path">${escapeHtml(repo.path)}</div>
    </div>
    <div class="repo-actions">
      <button type="button" class="btn btn-ghost btn-repo-action open-project" title="Open project">Open</button>
      <button type="button" class="btn btn-ghost btn-repo-action open-folder" title="Open folder">📁</button>
      <button type="button" class="btn btn-ghost btn-repo-action delete-project" title="Delete project">✕</button>
    </div>`;

  const nameRow = item.querySelector('.repo-name-row');
  nameRow.appendChild(createBranchBadge(repo.branch));

  if (repo.dirty) {
    const dirtyBadge = document.createElement('span');
    dirtyBadge.className = 'badge dirty';
    dirtyBadge.textContent = 'modified';
    nameRow.appendChild(dirtyBadge);
  }

  const summary = repo.project || getSummaryForRepo({}, repo.path);
  if (summary.openTodos > 0) {
    const todoBadge = document.createElement('span');
    todoBadge.className = 'project-todo-count badge';
    todoBadge.textContent = `${summary.openTodos} to-do${summary.openTodos === 1 ? '' : 's'}`;
    nameRow.appendChild(todoBadge);
  }

  item.querySelector('.open-project').addEventListener('click', (e) => {
    e.stopPropagation();
    openProject(repo);
  });

  item.querySelector('.open-folder').addEventListener('click', (e) => {
    e.stopPropagation();
    api.shell.openPath(repo.path);
  });

  item.querySelector('.delete-project').addEventListener('click', (e) => {
    e.stopPropagation();
    deleteLocalProject(repo);
  });

  return item;
}

async function deleteLocalProject(repo) {
  const { confirmed } = await api.dialog.showConfirm({
    title: 'Delete local project',
    message: `Delete "${repo.name}" from Dev Hub and Windows?`,
    detail: `This will permanently delete the folder from your computer:\n${repo.path}\n\nThe project will be removed from Dev Hub. The remote repository on Azure DevOps is not affected.`,
    confirmLabel: 'Delete',
  });

  if (!confirmed) return;

  try {
    const result = await api.repos.delete(repo.path);
    if (!(await ensureApiOk(result, 'Delete project'))) return;

    if (currentProject?.path === repo.path) {
      currentProject = null;
      showView('repos');
    }

    invalidateRepoCache();
    await loadProjectsPage({ force: true });
    await refreshDashboard({ force: true });
  } catch (err) {
    await reportError(err, 'Delete project');
  }
}

function renderLocalProjectsList(repos) {
  const listEl = document.getElementById('local-repos-list');

  if (repos.length === 0) {
    const clonePath = getClonePath();
    listEl.innerHTML = `
      <p class="empty-state">
        ${!clonePath
          ? 'No local projects yet. Set where to clone repositories above, then clone a remote repository.'
          : 'No local projects found in this folder. Clone a remote repository to get started.'}
      </p>`;
    return;
  }

  listEl.innerHTML = '';
  repos.forEach((repo) => {
    listEl.appendChild(createLocalRepoItem(repo));
  });
}

function setRemoteReposStatus(message, tone = '') {
  const statusEl = document.getElementById('remote-repos-status');
  if (!message) {
    statusEl.textContent = '';
    statusEl.className = 'projects-panel-status hidden';
    return;
  }

  statusEl.textContent = message;
  statusEl.className = `projects-panel-status${tone ? ` ${tone}` : ''}`;
}

function createRemoteRepoItem(remoteRepo, { organization, project }) {
  const item = document.createElement('div');
  item.className = `repo-item remote-repo-item repo-item-static${remoteRepo.isLocal ? ' is-cloned' : ''}`;
  const subtitle = `${organization} / ${project}`;

  const badges = '<span class="badge badge-remote">Remote</span>';
  const clonedBadge = remoteRepo.isLocal ? '<span class="badge badge-cloned">Cloned</span>' : '';

  item.innerHTML = `
    <div>
      <div class="repo-name-row">
        <div class="repo-name">${escapeHtml(remoteRepo.name)}</div>
        ${badges}
        ${clonedBadge}
      </div>
      <div class="repo-path">${escapeHtml(subtitle)}</div>
    </div>
    <div class="repo-meta"></div>
    <div class="repo-actions"></div>`;

  const actionsEl = item.querySelector('.repo-actions');

  const cloneBtn = document.createElement('button');
  cloneBtn.type = 'button';
  cloneBtn.className = 'btn btn-primary clone-remote-repo';
  cloneBtn.textContent = 'Clone';
  if (remoteRepo.isLocal) {
    cloneBtn.disabled = true;
    cloneBtn.title = 'Already cloned on this machine';
  } else {
    cloneBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await cloneRemoteRepository(remoteRepo, cloneBtn);
    });
  }
  actionsEl.appendChild(cloneBtn);

  if (remoteRepo.webUrl) {
    const webBtn = document.createElement('button');
    webBtn.type = 'button';
    webBtn.className = 'btn btn-ghost';
    webBtn.title = 'Open in Azure DevOps';
    webBtn.textContent = '↗';
    webBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      api.shell.openExternal(remoteRepo.webUrl);
    });
    actionsEl.appendChild(webBtn);
  }

  return item;
}

function formatCloneProgressMessage(progress) {
  if (!progress) return 'Cloning…';

  const parts = [progress.label || 'Cloning'];
  if (Number.isFinite(progress.percent)) {
    parts[0] = `${parts[0]} — ${progress.percent}%`;
  }
  if (progress.detail) {
    parts.push(progress.detail);
  }
  return parts.join(' · ');
}

function ensureCloneProgressElement(itemEl) {
  let progressEl = itemEl.querySelector('.clone-progress');
  if (progressEl) return progressEl;

  progressEl = document.createElement('div');
  progressEl.className = 'clone-progress';
  progressEl.innerHTML = `
    <div class="clone-progress-track">
      <div class="clone-progress-fill"></div>
    </div>
    <p class="clone-progress-label"></p>
  `;
  itemEl.appendChild(progressEl);
  return progressEl;
}

function updateCloneProgressUi(itemEl, progress) {
  const progressEl = ensureCloneProgressElement(itemEl);
  const trackEl = progressEl.querySelector('.clone-progress-track');
  const fillEl = progressEl.querySelector('.clone-progress-fill');
  const labelEl = progressEl.querySelector('.clone-progress-label');
  const indeterminate = progress?.indeterminate || !Number.isFinite(progress?.percent);

  trackEl.classList.toggle('is-indeterminate', indeterminate);
  if (indeterminate) {
    fillEl.style.width = '';
  } else {
    fillEl.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
  }

  labelEl.textContent = formatCloneProgressMessage(progress);
  progressEl.classList.remove('hidden');
}

function clearCloneProgressUi(itemEl) {
  const progressEl = itemEl?.querySelector('.clone-progress');
  if (progressEl) {
    progressEl.remove();
  }
}

async function cloneRemoteRepository(remoteRepo, buttonEl) {
  const clonePath = getClonePath();
  if (!clonePath) {
    await reportError(
      'Choose where to clone repositories on the Projects page.',
      'Clone repository',
    );
    return;
  }

  const itemEl = buttonEl.closest('.remote-repo-item');
  const originalLabel = buttonEl.textContent;
  const cloneId = crypto.randomUUID();
  buttonEl.disabled = true;
  buttonEl.textContent = 'Cloning…';
  updateCloneProgressUi(itemEl, { label: 'Starting clone', percent: 0, indeterminate: false });
  setRemoteReposStatus(`Cloning "${remoteRepo.name}"…`, 'warning');

  const unsubscribe = api.repos.onCloneProgress(cloneId, (progress) => {
    updateCloneProgressUi(itemEl, progress);
    setRemoteReposStatus(`Cloning "${remoteRepo.name}" — ${formatCloneProgressMessage(progress)}`, 'warning');
  });

  try {
    const result = await api.repos.clone({
      remoteUrl: remoteRepo.remoteUrl,
      repoName: remoteRepo.name,
      targetParent: clonePath,
      cloneId,
    });

    if (!(await ensureApiOk(result, 'Clone repository'))) {
      setRemoteReposStatus(`Failed to clone "${remoteRepo.name}"`, 'error');
      return;
    }

    setRemoteReposStatus(`Cloned "${remoteRepo.name}" to ${result.path}`, 'ok');
    invalidateRepoCache();
    await loadProjectsPage({ force: true });
    const repos = await fetchRepos({ force: true });
    const cloned = repos.find((repo) => repo.path === result.path);
    if (cloned) {
      openProject(cloned);
    }
  } catch (err) {
    setRemoteReposStatus(`Failed to clone "${remoteRepo.name}"`, 'error');
    await reportError(err, 'Clone repository');
  } finally {
    unsubscribe();
    clearCloneProgressUi(itemEl);
    buttonEl.disabled = false;
    buttonEl.textContent = originalLabel;
  }
}

async function loadRemoteRepos(localRepos = null) {
  const listEl = document.getElementById('remote-repos-list');
  listEl.innerHTML = '<p class="empty-state">Loading remote repositories…</p>';
  setRemoteReposStatus('');

  try {
    const result = await api.azure.listRepositories(localRepos);

    if (!result.ok) {
      listEl.innerHTML = `<p class="empty-state">${escapeHtml(result.error)}</p>`;
      setRemoteReposStatus(result.error, 'error');
      return;
    }

    const { repositories, organization, project } = result;
    const remoteCount = repositories.filter((repo) => !repo.isLocal).length;
    const localCount = repositories.filter((repo) => repo.isLocal).length;
    setRemoteReposStatus(
      `${repositories.length} repositories in ${organization}/${project} · ${localCount} local · ${remoteCount} available to clone`,
      'ok',
    );

    if (repositories.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No Git repositories found in this Azure DevOps project.</p>';
      return;
    }

    listEl.innerHTML = '';
    repositories.forEach((remoteRepo) => {
      listEl.appendChild(createRemoteRepoItem(remoteRepo, { organization, project }));
    });
  } catch (err) {
    listEl.innerHTML = '<p class="empty-state">Could not load remote repositories.</p>';
    setRemoteReposStatus(formatErrorMessage(err), 'error');
    await reportError(err, 'Remote repositories');
  }
}

async function loadLocalProjects({ force = false } = {}) {
  const listEl = document.getElementById('local-repos-list');
  listEl.innerHTML = '<p class="empty-state">Scanning local repositories…</p>';

  try {
    const repos = await fetchRepos({ force });
    renderLocalProjectsList(repos);
    return repos;
  } catch (err) {
    listEl.innerHTML = '<p class="empty-state">Could not scan local repositories.</p>';
    await reportError(err, 'Local projects');
    return [];
  }
}

async function loadProjectsPage({ preferCache = false, force = false } = {}) {
  if (preferCache && cachedRepos.length > 0 && !force) {
    renderLocalProjectsList(cachedRepos);
    void loadRemoteRepos(cachedRepos);
    void fetchRepos({ force }).then((repos) => {
      renderLocalProjectsList(repos);
      loadRemoteRepos(repos);
    });
    return;
  }

  const repos = await loadLocalProjects({ force });
  await loadRemoteRepos(repos);
}

async function loadRepos() {
  return loadLocalProjects();
}

async function runRefreshButton(button, task) {
  if (!button || button.disabled) return;

  button.disabled = true;
  button.classList.add('spinning');

  try {
    await task();
  } finally {
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

document.getElementById('repos-refresh').addEventListener('click', (e) => {
  runRefreshButton(e.currentTarget, () => loadProjectsPage({ force: true }));
});

document.getElementById('remote-repos-refresh').addEventListener('click', (e) => {
  runRefreshButton(e.currentTarget, loadRemoteRepos);
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

function renderTaskRows(container, tasks, {
  limit = null,
  emptyMessage = 'No open tasks',
  titleMaxLength = 64,
} = {}) {
  const visibleTasks = limit ? tasks.slice(0, limit) : tasks;
  container.innerHTML = '';

  if (visibleTasks.length === 0) {
    container.innerHTML = `<li class="empty">${escapeHtml(emptyMessage)}</li>`;
    return;
  }

  visibleTasks.forEach((task) => {
    const fullTitle = task.title || '';
    const displayTitle = titleMaxLength ? truncateText(fullTitle, titleMaxLength) : fullTitle;
    const item = document.createElement('li');
    item.className = 'dash-task-row';
    item.innerHTML = `
      <a href="#" class="dash-task-link dash-task-id">#${escapeHtml(String(task.id))}</a>
      <span class="badge dash-task-state">${escapeHtml(task.state)}</span>
      <span class="dash-task-creator">${escapeHtml(task.creator)}</span>
      <a href="#" class="dash-task-link dash-task-title" title="${escapeHtml(fullTitle)}">${escapeHtml(displayTitle)}</a>`;

    item.querySelectorAll('.dash-task-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        api.shell.openExternal(task.url);
      });
    });

    container.appendChild(item);
  });
}

async function loadTasks() {
  const listEl = document.getElementById('tasks-list');
  const statusEl = document.getElementById('tasks-status');

  listEl.innerHTML = '<li class="empty">Loading tasks…</li>';
  statusEl.classList.add('hidden');

  try {
    const result = await api.azure.fetchTasks();

    if (!(await ensureApiOk(result, 'Tasks'))) {
      listEl.innerHTML = '';
      statusEl.textContent = formatErrorMessage(result.error);
      statusEl.classList.remove('hidden');
      statusEl.classList.remove('info');
      return [];
    }

    renderTaskRows(listEl, result.tasks, {
      emptyMessage: 'No open tasks assigned to you.',
    });

    return result.tasks;
  } catch (err) {
    listEl.innerHTML = '';
    statusEl.textContent = formatErrorMessage(err);
    statusEl.classList.remove('hidden');
    statusEl.classList.remove('info');
    await reportError(err, 'Tasks');
    return [];
  }
}

document.getElementById('tasks-refresh').addEventListener('click', (e) => {
  runRefreshButton(e.currentTarget, loadTasks);
});

// ── Quick Links ─────────────────────────────────────────────────────────────────

function renderLinks() {
  const grid = document.getElementById('links-grid');
  const links = settings?.links || [];

  if (links.length === 0) {
    grid.innerHTML = '<p class="empty-state">No links yet. Click "Add Link" to create one.</p>';
    return;
  }

  grid.innerHTML = '';
  links.forEach((link, index) => {
    const card = document.createElement('div');
    card.className = 'link-card';
    card.innerHTML = `
      <span class="link-icon">${link.icon || '🔗'}</span>
      <span class="link-name">${escapeHtml(link.name)}</span>
      <span class="link-url">${escapeHtml(link.url)}</span>`;
    card.addEventListener('click', () => api.shell.openExternal(link.url));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm(`Remove "${link.name}"?`)) {
        const updated = links.filter((_, i) => i !== index);
        api.settings.save({ links: updated }).then(async () => {
          await loadSettings();
          renderLinks();
        });
      }
    });
    grid.appendChild(card);
  });
}

document.getElementById('links-add').addEventListener('click', openLinkModal);

const linkModal = document.getElementById('link-modal');
const linkModalName = document.getElementById('link-modal-name');
const linkModalUrl = document.getElementById('link-modal-url');
const linkModalIcon = document.getElementById('link-modal-icon');
const linkModalError = document.getElementById('link-modal-error');

function openLinkModal() {
  linkModalName.value = '';
  linkModalUrl.value = '';
  linkModalIcon.value = '';
  linkModalError.textContent = '';
  linkModalError.classList.add('hidden');
  linkModal.classList.remove('hidden');
  linkModalName.focus();
}

function closeLinkModal() {
  linkModal.classList.add('hidden');
}

async function submitLinkModal() {
  const name = linkModalName.value.trim();
  const url = linkModalUrl.value.trim();
  const icon = linkModalIcon.value.trim() || '🔗';

  if (!name) {
    linkModalError.textContent = 'Enter a link name.';
    linkModalError.classList.remove('hidden');
    linkModalName.focus();
    return;
  }

  if (!url) {
    linkModalError.textContent = 'Enter a URL.';
    linkModalError.classList.remove('hidden');
    linkModalUrl.focus();
    return;
  }

  const saveBtn = document.getElementById('link-modal-save');
  saveBtn.disabled = true;

  try {
    const links = [...(settings?.links || []), { name, url, icon }];
    await api.settings.save({ links });
    await loadSettings();
    renderLinks();
    closeLinkModal();
  } catch (err) {
    linkModalError.textContent = formatErrorMessage(err);
    linkModalError.classList.remove('hidden');
    await reportError(err, 'Quick links');
  } finally {
    saveBtn.disabled = false;
  }
}

document.getElementById('link-modal-cancel').addEventListener('click', closeLinkModal);
document.getElementById('link-modal-save').addEventListener('click', submitLinkModal);

linkModal.addEventListener('click', (e) => {
  if (e.target === linkModal) {
    closeLinkModal();
  }
});

linkModalName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    linkModalUrl.focus();
  }
  if (e.key === 'Escape') {
    closeLinkModal();
  }
});

linkModalUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitLinkModal();
  }
  if (e.key === 'Escape') {
    closeLinkModal();
  }
});

linkModalIcon.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitLinkModal();
  }
  if (e.key === 'Escape') {
    closeLinkModal();
  }
});

// ── Dashboard ───────────────────────────────────────────────────────────────────

function createDashboardProjectsEmptyState() {
  const guide = document.createElement('div');
  guide.className = 'dashboard-projects-empty';
  guide.innerHTML = `
    <div class="dashboard-projects-empty-icon" aria-hidden="true"><img src="../assets/icon.svg" alt="" width="40" height="40"></div>
    <h3>Start your first project</h3>
    <p class="hint">Browse remote repositories from Azure DevOps and clone one to begin working locally.</p>
    <button type="button" class="btn btn-primary dashboard-start-projects">Go to Projects</button>`;

  guide.querySelector('.dashboard-start-projects').addEventListener('click', () => {
    navigateToView('repos', { focusContent: true });
  });

  return guide;
}

async function refreshDashboard({ preferCache = false, force = false } = {}) {
  if (preferCache && cachedRepos.length > 0 && !force) {
    document.getElementById('dash-repo-count').textContent = cachedRepos.length;
    renderDashboardProjectCards(cachedRepos);
    void refreshDashboard({ force });
    return;
  }

  const repos = await fetchRepos({ force });
  document.getElementById('dash-repo-count').textContent = repos.length;
  renderDashboardProjectCards(repos);

  const taskResult = await api.azure.fetchTasks();
  const tasks = taskResult.ok ? taskResult.tasks : [];
  document.getElementById('dash-task-count').textContent = taskResult.ok ? tasks.length : '—';

  const tasksList = document.getElementById('dash-tasks');
  if (!taskResult.ok) {
    tasksList.innerHTML = `<li class="empty">${escapeHtml(taskResult.error)}</li>`;
  } else {
    renderTaskRows(tasksList, tasks, {
      limit: 5,
      emptyMessage: 'No open tasks',
      titleMaxLength: null,
    });
  }
}

document.getElementById('dashboard-refresh').addEventListener('click', (e) => {
  runRefreshButton(e.currentTarget, () => refreshDashboard({ force: true }));
});

// ── Helpers ─────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatRemoteUrlForDisplay(remote) {
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

function truncateText(text, maxLength = 64) {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

async function openInIde(ide, repoPath) {
  const result = await api.ide.open(ide, repoPath);
  await ensureApiOk(result, 'Could not open IDE');
}

function createBranchBadge(branch) {
  const badge = document.createElement('span');
  badge.className = 'badge badge-branch';
  badge.title = 'Current branch';
  badge.textContent = branch ? `\u2387 ${branch}` : '\u2387 unknown';
  return badge;
}

async function pullProjectRepo(repo, button, lastPullEl, branchSelect, branchState) {
  button.disabled = true;
  button.classList.add('spinning');

  try {
    const result = await api.repos.pull(repo.path);

    if (!(await ensureApiOk(result, 'Git pull failed'))) {
      return;
    }

    if (lastPullEl) {
      lastPullEl.textContent = formatLastPull(result.lastPullAt);
    }

    if (branchSelect && result.branches) {
      populateBranchSelect(branchSelect, result.branches, result.repo?.branch || branchState.current);
      branchState.current = result.repo?.branch || branchState.current;
    }

    invalidateRepoCache();
    const repos = await fetchRepos({ force: true });
    const updatedRepo = repos.find((r) => r.path === repo.path) || result.repo;
    currentProject = updatedRepo;

    await renderProjectGitActivity(repo.path, { quiet: true });
    await renderProjectPullRequests(updatedRepo, { quiet: true });
    await renderProjectReadme(repo.path, { quiet: true });

    const reportStatus = gitHistoryReportStatusFromResult(result.gitHistoryReport);
    if (reportStatus) {
      updateGitHistoryReportWidget(updatedRepo, reportStatus);
    } else {
      await regenerateGitHistoryReportForProject(updatedRepo, { quiet: true });
    }

    const remoteUrl = document.querySelector('.project-remote-url');
    if (remoteUrl && updatedRepo.remote) {
      const displayRemote = formatRemoteUrlForDisplay(updatedRepo.remote);
      remoteUrl.textContent = displayRemote;
      remoteUrl.title = displayRemote;
      remoteUrl.classList.remove('empty');
    }

    const releaseEl = document.querySelector('.project-release-branch');
    if (releaseEl) {
      if (updatedRepo.lastReleaseBranch) {
        releaseEl.textContent = updatedRepo.lastReleaseBranch;
        releaseEl.classList.remove('empty');
      } else {
        releaseEl.textContent = 'No release branch found';
        releaseEl.classList.add('empty');
      }
    }

    void refreshDashboard({ preferCache: true });
  } catch (err) {
    await reportError(err, 'Git pull failed');
  } finally {
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

function formatLastPull(iso) {
  if (!iso) return 'Last pull: Never';
  return `Last pull: ${new Date(iso).toLocaleString()}`;
}

function populateBranchSelect(select, branchResult, currentBranch) {
  select.innerHTML = '';
  const hasBranches = branchResult.local.length > 0 || branchResult.remoteOnly.length > 0;

  if (branchResult.local.length > 0) {
    const localGroup = document.createElement('optgroup');
    localGroup.label = 'Local';
    branchResult.local.forEach((branch) => {
      const option = document.createElement('option');
      option.value = branch;
      option.textContent = branch;
      option.selected = branch === currentBranch;
      localGroup.appendChild(option);
    });
    select.appendChild(localGroup);
  }

  if (branchResult.remoteOnly.length > 0) {
    const remoteGroup = document.createElement('optgroup');
    remoteGroup.label = 'Remote';
    branchResult.remoteOnly.forEach(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      remoteGroup.appendChild(option);
    });
    select.appendChild(remoteGroup);
  }

  if (!hasBranches) {
    const option = document.createElement('option');
    option.textContent = currentBranch || 'unknown';
    select.appendChild(option);
    select.disabled = true;
  } else {
    select.disabled = false;
  }
}

async function createProjectMetaWidget(repo, projectData, renderContext = {}) {
  const { renderId, openId } = renderContext;
  const widget = document.createElement('div');
  widget.className = 'project-info-widget';

  const remoteLabel = document.createElement('span');
  remoteLabel.className = 'project-info-label project-info-label-remote';
  remoteLabel.textContent = 'Remote';

  const remoteContent = document.createElement('div');
  remoteContent.className = 'project-remote-row';

  const syncWrap = document.createElement('div');
  syncWrap.className = 'project-sync-inline';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn-ghost btn-icon refresh-btn';
  refreshBtn.title = 'Pull latest changes and refresh git history report';
  refreshBtn.setAttribute('aria-label', 'Pull latest changes and refresh git history report');
  refreshBtn.textContent = '↻';

  const lastPullEl = document.createElement('span');
  lastPullEl.className = 'project-last-pull';
  lastPullEl.textContent = formatLastPull(projectData.lastPullAt);

  syncWrap.appendChild(refreshBtn);
  syncWrap.appendChild(lastPullEl);

  const displayRemote = formatRemoteUrlForDisplay(repo.remote);

  const remoteUrl = document.createElement('span');
  remoteUrl.className = 'project-info-value project-remote-url';
  remoteUrl.textContent = displayRemote || 'No remote configured';
  if (!displayRemote) {
    remoteUrl.classList.add('empty');
  } else {
    remoteUrl.title = displayRemote;
  }

  remoteContent.appendChild(remoteUrl);
  remoteContent.appendChild(syncWrap);

  const branchLabel = document.createElement('span');
  branchLabel.className = 'project-info-label project-info-label-branch';
  branchLabel.textContent = 'Branch';

  const branchSelect = document.createElement('select');
  branchSelect.className = 'branch-select';
  branchSelect.disabled = true;

  const releaseLabel = document.createElement('span');
  releaseLabel.className = 'project-info-label';
  releaseLabel.textContent = 'Last Release';

  const releaseBranch = document.createElement('span');
  releaseBranch.className = 'project-info-value project-release-branch';
  if (repo.lastReleaseBranch) {
    releaseBranch.textContent = repo.lastReleaseBranch;
  } else {
    releaseBranch.textContent = 'No release branch found';
    releaseBranch.classList.add('empty');
  }

  widget.appendChild(remoteLabel);
  widget.appendChild(remoteContent);
  widget.appendChild(branchLabel);
  widget.appendChild(branchSelect);
  widget.appendChild(releaseLabel);
  widget.appendChild(releaseBranch);

  const branchResult = await api.repos.listBranches(repo.path, false);
  if (renderId != null && !isProjectRenderCurrent(renderId, openId)) {
    return widget;
  }

  const branchState = { current: repo.branch };
  let suppressBranchChange = true;

  if (!branchResult.ok) {
    branchSelect.innerHTML = '';
    const option = document.createElement('option');
    option.textContent = repo.branch || 'unknown';
    branchSelect.appendChild(option);
  } else {
    branchState.current = branchResult.current;
    populateBranchSelect(branchSelect, branchResult, branchResult.current);
    branchSelect.value = branchResult.current;
  }

  refreshBtn.addEventListener('click', () =>
    pullProjectRepo(repo, refreshBtn, lastPullEl, branchSelect, branchState));

  branchSelect.addEventListener('change', async () => {
    if (suppressBranchChange) return;

    const targetBranch = branchSelect.value;
    const previousBranch = branchState.current;
    if (!targetBranch || targetBranch === previousBranch) return;

    branchSelect.disabled = true;

    try {
      const checkoutResult = await api.repos.checkout(repo.path, targetBranch);

      if (!(await ensureApiOk(checkoutResult, 'Could not switch branch'))) {
        branchSelect.disabled = false;
        branchSelect.value = previousBranch;
        return;
      }

      branchState.current = checkoutResult.branch;
      const updatedRepo = checkoutResult.repo || { ...repo, branch: checkoutResult.branch };
      currentProject = updatedRepo;

      if (checkoutResult.branches) {
        suppressBranchChange = true;
        populateBranchSelect(branchSelect, checkoutResult.branches, checkoutResult.branch);
        branchSelect.value = checkoutResult.branch;
        suppressBranchChange = false;
      } else {
        const branchesResult = await api.repos.listBranches(repo.path, false);
        if (branchesResult.ok) {
          suppressBranchChange = true;
          populateBranchSelect(branchSelect, branchesResult, checkoutResult.branch);
          branchSelect.value = checkoutResult.branch;
          suppressBranchChange = false;
        }
      }

      invalidateRepoCache();
      await fetchRepos({ force: true });

      await Promise.all([
        renderProjectGitActivity(repo.path, { quiet: true }),
        renderProjectPullRequests(updatedRepo, { quiet: true }),
      ]);
      void refreshDashboard({ preferCache: true });
    } catch (err) {
      branchSelect.disabled = false;
      branchSelect.value = previousBranch;
      await reportError(err, 'Could not switch branch');
    } finally {
      branchSelect.disabled = false;
    }
  });

  suppressBranchChange = false;

  return widget;
}

function createIdeButtons(repoPath) {
  const wrap = document.createElement('div');
  wrap.className = 'repo-ide-buttons';

  const vscodeBtn = document.createElement('button');
  vscodeBtn.type = 'button';
  vscodeBtn.className = 'btn btn-ghost btn-ide';
  vscodeBtn.title = 'Open in Visual Studio Code';
  vscodeBtn.textContent = 'VS Code';
  vscodeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openInIde('vscode', repoPath);
  });

  const vsBtn = document.createElement('button');
  vsBtn.type = 'button';
  vsBtn.className = 'btn btn-ghost btn-ide';
  vsBtn.title = 'Open in Visual Studio';
  vsBtn.textContent = 'VS';
  vsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openInIde('visualstudio', repoPath);
  });

  wrap.appendChild(vscodeBtn);
  wrap.appendChild(vsBtn);
  return wrap;
}

// ── Command bar & keyboard shortcuts ───────────────────────────────────────────

let commandBarMatches = [];
let commandBarActiveIndex = 0;
let commandBarProjectContext = null;

function pathBasename(filePath) {
  return String(filePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

function projectSearchKeywords(repo) {
  const pathLower = repo.path.toLowerCase();
  const segments = pathLower.split(/[\\/]+/).filter(Boolean);
  return [
    'project',
    'find',
    'select',
    repo.name.toLowerCase(),
    pathBasename(repo.path).toLowerCase(),
    pathLower,
    ...segments,
  ];
}

function isSelectProjectCommand(command) {
  return command.id?.startsWith('select-project-');
}

function isSwitchWorkspaceCommand(command) {
  return command.id?.startsWith('switch-workspace-');
}

function workspaceSearchKeywords(ws) {
  const nameLower = ws.name.toLowerCase();
  return [
    'workspace',
    'switch',
    'change',
    nameLower,
    ...nameLower.split(/\s+/).filter(Boolean),
  ];
}

function resolveCommandIcon(command) {
  if (command.icon) return command.icon;
  if (isSelectProjectCommand(command)) return '▤';
  if (isSwitchWorkspaceCommand(command)) return command.current ? '●' : '◆';

  const icons = {
    dashboard: '◫',
    projects: '▤',
    terminal: '>_',
    tasks: '☑',
    settings: '⚙',
    'refresh-dashboard': '↻',
    'refresh-projects': '↻',
    'refresh-tasks': '↻',
    'new-terminal': '＋',
    'new-workspace': '＋',
    'add-link': '🔗',
    'project-view-back': '←',
    'command-focus': '⌕',
    'project-open': '→',
    'project-vscode': '⟨⟩',
    'project-vs': '▣',
    'project-terminal': '>_',
    'project-folder': '▤',
    'project-delete': '✕',
    'command-context-back': '←',
  };

  return icons[command.id] || '·';
}

function renderCommandResultContent(command) {
  const iconValue = resolveCommandIcon(command);
  const icon = escapeHtml(iconValue);
  const iconClass = iconValue === '>_'
    ? 'command-result-icon command-result-icon-terminal'
    : 'command-result-icon';
  const label = escapeHtml(command.label);
  const hint = command.hint
    ? `<span class="command-result-hint">${escapeHtml(command.hint)}</span>`
    : '';

  return `
    <div class="command-result-row">
      <span class="${iconClass}${command.destructive ? ' destructive' : ''}" aria-hidden="true">${icon}</span>
      <div class="command-result-body">
        <span class="command-result-label">${label}</span>
        ${hint}
      </div>
    </div>`;
}

function getProjectCommandCatalog(repo) {
  return [
    {
      id: 'project-open',
      label: 'Open project',
      hint: 'Enter',
      keywords: ['open', 'project', 'view', 'page', 'detail'],
      run: () => openProject(repo, { focusContent: true }),
    },
    {
      id: 'project-vscode',
      label: 'Open in VS Code',
      keywords: ['vscode', 'vs code', 'code', 'ide'],
      run: () => openInIde('vscode', repo.path),
    },
    {
      id: 'project-vs',
      label: 'Open in Visual Studio',
      keywords: ['visual studio', 'vs', 'ide'],
      run: () => openInIde('visualstudio', repo.path),
    },
    {
      id: 'project-terminal',
      label: 'Open terminal',
      keywords: ['terminal', 'shell', 'console'],
      run: () => {
        navigateToView('terminal', { focusContent: true });
        createTerminalSession(repo.path);
      },
    },
    {
      id: 'project-folder',
      label: 'Open folder',
      keywords: ['folder', 'explorer', 'directory', 'path'],
      run: () => api.shell.openPath(repo.path),
    },
    {
      id: 'project-delete',
      label: 'Delete project',
      keywords: ['delete', 'remove', 'unlink'],
      destructive: true,
      run: () => deleteLocalProject(repo),
    },
    {
      id: 'command-context-back',
      label: 'Back to all commands',
      hint: 'Esc',
      keywords: ['back', 'exit', 'leave', 'cancel'],
      run: () => exitProjectCommandContext(),
    },
  ];
}

function getGlobalCommandCatalog() {
  const commands = [
    {
      id: 'dashboard',
      label: 'Go to Dashboard',
      hint: 'Alt+D',
      keywords: ['dashboard', 'home'],
      run: () => navigateToView('dashboard', { focusContent: true }),
    },
    {
      id: 'projects',
      label: 'Go to Projects',
      hint: 'Alt+P',
      keywords: ['projects', 'repos', 'clone', 'remote', 'local'],
      run: () => navigateToView('repos', { focusContent: true }),
    },
    {
      id: 'terminal',
      label: 'Go to Terminal',
      hint: 'Alt+E',
      keywords: ['terminal', 'shell'],
      run: () => navigateToView('terminal', { focusContent: true }),
    },
    {
      id: 'tasks',
      label: 'Go to Tasks',
      hint: 'Alt+T',
      keywords: ['tasks', 'azure', 'work items'],
      run: () => navigateToView('tasks', { focusContent: true }),
    },
    {
      id: 'settings',
      label: 'Go to Settings',
      hint: 'Alt+S',
      keywords: ['settings', 'preferences', 'config', 'clone'],
      run: () => navigateToView('settings', { focusContent: true }),
    },
    {
      id: 'refresh-dashboard',
      label: 'Refresh dashboard',
      keywords: ['refresh', 'reload', 'dashboard', 'pull requests', 'prs'],
      run: () => refreshDashboard({ force: true }),
    },
    {
      id: 'refresh-projects',
      label: 'Refresh projects page',
      keywords: ['refresh', 'projects', 'repos', 'reload', 'remote', 'local', 'clone'],
      run: () => loadProjectsPage({ force: true }),
    },
    {
      id: 'refresh-tasks',
      label: 'Refresh tasks',
      keywords: ['refresh', 'tasks'],
      run: () => loadTasks(),
    },
    {
      id: 'new-terminal',
      label: 'New terminal tab',
      keywords: ['terminal', 'new', 'shell', 'tab'],
      run: () => {
        navigateToView('terminal', { focusContent: true });
        createTerminalSession(currentProject?.path);
      },
    },
    {
      id: 'new-workspace',
      label: 'New workspace',
      keywords: ['workspace', 'new'],
      run: () => openWorkspaceModal(),
    },
    {
      id: 'add-link',
      label: 'Add quick link',
      keywords: ['link', 'add', 'quick'],
      run: () => openLinkModal(),
    },
    {
      id: 'project-view-back',
      label: 'Back from project view',
      keywords: ['back', 'project', 'close'],
      run: () => {
        if (document.getElementById('view-project').classList.contains('active')) {
          currentProject = null;
          navigateToView(lastListView, { focusContent: true });
        }
      },
    },
    {
      id: 'command-focus',
      label: 'Focus command bar',
      hint: 'Ctrl+Q',
      keywords: ['command', 'palette', 'search'],
      run: () => focusCommandBar(),
    },
  ];

  cachedRepos.forEach((repo) => {
    commands.push({
      id: `select-project-${repo.path}`,
      label: repo.name,
      hint: 'Enter for commands',
      keywords: projectSearchKeywords(repo),
      repo,
      run: () => enterProjectCommandContext(repo),
    });
  });

  workspaces.workspaces.forEach((ws) => {
    const isActive = ws.id === workspaces.activeId;
    commands.push({
      id: `switch-workspace-${ws.id}`,
      label: isActive ? ws.name : `Switch to ${ws.name}`,
      hint: isActive ? 'Current workspace' : 'Workspace',
      keywords: workspaceSearchKeywords(ws),
      current: isActive,
      run: () => switchToWorkspace(ws.id),
    });
  });

  return commands;
}

function getCommandCatalog() {
  if (commandBarProjectContext) {
    return getProjectCommandCatalog(commandBarProjectContext);
  }
  return getGlobalCommandCatalog();
}

function updateCommandBarPlaceholder() {
  const commandBar = document.getElementById('command-bar');
  const wrap = document.querySelector('.command-bar-wrap');
  if (commandBarProjectContext) {
    commandBar.placeholder = `${commandBarProjectContext.name} › type a command…`;
    wrap?.classList.add('command-bar-context');
  } else {
    commandBar.placeholder = 'Ctrl+Q — type a command or project…';
    wrap?.classList.remove('command-bar-context');
  }
}

function enterProjectCommandContext(repo) {
  commandBarProjectContext = repo;
  updateCommandBarPlaceholder();
  commandBarActiveIndex = 0;
  const commandBar = document.getElementById('command-bar');
  commandBar.value = '';
  renderCommandResults();
  commandBar.focus();
}

function exitProjectCommandContext() {
  commandBarProjectContext = null;
  updateCommandBarPlaceholder();
  commandBarActiveIndex = 0;
  const commandBar = document.getElementById('command-bar');
  commandBar.value = '';
  renderCommandResults();
  commandBar.focus();
}

function commandSearchText(command) {
  return [
    command.label,
    command.hint || '',
    ...(command.keywords || []),
  ].join(' ').toLowerCase();
}

function filterCommands(query) {
  const normalized = query.trim().toLowerCase();
  const catalog = getCommandCatalog();

  if (!normalized) {
    if (commandBarProjectContext) {
      return catalog;
    }
    const actions = catalog.filter((command) => !isSelectProjectCommand(command) && !isSwitchWorkspaceCommand(command));
    const workspaceCommands = catalog.filter((command) => isSwitchWorkspaceCommand(command));
    const projects = catalog.filter((command) => isSelectProjectCommand(command));
    return [...actions.slice(0, 6), ...workspaceCommands, ...projects].slice(0, 24);
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);

  return catalog
    .map((command) => {
      const haystack = commandSearchText(command);
      let score = 0;

      for (const token of tokens) {
        if (!haystack.includes(token)) {
          return { command, score: 0 };
        }

        if (command.label.toLowerCase().includes(token)) score += 14;
        else if (command.label.toLowerCase().startsWith(token)) score += 10;
        else if ((command.keywords || []).some((word) => word.startsWith(token))) score += 8;
        else if ((command.keywords || []).some((word) => word.includes(token))) score += 6;
        else score += 4;
      }

      if (!commandBarProjectContext && isSelectProjectCommand(command)) score += 18;
      if (!commandBarProjectContext && isSwitchWorkspaceCommand(command)) score += 16;
      if (tokens.length === 1 && command.label.toLowerCase().startsWith(tokens[0])) score += 12;
      if (tokens.length === 1 && (command.hint || '').toLowerCase().includes(tokens[0])) score += 8;

      return { command, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label))
    .map((entry) => entry.command)
    .slice(0, 24);
}

function renderCommandResults() {
  const commandBar = document.getElementById('command-bar');
  const resultsEl = document.getElementById('command-results');
  commandBarMatches = filterCommands(commandBar.value);
  commandBarActiveIndex = Math.min(commandBarActiveIndex, Math.max(commandBarMatches.length - 1, 0));

  if (commandBarMatches.length === 0) {
    const emptyLabel = commandBarProjectContext
      ? 'No matching commands for this project'
      : 'No matching commands';
    resultsEl.innerHTML = `<li class="command-result">${emptyLabel}</li>`;
    resultsEl.classList.remove('hidden');
    commandBar.setAttribute('aria-expanded', 'true');
    return;
  }

  resultsEl.innerHTML = '';
  if (commandBarProjectContext) {
    const header = document.createElement('li');
    header.className = 'command-result command-result-context';
    header.setAttribute('role', 'presentation');
    header.innerHTML = `
      <div class="command-result-row">
        <span class="command-result-icon" aria-hidden="true">▤</span>
        <div class="command-result-body">
          <span class="command-result-label">${escapeHtml(commandBarProjectContext.name)}</span>
          <span class="command-result-hint">${escapeHtml(commandBarProjectContext.path)}</span>
        </div>
      </div>`;
    resultsEl.appendChild(header);
  }

  commandBarMatches.forEach((command, index) => {
    const item = document.createElement('li');
    const destructive = command.destructive ? ' destructive' : '';
    const current = command.current ? ' current' : '';
    item.className = `command-result${destructive}${current}${index === commandBarActiveIndex ? ' active' : ''}`;
    item.setAttribute('role', 'option');
    item.innerHTML = renderCommandResultContent(command);
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handleCommandSelection(command);
    });
    resultsEl.appendChild(item);
  });

  resultsEl.classList.remove('hidden');
  commandBar.setAttribute('aria-expanded', 'true');
}

function hideCommandResults() {
  const commandBar = document.getElementById('command-bar');
  const resultsEl = document.getElementById('command-results');
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
  commandBar.setAttribute('aria-expanded', 'false');
  commandBarMatches = [];
  commandBarActiveIndex = 0;
}

function focusCommandBar() {
  const commandBar = document.getElementById('command-bar');
  commandBar.focus();
  commandBar.select();
  renderCommandResults();
}

function handleCommandSelection(command) {
  if (!commandBarProjectContext && isSelectProjectCommand(command)) {
    enterProjectCommandContext(command.repo);
    return;
  }
  if (command.id === 'command-context-back') {
    exitProjectCommandContext();
    return;
  }
  executeCommand(command);
}

function executeCommand(command) {
  const commandBar = document.getElementById('command-bar');
  const inProjectContext = Boolean(commandBarProjectContext);
  hideCommandResults();
  commandBar.blur();
  commandBar.value = '';
  if (inProjectContext) {
    exitProjectCommandContext();
  }
  command.run();
}

function findProjectByExactName(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return cachedRepos.find((repo) => repo.name.toLowerCase() === normalized) || null;
}

function findWorkspaceByExactName(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const matches = workspaces.workspaces.filter((ws) => ws.name.toLowerCase() === normalized);
  if (matches.length === 0) return null;
  return matches.find((ws) => ws.id !== workspaces.activeId) || matches[0];
}

function executeActiveCommand() {
  const commandBar = document.getElementById('command-bar');

  if (commandBarMatches.length > 0) {
    handleCommandSelection(commandBarMatches[commandBarActiveIndex]);
    return;
  }

  if (!commandBarProjectContext) {
    const workspace = findWorkspaceByExactName(commandBar.value);
    if (workspace && workspace.id !== workspaces.activeId) {
      executeCommand({
        id: `switch-workspace-${workspace.id}`,
        run: () => switchToWorkspace(workspace.id),
      });
      return;
    }

    const repo = findProjectByExactName(commandBar.value);
    if (repo) {
      enterProjectCommandContext(repo);
    }
  }
}

function activateNavShortcut(key) {
  const shortcut = key.toLowerCase();
  const button = document.querySelector(`[data-shortcut="${shortcut}"]`);
  if (!button) return false;

  const view = button.dataset.view;
  if (!view) return false;

  if (button.id === 'nav-projects-toggle') {
    currentProject = null;
    updateProjectsSubmenuActive();
    if (!projectsExpanded) setProjectsExpanded(true);
  }

  navigateToView(view, { focusContent: true });
  return true;
}

function isTextEntryTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function isTerminalTarget(target) {
  return Boolean(target?.closest?.('.terminal-pane, .xterm'));
}

function initKeyboardShortcuts() {
  const commandBar = document.getElementById('command-bar');
  updateCommandBarPlaceholder();

  api.app.onFocusCommandBar(() => {
    focusCommandBar();
  });

  commandBar.addEventListener('input', () => {
    commandBarActiveIndex = 0;
    renderCommandResults();
  });

  commandBar.addEventListener('focus', () => {
    renderCommandResults();
  });

  commandBar.addEventListener('blur', () => {
    window.setTimeout(() => hideCommandResults(), 120);
  });

  commandBar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (commandBarMatches.length > 0) {
        commandBarActiveIndex = (commandBarActiveIndex + 1) % commandBarMatches.length;
        renderCommandResults();
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandBarMatches.length > 0) {
        commandBarActiveIndex = (commandBarActiveIndex - 1 + commandBarMatches.length) % commandBarMatches.length;
        renderCommandResults();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      executeActiveCommand();
      return;
    }

    if (e.key === 'Backspace' && commandBar.value === '' && commandBarProjectContext) {
      e.preventDefault();
      exitProjectCommandContext();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (commandBarProjectContext) {
        exitProjectCommandContext();
        return;
      }
      commandBar.value = '';
      hideCommandResults();
      commandBar.blur();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      focusCommandBar();
      return;
    }

    if (e.key === 'Backspace' && !isTextEntryTarget(e.target) && !isTerminalTarget(e.target)) {
      e.preventDefault();
      return;
    }

    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key.length === 1) {
      if (isTextEntryTarget(document.activeElement) && document.activeElement !== commandBar) {
        return;
      }

      if (activateNavShortcut(e.key)) {
        e.preventDefault();
      }
    }
  }, true);
}

// ── Init ────────────────────────────────────────────────────────────────────────

(async function init() {
  installGlobalErrorHandlers();
  initDashboardNavigation();
  initKeyboardShortcuts();
  try {
    setProjectsExpanded(projectsExpanded, { persist: false });
    await loadWorkspaces();
    renderWorkspaceSwitcher();
    await loadSettings();
    renderSettingsForm();
    renderLinks();
    createTerminalSession();
    await refreshDashboard();
  } catch (err) {
    await reportError(err, 'Failed to start Dev Hub');
  }
})();
