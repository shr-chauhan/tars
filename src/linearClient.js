const axios = require('axios');

const LINEAR_API_URL = 'https://api.linear.app/graphql';

class LinearClient {
  constructor() {
    this.apiKey = process.env.LINEAR_API_KEY;
    if (!this.apiKey) throw new Error('LINEAR_API_KEY is not set');
  }

  async query(gql, variables = {}) {
    const res = await axios.post(
      LINEAR_API_URL,
      { query: gql, variables },
      {
        headers: {
          Authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
      }
    );
    if (res.data.errors) throw new Error(res.data.errors[0].message);
    return res.data.data;
  }

  // ── Get issues with optional filters ──────────────────────────────────────
  async getIssues({ status, assignee, teamName, priority, currentCycle, completedAfter, completedBefore, limit } = {}) {
    // Use a high limit when filtering by assignee or date so we don't miss results
    const effectiveLimit = limit ?? (assignee || completedAfter || completedBefore ? 250 : 50);
    const filters = [];
    if (status) filters.push(`state: { name: { eq: "${status}" } }`);
    if (priority !== undefined) filters.push(`priority: { eq: ${priority} }`);
    if (currentCycle) filters.push(`cycle: { isActive: { eq: true } }`);
    // Note: assignee is intentionally NOT added to GraphQL filter — Linear name fields
    // may not match display names (users often identified by email). We filter client-side
    // against both name and email for reliability.
    if (completedAfter || completedBefore) {
      const dateParts = [];
      if (completedAfter) dateParts.push(`gte: "${completedAfter}"`);
      if (completedBefore) dateParts.push(`lte: "${completedBefore}"`);
      filters.push(`completedAt: { ${dateParts.join(', ')} }`);
    }

    const filterStr = filters.length ? `filter: { ${filters.join(', ')} }` : '';

    const gql = `
      query GetIssues {
        issues(first: ${effectiveLimit} ${filterStr ? `, ${filterStr}` : ''}) {
          nodes {
            id
            identifier
            title
            priority
            state { name }
            assignee { name email }
            team { name }
            cycle { name startsAt endsAt isActive }
            createdAt
            updatedAt
            completedAt
            url
          }
        }
      }
    `;
    const data = await this.query(gql);
    let issues = data.issues.nodes;

    // Client-side filters
    if (teamName) {
      issues = issues.filter(i => i.team?.name?.toLowerCase().includes(teamName.toLowerCase()));
    }
    if (assignee && assignee !== 'me') {
      const words = assignee.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const haystack = i => `${i.assignee?.name || ''} ${i.assignee?.email || ''}`.toLowerCase();

      // Try strict: all words must appear somewhere in name+email combined
      let filtered = issues.filter(i => words.every(w => haystack(i).includes(w)));

      // Fallback: any single word matches (handles first-name-only Linear profiles)
      if (filtered.length === 0) {
        console.log(`[Linear] Strict match for "${assignee}" found 0 results, trying partial match`);
        console.log(`[Linear] Unique assignees in results:`, [...new Set(issues.map(i => `${i.assignee?.name} <${i.assignee?.email}>`))].slice(0, 10));
        filtered = issues.filter(i => words.some(w => haystack(i).includes(w)));
      }

      issues = filtered;
    }

    return {
      count: issues.length,
      issues: issues.map(this._formatIssue),
    };
  }

  // ── Get single issue ───────────────────────────────────────────────────────
  async getIssue(issueId) {
    const gql = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id identifier title description priority
          state { name }
          assignee { name email }
          team { name }
          cycle { name isActive }
          labels { nodes { name } }
          comments { nodes { body createdAt user { name } } }
          createdAt updatedAt url
        }
      }
    `;
    // Linear accepts identifier like ENG-123 or internal UUID
    const data = await this.query(gql, { id: issueId });
    return this._formatIssue(data.issue, true);
  }

  // ── Update an issue ────────────────────────────────────────────────────────
  async updateIssue({ issueId, status, assigneeName, priority, comment }) {
    const results = [];

    if (status || assigneeName || priority !== undefined) {
      // Find state ID if status provided
      let stateId;
      if (status) {
        const states = await this.query(`
          query { workflowStates { nodes { id name } } }
        `);
        const state = states.workflowStates.nodes.find(
          s => s.name.toLowerCase() === status.toLowerCase()
        );
        if (!state) throw new Error(`Status "${status}" not found`);
        stateId = state.id;
      }

      // Find assignee ID if provided
      let assigneeId;
      if (assigneeName) {
        const users = await this.query(`
          query { users { nodes { id name } } }
        `);
        const user = users.users.nodes.find(
          u => u.name.toLowerCase().includes(assigneeName.toLowerCase())
        );
        if (!user) throw new Error(`User "${assigneeName}" not found`);
        assigneeId = user.id;
      }

      const updateFields = [];
      if (stateId) updateFields.push(`stateId: "${stateId}"`);
      if (assigneeId) updateFields.push(`assigneeId: "${assigneeId}"`);
      if (priority !== undefined) updateFields.push(`priority: ${priority}`);

      const gql = `
        mutation UpdateIssue($id: String!) {
          issueUpdate(id: $id, input: { ${updateFields.join(', ')} }) {
            success
            issue { identifier title state { name } assignee { name } }
          }
        }
      `;
      const data = await this.query(gql, { id: issueId });
      results.push({ updated: data.issueUpdate.issue });
    }

    if (comment) {
      // Get the issue UUID first (in case issueId is an identifier like ENG-123)
      const issueData = await this.getIssue(issueId);
      const gql = `
        mutation AddComment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
            comment { id createdAt }
          }
        }
      `;
      const data = await this.query(gql, { issueId: issueData.id || issueId, body: comment });
      results.push({ commentAdded: data.commentCreate.success });
    }

    return { success: true, results };
  }

  // ── Create an issue ────────────────────────────────────────────────────────
  async createIssue({ title, description, teamName, priority, assigneeName }) {
    // Find team ID
    const teams = await this.query(`query { teams { nodes { id name } } }`);
    let team = teams.teams.nodes[0]; // default to first team
    if (teamName) {
      const found = teams.teams.nodes.find(t => t.name.toLowerCase().includes(teamName.toLowerCase()));
      if (found) team = found;
    }

    const fields = [`teamId: "${team.id}"`, `title: "${title}"`];
    if (description) fields.push(`description: "${description.replace(/"/g, '\\"')}"`);
    if (priority) fields.push(`priority: ${priority}`);

    if (assigneeName) {
      const users = await this.query(`query { users { nodes { id name } } }`);
      const user = users.users.nodes.find(u => u.name.toLowerCase().includes(assigneeName.toLowerCase()));
      if (user) fields.push(`assigneeId: "${user.id}"`);
    }

    const gql = `
      mutation CreateIssue {
        issueCreate(input: { ${fields.join(', ')} }) {
          success
          issue { identifier title url state { name } }
        }
      }
    `;
    const data = await this.query(gql);
    return data.issueCreate;
  }

  // ── Get teams ─────────────────────────────────────────────────────────────
  async getTeams() {
    const data = await this.query(`
      query {
        teams {
          nodes {
            id name description
          }
        }
      }
    `);
    return data.teams.nodes;
  }

  // ── Get active cycle ──────────────────────────────────────────────────────
  async getCycle(teamName) {
    const data = await this.query(`
      query {
        cycles(filter: { isActive: { eq: true } }) {
          nodes {
            id name number startsAt endsAt
            team { name }
            issues { nodes { identifier title state { name } assignee { name } priority } }
          }
        }
      }
    `);
    let cycles = data.cycles.nodes;
    if (teamName) {
      cycles = cycles.filter(c => c.team?.name?.toLowerCase().includes(teamName.toLowerCase()));
    }
    return cycles;
  }

  _formatIssue(issue, full = false) {
    const priorityMap = { 0: 'None', 1: '🔴 Urgent', 2: '🟠 High', 3: '🟡 Medium', 4: '🟢 Low' };
    const base = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.state?.name,
      assignee: issue.assignee?.name || 'Unassigned',
      team: issue.team?.name,
      priority: priorityMap[issue.priority] || 'None',
      cycle: issue.cycle?.name,
      completedAt: issue.completedAt || null,
      url: issue.url,
    };
    if (full) {
      return {
        ...base,
        description: issue.description,
        labels: issue.labels?.nodes?.map(l => l.name),
        comments: issue.comments?.nodes?.map(c => ({
          author: c.user?.name,
          body: c.body,
          date: c.createdAt,
        })),
      };
    }
    return base;
  }
}

module.exports = { LinearClient };
