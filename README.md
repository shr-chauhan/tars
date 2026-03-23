# 🤖 TARS — Engineering Assistant for Microsoft Teams

An AI-powered Teams bot that gives you instant access to your Linear board and GitHub repos, powered by OpenAI GPT-4o.

## What it can do

| Capability | Example questions |
|---|---|
| **Linear issues** | "Show me all in-progress issues", "What's in the current sprint?", "Show ENG-42" |
| **Linear updates** | "Mark ENG-42 as done", "Assign ENG-10 to Sarah", "Add a comment to ENG-55" |
| **GitHub PRs** | "What PRs are waiting for review?", "Show me PR #123 details" |
| **GitHub branches** | "List all branches in E_Pharma_Backend" |
| **GitHub code** | "Where is the payment service implemented?", "Find all uses of sendEmail" |
| **GitHub commits** | "What was committed to main this week?" |
| **Engineering Q&A** | "How should we structure our auth service?", "What's the difference between X and Y?" |

---

## Architecture

```
Teams Message
     ↓
Azure Bot Service (handles auth + routing)
     ↓
Your Bot Server (Node.js + botbuilder)
     ↓
OpenAI GPT-4o (with tool use)
   ↙           ↘
Linear GraphQL API   GitHub REST API
```

---

## Setup

### Step 1: Create an App Registration in Azure

1. Go to [Azure Portal](https://portal.azure.com) → search **"App Registrations"** → click **New registration**
2. Give it a name like `tars`
3. Under **Supported account types**, select **Single tenant**
4. Click **Register**
5. On the Overview page, copy:
   - **Application (client) ID** → save as `MICROSOFT_APP_ID`
   - **Directory (tenant) ID** → save as `MICROSOFT_TENANT_ID`
6. Go to **Certificates & secrets** → **Client secrets** tab → **+ New client secret**
7. Add a description (e.g. "TARS"), choose expiry (24 months), click **Add**
8. ⚠️ Immediately copy the **Value** (not the Secret ID) → save as `MICROSOFT_APP_PASSWORD`. You cannot see it again after leaving the page.

---

### Step 2: Create the Azure Bot

1. In the Azure Portal search bar, type **"Azure Bot"** → click **Azure Bot** under Marketplace
2. Click **+ Create** and fill in:
   - **Bot handle**: a unique name e.g. `tars-yourcompany`
   - **Subscription**: your subscription
   - **Resource group**: click Create new → name it `tars-rg` → pick your region
   - **Pricing tier**: click Change plan → select **F0 (Free)**
   - **Type of App**: **Single Tenant**
   - **App ID**: paste your `MICROSOFT_APP_ID` from Step 1
3. Click **Review + Create** → **Create**
4. Wait for deployment → click **Go to resource**

> ⚠️ The old Azure Bot Service direct URL (`portal.azure.com/#create/Microsoft.BotServiceConnectivityGallery`) no longer works. Always search for **"Azure Bot"** in the portal search bar instead.

> ⚠️ **User-Assigned Managed Identity**: If you don't see a field to enter your App ID and only see "User-Assigned Managed Identity" as the Type of App option, select it. Azure will manage credentials automatically. After creation, find your App ID by searching "Managed Identities" in the portal → open the created identity → copy the **Client ID**.

> ⚠️ **No Azure subscription?** If you see "Welcome to Azure / Don't have a subscription", click **Start with Azure free trial**. You get $200 credit and the bot runs on the F0 free tier so you won't be charged.

---

### Step 3: Enable the Microsoft Teams Channel

1. Inside your Azure Bot resource, look in the left sidebar for **Channels**
2. Click **Microsoft Teams Commercial** (not Government)
3. Agree to the terms → click **Save**

---

### Step 4: Get API keys

**OpenAI API key:**
- [platform.openai.com](https://platform.openai.com) → API keys → Create new secret key
- Copy to `OPENAI_API_KEY`
- Note: This is separate from a ChatGPT subscription — you need API credits at platform.openai.com

**Linear API key:**
- Linear → Settings → API → Personal API Keys → Create key
- Copy to `LINEAR_API_KEY`

**GitHub token:**
- GitHub → Settings → Developer Settings → Personal Access Tokens (Classic)
- Required scopes: `repo`, `read:org`, `read:user`
- Copy to `GITHUB_TOKEN`

---

### Step 5: Install and run locally

```bash
cd tars

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your keys
```

Your `.env` should look like:
```
OPENAI_API_KEY=sk-...
MICROSOFT_APP_ID=38721fd8-...
MICROSOFT_APP_PASSWORD=your-secret-value
MICROSOFT_TENANT_ID=your-tenant-id
LINEAR_API_KEY=lin_api_...
GITHUB_TOKEN=github_pat_...
GITHUB_DEFAULT_REPO=owner/repo-name
PORT=3978
```

```bash
# Run locally
npm run dev
```

---

### Step 6: Expose locally with ngrok (for local testing only)

> ℹ️ This step is only needed for **local development and testing**. In production, deploy to a real server (see [Deploy](#deploy-production) below) and skip ngrok entirely.

Teams needs a public HTTPS URL to reach your bot.

**Install ngrok:** [ngrok.com](https://ngrok.com) → sign up → download for Windows

```bash
# Add your authtoken (shown in ngrok dashboard after signup)
ngrok config add-authtoken YOUR_AUTH_TOKEN

# Start tunnel (use your static domain if you have one)
ngrok http --url=your-static-domain.ngrok-free.app 3978
```

Free ngrok accounts get a **static domain** — your URL won't change on restart. Find it in your ngrok dashboard under "Domains".

---

### Step 7: Set the messaging endpoint in Azure (point to ngrok for local testing)

> ℹ️ For local testing, use your ngrok URL here. When deploying to production, update this to your real server URL instead.

1. Go to your **Azure Bot** resource → **Configuration**
2. Set **Messaging endpoint** to: `https://your-ngrok-domain.ngrok-free.app/api/messages`
3. Click **Apply**

---

### Step 8: Install in Teams

1. Create a zip with exactly these 3 files (no subfolders):

```powershell
cd c:\path\to\tars\config
Compress-Archive -Path manifest.json, color.png, outline.png -DestinationPath ..\tars.zip -Force
cd ..
```

2. In **Microsoft Teams** → **Apps** (left sidebar) → **Manage your apps** (bottom left) → **Upload an app** → **Upload a custom app**
3. Select `tars.zip`
4. Find **TARS** in your apps and start a chat

> ⚠️ The `validDomains` field in `manifest.json` must contain your ngrok domain, otherwise Teams will reject the manifest.

---

### Step 9: Test with Bot Framework Emulator (optional, local only)

The [Bot Framework Emulator](https://github.com/microsoft/BotFramework-Emulator/releases) lets you chat with the bot without setting up Teams.

1. Download and install the emulator
2. Open it → **File → Open Bot**
3. Fill in:
   - **Bot URL**: `http://localhost:3978/api/messages`
   - **Microsoft App ID**: your App ID
   - **Microsoft App Password**: your App Password
4. Click **Connect**

---

## Deploy (production)

Deploy to any Node.js host. Recommended options:
- **Azure App Service** (integrates naturally with Azure Bot)
- **Railway / Render / Fly.io** (simpler, cheaper)
- **Docker** (see Dockerfile below)

Once deployed, replace every reference to your ngrok URL with your real public URL:
1. **Azure Bot → Configuration → Messaging endpoint** → set to `https://your-domain.com/api/messages`
2. **`config/manifest.json` → `validDomains`** → replace the ngrok domain with your real domain, then re-zip and re-upload to Teams

```bash
docker build -t tars .
docker run -p 3978:3978 --env-file .env tars
```

---

## Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
EXPOSE 3978
CMD ["node", "src/index.js"]
```

---

## Project structure

```
tars/
├── src/
│   ├── index.js          # HTTP server + bot adapter
│   ├── bot.js            # Teams bot activity handler
│   ├── claudeAgent.js    # OpenAI GPT-4o agent with tool use
│   ├── linearClient.js   # Linear GraphQL client
│   └── githubClient.js   # GitHub REST client
├── config/
│   ├── manifest.json     # Teams app manifest
│   ├── color.png         # App icon 192x192
│   └── outline.png       # App icon 32x32
├── .env.example
└── package.json
```

---

## Extending the bot

### Add more Linear tools
Edit `claudeAgent.js` → add to `TOOLS` array, handle in `executeTool()`, implement in `linearClient.js`.

### Add more GitHub capabilities
- List workflow runs (CI/CD status)
- Get file contents for code review questions
- Create issues or PRs from Teams

### Add Confluence / Notion docs
Add a `docsClient.js` and tools for searching your wiki.

### Add Slack/email digest
Schedule a daily summary using cron and post to a Teams channel.

### Integrate a logging / observability platform

Connect the bot to a logging platform like Sentry, Datadog, or Grafana and it can bridge production incidents with code in a single conversation — e.g. *"A customer is reporting slowness in payments, can you check the logs and identify any bottlenecks?"* The bot can pull recent errors or traces and cross-reference them against the relevant code.

---

## License

MIT © 2026 TARS

See [LICENSE](./LICENSE) for the full text.
