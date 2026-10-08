import {
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { getOrCreateUserAvatarEmoji } from "./application-emoji.js";
import {
  buildWinnerImageFilename,
  downloadImageAttachment,
  extractSubmissionImageUrls,
  SUBMISSION_REPOST_REACTION_EMOJI,
} from "./submission.js";
import { parseUserIdList } from "./config.js";
import { getCurrentWeekStartMs, getWeekInfo, WEEK_MS } from "./week.js";
import { syncPhotoContestWinnerRole } from "./winner-role.js";

export const WINNER_LIMIT = 3;
export const MAIN_POST_WINNER_COUNT = 2;
const CONTEST_START_KEY = "contest_week_start_ms";

export function parseEndNowAllowedUserIds(
  value = process.env.END_NOW_ALLOWED_USER_IDS,
) {
  return parseUserIdList(value);
}

export function parseEndNowDmUserIds(
  value = process.env.END_NOW_DM_USER_IDS,
) {
  return parseUserIdList(value);
}

export function getEndNowSendTestUserId(
  value = process.env.END_NOW_SEND_TEST_USER_ID,
) {
  return String(value ?? "").trim();
}

export function canUseEndNow(
  userId,
  allowedUserIds = parseEndNowAllowedUserIds(),
  dmUserIds = parseEndNowDmUserIds(),
) {
  return allowedUserIds.has(userId) || dmUserIds.has(userId);
}

export function resolveEndNowComposeDmUserIds({ extraUserIds = [] } = {}) {
  const userIds = new Set([...parseEndNowDmUserIds(), ...extraUserIds]);
  return [...userIds];
}

export function formatReactionLine(reactionCount) {
  return `${SUBMISSION_REPOST_REACTION_EMOJI} ${reactionCount}`;
}

export function formatWinnerVoteLine(reactionCount) {
  return `${formatReactionLine(reactionCount)} --`;
}

export function buildWinnersAnnouncementTitle(weekNumber) {
  return `**WK${weekNumber} over!**`;
}

export function formatWinnersPostTitle(title) {
  const trimmed = title?.trim();
  if (!trimmed) {
    return "";
  }

  let text = trimmed.replace(/^#+\s*/, "");
  if (/^\*\*.+\*\*$/.test(text)) {
    return text;
  }

  return `**${text}**`;
}

export function buildWinnersAnnouncementIntro() {
  return "Here are the top contenders from the last week!";
}

export function buildVotingChannelEndOfWeekContent({
  weekNumber,
  winnersChannelId,
  postingChannelId,
}) {
  return [
    `End of the week! wk${weekNumber} is now closed.`,
    `See the winners in <#${winnersChannelId}>.`,
    `Submit your next photo in <#${postingChannelId}>.`,
  ].join("\n");
}

export function pickTopWinners(entries, limit = WINNER_LIMIT) {
  const winners = [];
  const users = new Set();
  for (const entry of rankContestEntries(entries)) {
    if (users.has(entry.userId)) continue;
    users.add(entry.userId);
    winners.push(entry);
    if (winners.length === limit) break;
  }
  return winners;
}

export function rankContestEntries(entries) {
  return [...entries].sort((left, right) => {
    if (right.reactionCount !== left.reactionCount) {
      return right.reactionCount - left.reactionCount;
    }
    if (left.submittedAt !== right.submittedAt) {
      return left.submittedAt - right.submittedAt;
    }
    return String(left.messageId ?? left.hiddenMessageId ?? "")
      .localeCompare(String(right.messageId ?? right.hiddenMessageId ?? ""));
  });
}

export function buildWeekEndNotifiedKey(weekStartMs) {
  return `week_end_notified_${weekStartMs}`;
}

export function isPendingWeekEndStillValid(prepared, store) {
  if (!prepared?.weekEndMs) {
    return false;
  }

  return store.getContestWeekStartMs() < prepared.weekEndMs;
}

export function getEndedWeekIfAny(now, contestStartMs, firstWeekEndMs = null) {
  const parsedFirstWeekEndMs = Number(firstWeekEndMs);
  const hasFirstWeekEnd =
    Number.isFinite(parsedFirstWeekEndMs) && parsedFirstWeekEndMs > contestStartMs;
  const periods = [];

  if (hasFirstWeekEnd) {
    periods.push({
      weekNumber: 1,
      weekStartMs: contestStartMs,
      weekEndMs: parsedFirstWeekEndMs,
    });

    let weekStartMs = parsedFirstWeekEndMs;
    let weekNumber = 2;
    while (weekStartMs < now) {
      periods.push({
        weekNumber,
        weekStartMs,
        weekEndMs: weekStartMs + WEEK_MS,
      });
      weekStartMs += WEEK_MS;
      weekNumber += 1;
    }
  } else {
    let weekStartMs = contestStartMs;
    let weekNumber = 1;
    while (weekStartMs < now) {
      periods.push({
        weekNumber,
        weekStartMs,
        weekEndMs: weekStartMs + WEEK_MS,
      });
      weekStartMs += WEEK_MS;
      weekNumber += 1;
    }
  }

  const endedPeriods = periods.filter((period) => now >= period.weekEndMs);
  return endedPeriods.at(-1) ?? null;
}

export function getNextContestStartMs(contestStartMs, now = Date.now(), firstWeekEndMs = null) {
  const parsedFirstWeekEndMs = Number(firstWeekEndMs);
  if (Number.isFinite(parsedFirstWeekEndMs) && parsedFirstWeekEndMs > contestStartMs && now < parsedFirstWeekEndMs) {
    return parsedFirstWeekEndMs;
  }

  const { weekNumber } = getWeekInfo(now, contestStartMs, firstWeekEndMs);
  return now - weekNumber * WEEK_MS;
}

export async function fetchSubmissionReactionCount(message, { submitterUserId = null } = {}) {
  const reaction =
    message.reactions.cache.find((entry) => entry.emoji.name === SUBMISSION_REPOST_REACTION_EMOJI) ??
    message.reactions.cache.find((entry) => entry.emoji.toString() === SUBMISSION_REPOST_REACTION_EMOJI);

  if (!reaction) {
    return 0;
  }

  let count = reaction.count ?? 0;
  if (count === 0) {
    return 0;
  }

  const users = await reaction.users.fetch().catch(() => null);
  if (users) {
    if (users.has(message.client.user.id)) {
      count = Math.max(0, count - 1);
    }
    if (submitterUserId && users.has(submitterUserId)) {
      count = Math.max(0, count - 1);
    }
  }

  return count;
}

export async function collectWeeklySubmissionScores(client, postingChannel, submissions, store = null) {
  const scored = [];

  for (const submission of submissions) {
    const message = await postingChannel.messages.fetch(submission.messageId).catch(() => null);
    if (!message) {
      continue;
    }

    scored.push({
      ...submission,
      reactionCount: store
        ? store.getVoteCount(submission.messageId)
        : await fetchSubmissionReactionCount(message, { submitterUserId: submission.userId }),
      sourceMessage: message,
    });
  }

  return scored;
}

export async function downloadWinnerImageFiles(sourceMessage) {
  const imageSources = extractSubmissionImageUrls(sourceMessage);
  if (imageSources.length === 0) {
    return [];
  }

  const [primaryImage] = imageSources;
  const filename = buildWinnerImageFilename(sourceMessage.id, primaryImage.name);
  return [await downloadImageAttachment(primaryImage, filename)];
}

export function buildWinnerAttributionLine(user, avatarEmoji) {
  return `${avatarEmoji} ${String(user)}`;
}

export async function buildWinnerSectionComponents(client, store, winner, imageFiles) {
  const user = await client.users.fetch(winner.userId);
  const avatarEmoji = await getOrCreateUserAvatarEmoji(client, user, store);

  const components = [];
  const files = [];

  for (const imageFile of imageFiles) {
    components.push(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${imageFile.name}`),
      ),
    );
    files.push(imageFile);
  }

  components.push(
    new TextDisplayBuilder().setContent(formatWinnerVoteLine(winner.reactionCount)),
    new TextDisplayBuilder().setContent(buildWinnerAttributionLine(user, avatarEmoji)),
  );

  return { components, files, userId: user.id };
}

export async function buildWinnerSectionsPayload(client, store, winners, { placeDescriptions = [] } = {}) {
  const components = [];
  const files = [];
  const mentionedUserIds = [];
  const usedFilenames = new Set();

  if (winners.length === 0) {
    components.push(new TextDisplayBuilder().setContent("No submissions received this week."));
    return { components, files, mentionedUserIds };
  }

  for (const [index, winner] of winners.entries()) {
    const placeDescription = placeDescriptions[index]?.trim();
    if (index === 1 && placeDescription) {
      components.push(new SeparatorBuilder().setDivider(true));
    }
    if (placeDescription) {
      components.push(new TextDisplayBuilder().setContent(placeDescription));
    }
    let imageFiles = await downloadWinnerImageFiles(winner.sourceMessage);
    imageFiles = imageFiles.map((file) => {
      if (!usedFilenames.has(file.name)) {
        usedFilenames.add(file.name);
        return file;
      }

      const uniqueName = buildWinnerImageFilename(
        `${winner.sourceMessage.id}-${usedFilenames.size}`,
        file.name,
      );
      usedFilenames.add(uniqueName);
      return new AttachmentBuilder(file.attachment, { name: uniqueName });
    });

    const section = await buildWinnerSectionComponents(client, store, winner, imageFiles);
    components.push(...section.components);
    files.push(...section.files);
    mentionedUserIds.push(section.userId);
  }

  return { components, files, mentionedUserIds };
}

export async function buildWinnersPreviewPayload(client, store, { winners }) {
  const sections = await buildWinnerSectionsPayload(client, store, winners);

  return {
    components: sections.components,
    files: sections.files,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: sections.mentionedUserIds },
  };
}

export async function buildWinnersAnnouncementPayload(
  client,
  store,
  { title, descriptionP1, descriptionP2, winners },
) {
  const sections = await buildWinnerSectionsPayload(client, store, winners, {
    placeDescriptions: [descriptionP1, descriptionP2],
  });

  const components = [];
  const formattedTitle = formatWinnersPostTitle(title);
  if (formattedTitle) {
    components.push(new TextDisplayBuilder().setContent(formattedTitle));
  }
  components.push(...sections.components);

  return {
    components,
    files: sections.files,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: sections.mentionedUserIds },
  };
}

export function buildVotingChannelEndOfWeekPayload({
  weekNumber,
  winnersChannelId,
  postingChannelId,
}) {
  return {
    components: [
      new ContainerBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          buildVotingChannelEndOfWeekContent({
            weekNumber,
            winnersChannelId,
            postingChannelId,
          }),
        ),
      ),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

export async function postVotingChannelEndOfWeekMessage({
  postingChannel,
  weekNumber,
  winnersChannelId,
  postingChannelId,
}) {
  return postingChannel.send(
    buildVotingChannelEndOfWeekPayload({
      weekNumber,
      winnersChannelId,
      postingChannelId,
    }),
  );
}

export async function postWeekWinners({
  client,
  store,
  winnersChannelId,
  title,
  descriptionP1,
  descriptionP2,
  winners,
}) {
  const winnersChannel = await client.channels.fetch(winnersChannelId);
  if (!winnersChannel?.isTextBased?.()) {
    throw new Error(`Winners channel ${winnersChannelId} not found`);
  }

  const mainPostWinners = winners.slice(0, MAIN_POST_WINNER_COUNT);

  if (mainPostWinners.length === 0) {
    const formattedTitle = formatWinnersPostTitle(title);
    const content = formattedTitle
      ? `${formattedTitle}\n\nNo submissions received this week.`
      : "No submissions received this week.";

    return winnersChannel.send({
      content,
      allowedMentions: { parse: [] },
    });
  }

  const payload = await buildWinnersAnnouncementPayload(client, store, {
    title,
    descriptionP1,
    descriptionP2,
    winners: mainPostWinners,
  });
  return winnersChannel.send(payload);
}

export function serializeWeekEndWinners(winners) {
  return winners.map((winner) => ({
    userId: winner.userId,
    reactionCount: winner.reactionCount,
    messageId: winner.sourceMessage.id,
    submittedAt: winner.submittedAt,
  }));
}

export async function hydrateWeekEndWinners(postingChannel, winners) {
  const hydrated = [];

  for (const winner of winners) {
    const sourceMessage = await postingChannel.messages.fetch(winner.messageId).catch(() => null);
    if (!sourceMessage) {
      continue;
    }

    hydrated.push({
      ...winner,
      sourceMessage,
    });
  }

  return hydrated;
}

export async function prepareWeekEnd({
  client,
  store,
  postingChannelId,
  now = Date.now(),
  endingWeek = null,
}) {
  const contestStartMs = store.getContestWeekStartMs();
  const firstWeekEndMs = store.getFirstWeekEndMs();
  const weekPeriod =
    endingWeek ??
    (() => {
      const weekNumber = getWeekInfo(now, contestStartMs, firstWeekEndMs).weekNumber;
      const weekStartMs = getCurrentWeekStartMs(now, contestStartMs, firstWeekEndMs);
      const weekEndMs = getWeekInfo(now, contestStartMs, firstWeekEndMs).weekEndMs;
      return { weekNumber, weekStartMs, weekEndMs };
    })();
  const { weekNumber, weekStartMs, weekEndMs } = weekPeriod;
  const submissions = store.getWeeklySubmissions(weekStartMs);
  const postingChannel = await client.channels.fetch(postingChannelId);

  if (!postingChannel?.isTextBased?.()) {
    throw new Error(`Posting channel ${postingChannelId} not found`);
  }

  const scored = await collectWeeklySubmissionScores(client, postingChannel, submissions, store);
  const batchEntries = weekPeriod.batchId ? store.getBatchEntries(weekPeriod.batchId) : [];
  const byPublicMessage = new Map(batchEntries.map((entry) => [entry.publicMessageId, entry]));
  const ranking = rankContestEntries(scored.map((entry) => {
    const stored = byPublicMessage.get(entry.messageId);
    return {
      ...entry,
      hiddenMessageId: stored?.hiddenMessageId ?? entry.messageId,
      description: stored?.description ?? "",
      images: stored?.images ?? extractSubmissionImageUrls(entry.sourceMessage),
    };
  })).map((entry, index) => ({ ...entry, rank: index + 1 }));
  const winners = ranking.slice(0, WINNER_LIMIT);

  return {
    weekNumber,
    weekStartMs,
    weekEndMs,
    contestStartMs,
    firstWeekEndMs,
    now,
    submissionCount: submissions.length,
    winners: serializeWeekEndWinners(winners),
    ranking: ranking.map((entry) => ({
      userId: entry.userId,
      reactionCount: entry.reactionCount,
      messageId: entry.sourceMessage.id,
      hiddenMessageId: entry.hiddenMessageId,
      submittedAt: entry.submittedAt,
      rank: entry.rank,
      description: entry.description,
      images: entry.images,
    })),
    winnerCount: winners.length,
  };
}

export async function finalizeWeekEnd({
  client,
  store,
  postingChannelId,
  winnersChannelId,
  prepared,
  title,
  descriptionP1,
  descriptionP2,
}) {
  const postingChannel = await client.channels.fetch(postingChannelId);
  if (!postingChannel?.isTextBased?.()) {
    throw new Error(`Posting channel ${postingChannelId} not found`);
  }

  const winners = await hydrateWeekEndWinners(postingChannel, prepared.winners);

  let winnersMessage;
  const existingResultsMessageId = prepared.batchId
    ? store.getBatch(prepared.batchId)?.resultsMessageId
    : null;
  if (existingResultsMessageId) {
    const winnersChannel = await client.channels.fetch(winnersChannelId);
    winnersMessage = await winnersChannel.messages.fetch(existingResultsMessageId);
  } else {
    winnersMessage = await postWeekWinners({
      client,
      store,
      winnersChannelId,
      title,
      descriptionP1,
      descriptionP2,
      winners,
    });
    if (prepared.batchId) store.setBatchResultsMessage(prepared.batchId, winnersMessage.id);
  }

  if (prepared.batchId) {
    await publishRankedResultsThread({
      store,
      batchId: prepared.batchId,
      winnersMessage,
      ranking: prepared.ranking ?? [],
    });
  }

  await postVotingChannelEndOfWeekMessage({
    postingChannel,
    weekNumber: prepared.weekNumber,
    winnersChannelId,
    postingChannelId,
  });

  if (prepared.batchId) {
    store.markBatchFinalized(prepared.batchId);
  } else {
    store.setSetting(CONTEST_START_KEY, String(prepared.weekEndMs));
    if (prepared.weekNumber === 1 && prepared.firstWeekEndMs) {
      store.clearFirstWeekEndMs();
    }
  }
  store.setSetting(buildWeekEndNotifiedKey(prepared.weekStartMs), String(prepared.now));

  const topWinnerUserId = winners[0]?.userId ?? null;
  if (postingChannel.guildId) {
    await syncPhotoContestWinnerRole({
      client,
      guildId: postingChannel.guildId,
      store,
      winnerUserId: topWinnerUserId,
    }).catch((error) => {
      console.error("Failed to sync photo contest winner role:", error);
    });
  }

  return {
    weekNumber: prepared.weekNumber,
    winnerCount: winners.length,
    submissionCount: prepared.submissionCount,
  };
}

export function isTransientDiscordError(error) {
  const status = Number(error?.status ?? error?.httpStatus);
  const code = Number(error?.code);
  return status === 429 || status >= 500 ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code) ||
    code === 20028 || code === 20029;
}

export async function withTransientRetry(operation, {
  attempts = 3,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDiscordError(error) || attempt === attempts - 1) throw error;
      const retryAfter = Number(error?.retry_after ?? error?.retryAfter);
      await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * (2 ** attempt));
    }
  }
  throw lastError;
}

export async function publishRankedResultsThread({
  store,
  batchId,
  winnersMessage,
  ranking,
}) {
  store.saveResultRanking(batchId, ranking);
  const batch = store.getBatch(batchId);
  let thread;
  if (batch.resultsThreadId) {
    thread = await winnersMessage.client.channels.fetch(batch.resultsThreadId);
  } else {
    thread = await withTransientRetry(() => winnersMessage.startThread({
      name: "Full contest results",
      autoArchiveDuration: 10080,
      reason: "Ranked photo contest results",
    }));
    store.setBatchResultsThread(batchId, thread.id);
  }

  const remaining = store.getResultRanking(batchId)
    .filter((entry) => !entry.resultMessageId && entry.rank > MAIN_POST_WINNER_COUNT);
  for (const entry of remaining) {
    const [image] = entry.images;
    const filename = buildWinnerImageFilename(entry.hiddenMessageId, image?.name);
    const files = image ? [await downloadImageAttachment(image, filename)] : [];
    const message = await withTransientRetry(() => thread.send({
      content: [
        `## #${entry.rank}`,
        `Submitted by <@${entry.userId}>`,
        entry.description,
        formatReactionLine(entry.reactionCount),
      ].filter(Boolean).join("\n"),
      files,
      allowedMentions: { users: [entry.userId] },
    }));
    store.markResultEntryPublished(batchId, entry.hiddenMessageId, message.id);
  }
  return thread;
}
