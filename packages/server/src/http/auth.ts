import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { Repo } from '../persistence/repo';

export const SESSION_COOKIE = 'wb_session';
const SESSION_DAYS = 7;

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200),
});
const signupBody = credentials.extend({ name: z.string().trim().min(1).max(80) });

/** Pre-handler: 401 unless the request carries a valid session cookie. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify({ onlyCookie: true });
  } catch {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}

export function userId(req: FastifyRequest): string {
  return req.user.sub;
}

/** Signup, login, logout, me (system-design.md, "REST API"). JWT in an httpOnly cookie. */
export function registerAuthRoutes(app: FastifyInstance, repo: Repo, config: Config): void {
  const setSession = (reply: FastifyReply, id: string) => {
    const token = app.jwt.sign({ sub: id }, { expiresIn: `${SESSION_DAYS}d` });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, // not readable from JS, so XSS can't steal it
      sameSite: 'lax', // not sent on cross-site POSTs (CSRF)
      secure: config.cookieSecure,
      path: '/',
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    });
  };

  app.post('/api/auth/signup', async (req, reply) => {
    const body = signupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_input', details: body.error.issues[0]?.message });
    const hash = await bcrypt.hash(body.data.password, config.bcryptCost);
    const user = await repo.createUser(body.data.email, body.data.name, hash);
    if (!user) return reply.code(409).send({ error: 'email_taken' });
    setSession(reply, user.id);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', async (req, reply) => {
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

  app.post('/api/auth/logout', { preHandler: requireUser }, async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/me', { preHandler: requireUser }, async (req, reply) => {
    const user = await repo.findUserById(userId(req));
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return { user };
  });
}
