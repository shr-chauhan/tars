process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_DEFAULT_REPO = 'shr-chauhan/E_Pharma_Backend';

// Build a shared mock Octokit instance that all tests can configure
const mockOctokit = {
  users: { getAuthenticated: jest.fn() },
  pulls: { list: jest.fn(), get: jest.fn(), listReviews: jest.fn() },
  checks: { listForRef: jest.fn() },
  issues: { listForRepo: jest.fn() },
  repos: { listCommits: jest.fn(), listBranches: jest.fn(), listForOrg: jest.fn(), listForAuthenticatedUser: jest.fn() },
  search: { code: jest.fn() },
};

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => mockOctokit),
}));

const { GitHubClient } = require('../src/githubClient');

// ─── helpers ────────────────────────────────────────────────────────────────

function mockPR(overrides = {}) {
  return {
    number: 1,
    title: 'Fix auth',
    user: { login: 'shrey' },
    state: 'open',
    draft: false,
    requested_reviewers: [{ login: 'alice' }],
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z',
    html_url: 'https://github.com/shr-chauhan/E_Pharma_Backend/pull/1',
    head: { ref: 'fix/auth' },
    base: { ref: 'main' },
    ...overrides,
  };
}

function mockIssue(overrides = {}) {
  return {
    number: 10,
    title: 'Bug: crash on login',
    state: 'open',
    user: { login: 'shrey' },
    assignees: [{ login: 'alice' }],
    labels: [{ name: 'bug' }],
    created_at: '2026-03-01T00:00:00Z',
    html_url: 'https://github.com/shr-chauhan/E_Pharma_Backend/issues/10',
    pull_request: undefined,
    ...overrides,
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('GitHubClient', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new GitHubClient();
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('throws if GITHUB_TOKEN is not set', () => {
      const original = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      expect(() => new GitHubClient()).toThrow('GITHUB_TOKEN is not set');
      process.env.GITHUB_TOKEN = original;
    });
  });

  // ── _parseRepo ────────────────────────────────────────────────────────────

  describe('_parseRepo', () => {
    it('splits "owner/repo" format', () => {
      const result = client._parseRepo('myorg/myapp');
      expect(result).toEqual({ owner: 'myorg', repo: 'myapp' });
    });

    it('uses GITHUB_ORG as owner when only repo name is given', () => {
      process.env.GITHUB_ORG = 'myorg';
      const c = new GitHubClient();
      expect(c._parseRepo('myapp')).toEqual({ owner: 'myorg', repo: 'myapp' });
      delete process.env.GITHUB_ORG;
    });

    it('falls back to owner from GITHUB_DEFAULT_REPO when only repo name given and no org', () => {
      // GITHUB_DEFAULT_REPO = 'shr-chauhan/E_Pharma_Backend', no GITHUB_ORG
      expect(client._parseRepo('OtherRepo')).toEqual({ owner: 'shr-chauhan', repo: 'OtherRepo' });
    });

    it('uses GITHUB_DEFAULT_REPO when no repo argument is given', () => {
      expect(client._parseRepo()).toEqual({ owner: 'shr-chauhan', repo: 'E_Pharma_Backend' });
    });

    it('throws when repo name is given but owner cannot be determined', () => {
      const original = process.env.GITHUB_DEFAULT_REPO;
      delete process.env.GITHUB_DEFAULT_REPO;
      const c = new GitHubClient();
      expect(() => c._parseRepo('myapp')).toThrow('Cannot determine owner');
      process.env.GITHUB_DEFAULT_REPO = original;
    });

    it('throws when no repo argument and no default', () => {
      const original = process.env.GITHUB_DEFAULT_REPO;
      delete process.env.GITHUB_DEFAULT_REPO;
      const c = new GitHubClient();
      expect(() => c._parseRepo()).toThrow('No repo specified');
      process.env.GITHUB_DEFAULT_REPO = original;
    });
  });

  // ── listPRs ───────────────────────────────────────────────────────────────

  describe('listPRs', () => {
    it('returns formatted PRs', async () => {
      mockOctokit.pulls.list.mockResolvedValue({ data: [mockPR()] });

      const result = await client.listPRs({});
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        number: 1,
        title: 'Fix auth',
        author: 'shrey',
        state: 'open',
        draft: false,
        reviewsRequested: ['alice'],
        branch: 'fix/auth',
        targetBranch: 'main',
      });
    });

    it('filters by author (case-insensitive partial match)', async () => {
      mockOctokit.pulls.list.mockResolvedValue({
        data: [mockPR({ user: { login: 'shrey' } }), mockPR({ number: 2, user: { login: 'alice' } })],
      });

      const result = await client.listPRs({ author: 'SHREY' });
      expect(result).toHaveLength(1);
      expect(result[0].author).toBe('shrey');
    });

    it('passes state parameter to octokit', async () => {
      mockOctokit.pulls.list.mockResolvedValue({ data: [] });
      await client.listPRs({ state: 'closed' });
      expect(mockOctokit.pulls.list).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'closed' })
      );
    });

    it('defaults to open PRs', async () => {
      mockOctokit.pulls.list.mockResolvedValue({ data: [] });
      await client.listPRs({});
      expect(mockOctokit.pulls.list).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'open' })
      );
    });
  });

  // ── getPR ─────────────────────────────────────────────────────────────────

  describe('getPR', () => {
    it('returns PR with reviews and checks', async () => {
      const pr = {
        ...mockPR(),
        body: 'Fixes the login issue',
        mergeable: true,
        changed_files: 3,
        additions: 50,
        deletions: 10,
      };

      mockOctokit.pulls.get.mockResolvedValue({ data: pr });
      mockOctokit.pulls.listReviews.mockResolvedValue({
        data: [{ user: { login: 'alice' }, state: 'APPROVED' }],
      });
      mockOctokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] },
      });

      const result = await client.getPR({ prNumber: 1 });

      expect(result.number).toBe(1);
      expect(result.reviews).toEqual([{ reviewer: 'alice', state: 'APPROVED' }]);
      expect(result.checks).toEqual([{ name: 'CI', status: 'completed', conclusion: 'success' }]);
      expect(result.changedFiles).toBe(3);
    });

    it('handles checks API failure gracefully (returns empty checks)', async () => {
      mockOctokit.pulls.get.mockResolvedValue({ data: { ...mockPR(), body: '', mergeable: true, changed_files: 0, additions: 0, deletions: 0 } });
      mockOctokit.pulls.listReviews.mockResolvedValue({ data: [] });
      mockOctokit.checks.listForRef.mockRejectedValue(new Error('403 Forbidden'));

      const result = await client.getPR({ prNumber: 1 });
      expect(result.checks).toEqual([]);
    });
  });

  // ── listIssues ────────────────────────────────────────────────────────────

  describe('listIssues', () => {
    it('returns formatted issues', async () => {
      mockOctokit.issues.listForRepo.mockResolvedValue({ data: [mockIssue()] });

      const result = await client.listIssues({});
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        number: 10,
        title: 'Bug: crash on login',
        state: 'open',
        author: 'shrey',
        labels: ['bug'],
      });
    });

    it('filters out pull requests from the results', async () => {
      mockOctokit.issues.listForRepo.mockResolvedValue({
        data: [
          mockIssue({ number: 10 }),
          mockIssue({ number: 11, pull_request: { url: 'https://...' } }), // this is a PR
        ],
      });

      const result = await client.listIssues({});
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(10);
    });

    it('passes label and assignee filters to octokit', async () => {
      mockOctokit.issues.listForRepo.mockResolvedValue({ data: [] });
      await client.listIssues({ label: 'bug', assignee: 'shrey' });
      expect(mockOctokit.issues.listForRepo).toHaveBeenCalledWith(
        expect.objectContaining({ labels: 'bug', assignee: 'shrey' })
      );
    });
  });

  // ── recentCommits ─────────────────────────────────────────────────────────

  describe('recentCommits', () => {
    it('returns formatted commits with truncated SHA and first message line only', async () => {
      mockOctokit.repos.listCommits.mockResolvedValue({
        data: [{
          sha: 'abc1234567890',
          commit: {
            message: 'Fix auth bug\n\nThis commit fixes the login issue.',
            author: { name: 'Shrey', date: '2026-03-10T00:00:00Z' },
          },
          html_url: 'https://github.com/.../commit/abc1234',
        }],
      });

      const result = await client.recentCommits({});
      expect(result[0].sha).toBe('abc1234');
      expect(result[0].message).toBe('Fix auth bug'); // only first line
      expect(result[0].author).toBe('Shrey');
    });

    it('defaults to main branch and limit 10', async () => {
      mockOctokit.repos.listCommits.mockResolvedValue({ data: [] });
      await client.recentCommits({});
      expect(mockOctokit.repos.listCommits).toHaveBeenCalledWith(
        expect.objectContaining({ sha: 'main', per_page: 10 })
      );
    });
  });

  // ── searchCode ────────────────────────────────────────────────────────────

  describe('searchCode', () => {
    beforeEach(() => {
      mockOctokit.users.getAuthenticated.mockResolvedValue({ data: { login: 'shr-chauhan' } });
      mockOctokit.search.code.mockResolvedValue({
        data: {
          items: [{
            path: 'src/auth.js',
            repository: { full_name: 'shr-chauhan/E_Pharma_Backend' },
            html_url: 'https://github.com/...',
          }],
        },
      });
    });

    it('scopes search to a specific repo when provided', async () => {
      await client.searchCode({ query: 'sendEmail', repo: 'E_Pharma_Backend' });
      expect(mockOctokit.search.code).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'sendEmail repo:shr-chauhan/E_Pharma_Backend' })
      );
    });

    it('searches by user when no repo specified', async () => {
      await client.searchCode({ query: 'sendEmail' });
      expect(mockOctokit.search.code).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'sendEmail user:shr-chauhan' })
      );
    });

    it('returns formatted results', async () => {
      const result = await client.searchCode({ query: 'sendEmail' });
      expect(result[0]).toMatchObject({
        file: 'src/auth.js',
        repo: 'shr-chauhan/E_Pharma_Backend',
      });
    });
  });

  // ── listBranches ──────────────────────────────────────────────────────────

  describe('listBranches', () => {
    it('returns formatted branches with truncated SHA', async () => {
      mockOctokit.repos.listBranches.mockResolvedValue({
        data: [
          { name: 'main', commit: { sha: 'abc1234567890' }, protected: true },
          { name: 'feature/login', commit: { sha: 'def4567890abc' }, protected: false },
        ],
      });

      const result = await client.listBranches({});
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'main', sha: 'abc1234', protected: true });
      expect(result[1]).toEqual({ name: 'feature/login', sha: 'def4567', protected: false });
    });

    it('uses the default repo when no repo is specified', async () => {
      mockOctokit.repos.listBranches.mockResolvedValue({ data: [] });
      await client.listBranches({});
      expect(mockOctokit.repos.listBranches).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'shr-chauhan', repo: 'E_Pharma_Backend' })
      );
    });
  });

  // ── listRepos ─────────────────────────────────────────────────────────────

  describe('listRepos', () => {
    it('returns formatted repos', async () => {
      mockOctokit.users.getAuthenticated.mockResolvedValue({ data: { login: 'shr-chauhan' } });
      mockOctokit.repos.listForAuthenticatedUser.mockResolvedValue({
        data: [{
          name: 'E_Pharma_Backend',
          description: 'Pharmacy backend',
          language: 'JavaScript',
          private: false,
          updated_at: '2026-03-10T00:00:00Z',
          html_url: 'https://github.com/...',
          open_issues_count: 3,
        }],
      });

      const result = await client.listRepos();
      expect(result[0]).toMatchObject({
        name: 'E_Pharma_Backend',
        language: 'JavaScript',
        openIssues: 3,
      });
    });
  });
});
