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
export type Sex = 'doe' | 'buck';

export const sexLabel = (sex: string) => (sex === 'doe' ? 'Female' : 'Male');

/** For the one screen where the reader is being taught the pairing. */
export const sexLabelFull = (sex: string) =>
  (sex === 'doe' ? 'Female (doe)' : 'Male (buck)');

export const sexTerm = (sex: string) => (sex === 'doe' ? 'doe' : 'buck');
