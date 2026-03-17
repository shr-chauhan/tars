// Mock botbuilder before anything else so the ActivityHandler constructor
// can be intercepted and the registered handlers captured for direct testing.
jest.mock('botbuilder', () => ({
  ActivityHandler: jest.fn(),
  MessageFactory: { text: jest.fn((text) => ({ type: 'message', text })) },
  CardFactory: { adaptiveCard: jest.fn((card) => card) },
}));

jest.mock('../src/claudeAgent', () => ({ ClaudeAgent: jest.fn() }));

const { ActivityHandler } = require('botbuilder');
const { ClaudeAgent } = require('../src/claudeAgent');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeMockContext(overrides = {}) {
  return {
    activity: {
      from: { id: 'user-123', name: 'Shrey Chauhan' },
      text: 'Show me issues',
      ...overrides.activity,
    },
    sendActivity: jest.fn(),
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('EngBot', () => {
  let bot;
  let mockAgent;
  let messageHandler;
  let membersAddedHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    messageHandler = undefined;
    membersAddedHandler = undefined;

    // Set up the ClaudeAgent mock
    mockAgent = { chat: jest.fn().mockResolvedValue({ text: 'Bot reply' }) };
    ClaudeAgent.mockImplementation(() => mockAgent);

    // Capture the handlers the bot registers during construction
    ActivityHandler.mockImplementation(function () {
      this.onMessage = (handler) => { messageHandler = handler; };
      this.onMembersAdded = (handler) => { membersAddedHandler = handler; };
    });

    const { EngBot } = require('../src/bot');
    bot = new EngBot();
  });

  // ── constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('initializes an empty conversation history Map', () => {
      expect(bot.conversationHistory).toBeInstanceOf(Map);
      expect(bot.conversationHistory.size).toBe(0);
    });

    it('registers a message handler', () => {
      expect(messageHandler).toBeInstanceOf(Function);
    });

    it('registers a membersAdded handler', () => {
      expect(membersAddedHandler).toBeInstanceOf(Function);
    });
  });

  // ── message handler ───────────────────────────────────────────────────────

  describe('message handler', () => {
    it('creates a new history entry for a first-time user', async () => {
      const ctx = makeMockContext();
      const next = jest.fn();

      await messageHandler(ctx, next);

      expect(bot.conversationHistory.has('user-123')).toBe(true);
    });

    it('appends user message and assistant reply to history', async () => {
      const ctx = makeMockContext({ activity: { from: { id: 'user-1' }, text: 'Hello' } });
      const next = jest.fn();

      await messageHandler(ctx, next);

      const history = bot.conversationHistory.get('user-1');
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Bot reply' });
    });

    it('preserves history across multiple messages from the same user', async () => {
      const userId = 'user-abc';
      const next = jest.fn();

      mockAgent.chat
        .mockResolvedValueOnce({ text: 'First reply' })
        .mockResolvedValueOnce({ text: 'Second reply' });

      await messageHandler(makeMockContext({ activity: { from: { id: userId }, text: 'Msg 1' } }), next);
      await messageHandler(makeMockContext({ activity: { from: { id: userId }, text: 'Msg 2' } }), next);

      const history = bot.conversationHistory.get(userId);
      expect(history).toHaveLength(4);
      expect(history[2]).toEqual({ role: 'user', content: 'Msg 2' });
      expect(history[3]).toEqual({ role: 'assistant', content: 'Second reply' });
    });

    it('keeps separate history per user', async () => {
      const next = jest.fn();

      await messageHandler(makeMockContext({ activity: { from: { id: 'user-A' }, text: 'Hi from A' } }), next);
      await messageHandler(makeMockContext({ activity: { from: { id: 'user-B' }, text: 'Hi from B' } }), next);

      expect(bot.conversationHistory.get('user-A')[0].content).toBe('Hi from A');
      expect(bot.conversationHistory.get('user-B')[0].content).toBe('Hi from B');
    });

    it('trims history to the last 40 messages when it exceeds 40', async () => {
      const userId = 'heavy-user';
      // Pre-fill with 40 messages
      bot.conversationHistory.set(userId, Array(40).fill({ role: 'user', content: 'old' }));

      await messageHandler(
        makeMockContext({ activity: { from: { id: userId }, text: 'new message' } }),
        jest.fn()
      );

      // 40 old + 1 user + 1 assistant = 42, trimmed to 40
      expect(bot.conversationHistory.get(userId)).toHaveLength(40);
    });

    it('passes the full history to the agent', async () => {
      const userId = 'user-xyz';
      bot.conversationHistory.set(userId, [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'old reply' }]);

      await messageHandler(
        makeMockContext({ activity: { from: { id: userId }, text: 'new question' } }),
        jest.fn()
      );

      // history is passed by reference; by inspection time the assistant reply is
      // already appended, so we see 4 items (2 old + 1 user + 1 assistant)
      const historyPassedToAgent = mockAgent.chat.mock.calls[0][0];
      expect(historyPassedToAgent).toHaveLength(4);
      expect(historyPassedToAgent[2]).toEqual({ role: 'user', content: 'new question' });
      expect(historyPassedToAgent[3]).toEqual({ role: 'assistant', content: 'Bot reply' });
    });

    it('sends the agent reply back to Teams', async () => {
      const ctx = makeMockContext();
      await messageHandler(ctx, jest.fn());
      expect(ctx.sendActivity).toHaveBeenCalledWith(expect.objectContaining({ text: 'Bot reply' }));
    });

    it('passes the Teams display name to the agent as userName', async () => {
      const ctx = makeMockContext({ activity: { from: { id: 'user-1', name: 'Shrey Chauhan' }, text: 'Show my issues' } });
      await messageHandler(ctx, jest.fn());
      expect(mockAgent.chat).toHaveBeenCalledWith(expect.any(Array), 'Shrey Chauhan');
    });

    it('calls next() after handling the message', async () => {
      const next = jest.fn();
      await messageHandler(makeMockContext(), next);
      expect(next).toHaveBeenCalled();
    });

    it('skips processing and calls next() when message text is empty', async () => {
      const ctx = makeMockContext({ activity: { from: { id: 'user-1' }, text: '' } });
      const next = jest.fn();

      await messageHandler(ctx, next);

      expect(mockAgent.chat).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('skips processing when message text is whitespace only', async () => {
      const ctx = makeMockContext({ activity: { from: { id: 'user-1' }, text: '   ' } });
      const next = jest.fn();

      await messageHandler(ctx, next);

      expect(mockAgent.chat).not.toHaveBeenCalled();
    });

    it('sends an error message and still calls next() when the agent throws', async () => {
      mockAgent.chat.mockRejectedValue(new Error('OpenAI timeout'));
      const ctx = makeMockContext();
      const next = jest.fn();

      await messageHandler(ctx, next);

      expect(ctx.sendActivity).toHaveBeenCalledWith(expect.stringContaining('OpenAI timeout'));
      expect(next).toHaveBeenCalled();
    });

    it('does not pollute history when the agent throws', async () => {
      mockAgent.chat.mockRejectedValue(new Error('API error'));
      const userId = 'error-user';
      const ctx = makeMockContext({ activity: { from: { id: userId }, text: 'Crash me' } });

      await messageHandler(ctx, jest.fn());

      // User message was appended before the agent call, but no assistant reply should be added
      const history = bot.conversationHistory.get(userId);
      expect(history.every(m => m.role !== 'assistant')).toBe(true);
    });
  });

  // ── membersAdded handler ──────────────────────────────────────────────────

  describe('membersAdded handler', () => {
    it('sends a welcome message to new members (not the bot itself)', async () => {
      const ctx = {
        activity: {
          membersAdded: [{ id: 'new-user-id' }],
          recipient: { id: 'bot-id' },
        },
        sendActivity: jest.fn(),
      };

      await membersAddedHandler(ctx, jest.fn());

      expect(ctx.sendActivity).toHaveBeenCalledTimes(1);
      const msg = ctx.sendActivity.mock.calls[0][0];
      expect(msg).toContain('Eng Bot');
    });

    it('does not send a welcome message to the bot itself', async () => {
      const ctx = {
        activity: {
          membersAdded: [{ id: 'bot-id' }],
          recipient: { id: 'bot-id' },
        },
        sendActivity: jest.fn(),
      };

      await membersAddedHandler(ctx, jest.fn());

      expect(ctx.sendActivity).not.toHaveBeenCalled();
    });

    it('sends welcome to each new human member', async () => {
      const ctx = {
        activity: {
          membersAdded: [{ id: 'user-1' }, { id: 'user-2' }],
          recipient: { id: 'bot-id' },
        },
        sendActivity: jest.fn(),
      };

      await membersAddedHandler(ctx, jest.fn());

      expect(ctx.sendActivity).toHaveBeenCalledTimes(2);
    });

    it('calls next() after handling membersAdded', async () => {
      const next = jest.fn();
      const ctx = {
        activity: { membersAdded: [], recipient: { id: 'bot-id' } },
        sendActivity: jest.fn(),
      };

      await membersAddedHandler(ctx, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
