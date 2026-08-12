/**
 * Mango Protocol Launch Monitor Bot
 * ---------------------------------
 * Monitors https://mangoprotocol.site/api/v1/launchpad/tokens
 * and posts new launches to Telegram.
 *
 * Features:
 *  - Detects new token launches
 *  - Sends CA, ticker, name, logo, creator, market cap, graduation status
 *  - Commands: /start, /latest, /status, /token <address>
 */

require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALERT_CHAT_IDS = (process.env.ALERT_CHAT_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 30) * 1000;
const MIN_MARKET_CAP = parseFloat(process.env.MIN_MARKET_CAP_USD) || 0;

const API_BASE = "https://mangoprotocol.site/api/v1";
const SEEN_FILE = path.join(__dirname, "seen-tokens.json");

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is required. Copy .env.example → .env and fill it in.");
  process.exit(1);
}

// ─── Persistence ──────────────────────────────────────────────────────────
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
    }
  } catch (e) {
    console.warn("Could not load seen-tokens.json, starting fresh");
  }
  return new Set();
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 2));
}

let seenTokens = loadSeen();

// ─── Mango API helpers ────────────────────────────────────────────────────
async function fetchLaunches() {
  const res = await fetch(`${API_BASE}/launchpad/tokens`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

async function fetchTokenDetail(address) {
  const res = await fetch(`${API_BASE}/launchpad/token?address=${address}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  return json.data;
}

// ─── Formatting ───────────────────────────────────────────────────────────
function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatLaunch(token, isNew = true) {
  const title = isNew ? "🚀 <b>New Launch on Mango</b>" : "🥭 <b>Mango Token</b>";
  const lines = [
    title,
    "",
    `<b>Name:</b> ${escapeHtml(token.name || "—")}`,
    `<b>Ticker:</b> $${escapeHtml(token.symbol || "—")}`,
    `<b>CA:</b> <code>${token.tokenAddress}</code>`,
    "",
    `<b>Creator:</b> <code>${shortAddr(token.creator)}</code>`,
    `<b>Market Cap:</b> $${Number(token.marketCapUsd || 0).toLocaleString()}`,
    `<b>Graduated:</b> ${token.graduated ? "✅ Yes" : "❌ No"} (threshold $${Number(token.graduationThresholdUsd || 30000).toLocaleString()})`,
    `<b>Holders:</b> ${token.holders ?? "—"}`,
  ];

  if (token.createdAt) {
    const date = new Date(token.createdAt).toUTCString();
    lines.push(`<b>Launched:</b> ${date}`);
  }

  lines.push("");
  lines.push(`🔗 <a href="https://mangoprotocol.site">mangoprotocol.site</a>`);

  return lines.join("\n");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function makeKeyboard(token) {
  return new InlineKeyboard()
    .url("Open Mango", "https://mangoprotocol.site")
    .row()
    .copyText("Copy CA", token.tokenAddress);
}

// ─── Alert sender ─────────────────────────────────────────────────────────
async function sendLaunchAlert(bot, token) {
  if (MIN_MARKET_CAP > 0 && Number(token.marketCapUsd || 0) < MIN_MARKET_CAP) {
    console.log(`Skipping ${token.symbol} — market cap below threshold`);
    return;
  }

  const text = formatLaunch(token, true);
  const keyboard = makeKeyboard(token);

  for (const chatId of ALERT_CHAT_IDS) {
    try {
      // Try sending with logo if available
      if (token.logoUrl) {
        await bot.api.sendPhoto(chatId, token.logoUrl, {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } else {
        await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          disable_web_page_preview: false,
        });
      }
      console.log(`✅ Alert sent to ${chatId} for $${token.symbol}`);
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message);
      // Fallback to text-only if photo fails
      try {
        await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (e2) {
        console.error(`Fallback also failed for ${chatId}:`, e2.message);
      }
    }
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────
async function checkForNewLaunches(bot) {
  try {
    const launches = await fetchLaunches();
    let newCount = 0;

    for (const token of launches) {
      const ca = (token.tokenAddress || "").toLowerCase();
      if (!ca || seenTokens.has(ca)) continue;

      // New launch!
      seenTokens.add(ca);
      newCount++;
      console.log(`🆕 New launch detected: $${token.symbol} (${token.tokenAddress})`);
      await sendLaunchAlert(bot, token);
    }

    if (newCount > 0) {
      saveSeen(seenTokens);
    } else {
      console.log(`[${new Date().toISOString()}] No new launches (${launches.length} total tracked)`);
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
}

// ─── Bot commands ─────────────────────────────────────────────────────────
const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  await ctx.reply(
    `🥭 <b>Mango Launch Monitor</b>\n\n` +
      `I watch Mango Protocol for new token launches and post alerts.\n\n` +
      `<b>Commands:</b>\n` +
      `/latest — show the most recent launches\n` +
      `/status — bot status & tracked tokens\n` +
      `/token &lt;address&gt; — details for a specific CA\n\n` +
      `Alerts are sent to configured channels automatically.`,
    { parse_mode: "HTML" }
  );
});

bot.command("status", async (ctx) => {
  const launches = await fetchLaunches().catch(() => []);
  await ctx.reply(
    `📊 <b>Status</b>\n\n` +
      `• Tracked tokens: <b>${seenTokens.size}</b>\n` +
      `• Currently on API: <b>${launches.length}</b>\n` +
      `• Poll interval: <b>${POLL_INTERVAL_MS / 1000}s</b>\n` +
      `• Alert chats: <b>${ALERT_CHAT_IDS.length}</b>\n` +
      `• Min market cap filter: <b>$${MIN_MARKET_CAP}</b>`,
    { parse_mode: "HTML" }
  );
});

bot.command("latest", async (ctx) => {
  try {
    const launches = await fetchLaunches();
    if (!launches.length) {
      return ctx.reply("No launches found on Mango yet.");
    }

    // Sort by createdAt descending
    const sorted = [...launches].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const top = sorted.slice(0, 5);

    for (const token of top) {
      const text = formatLaunch(token, false);
      const keyboard = makeKeyboard(token);
      if (token.logoUrl) {
        await ctx.replyWithPhoto(token.logoUrl, {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } else {
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      }
    }
  } catch (err) {
    await ctx.reply(`Error fetching launches: ${err.message}`);
  }
});

bot.command("token", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !address.startsWith("0x")) {
    return ctx.reply("Usage: /token 0xYourContractAddress");
  }

  try {
    const data = await fetchTokenDetail(address);
    const token = data.token || data;
    const text = formatLaunch(token, false);

    // Add recent trades summary if available
    let extra = "";
    if (data.trades?.length) {
      const buys = data.trades.filter((t) => t.isBuy).length;
      const sells = data.trades.filter((t) => !t.isBuy).length;
      extra = `\n\n📈 Recent trades: ${buys} buys / ${sells} sells (last ${data.trades.length})`;
    }

    const keyboard = makeKeyboard(token);
    if (token.logoUrl) {
      await ctx.replyWithPhoto(token.logoUrl, {
        caption: text + extra,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(text + extra, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    await ctx.reply(`Could not fetch token: ${err.message}`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────
async function main() {
  console.log("🥭 Mango Launch Monitor starting...");

  // Seed seen tokens so we don't spam old launches on first run
  try {
    const existing = await fetchLaunches();
    for (const t of existing) {
      if (t.tokenAddress) seenTokens.add(t.tokenAddress.toLowerCase());
    }
    saveSeen(seenTokens);
    console.log(`Seeded ${seenTokens.size} existing tokens (won't re-alert)`);
  } catch (e) {
    console.warn("Could not seed existing tokens:", e.message);
  }

  // Start polling
  setInterval(() => checkForNewLaunches(bot), POLL_INTERVAL_MS);
  // Run once immediately after a short delay
  setTimeout(() => checkForNewLaunches(bot), 3000);

  // Start bot
  bot.start({
    onStart: (info) => console.log(`✅ Bot @${info.username} is running`),
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
