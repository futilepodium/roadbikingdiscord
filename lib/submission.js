import {
  AttachmentBuilder,
  ComponentType,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { getOrCreateUserAvatarEmoji } from "./application-emoji.js";

export const SUBMISSION_COOLDOWN_MS = 60 * 60 * 1000;
export const MAX_SUBMISSION_PHOTOS = 1;
export const SUBMISSION_REPOST_REACTION_EMOJI = "⭐";

export function parseSubmissionCooldownExemptUserIds(
  value = process.env.SUBMISSION_COOLDOWN_EXEMPT_USER_IDS,
) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isSubmissionCooldownExempt(
  userId,
  exemptUserIds = parseSubmissionCooldownExemptUserIds(),
) {
  return exemptUserIds.has(userId);
}

export function isImageAttachment(attachment) {
  if (attachment.contentType?.startsWith("image/")) {
    return true;
  }

  const name = String(attachment.name ?? "");
  if (/\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name)) {
    return true;
  }

  const url = String(attachment.url ?? "");
  return /\.(png|jpe?g|gif|webp|bmp|avif)(?:[?#]|$)/i.test(url);
}

export function getSubmissionCooldownRemainingMs(
  userId,
  store,
  now = Date.now(),
  exemptUserIds = parseSubmissionCooldownExemptUserIds(),
) {
  if (isSubmissionCooldownExempt(userId, exemptUserIds)) {
    return 0;
  }

  const lastSubmittedAt = store.getLastSubmissionAt(userId);
  if (!lastSubmittedAt) {
    return 0;
  }

  return Math.max(0, SUBMISSION_COOLDOWN_MS - (now - lastSubmittedAt));
}

export function formatCooldownRemaining(ms) {
  const minutes = Math.ceil(ms / (60 * 1000));
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  return `${minutes}m`;
}

export function getSubmissionAttachmentFilename(attachment, { index = 0, total = 1 } = {}) {
  let filename;
  if (attachment.name?.trim()) {
    filename = attachment.name.trim();
  } else {
    const match = String(attachment.url ?? "").match(
      /\/([^/?#]+\.(png|jpe?g|gif|webp|bmp|avif))/i,
    );
    filename = match?.[1] ?? "submission.jpg";
  }

  if (total <= 1 || index === 0) {
    return filename;
  }

  const dot = filename.lastIndexOf(".");
  if (dot > 0) {
    return `${filename.slice(0, dot)}-${index + 1}${filename.slice(dot)}`;
  }

  return `${filename}-${index + 1}`;
}

export async function buildSubmissionAttachmentFile(
  attachment,
  { index = 0, total = 1 } = {},
) {
  const filename = getSubmissionAttachmentFilename(attachment, { index, total });
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(
      `Failed to download submission attachment ${filename}: ${response.status}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return new AttachmentBuilder(buffer, { name: filename });
}

export async function buildSubmissionAttachmentFiles(attachments) {
  const imageAttachments = attachments.filter(isImageAttachment).slice(0, MAX_SUBMISSION_PHOTOS);
  const total = imageAttachments.length;

  return Promise.all(
    imageAttachments.map((attachment, index) =>
      buildSubmissionAttachmentFile(attachment, { index, total }),
    ),
  );
}

export function buildCandidateImagesFromAttachments(attachments) {
  const candidateImages = attachments
    .filter(isImageAttachment)
    .map((attachment) => ({
      url: attachment.url,
      name: attachment.name ?? getSubmissionAttachmentFilename(attachment),
    }));
  if (candidateImages.length !== 1) {
    throw new Error("Exactly one candidate image attachment is required");
  }
  return candidateImages;
}

export function extractAttachmentImageUrls(message) {
  const images = [];
  const seen = new Set();

  for (const attachment of message.attachments?.values?.() ?? []) {
    if (!isImageAttachment(attachment) || !attachment.url || seen.has(attachment.url)) {
      continue;
    }

    seen.add(attachment.url);
    images.push({ url: attachment.url, name: attachment.name ?? null });
  }

  return images;
}

export function extractSubmissionImageUrls(message) {
  const images = extractAttachmentImageUrls(message);
  const seen = new Set(images.map((image) => image.url));

  for (const component of message.components ?? []) {
    if (component.type !== ComponentType.MediaGallery) {
      continue;
    }

    for (const item of component.items ?? []) {
      const url = item.media?.url;
      if (!url || seen.has(url) || url.startsWith("attachment://")) {
        continue;
      }

      seen.add(url);
      images.push({ url, name: getSubmissionAttachmentFilename({ url, name: null }) });
    }
  }

  return images;
}

export function buildWinnerImageFilename(messageId, sourceName, index = 0) {
  const extensionMatch = String(sourceName ?? "").match(/\.(png|jpe?g|gif|webp|bmp|avif)$/i);
  const extension = extensionMatch?.[0] ?? ".jpg";
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `winner-${messageId}${suffix}${extension}`;
}

export async function downloadImageAttachment(source, filename) {
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`Failed to download image ${filename}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return new AttachmentBuilder(buffer, { name: filename });
}

export function buildSubmissionAttributionLine(user, avatarEmoji) {
  return `${avatarEmoji} Submitted by ${String(user)}`;
}

export function buildSubmissionRepostPayload(user, description, files, avatarEmoji, { anonymous = false } = {}) {
  const components = [];

  const trimmedDescription = description?.trim();
  if (trimmedDescription) {
    components.push(new TextDisplayBuilder().setContent(trimmedDescription));
  }

  for (const file of files) {
    components.push(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${file.name}`),
      ),
    );
  }

  if (!anonymous) {
    components.push(
      new TextDisplayBuilder().setContent(buildSubmissionAttributionLine(user, avatarEmoji)),
    );
  }

  return {
    components,
    files,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: anonymous ? { parse: [] } : { users: [user.id] },
  };
}

export async function repostSubmission({
  client,
  postingChannel,
  user,
  description,
  attachments,
  store,
  anonymous = false,
}) {
  const imageAttachments = attachments.filter(isImageAttachment);
  if (imageAttachments.length === 0) {
    throw new Error("At least one image attachment is required");
  }

  const files = await buildSubmissionAttachmentFiles(imageAttachments);
  if (imageAttachments.length !== 1) {
    throw new Error("Exactly one image attachment is required");
  }
  const avatarEmoji = anonymous ? null : await getOrCreateUserAvatarEmoji(client, user, store);
  const payload = buildSubmissionRepostPayload(
    user, description, files, avatarEmoji, { anonymous },
  );

  const message = await postingChannel.send(payload);
  await message.react(SUBMISSION_REPOST_REACTION_EMOJI);
  return message;
}
