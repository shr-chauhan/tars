process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.LINEAR_API_KEY = 'test-linear-key';
process.env.GITHUB_TOKEN = 'test-token';
process.env.GITHUB_DEFAULT_REPO = 'owner/repo';

// ─── Mocks ───────────────────────────────────────────────────────────────────
// Note: jest.mock() is hoisted, but the factory functions are called lazily
// (when require() runs), so variables defined with var before the require are
// already assigned by the time the factory executes.

var mockLinear = {
  getIssues: jest.fn(),
  getIssue: jest.fn(),
  updateIssue: jest.fn(),
  createIssue: jest.fn(),
  getTeams: jest.fn(),
  getCycle: jest.fn(),
};

var mockGitHub = {
  listPRs: jest.fn(),
  getPR: jest.fn(),
  listIssues: jest.fn(),
  recentCommits: jest.fn(),
  searchCode: jest.fn(),
  listRepos: jest.fn(),
  listBranches: jest.fn(),
};

var mockOutlook = {
  listEmails:   jest.fn(),
  getEmail:     jest.fn(),
  searchEmails: jest.fn(),
  listEvents:   jest.fn(),
};

var mockChatCreate = jest.fn();

jest.mock('../src/outlookClient', () => ({
  OutlookClient: jest.fn(() => mockOutlook),
}));

jest.mock('../src/linearClient', () => ({
  LinearClient: jest.fn(() => mockLinear),
}));

jest.mock('../src/githubClient', () => ({
  GitHubClient: jest.fn(() => mockGitHub),
}));

jest.mock('openai', () =>
  jest.fn(() => ({ chat: { completions: { create: mockChatCreate } } }))
);

const { ClaudeAgent } = require('../src/claudeAgent');

// ─── helpers ─────────────────────────────────────────────────────────────────

function stopResponse(text) {
  return {
    choices: [{ finish_reason: 'stop', message: { content: text } }],
  };
}

function toolCallResponse(name, args, id = 'call-1') {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('ClaudeAgent', () => {
  let agent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new ClaudeAgent();
  });

  // ── chat ──────────────────────────────────────────────────────────────────

  describe('chat', () => {
    it('returns text when model finishes immediately', async () => {
      mockChatCreate.mockResolvedValueOnce(stopResponse('Here are your issues.'));

      const result = await agent.chat([{ role: 'user', content: 'Show issues' }]);
      expect(result.text).toBe('Here are your issues.');
    });

    it('injects today\'s date into the system prompt', async () => {
      mockChatCreate.mockResolvedValueOnce(stopResponse('Done'));
      await agent.chat([]);
      const systemMsg = mockChatCreate.mock.calls[0][0].messages[0];
      expect(systemMsg.role).toBe('system');
      expect(systemMsg.content).toMatch(/Today's date is \d{4}-\d{2}-\d{2}/);
    });

    it('injects the user name into the system prompt when provided', async () => {
      mockChatCreate.mockResolvedValueOnce(stopResponse('Done'));
      await agent.chat([], 'Shrey Chauhan');
      const systemMsg = mockChatCreate.mock.calls[0][0].messages[0];
      expect(systemMsg.content).toContain('Shrey Chauhan');
    });

    it('does not mention a user name in the system prompt when not provided', async () => {
      mockChatCreate.mockResolvedValueOnce(stopResponse('Done'));
      await agent.chat([]);
      const systemMsg = mockChatCreate.mock.calls[0][0].messages[0];
      expect(systemMsg.content).not.toContain("user's name is");
    });

    it('calls a tool and sends the result back to the model', async () => {
      const issues = { count: 1, issues: [{ identifier: 'ENG-1', title: 'Fix auth' }] };
      mockLinear.getIssues.mockResolvedValue(issues);

      mockChatCreate
        .mockResolvedValueOnce(toolCallResponse('linear_get_issues', { status: 'In Progress' }))
        .mockResolvedValueOnce(stopResponse('You have 1 issue in progress.'));

      const result = await agent.chat([{ role: 'user', content: 'Show in-progress issues' }]);

      expect(mockLinear.getIssues).toHaveBeenCalledWith({ status: 'In Progress' });
      expect(result.text).toBe('You have 1 issue in progress.');

      // Second call should include the tool result message
      const secondCallMessages = mockChatCreate.mock.calls[1][0].messages;
      const toolResultMsg = secondCallMessages.find(m => m.role === 'tool');
      expect(toolResultMsg).toBeDefined();
      expect(JSON.parse(toolResultMsg.content)).toEqual(issues);
    });

    it('handles multiple sequential tool calls in one turn', async () => {
      mockLinear.getIssues.mockResolvedValue({ count: 0, issues: [] });
      mockGitHub.listPRs.mockResolvedValue([]);

      const multiToolResponse = {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call-1', function: { name: 'linear_get_issues', arguments: '{}' } },
              { id: 'call-2', function: { name: 'github_list_prs', arguments: '{}' } },
            ],
          },
        }],
      };

      mockChatCreate
        .mockResolvedValueOnce(multiToolResponse)
        .mockResolvedValueOnce(stopResponse('Nothing to show.'));

      await agent.chat([]);

      expect(mockLinear.getIssues).toHaveBeenCalledTimes(1);
      expect(mockGitHub.listPRs).toHaveBeenCalledTimes(1);

      const secondCallMessages = mockChatCreate.mock.calls[1][0].messages;
      const toolMessages = secondCallMessages.filter(m => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
    });

    it('returns a tool error result and continues when a tool throws', async () => {
      mockLinear.getIssues.mockRejectedValue(new Error('Linear API down'));

      mockChatCreate
        .mockResolvedValueOnce(toolCallResponse('linear_get_issues', {}))
        .mockResolvedValueOnce(stopResponse('I could not fetch issues right now.'));

      const result = await agent.chat([]);
      expect(result.text).toBe('I could not fetch issues right now.');

      // Tool error should be surfaced as a tool message
      const secondMessages = mockChatCreate.mock.calls[1][0].messages;
      const toolMsg = secondMessages.find(m => m.role === 'tool');
      expect(JSON.parse(toolMsg.content)).toEqual({ error: 'Linear API down' });
    });

    it('returns a fallback message after 10 iterations without stop', async () => {
      // Always respond with a tool call — never stops
      mockLinear.getIssues.mockResolvedValue({});
      mockChatCreate.mockResolvedValue(toolCallResponse('linear_get_issues', {}));

      const result = await agent.chat([]);
      expect(result.text).toContain('maximum number of steps');
      expect(mockChatCreate).toHaveBeenCalledTimes(10);
    });
  });

  // ── executeTool ───────────────────────────────────────────────────────────

  describe('executeTool', () => {
    // Tools that pass the full input object through
    it.each([
      ['linear_get_issues',    () => mockLinear.getIssues,    { status: 'Todo' }],
      ['linear_update_issue',  () => mockLinear.updateIssue,  { issueId: 'ENG-1', status: 'Done' }],
      ['linear_create_issue',  () => mockLinear.createIssue,  { title: 'New issue' }],
      ['github_list_prs',      () => mockGitHub.listPRs,      { state: 'open' }],
      ['github_get_pr',        () => mockGitHub.getPR,        { prNumber: 1 }],
      ['github_list_issues',   () => mockGitHub.listIssues,   {}],
      ['github_recent_commits',() => mockGitHub.recentCommits,{}],
      ['github_search_code',   () => mockGitHub.searchCode,   { query: 'sendEmail' }],
      ['github_list_branches', () => mockGitHub.listBranches, {}],
    ])('routes %s passing the input object', async (toolName, getMock, input) => {
      const mock = getMock();
      mock.mockResolvedValue({});
      await agent.executeTool(toolName, input);
      expect(mock).toHaveBeenCalledWith(input);
    });

    // linear_get_issue extracts issueId from the input object
    it('routes linear_get_issue passing issueId string', async () => {
      mockLinear.getIssue.mockResolvedValue({});
      await agent.executeTool('linear_get_issue', { issueId: 'ENG-1' });
      expect(mockLinear.getIssue).toHaveBeenCalledWith('ENG-1');
    });

    // linear_get_cycle extracts teamName from the input object
    it('routes linear_get_cycle passing teamName string', async () => {
      mockLinear.getCycle.mockResolvedValue([]);
      await agent.executeTool('linear_get_cycle', { teamName: 'Engineering' });
      expect(mockLinear.getCycle).toHaveBeenCalledWith('Engineering');
    });

    // No-arg tools
    it('routes linear_get_teams with no arguments', async () => {
      mockLinear.getTeams.mockResolvedValue([]);
      await agent.executeTool('linear_get_teams', {});
      expect(mockLinear.getTeams).toHaveBeenCalledWith();
    });

    it('routes github_list_repos with no arguments', async () => {
      mockGitHub.listRepos.mockResolvedValue([]);
      await agent.executeTool('github_list_repos', {});
      expect(mockGitHub.listRepos).toHaveBeenCalledWith();
    });

    it('throws for an unknown tool name', async () => {
      await expect(agent.executeTool('unknown_tool', {})).rejects.toThrow('Unknown tool: unknown_tool');
    });
  });
});
