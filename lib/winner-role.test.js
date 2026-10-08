import assert from "node:assert/strict";
import test from "node:test";
import { PhotoContestStore } from "./store.js";
import {
  clearPhotoContestWinnerRole,
  PHOTO_CONTEST_WINNER_ROLE_NAME,
  PHOTO_CONTEST_WINNER_ROLE_SETTING,
  PHOTO_CONTEST_WINNER_USER_SETTING,
  syncPhotoContestWinnerRole,
} from "./winner-role.js";

function createMockMember(userId, roleIds = new Set()) {
  const roles = {
    cache: roleIds,
    remove: async (_role, reason) => {
      roles.cache.delete(_role.id);
      roles.lastRemoveReason = reason;
    },
    add: async (_role, reason) => {
      roles.cache.add(_role.id);
      roles.lastAddReason = reason;
    },
  };

  return { id: userId, roles };
}

function createMockGuild({ role, members, createRole = false }) {
  const roleRecord = role ?? {
    id: "role-1",
    name: PHOTO_CONTEST_WINNER_ROLE_NAME,
    members: {
      values: () => members.filter((member) => member.roles.cache.has(role?.id ?? "role-1")).values(),
    },
  };

  return {
    roles: {
      cache: new Map([[roleRecord.id, roleRecord]]),
      find: (predicate) => [...roleRecord ? [roleRecord] : []].find(predicate),
      fetch: async (roleId) => (roleId === roleRecord.id ? roleRecord : null),
      create: async ({ name }) => {
        assert.equal(createRole, true);
        assert.equal(name, PHOTO_CONTEST_WINNER_ROLE_NAME);
        return roleRecord;
      },
    },
    members: {
      fetch: async (userId) => members.find((member) => member.id === userId) ?? null,
    },
  };
}

test("syncPhotoContestWinnerRole replaces the previous winner", async () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-winner-role-${Date.now()}.db`);
  store.setSetting(PHOTO_CONTEST_WINNER_USER_SETTING, "old-winner");
  store.setSetting(PHOTO_CONTEST_WINNER_ROLE_SETTING, "role-1");

  const oldMember = createMockMember("old-winner", new Set(["role-1"]));
  const newMember = createMockMember("new-winner");
  const role = {
    id: "role-1",
    name: PHOTO_CONTEST_WINNER_ROLE_NAME,
    members: {
      values: () => [oldMember].values(),
    },
  };

  const client = {
    guilds: {
      fetch: async () => createMockGuild({ role, members: [oldMember, newMember] }),
    },
  };

  await syncPhotoContestWinnerRole({
    client,
    guildId: "guild-1",
    store,
    winnerUserId: "new-winner",
  });

  assert.equal(store.getSetting(PHOTO_CONTEST_WINNER_USER_SETTING), "new-winner");
  assert.equal(oldMember.roles.cache.has("role-1"), false);
  assert.equal(newMember.roles.cache.has("role-1"), true);
});

test("clearPhotoContestWinnerRole removes the role from the stored winner", async () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-winner-clear-${Date.now()}.db`);
  store.setSetting(PHOTO_CONTEST_WINNER_USER_SETTING, "old-winner");
  store.setSetting(PHOTO_CONTEST_WINNER_ROLE_SETTING, "role-1");

  const member = createMockMember("old-winner", new Set(["role-1"]));
  const role = {
    id: "role-1",
    name: PHOTO_CONTEST_WINNER_ROLE_NAME,
    members: {
      values: () => [member].values(),
    },
  };

  const client = {
    guilds: {
      fetch: async () => createMockGuild({ role, members: [member] }),
    },
  };

  const result = await clearPhotoContestWinnerRole({
    client,
    guildId: "guild-1",
    store,
  });

  assert.equal(result.removedUserId, "old-winner");
  assert.equal(store.getSetting(PHOTO_CONTEST_WINNER_USER_SETTING), null);
  assert.equal(member.roles.cache.has("role-1"), false);
});

test("syncPhotoContestWinnerRole creates the role when it does not exist", async () => {
  const store = new PhotoContestStore(`/tmp/photo-contest-winner-create-${Date.now()}.db`);
  const winner = createMockMember("winner-1");
  const role = {
    id: "role-new",
    name: PHOTO_CONTEST_WINNER_ROLE_NAME,
    members: {
      values: () => [][Symbol.iterator](),
    },
  };

  const client = {
    guilds: {
      fetch: async () => createMockGuild({ role, members: [winner], createRole: true }),
    },
  };

  await syncPhotoContestWinnerRole({
    client,
    guildId: "guild-1",
    store,
    winnerUserId: "winner-1",
  });

  assert.equal(store.getSetting(PHOTO_CONTEST_WINNER_ROLE_SETTING), "role-new");
  assert.equal(store.getSetting(PHOTO_CONTEST_WINNER_USER_SETTING), "winner-1");
  assert.equal(winner.roles.cache.has("role-new"), true);
});
