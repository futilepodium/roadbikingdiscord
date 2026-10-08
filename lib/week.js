export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const REVIEW_MS = 24 * 60 * 60 * 1000;
export const INITIAL_VOTING_START_MS = Date.parse("2026-10-12T00:00:00Z");
export const INITIAL_SUBMISSION_DEADLINE_MS = INITIAL_VOTING_START_MS - REVIEW_MS;
export const INITIAL_VOTING_DEADLINE_MS = INITIAL_VOTING_START_MS + WEEK_MS;

export function getBatchForSubmissionTime(now = Date.now()) {
  const offset = Math.max(0, Math.floor((now - INITIAL_SUBMISSION_DEADLINE_MS) / WEEK_MS) + 1);
  const submissionDeadlineMs = INITIAL_SUBMISSION_DEADLINE_MS + offset * WEEK_MS;
  const votingStartMs = submissionDeadlineMs + REVIEW_MS;
  return {
    batchId: String(submissionDeadlineMs),
    submissionDeadlineMs,
    votingStartMs,
    votingEndMs: votingStartMs + WEEK_MS,
  };
}

export function getVotingBatchAt(now = Date.now()) {
  if (now < INITIAL_VOTING_START_MS) return null;
  const votingStartMs =
    INITIAL_VOTING_START_MS +
    Math.floor((now - INITIAL_VOTING_START_MS) / WEEK_MS) * WEEK_MS;
  const submissionDeadlineMs = votingStartMs - REVIEW_MS;
  return {
    batchId: String(submissionDeadlineMs),
    submissionDeadlineMs,
    votingStartMs,
    votingEndMs: votingStartMs + WEEK_MS,
  };
}

export function getWeekInfo(now = Date.now(), contestStartMs, firstWeekEndMs = null) {
  const parsedFirstWeekEndMs = Number(firstWeekEndMs);
  const hasFirstWeekEnd =
    Number.isFinite(parsedFirstWeekEndMs) && parsedFirstWeekEndMs > contestStartMs;

  if (hasFirstWeekEnd && now <= parsedFirstWeekEndMs) {
    return {
      weekNumber: 1,
      weekEndMs: parsedFirstWeekEndMs,
      remainingMs: Math.max(0, parsedFirstWeekEndMs - now),
    };
  }

  if (hasFirstWeekEnd && now >= parsedFirstWeekEndMs) {
    const elapsed = now - parsedFirstWeekEndMs;
    const weekNumber = Math.floor(elapsed / WEEK_MS) + 2;
    const weekEndMs = parsedFirstWeekEndMs + (weekNumber - 1) * WEEK_MS;
    return {
      weekNumber,
      weekEndMs,
      remainingMs: Math.max(0, weekEndMs - now),
    };
  }

  const elapsed = Math.max(0, now - contestStartMs);
  const weekNumber = Math.floor(elapsed / WEEK_MS) + 1;
  const weekEndMs = contestStartMs + weekNumber * WEEK_MS;
  const remainingMs = Math.max(0, weekEndMs - now);

  return { weekNumber, weekEndMs, remainingMs };
}

export function formatWeekTimestamp(weekEndMs) {
  return `<t:${Math.floor(weekEndMs / 1000)}:R>`;
}

export function formatWeekLine(now, contestStartMs, firstWeekEndMs = null) {
  const { weekNumber, weekEndMs } = getWeekInfo(now, contestStartMs, firstWeekEndMs);
  return `wk${weekNumber} - ends ${formatWeekTimestamp(weekEndMs)}`;
}

export function getCurrentWeekStartMs(now = Date.now(), contestStartMs, firstWeekEndMs = null) {
  const { weekNumber, weekEndMs } = getWeekInfo(now, contestStartMs, firstWeekEndMs);

  if (weekNumber === 1) {
    return contestStartMs;
  }

  return weekEndMs - WEEK_MS;
}

export function formatWeeklyStatsLines({ photosSubmitted = 0, votersCount = 0 } = {}) {
  const photos = Number(photosSubmitted) || 0;
  const voters = Number(votersCount) || 0;
  const photoLabel = photos === 1 ? "photo" : "photos";
  const voterLabel = voters === 1 ? "person" : "people";

  return [
    `${photos} ${photoLabel} submitted so far this week.`,
    `Voted on by ${voters} ${voterLabel}.`,
  ];
}

export function formatPhasedStatsLines({
  submissionPhotos = 0,
  votingEntries = 0,
  votersCount = 0,
} = {}) {
  return [
    `${Number(submissionPhotos) || 0} photos submitted for the next vote.`,
    `${Number(votingEntries) || 0} entries currently voting; ${Number(votersCount) || 0} people voted.`,
  ];
}

export const PROMPT_TITLE = "Road Biking Photo Content";

export function buildPromptTitle(weekNumber) {
  return `${PROMPT_TITLE} — wk${weekNumber}`;
}

export function buildPromptContent(
  contestStartMs,
  now = Date.now(),
  { postingChannelId, winnersChannelId, weeklyStats, firstWeekEndMs = null } = {},
) {
  const { weekNumber } = getWeekInfo(now, contestStartMs, firstWeekEndMs);
  const submissionBatch = getBatchForSubmissionTime(now);
  const votingBatch = getVotingBatchAt(now);
  const lines = [
    `# ${buildPromptTitle(weekNumber)}`,
    `Submissions close <t:${Math.floor(submissionBatch.submissionDeadlineMs / 1000)}:F> (<t:${Math.floor(submissionBatch.submissionDeadlineMs / 1000)}:R>).`,
    `Voting opens <t:${Math.floor(submissionBatch.votingStartMs / 1000)}:F> (<t:${Math.floor(submissionBatch.votingStartMs / 1000)}:R>) after mod review.`,
  ];

  if (votingBatch) {
    lines.push(
      `Current voting closes <t:${Math.floor(votingBatch.votingEndMs / 1000)}:F> (<t:${Math.floor(votingBatch.votingEndMs / 1000)}:R>).`,
    );
  }

  if (postingChannelId && winnersChannelId) {
    lines.push("", "No AI submissions, please. And remember to have fun!");
  }

  if (weeklyStats) {
    lines.push("", ...formatPhasedStatsLines(weeklyStats));
  }

  return lines.join("\n");
}

export function getContestWeekStartMs(now = Date.now()) {
  const date = new Date(now);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - daysSinceMonday);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}
