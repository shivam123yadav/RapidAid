/**
 * Message templates.
 *
 * Pure functions with no I/O and no environment access, so each one can be
 * unit-tested in isolation. Every template returns both a plain-text and an
 * HTML alternative: the text part is a genuine fallback, not decoration, and
 * several mail clients score deliverability on it being present.
 *
 * HTML is intentionally minimal and inline-styled, because mail clients strip
 * most external CSS and many block stylesheets outright.
 */

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const BRAND = 'RapidAid';
const shell = (title: string, body: string): string => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f6fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
    <div style="background:#dc2626;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700">${BRAND}</div>
    <div style="padding:24px">
      <h1 style="margin:0 0 16px;font-size:18px">${title}</h1>
      ${body}
      <p style="margin:24px 0 0;font-size:12px;color:#6b7280">If you did not expect this message you can safely ignore it.</p>
    </div>
  </div>
</body></html>`;

const button = (url: string, label: string): string =>
  `<p style="margin:24px 0"><a href="${url}" style="background:#dc2626;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">${label}</a></p>
   <p style="margin:0;font-size:12px;color:#6b7280;word-break:break-all">Or paste this link into your browser:<br />${url}</p>`;

/** Sent once, immediately after a citizen completes registration. */
export function verificationEmail(name: string, url: string): EmailContent {
  return {
    subject: `Verify your ${BRAND} account`,
    text: [
      `Hi ${name},`,
      '',
      'Thanks for registering with RapidAid. Confirm this email address to activate your account and start reporting emergencies.',
      '',
      `Verify your email: ${url}`,
      '',
      `This link expires in 24 hours.`,
    ].join('\n'),
    html: shell(
      'Verify your email address',
      `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
       <p style="margin:0">Thanks for registering. Confirm this address to activate your account and start reporting emergencies.</p>
       ${button(url, 'Verify my email')}`,
    ),
  };
}

/** Sent in response to a password-reset request. */
export function passwordResetEmail(name: string, url: string): EmailContent {
  return {
    subject: `Reset your ${BRAND} password`,
    text: [
      `Hi ${name},`,
      '',
      'We received a request to reset your RapidAid password. Use the link below to choose a new one.',
      '',
      `Reset your password: ${url}`,
      '',
      'This link expires in 24 hours and can be used once.',
      'If you did not request this, no action is needed — your password has not changed.',
    ].join('\n'),
    html: shell(
      'Reset your password',
      `<p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
       <p style="margin:0">We received a request to reset your RapidAid password. Choose a new one using the link below.</p>
       ${button(url, 'Reset my password')}
       <p style="margin:24px 0 0;font-size:13px;color:#6b7280">If you did not request this, no action is needed — your password has not changed.</p>`,
    ),
  };
}

/**
 * Escapes interpolated values before they reach HTML. Names are user-supplied,
 * so without this a crafted name could inject markup into the message.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
