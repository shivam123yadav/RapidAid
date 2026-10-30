import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { Role } from '../validation/constants.js';

/**
 * Assigns a unique request id to every request (reusing a well-formed
 * x-request-id supplied by the client for distributed tracing), echoes it
 * on the response, and makes it available to handlers + the error formatter.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      /**
       * Populated by the auth middleware from the verified JWT + the user
       * document. `role` is the `Role` union (not `string`) so an invalid role
       * cannot flow into an authorization check without a compile error.
       */
      auth?: {
        userId: string;
        role: Role;
        name: string;
        email: string;
        /**
         * Owning facility for HOSPITAL_STAFF, read live from the user document
         * (never from a token claim) so ownership cannot be forged or go stale.
         */
        hospitalId?: string;
        organizationId?: string;
        ambulanceId?: string;
        permissions: readonly string[];
      };
    }
  }
}

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function requestId(req: Request, res: import('express').Response, next: import('express').NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && CLIENT_ID_RE.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
