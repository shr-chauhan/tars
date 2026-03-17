process.env.LINEAR_API_KEY = 'test-linear-key';

const axios = require('axios');
jest.mock('axios');

const { LinearClient } = require('../src/linearClient');

// ─── helpers ────────────────────────────────────────────────────────────────

function mockIssueNode(overrides = {}) {
  return {
    id: 'uuid-1',
    identifier: 'ENG-1',
    title: 'Fix login bug',
    priority: 2,
    state: { name: 'In Progress' },
    assignee: { name: 'Shrey', email: 'shrey@test.com' },
    team: { name: 'Engineering' },
    cycle: { name: 'Sprint 1', startsAt: '2026-03-01', endsAt: '2026-03-14', isActive: true },
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    completedAt: null,
    url: 'https://linear.app/eng/issue/ENG-1',
    ...overrides,
  };
}

function gqlOk(data) {
  return { data: { data } };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('LinearClient', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new LinearClient();
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('throws if LINEAR_API_KEY is not set', () => {
      const original = process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_API_KEY;
      expect(() => new LinearClient()).toThrow('LINEAR_API_KEY is not set');
      process.env.LINEAR_API_KEY = original;
    });
  });

  // ── getIssues ─────────────────────────────────────────────────────────────

  describe('getIssues', () => {
    beforeEach(() => {
      axios.post.mockResolvedValue(gqlOk({ issues: { nodes: [mockIssueNode()] } }));
    });

    it('defaults to limit 50', async () => {
      await client.getIssues();
      expect(axios.post.mock.calls[0][1].query).toContain('first: 50');
    });

    it('uses limit 250 when assignee is provided', async () => {
      await client.getIssues({ assignee: 'Shrey' });
      expect(axios.post.mock.calls[0][1].query).toContain('first: 250');
    });

    it('uses limit 250 when completedAfter is provided', async () => {
      await client.getIssues({ completedAfter: '2026-02-01T00:00:00Z' });
      expect(axios.post.mock.calls[0][1].query).toContain('first: 250');
    });

    it('uses limit 250 when completedBefore is provided', async () => {
      await client.getIssues({ completedBefore: '2026-03-01T00:00:00Z' });
      expect(axios.post.mock.calls[0][1].query).toContain('first: 250');
    });

    it('respects an explicit limit override', async () => {
      await client.getIssues({ limit: 5 });
      expect(axios.post.mock.calls[0][1].query).toContain('first: 5');
    });

    it('adds status filter to query', async () => {
      await client.getIssues({ status: 'In Progress' });
      expect(axios.post.mock.calls[0][1].query).toContain('state: { name: { eq: "In Progress" } }');
    });

    it('does NOT add an assignee filter to the GraphQL query (client-side only)', async () => {
      await client.getIssues({ assignee: 'Shrey' });
      expect(axios.post.mock.calls[0][1].query).not.toContain('containsIgnoreCase');
    });

    it('skips assignee filter when value is "me"', async () => {
      await client.getIssues({ assignee: 'me' });
      expect(axios.post.mock.calls[0][1].query).not.toContain('containsIgnoreCase');
    });

    it('adds priority filter to query', async () => {
      await client.getIssues({ priority: 1 });
      expect(axios.post.mock.calls[0][1].query).toContain('priority: { eq: 1 }');
    });

    it('adds currentCycle filter to query', async () => {
      await client.getIssues({ currentCycle: true });
      expect(axios.post.mock.calls[0][1].query).toContain('cycle: { isActive: { eq: true } }');
    });

    it('builds a single completedAt filter with both gte and lte', async () => {
      await client.getIssues({
        completedAfter: '2026-02-01T00:00:00Z',
        completedBefore: '2026-03-01T00:00:00Z',
      });
      const query = axios.post.mock.calls[0][1].query;
      expect(query).toContain('completedAt');
      expect(query).toContain('gte: "2026-02-01T00:00:00Z"');
      expect(query).toContain('lte: "2026-03-01T00:00:00Z"');
      // Must not produce duplicate filter keys — gte and lte should be inside one completedAt block
      expect(query.match(/completedAt:\s*\{/g).length).toBe(1);
    });

    it('builds completedAt filter with only gte', async () => {
      await client.getIssues({ completedAfter: '2026-02-01T00:00:00Z' });
      const query = axios.post.mock.calls[0][1].query;
      expect(query).toContain('gte: "2026-02-01T00:00:00Z"');
      expect(query).not.toContain('lte:');
    });

    it('filters by assignee name client-side', async () => {
      axios.post.mockResolvedValue(gqlOk({
        issues: {
          nodes: [
            mockIssueNode({ assignee: { name: 'Shrey Chauhan', email: 'shrey@test.com' } }),
            mockIssueNode({ id: 'uuid-2', assignee: { name: 'Alice Smith', email: 'alice@test.com' } }),
          ],
        },
      }));

      const result = await client.getIssues({ assignee: 'shrey' });
      expect(result.count).toBe(1);
      expect(result.issues[0].assignee).toBe('Shrey Chauhan');
    });

    it('filters by assignee email client-side when name does not match', async () => {
      axios.post.mockResolvedValue(gqlOk({
        issues: {
          nodes: [
            mockIssueNode({ assignee: { name: 'SS', email: 'sai.siddhartha@company.com' } }),
            mockIssueNode({ id: 'uuid-2', assignee: { name: 'Alice', email: 'alice@company.com' } }),
          ],
        },
      }));

      // "sai" doesn't match name "SS" but matches email "sai.siddhartha@..."
      const result = await client.getIssues({ assignee: 'sai' });
      expect(result.count).toBe(1);
      expect(result.issues[0].assignee).toBe('SS');
    });

    it('filters by teamName client-side', async () => {
      axios.post.mockResolvedValue(gqlOk({
        issues: {
          nodes: [
            mockIssueNode({ team: { name: 'Engineering' } }),
            mockIssueNode({ id: 'uuid-2', identifier: 'MKT-1', team: { name: 'Marketing' } }),
          ],
        },
      }));

      const result = await client.getIssues({ teamName: 'engineering' });
      expect(result.count).toBe(1);
      expect(result.issues[0].team).toBe('Engineering');
    });

    it('returns formatted issues', async () => {
      const result = await client.getIssues();
      expect(result.count).toBe(1);
      expect(result.issues[0]).toMatchObject({
        identifier: 'ENG-1',
        title: 'Fix login bug',
        status: 'In Progress',
        assignee: 'Shrey',
        team: 'Engineering',
        priority: '🟠 High',
        url: 'https://linear.app/eng/issue/ENG-1',
      });
    });

    it('throws when the API returns GraphQL errors', async () => {
      axios.post.mockResolvedValue({ data: { errors: [{ message: 'Unauthorized' }] } });
      await expect(client.getIssues()).rejects.toThrow('Unauthorized');
    });
  });

  // ── getIssue ──────────────────────────────────────────────────────────────

  describe('getIssue', () => {
    it('fetches a single issue with full details', async () => {
      axios.post.mockResolvedValue(gqlOk({
        issue: {
          id: 'uuid-42',
          identifier: 'ENG-42',
          title: 'Auth bug',
          description: 'Detailed description',
          priority: 1,
          state: { name: 'In Review' },
          assignee: { name: 'Shrey', email: 'shrey@test.com' },
          team: { name: 'Engineering' },
          cycle: { name: 'Sprint 1', isActive: true },
          labels: { nodes: [{ name: 'bug' }, { name: 'auth' }] },
          comments: { nodes: [{ body: 'Looking into it', createdAt: '2026-03-10T00:00:00Z', user: { name: 'Shrey' } }] },
          createdAt: '2026-03-01T00:00:00Z',
          updatedAt: '2026-03-10T00:00:00Z',
          completedAt: null,
          url: 'https://linear.app/eng/issue/ENG-42',
        },
      }));

      const result = await client.getIssue('ENG-42');

      expect(result.identifier).toBe('ENG-42');
      expect(result.priority).toBe('🔴 Urgent');
      expect(result.labels).toEqual(['bug', 'auth']);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]).toMatchObject({ author: 'Shrey', body: 'Looking into it' });
      expect(result.description).toBe('Detailed description');
    });

    it('passes the issueId as a variable', async () => {
      axios.post.mockResolvedValue(gqlOk({
        issue: mockIssueNode({ id: 'uuid-42', identifier: 'ENG-42', labels: { nodes: [] }, comments: { nodes: [] }, description: '' }),
      }));

      await client.getIssue('ENG-42');
      expect(axios.post.mock.calls[0][1].variables).toEqual({ id: 'ENG-42' });
    });
  });

  // ── updateIssue ───────────────────────────────────────────────────────────

  describe('updateIssue', () => {
    it('looks up state ID then updates status', async () => {
      axios.post
        .mockResolvedValueOnce(gqlOk({ workflowStates: { nodes: [{ id: 'state-done', name: 'Done' }] } }))
        .mockResolvedValueOnce(gqlOk({ issueUpdate: { success: true, issue: { identifier: 'ENG-1', title: 'Fix', state: { name: 'Done' }, assignee: null } } }));

      const result = await client.updateIssue({ issueId: 'ENG-1', status: 'Done' });
      expect(result.success).toBe(true);
      expect(result.results[0].updated.state.name).toBe('Done');
    });

    it('throws if the requested status does not exist', async () => {
      axios.post.mockResolvedValueOnce(gqlOk({ workflowStates: { nodes: [{ id: 'state-todo', name: 'Todo' }] } }));
      await expect(client.updateIssue({ issueId: 'ENG-1', status: 'Nonexistent' }))
        .rejects.toThrow('Status "Nonexistent" not found');
    });

    it('looks up assignee ID then updates assignee', async () => {
      axios.post
        .mockResolvedValueOnce(gqlOk({ users: { nodes: [{ id: 'user-1', name: 'Shrey Chauhan' }] } }))
        .mockResolvedValueOnce(gqlOk({ issueUpdate: { success: true, issue: { identifier: 'ENG-1', title: 'Fix', state: { name: 'Todo' }, assignee: { name: 'Shrey Chauhan' } } } }));

      const result = await client.updateIssue({ issueId: 'ENG-1', assigneeName: 'Shrey' });
      expect(result.success).toBe(true);
    });

    it('throws if the requested assignee does not exist', async () => {
      axios.post.mockResolvedValueOnce(gqlOk({ users: { nodes: [{ id: 'user-1', name: 'Alice' }] } }));
      await expect(client.updateIssue({ issueId: 'ENG-1', assigneeName: 'Bob' }))
        .rejects.toThrow('User "Bob" not found');
    });

    it('adds a comment to the issue', async () => {
      const fullIssue = { id: 'uuid-1', identifier: 'ENG-1', title: 'Fix', priority: 0, state: { name: 'Todo' }, assignee: null, team: { name: 'Eng' }, cycle: null, labels: { nodes: [] }, comments: { nodes: [] }, createdAt: '', updatedAt: '', completedAt: null, url: '' };
      axios.post
        .mockResolvedValueOnce(gqlOk({ issue: fullIssue }))
        .mockResolvedValueOnce(gqlOk({ commentCreate: { success: true, comment: { id: 'c1', createdAt: '' } } }));

      const result = await client.updateIssue({ issueId: 'ENG-1', comment: 'Looks good!' });
      expect(result.success).toBe(true);
      expect(result.results[0].commentAdded).toBe(true);
    });
  });

  // ── createIssue ───────────────────────────────────────────────────────────

  describe('createIssue', () => {
    it('creates an issue using the first available team by default', async () => {
      axios.post
        .mockResolvedValueOnce(gqlOk({ teams: { nodes: [{ id: 'team-1', name: 'Engineering' }] } }))
        .mockResolvedValueOnce(gqlOk({ issueCreate: { success: true, issue: { identifier: 'ENG-10', title: 'New issue', url: 'https://...', state: { name: 'Todo' } } } }));

      const result = await client.createIssue({ title: 'New issue' });
      expect(result.success).toBe(true);
      expect(result.issue.identifier).toBe('ENG-10');
    });

    it('selects the matching team by name', async () => {
      axios.post
        .mockResolvedValueOnce(gqlOk({ teams: { nodes: [{ id: 'team-1', name: 'Engineering' }, { id: 'team-2', name: 'Marketing' }] } }))
        .mockResolvedValueOnce(gqlOk({ issueCreate: { success: true, issue: { identifier: 'MKT-1', title: 'Campaign', url: '', state: { name: 'Todo' } } } }));

      await client.createIssue({ title: 'Campaign', teamName: 'marketing' });
      const mutation = axios.post.mock.calls[1][1].query;
      expect(mutation).toContain('"team-2"');
    });
  });

  // ── getTeams ──────────────────────────────────────────────────────────────

  describe('getTeams', () => {
    it('returns team list', async () => {
      axios.post.mockResolvedValue(gqlOk({
        teams: { nodes: [{ id: 'team-1', name: 'Engineering', description: 'Core eng' }] },
      }));

      const teams = await client.getTeams();
      expect(teams).toHaveLength(1);
      expect(teams[0].name).toBe('Engineering');
    });

    it('does not query for members (avoids permission errors)', async () => {
      axios.post.mockResolvedValue(gqlOk({ teams: { nodes: [] } }));
      await client.getTeams();
      expect(axios.post.mock.calls[0][1].query).not.toContain('members');
    });
  });

  // ── getCycle ──────────────────────────────────────────────────────────────

  describe('getCycle', () => {
    const mockCycles = [
      { id: 'c1', name: 'Sprint 5', number: 5, startsAt: '', endsAt: '', team: { name: 'Engineering' }, issues: { nodes: [] } },
      { id: 'c2', name: 'Sprint 2', number: 2, startsAt: '', endsAt: '', team: { name: 'Marketing' }, issues: { nodes: [] } },
    ];

    beforeEach(() => {
      axios.post.mockResolvedValue(gqlOk({ cycles: { nodes: mockCycles } }));
    });

    it('returns all active cycles when no teamName is given', async () => {
      const result = await client.getCycle();
      expect(result).toHaveLength(2);
    });

    it('filters cycles by teamName (case-insensitive)', async () => {
      const result = await client.getCycle('engineering');
      expect(result).toHaveLength(1);
      expect(result[0].team.name).toBe('Engineering');
    });
  });

  // ── _formatIssue ──────────────────────────────────────────────────────────

  describe('_formatIssue', () => {
    const base = {
      id: 'uuid-1', identifier: 'ENG-1', title: 'Test', priority: 0,
      state: { name: 'Todo' }, assignee: null, team: { name: 'Eng' },
      cycle: null, completedAt: null, url: 'https://...',
    };

    it.each([
      [0, 'None'],
      [1, '🔴 Urgent'],
      [2, '🟠 High'],
      [3, '🟡 Medium'],
      [4, '🟢 Low'],
    ])('maps priority %i to "%s"', (priority, label) => {
      expect(client._formatIssue({ ...base, priority }).priority).toBe(label);
    });

    it('shows "Unassigned" when no assignee', () => {
      expect(client._formatIssue(base).assignee).toBe('Unassigned');
    });

    it('includes description and comments only in full mode', () => {
      const issue = { ...base, description: 'desc', labels: { nodes: [] }, comments: { nodes: [] } };
      const brief = client._formatIssue(issue, false);
      const full = client._formatIssue(issue, true);
      expect(brief.description).toBeUndefined();
      expect(full.description).toBe('desc');
    });
  });
});
