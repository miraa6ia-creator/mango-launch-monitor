/**
 * Vercel serverless function for Mango Launch Monitor Bot
 * Handles Telegram webhooks + background polling via cron (optional)
 */

const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALERT_CHAT_IDS = (process.env.ALERT_CHAT_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const MIN_MARKET_CAP = parseFloat(process.env.MIN_MARKET_CAP_USD) || 0;
const API_BASE = "https://mangoprotocol.site/api/v1";

// In-memory seen tokens (resets on cold start — acceptable for low-volume)
const seenTokens = new Set();
let seeded = false;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing");
}

const bot = new Bot(BOT_TOKEN || "dummy");

// ─── Helpers ──────────────────────────────────────────────────────────────
function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    lines.push(`<b>Launched:</b> ${new Date(token.createdAt).toUTCString()}`);
  }
  lines.push("", `🔗 <a href="https://mangoprotocol.site">mangoprotocol.site</a>`);
  return lines.join("\n");
}

function makeKeyboard(token) {
  return new InlineKeyboard()
    .url("Open Mango", "https://mangoprotocol.site")
    .row()
    .copyText("Copy CA", token.tokenAddress);
}

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

async function sendLaunchAlert(token) {
  if (MIN_MARKET_CAP > 0 && Number(token.marketCapUsd || 0) < MIN_MARKET_CAP) return;

  const text = formatLaunch(token, true);
  const keyboard = makeKeyboard(token);

  for (const chatId of ALERT_CHAT_IDS) {
    try {
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
        });
      }
    } catch (err) {
      console.error(`Failed to send to ${chatId}:`, err.message);
      try {
        await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (e2) {
        console.error(`Fallback failed:`, e2.message);
      }
    }
  }
}

async function seedAndCheck() {
  try {
    const launches = await fetchLaunches();

    if (!seeded) {
      for (const t of launches) {
        if (t.tokenAddress) seenTokens.add(t.tokenAddress.toLowerCase());
      }
      seeded = true;
      console.log(`Seeded ${seenTokens.size} tokens`);
      return;
    }

    for (const token of launches) {
      const ca = (token.tokenAddress || "").toLowerCase();
      if (!ca || seenTokens.has(ca)) continue;
      seenTokens.add(ca);
      console.log(`New launch: $${token.symbol}`);
      await sendLaunchAlert(token);
    }
  } catch (err) {
    console.error("Check error:", err.message);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  await ctx.reply(
    `🥭 <b>Mango Launch Monitor</b>\n\n` +
      `I watch Mango Protocol for new token launches and post alerts.\n\n` +
      `<b>Commands:</b>\n` +
      `/latest — show recent launches\n` +
      `/status — bot status\n` +
      `/token &lt;address&gt; — token details\n` +
      `/check — manually check for new launches`,
    { parse_mode: "HTML" }
  );
});

bot.command("status", async (ctx) => {
  const launches = await fetchLaunches().catch(() => []);
  await ctx.reply(
    `📊 <b>Status</b>\n\n` +
      `• Tracked (this instance): <b>${seenTokens.size}</b>\n` +
      `• Currently on API: <b>${launches.length}</b>\n` +
      `• Alert chats: <b>${ALERT_CHAT_IDS.length}</b>\n` +
      `• Min market cap: <b>$${MIN_MARKET_CAP}</b>\n` +
      `• Host: Vercel (webhook)`,
    { parse_mode: "HTML" }
  );
});

bot.command("latest", async (ctx) => {
  try {
    const launches = await fetchLaunches();
    if (!launches.length) return ctx.reply("No launches found yet.");

    const sorted = [...launches].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const token of sorted.slice(0, 5)) {
      const text = formatLaunch(token, false);
      const keyboard = makeKeyboard(token);
      if (token.logoUrl) {
        await ctx.replyWithPhoto(token.logoUrl, {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } else {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      }
    }
  } catch (err) {
    await ctx.reply(`Error: ${err.message}`);
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
    let extra = "";
    if (data.trades?.length) {
      const buys = data.trades.filter((t) => t.isBuy).length;
      const sells = data.trades.filter((t) => !t.isBuy).length;
      extra = `\n\n📈 Recent trades: ${buys} buys / ${sells} sells`;
    }
    const keyboard = makeKeyboard(token);
    if (token.logoUrl) {
      await ctx.replyWithPhoto(token.logoUrl, {
        caption: text + extra,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(text + extra, { parse_mode: "HTML", reply_markup: keyboard });
    }
  } catch (err) {
    await ctx.reply(`Error: ${err.message}`);
  }
});

bot.command("check", async (ctx) => {
  await ctx.reply("🔍 Checking for new launches...");
  await seedAndCheck();
  await ctx.reply("✅ Check complete.");
});

// ─── Vercel handler ───────────────────────────────────────────────────────
const handleUpdate = webhookCallback(bot, "http");

module.exports = async function handler(req, res) {
  // Manual check endpoint (can be called by Vercel Cron)
  if (req.method === "GET" && req.url?.includes("check")) {
    await seedAndCheck();
    return res.status(200).json({ ok: true, seen: seenTokens.size });
  }

  // Telegram webhook
  if (req.method === "POST") {
    try {
      await handleUpdate(req, res);
    } catch (err) {
      console.error("Webhook error:", err);
      res.status(500).json({ error: "Webhook failed" });
    }
    return;
  }

  res.status(200).json({
    status: "Mango Launch Monitor is running",
    hint: "POST Telegram updates here, or GET /api/bot?check=1 to poll launches",
  });
};
