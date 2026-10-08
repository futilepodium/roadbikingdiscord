import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEndNowComposeButton,
  buildEndNowModal,
  buildEndNowSlashCommand,
  buildWinnersPostSentDmPayload,
  clearPendingWeekEnd,
  editComposeDmsAfterWinnersPosted,
  END_NOW_COMPOSE_BUTTON_ID,
  END_NOW_DESCRIPTION_P1_INPUT_ID,
  END_NOW_DESCRIPTION_P2_INPUT_ID,
  END_NOW_MODAL_ID,
  END_NOW_SEND_TEST_OPTION_NAME,
  END_NOW_TITLE_INPUT_ID,
  getPendingWeekEnd,
  resolveEndNowComposeRecipients,
  sendWeekEndComposeDms,
  setPendingWeekEnd,
} from "./end-now-command.js";
import { ComponentType, MessageFlags } from "discord.js";
import { PhotoContestStore } from "./store.js";
import { END_NOW_SEND_TEST_USER_ID, isPendingWeekEndStillValid } from "./week-end.js";
import {
  buildEndNowDmInstructions,
  formatWinnersPostSentMessage,
  GERMAN_LOCALE_USER_ID,
} from "./user-locale.js";

test("buildEndNowDmInstructions explains the compose flow", () => {
  const content = buildEndNowDmInstructions(2, "1107839461582184458");
  assert.match(content, /wk2 is ready to close\./);
  assert.match(content, /1st and 2nd place/i);
  assert.match(content, /Compose winners post/i);
});

test("buildEndNowDmInstructions uses German for the configured locale user", () => {
  const content = buildEndNowDmInstructions(2, GERMAN_LOCALE_USER_ID);
  assert.match(content, /Woche 2 kann abgeschlossen werden\./);
  assert.match(content, /Gewinner-Beitrag erstellen/);
});

test("buildEndNowComposeButton uses the compose custom id", () => {
  const row = buildEndNowComposeButton().toJSON();
  assert.equal(row.components[0].custom_id, END_NOW_COMPOSE_BUTTON_ID);
});

test("buildEndNowModal includes title and per-place descriptions", () => {
  const modal = buildEndNowModal(3, "1107839461582184458").toJSON();
  assert.equal(modal.custom_id, END_NOW_MODAL_ID);

  const titleInput = modal.components[0].component;
  const descriptionP1Input = modal.components[1].component;
  const descriptionP2Input = modal.components[2].component;

  assert.equal(titleInput.custom_id, END_NOW_TITLE_INPUT_ID);
  assert.equal(titleInput.value, "**WK3 over!**");
  assert.equal(titleInput.required, false);
  assert.equal(descriptionP1Input.custom_id, END_NOW_DESCRIPTION_P1_INPUT_ID);
  assert.equal(descriptionP1Input.required, false);
  assert.equal(descriptionP2Input.custom_id, END_NOW_DESCRIPTION_P2_INPUT_ID);
  assert.equal(descriptionP2Input.required, false);
});

test("buildEndNowSlashCommand includes optional send-test option", () => {
  const command = buildEndNowSlashCommand();
  const sendTestOption = command.options.find((option) => option.name === END_NOW_SEND_TEST_OPTION_NAME);

  assert.ok(sendTestOption);
  assert.equal(sendTestOption.type, 5);
  assert.equal(sendTestOption.required, false);
});

test("resolveEndNowComposeRecipients limits DMs to the test user or invoker only", () => {
  assert.deepEqual(
    resolveEndNowComposeRecipients({ sendTest: true, invokingUserId: "999" }),
    [END_NOW_SEND_TEST_USER_ID],
  );
  assert.deepEqual(
    resolveEndNowComposeRecipients({ sendTest: false, invokingUserId: "999" }),
    ["999"],
  );
  assert.deepEqual(resolveEndNowComposeRecipients({ sendTest: false }), []);
});

test("pending week end sessions persist in the store across restarts", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-pending-${Date.now()}.db`);
  const userId = "120883716330487809";
  const prepared = {
    weekNumber: 1,
    weekStartMs: Date.parse("2026-10-02T21:00:00.000Z"),
    weekEndMs: Date.parse("2026-10-13T00:00:00.000Z"),
    winners: [],
  };

  store.setSetting("contest_week_start_ms", String(prepared.weekStartMs));

  setPendingWeekEnd(store, prepared);
  assert.deepEqual(getPendingWeekEnd(userId, store), prepared);

  const reloadedStore = new PhotoContestStore(store.dbPath);
  assert.deepEqual(getPendingWeekEnd(userId, reloadedStore), prepared);

  clearPendingWeekEnd(reloadedStore);
  assert.equal(getPendingWeekEnd(userId, reloadedStore), null);
});

test("formatWinnersPostSentMessage uses the sender display name", () => {
  assert.equal(
    formatWinnersPostSentMessage(
      { globalName: "Polar", username: "polariridium" },
      "1107839461582184458",
    ),
    "Polar sent the winners post message.",
  );
  assert.equal(
    formatWinnersPostSentMessage(
      { username: "bozenshmirtz" },
      GERMAN_LOCALE_USER_ID,
    ),
    "bozenshmirtz hat den Gewinner-Beitrag gesendet.",
  );
});

test("buildWinnersPostSentDmPayload wraps the sent message in a container", () => {
  const payload = buildWinnersPostSentDmPayload(
    { globalName: "Polar", username: "polariridium" },
    "1107839461582184458",
  );

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  const container = payload.components[0].toJSON();
  assert.equal(container.type, ComponentType.Container);
  assert.equal(
    container.components[0].content,
    "Polar sent the winners post message.",
  );
});

test("sendWeekEndComposeDms records blocked recipients without aborting others", async () => {
  const prepared = {
    weekNumber: 1,
    weekStartMs: Date.parse("2026-10-02T21:00:00.000Z"),
    weekEndMs: Date.parse("2026-10-13T00:00:00.000Z"),
    winners: [],
  };
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        messages: { fetch: async () => null },
      }),
    },
    users: {
      fetch: async (userId) => ({
        id: userId,
        createDM: async () => ({
          id: `dm-${userId}`,
          send: async () => {
            if (userId === "120883716330487809") {
              const error = new Error("Cannot send messages to this user");
              error.code = 50007;
              throw error;
            }
            return { id: `msg-${userId}` };
          },
        }),
      }),
    },
  };

  const result = await sendWeekEndComposeDms({
    client,
    store: {
      getContestWeekStartMs: () => prepared.weekStartMs,
    },
    postingChannelId: "posting",
    prepared,
    userIds: ["1107839461582184458", "120883716330487809"],
  });

  assert.deepEqual(result.sentUserIds, ["1107839461582184458"]);
  assert.deepEqual(result.failedUserIds, ["120883716330487809"]);
  assert.deepEqual(result.sentMessages, [
    {
      userId: "1107839461582184458",
      channelId: "dm-1107839461582184458",
      messageId: "msg-1107839461582184458",
    },
  ]);
});

test("editComposeDmsAfterWinnersPosted updates every tracked compose DM", async () => {
  const edited = [];
  const client = {
    users: {
      fetch: async () => ({ globalName: "Polar", username: "polariridium" }),
    },
    channels: {
      fetch: async (channelId) => ({
        messages: {
          fetch: async (messageId) => ({
            id: messageId,
            edit: async (payload) => {
              edited.push({ channelId, messageId, payload });
            },
          }),
        },
      }),
    },
  };

  const result = await editComposeDmsAfterWinnersPosted({
    client,
    composeDmMessages: [
      { userId: "1107839461582184458", channelId: "dm-1", messageId: "msg-1" },
      { userId: "120883716330487809", channelId: "dm-2", messageId: "msg-2" },
    ],
    senderUserId: "1107839461582184458",
  });

  assert.equal(result.edited.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(edited.length, 2);
  assert.equal(
    edited[0].payload.components[0].toJSON().components[0].content,
    "Polar sent the winners post message.",
  );
  assert.equal(
    edited[1].payload.components[0].toJSON().components[0].content,
    "Polar hat den Gewinner-Beitrag gesendet.",
  );
});

test("pending week end sessions are cleared after winners are posted", () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-posted-${Date.now()}.db`);
  const prepared = {
    weekNumber: 1,
    weekStartMs: Date.parse("2026-10-02T21:00:00.000Z"),
    weekEndMs: Date.parse("2026-10-13T00:00:00.000Z"),
    winners: [],
  };

  store.setSetting("contest_week_start_ms", String(prepared.weekStartMs));
  setPendingWeekEnd(store, prepared);
  store.setSetting("contest_week_start_ms", String(prepared.weekEndMs));

  assert.equal(isPendingWeekEndStillValid(prepared, store), false);
  assert.equal(getPendingWeekEnd("1107839461582184458", store), null);
  assert.equal(store.getPendingWeekEndSession(), null);
});
