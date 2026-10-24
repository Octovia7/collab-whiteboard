import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config';
import type { Repo } from '../persistence/repo';
import { isRevoked, revokeSession } from '../redisState';
import type { RedisBus } from '../ws/RedisBus';

export const SESSION_COOKIE = 'wb_session';
const SESSION_DAYS = 7;

declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** `jti` names the session, so logging out can revoke exactly this token. */
    payload: { sub: string; jti: string };
    user: { sub: string; jti?: string; exp?: number };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared Redis connection (session revocation checks). */
    redis: Redis;
  }
}

/**
 * Whether a verified token's session was logged out. Fails closed: if Redis can't answer, this
 * throws and the request gets 503, never a pass for a possibly revoked session.
 */
export async function sessionValid(redis: Redis, user: { jti?: string }): Promise<boolean> {
  // Tokens from before sessions had ids can't be revoked, so they are no longer accepted.
  if (!user.jti) return false;
  return !(await isRevoked(redis, user.jti));
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
});
const signupBody = credentials.extend({ name: z.string().trim().min(1).max(80) });

/** Pre-handler: 401 unless the request carries a valid, not logged-out session cookie. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify({ onlyCookie: true });
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  let valid: boolean;
  try {
    valid = await sessionValid(req.server.redis, req.user);
  } catch (err) {
    req.log.warn({ err: { message: (err as Error).message } }, 'session check failed (Redis): refusing');
    return reply.code(503).send({ error: 'service_unavailable' });
  }
  if (!valid) return reply.code(401).send({ error: 'unauthorized' });
}

export function userId(req: FastifyRequest): string {
  return req.user.sub;
}

/** Signup, login, logout, me (system-design.md, "REST API"). JWT in an httpOnly cookie. */
export function registerAuthRoutes(app: FastifyInstance, repo: Repo, config: Config, bus: RedisBus): void {
  const setSession = (reply: FastifyReply, id: string) => {
    const token = app.jwt.sign({ sub: id, jti: randomUUID() }, { expiresIn: `${SESSION_DAYS}d` });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, // not readable from JS, so XSS can't steal it
      sameSite: 'lax', // not sent on cross-site POSTs (CSRF)
      secure: config.cookieSecure,
      path: '/',
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    });
  };

  // Per client IP (X-Forwarded-For when behind the proxy): slows down password guessing
  // and mass sign-ups. Counted in Redis, so it holds across servers.
  const authLimit = { config: { rateLimit: { max: config.authRateLimitPerMin, timeWindow: '1 minute' } } };

  app.post('/api/auth/signup', authLimit, async (req, reply) => {
    const body = signupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_input', details: body.error.issues[0]?.message });
    const hash = await bcrypt.hash(body.data.password, config.bcryptCost);
    const user = await repo.createUser(body.data.email, body.data.name, hash);
    if (!user) return reply.code(409).send({ error: 'email_taken' });
    setSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const body = credentials.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
    const user = await repo.findUserByEmail(body.data.email);
    // Same error for unknown email and wrong password, so the endpoint can't be used to
    // discover which emails have accounts.
    if (!user || !(await bcrypt.compare(body.data.password, user.passwordHash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    setSession(reply, user.id);
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  // Logout revokes this session everywhere: the token is refused from now on (it's stateless,
  // so clearing the cookie alone would leave a copied token valid for days), and every socket
  // opened with it, on any server, is closed with 4001.
  app.post('/api/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    const { jti, exp } = req.user;
    if (jti) {
      const ttlMs = exp ? exp * 1000 - Date.now() : SESSION_DAYS * 24 * 60 * 60 * 1000;
      await revokeSession(req.server.redis, jti, ttlMs);
      await bus.publishSessionRevoked(jti);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/me', { preHandler: requireUser }, async (req, reply) => {
    const user = await repo.findUserById(userId(req));
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return { user };
  });
}
