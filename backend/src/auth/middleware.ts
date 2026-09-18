import type { RequestHandler } from 'express';
import type { Role } from '../domain/types.js';
import { verifyAppSession } from './appToken.js';

function roleSatisfies(actual: Role, required: Role): boolean {
  return required === 'officer' ? actual === 'officer' || actual === 'admin' : actual === 'admin';
}

/** Bind the JWT secret once, then gate routes with `requireRole('officer' | 'admin')`. */
export function makeRequireRole(secret: string) {
  return function requireRole(required: Role): RequestHandler {
    return (req, res, next) => {
      const bearer = req.headers.authorization?.replace(/^Bearer /i, '');
      if (!bearer) return res.status(401).json({ error: 'missing app session token' });
      const session = verifyAppSession(bearer, secret);
      if (!session) return res.status(401).json({ error: 'invalid app session token' });
      if (!roleSatisfies(session.role, required)) {
        return res.status(403).json({ error: 'insufficient role' });
      }
      res.locals.auth = session;
      return next();
    };
  };
}
