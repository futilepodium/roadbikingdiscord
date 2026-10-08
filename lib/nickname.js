import { ActivityType } from "discord.js";

export const BOT_NICKNAME = "Fred";
export const BOT_ACTIVITY = "roadbikingdiscord.com";

export async function setBotGuildNickname(readyClient, guildId, nickname = BOT_NICKNAME) {
  const guild = readyClient.guilds.cache.get(guildId);
  if (!guild) {
    console.warn(`Cannot set nickname: guild ${guildId} not found in cache`);
    return;
  }

  try {
    const member = await guild.members.fetchMe();
    await member.setNickname(nickname);
    console.log(`Set guild nickname to "${nickname}" in ${guild.name} (${guild.id})`);
  } catch (error) {
    if (error.code === 50013) {
      console.warn(
        `Missing permissions to set nickname in guild ${guild.name} (${guild.id})`,
      );
      return;
    }

    console.error(`Failed to set guild nickname in ${guild.name} (${guild.id}):`, error);
  }
}

export function setBotListeningStatus(client, name = BOT_ACTIVITY) {
  client.user.setActivity(name, { type: ActivityType.Watching });
  console.log(`Set bot status to Watching ${name}`);
}
