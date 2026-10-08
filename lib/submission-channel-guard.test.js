import assert from "node:assert/strict";
import test from "node:test";
import { getSubmissionPromptChannelIds } from "./config.js";
import {
  buildSubmitInstructionDmContent,
  isSubmissionPromptChannel,
} from "./submission-channel-guard.js";
const TEST_GERMAN_USER_ID = "120883716330487809";

test("isSubmissionPromptChannel matches dev and prod posting channels", () => {
  const channelIds = getSubmissionPromptChannelIds();

  assert.equal(isSubmissionPromptChannel("1555675560267620442", channelIds), true);
  assert.equal(isSubmissionPromptChannel("1244408284908355666", channelIds), true);
  assert.equal(isSubmissionPromptChannel("999", channelIds), false);
});

test("buildSubmitInstructionDmContent includes the submit command and channel link", () => {
  const content = buildSubmitInstructionDmContent(
    "https://discord.com/channels/416024949627813890/1244408284908355666",
  );

  assert.match(content, /Please use/);
  assert.match(content, /```\/submit-photos```/);
  assert.match(content, /https:\/\/discord\.com\/channels\/416024949627813890\/1244408284908355666$/);
});

test("buildSubmitInstructionDmContent uses German for the configured locale user", () => {
  const previous = process.env.GERMAN_LOCALE_USER_ID;
  process.env.GERMAN_LOCALE_USER_ID = TEST_GERMAN_USER_ID;
  const link = "https://discord.com/channels/1555674814562439188/1555675560267620442";
  const content = buildSubmitInstructionDmContent(link, TEST_GERMAN_USER_ID);

  if (previous === undefined) {
    delete process.env.GERMAN_LOCALE_USER_ID;
  } else {
    process.env.GERMAN_LOCALE_USER_ID = previous;
  }

  assert.match(content, /Bitte verwende/);
  assert.match(content, /```\/submit-photos```/);
  assert.match(content, new RegExp(`${link}$`));
});
