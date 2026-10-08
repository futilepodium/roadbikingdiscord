import { parseEndNowDmUserIds, prepareWeekEnd } from "./week-end.js";
import { clearPendingWeekEnd, sendWeekEndComposeDms, setPendingWeekEnd } from "./end-now-command.js";
import { repostSubmission } from "./submission.js";
import {
  getBatchForSubmissionTime,
  INITIAL_SUBMISSION_DEADLINE_MS,
  INITIAL_VOTING_START_MS,
  REVIEW_MS,
  WEEK_MS,
} from "./week.js";

export function ensureContestBatches(store, now = Date.now()) {
  const active = getBatchForSubmissionTime(now);
  for (
    let deadline = INITIAL_SUBMISSION_DEADLINE_MS;
    deadline <= active.submissionDeadlineMs;
    deadline += WEEK_MS
  ) {
    store.ensureBatch({
      batchId: String(deadline),
      submissionDeadlineMs: deadline,
      votingStartMs: deadline + REVIEW_MS,
      votingEndMs: deadline + REVIEW_MS + WEEK_MS,
    });
  }
  return active;
}

export async function publishBatch({ client, store, postingChannelId, batch, now }) {
  if (batch.publishedAt) return false;
  const postingChannel = await client.channels.fetch(postingChannelId);
  if (!postingChannel?.isTextBased?.()) throw new Error(`Posting channel ${postingChannelId} not found`);

  for (const entry of store.getBatchEntries(batch.batchId)) {
    if (entry.publicMessageId) continue;
    const user = await client.users.fetch(entry.userId);
    const message = await repostSubmission({
      client,
      postingChannel,
      user,
      description: entry.description,
      attachments: entry.images,
      store,
      anonymous: true,
    });
    store.setEntryPublicMessage(entry.hiddenMessageId, message.id);
    store.recordWeeklySubmission({
      messageId: message.id,
      userId: entry.userId,
      weekStartMs: batch.votingStartMs,
      photoCount: entry.photoCount,
      submittedAt: entry.submittedAt,
    });
  }
  store.markBatchPublished(batch.batchId, now);
  return true;
}

export async function notifyBatchWinners({
  client,
  store,
  postingChannelId,
  batch,
  now,
  allowedUserIds = parseEndNowDmUserIds(),
}) {
  if (batch.winnersNotifiedAt) return false;
  if (store.getPendingWeekEndSession()) return false;
  const weekNumber = Math.floor(
    (batch.votingStartMs - INITIAL_VOTING_START_MS) / WEEK_MS,
  ) + 1;
  const prepared = await prepareWeekEnd({
    client,
    store,
    postingChannelId,
    now,
    endingWeek: {
      weekNumber,
      weekStartMs: batch.votingStartMs,
      weekEndMs: batch.votingEndMs,
      batchId: batch.batchId,
    },
  });
  prepared.batchId = batch.batchId;
  setPendingWeekEnd(store, prepared);
  const { sentUserIds, failedUserIds } = await sendWeekEndComposeDms({
    client,
    store,
    postingChannelId,
    prepared,
    userIds: [...allowedUserIds],
  });
  if (sentUserIds.length === 0) {
    clearPendingWeekEnd(store);
    throw new Error("Could not DM any configured week-end recipients");
  }
  if (failedUserIds.length > 0) {
    console.warn(
      `Batch ${batch.batchId} compose DMs failed for: ${failedUserIds.join(", ")}`,
    );
  }
  store.markBatchWinnersNotified(batch.batchId, now);
  return true;
}

export function createContestLifecycle(options) {
  let running = null;
  async function run(now = Date.now()) {
    if (running) return running;
    running = (async () => {
      ensureContestBatches(options.store, now);
      const results = { published: 0, notified: 0 };
      for (const batch of options.store.listDueBatches(now)) {
        if (now >= batch.votingStartMs && !batch.publishedAt) {
          if (await publishBatch({ ...options, batch, now })) {
            results.published += 1;
            await options.refreshModReviewPanel?.().catch((error) => {
              console.error("Failed to refresh mod review panel after publish:", error);
            });
          }
        }
        const refreshed = options.store.getBatch(batch.batchId);
        if (
          results.notified === 0 &&
          now >= refreshed.votingEndMs &&
          !refreshed.winnersNotifiedAt
        ) {
          if (await notifyBatchWinners({ ...options, batch: refreshed, now })) results.notified += 1;
        }
      }
      return results;
    })().finally(() => {
      running = null;
    });
    return running;
  }
  return { run };
}
