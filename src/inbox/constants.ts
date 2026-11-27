const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** An unanswered question expires this long after it was asked (design 3.6). */
export const QUESTION_TTL_MS = 7 * DAY_MS;

/**
 * An unfetched reply (answer or rejection) expires this long after it was
 * created, matching `QUESTION_TTL_MS` (design 4).
 */
export const UNFETCHED_REPLY_TTL_MS = 7 * DAY_MS;

/**
 * A message body is deleted this long after the recipient fetched the
 * message (design 4).
 */
export const BODY_RETENTION_MS = DAY_MS;

/**
 * Terminal message rows whose body has already been cleared are deleted this
 * long after creation (design 4).
 */
export const MESSAGE_RETENTION_MS = 90 * DAY_MS;
