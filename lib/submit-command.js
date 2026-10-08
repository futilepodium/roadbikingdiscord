import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  TextDisplayBuilder,
  Events,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { resolveBotEnv } from "./config.js";
import { buildReplacementPreviewTexts, buildViewSubmissionsTexts } from "./user-locale.js";
import {
  formatCooldownRemaining,
  buildCandidateImagesFromAttachments,
  extractSubmissionImageUrls,
  getSubmissionCooldownRemainingMs,
  isSubmissionCooldownExempt,
  isImageAttachment,
  repostSubmission,
} from "./submission.js";
import { getBatchForSubmissionTime } from "./week.js";

export const SUBMIT_COMMAND_NAME = "submit-photo";
export const SUBMIT_MODAL_ID = "submit-photo-modal";
export const PHOTOS_INPUT_ID = "photos";
export const DESCRIPTION_INPUT_ID = "description";
const BOT_ENV = resolveBotEnv();
export const SUBMIT_PHOTO_BUTTON_ID = `submit-photo:${BOT_ENV}`;
export const VIEW_SUBMISSIONS_BUTTON_ID = `view-submissions:${BOT_ENV}`;
export const REPLACE_BUTTON_PREFIX = `replace-photo:${BOT_ENV}:`;
export const CANCEL_BUTTON_PREFIX = `cancel-replace:${BOT_ENV}:`;
export const CHANGE_SUBMISSION_BUTTON_PREFIX = `change-submission:${BOT_ENV}:`;
export const DELETE_SUBMISSION_BUTTON_PREFIX = `delete-submission:${BOT_ENV}:`;
export const LEGACY_REPLACE_BUTTON_PREFIX = "replace-photo:";
export const LEGACY_CANCEL_BUTTON_PREFIX = "cancel-replace:";
export const REPLACEMENT_TTL_MS = 24 * 60 * 60 * 1000;
const REPLACEMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const batchThreadPromises = new Map();

export async function getOrCreateBatchThread({
  client,
  postingChannelId,
  store,
  batch,
}) {
  const pending = batchThreadPromises.get(batch.batchId);
  if (pending) return pending;
  const creation = (async () => {
  const existing = store.getBatch(batch.batchId);
  if (existing?.threadId) {
    const thread = await client.channels.fetch(existing.threadId).catch(() => null);
    if (thread?.isTextBased?.()) return thread;
  }
  const channel = await client.channels.fetch(postingChannelId);
  if (!channel?.threads?.create) {
    throw new Error(`Posting channel ${postingChannelId} cannot create threads`);
  }
  const thread = await channel.threads.create({
    name: `Photo submissions — ${new Date(batch.submissionDeadlineMs).toISOString().slice(0, 10)}`,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 10080,
    reason: "Private photo contest submission batch",
  });
  store.setBatchThreadId(batch.batchId, thread.id);
  return thread;
  })().finally(() => batchThreadPromises.delete(batch.batchId));
  batchThreadPromises.set(batch.batchId, creation);
  return creation;
}

export function buildSubmitPhotoSlashCommand() {
  return new SlashCommandBuilder()
    .setName(SUBMIT_COMMAND_NAME)
    .setDescription("Submit a road biking photo for the weekly contest")
    .toJSON();
}

export async function registerSubmitPhotoSlashCommand({ token, clientId, guildId }) {
  const rest = new REST({ version: "10" }).setToken(token);
  const existing = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
  const nextCommands = [
    ...existing.filter((command) => command.name !== SUBMIT_COMMAND_NAME),
    buildSubmitPhotoSlashCommand(),
  ];

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: nextCommands,
  });
}

export function buildSubmitPhotoButtonRow() {
  return buildPromptButtonRows()[0];
}

export function buildPromptButtonRows() {
  const texts = buildViewSubmissionsTexts(null);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(SUBMIT_PHOTO_BUTTON_ID)
        .setLabel("Submit Photo")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(VIEW_SUBMISSIONS_BUTTON_ID)
        .setLabel(texts.viewButton)
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function parseSubmissionManagementButtonCustomId(customId) {
  for (const [action, prefix] of [
    ["change", CHANGE_SUBMISSION_BUTTON_PREFIX],
    ["delete", DELETE_SUBMISSION_BUTTON_PREFIX],
  ]) {
    if (!customId.startsWith(prefix)) {
      continue;
    }
    const batchId = customId.slice(prefix.length);
    if (batchId) {
      return { action, batchId };
    }
  }
  return null;
}

export function buildViewSubmissionsDmPayload(entry, batchId, userId) {
  const texts = buildViewSubmissionsTexts(userId);
  const image = entry.images[0];
  return {
    components: [
      new TextDisplayBuilder().setContent(texts.heading),
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(image.url),
      ),
      buildSubmissionManagementButtons(batchId, userId),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function buildSubmissionManagementButtons(batchId, userId) {
  const texts = buildViewSubmissionsTexts(userId);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CHANGE_SUBMISSION_BUTTON_PREFIX}${batchId}`)
      .setLabel(texts.change)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${DELETE_SUBMISSION_BUTTON_PREFIX}${batchId}`)
      .setLabel(texts.delete)
      .setStyle(ButtonStyle.Danger),
  );
}

export async function beginSubmitPhotoFlow(
  interaction,
  { store, submissionCooldownExemptUserIds },
) {
  const batch = getBatchForSubmissionTime();
  const storedBatch = store.ensureBatch(batch);
  if (storedBatch.publishedAt) {
    await interaction.reply({
      content: "Submissions are closed until the next weekly period.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const existing = store.getContestEntry(batch.batchId, interaction.user.id);
  const remainingMs = existing ? 0 : getSubmissionCooldownRemainingMs(
    interaction.user.id,
    store,
    Date.now(),
    submissionCooldownExemptUserIds,
  );
  if (remainingMs > 0) {
    await interaction.reply({
      content: `You can submit again in ${formatCooldownRemaining(remainingMs)}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildSubmitPhotoModal());
}

export function buildSubmitPhotoModal() {
  return new ModalBuilder()
    .setCustomId(SUBMIT_MODAL_ID)
    .setTitle("Submit Road Biking Photo")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Photos")
        .setDescription("Upload exactly one road biking photo.")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(PHOTOS_INPUT_ID)
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Description")
        .setDescription("Optional caption for your photo.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(DESCRIPTION_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(1000),
        ),
    );
}

export function registerSubmitPhotoHandlers(
  client,
  {
    allowedGuildId,
    postingChannelId,
    store,
    submissionCooldownExemptUserIds,
    refreshSubmissionPrompt,
    refreshModReviewPanel,
  },
) {
  client.on(Events.InteractionCreate, async (interaction) => {
    const replacementButton = interaction.isButton?.()
      ? parseReplacementButtonCustomId(interaction.customId)
      : null;
    const managementButton = interaction.isButton?.()
      ? parseSubmissionManagementButtonCustomId(interaction.customId)
      : null;
    const isReplacementButton = Boolean(replacementButton);
    const isDmButton = Boolean(replacementButton || managementButton);
    if (!isDmButton && interaction.guildId !== allowedGuildId) {
      return;
    }

    if (isReplacementButton) {
      await handleReplacementButton({
        interaction, client, store, postingChannelId, replacementButton,
      });
      return;
    }

    if (managementButton?.action === "delete") {
      await handleDeleteSubmissionButton({
        interaction,
        client,
        store,
        postingChannelId,
        batchId: managementButton.batchId,
        refreshSubmissionPrompt,
        refreshModReviewPanel,
      });
      return;
    }

    if (managementButton?.action === "change") {
      await handleChangeSubmissionButton({
        interaction,
        batchId: managementButton.batchId,
        store,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === VIEW_SUBMISSIONS_BUTTON_ID) {
      await handleViewSubmissionsButton(interaction, { store });
      return;
    }

    if (
      (interaction.isChatInputCommand() && interaction.commandName === SUBMIT_COMMAND_NAME) ||
      (interaction.isButton() && interaction.customId === SUBMIT_PHOTO_BUTTON_ID)
    ) {
      await beginSubmitPhotoFlow(interaction, { store, submissionCooldownExemptUserIds });
      return;
    }

    if (!interaction.isModalSubmit() || interaction.customId !== SUBMIT_MODAL_ID) {
      return;
    }

    const modalBatch = getBatchForSubmissionTime();
    const storedModalBatch = store.ensureBatch(modalBatch);
    if (storedModalBatch.publishedAt) {
      await interaction.reply({
        content: "Submissions closed before this form was sent. Please try again next period.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const existingAtSubmit = store.getContestEntry(modalBatch.batchId, interaction.user.id);
    const remainingMs = existingAtSubmit ? 0 : getSubmissionCooldownRemainingMs(
      interaction.user.id,
      store,
      Date.now(),
      submissionCooldownExemptUserIds,
    );
    if (remainingMs > 0) {
      await interaction.reply({
        content: `You can submit again in ${formatCooldownRemaining(remainingMs)}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const description = interaction.fields.getTextInputValue(DESCRIPTION_INPUT_ID).trim();
    const uploadedFiles = interaction.fields.getUploadedFiles(PHOTOS_INPUT_ID, true);

    if (!uploadedFiles || uploadedFiles.size !== 1) {
      await interaction.reply({
        content: "Exactly one photo is required.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const attachments = [...uploadedFiles.values()];
      const batch = getBatchForSubmissionTime();
      store.ensureBatch(batch);
      const existing = store.getContestEntry(batch.batchId, interaction.user.id);
      if (existing) {
        await createReplacementPreview({
          interaction, store, existing, batch, attachments, description,
        });
        return;
      }
      const hiddenThread = await getOrCreateBatchThread({
        client, postingChannelId, store, batch,
      });
      const message = await repostSubmission({
        client,
        postingChannel: hiddenThread,
        user: interaction.user,
        description,
        attachments,
        store,
        anonymous: true,
      });

      const photoCount = attachments.filter(isImageAttachment).length;
      const inserted = store.recordContestEntry({
        hiddenMessageId: message.id,
        batchId: batch.batchId,
        userId: interaction.user.id,
        description,
        images: extractSubmissionImageUrls(message),
        photoCount,
      });
      if (!inserted) {
        await message.delete().catch(() => {});
        throw new Error("A submission for this user and batch already exists");
      }

      if (!isSubmissionCooldownExempt(interaction.user.id, submissionCooldownExemptUserIds)) {
        store.setLastSubmissionAt(interaction.user.id);
      }

      await refreshSubmissionPrompt?.().catch((error) => {
        console.error("Failed to refresh prompt after submission:", error);
      });
      await refreshModReviewPanel?.().catch((error) => {
        console.error("Failed to refresh mod review panel after submission:", error);
      });

      await interaction.editReply(
        `Your submission is hidden until mod review finishes and voting opens <t:${Math.floor(batch.votingStartMs / 1000)}:R>.`,
      );
    } catch (error) {
      console.error(`Failed to handle photo submission from ${interaction.user.id}:`, error);
      await interaction.editReply(
        "Something went wrong while posting your submission. Please try again.",
      );
    }
  });
}

export function parseReplacementButtonCustomId(customId) {
  for (const [replacing, prefixes] of [
    [true, [REPLACE_BUTTON_PREFIX, LEGACY_REPLACE_BUTTON_PREFIX]],
    [false, [CANCEL_BUTTON_PREFIX, LEGACY_CANCEL_BUTTON_PREFIX]],
  ]) {
    for (const prefix of prefixes) {
      if (!customId.startsWith(prefix)) continue;
      const replacementId = customId.slice(prefix.length);
      if (REPLACEMENT_ID_PATTERN.test(replacementId)) {
        return { replacing, replacementId };
      }
      const envSeparator = replacementId.indexOf(":");
      if (envSeparator === -1) continue;
      const scopedId = replacementId.slice(envSeparator + 1);
      if (REPLACEMENT_ID_PATTERN.test(scopedId)) {
        return { replacing, replacementId: scopedId };
      }
    }
  }
  return null;
}

function buildReplacementButtons(replacementId, userId) {
  const texts = buildReplacementPreviewTexts(userId);

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REPLACE_BUTTON_PREFIX}${replacementId}`)
      .setLabel(texts.replace)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CANCEL_BUTTON_PREFIX}${replacementId}`)
      .setLabel(texts.cancel)
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function createReplacementPreview({
  interaction,
  store,
  existing,
  batch,
  attachments,
  description = "",
  now = Date.now(),
}) {
  const replacementId = randomUUID();
  const candidateImages = buildCandidateImagesFromAttachments(attachments);
  const files = await Promise.all(
    attachments.filter(isImageAttachment).map(async (attachment) => {
      const response = await fetch(attachment.url);
      if (!response.ok) throw new Error(`Failed to download candidate image: ${response.status}`);
      return {
        attachment: Buffer.from(await response.arrayBuffer()),
        name: attachment.name ?? "candidate.jpg",
      };
    }),
  );
  if (files.length !== 1) throw new Error("Exactly one image attachment is required");

  const userId = interaction.user.id;
  const texts = buildReplacementPreviewTexts(userId);
  const dm = await interaction.user.createDM();
  const existingImage = existing.images[0];
  const preview = await dm.send({
    components: [
      new TextDisplayBuilder().setContent(texts.heading),
      new TextDisplayBuilder().setContent(texts.current),
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(existingImage.url),
      ),
      new TextDisplayBuilder().setContent(texts.candidate),
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${files[0].name}`),
      ),
      buildReplacementButtons(replacementId, userId),
    ],
    files,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
  store.createPendingReplacement({
    replacementId,
    batchId: batch.batchId,
    userId: interaction.user.id,
    existingHiddenMessageId: existing.hiddenMessageId,
    candidateDescription: description,
    candidateImages,
    dmMessageId: preview.id,
    createdAt: now,
    expiresAt: now + REPLACEMENT_TTL_MS,
  });
  await interaction.editReply(texts.checkDms);
}

export async function handleViewSubmissionsButton(interaction, { store }) {
  const userId = interaction.user.id;
  const texts = buildViewSubmissionsTexts(userId);
  const batch = getBatchForSubmissionTime();
  const storedBatch = store.ensureBatch(batch);
  if (storedBatch.publishedAt) {
    await interaction.reply({
      content: texts.submissionsClosed,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = store.getContestEntry(batch.batchId, userId);
  if (!existing) {
    await interaction.reply({
      content: texts.noSubmission,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (store.getPendingReplacementForUser(batch.batchId, userId)) {
    await interaction.reply({
      content: texts.pendingReplacement,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const dm = await interaction.user.createDM();
    await dm.send(buildViewSubmissionsDmPayload(existing, batch.batchId, userId));
    await interaction.editReply(texts.checkDms);
  } catch (error) {
    if (error?.code === 50007) {
      await interaction.editReply(texts.dmFailed);
      return;
    }
    console.error(`Failed to DM submission view to ${userId}:`, error);
    await interaction.editReply(texts.dmFailed);
  }
}

export async function handleChangeSubmissionButton(interaction, { batchId, store }) {
  const userId = interaction.user.id;
  const texts = buildViewSubmissionsTexts(userId);
  const batch = store.getBatch(batchId);
  if (!batch || batch.publishedAt) {
    await interaction.reply({
      content: texts.submissionsClosed,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = store.getContestEntry(batchId, userId);
  if (!existing) {
    await interaction.reply({
      content: texts.deleteUnavailable,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (store.getPendingReplacementForUser(batchId, userId)) {
    await interaction.reply({
      content: texts.pendingReplacement,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: texts.changeInstructions,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleDeleteSubmissionButton({
  interaction,
  client,
  store,
  postingChannelId,
  batchId,
  refreshSubmissionPrompt,
  refreshModReviewPanel,
}) {
  const userId = interaction.user.id;
  const texts = buildViewSubmissionsTexts(userId);
  const batch = store.getBatch(batchId);
  if (!batch || batch.publishedAt) {
    await interaction.reply({
      content: texts.submissionsClosed,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = store.getContestEntry(batchId, userId);
  if (!existing) {
    await interaction.reply({
      content: texts.deleteUnavailable,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const deleted = store.deleteContestEntry(batchId, userId);
    if (!deleted) {
      await interaction.editReply(texts.deleteUnavailable);
      return;
    }

    store.clearSubmissionCooldown(userId);
    const hiddenThread = await getOrCreateBatchThread({
      client, postingChannelId, store, batch,
    });
    await hiddenThread.messages.fetch(deleted.hiddenMessageId)
      .then((message) => message.delete())
      .catch(() => {});

    await refreshSubmissionPrompt?.().catch((error) => {
      console.error("Failed to refresh prompt after submission delete:", error);
    });
    await refreshModReviewPanel?.().catch((error) => {
      console.error("Failed to refresh mod review panel after submission delete:", error);
    });

    await interaction.editReply(texts.deleted);
  } catch (error) {
    console.error(`Failed to delete submission for ${userId} in ${batchId}:`, error);
    await interaction.editReply(texts.deleteFailed);
  }
}

export async function handleReplacementButton({
  interaction,
  client,
  store,
  postingChannelId,
  replacementButton,
}) {
  const userId = interaction.user.id;
  const texts = buildReplacementPreviewTexts(userId);
  const { replacing, replacementId } = replacementButton;
  const current = store.getPendingReplacement(replacementId);
  if (!current || current.userId !== userId) {
    await interaction.reply({
      content: texts.unavailable,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!replacing) {
    const cancelled = store.cancelReplacement(replacementId, userId);
    await interaction.reply({
      content: cancelled ? texts.cancelled : `This request was already ${current.status}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const claimed = store.claimReplacement(replacementId, interaction.user.id);
  if (!claimed) {
    const resolved = store.getPendingReplacement(replacementId);
    await interaction.reply({
      content: `This request was already ${resolved?.status ?? "resolved"}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const batch = store.getBatch(claimed.batchId);
    const hiddenThread = await getOrCreateBatchThread({
      client, postingChannelId, store, batch,
    });
    const message = await repostSubmission({
      client,
      postingChannel: hiddenThread,
      user: interaction.user,
      description: claimed.candidateDescription,
      attachments: claimed.candidateImages,
      store,
      anonymous: true,
    });
    store.completeReplacement(replacementId, {
      hiddenMessageId: message.id,
      description: claimed.candidateDescription,
      images: extractSubmissionImageUrls(message),
    });
    await hiddenThread.messages.fetch(claimed.existingHiddenMessageId)
      .then((oldMessage) => oldMessage.delete())
      .catch(() => {});
    await interaction.editReply(texts.replaced);
  } catch (error) {
    store.releaseReplacement(replacementId);
    console.error(`Failed replacement ${replacementId}:`, error);
    await interaction.editReply(texts.failed);
  }
}
