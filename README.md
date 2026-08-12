# 🥭 Mango Launch Monitor Bot

Telegram bot that watches [Mango Protocol](https://mangoprotocol.site) for new token launches and posts alerts with:

- Contract Address (CA)
- Ticker & Name
- Logo
- Creator
- Market Cap
- Graduation status
- Holders

## Quick Start

### 1. Create a Telegram Bot
1. Open Telegram and talk to [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token**

### 2. Get your Chat / Channel ID
- For personal chat: message [@userinfobot](https://t.me/userinfobot)
- For a channel: add the bot as admin, then forward a channel message to `@userinfobot` or use a bot like `@getidsbot`

### 3. Configure
```bash
cp .env.example .env
```

Edit `.env`:
```env
BOT_TOKEN=your_bot_token_here
ALERT_CHAT_IDS=-100xxxxxxxxxx,123456789
POLL_INTERVAL_SECONDS=30
MIN_MARKET_CAP_USD=0
```

### 4. Install & Run
```bash
npm install
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + help |
| `/latest` | Show the 5 most recent launches |
| `/status` | Bot status (tracked tokens, poll interval…) |
| `/token 0x...` | Details for a specific contract address |

## How it works

1. On startup it seeds all currently known launches so it **doesn't spam old ones**.
2. Every `POLL_INTERVAL_SECONDS` it calls:
   ```
   GET https://mangoprotocol.site/api/v1/launchpad/tokens
   ```
3. Any new `tokenAddress` triggers an alert to all `ALERT_CHAT_IDS`.
4. Seen tokens are saved in `seen-tokens.json` so restarts don't re-alert.

## Notes

- **Social links** (X / Telegram) are not currently returned by Mango’s public API, so they are not included.
- Logos are sent as photos when available.
- The bot is non-custodial and read-only — it only monitors public data.

## Deploy

Works on any Node.js host:

- Railway
- Render
- Fly.io
- A simple VPS (`pm2 start index.js`)

Make sure the process stays alive and has network access to `mangoprotocol.site`.
