import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Repo } from '../persistence/repo';
import type { RoomManager } from '../ws/RoomManager';
import { requireUser, userId } from './auth';

const boardParams = z.object({ id: z.string().uuid() });
const memberParams = boardParams.extend({ userId: z.string().uuid() });
const titleBody = z.object({ title: z.string().trim().min(1).max(120) });
// Only the creator is ever owner; members are invited as editor or viewer.
const memberRole = z.enum(['editor', 'viewer']);

/**
 * Boards and members (system-design.md, "REST API"). Non-members get 404 rather than 403,
 * so board ids can't be probed. Role changes and removals reach open sockets immediately.
 */
export function registerBoardRoutes(app: FastifyInstance, repo: Repo, rooms: RoomManager): void {
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'board_not_found' });
  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: 'forbidden' });

  app.get('/api/boards', { preHandler: requireUser }, async (req) => ({ boards: await repo.listBoards(userId(req)) }));

  app.post('/api/boards', { preHandler: requireUser }, async (req, reply) => {
    const body = z.object({ title: titleBody.shape.title.optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
    const board = await repo.createBoard(userId(req), body.data.title ?? 'Untitled board');
    return reply.code(201).send({ board });
  });

  app.get('/api/boards/:id', { preHandler: requireUser }, async (req, reply) => {
    const params = boardParams.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const board = await repo.getBoardForUser(params.data.id, userId(req));
    return board ? { board } : notFound(reply);
  });

  app.patch('/api/boards/:id', { preHandler: requireUser }, async (req, reply) => {
    const params = boardParams.safeParse(req.params);
    const body = titleBody.safeParse(req.body);
    if (!params.success) return notFound(reply);
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
    const role = await repo.getRole(params.data.id, userId(req));
    if (!role) return notFound(reply);
    if (role !== 'owner') return forbidden(reply);
    await repo.renameBoard(params.data.id, body.data.title);
    return reply.code(204).send();
  });

  app.delete('/api/boards/:id', { preHandler: requireUser }, async (req, reply) => {
    const params = boardParams.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const role = await repo.getRole(params.data.id, userId(req));
    if (!role) return notFound(reply);
    if (role !== 'owner') return forbidden(reply);
    await repo.softDeleteBoard(params.data.id);
    await rooms.deleteBoard(params.data.id); // open sockets get `board_deleted`
    return reply.code(204).send();
  });

  app.get('/api/boards/:id/members', { preHandler: requireUser }, async (req, reply) => {
    const params = boardParams.safeParse(req.params);
    if (!params.success || !(await repo.getRole(params.data.id, userId(req)))) return notFound(reply);
    return { members: await repo.listMembers(params.data.id) };
  });

  app.post('/api/boards/:id/members', { preHandler: requireUser }, async (req, reply) => {
    const params = boardParams.safeParse(req.params);
    const body = z.object({ email: z.string().trim().toLowerCase().email(), role: memberRole }).safeParse(req.body);
    if (!params.success) return notFound(reply);
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
    const role = await repo.getRole(params.data.id, userId(req));
    if (!role) return notFound(reply);
    if (role !== 'owner') return forbidden(reply);
    const target = await repo.findUserByEmail(body.data.email);
    if (!target) return reply.code(404).send({ error: 'user_not_found' });
    if ((await repo.getRole(params.data.id, target.id)) === 'owner') return reply.code(400).send({ error: 'cannot_change_owner' });
    const member = await repo.upsertMember(params.data.id, body.data.email, body.data.role);
    if (!member) return reply.code(404).send({ error: 'user_not_found' });
    rooms.setRole(params.data.id, member.id, body.data.role);
    return reply.code(201).send({ member: { ...member, role: body.data.role } });
  });

  app.patch('/api/boards/:id/members/:userId', { preHandler: requireUser }, async (req, reply) => {
    const params = memberParams.safeParse(req.params);
    const body = z.object({ role: memberRole }).safeParse(req.body);
    if (!params.success) return notFound(reply);
    if (!body.success) return reply.code(400).send({ error: 'invalid_input' });
    const role = await repo.getRole(params.data.id, userId(req));
    if (!role) return notFound(reply);
    if (role !== 'owner') return forbidden(reply);
    if ((await repo.getRole(params.data.id, params.data.userId)) === 'owner') return reply.code(400).send({ error: 'cannot_change_owner' });
    if (!(await repo.setRole(params.data.id, params.data.userId, body.data.role))) return reply.code(404).send({ error: 'member_not_found' });
    // Pushed to their open sockets now: the next batch they send is checked against it.
    rooms.setRole(params.data.id, params.data.userId, body.data.role);
    return reply.code(204).send();
  });

  app.delete('/api/boards/:id/members/:userId', { preHandler: requireUser }, async (req, reply) => {
    const params = memberParams.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const role = await repo.getRole(params.data.id, userId(req));
    if (!role) return notFound(reply);
    if (role !== 'owner') return forbidden(reply);
    if ((await repo.getRole(params.data.id, params.data.userId)) === 'owner') return reply.code(400).send({ error: 'cannot_remove_owner' });
    await repo.removeMember(params.data.id, params.data.userId);
    rooms.removeMember(params.data.id, params.data.userId); // their sockets are closed
    return reply.code(204).send();
  });
}
