import assert from "node:assert/strict";
import test from "node:test";
import { DEV_GUILD_ID, PROD_GUILD_ID } from "./config.js";
import {
  buildGuildSlashCommands,
  DEV_ONLY_COMMAND_NAMES,
  getGuildSlashCommandNames,
  SUBMIT_COMMAND_NAME,
} from "./guild-commands.js";
import { END_NOW_COMMAND_NAME } from "./end-now-command.js";
import { QUICK_END_SUBMISSION_COMMAND_NAME } from "./quick-end-submission-command.js";
import { RESET_DEV_COMMAND_NAME } from "./reset-dev-command.js";

test("development guild registers public and dev-only slash commands", () => {
  const commandNames = getGuildSlashCommandNames("development");

  assert.deepEqual(commandNames, [
    SUBMIT_COMMAND_NAME,
    END_NOW_COMMAND_NAME,
    QUICK_END_SUBMISSION_COMMAND_NAME,
    RESET_DEV_COMMAND_NAME,
  ]);
});

test("production guild registers only public slash commands", () => {
  const commandNames = getGuildSlashCommandNames("production");

  assert.deepEqual(commandNames, [SUBMIT_COMMAND_NAME]);
  for (const devCommandName of DEV_ONLY_COMMAND_NAMES) {
    assert.equal(
      commandNames.includes(devCommandName),
      false,
      `${devCommandName} must not register in production`,
    );
  }
});

test("buildGuildSlashCommands returns serializable slash command payloads", () => {
  for (const botEnv of ["development", "production"]) {
    for (const command of buildGuildSlashCommands(botEnv)) {
      assert.equal(typeof command.name, "string");
      assert.equal(typeof command.description, "string");
    }
  }
});

test("dev-only command set matches the three admin commands", () => {
  assert.deepEqual([...DEV_ONLY_COMMAND_NAMES].sort(), [
    END_NOW_COMMAND_NAME,
    QUICK_END_SUBMISSION_COMMAND_NAME,
    RESET_DEV_COMMAND_NAME,
  ].sort());
});

test("guild ids stay mapped to the expected dev and prod servers", () => {
  assert.equal(DEV_GUILD_ID, "1555674814562439188");
  assert.equal(PROD_GUILD_ID, "416024949627813890");
});
