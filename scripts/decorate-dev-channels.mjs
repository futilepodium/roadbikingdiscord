/**
 * Rename dev guild categories (ALL CAPS) and prefix channel names with emojis.
 * Does NOT modify prod guild.
 *
 * Usage:
 *   node scripts/decorate-dev-channels.mjs           # apply renames
 *   node scripts/decorate-dev-channels.mjs --dry-run   # plan only
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} from "discord.js";
import { DEV_GUILD_ID, PROD_GUILD_ID } from "../lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const TOKEN = process.env.DISCORD_TOKEN?.trim();
const DRY_RUN = process.argv.includes("--dry-run");
const EDIT_DELAY_MS = 750;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

/** Target layout: ALL CAPS categories + emoji-prefixed channel names. */
export const DECORATED_LAYOUT = [
  {
    category: "ANNOUNCEMENTS",
    channels: [
      { base: "rules-info", name: "📋-rules-info" },
      { base: "announcements", name: "📢-announcements" },
      { base: "server-suggestions", name: "💡-server-suggestions" },
      { base: "club-leaderboard", name: "🏅-club-leaderboard" },
    ],
  },
  {
    category: "CONTESTS",
    channels: [
      { base: "photo-winners", name: "🏆-photo-winners" },
      { base: "submit-your-photo", name: "📸-submit-your-photo" },
      { base: "photo-contest-voting", name: "⭐-photo-contest-voting" },
      { base: "topic-of-the-week", name: "💬-topic-of-the-week" },
    ],
  },
  {
    category: "FORUMS",
    channels: [
      { base: "general-forums", name: "💬-general-forums" },
      { base: "maintenance-repair", name: "🔧-maintenance-repair" },
      { base: "marketplace-advice", name: "🛒-marketplace-advice" },
    ],
  },
  {
    category: "GENERAL ROAD CYCLING",
    channels: [
      { base: "world-tour-discussion", name: "🌍-world-tour-discussion" },
      { base: "totw-discussion", name: "📰-totw-discussion" },
      { base: "general", name: "🚴-general" },
      { base: "bike-media", name: "📷-bike-media" },
      { base: "nutrition", name: "🥗-nutrition" },
      { base: "bike-help", name: "🛠️-bike-help" },
      { base: "competitive", name: "🏁-competitive" },
    ],
  },
  {
    category: "GENERAL CHATS",
    channels: [
      { base: "off-topic", name: "💭-off-topic" },
      { base: "motor-sport", name: "🏎️-motor-sport" },
      { base: "media", name: "🎬-media" },
    ],
  },
  {
    category: "OTHER ROAD",
    channels: [
      { base: "strava-and-zwift", name: "📊-strava-and-zwift" },
      { base: "fixed-gear", name: "⚙️-fixed-gear" },
      { base: "mtb-off-road", name: "🏔️-mtb-off-road" },
      { base: "bikepacking-touring", name: "🎒-bikepacking-touring" },
      { base: "legendary-chat", name: "👑-legendary-chat" },
      { base: "mythical-chat", name: "✨-mythical-chat" },
    ],
  },
  {
    category: "VOICE CHANNELS",
    channels: [
      { base: "general", name: "🔊 general", voice: true },
      { base: "voice-2", name: "🔊 Voice-2", voice: true },
    ],
  },
  {
    category: "OTHER",
    channels: [
      { base: "memes", name: "😂-memes" },
      { base: "music", name: "🎵-music" },
      { base: "gaming", name: "🎮-gaming" },
      { base: "bot-spam-or-spam", name: "🤖-bot-spam-or-spam" },
      { base: "welcome", name: "👋-welcome" },
    ],
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  return error?.status === 429 || error?.httpStatus === 429 || error?.code === 429;
}

function retryAfterMs(error) {
  const seconds =
    error?.retryAfter ??
    error?.data?.retry_after ??
    error?.rawError?.retry_after ??
    1;
  return Math.max(Number(seconds) * 1000, 1000);
}

async function editWithRateLimit(editFn, label) {
  for (;;) {
    try {
      const result = await editFn();
      await sleep(EDIT_DELAY_MS);
      return result;
    } catch (error) {
      if (isRateLimitError(error)) {
        const waitMs = retryAfterMs(error);
        console.warn(`Rate limited on ${label}, waiting ${waitMs}ms before retry...`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
}

function normalizeName(name) {
  return String(name).trim().toLowerCase();
}

function stripEmojiPrefix(name) {
  return String(name)
    .replace(/^[\s\uFE0F\u200D\p{Extended_Pictographic}\p{Emoji_Presentation}]+[-\s]*/u, "")
    .trim();
}

function isCategory(channel) {
  return channel.type === ChannelType.GuildCategory;
}

function channelBaseName(channel) {
  return normalizeName(stripEmojiPrefix(channel.name));
}

function buildCategoryLookup(categories) {
  const byBase = new Map();
  for (const category of categories) {
    const key = normalizeName(category.name);
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(category);
  }
  return byBase;
}

function findCategoryForSection(section, categoriesByNorm, usedCategoryIds) {
  const targetNorm = normalizeName(section.category);
  const direct = categoriesByNorm.get(targetNorm)?.find((c) => !usedCategoryIds.has(c.id));
  if (direct) return direct;

  for (const category of categoriesByNorm.values()) {
    for (const candidate of category) {
      if (usedCategoryIds.has(candidate.id)) continue;
      const stripped = normalizeName(stripEmojiPrefix(candidate.name));
      if (stripped === targetNorm) return candidate;
    }
  }

  const legacyKeys = LEGACY_CATEGORY_ALIASES.get(targetNorm) ?? [];
  for (const legacyKey of legacyKeys) {
    const match = categoriesByNorm.get(legacyKey)?.find((c) => !usedCategoryIds.has(c.id));
    if (match) return match;
  }

  return null;
}

/** Map ALL CAPS category → legacy title-case / lowercase names in dev guild. */
const LEGACY_CATEGORY_ALIASES = new Map([
  ["announcements", ["announcements"]],
  ["contests", ["contests"]],
  ["forums", ["forums"]],
  ["general road cycling", ["general road cycling"]],
  ["general chats", ["general chats"]],
  ["other road", ["other road"]],
  ["voice channels", ["voice channels"]],
  ["other", ["other"]],
]);

function buildChannelLookup(channels) {
  const byBase = new Map();
  for (const channel of channels) {
    if (isCategory(channel)) continue;
    const key = channelBaseName(channel);
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(channel);
  }
  return byBase;
}

function findChannel(spec, channelsInCategory, channelsByBase, usedChannelIds) {
  const inCategory = channelsInCategory.find(
    (ch) => channelBaseName(ch) === spec.base && !usedChannelIds.has(ch.id),
  );
  if (inCategory) return inCategory;

  const globalMatches = channelsByBase.get(spec.base) ?? [];
  return globalMatches.find((ch) => !usedChannelIds.has(ch.id)) ?? null;
}

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await client.login(TOKEN);
  console.log(`Logged in as ${client.user.tag}${DRY_RUN ? " (dry-run)" : ""}`);

  const devGuild = await client.guilds.fetch(DEV_GUILD_ID);
  const devMember = await devGuild.members.fetch(client.user.id);
  const canManageChannels = devMember.permissions.has(PermissionFlagsBits.ManageChannels);
  if (!canManageChannels && !DRY_RUN) {
    console.error("Bot lacks Manage Channels in dev guild.");
    await client.destroy();
    process.exit(1);
  }

  try {
    await client.guilds.fetch(PROD_GUILD_ID);
    console.warn("Prod guild fetch succeeded but this script only edits dev guild.");
  } catch {
    console.warn("Prod guild not accessible — using built-in emoji mapping.");
  }

  await devGuild.channels.fetch();

  const allCategories = [...devGuild.channels.cache.values()].filter(isCategory);
  const allChannels = [...devGuild.channels.cache.values()].filter((c) => !isCategory(c));
  const categoriesByNorm = buildCategoryLookup(allCategories);
  const channelsByBase = buildChannelLookup(allChannels);

  const report = {
    categoryRenames: [],
    channelRenames: [],
    categorySkipped: [],
    channelSkipped: [],
    unmatchedCategories: [],
    unmatchedChannels: [],
    errors: [],
  };

  const usedCategoryIds = new Set();
  const usedChannelIds = new Set();

  for (const section of DECORATED_LAYOUT) {
    const category = findCategoryForSection(section, categoriesByNorm, usedCategoryIds);
    if (!category) {
      report.unmatchedCategories.push(section.category);
      console.warn(`No category found for section: ${section.category}`);
      continue;
    }
    usedCategoryIds.add(category.id);

    if (category.name !== section.category) {
      report.categoryRenames.push({
        id: category.id,
        old: category.name,
        new: section.category,
      });
      if (!DRY_RUN) {
        try {
          await editWithRateLimit(
            () => category.edit({ name: section.category }),
            `category:${category.name}→${section.category}`,
          );
          console.log(`Renamed category: "${category.name}" → "${section.category}"`);
        } catch (error) {
          report.errors.push({
            target: `category:${category.name}`,
            message: error.message,
            code: error.code,
          });
          console.error(`Failed category rename ${category.name}: ${error.message}`);
        }
      } else {
        console.log(`[dry-run] category: "${category.name}" → "${section.category}"`);
      }
    } else {
      report.categorySkipped.push({ id: category.id, name: category.name });
    }

    const channelsInCategory = allChannels.filter((ch) => ch.parentId === category.id);
    for (const spec of section.channels) {
      const channel = findChannel(spec, channelsInCategory, channelsByBase, usedChannelIds);
      if (!channel) {
        report.unmatchedChannels.push({ category: section.category, base: spec.base, target: spec.name });
        console.warn(`No channel found: ${section.category} / ${spec.base}`);
        continue;
      }
      usedChannelIds.add(channel.id);

      if (channel.name === spec.name) {
        report.channelSkipped.push({ id: channel.id, name: channel.name });
        continue;
      }

      report.channelRenames.push({
        id: channel.id,
        category: section.category,
        old: channel.name,
        new: spec.name,
      });

      if (!DRY_RUN) {
        try {
          await editWithRateLimit(
            () => channel.edit({ name: spec.name }),
            `channel:${channel.name}→${spec.name}`,
          );
          console.log(`Renamed channel: "${channel.name}" → "${spec.name}"`);
        } catch (error) {
          report.errors.push({
            target: `channel:${channel.name}`,
            message: error.message,
            code: error.code,
          });
          console.error(`Failed channel rename ${channel.name}: ${error.message}`);
        }
      } else {
        console.log(`[dry-run] channel: "${channel.name}" → "${spec.name}"`);
      }
    }
  }

  await devGuild.channels.fetch();

  console.log("\n=== Summary ===");
  console.log(`Dev guild: ${devGuild.name} (${devGuild.id})`);
  console.log(`Mode: ${DRY_RUN ? "dry-run" : "apply"}`);
  console.log(`Category renames: ${report.categoryRenames.length}`);
  console.log(`Channel renames: ${report.channelRenames.length}`);
  console.log(`Categories already correct: ${report.categorySkipped.length}`);
  console.log(`Channels already correct: ${report.channelSkipped.length}`);
  console.log(`Errors: ${report.errors.length}`);

  if (report.categoryRenames.length) {
    console.log("\nCategory renames (old → new):");
    for (const item of report.categoryRenames) {
      console.log(`  - "${item.old}" → "${item.new}" (${item.id})`);
    }
  }

  if (report.channelRenames.length) {
    console.log("\nChannel renames (old → new):");
    for (const item of report.channelRenames) {
      console.log(`  - [${item.category}] "${item.old}" → "${item.new}" (${item.id})`);
    }
  }

  if (report.errors.length) {
    console.log("\nErrors:");
    for (const item of report.errors) {
      console.log(`  - ${item.target}: ${item.message}${item.code ? ` [${item.code}]` : ""}`);
    }
  }

  if (report.unmatchedCategories.length || report.unmatchedChannels.length) {
    console.log("\nUnmatched:");
    for (const name of report.unmatchedCategories) console.log(`  - category: ${name}`);
    for (const item of report.unmatchedChannels) {
      console.log(`  - channel: ${item.category}/${item.base}`);
    }
  }

  console.log("\n=== Final state ===");
  const finalCategories = [...devGuild.channels.cache.values()]
    .filter(isCategory)
    .sort((a, b) => a.position - b.position);
  for (const cat of finalCategories) {
    console.log(`${cat.name}`);
    const chs = [...devGuild.channels.cache.values()]
      .filter((c) => c.parentId === cat.id && !isCategory(c))
      .sort((a, b) => a.position - b.position);
    for (const ch of chs) console.log(`  ${ch.name}`);
  }

  await client.destroy();
  process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
