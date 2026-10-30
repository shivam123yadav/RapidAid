import pino from 'pino';
import { env, isTest } from './env.js';

export const REDACTED_VALUE = '[REDACTED]';

/**
 * Centrally configured sensitive paths for fast-redact.
 * Pino redacts properties matching these paths across all logger calls
 * without mutating the caller's input objects.
 */
export const REDACT_PATHS: string[] = [
  // HTTP headers (all standard variants)
  'req.headers.authorization',
  'req.headers["authorization"]',
  'req.headers.cookie',
  'req.headers["cookie"]',
  'req.headers["proxy-authorization"]',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["authorization"]',
  'headers.cookie',
  'headers["cookie"]',
  'headers["proxy-authorization"]',
  'headers["set-cookie"]',

  // Authentication credentials & secrets
  'password',
  '*.password',
  '*.*.password',
  '*.*.*.password',
  '*.*.*.*.password',
  'passwordHash',
  '*.passwordHash',
  '*.*.passwordHash',
  '*.*.*.passwordHash',
  'passwordConfirm',
  '*.passwordConfirm',
  '*.*.passwordConfirm',
  '*.*.*.passwordConfirm',
  'passwordConfirmation',
  '*.passwordConfirmation',
  '*.*.passwordConfirmation',
  '*.*.*.passwordConfirmation',
  'currentPassword',
  '*.currentPassword',
  '*.*.currentPassword',
  'newPassword',
  '*.newPassword',
  '*.*.newPassword',
  'oldPassword',
  '*.oldPassword',
  '*.*.oldPassword',

  // Tokens & Session Keys
  'token',
  '*.token',
  '*.*.token',
  '*.*.*.token',
  '*.*.*.*.token',
  'tokenHash',
  '*.tokenHash',
  '*.*.tokenHash',
  '*.*.*.tokenHash',
  'refreshToken',
  '*.refreshToken',
  '*.*.refreshToken',
  '*.*.*.refreshToken',
  '*.*.*.*.refreshToken',
  'accessToken',
  '*.accessToken',
  '*.*.accessToken',
  '*.*.*.accessToken',
  'jwt',
  '*.jwt',
  '*.*.jwt',
  '*.*.*.jwt',
  'secret',
  '*.secret',
  '*.*.secret',
  '*.*.*.secret',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  '*.*.*.apiKey',
  'apikey',
  '*.apikey',
  '*.*.apikey',
  '*.*.*.apikey',
  'sessionSecret',
  '*.sessionSecret',
  '*.*.sessionSecret',
  'resetToken',
  '*.resetToken',
  '*.*.resetToken',
  '*.*.*.resetToken',
  'verificationToken',
  '*.verificationToken',
  '*.*.verificationToken',
  '*.*.*.verificationToken',

  // Personal Identifiable Information (PII)
  'patientName',
  '*.patientName',
  '*.*.patientName',
  '*.*.*.patientName',
  '*.*.*.*.patientName',
  'callerName',
  '*.callerName',
  '*.*.callerName',
  '*.*.*.callerName',
  '*.*.*.*.callerName',
  'phone',
  '*.phone',
  '*.*.phone',
  '*.*.*.phone',
  '*.*.*.*.phone',
  'phoneNumber',
  '*.phoneNumber',
  '*.*.phoneNumber',
  '*.*.*.phoneNumber',
  '*.*.*.*.phoneNumber',
  'callerPhone',
  '*.callerPhone',
  '*.*.callerPhone',
  '*.*.*.callerPhone',
  'patientPhone',
  '*.patientPhone',
  '*.*.patientPhone',
  '*.*.*.patientPhone',
  'email',
  '*.email',
  '*.*.email',
  '*.*.*.email',
  '*.*.*.*.email',

  // Emergency & Clinical Sensitive Fields
  'description',
  '*.description',
  '*.*.description',
  '*.*.*.description',
  '*.*.*.*.description',
  'medicalNotes',
  '*.medicalNotes',
  '*.*.medicalNotes',
  '*.*.*.medicalNotes',
  'notes',
  '*.notes',
  '*.*.notes',
  '*.*.*.notes',

  // Voice reports & audio payloads
  'transcript',
  '*.transcript',
  '*.*.transcript',
  '*.*.*.transcript',
  '*.*.*.*.transcript',
  'clientTranscript',
  '*.clientTranscript',
  '*.*.clientTranscript',
  '*.*.*.clientTranscript',
  'rawTranscript',
  '*.rawTranscript',
  '*.*.rawTranscript',
  '*.*.*.rawTranscript',
  'dataUrl',
  '*.dataUrl',
  '*.*.dataUrl',
  '*.*.*.dataUrl',
  '*.*.*.*.dataUrl',
  'spokenLocation',
  '*.spokenLocation',
  '*.*.spokenLocation',
  '*.*.*.spokenLocation',

  // Request & response bodies (ensures full bodies or sensitive nested bodies never leak)
  'req.body',
  'req.body.password',
  'req.body.token',
  'req.body.email',
  'res.body',
  'body.password',
  'body.token',
];

const SENSITIVE_PARAM_REGEX =
  /^(token|access_token|refresh_token|jwt|secret|apikey|key|password|credential|email|phone)/i;

/** Sanitizes query string parameters in raw URLs. */
export function sanitizeUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return rawUrl;

  const pathname = rawUrl.slice(0, qIndex);
  const search = rawUrl.slice(qIndex + 1);
  try {
    const params = new URLSearchParams(search);
    let modified = false;
    for (const [key] of Array.from(params.entries())) {
      if (SENSITIVE_PARAM_REGEX.test(key)) {
        params.set(key, REDACTED_VALUE);
        modified = true;
      }
    }
    if (!modified) return rawUrl;
    return `${pathname}?${decodeURIComponent(params.toString())}`;
  } catch {
    return pathname;
  }
}

/** Sanitizes credentials and secrets in strings (e.g. DB connection strings, Bearer tokens). */
export function sanitizeString(val: string): string {
  if (typeof val !== 'string') return val;
  return val
    .replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3')
    .replace(/(https?:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(password["']?\s*[:=]\s*["']?)([^"',;\s]+)(["']?)/gi, '$1[REDACTED]$3')
    .replace(/(token["']?\s*[:=]\s*["']?)([^"',;\s]+)(["']?)/gi, '$1[REDACTED]$3');
}

/** Serializer for HTTP requests — prevents raw header or body leakage while preserving diagnostics. */
export const reqSerializer: pino.SerializerFn = (req: unknown) => {
  if (!req || typeof req !== 'object') return req;
  const raw = ((req as { raw?: Record<string, unknown> }).raw ?? req) as Record<string, unknown>;
  const url = sanitizeUrl((raw.url as string) ?? (req as { url?: string }).url);
  const rawHeaders =
    ((raw.headers as Record<string, unknown>) ??
      (req as { headers?: Record<string, unknown> }).headers) || {};
  const headers: Record<string, unknown> = { ...rawHeaders };

  if (headers.authorization) headers.authorization = REDACTED_VALUE;
  if (headers.cookie) headers.cookie = REDACTED_VALUE;
  if (headers['proxy-authorization']) headers['proxy-authorization'] = REDACTED_VALUE;
  if (headers['set-cookie']) headers['set-cookie'] = REDACTED_VALUE;

  return {
    id: (req as { id?: string }).id ?? raw.id ?? raw.requestId,
    method: raw.method ?? (req as { method?: string }).method,
    url,
    headers,
    remoteAddress: (raw.socket as { remoteAddress?: string })?.remoteAddress,
  };
};

/** Serializer for HTTP responses — strips Set-Cookie and sensitive response headers. */
export const resSerializer: pino.SerializerFn = (res: unknown) => {
  if (!res || typeof res !== 'object') return res;
  const raw = ((res as { raw?: Record<string, unknown> }).raw ?? res) as Record<string, unknown>;
  const rawHeaders =
    typeof (raw.getHeaders as () => Record<string, unknown>) === 'function'
      ? (raw.getHeaders as () => Record<string, unknown>)()
      : ((raw.headers as Record<string, unknown>) ??
          (res as { headers?: Record<string, unknown> }).headers) || {};
  const headers: Record<string, unknown> = { ...rawHeaders };

  if (headers['set-cookie']) headers['set-cookie'] = REDACTED_VALUE;

  return {
    statusCode: raw.statusCode ?? (res as { statusCode?: number }).statusCode,
    headers,
  };
};

/** Serializer for errors — sanitizes DB credentials, Bearer tokens, and error metadata. */
export const errSerializer: pino.SerializerFn = (err: unknown) => {
  if (!err) return err;
  let serialized: Record<string, unknown>;
  if (err instanceof Error) {
    serialized = pino.stdSerializers.err(err) as Record<string, unknown>;
  } else if (typeof err === 'object') {
    serialized = { ...(err as Record<string, unknown>) };
  } else {
    return sanitizeString(String(err));
  }

  if (typeof serialized.message === 'string') {
    serialized.message = sanitizeString(serialized.message);
  }
  if (typeof serialized.stack === 'string') {
    serialized.stack = sanitizeString(serialized.stack);
  }
  for (const key of ['password', 'token', 'secret', 'apiKey', 'keyValue', 'body', 'query']) {
    if (key in serialized) {
      serialized[key] = REDACTED_VALUE;
    }
  }
  return serialized;
};

export const defaultSerializers = {
  req: reqSerializer,
  res: resSerializer,
  err: errSerializer,
};

export const defaultRedact: pino.redactOptions = {
  paths: REDACT_PATHS,
  censor: REDACTED_VALUE,
};

export function createLogger(
  options: pino.LoggerOptions = {},
  destination?: pino.DestinationStream,
): pino.Logger {
  const level = options.level ?? (isTest ? 'silent' : env.LOG_LEVEL);
  const mergedOptions: pino.LoggerOptions = {
    level,
    redact: options.redact ?? defaultRedact,
    serializers: {
      ...defaultSerializers,
      ...options.serializers,
    },
    ...options,
  };

  if (destination) {
    return pino(mergedOptions, destination);
  }

  if (!isTest && env.NODE_ENV === 'development') {
    return pino({
      ...mergedOptions,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(mergedOptions);
}

/** Default singleton application logger. */
export const logger = createLogger();
