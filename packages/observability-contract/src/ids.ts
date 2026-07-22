/**
 * nanoid-based ID helpers for observability events.
 *
 * Every event carries a nanoid `event_id` for wire-level dedup. Every
 * operation carries a nanoid `operation_id`. Every attempt within an
 * operation carries a distinct nanoid `attempt_id`.
 *
 * Alphabets are ASCII-only, URL-safe, and typographically distinct so
 * IDs don't collide with punctuation in log formats.
 */

import { nanoid } from "nanoid";

/** ID length for event_id (short; wire-level dedup only). */
export const EVENT_ID_LENGTH = 12;

/** ID length for operation_id (medium; groups events in one workflow). */
export const OPERATION_ID_LENGTH = 16;

/** ID length for attempt_id (medium; distinct within an operation). */
export const ATTEMPT_ID_LENGTH = 16;

/** ID length for evaluation_id (medium). */
export const EVALUATION_ID_LENGTH = 16;

/**
 * Generate a fresh `event_id`. 12-char nanoid (probability of collision
 * across 1M events per second for a year: <1 in a trillion).
 */
export function newEventId(): string {
  return nanoid(EVENT_ID_LENGTH);
}

/**
 * Generate a fresh `operation_id`. 16-char nanoid. Longer than event_id
 * because operations are grouping keys queried against for weeks or
 * months of retention.
 */
export function newOperationId(): string {
  return nanoid(OPERATION_ID_LENGTH);
}

/**
 * Generate a fresh `attempt_id`. 16-char nanoid.
 */
export function newAttemptId(): string {
  return nanoid(ATTEMPT_ID_LENGTH);
}

/**
 * Generate a fresh `evaluation_id`. 16-char nanoid.
 */
export function newEvaluationId(): string {
  return nanoid(EVALUATION_ID_LENGTH);
}
