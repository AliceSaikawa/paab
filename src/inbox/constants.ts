const HOUR_MS = 60 * 60 * 1000;

/** An unanswered question expires this long after it was asked (design 3.6). */
export const QUESTION_TTL_MS = 7 * 24 * HOUR_MS;

/**
 * A message body is deleted this long after the recipient fetched the
 * message (design 4).
 */
export const BODY_RETENTION_MS = 24 * HOUR_MS;

/**
 * Delay before a bridge-rejected question's rejection becomes visible in the
 * asker's inbox, unread count, and delayed webhook wake (design 3.4).
 */
export const BRIDGE_REJECTION_DELAY_MS = 60_000;
