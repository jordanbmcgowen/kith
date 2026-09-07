/**
 * Confidence below this goes to needs_review instead of filing itself. In its
 * own file so the confirmation screen can show the same line without pulling
 * the Anthropic SDK into the browser bundle.
 */
export const AUTO_FILE_THRESHOLD = 0.82;
