import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType, MessageFlags } from "discord.js";
import {
  buildVotingChannelEndOfWeekContent,
  buildVotingChannelEndOfWeekPayload,
  buildWinnersAnnouncementIntro,
  buildWinnersAnnouncementPayload,
  buildWinnersAnnouncementTitle,
  buildWinnerAttributionLine,
  formatWinnersPostTitle,
  buildWeekEndNotifiedKey,
  canUseEndNow,
  fetchSubmissionReactionCount,
  formatReactionLine,
  formatWinnerVoteLine,
  MAIN_POST_WINNER_COUNT,
  parseEndNowAllowedUserIds,
  getEndedWeekIfAny,
  getNextContestStartMs,
  isPendingWeekEndStillValid,
  isTransientDiscordError,
  pickTopWinners,
  postWeekWinners,
  publishRankedResultsThread,
  rankContestEntries,
  withTransientRetry,
  WINNER_LIMIT,
} from "./week-end.js";
import { SUBMISSION_REPOST_REACTION_EMOJI } from "./submission.js";
import { PhotoContestStore } from "./store.js";
import { getWeekInfo, WEEK_MS } from "./week.js";

test("canUseEndNow allows only configured users", () => {
  const allowedUserIds = parseEndNowAllowedUserIds(
    "1107839461582184458,120883716330487809",
  );

  assert.equal(canUseEndNow("1107839461582184458", allowedUserIds), true);
  assert.equal(canUseEndNow("120883716330487809", allowedUserIds), true);
  assert.equal(canUseEndNow("999", allowedUserIds), false);
});

test("pickTopWinners returns top 3 with one entry per user", () => {
  const winners = pickTopWinners([
    { userId: "a", reactionCount: 10, submittedAt: 1 },
    { userId: "a", reactionCount: 9, submittedAt: 2 },
    { userId: "b", reactionCount: 8, submittedAt: 3 },
    { userId: "c", reactionCount: 7, submittedAt: 4 },
    { userId: "d", reactionCount: 6, submittedAt: 5 },
  ]);

  assert.deepEqual(
    winners.map((winner) => winner.userId),
    ["a", "b", "c"],
  );
});

test("full ranking uses deterministic oldest-then-id tie breaking", () => {
  const ranked = rankContestEntries([
    { messageId: "b", reactionCount: 4, submittedAt: 2 },
    { messageId: "c", reactionCount: 5, submittedAt: 1 },
    { messageId: "a", reactionCount: 4, submittedAt: 2 },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.messageId), ["c", "a", "b"]);
});

test("bounded retry retries transient failures but not validation errors", async () => {
  let calls = 0;
  const result = await withTransientRetry(async () => {
    calls += 1;
    if (calls < 3) throw { status: 503 };
    return "ok";
  }, { delay: async () => {} });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(isTransientDiscordError({ status: 403 }), false);

  calls = 0;
  await assert.rejects(() => withTransientRetry(async () => {
    calls += 1;
    throw { status: 400 };
  }, { delay: async () => {} }));
  assert.equal(calls, 1);
});

test("ranked results thread resumes without duplicate entry posts", async () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-results-${Date.now()}-${Math.random()}.db`);
  const batch = { batchId: "results", submissionDeadlineMs: 1, votingStartMs: 1, votingEndMs: 2 };
  store.ensureBatch(batch);
  const ranking = [];
  for (let rank = 1; rank <= 4; rank += 1) {
    const hiddenMessageId = `hidden-${rank}`;
    store.recordContestEntry({
      hiddenMessageId, batchId: batch.batchId, userId: `user-${rank}`,
      description: `entry ${rank}`, images: [{ url: `https://example.test/${rank}.jpg`, name: `${rank}.jpg` }],
      photoCount: 1, submittedAt: rank,
    });
    ranking.push({ hiddenMessageId, rank, reactionCount: 5 - rank });
  }
  const sent = [];
  const thread = {
    id: "thread",
    send: async (payload) => {
      sent.push(payload);
      return { id: `result-${sent.length}` };
    },
  };
  let threadCreates = 0;
  const winnersMessage = {
    client: { channels: { fetch: async () => thread } },
    startThread: async () => {
      threadCreates += 1;
      return thread;
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  try {
    await publishRankedResultsThread({ store, batchId: batch.batchId, winnersMessage, ranking });
    await publishRankedResultsThread({ store, batchId: batch.batchId, winnersMessage, ranking });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(threadCreates, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0].content, /#3/);
  assert.match(sent[1].content, /#4/);
  assert.equal(store.getResultRanking(batch.batchId)[0].resultMessageId, null);
  assert.equal(store.getResultRanking(batch.batchId)[1].resultMessageId, null);
  assert.equal(store.getResultRanking(batch.batchId)[2].resultMessageId, "result-1");
  assert.equal(store.getResultRanking(batch.batchId)[3].resultMessageId, "result-2");
});

test("buildWinnersAnnouncementTitle and intro use the new winners copy", () => {
  assert.equal(buildWinnersAnnouncementTitle(1), "**WK1 over!**");
  assert.equal(
    buildWinnersAnnouncementIntro(),
    "Here are the top contenders from the last week!",
  );
});

test("buildWinnerAttributionLine uses plain text without a heading marker", () => {
  assert.equal(
    buildWinnerAttributionLine({ toString: () => "@Boz" }, ":u120883716330487809:"),
    ":u120883716330487809: @Boz",
  );
});

test("formatWinnersPostTitle wraps titles in bold and strips heading markers", () => {
  assert.equal(formatWinnersPostTitle("# WK2 over!"), "**WK2 over!**");
  assert.equal(formatWinnersPostTitle("Custom title"), "**Custom title**");
  assert.equal(formatWinnersPostTitle("**Already bold**"), "**Already bold**");
  assert.equal(formatWinnersPostTitle(""), "");
});

test("buildWinnersAnnouncementPayload omits empty title and place descriptions", async () => {
  const payload = await buildWinnersAnnouncementPayload(
    { users: { fetch: async () => ({}) } },
    {},
    { title: "", descriptionP1: "", descriptionP2: "", winners: [] },
  );

  assert.equal(payload.components.length, 1);
  assert.equal(payload.components[0].data.content, "No submissions received this week.");
});

test("buildWinnersAnnouncementPayload includes only a non-empty title", async () => {
  const payload = await buildWinnersAnnouncementPayload(
    { users: { fetch: async () => ({}) } },
    {},
    {
      title: "# WK2 over!",
      descriptionP1: "",
      descriptionP2: "",
      winners: [],
    },
  );

  assert.equal(payload.components.length, 2);
  assert.equal(payload.components[0].data.content, "**WK2 over!**");
  assert.equal(payload.components[1].data.content, "No submissions received this week.");
});

test("postWeekWinners omits empty title when there are no submissions", async () => {
  let sentPayload;
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (payload) => {
          sentPayload = payload;
          return { id: "winners-message" };
        },
      }),
    },
  };

  await postWeekWinners({
    client,
    store: {},
    winnersChannelId: "winners",
    title: "",
    descriptionP1: "",
    descriptionP2: "",
    winners: [],
  });

  assert.equal(sentPayload.content, "No submissions received this week.");
});

test("main post winner count is two while winner limit stays three", () => {
  assert.equal(MAIN_POST_WINNER_COUNT, 2);
  assert.equal(WINNER_LIMIT, 3);
});

test("ranked results thread skips placements already shown in the main post", () => {
  const ranking = [
    { rank: 1, resultMessageId: null },
    { rank: 2, resultMessageId: null },
    { rank: 3, resultMessageId: null },
    { rank: 4, resultMessageId: null },
  ];
  const remaining = ranking.filter(
    (entry) => !entry.resultMessageId && entry.rank > MAIN_POST_WINNER_COUNT,
  );

  assert.deepEqual(remaining.map((entry) => entry.rank), [3, 4]);
});

test("buildVotingChannelEndOfWeekContent links winners and posting channels", () => {
  const content = buildVotingChannelEndOfWeekContent({
    weekNumber: 1,
    winnersChannelId: "1555679698820800562",
    postingChannelId: "1555675560267620442",
  });

  assert.match(content, /End of the week! wk1 is now closed\./);
  assert.match(content, /<#1555679698820800562>/);
  assert.match(content, /<#1555675560267620442>/);
});

test("buildVotingChannelEndOfWeekPayload wraps end-of-week copy in a container", () => {
  const payload = buildVotingChannelEndOfWeekPayload({
    weekNumber: 1,
    winnersChannelId: "1555679698820800562",
    postingChannelId: "1555675560267620442",
  });

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(payload.components.length, 1);

  const container = payload.components[0].toJSON();
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.components.length, 1);
  assert.equal(container.components[0].type, ComponentType.TextDisplay);
  assert.match(container.components[0].content, /End of the week! wk1 is now closed\./);
});

test("formatReactionLine shows the star emoji and count", () => {
  assert.equal(formatReactionLine(1), "⭐ 1");
  assert.equal(formatReactionLine(4), "⭐ 4");
});

test("formatWinnerVoteLine adds a trailing separator after the vote count", () => {
  assert.equal(formatWinnerVoteLine(0), "⭐ 0 --");
  assert.equal(formatWinnerVoteLine(4), "⭐ 4 --");
});

test("fetchSubmissionReactionCount excludes bot and submitter reactions", async () => {
  const reactionUsers = new Map([
    ["bot-user", {}],
    ["submitter-1", {}],
    ["voter-1", {}],
  ]);
  const message = {
    client: { user: { id: "bot-user" } },
    reactions: {
      cache: {
        find: () => ({
          emoji: { name: SUBMISSION_REPOST_REACTION_EMOJI, toString: () => SUBMISSION_REPOST_REACTION_EMOJI },
          count: 3,
          users: {
            fetch: async () => ({
              has: (userId) => reactionUsers.has(userId),
            }),
          },
        }),
      },
    },
  };

  assert.equal(await fetchSubmissionReactionCount(message), 2);
  assert.equal(
    await fetchSubmissionReactionCount(message, { submitterUserId: "submitter-1" }),
    1,
  );
});

test("getNextContestStartMs advances to the next week number", () => {
  const contestStartMs = Date.parse("2026-10-01T00:00:00.000Z");
  const now = contestStartMs + 2 * WEEK_MS + 60_000;
  const before = getWeekInfo(now, contestStartMs).weekNumber;
  const nextStart = getNextContestStartMs(contestStartMs, now);
  const after = getWeekInfo(now, nextStart).weekNumber;

  assert.equal(after, before + 1);
});

test("getEndedWeekIfAny returns the most recently ended week", () => {
  const contestStartMs = Date.parse("2026-10-02T21:00:00.000Z");
  const firstWeekEndMs = Date.parse("2026-10-13T00:00:00.000Z");
  const now = Date.parse("2026-10-13T01:00:00.000Z");
  const endedWeek = getEndedWeekIfAny(now, contestStartMs, firstWeekEndMs);

  assert.deepEqual(endedWeek, {
    weekNumber: 1,
    weekStartMs: contestStartMs,
    weekEndMs: firstWeekEndMs,
  });
  assert.equal(buildWeekEndNotifiedKey(endedWeek.weekStartMs), `week_end_notified_${contestStartMs}`);
});

test("isPendingWeekEndStillValid is false after the week has been finalized", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-valid-${Date.now()}.db`);
  const prepared = {
    weekEndMs: Date.parse("2026-10-13T00:00:00.000Z"),
  };

  store.setSetting("contest_week_start_ms", String(Date.parse("2026-10-02T21:00:00.000Z")));
  assert.equal(isPendingWeekEndStillValid(prepared, store), true);

  store.setSetting("contest_week_start_ms", String(prepared.weekEndMs));
  assert.equal(isPendingWeekEndStillValid(prepared, store), false);
});

test("getNextContestStartMs uses the extended first week end", () => {
  const contestStartMs = Date.parse("2026-10-02T21:00:00.000Z");
  const firstWeekEndMs = Date.parse("2026-10-13T00:00:00.000Z");
  const now = Date.parse("2026-10-10T12:00:00.000Z");

  assert.equal(getNextContestStartMs(contestStartMs, now, firstWeekEndMs), firstWeekEndMs);
});
