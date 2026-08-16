/**
 * Words shown to people, kept in one place so the app never says "Buck" on one
 * screen and "Male" on the next about the same rabbit.
 *
 * Plain words lead. "Doe" and "Buck" are the right terms and the breeding
 * screens use them throughout — but a new farm hand adding stock on their first
 * morning knows male and female, and picking the wrong one there quietly
 * corrupts every pedigree and buck suggestion that follows.
 *
 * The stored value is still 'doe' / 'buck'. This is presentation only.
 */
export type Sex = 'doe' | 'buck' | 'unknown';

/**
 * 'unknown' is the honest answer for a kit. Sexing at thirty days is fiddly and
 * often wrong, so the app says "not sexed yet" rather than picking one — and
 * every breeding queue filters on doe or buck, so an unsexed grower stays out
 * of them until somebody looks properly at eight weeks.
 */
export const sexLabel = (sex: string) =>
  (sex === 'doe' ? 'Female' : sex === 'buck' ? 'Male' : 'Not sexed');

/** For the one screen where the reader is being taught the pairing. */
export const sexLabelFull = (sex: string) =>
  (sex === 'doe' ? 'Female (doe)' : sex === 'buck' ? 'Male (buck)' : 'Not sexed yet');

export const sexTerm = (sex: string) =>
  (sex === 'doe' ? 'doe' : sex === 'buck' ? 'buck' : 'unsexed');
