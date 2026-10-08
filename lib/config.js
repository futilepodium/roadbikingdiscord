export const DEV_GUILD_ID = "1555674814562439188";
export const PROD_GUILD_ID = "416024949627813890";

export const SUBMIT_INSTRUCTION_CHANNEL_IDS = {
  development: "1555675560267620442",
  production: "1244408284908355666",
};

export function getSubmitInstructionChannelLink(botEnv = resolveBotEnv()) {
  const { guildId } = getConfig(botEnv);
  const channelId = SUBMIT_INSTRUCTION_CHANNEL_IDS[botEnv];
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

export const DEV_COMMANDS_CHANNEL_ID = "1557406996234248233";
export const DEV_MOD_REVIEW_CHANNEL_ID = "1557460302868521051";

export const CHANNELS = {
  development: {
    guildId: DEV_GUILD_ID,
    submissionPromptChannelId: "1555675513056534598",
    postingChannelId: "1555675560267620442",
    winnersChannelId: "1555679698820800562",
    devCommandsChannelId: DEV_COMMANDS_CHANNEL_ID,
    modReviewChannelId: DEV_MOD_REVIEW_CHANNEL_ID,
  },
  production: {
    guildId: PROD_GUILD_ID,
    submissionPromptChannelId: "1239313239742087248",
    postingChannelId: "1244408284908355666",
    winnersChannelId: "752789128814395423",
  },
};

export function resolveBotEnv(value = process.env.BOT_ENV) {
  const normalized = String(value ?? "development").trim().toLowerCase();
  return normalized === "production" || normalized === "prod" ? "production" : "development";
}

export function getConfig(botEnv = resolveBotEnv()) {
  return CHANNELS[botEnv];
}

export function getSubmissionPromptChannelIds() {
  return new Set(
    Object.values(CHANNELS).map((channelConfig) => channelConfig.postingChannelId),
  );
}
