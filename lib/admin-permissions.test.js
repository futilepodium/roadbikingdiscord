import assert from "node:assert/strict";
import test from "node:test";
import { buildEndNowSlashCommand } from "./end-now-command.js";
import { getPendingWeekEnd, setPendingWeekEnd } from "./end-now-command.js";
import { buildQuickEndSubmissionSlashCommand } from "./quick-end-submission-command.js";
import { buildResetDevSlashCommand } from "./reset-dev-command.js";
import { PhotoContestStore } from "./store.js";
import {
  canUseEndNow,
  parseEndNowAllowedUserIds,
  parseEndNowDmUserIds,
  resolveEndNowComposeDmUserIds,
} from "./week-end.js";

const ADMIN_USER_IDS = ["1107839461582184458", "120883716330487809"];

function withAdminUserIds(run) {
  const previousAllowed = process.env.END_NOW_ALLOWED_USER_IDS;
  const previousDm = process.env.END_NOW_DM_USER_IDS;
  process.env.END_NOW_ALLOWED_USER_IDS = ADMIN_USER_IDS.join(",");
  process.env.END_NOW_DM_USER_IDS = ADMIN_USER_IDS.join(",");
  try {
    run();
  } finally {
    if (previousAllowed === undefined) {
      delete process.env.END_NOW_ALLOWED_USER_IDS;
    } else {
      process.env.END_NOW_ALLOWED_USER_IDS = previousAllowed;
    }
    if (previousDm === undefined) {
      delete process.env.END_NOW_DM_USER_IDS;
    } else {
      process.env.END_NOW_DM_USER_IDS = previousDm;
    }
  }
}

test("admin slash commands rely on canUseEndNow instead of Discord Administrator", () => {
  for (const command of [
    buildEndNowSlashCommand(),
    buildQuickEndSubmissionSlashCommand(),
    buildResetDevSlashCommand(),
  ]) {
    assert.equal(
      command.default_member_permissions,
      undefined,
      `${command.name} should not require Discord Administrator`,
    );
  }
});

test("parseEndNowAllowedUserIds and parseEndNowDmUserIds include both admins", () => {
  for (const parser of [parseEndNowAllowedUserIds, parseEndNowDmUserIds]) {
    const allowed = parser(`${ADMIN_USER_IDS[0]},${ADMIN_USER_IDS[1]}`);
    for (const userId of ADMIN_USER_IDS) {
      assert.equal(canUseEndNow(userId, allowed), true);
    }
    assert.equal(canUseEndNow("999", allowed), false);
  }
});

test("parseEndNowAllowedUserIds returns empty set when env value is empty", () => {
  assert.equal(parseEndNowAllowedUserIds("").size, 0);
});

test("parseEndNowDmUserIds returns empty set when env value is empty", () => {
  assert.equal(parseEndNowDmUserIds("").size, 0);
});

test("getPendingWeekEnd allows both configured admin users", () => {
  withAdminUserIds(() => {
    const store = new PhotoContestStore(`/tmp/photo-contest-admin-${Date.now()}.db`);
    const prepared = {
      weekNumber: 1,
      weekStartMs: Date.parse("2026-10-02T21:00:00.000Z"),
      weekEndMs: Date.parse("2026-10-13T00:00:00.000Z"),
      winners: [],
    };

    store.setSetting("contest_week_start_ms", String(prepared.weekStartMs));
    setPendingWeekEnd(store, prepared);

    for (const userId of ADMIN_USER_IDS) {
      assert.deepEqual(getPendingWeekEnd(userId, store), prepared);
    }

    assert.equal(getPendingWeekEnd("999", store), null);
  });
});

test("canUseEndNow allows users listed in either allowed or dm env vars", () => {
  const allowedOnly = parseEndNowAllowedUserIds(ADMIN_USER_IDS[0]);
  const dmOnly = parseEndNowDmUserIds(ADMIN_USER_IDS[1]);

  assert.equal(canUseEndNow(ADMIN_USER_IDS[0], allowedOnly, dmOnly), true);
  assert.equal(canUseEndNow(ADMIN_USER_IDS[1], allowedOnly, dmOnly), true);
  assert.equal(canUseEndNow("999", allowedOnly, dmOnly), false);
});

test("resolveEndNowComposeDmUserIds always includes the invoking admin", () => {
  const dmUserIds = resolveEndNowComposeDmUserIds({
    extraUserIds: [ADMIN_USER_IDS[1]],
  });

  assert.equal(dmUserIds.includes(ADMIN_USER_IDS[1]), true);
});
