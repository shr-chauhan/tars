const { Octokit } = require('@octokit/rest');

class GitHubClient {
  constructor() {
    this.token = process.env.GITHUB_TOKEN;
    this.defaultOrg = process.env.GITHUB_ORG || null;
    this.defaultRepo = process.env.GITHUB_DEFAULT_REPO;

    if (!this.token) throw new Error('GITHUB_TOKEN is not set');

    this.octokit = new Octokit({ auth: this.token });
  }

  async _getOwner() {
    if (this.defaultOrg) return this.defaultOrg;
    const { data } = await this.octokit.users.getAuthenticated();
    return data.login;
  }

  _parseRepo(repo) {
    const r = repo || this.defaultRepo;
    if (!r) throw new Error('No repo specified. Set GITHUB_DEFAULT_REPO or pass a repo name.');
    // Support "owner/repo" format
    if (r.includes('/')) {
      const [owner, name] = r.split('/');
      return { owner, repo: name };
    }
    // Just a repo name — use org, or fall back to owner from defaultRepo
    if (this.defaultOrg) return { owner: this.defaultOrg, repo: r };
    if (this.defaultRepo && this.defaultRepo.includes('/')) {
      const [owner] = this.defaultRepo.split('/');
      return { owner, repo: r };
    }
    throw new Error(`Cannot determine owner for repo "${r}". Set GITHUB_ORG or use "owner/repo" format.`);
  }

  // ── List PRs ──────────────────────────────────────────────────────────────
  async listPRs({ repo, state = 'open', author } = {}) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data } = await this.octokit.pulls.list({
      owner, repo: repoName, state, per_page: 30,
    });

    let prs = data;
    if (author) prs = prs.filter(pr => pr.user.login.toLowerCase().includes(author.toLowerCase()));

    return prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      state: pr.state,
      draft: pr.draft,
      reviewsRequested: pr.requested_reviewers?.map(r => r.login),
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      url: pr.html_url,
      branch: pr.head.ref,
      targetBranch: pr.base.ref,
    }));
  }

  // ── Get single PR ──────────────────────────────────────────────────────────
  async getPR({ repo, prNumber }) {
    const { owner, repo: repoName } = this._parseRepo(repo);

    const [{ data: pr }, { data: reviews }, { data: checks }] = await Promise.all([
      this.octokit.pulls.get({ owner, repo: repoName, pull_number: prNumber }),
      this.octokit.pulls.listReviews({ owner, repo: repoName, pull_number: prNumber }),
      this.octokit.checks.listForRef({ owner, repo: repoName, ref: `pull/${prNumber}/head` }).catch(() => ({ data: { check_runs: [] } })),
    ]);

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.user.login,
      state: pr.state,
      draft: pr.draft,
      mergeable: pr.mergeable,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
      branch: pr.head.ref,
      reviews: reviews.map(r => ({ reviewer: r.user.login, state: r.state })),
      checks: checks.check_runs?.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
      url: pr.html_url,
    };
  }

  // ── List GitHub issues ────────────────────────────────────────────────────
  async listIssues({ repo, state = 'open', label, assignee } = {}) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data } = await this.octokit.issues.listForRepo({
      owner, repo: repoName, state,
      labels: label,
      assignee,
      per_page: 30,
    });

    // Filter out PRs (GitHub issues API returns PRs too)
    return data
      .filter(i => !i.pull_request)
      .map(issue => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.user.login,
        assignees: issue.assignees?.map(a => a.login),
        labels: issue.labels?.map(l => l.name),
        createdAt: issue.created_at,
        url: issue.html_url,
      }));
  }

  // ── Recent commits ────────────────────────────────────────────────────────
  async recentCommits({ repo, branch = 'main', limit = 10 } = {}) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data } = await this.octokit.repos.listCommits({
      owner, repo: repoName, sha: branch, per_page: limit,
    });

    return data.map(c => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0], // first line only
      author: c.commit.author.name,
      date: c.commit.author.date,
      url: c.html_url,
    }));
  }

  // ── Search code ───────────────────────────────────────────────────────────
  async searchCode({ query, repo } = {}) {
    const owner = await this._getOwner();
    const q = repo ? `${query} repo:${owner}/${repo}` : `${query} user:${owner}`;
    const { data } = await this.octokit.search.code({ q, per_page: 10 });

    return data.items.map(item => ({
      file: item.path,
      repo: item.repository.full_name,
      url: item.html_url,
    }));
  }

  // ── List branches ─────────────────────────────────────────────────────────
  async listBranches({ repo } = {}) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data } = await this.octokit.repos.listBranches({
      owner, repo: repoName, per_page: 50,
    });

    return data.map(b => ({
      name: b.name,
      sha: b.commit.sha.slice(0, 7),
      protected: b.protected,
    }));
  }

  // ── List repos ────────────────────────────────────────────────────────────
  async listRepos() {
    const owner = await this._getOwner();
    const listFn = this.defaultOrg
      ? this.octokit.repos.listForOrg({ org: owner, per_page: 50, sort: 'updated' })
      : this.octokit.repos.listForAuthenticatedUser({ per_page: 50, sort: 'updated' });
    const { data } = await listFn;

    return data.map(r => ({
      name: r.name,
      description: r.description,
      language: r.language,
      private: r.private,
      updatedAt: r.updated_at,
      url: r.html_url,
      openIssues: r.open_issues_count,
    }));
  }
}

module.exports = { GitHubClient };
