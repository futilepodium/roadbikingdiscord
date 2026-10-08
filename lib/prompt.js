import { Events } from "discord.js";
import {
  buildPromptButtonRows,
  SUBMIT_PHOTO_BUTTON_ID,
  VIEW_SUBMISSIONS_BUTTON_ID,
} from "./submit-command.js";
import { getCurrentWeeklyStats } from "./voting.js";
import { buildPromptContent, PROMPT_TITLE } from "./week.js";

export const PROMPT_SCAN_LIMIT = 100;
export const PROMPT_DEBOUNCE_MS = 500;
export const PROMPT_REFRESH_MS = 60_000;
export const PROMPT_HEADER = "# Road Biking Photo Content";

export const PROMPT_STATUS = {
  BOTTOM: "bottom",
  EDITED: "edited",
  CREATED: "created",
  REPOSTED: "reposted",
  MISSING: "missing",
};

export function isPhotoPromptMessage(message) {
  const content = message?.content ?? "";
  if (content.startsWith(PROMPT_HEADER)) {
    return true;
  }

  const embed = message.embeds?.[0];
  if (embed?.title === PROMPT_TITLE) {
    return true;
  }

  return false;
}

export function messageHasSubmitPhotoButton(message) {
  return messageHasPromptButtons(message);
}

export function messageHasPromptButtons(message) {
  const customIds = new Set(
    (message.components ?? []).flatMap((row) =>
      (row.components ?? []).map((component) => component.customId ?? component.custom_id),
    ),
  );
  return customIds.has(SUBMIT_PHOTO_BUTTON_ID) && customIds.has(VIEW_SUBMISSIONS_BUTTON_ID);
}

function promptPayloadMatches(message, payload) {
  return (message.content ?? "") === payload.content
    && messageHasSubmitPhotoButton(message);
}

export function getNewestMessage(messages) {
  if (typeof messages.first === "function") {
    return messages.first();
  }

  const values = [...messages.values()];
  if (values.length === 0) {
    return null;
  }

  return values.reduce((newest, message) =>
    BigInt(message.id) > BigInt(newest.id) ? message : newest,
  );
}

export function isPromptAtBottomById(latestMessageId, promptMessageId) {
  return Boolean(
    latestMessageId && promptMessageId && latestMessageId === promptMessageId,
  );
}

export function selectNewestPrompt(prompts) {
  if (prompts.length === 0) {
    return null;
  }

  return prompts.reduce((newest, message) =>
    BigInt(message.id) > BigInt(newest.id) ? message : newest,
  );
}

export function findPromptMessages(messages, botUserId) {
  return [...messages.values()].filter(
    (message) => message.author?.id === botUserId && isPhotoPromptMessage(message),
  );
}

export function findKeepableBottomPrompt(messages, botUserId) {
  const prompts = findPromptMessages(messages, botUserId);
  if (prompts.length === 0) {
    return null;
  }

  const lastMessage = getNewestMessage(messages);
  const newestPrompt = selectNewestPrompt(prompts);
  if (!lastMessage || !newestPrompt || lastMessage.id !== newestPrompt.id) {
    return null;
  }

  return newestPrompt;
}

export function buildPromptPayload(
  contestStartMs,
  now = Date.now(),
  { postingChannelId, winnersChannelId, weeklyStats, firstWeekEndMs = null } = {},
) {
  return {
    content: buildPromptContent(contestStartMs, now, {
      postingChannelId,
      winnersChannelId,
      weeklyStats,
      firstWeekEndMs,
    }),
    components: buildPromptButtonRows(),
  };
}

async function upsertPromptMessage(channel, message, payload, savePromptState) {
  if (promptPayloadMatches(message, payload)) {
    savePromptState({ messageId: message.id, status: PROMPT_STATUS.BOTTOM });
    return message;
  }

  const edited = await message.edit({
    content: payload.content,
    embeds: [],
    components: payload.components ?? [],
  });
  savePromptState({ messageId: edited.id, status: PROMPT_STATUS.EDITED });
  return edited;
}

async function cleanupLegacyPrompts(client, store, legacyPromptChannelId, promptChannelId, botUserId) {
  if (!legacyPromptChannelId || legacyPromptChannelId === promptChannelId) {
    return;
  }

  const channel = await client.channels.fetch(legacyPromptChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return;
  }

  const messages = await channel.messages.fetch({ limit: PROMPT_SCAN_LIMIT });
  const prompts = findPromptMessages(messages, botUserId);
  if (prompts.length === 0) {
    store.clearPromptState(legacyPromptChannelId);
    return;
  }

  await Promise.all(prompts.map((message) => message.delete().catch(() => {})));
  store.clearPromptState(legacyPromptChannelId);
}

export function registerPhotoPromptHandlers(
  client,
  { promptChannelId, legacyPromptChannelId = null, postingChannelId, winnersChannelId, store },
) {
  const refreshPromises = new Map();
  const refreshDebounceTimers = new Map();
  let legacyPromptsCleaned = false;

  async function deletePromptMessages(prompts, exceptId = null) {
    await Promise.all(
      prompts
        .filter((message) => message.id !== exceptId)
        .map((message) => message.delete().catch(() => {})),
    );
  }

  async function refreshStickyPrompt(channel) {
    const existing = refreshPromises.get(channel.id);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      const botUserId = client.user.id;
      const contestStartMs = store.getContestWeekStartMs();
      const payload = buildPromptPayload(contestStartMs, Date.now(), {
        postingChannelId,
        winnersChannelId,
        firstWeekEndMs: store.getFirstWeekEndMs(),
        weeklyStats: getCurrentWeeklyStats(store),
      });
      const savePromptState = ({ messageId, status }) =>
        store.setPromptState(channel.id, { messageId, status });
      const storedPromptId = store.getPromptMessageId(channel.id);
      const latest = await channel.messages.fetch({ limit: 1 });
      const latestMessage = latest.first();

      if (
        storedPromptId &&
        isPromptAtBottomById(latestMessage?.id, storedPromptId) &&
        isPhotoPromptMessage(latestMessage)
      ) {
        return upsertPromptMessage(channel, latestMessage, payload, savePromptState);
      }

      const messages = await channel.messages.fetch({ limit: PROMPT_SCAN_LIMIT });
      const prompts = findPromptMessages(messages, botUserId);
      const keepPrompt = findKeepableBottomPrompt(messages, botUserId);

      if (keepPrompt) {
        if (prompts.length > 1) {
          await deletePromptMessages(prompts, keepPrompt.id);
        }

        return upsertPromptMessage(channel, keepPrompt, payload, savePromptState);
      }

      await deletePromptMessages(prompts);
      const prompt = await channel.send(payload);
      savePromptState({
        messageId: prompt.id,
        status: prompts.length > 0 ? PROMPT_STATUS.REPOSTED : PROMPT_STATUS.CREATED,
      });
      return prompt;
    })().finally(() => {
      if (refreshPromises.get(channel.id) === promise) {
        refreshPromises.delete(channel.id);
      }
    });

    refreshPromises.set(channel.id, promise);
    return promise;
  }

  function scheduleStickyPromptRefresh(channel) {
    const existingTimer = refreshDebounceTimers.get(channel.id);
    clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      refreshDebounceTimers.delete(channel.id);
      refreshStickyPrompt(channel).catch((error) => {
        console.error(`Failed to refresh photo prompt in ${channel.id}:`, error);
      });
    }, PROMPT_DEBOUNCE_MS);

    refreshDebounceTimers.set(channel.id, timer);
  }

  async function ensureSubmissionPrompt({ log = false } = {}) {
    const channel = await client.channels.fetch(promptChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      throw new Error(`Submission prompt channel ${promptChannelId} not found`);
    }

    if (!legacyPromptsCleaned) {
      legacyPromptsCleaned = true;
      await cleanupLegacyPrompts(
        client,
        store,
        legacyPromptChannelId,
        promptChannelId,
        client.user.id,
      );
    }

    await refreshStickyPrompt(channel);

    if (log) {
      const state = store.getPromptState(channel.id);
      console.log(
        `Photo submission prompt refreshed in #${channel.name} (${channel.id})`
          + ` message=${state?.messageId ?? "none"} status=${state?.status ?? PROMPT_STATUS.MISSING}`,
      );
    }

    return channel;
  }

  client.on(Events.MessageCreate, (message) => {
    if (message.channelId !== promptChannelId) {
      return;
    }

    if (message.author?.id === client.user.id && isPhotoPromptMessage(message)) {
      return;
    }

    scheduleStickyPromptRefresh(message.channel);
  });

  client.on(Events.MessageDelete, (message) => {
    if (message.channelId !== promptChannelId) {
      return;
    }

    if (store.getPromptMessageId(message.channelId) === message.id) {
      store.clearPromptState(message.channelId);
      scheduleStickyPromptRefresh(message.channel);
    }
  });

  setInterval(() => {
    client.channels
      .fetch(promptChannelId)
      .then((channel) => {
        if (channel?.isTextBased?.()) {
          return refreshStickyPrompt(channel);
        }
        return null;
      })
      .catch((error) => {
        console.error("Failed periodic photo prompt refresh:", error);
      });
  }, PROMPT_REFRESH_MS);

  async function refreshSubmissionPrompt() {
    const channel = await client.channels.fetch(promptChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      return null;
    }

    return refreshStickyPrompt(channel);
  }

  return { ensureSubmissionPrompt, refreshStickyPrompt, refreshSubmissionPrompt };
}
