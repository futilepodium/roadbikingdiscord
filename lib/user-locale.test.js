import assert from "node:assert/strict";
import test from "node:test";
import {
  buildViewSubmissionsTexts,
  buildWinnersModalLabels,
  GERMAN_LOCALE_USER_ID,
  prefersGerman,
} from "./user-locale.js";

test("prefersGerman matches the configured user id", () => {
  assert.equal(prefersGerman(GERMAN_LOCALE_USER_ID), true);
  assert.equal(prefersGerman("1107839461582184458"), false);
});

test("buildWinnersModalLabels returns German modal copy for the locale user", () => {
  const labels = buildWinnersModalLabels(GERMAN_LOCALE_USER_ID);
  assert.equal(labels.title, "Gewinner-Beitrag");
  assert.equal(labels.p1Label, "Beschreibung für Platz 1");
});

test("buildViewSubmissionsTexts returns German copy for the locale user", () => {
  const texts = buildViewSubmissionsTexts(GERMAN_LOCALE_USER_ID);
  assert.equal(texts.viewButton, "Deine Einreichungen ansehen");
  assert.equal(texts.change, "Ändern");
  assert.equal(texts.delete, "Löschen");
});
