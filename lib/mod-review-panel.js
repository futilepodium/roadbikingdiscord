import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { resolveBotEnv } from "./config.js";
import { getOrCreateBatchThread } from "./submit-command.js";
import { getBatchForSubmissionTime } from "./week.js";

export const MOD_REVIEW_PANEL_HEADER = "# Photo contest — mod review";

export function buildModReviewThreadUrl(guildId, threadId) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

export function buildModReviewPanelPayload({
  guildId,
  threadId = null,
  submissionCount = 0,
  submissionDeadlineMs = null,
  votingStartMs = null,
  published = false,
} = {}) {
  const photoLabel = submissionCount === 1 ? "submission" : "submissions";
  const lines = [
    MOD_REVIEW_PANEL_HEADER,
    "",
    published
      ? "The current batch is in voting. The next submission thread will appear here when submissions reopen."
      : `${submissionCount} ${photoLabel} waiting for review.`,
  ];

  if (!published && submissionDeadlineMs) {
    lines.push(
      `Submissions close <t:${Math.floor(submissionDeadlineMs / 1000)}:R>.`,
    );
  }
  if (!published && votingStartMs) {
    lines.push(
      `Approved entries publish for voting <t:${Math.floor(votingStartMs / 1000)}:R>.`,
      "",
      "Delete any entry in the review thread to reject it before voting opens.",
    );
  }

  const components = [
    new TextDisplayBuilder().setContent(lines.join("\n")),
  ];

  if (threadId) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("View submissions channel")
          .setStyle(ButtonStyle.Link)
          .setURL(buildModReviewThreadUrl(guildId, threadId)),
      ),
    );
  }

  return {
    components,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

export function registerModReviewPanelHandlers(
  client,
  {
    allowedGuildId,
    channelId,
    postingChannelId,
    store,
  },
) {
  if (resolveBotEnv() !== "development" || !channelId) {
    return {
      ensureModReviewPanel: async () => {},
      refreshModReviewPanel: async () => {},
    };
  }

  async function resolveReviewBatchContext() {
    const batch = getBatchForSubmissionTime();
    const stored = store.ensureBatch(batch);
    if (stored.publishedAt) {
      return {
        batch: stored,
        threadId: stored.threadId ?? null,
        submissionCount: 0,
        published: true,
      };
    }

    let threadId = stored.threadId ?? null;
    if (!threadId && store.getBatchEntries(stored.batchId).length > 0) {
      const thread = await getOrCreateBatchThread({
        client,
        postingChannelId,
        store,
        batch: stored,
      });
      threadId = thread.id;
    }

    return {
      batch: stored,
      threadId,
      submissionCount: store.getBatchEntries(stored.batchId).length,
      published: false,
    };
  }

  async function refreshModReviewPanel() {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      return null;
    }

    const context = await resolveReviewBatchContext();
    const payload = buildModReviewPanelPayload({
      guildId: allowedGuildId,
      threadId: context.threadId,
      submissionCount: context.submissionCount,
      submissionDeadlineMs: context.batch.submissionDeadlineMs,
      votingStartMs: context.batch.votingStartMs,
      published: context.published,
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

  async function ensureModReviewPanel({ log = false } = {}) {
    const message = await refreshModReviewPanel();
    if (log && message) {
      console.log(`Ensured mod review panel in channel ${channelId} (${message.id})`);
    }
    return message;
  }

  client.on(Events.MessageCreate, async (message) => {
    if (
      message.author?.id !== client.user?.id ||
      message.channelId !== channelId ||
      !message.content?.startsWith(MOD_REVIEW_PANEL_HEADER)
    ) {
      return;
    }

    const storedMessageId = store.getPromptMessageId(channelId);
    if (storedMessageId && message.id !== storedMessageId) {
      await message.delete().catch(() => {});
    }
  });

  return {
    ensureModReviewPanel,
    refreshModReviewPanel,
  };
}
