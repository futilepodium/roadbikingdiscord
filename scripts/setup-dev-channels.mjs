/**
 * One-off: create missing categories/channels in the dev guild to mirror prod layout.
 * Does NOT modify, delete, rename, or reorder existing channels.
 *
 * Usage: node scripts/setup-dev-channels.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  OverwriteType,
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
const CREATE_DELAY_MS = 750;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

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

async function createWithRateLimit(createFn, label) {
  for (;;) {
    try {
      const result = await createFn();
      await sleep(CREATE_DELAY_MS);
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

/** Target layout (ALL CAPS categories + emoji-prefixed channel names). */
const TARGET_LAYOUT = [
  {
    category: "ANNOUNCEMENTS",
    channels: [
      { name: "📋-rules-info", kind: "rules" },
      { name: "📢-announcements", kind: "announcement" },
      { name: "💡-server-suggestions", kind: "text" },
      { name: "🏅-club-leaderboard", kind: "text" },
    ],
  },
  {
    category: "CONTESTS",
    channels: [
      { name: "🏆-photo-winners", kind: "text" },
      { name: "📸-submit-your-photo", kind: "text" },
      { name: "⭐-photo-contest-voting", kind: "text" },
      { name: "💬-topic-of-the-week", kind: "text" },
    ],
  },
  {
    category: "FORUMS",
    channels: [
      { name: "💬-general-forums", kind: "forum" },
      { name: "🔧-maintenance-repair", kind: "forum" },
      { name: "🛒-marketplace-advice", kind: "forum" },
    ],
  },
  {
    category: "GENERAL ROAD CYCLING",
    channels: [
      { name: "🌍-world-tour-discussion", kind: "text" },
      { name: "📰-totw-discussion", kind: "text" },
      { name: "🚴-general", kind: "text" },
      { name: "📷-bike-media", kind: "text" },
      { name: "🥗-nutrition", kind: "text" },
      { name: "🛠️-bike-help", kind: "text" },
      { name: "🏁-competitive", kind: "text" },
    ],
  },
  {
    category: "GENERAL CHATS",
    channels: [
      { name: "💭-off-topic", kind: "text" },
      { name: "🏎️-motor-sport", kind: "text" },
      { name: "🎬-media", kind: "text" },
    ],
  },
  {
    category: "OTHER ROAD",
    channels: [
      { name: "📊-strava-and-zwift", kind: "text" },
      { name: "⚙️-fixed-gear", kind: "text" },
      { name: "🏔️-mtb-off-road", kind: "text" },
      { name: "🎒-bikepacking-touring", kind: "text" },
      { name: "👑-legendary-chat", kind: "text", private: true },
      { name: "✨-mythical-chat", kind: "text", private: true },
    ],
  },
  {
    category: "VOICE CHANNELS",
    channels: [
      { name: "🔊 general", kind: "voice" },
      { name: "🔊 Voice-2", kind: "voice" },
    ],
  },
  {
    category: "OTHER",
    channels: [
      { name: "😂-memes", kind: "text" },
      { name: "🎵-music", kind: "text" },
      { name: "🎮-gaming", kind: "text" },
      { name: "🤖-bot-spam-or-spam", kind: "text" },
      { name: "👋-welcome", kind: "text" },
    ],
  },
];

const KIND_TO_TYPE = {
  text: ChannelType.GuildText,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  voice: ChannelType.GuildVoice,
  rules: ChannelType.GuildText,
};

function normalizeName(name) {
  return String(name).trim().toLowerCase();
}

function isCategory(channel) {
  return channel.type === ChannelType.GuildCategory;
}

function channelKindFromType(type, flags = 0) {
  if (type === ChannelType.GuildAnnouncement) return "announcement";
  if (type === ChannelType.GuildForum) return "forum";
  if (type === ChannelType.GuildVoice) return "voice";
  if (type === ChannelType.GuildText && (flags & 128) === 128) return "rules";
  if (type === ChannelType.GuildText) return "text";
  return `type-${type}`;
}

function buildGuildIndex(channels) {
  const byNormalizedName = new Map();
  const categoriesByNormalizedName = new Map();

  for (const channel of channels.values()) {
    const key = normalizeName(channel.name);
    if (!byNormalizedName.has(key)) byNormalizedName.set(key, []);
    byNormalizedName.get(key).push(channel);
    if (isCategory(channel)) {
      categoriesByNormalizedName.set(key, channel);
    }
  }

  return { byNormalizedName, categoriesByNormalizedName };
}

function extractPermissionOverwrites(channel) {
  if (!channel?.permissionOverwrites?.cache) return null;
  return channel.permissionOverwrites.cache.map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield,
    deny: overwrite.deny.bitfield,
  }));
}

function buildPrivateOverwrites(guild, prodOverwrites) {
  if (prodOverwrites?.length) {
    return prodOverwrites.map((entry) => ({
      id: entry.id === PROD_GUILD_ID ? guild.id : entry.id,
      type: entry.type,
      allow: entry.allow,
      deny: entry.deny,
    }));
  }

  return [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: PermissionFlagsBits.ViewChannel,
    },
  ];
}

function isUnsupportedChannelTypeError(error) {
  return error?.code === 50035 || error?.rawError?.code === 50035;
}

function channelCreateOptions(guild, spec, parentId, prodChannel, prodOverwrites, kindOverride = null) {
  const kind = kindOverride ?? spec.kind;
  const type = KIND_TO_TYPE[kind] ?? ChannelType.GuildText;
  const options = {
    name: spec.name,
    type,
    parent: parentId,
  };

  if (kind === "rules") {
    options.flags = 128; // ChannelFlags.IsGuildResourceChannel
  }

  if (spec.private) {
    options.permissionOverwrites = buildPrivateOverwrites(guild, prodOverwrites);
  } else if (prodOverwrites?.length && prodChannel && !spec.private) {
    // Only copy non-private prod overwrites when creating matching public channels (rare).
    void prodChannel;
  }

  return options;
}

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await client.login(TOKEN);
  console.log(`Logged in as ${client.user.tag}${DRY_RUN ? " (dry-run)" : ""}`);

  const devGuild = await client.guilds.fetch(DEV_GUILD_ID);
  const devMember = await devGuild.members.fetch(client.user.id);
  const canManageChannels = devMember.permissions.has(PermissionFlagsBits.ManageChannels);
  if (!canManageChannels) {
    console.warn(
      "Bot lacks Manage Channels in dev guild — cannot create categories/channels. Grant Manage Channels to the bot role and re-run.",
    );
    if (!DRY_RUN) {
      // Continue in dry-run-like mode to still report planned creates/skips.
    }
  }
  let prodGuild = null;
  try {
    prodGuild = await client.guilds.fetch(PROD_GUILD_ID);
  } catch (error) {
    console.warn(`Could not fetch prod guild (read-only reference skipped): ${error.message}`);
  }

  await devGuild.channels.fetch();
  if (prodGuild) await prodGuild.channels.fetch();

  const devIndex = buildGuildIndex(devGuild.channels.cache);
  const prodIndex = prodGuild ? buildGuildIndex(prodGuild.channels.cache) : null;

  const report = {
    categoriesCreated: [],
    categoriesSkipped: [],
    channelsCreated: [],
    channelsSkipped: [],
    errors: [],
  };

  for (const section of TARGET_LAYOUT) {
    const categoryKey = normalizeName(section.category);
    let category = devIndex.categoriesByNormalizedName.get(categoryKey);

    if (category) {
      report.categoriesSkipped.push({ name: category.name, id: category.id });
    } else if (DRY_RUN || !canManageChannels) {
      report.categoriesCreated.push({ name: section.category, id: "(would create)" });
      category = { id: null, name: section.category };
    } else {
      try {
        category = await createWithRateLimit(
          () =>
            devGuild.channels.create({
              name: section.category,
              type: ChannelType.GuildCategory,
            }),
          `category:${section.category}`,
        );
        devIndex.categoriesByNormalizedName.set(categoryKey, category);
        report.categoriesCreated.push({ name: category.name, id: category.id });
        console.log(`Created category: ${category.name}`);
      } catch (error) {
        report.errors.push({
          target: `category:${section.category}`,
          message: error.message,
          code: error.code,
        });
        console.error(`Failed to create category ${section.category}: ${error.message}`);
        continue;
      }
    }

    for (const spec of section.channels) {
      const channelKey = normalizeName(spec.name);
      const existingAnywhere = devIndex.byNormalizedName
        .get(channelKey)
        ?.find((channel) => !isCategory(channel));

      if (existingAnywhere) {
        const reason =
          existingAnywhere.name !== spec.name
            ? `already exists as "${existingAnywhere.name}" (Discord names are case-insensitive)`
            : "already exists in guild";
        const alreadyLogged = report.channelsSkipped.some(
          (entry) => entry.id === existingAnywhere.id && entry.requested === spec.name,
        );
        if (!alreadyLogged) {
          report.channelsSkipped.push({
            requested: spec.name,
            name: existingAnywhere.name,
            id: existingAnywhere.id,
            reason,
            parentId: existingAnywhere.parentId ?? null,
          });
        }
        continue;
      }

      const prodChannel = prodIndex?.byNormalizedName.get(channelKey)?.[0] ?? null;
      const prodOverwrites = prodChannel ? extractPermissionOverwrites(prodChannel) : null;

      if (prodChannel) {
        const prodKind = channelKindFromType(prodChannel.type, prodChannel.flags?.bitfield ?? prodChannel.rawFlags ?? 0);
        if (prodKind !== spec.kind && prodKind !== `type-${prodChannel.type}`) {
          console.log(
            `  Note: prod ${spec.name} is ${prodKind}, target spec is ${spec.kind}; using spec`,
          );
        }
      }

      try {
        const options = channelCreateOptions(
          devGuild,
          spec,
          category.id,
          prodChannel,
          prodOverwrites,
        );
        if (DRY_RUN || !canManageChannels) {
          report.channelsCreated.push({
            name: spec.name,
            id: "(would create)",
            kind: spec.kind,
            category: category.name,
            private: Boolean(spec.private),
          });
          continue;
        }
        let createdKind = spec.kind;
        let created;
        try {
          created = await createWithRateLimit(
            () => devGuild.channels.create(options),
            `channel:${section.category}/${spec.name}`,
          );
        } catch (error) {
          if (spec.kind === "announcement" && isUnsupportedChannelTypeError(error)) {
            console.warn(
              `  Announcement channel type not supported; falling back to text for ${spec.name}`,
            );
            const fallbackOptions = channelCreateOptions(
              devGuild,
              spec,
              category.id,
              prodChannel,
              prodOverwrites,
              "text",
            );
            created = await createWithRateLimit(
              () => devGuild.channels.create(fallbackOptions),
              `channel:${section.category}/${spec.name} (text fallback)`,
            );
            createdKind = "text (announcement fallback)";
          } else {
            throw error;
          }
        }
        if (!devIndex.byNormalizedName.has(channelKey)) devIndex.byNormalizedName.set(channelKey, []);
        devIndex.byNormalizedName.get(channelKey).push(created);

        report.channelsCreated.push({
          name: created.name,
          id: created.id,
          kind: createdKind,
          category: category.name,
          private: Boolean(spec.private),
        });
        console.log(`Created channel: ${category.name} / ${created.name} (${createdKind})`);
      } catch (error) {
        report.errors.push({
          target: `channel:${section.category}/${spec.name}`,
          message: error.message,
          code: error.code,
        });
        console.error(`Failed to create channel ${spec.name}: ${error.message}`);
      }
    }
  }

  await devGuild.channels.fetch();
  const finalCount = devGuild.channels.cache.size;

  console.log("\n=== Summary ===");
  console.log(`Dev guild: ${devGuild.name} (${devGuild.id})`);
  console.log(`Bot Manage Channels: ${canManageChannels ? "yes" : "NO — grant permission and re-run"}`);
  if (DRY_RUN || !canManageChannels) {
    console.log(`Mode: ${DRY_RUN ? "dry-run" : "blocked (no permission)"}`);
  }
  console.log(`Categories created: ${report.categoriesCreated.length}`);
  console.log(`Categories skipped (existing): ${report.categoriesSkipped.length}`);
  console.log(`Channels created: ${report.channelsCreated.length}`);
  console.log(`Channels skipped (existing): ${report.channelsSkipped.length}`);
  console.log(`Errors: ${report.errors.length}`);
  console.log(`Final channel count (including threads/categories): ${finalCount}`);

  if (report.categoriesCreated.length) {
    console.log("\nCreated categories:");
    for (const item of report.categoriesCreated) console.log(`  - ${item.name} (${item.id})`);
  }

  if (report.channelsCreated.length) {
    console.log("\nCreated channels:");
    for (const item of report.channelsCreated) {
      console.log(`  - ${item.category} / ${item.name} [${item.kind}] (${item.id})`);
    }
  }

  if (report.channelsSkipped.length) {
    console.log("\nSkipped channels (already existed):");
    for (const item of report.channelsSkipped) {
      const label =
        item.requested && item.requested !== item.name
          ? `${item.requested} → existing "${item.name}"`
          : item.name;
      console.log(`  - ${label} (${item.id})${item.reason ? `: ${item.reason}` : ""}`);
    }
  }

  if (report.errors.length) {
    console.log("\nErrors:");
    for (const item of report.errors) {
      console.log(`  - ${item.target}: ${item.message}${item.code ? ` [${item.code}]` : ""}`);
    }
  }

  await client.destroy();
  const blocked = !canManageChannels && !DRY_RUN;
  process.exit(report.errors.length > 0 || blocked ? 1 : 0);
}

main().catch(async (error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
