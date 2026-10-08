export function getGermanLocaleUserId(
  value = process.env.GERMAN_LOCALE_USER_ID,
) {
  return String(value ?? "").trim();
}

export function prefersGerman(userId) {
  const germanLocaleUserId = getGermanLocaleUserId();
  return germanLocaleUserId !== "" && userId === germanLocaleUserId;
}

export function pickLocale(userId, english, german) {
  return prefersGerman(userId) ? german : english;
}

export function buildSubmitInstructionDmContent(channelLink, userId) {
  return pickLocale(
    userId,
    `Please use \n\`\`\`/submit-photos\`\`\` in the Discord server. ${channelLink}`,
    `Bitte verwende \n\`\`\`/submit-photos\`\`\` im Discord-Server. ${channelLink}`,
  );
}

export function buildEndNowDmInstructions(weekNumber, userId) {
  return pickLocale(
    userId,
    [
      `wk${weekNumber} is ready to close.`,
      "Add a title and descriptions for 1st and 2nd place in the winners post.",
      "Click **Compose winners post** to add them and send to the photo winners channel.",
    ].join("\n\n"),
    [
      `Woche ${weekNumber} kann abgeschlossen werden.`,
      "Füge einen Titel und Beschreibungen für Platz 1 und Platz 2 im Gewinner-Beitrag hinzu.",
      "Klicke auf **Gewinner-Beitrag erstellen**, um sie hinzuzufügen und in den Gewinner-Kanal zu senden.",
    ].join("\n\n"),
  );
}

export function getComposeWinnersButtonLabel(userId) {
  return pickLocale(userId, "Compose winners post", "Gewinner-Beitrag erstellen");
}

export function formatWinnersPostSentMessage(sender, recipientUserId) {
  const name = sender.globalName ?? sender.username ?? "Someone";
  return pickLocale(
    recipientUserId,
    `${name} sent the winners post message.`,
    `${name} hat den Gewinner-Beitrag gesendet.`,
  );
}

export function getWinnersAlreadyPostedMessage(userId) {
  return pickLocale(
    userId,
    "Winners for this week have already been posted.",
    "Die Gewinner für diese Woche wurden bereits veröffentlicht.",
  );
}

export const endNowPersonalMessages = {
  permissionDeniedCommand(userId) {
    return pickLocale(userId, "You do not have permission to use this command.", "Du hast keine Berechtigung, diesen Befehl zu verwenden.");
  },
  noActiveVoting(userId) {
    return pickLocale(userId, "There is no active voting period to end.", "Es gibt keine aktive Abstimmungsphase zum Beenden.");
  },
  testRecipientDmFailed(userId) {
    return pickLocale(userId, "I couldn't DM the test recipient. Check their DMs and try again.", "Ich konnte dem Testempfänger keine DM senden. Bitte DMs prüfen und erneut versuchen.");
  },
  testDmsSent(userId) {
    return pickLocale(userId, "Sent compose DMs to the test recipient only.", "Compose-DMs nur an den Testempfänger gesendet.");
  },
  invokerDmFailed(userId) {
    return pickLocale(userId, "I couldn't DM you. Open your DMs to this server and try again.", "Ich konnte dir keine DM senden. Öffne deine DMs für diesen Server und versuche es erneut.");
  },
  composeDmsSent(userId, someFailed) {
    if (someFailed) {
      return pickLocale(
        userId,
        "Check your DMs to compose and send the winners post. Some other recipients could not be DM'd.",
        "Schau in deine DMs, um den Gewinner-Beitrag zu erstellen und zu senden. Einige andere Empfänger konnten nicht per DM erreicht werden.",
      );
    }
    return pickLocale(
      userId,
      "Check your DMs to compose and send the winners post.",
      "Schau in deine DMs, um den Gewinner-Beitrag zu erstellen und zu senden.",
    );
  },
  prepareFailed(userId, code) {
    if (code === 50007) {
      return pickLocale(userId, "I couldn't DM you. Open your DMs and try again.", "Ich konnte dir keine DM senden. Öffne deine DMs und versuche es erneut.");
    }
    return pickLocale(userId, "Something went wrong while preparing the week end.", "Beim Vorbereiten des Wochenabschlusses ist etwas schiefgelaufen.");
  },
  permissionDeniedButton(userId) {
    return pickLocale(userId, "You do not have permission to use this button.", "Du hast keine Berechtigung, diese Schaltfläche zu verwenden.");
  },
  permissionDeniedForm(userId) {
    return pickLocale(userId, "You do not have permission to use this form.", "Du hast keine Berechtigung, dieses Formular zu verwenden.");
  },
  winnersPosted(userId, weekNumber, winnerCount, submissionCount) {
    const winnerLabel = winnerCount === 1 ? pickLocale(userId, "winner", "Gewinner") : pickLocale(userId, "winners", "Gewinner");
    const submissionLabel = submissionCount === 1
      ? pickLocale(userId, "submission", "Einreichung")
      : pickLocale(userId, "submissions", "Einreichungen");
    return pickLocale(
      userId,
      `Posted winners for wk${weekNumber} (${winnerCount} ${winnerLabel} from ${submissionCount} ${submissionLabel}).`,
      `Gewinner für Woche ${weekNumber} veröffentlicht (${winnerCount} ${winnerLabel} aus ${submissionCount} ${submissionLabel}).`,
    );
  },
  finalizeFailed(userId) {
    return pickLocale(userId, "Something went wrong while posting the winners.", "Beim Veröffentlichen der Gewinner ist etwas schiefgelaufen.");
  },
};

export function buildReplacementPreviewTexts(userId) {
  return {
    heading: pickLocale(userId, "## Replace your contest entry?", "## Beitrag ersetzen?"),
    current: pickLocale(userId, "**Current**", "**Aktuell**"),
    candidate: pickLocale(userId, "**Candidate**", "**Neuer Entwurf**"),
    replace: pickLocale(userId, "Replace", "Ersetzen"),
    cancel: pickLocale(userId, "Cancel", "Abbrechen"),
    checkDms: pickLocale(userId, "Check your DMs to preview and confirm the replacement.", "Schau in deine DMs, um die Ersetzung anzusehen und zu bestätigen."),
    unavailable: pickLocale(userId, "This replacement request is unavailable. Run `/submit-photo` again to start a new one.", "Diese Ersetzungsanfrage ist nicht mehr verfügbar. Führe `/submit-photo` erneut aus, um eine neue zu starten."),
    cancelled: pickLocale(userId, "Replacement cancelled. Your original entry is still active.", "Ersetzung abgebrochen. Dein ursprünglicher Beitrag ist weiterhin aktiv."),
    replaced: pickLocale(userId, "Your contest entry was replaced.", "Dein Wettbewerbsbeitrag wurde ersetzt."),
    failed: pickLocale(userId, "The replacement failed. Your original entry is still active.", "Die Ersetzung ist fehlgeschlagen. Dein ursprünglicher Beitrag ist weiterhin aktiv."),
  };
}

export function buildViewSubmissionsTexts(userId) {
  return {
    viewButton: pickLocale(userId, "View your submissions", "Deine Einreichungen ansehen"),
    heading: pickLocale(userId, "## Your submission", "## Deine Einreichung"),
    noSubmission: pickLocale(userId, "You have not submitted a photo for this period yet.", "Du hast für diese Periode noch kein Foto eingereicht."),
    submissionsClosed: pickLocale(userId, "Submissions are closed until the next weekly period.", "Einreichungen sind bis zur nächsten Wochenperiode geschlossen."),
    checkDms: pickLocale(userId, "Check your DMs to view or manage your submission.", "Schau in deine DMs, um deine Einreichung anzusehen oder zu verwalten."),
    dmFailed: pickLocale(userId, "I couldn't DM you. Open your DMs to this server and try again.", "Ich konnte dir keine DM senden. Öffne deine DMs für diesen Server und versuche es erneut."),
    pendingReplacement: pickLocale(userId, "You already have a pending replacement. Check your DMs to confirm or cancel it.", "Du hast bereits eine ausstehende Ersetzung. Schau in deine DMs, um sie zu bestätigen oder abzubrechen."),
    change: pickLocale(userId, "Change", "Ändern"),
    delete: pickLocale(userId, "Delete", "Löschen"),
    changeInstructions: pickLocale(
      userId,
      "Use **Submit Photo** in the posting channel to upload a replacement. You will get a DM preview to confirm.",
      "Verwende **Foto einreichen** im Einreichungskanal, um ein Ersatzfoto hochzuladen. Du erhältst eine DM-Vorschau zur Bestätigung.",
    ),
    deleted: pickLocale(userId, "Your submission was deleted.", "Deine Einreichung wurde gelöscht."),
    deleteUnavailable: pickLocale(userId, "This submission is no longer available.", "Diese Einreichung ist nicht mehr verfügbar."),
    deleteFailed: pickLocale(userId, "Something went wrong while deleting your submission.", "Beim Löschen deiner Einreichung ist etwas schiefgelaufen."),
  };
}

export function buildWinnersModalLabels(userId) {
  return pickLocale(
    userId,
    {
      title: "Winners Post",
      titleLabel: "Title",
      titleDescription: "The heading at the top of the winners post.",
      p1Label: "Description for P1",
      p1Description: "Intro text shown above the 1st place winner.",
      p2Label: "Description for P2",
      p2Description: "Intro text shown above the 2nd place winner.",
    },
    {
      title: "Gewinner-Beitrag",
      titleLabel: "Titel",
      titleDescription: "Die Überschrift oben im Gewinner-Beitrag.",
      p1Label: "Beschreibung für Platz 1",
      p1Description: "Einleitungstext über dem Gewinner auf Platz 1.",
      p2Label: "Beschreibung für Platz 2",
      p2Description: "Einleitungstext über dem Gewinner auf Platz 2.",
    },
  );
}
