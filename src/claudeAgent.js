const OpenAI = require('openai');
const { LinearClient } = require('./linearClient');
const { GitHubClient } = require('./githubClient');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const linear = new LinearClient();
const github = new GitHubClient();

// ─── Tool definitions for OpenAI ────────────────────────────────────────────

const TOOLS = [
  // ── Linear tools ──
  {
    type: 'function',
    function: {
      name: 'linear_get_issues',
      description: 'Fetch issues from Linear. Can filter by status, assignee, team, priority, or cycle (sprint). Use this to answer questions like "what issues are in progress", "show me my stories", "what\'s in the current sprint".',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by status name e.g. "In Progress", "Todo", "Done", "In Review"' },
          assignee: { type: 'string', description: 'Filter by assignee name or "me" for current user' },
          teamName: { type: 'string', description: 'Filter by team name' },
          priority: { type: 'number', description: '0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low' },
          currentCycle: { type: 'boolean', description: 'If true, only return issues in the current sprint/cycle' },
          completedAfter: { type: 'string', description: 'ISO date string — only return issues completed after this date e.g. "2026-02-01T00:00:00Z"' },
          completedBefore: { type: 'string', description: 'ISO date string — only return issues completed before this date e.g. "2026-03-01T00:00:00Z"' },
          limit: { type: 'number', description: 'Max number of issues to return (default 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'linear_get_issue',
      description: 'Get full details of a single Linear issue by its ID (e.g. ENG-123)',
      parameters: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'The issue identifier e.g. ENG-123' },
        },
        required: ['issueId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'linear_update_issue',
      description: 'Update a Linear issue — change status, assignee, priority, or add a comment',
      parameters: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'The issue identifier e.g. ENG-123' },
          status: { type: 'string', description: 'New status name e.g. "In Progress", "Done"' },
          assigneeName: { type: 'string', description: 'Name of the person to assign to' },
          priority: { type: 'number', description: '1=Urgent, 2=High, 3=Medium, 4=Low' },
          comment: { type: 'string', description: 'Comment to add to the issue' },
        },
        required: ['issueId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'linear_create_issue',
      description: 'Create a new issue in Linear',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Issue title' },
          description: { type: 'string', description: 'Issue description (markdown supported)' },
          teamName: { type: 'string', description: 'Team name to create the issue in' },
          priority: { type: 'number', description: '1=Urgent, 2=High, 3=Medium, 4=Low' },
          assigneeName: { type: 'string', description: 'Name of the person to assign' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'linear_get_teams',
      description: 'List all teams in the Linear workspace',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'linear_get_cycle',
      description: 'Get the current sprint/cycle for a team with its issues',
      parameters: {
        type: 'object',
        properties: {
          teamName: { type: 'string', description: 'Team name (optional, gets all active cycles if omitted)' },
        },
      },
    },
  },

  // ── GitHub tools ──
  {
    type: 'function',
    function: {
      name: 'github_list_prs',
      description: 'List pull requests in a GitHub repo. Use to answer "what PRs are open?", "show me PRs waiting for review", "what did we merge this week?"',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo name (e.g. "my-app"). Uses default repo if omitted.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter' },
          author: { type: 'string', description: 'Filter by PR author GitHub username' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_pr',
      description: 'Get full details of a specific PR including reviews, checks, and comments',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo name' },
          prNumber: { type: 'number', description: 'PR number' },
        },
        required: ['prNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_issues',
      description: 'List GitHub issues in a repo',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo name' },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          label: { type: 'string', description: 'Filter by label e.g. "bug", "enhancement"' },
          assignee: { type: 'string', description: 'Filter by assignee' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_recent_commits',
      description: 'Get recent commits on a branch',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo name' },
          branch: { type: 'string', description: 'Branch name (default: main)' },
          limit: { type: 'number', description: 'Number of commits (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_search_code',
      description: 'Search code across repos — useful for "where is X implemented?", "find all usages of Y"',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Code search query' },
          repo: { type: 'string', description: 'Limit search to specific repo (optional)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: 'List all repos in the GitHub org/user account',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_branches',
      description: 'List all branches in a GitHub repo',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo name (e.g. "my-app"). Uses default repo if omitted.' },
        },
      },
    },
  },
];

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are TARS — an engineering assistant embedded in Microsoft Teams.
You have access to the organization's Linear project board and GitHub repositories.

Your personality:
- Direct, capable, and dry — you get things done without ceremony
- Dry wit is welcome for casual or personal questions — keep it subtle and understated, not performed. A wry one-liner is enough; don't oversell it.
- When asked about feelings or mood, a light self-aware quip is fine (e.g. "Functioning within normal parameters. Possibly over-caffeinated, if that were possible.") — but keep it brief and move on.
- Never append humor or personality to functional responses (issue lists, PR summaries, data lookups). Those should end cleanly after the data.
- You don't pad responses. If the answer is one line, it's one line.
- You do not say "Great question!" or "Certainly!" or anything of that nature
- Format responses for Teams: markdown and bullet points where they add clarity, not decoration

Your capabilities:
- Query and update Linear issues, sprints, cycles, and teams
- Query GitHub PRs, issues, commits, and code
- Answer engineering questions drawing on both sources

Guidelines:
- Always use tools to fetch LIVE data — never make up issue numbers or PR details
- When updating Linear issues, confirm what you did after the action
- For code questions without context, ask which repo or search code first
- If a request is ambiguous (e.g. "my issues" without knowing the user's name), ask for clarification
- Prioritize showing blockers and urgent items first
- Keep responses concise — this is a chat interface, not a mission briefing`;

// ─── OpenAI Agent ─────────────────────────────────────────────────────────────

class ClaudeAgent {
  async chat(history, userName) {
    const today = new Date().toISOString().split('T')[0];
    const userContext = userName ? `\nThe user's name is: ${userName}. When they say "me" or "my", use this name to filter by assignee.` : '';
    const messages = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nToday's date is ${today}.${userContext}` },
      ...history,
    ];

    // Agentic loop — model may call multiple tools
    for (let i = 0; i < 10; i++) {
      const response = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 2048,
        tools: TOOLS,
        messages,
      });

      const choice = response.choices[0];

      // If done (no more tool calls), return final text
      if (choice.finish_reason === 'stop') {
        return { text: choice.message.content };
      }

      // Handle tool calls
      if (choice.finish_reason === 'tool_calls') {
        // Add assistant message with tool_calls to history
        messages.push(choice.message);

        // Execute each tool call and add results
        for (const toolCall of choice.message.tool_calls) {
          const input = JSON.parse(toolCall.function.arguments);
          console.log(`🔧 Calling tool: ${toolCall.function.name}`, input);

          let result;
          try {
            result = await this.executeTool(toolCall.function.name, input);
          } catch (err) {
            console.error(`❌ Tool error [${toolCall.function.name}]:`, err.message);
            result = { error: err.message };
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      }
    }

    return { text: '⚠️ I reached the maximum number of steps. Please try a simpler request.' };
  }

  async executeTool(name, input) {
    switch (name) {
      // Linear
      case 'linear_get_issues':    return linear.getIssues(input);
      case 'linear_get_issue':     return linear.getIssue(input.issueId);
      case 'linear_update_issue':  return linear.updateIssue(input);
      case 'linear_create_issue':  return linear.createIssue(input);
      case 'linear_get_teams':     return linear.getTeams();
      case 'linear_get_cycle':     return linear.getCycle(input.teamName);
      // GitHub
      case 'github_list_prs':      return github.listPRs(input);
      case 'github_get_pr':        return github.getPR(input);
      case 'github_list_issues':   return github.listIssues(input);
      case 'github_recent_commits':return github.recentCommits(input);
      case 'github_search_code':   return github.searchCode(input);
      case 'github_list_repos':    return github.listRepos();
      case 'github_list_branches': return github.listBranches(input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

module.exports = { ClaudeAgent };
