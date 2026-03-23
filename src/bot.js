const { ActivityHandler, MessageFactory, CardFactory } = require('botbuilder');
const { ClaudeAgent } = require('./claudeAgent');

class TARSBot extends ActivityHandler {
  constructor() {
    super();
    this.agent = new ClaudeAgent();
    // Store conversation history per user
    this.conversationHistory = new Map();

    this.onMessage(async (context, next) => {
      const userId = context.activity.from.id;
      const userName = context.activity.from.name;
      const userMessage = context.activity.text?.trim();

      if (!userMessage) {
        await next();
        return;
      }

      // Show typing indicator
      await context.sendActivity({ type: 'typing' });

      // Get or initialize conversation history
      if (!this.conversationHistory.has(userId)) {
        this.conversationHistory.set(userId, []);
      }
      const history = this.conversationHistory.get(userId);

      // Add user message to history
      history.push({ role: 'user', content: userMessage });

      try {
        // Get response from Claude agent
        const response = await this.agent.chat(history, userName);

        // Add assistant response to history
        history.push({ role: 'assistant', content: response.text });

        // Keep history manageable (last 20 turns)
        if (history.length > 40) {
          this.conversationHistory.set(userId, history.slice(-40));
        }

        // Send response back to Teams
        await context.sendActivity(MessageFactory.text(response.text));

        // If there's structured data (e.g. issue list), send as adaptive card
        if (response.card) {
          await context.sendActivity({
            attachments: [CardFactory.adaptiveCard(response.card)],
          });
        }
      } catch (error) {
        console.error('Bot error:', error);
        await context.sendActivity('❌ I ran into an error: ' + error.message);
      }

      await next();
    });

    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            `**TARS online.**\n\n` +
            `I have access to Linear, GitHub, and Outlook. Tell me what you need.\n\n` +
            `- Linear: issues, stories, sprint status, cycle progress\n` +
            `- GitHub: PRs, commits, open issues, code search\n` +
            `- Outlook: inbox, unread emails, search by keyword or sender\n\n` +
            `_Honesty setting: 90%. Humor setting: somewhere between dry and arid._`
          );
        }
      }
      await next();
    });
  }
}

module.exports = { TARSBot };
