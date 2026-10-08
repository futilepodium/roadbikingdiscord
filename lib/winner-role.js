export const PHOTO_CONTEST_WINNER_ROLE_NAME = "Photo Contest Winner";
export const PHOTO_CONTEST_WINNER_USER_SETTING = "photo_contest_winner_user_id";
export const PHOTO_CONTEST_WINNER_ROLE_SETTING = "photo_contest_winner_role_id";

function findGuildRoleByName(guild, roleName) {
  const roles = guild.roles?.cache;
  if (!roles) {
    return null;
  }

  if (typeof roles.find === "function") {
    return roles.find((role) => role.name === roleName) ?? null;
  }

  for (const role of roles.values()) {
    if (role.name === roleName) {
      return role;
    }
  }

  return null;
}

export function getStoredWinnerUserId(store) {
  return store.getSetting(PHOTO_CONTEST_WINNER_USER_SETTING);
}

export function setStoredWinnerUserId(store, userId) {
  if (userId) {
    store.setSetting(PHOTO_CONTEST_WINNER_USER_SETTING, userId);
    return;
  }
  store.clearSetting(PHOTO_CONTEST_WINNER_USER_SETTING);
}

export async function findPhotoContestWinnerRole(guild, store) {
  const cachedRoleId = store.getSetting(PHOTO_CONTEST_WINNER_ROLE_SETTING);
  if (cachedRoleId) {
    const cachedRole =
      guild.roles.cache.get(cachedRoleId) ??
      await guild.roles.fetch(cachedRoleId).catch(() => null);
    if (cachedRole) {
      return cachedRole;
    }
  }

  const existingRole = findGuildRoleByName(guild, PHOTO_CONTEST_WINNER_ROLE_NAME);
  if (existingRole) {
    store.setSetting(PHOTO_CONTEST_WINNER_ROLE_SETTING, existingRole.id);
    return existingRole;
  }

  return null;
}

export async function resolvePhotoContestWinnerRole(guild, store) {
  const existingRole = await findPhotoContestWinnerRole(guild, store);
  if (existingRole) {
    return existingRole;
  }

  const createdRole = await guild.roles.create({
    name: PHOTO_CONTEST_WINNER_ROLE_NAME,
    reason: "Photo contest weekly winner",
  });
  store.setSetting(PHOTO_CONTEST_WINNER_ROLE_SETTING, createdRole.id);
  return createdRole;
}

export async function removeWinnerRoleFromMember(guild, role, userId, reason) {
  if (!userId || !role) {
    return false;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member?.roles.cache.has(role.id)) {
    return false;
  }

  await member.roles.remove(role, reason);
  return true;
}

export async function clearPhotoContestWinnerRole({ client, guildId, store }) {
  const guild = await client.guilds.fetch(guildId);
  const currentUserId = getStoredWinnerUserId(store);
  const role = await findPhotoContestWinnerRole(guild, store);

  if (role) {
    for (const member of role.members.values()) {
      await member.roles.remove(role, "Photo contest winner cleared");
    }
  }

  setStoredWinnerUserId(store, null);
  return { removedUserId: currentUserId ?? null };
}

export async function syncPhotoContestWinnerRole({
  client,
  guildId,
  store,
  winnerUserId,
}) {
  const guild = await client.guilds.fetch(guildId);
  const previousUserId = getStoredWinnerUserId(store);
  const role = await resolvePhotoContestWinnerRole(guild, store);

  for (const member of role.members.values()) {
    if (member.id !== winnerUserId) {
      await member.roles.remove(role, "Only one photo contest winner at a time");
    }
  }

  if (!winnerUserId) {
    setStoredWinnerUserId(store, null);
    return { previousUserId, winnerUserId: null, roleId: role.id };
  }

  if (previousUserId && previousUserId !== winnerUserId) {
    await removeWinnerRoleFromMember(
      guild,
      role,
      previousUserId,
      "Replaced by new photo contest winner",
    );
  }

  const member = await guild.members.fetch(winnerUserId).catch(() => null);
  if (!member) {
    throw new Error(`Winner member ${winnerUserId} not found in guild ${guildId}`);
  }

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role, "Photo contest weekly winner");
  }

  setStoredWinnerUserId(store, winnerUserId);
  return { previousUserId, winnerUserId, roleId: role.id };
}
