import { REST, Routes } from "discord.js";
import { buildEndNowSlashCommand, END_NOW_COMMAND_NAME } from "./end-now-command.js";
import {
  buildQuickEndSubmissionSlashCommand,
  QUICK_END_SUBMISSION_COMMAND_NAME,
} from "./quick-end-submission-command.js";
import { buildResetDevSlashCommand, RESET_DEV_COMMAND_NAME } from "./reset-dev-command.js";
import { buildSubmitPhotoSlashCommand, SUBMIT_COMMAND_NAME } from "./submit-command.js";
import { resolveBotEnv } from "./config.js";

export const DEV_ONLY_COMMAND_NAMES = new Set([
  END_NOW_COMMAND_NAME,
  QUICK_END_SUBMISSION_COMMAND_NAME,
  RESET_DEV_COMMAND_NAME,
]);

export function buildGuildSlashCommands(botEnv = resolveBotEnv()) {
  const commands = [buildSubmitPhotoSlashCommand()];
  if (botEnv === "development") {
    commands.push(
      buildEndNowSlashCommand(),
      buildQuickEndSubmissionSlashCommand(),
      buildResetDevSlashCommand(),
    );
  }
  return commands;
}

export function getGuildSlashCommandNames(botEnv = resolveBotEnv()) {
  return buildGuildSlashCommands(botEnv).map((command) => command.name);
}

export async function registerGuildSlashCommands({
  token,
  clientId,
  guildId,
  botEnv = resolveBotEnv(),
}) {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = buildGuildSlashCommands(botEnv);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
}

export { SUBMIT_COMMAND_NAME };
