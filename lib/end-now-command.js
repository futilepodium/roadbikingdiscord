import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  Events,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  SeparatorBuilder,
  SlashCommandBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { resolveBotEnv } from "./config.js";
import {
  buildWinnersAnnouncementTitle,
  buildWinnersPreviewPayload,
  buildWeekEndNotifiedKey,
  canUseEndNow,
  finalizeWeekEnd,
  getEndNowSendTestUserId,
  getEndedWeekIfAny,
  hydrateWeekEndWinners,
  isPendingWeekEndStillValid,
  parseEndNowDmUserIds,
  prepareWeekEnd,
  resolveEndNowComposeDmUserIds,
} from "./week-end.js";
import { INITIAL_SUBMISSION_DEADLINE_MS, WEEK_MS } from "./week.js";
import {
  buildEndNowDmInstructions,
  buildWinnersModalLabels,
  endNowPersonalMessages,
  formatWinnersPostSentMessage,
  getComposeWinnersButtonLabel,
  getWinnersAlreadyPostedMessage,
} from "./user-locale.js";

export const END_NOW_COMMAND_NAME = "end-now";
export const DEV_END_NOW_LOCK_KEY = "dev_end_now_locked_user_id";
const BOT_ENV = resolveBotEnv();

export function getDevEndNowLockedUserId(store) {
  return store.getSetting(DEV_END_NOW_LOCK_KEY);
}

export function setDevEndNowLock(store, userId) {
  store.setSetting(DEV_END_NOW_LOCK_KEY, userId);
}

export function clearDevEndNowLock(store) {
  store.clearSetting(DEV_END_NOW_LOCK_KEY);
}
export const END_NOW_COMPOSE_BUTTON_ID = `end-now-compose:${BOT_ENV}`;
export const END_NOW_MODAL_ID = `end-now-modal:${BOT_ENV}`;
export const END_NOW_TITLE_INPUT_ID = "title";
export const END_NOW_DESCRIPTION_P1_INPUT_ID = "description-p1";
export const END_NOW_DESCRIPTION_P2_INPUT_ID = "description-p2";
export const END_NOW_SEND_TEST_OPTION_NAME = "send-test";
export const WEEK_END_CHECK_MS = 60_000;
export function buildEndNowSlashCommand() {
  return new SlashCommandBuilder()
    .setName(END_NOW_COMMAND_NAME)
    .setDescription("2. End the current photo contest week and post winners")
    .addBooleanOption((option) =>
      option
        .setName(END_NOW_SEND_TEST_OPTION_NAME)
        .setDescription("Send compose DMs only to the test recipient")
        .setRequired(false),
    )
    .toJSON();
}

export async function registerEndNowSlashCommand({ token, clientId, guildId }) {
  const rest = new REST({ version: "10" }).setToken(token);
  const existing = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
  const nextCommands = [
    ...existing.filter((command) => command.name !== END_NOW_COMMAND_NAME),
    buildEndNowSlashCommand(),
  ];

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: nextCommands,
  });
}

export function buildEndNowComposeButton(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(END_NOW_COMPOSE_BUTTON_ID)
      .setLabel(getComposeWinnersButtonLabel(userId))
      .setStyle(ButtonStyle.Primary),
  );
}

export function resolveEndNowComposeRecipients({ sendTest = false, invokingUserId = null } = {}) {
  if (sendTest) {
    const testUserId = getEndNowSendTestUserId();
    return testUserId ? [testUserId] : [];
  }

  return invokingUserId ? [invokingUserId] : [];
}

export async function executeEndNowPrepare({
  client,
  store,
  postingChannelId,
  userId,
  sendTest = false,
}) {
  const lockedUserId = getDevEndNowLockedUserId(store);
  if (!sendTest && lockedUserId && lockedUserId !== userId) {
    return {
      ok: false,
      message: `<@${lockedUserId}> is already composing this week's winners.`,
    };
  }

  if (!sendTest && lockedUserId === userId) {
    return {
      ok: false,
      message: "You already started the end-week flow. Check your DMs for the compose message.",
    };
  }

  const batch = store.getLatestPublishedUnfinalizedBatch();
  if (!batch) {
    return {
      ok: false,
      message: endNowPersonalMessages.noActiveVoting(userId),
    };
  }

  const weekNumber =
    Math.floor((Number(batch.batchId) - INITIAL_SUBMISSION_DEADLINE_MS) / WEEK_MS) + 1;
  const prepared = await prepareWeekEnd({
    client,
    store,
    postingChannelId,
    endingWeek: {
      batchId: batch.batchId,
      weekNumber,
      weekStartMs: batch.votingStartMs,
      weekEndMs: batch.votingEndMs,
    },
  });
  prepared.batchId = batch.batchId;

  const { sentUserIds, failedUserIds, sentMessages } = await sendWeekEndComposeDms({
    client,
    store,
    postingChannelId,
    prepared,
    userIds: resolveEndNowComposeRecipients({
      sendTest,
      invokingUserId: userId,
    }),
  });
  setPendingWeekEnd(store, { ...prepared, composeDmMessages: sentMessages });

  if (sendTest) {
    if (sentUserIds.length === 0) {
      clearPendingWeekEnd(store);
      return {
        ok: false,
        message: endNowPersonalMessages.testRecipientDmFailed(userId),
      };
    }

    return {
      ok: true,
      message: endNowPersonalMessages.testDmsSent(userId),
    };
  }

  if (!sentUserIds.includes(userId)) {
    clearPendingWeekEnd(store);
    return {
      ok: false,
      message: endNowPersonalMessages.invokerDmFailed(userId),
    };
  }

  setDevEndNowLock(store, userId);

  return {
    ok: true,
    message: endNowPersonalMessages.composeDmsSent(userId, failedUserIds.length > 0),
  };
}

export async function buildEndNowDmPayload({
  client,
  store,
  postingChannelId,
  prepared,
  recipientUserId,
}) {
  const postingChannel = await client.channels.fetch(postingChannelId);
  const winners = await hydrateWeekEndWinners(postingChannel, prepared.winners);
  const preview = await buildWinnersPreviewPayload(client, store, { winners });

  return {
    components: [
      ...preview.components,
      new SeparatorBuilder().setDivider(true),
      new TextDisplayBuilder().setContent(
        buildEndNowDmInstructions(prepared.weekNumber, recipientUserId),
      ),
      buildEndNowComposeButton(recipientUserId),
    ],
    files: preview.files,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: preview.allowedMentions,
  };
}

export function buildEndNowModal(weekNumber, userId) {
  const labels = buildWinnersModalLabels(userId);

  return new ModalBuilder()
    .setCustomId(END_NOW_MODAL_ID)
    .setTitle(labels.title)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(labels.titleLabel)
        .setDescription(labels.titleDescription)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(END_NOW_TITLE_INPUT_ID)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(200)
            .setValue(buildWinnersAnnouncementTitle(weekNumber)),
        ),
      new LabelBuilder()
        .setLabel(labels.p1Label)
        .setDescription(labels.p1Description)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(END_NOW_DESCRIPTION_P1_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000),
        ),
      new LabelBuilder()
        .setLabel(labels.p2Label)
        .setDescription(labels.p2Description)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(END_NOW_DESCRIPTION_P2_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000),
        ),
    );
}

export function getPendingWeekEnd(userId, store) {
  if (!canUseEndNow(userId)) {
    return null;
  }

  const lockedUserId = getDevEndNowLockedUserId(store);
  if (lockedUserId && lockedUserId !== userId) {
    return null;
  }

  const prepared = store.getPendingWeekEndSession();
  if (!prepared) {
    return null;
  }

  if (!isPendingWeekEndStillValid(prepared, store)) {
    store.clearPendingWeekEndSession();
    return null;
  }

  return prepared;
}

export function setPendingWeekEnd(store, prepared) {
  store.setPendingWeekEndSession(prepared);
}

export function clearPendingWeekEnd(store) {
  store.clearPendingWeekEndSession();
}

export function buildWinnersPostSentDmPayload(sender, recipientUserId) {
  return {
    components: [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          formatWinnersPostSentMessage(sender, recipientUserId),
        ),
      ),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

export async function editComposeDmsAfterWinnersPosted({
  client,
  composeDmMessages = [],
  senderUserId,
}) {
  if (composeDmMessages.length === 0) {
    return { edited: [], failed: [] };
  }

  const sender = await client.users.fetch(senderUserId);
  const edited = [];
  const failed = [];

  for (const { userId: recipientUserId, channelId, messageId } of composeDmMessages) {
    try {
      const channel = await client.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);
      const payload = buildWinnersPostSentDmPayload(sender, recipientUserId);
      await message.edit(payload);
      edited.push({ channelId, messageId });
    } catch (error) {
      failed.push({ channelId, messageId, error });
      console.warn(`Failed to update compose DM ${messageId}: ${error.message}`);
    }
  }

  return { edited, failed };
}

export async function sendWeekEndComposeDms({ client, store, postingChannelId, prepared, userIds }) {
  const sentUserIds = [];
  const failedUserIds = [];
  const sentMessages = [];

  for (const userId of userIds) {
    try {
      const user = await client.users.fetch(userId);
      const dmChannel = await user.createDM();
      const dmPayload = await buildEndNowDmPayload({
        client,
        store,
        postingChannelId,
        prepared,
        recipientUserId: userId,
      });
      const message = await dmChannel.send(dmPayload);
      sentUserIds.push(userId);
      sentMessages.push({
        userId,
        channelId: dmChannel.id,
        messageId: message.id,
      });
    } catch (error) {
      failedUserIds.push(userId);
      if (error.code === 50007) {
        console.warn(`Could not DM user ${userId} for week-end compose: DMs disabled or blocked`);
        continue;
      }
      throw error;
    }
  }

  return { sentUserIds, failedUserIds, sentMessages };
}

export async function checkAndSendAutoWeekEndCompose({
  client,
  store,
  postingChannelId,
  allowedUserIds = parseEndNowDmUserIds(),
  now = Date.now(),
}) {
  const existingPending = store.getPendingWeekEndSession();
  if (existingPending && isPendingWeekEndStillValid(existingPending, store)) {
    return false;
  }

  const contestStartMs = store.getContestWeekStartMs();
  const firstWeekEndMs = store.getFirstWeekEndMs();
  const endedWeek = getEndedWeekIfAny(now, contestStartMs, firstWeekEndMs);
  if (!endedWeek) {
    return false;
  }

  const notifiedKey = buildWeekEndNotifiedKey(endedWeek.weekStartMs);
  if (store.getSetting(notifiedKey)) {
    return false;
  }

  const prepared = await prepareWeekEnd({
    client,
    store,
    postingChannelId,
    now,
    endingWeek: endedWeek,
  });

  const { sentUserIds, failedUserIds, sentMessages } = await sendWeekEndComposeDms({
    client,
    store,
    postingChannelId,
    prepared,
    userIds: [...allowedUserIds],
  });
  setPendingWeekEnd(store, { ...prepared, composeDmMessages: sentMessages });
  if (sentUserIds.length === 0) {
    clearPendingWeekEnd(store);
    throw new Error("Could not DM any configured week-end recipients");
  }
  store.setSetting(notifiedKey, String(now));
  console.log(
    `Auto-sent wk${prepared.weekNumber} compose DMs to ${sentUserIds.join(", ")}` +
      (failedUserIds.length > 0 ? ` (failed: ${failedUserIds.join(", ")})` : ""),
  );
  return true;
}

export function registerEndNowHandlers(
  client,
  {
    allowedGuildId,
    postingChannelId,
    winnersChannelId,
    store,
    refreshSubmissionPrompt,
    refreshDevCommandsPanel,
    recordDevCommandActivity,
  },
) {
  if (resolveBotEnv() !== "development") {
    return;
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === END_NOW_COMMAND_NAME) {
      if (interaction.guildId !== allowedGuildId) {
        return;
      }

      const userId = interaction.user.id;

      if (!canUseEndNow(userId)) {
        await interaction.reply({
          content: endNowPersonalMessages.permissionDeniedCommand(userId),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      recordDevCommandActivity?.();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const sendTest = interaction.options.getBoolean(END_NOW_SEND_TEST_OPTION_NAME) ?? false;
        const result = await executeEndNowPrepare({
          client,
          store,
          postingChannelId,
          userId,
          sendTest,
        });

        if (!result.ok) {
          await interaction.editReply(result.message);
          return;
        }

        if (!sendTest) {
          await refreshDevCommandsPanel?.().catch((error) => {
            console.error("Failed to refresh dev commands panel after end-now:", error);
          });
        }

        await interaction.editReply(result.message);
      } catch (error) {
        clearPendingWeekEnd(store);
        console.error("Failed to prepare week end:", error);
        await interaction.editReply(
          endNowPersonalMessages.prepareFailed(userId, error.code),
        ).catch(() => {});
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === END_NOW_COMPOSE_BUTTON_ID) {
      const userId = interaction.user.id;

      if (!canUseEndNow(userId)) {
        await interaction.reply({
          content: endNowPersonalMessages.permissionDeniedButton(userId),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const prepared = getPendingWeekEnd(userId, store);
      if (!prepared) {
        await interaction.reply({
          content: getWinnersAlreadyPostedMessage(userId),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.showModal(buildEndNowModal(prepared.weekNumber, userId));
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === END_NOW_MODAL_ID) {
      const userId = interaction.user.id;

      if (!canUseEndNow(userId)) {
        await interaction.reply({
          content: endNowPersonalMessages.permissionDeniedForm(userId),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const prepared = getPendingWeekEnd(userId, store);
      if (!prepared) {
        await interaction.reply({
          content: getWinnersAlreadyPostedMessage(userId),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const title = interaction.fields.getTextInputValue(END_NOW_TITLE_INPUT_ID).trim();
      const descriptionP1 = interaction.fields.getTextInputValue(END_NOW_DESCRIPTION_P1_INPUT_ID).trim();
      const descriptionP2 = interaction.fields.getTextInputValue(END_NOW_DESCRIPTION_P2_INPUT_ID).trim();

      try {
        const result = await finalizeWeekEnd({
          client,
          store,
          postingChannelId,
          winnersChannelId,
          prepared,
          title,
          descriptionP1,
          descriptionP2,
        });

        await editComposeDmsAfterWinnersPosted({
          client,
          composeDmMessages: prepared.composeDmMessages ?? [],
          senderUserId: userId,
        });

        clearPendingWeekEnd(store);
        clearDevEndNowLock(store);

        await refreshSubmissionPrompt?.().catch((error) => {
          console.error("Failed to refresh prompt after ending week:", error);
        });
        await refreshDevCommandsPanel?.().catch((error) => {
          console.error("Failed to refresh dev commands panel after ending week:", error);
        });

        await interaction.editReply(
          endNowPersonalMessages.winnersPosted(
            userId,
            result.weekNumber,
            result.winnerCount,
            result.submissionCount,
          ),
        );
      } catch (error) {
        console.error("Failed to finalize week end:", error);
        await interaction.editReply(endNowPersonalMessages.finalizeFailed(userId));
      }
    }
  });

  async function runAutoWeekEndCheck() {
    await checkAndSendAutoWeekEndCompose({
      client,
      store,
      postingChannelId,
    });
  }

  return { runAutoWeekEndCheck };
}
