require('dotenv').config();
const { BotFrameworkAdapter, TurnContext } = require('botbuilder');
const restify = require('restify');
const { TARSBot } = require('./bot');

// Create HTTP server
const server = restify.createServer();
server.use(restify.plugins.bodyParser());

// Create adapter
const adapter = new BotFrameworkAdapter({
  appId: process.env.MICROSOFT_APP_ID,
  appPassword: process.env.MICROSOFT_APP_PASSWORD,
  channelAuthTenant: process.env.MICROSOFT_TENANT_ID || 'botframework.com',
});

// Error handler
adapter.onTurnError = async (context, error) => {
  console.error('[onTurnError]', error);
  await context.sendActivity('❌ Something went wrong. Please try again.');
};

// Create the bot
const bot = new TARSBot();

// Listen for incoming requests
server.post('/api/messages', async (req, res) => {
  await adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
});

const PORT = process.env.PORT || 3978;
server.listen(PORT, () => {
  console.log(`\n🤖 TARS is running on port ${PORT}`);
  console.log(`📡 Endpoint: http://localhost:${PORT}/api/messages`);
});
