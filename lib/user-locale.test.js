import assert from "node:assert/strict";
import test from "node:test";
import {
  buildViewSubmissionsTexts,
  buildWinnersModalLabels,
  prefersGerman,
} from "./user-locale.js";

const TEST_GERMAN_USER_ID = "120883716330487809";

function withGermanLocaleUserId(run) {
  const previous = process.env.GERMAN_LOCALE_USER_ID;
  process.env.GERMAN_LOCALE_USER_ID = TEST_GERMAN_USER_ID;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.GERMAN_LOCALE_USER_ID;
    } else {
      process.env.GERMAN_LOCALE_USER_ID = previous;
    }
  }
}

test("prefersGerman matches the configured user id", () => {
  withGermanLocaleUserId(() => {
    assert.equal(prefersGerman(TEST_GERMAN_USER_ID), true);
    assert.equal(prefersGerman("1107839461582184458"), false);
  });
});

test("buildWinnersModalLabels returns German modal copy for the locale user", () => {
  withGermanLocaleUserId(() => {
    const labels = buildWinnersModalLabels(TEST_GERMAN_USER_ID);
    assert.equal(labels.title, "Gewinner-Beitrag");
    assert.equal(labels.p1Label, "Beschreibung für Platz 1");
  });
});

test("buildViewSubmissionsTexts returns German copy for the locale user", () => {
  withGermanLocaleUserId(() => {
    const texts = buildViewSubmissionsTexts(TEST_GERMAN_USER_ID);
    assert.equal(texts.viewButton, "Deine Einreichungen ansehen");
    assert.equal(texts.change, "Ändern");
    assert.equal(texts.delete, "Löschen");
  });
});
