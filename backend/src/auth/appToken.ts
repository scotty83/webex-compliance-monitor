import jwt from 'jsonwebtoken';
import type { Role } from '../domain/types.js';

export interface AppSession {
  email: string;
  role: Role;
}

export function signAppSession(payload: AppSession, secret: string, ttlSeconds = 3600): string {
  return jwt.sign(payload, secret, { expiresIn: ttlSeconds });
}

export function verifyAppSession(token: string, secret: string): AppSession | null {
  try {
    const d = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (d.role !== 'officer' && d.role !== 'admin') return null;
    return { email: String(d.email), role: d.role };
  } catch {
    return null;
  }
}
