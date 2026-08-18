/**
 * A one-page PDF, written by hand.
 *
 * The only PDF this product makes is a payslip: one page, text and rules, two
 * standard fonts. A library that lays out arbitrary documents earns its place
 * when the documents are arbitrary; until then this stays a page of code that
 * the Netlify function bundler needs nothing extra for.
 *
 * Coordinates are PDF points, origin bottom-left, A4 (595 x 842). Text is
 * WinAnsi, which is why amounts say "Rs" rather than the rupee sign — the
 * glyph is not in the base-14 fonts, and a payslip that prints a box where
 * the money sign should be reads as broken.
 */

const escapeText = (s) => String(s)
  .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  // Outside Latin-1 there is no glyph in a base-14 font; a question mark is
  // honest, a random byte is garbage.
  .replace(/[^\x20-\xff]/g, '?');

/**
 * lines: [{ x, y, text, size?, bold?, gray? }] — gray 0..1, default near-black.
 * rules: [{ x1, y1, x2, y2 }] — hairlines.
 */
export function textPdf({ lines, rules = [] }) {
  const ops = [];
  for (const r of rules) {
    ops.push(`0.78 0.76 0.72 RG 0.75 w ${r.x1} ${r.y1} m ${r.x2} ${r.y2} l S`);
  }
  for (const l of lines) {
    const g = l.gray ?? 0.12;
    ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${l.size ?? 11} Tf ${g} ${g} ${g} rg `
      + `1 0 0 1 ${l.x} ${l.y} Tm (${escapeText(l.text)}) Tj ET`);
  }
  const stream = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const rs = (n) => `Rs ${Number(n).toLocaleString('en-IN', {
  minimumFractionDigits: 0, maximumFractionDigits: 2,
})}`;

const ROLE_LABEL = {
  owner: 'Owner', manager: 'Manager', caretaker: 'Farm hand',
  vet: 'Vet', accountant: 'Accountant',
};

/**
 * The payslip itself. `pay` is one row from the month-pay query: month,
 * days_in_month, present, half_days, holiday, absent, leave, paid_days,
 * monthly_amount, amount.
 */
export function payslipPdf({ farmName, person, pay }) {
  const monthName = new Date(`${pay.month}-01T00:00:00`)
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const L = 64, R = 531;
  const lines = [];
  const rules = [];

  lines.push({ x: L, y: 778, text: farmName, size: 20, bold: true });
  lines.push({ x: L, y: 756, text: `Salary slip - ${monthName}`, size: 12, gray: 0.45 });
  rules.push({ x1: L, y1: 740, x2: R, y2: 740 });

  lines.push({ x: L, y: 712, text: 'PAID TO', size: 8, bold: true, gray: 0.45 });
  lines.push({ x: L, y: 694, text: person.full_name, size: 15, bold: true });
  lines.push({
    x: L, y: 678, size: 10, gray: 0.45,
    text: `${ROLE_LABEL[person.role] ?? person.role}${person.phone ? ` - ${person.phone}` : ''}`,
  });

  lines.push({ x: L, y: 636, text: 'THE MONTH', size: 8, bold: true, gray: 0.45 });
  const rows = [
    ['Days in the month', String(pay.days_in_month)],
    ['Present', String(pay.present)],
    ['Half days', String(pay.half_days)],
    ['Paid holidays', String(pay.holiday)],
    ['Absent', String(pay.absent)],
    ['On leave', String(pay.leave)],
    ['Days paid for', String(pay.paid_days)],
  ];
  let y = 614;
  for (const [label, value] of rows) {
    const bold = label === 'Days paid for';
    lines.push({ x: L, y, text: label, size: 11, bold, gray: bold ? 0.12 : 0.3 });
    lines.push({ x: 340, y, text: value, size: 11, bold });
    y -= 20;
  }

  y -= 8;
  rules.push({ x1: L, y1: y + 14, x2: R, y2: y + 14 });
  y -= 14;
  lines.push({ x: L, y, text: 'Monthly salary', size: 11, gray: 0.3 });
  lines.push({ x: 340, y, text: rs(pay.monthly_amount), size: 11 });
  y -= 30;
  lines.push({ x: L, y, text: 'Amount payable', size: 14, bold: true });
  lines.push({ x: 340, y, text: rs(pay.amount), size: 16, bold: true });
  y -= 18;
  lines.push({
    x: L, y, size: 9, gray: 0.45,
    text: `${rs(pay.monthly_amount)} x ${pay.paid_days} of ${pay.days_in_month} days`
      + ` - present and half days count, paid holidays count, absence and leave do not.`,
  });

  rules.push({ x1: L, y1: 76, x2: R, y2: 76 });
  lines.push({
    x: L, y: 60, size: 9, gray: 0.45,
    text: `Generated by rabbitfarmers from the farm's attendance record`
      + ` on ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
  });

  return textPdf({ lines, rules });
}
