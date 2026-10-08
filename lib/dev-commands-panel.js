import {
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { resolveBotEnv } from "./config.js";
import {
  clearDevEndNowLock,
  executeEndNowPrepare,
  getDevEndNowLockedUserId,
} from "./end-now-command.js";
import { executeQuickEndSubmission } from "./quick-end-submission-command.js";
import { executeResetDev } from "./reset-dev-command.js";
import { SUBMIT_COMMAND_NAME, SUBMIT_PHOTO_BUTTON_ID } from "./submit-command.js";
import { canUseEndNow } from "./week-end.js";

export const DEV_COMMANDS_CHANNEL_ID = "1557406996234248233";
export const DEV_IDLE_RESET_MS = 5 * 60 * 1000;
export const DEV_COMMANDS_HEADER = "# Development only";

const BOT_ENV = resolveBotEnv();
export const DEV_RESET_BUTTON_ID = `dev-reset:${BOT_ENV}`;
export const DEV_QUICK_END_BUTTON_ID = `dev-quick-end:${BOT_ENV}`;
export const DEV_END_NOW_BUTTON_ID = `dev-end-now:${BOT_ENV}`;

function buildDevCommandSection({
  heading,
  buttonId,
  buttonLabel,
  buttonStyle,
  disabled = false,
}) {
  return new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading))
    .setButtonAccessory(
      new ButtonBuilder()
        .setCustomId(buttonId)
        .setLabel(buttonLabel)
        .setStyle(buttonStyle)
        .setDisabled(disabled),
    );
}

export function buildDevCommandsPanelPayload({ lockedUserId = null } = {}) {
  const endNowLocked = Boolean(lockedUserId);
  const endNowDescription = endNowLocked
    ? "End the current photo contest week and post winners.\n\nLocked by the user who started it."
    : "End the current photo contest week and post winners. Sends a compose DM to you.";

  return {
    components: [
      new TextDisplayBuilder().setContent(DEV_COMMANDS_HEADER),
      buildDevCommandSection({
        heading: "# 1. /reset-dev",
        buttonId: DEV_RESET_BUTTON_ID,
        buttonLabel: "Reset",
        buttonStyle: ButtonStyle.Danger,
      }),
      new TextDisplayBuilder().setContent(
        "Reset contest submissions, voting, and winner state.",
      ),
      new SeparatorBuilder().setDivider(true),
      buildDevCommandSection({
        heading: `# 2. /${SUBMIT_COMMAND_NAME}`,
        buttonId: SUBMIT_PHOTO_BUTTON_ID,
        buttonLabel: "Submit Photo",
        buttonStyle: ButtonStyle.Success,
      }),
      new TextDisplayBuilder().setContent(
        "Submit a road biking photo for the weekly contest.",
      ),
      new SeparatorBuilder().setDivider(true),
      buildDevCommandSection({
        heading: "# 3. /quick-end-submissions",
        buttonId: DEV_QUICK_END_BUTTON_ID,
        buttonLabel: "Close Submissions",
        buttonStyle: ButtonStyle.Primary,
      }),
      new TextDisplayBuilder().setContent(
        "Close submissions now and begin the voting period.",
      ),
      new SeparatorBuilder().setDivider(true),
      buildDevCommandSection({
        heading: "# 4. /end-now",
        buttonId: DEV_END_NOW_BUTTON_ID,
        buttonLabel: "End Week",
        buttonStyle: ButtonStyle.Secondary,
        disabled: endNowLocked,
      }),
      new TextDisplayBuilder().setContent(endNowDescription),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

export function formatDevCommandsPanelPreview({ lockedUserId = null } = {}) {
  const lockedLine = lockedUserId
    ? `\n\n> Locked by user \`${lockedUserId}\`. End Week button disabled.`
    : "";

  return [
    DEV_COMMANDS_HEADER,
    "",
    "# 1. /reset-dev                                    [ Reset ]",
    "Reset contest submissions, voting, and winner state.",
    "────────────",
    "# 2. /submit-photo                            [ Submit Photo ]",
    "Submit a road biking photo for the weekly contest.",
    "────────────",
    "# 3. /quick-end-submissions              [ Close Submissions ]",
    "Close submissions now and begin the voting period.",
    "────────────",
    "# 4. /end-now                                          [ End Week ]",
    `End the current photo contest week and post winners. Sends a compose DM to you.${lockedLine}`,
  ].join("\n");
}

export function registerDevCommandsPanelHandlers(
  client,
  {
    allowedGuildId,
    channelId = DEV_COMMANDS_CHANNEL_ID,
    postingChannelId,
    winnersChannelId,
    store,
    refreshSubmissionPrompt,
  },
) {
  if (resolveBotEnv() !== "development") {
    return {
      ensureDevCommandsPanel: async () => {},
      refreshDevCommandsPanel: async () => {},
      recordDevCommandActivity: () => {},
    };
  }

  let lastDevActivityAt = Date.now();
  let idleResetTimer = null;

  function recordDevCommandActivity() {
    lastDevActivityAt = Date.now();
  }

  async function refreshDevCommandsPanel() {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      return null;
    }

    const payload = buildDevCommandsPanelPayload({
      lockedUserId: getDevEndNowLockedUserId(store),
    });
    const storedMessageId = store.getPromptMessageId(channelId);

    if (storedMessageId) {
      const existing = await channel.messages.fetch(storedMessageId).catch(() => null);
      if (existing) {
        const edited = await existing.edit(payload);
        store.setPromptMessageId(channelId, edited.id);
        return edited;
      }
    }

    const message = await channel.send(payload);
    store.setPromptMessageId(channelId, message.id);
    return message;
  }

  async function ensureDevCommandsPanel({ log = false } = {}) {
    const message = await refreshDevCommandsPanel();
    if (log && message) {
      console.log(`Ensured dev commands panel in channel ${channelId} (${message.id})`);
    }
    return message;
  }

  async function runIdleResetIfNeeded() {
    if (Date.now() - lastDevActivityAt < DEV_IDLE_RESET_MS) {
      return false;
    }

    if (getDevEndNowLockedUserId(store) || store.getPendingWeekEndSession()) {
      return false;
    }

    try {
      await executeResetDev({
        client,
        store,
        allowedGuildId,
        postingChannelId,
        winnersChannelId,
        refreshSubmissionPrompt,
        refreshDevCommandsPanel: refreshDevCommandsPanel,
      });
      recordDevCommandActivity();
      console.log("Auto-reset development contest after 5 minutes without dev command use");
      return true;
    } catch (error) {
      console.error("Failed auto-reset of development contest:", error);
      return false;
    }
  }

  function scheduleIdleResetCheck() {
    clearTimeout(idleResetTimer);
    idleResetTimer = setTimeout(async () => {
      await runIdleResetIfNeeded();
      scheduleIdleResetCheck();
    }, 30_000);
  }

  scheduleIdleResetCheck();

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() || interaction.guildId !== allowedGuildId) {
      return;
    }

    const handlers = {
      [DEV_RESET_BUTTON_ID]: handleResetButton,
      [DEV_QUICK_END_BUTTON_ID]: handleQuickEndButton,
      [DEV_END_NOW_BUTTON_ID]: handleEndNowButton,
    };
    const handler = handlers[interaction.customId];
    if (!handler) {
      return;
    }

    if (!canUseEndNow(interaction.user.id)) {
      await interaction.reply({
        content: "You do not have permission to use development commands.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    recordDevCommandActivity();
    await handler(interaction);
  });

  async function handleResetButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await executeResetDev({
        client,
        store,
        allowedGuildId,
        postingChannelId,
        winnersChannelId,
        refreshSubmissionPrompt,
        refreshDevCommandsPanel: refreshDevCommandsPanel,
      });
      await interaction.editReply(
        `Development contest reset complete. Removed ${result.removedEntries} submission(s), ${result.removedVotingMessages} voting message(s), and ${result.removedBatches} batch record(s).`,
      );
    } catch (error) {
      console.error("Failed to reset development contest from panel:", error);
      await interaction.editReply("Something went wrong while resetting the development contest.");
    }
  }

  async function handleQuickEndButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await executeQuickEndSubmission({
        client,
        store,
        postingChannelId,
        refreshSubmissionPrompt,
      });

      if (!result.ok) {
        await interaction.editReply(result.message);
        return;
      }

      await interaction.editReply(result.message);
    } catch (error) {
      console.error("Failed to quick-end submission period from panel:", error);
      await interaction.editReply("Something went wrong while ending the submission period.");
    }
  }

  async function handleEndNowButton(interaction) {
    const lockedUserId = getDevEndNowLockedUserId(store);
    if (lockedUserId && lockedUserId !== interaction.user.id) {
      await interaction.reply({
        content: `<@${lockedUserId}> is already composing this week's winners. Check your DMs if that was you.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (lockedUserId) {
      await interaction.reply({
        content: "You already started the end-week flow. Check your DMs for the compose message.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await executeEndNowPrepare({
        client,
        store,
        postingChannelId,
        userId: interaction.user.id,
      });

      if (!result.ok) {
        await interaction.editReply(result.message);
        return;
      }

      await refreshDevCommandsPanel();
      await interaction.editReply(result.message);
    } catch (error) {
      console.error("Failed to prepare week end from panel:", error);
      await interaction.editReply("Something went wrong while preparing the week end.");
    }
  }

  return {
    ensureDevCommandsPanel,
    refreshDevCommandsPanel,
    recordDevCommandActivity,
  };
}

export { clearDevEndNowLock, getDevEndNowLockedUserId };
