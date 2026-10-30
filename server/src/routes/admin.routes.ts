import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission, requireRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { RolePolicy, User, nextId } from '../models/index.js';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '../authz/policy.js';
import { P, invalidatePolicyCache } from '../authz/permissions.js';
import { ROLES, type Role } from '../validation/constants.js';
import { recordAudit } from '../services/auditService.js';
import { hashPassword } from '../services/tokenService.js';

export const adminRouter = Router();
const roleSchema = z.enum(ROLES);
const policySchema = z.object({ permissions: z.array(z.string().min(1)).max(200), revision: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(500).optional() });
const userCreateSchema = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email(), password: z.string().min(8).max(128), role: roleSchema, hospitalId: z.string().trim().max(40).optional(), ambulanceId: z.string().trim().max(40).optional(), organizationId: z.string().trim().max(40).optional() });
const userUpdateSchema = z.object({ name: z.string().trim().min(2).max(100).optional(), role: roleSchema.optional(), active: z.boolean().optional(), hospitalId: z.string().trim().max(40).nullable().optional(), ambulanceId: z.string().trim().max(40).nullable().optional(), organizationId: z.string().trim().max(40).nullable().optional() });

adminRouter.get('/permissions', authenticate, requireRole('ADMIN'), requirePermission(P.PERMISSION_MANAGE), asyncHandler(async (_req, res) => {
  const stored = await RolePolicy.find().lean();
  const overrides = new Map(stored.map((policy) => [policy.role, policy]));
  res.json({ catalog: ALL_PERMISSIONS, roles: Object.fromEntries((ROLES as readonly Role[]).map((role) => [role, overrides.get(role)?.permissions ?? ROLE_PERMISSIONS[role]])), revisions: Object.fromEntries((ROLES as readonly Role[]).map((role) => [role, overrides.get(role)?.revision ?? 0])) });
}));

adminRouter.put('/permissions/:role', authenticate, requireRole('ADMIN'), requirePermission(P.PERMISSION_MANAGE), validateBody(policySchema), asyncHandler(async (req, res) => {
  const role = roleSchema.parse(req.params.role) as Role;
  const permissions = [...new Set(req.body.permissions)] as Permission[];
  if (permissions.some((permission) => !ALL_PERMISSIONS.includes(permission))) throw ApiError.badRequest('Unknown permission identifier');
  if (role === 'ADMIN' && !permissions.includes(P.PERMISSION_MANAGE)) throw ApiError.badRequest('Administrator policy must retain permission:manage');
  const current = await RolePolicy.findById(role).lean();
  if (req.body.revision !== undefined && current && current.revision !== req.body.revision) throw ApiError.conflict('Role policy changed; refresh before saving');
  const previous = current?.permissions ?? ROLE_PERMISSIONS[role];
  const saved = current ? await RolePolicy.findOneAndUpdate({ _id: role, revision: current.revision }, { $set: { permissions, updatedBy: req.auth!.userId, updatedAt: new Date() }, $inc: { revision: 1 } }, { new: true }) : await RolePolicy.create({ _id: role, role, permissions, revision: 1, updatedBy: req.auth!.userId, updatedAt: new Date() });
  if (!saved) throw ApiError.conflict('Role policy changed; refresh before saving');
  invalidatePolicyCache(role);
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'permission.policy_updated', resource: 'RolePolicy', resourceId: role, requestId: req.requestId, reason: req.body.reason, previousState: previous, newState: permissions, ip: req.ip, userAgent: req.header('user-agent') });
  res.json({ role, permissions: saved.permissions, revision: saved.revision, updatedAt: saved.updatedAt });
}));

/**
 * Projects a user row to the admin list shape (`id`, not the Mongoose `_id`).
 *
 * POST /users and PATCH /users/:id below already returned this shape; the
 * collection endpoint used to stream raw documents, so `AdminUser.id` was
 * `undefined` for every row in the UI. The explicit select keeps
 * `passwordHash` (already `select: false` on the schema) off the wire.
 */
const adminUserView = (user: {
  _id: string; name: string; email: string; role: string;
  hospitalId?: string | null; ambulanceId?: string | null; organizationId?: string | null;
  active?: boolean; emailVerified?: boolean;
}) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  hospitalId: user.hospitalId ?? null,
  ambulanceId: user.ambulanceId ?? null,
  organizationId: user.organizationId ?? null,
  active: user.active ?? true,
  // Absent on rows written before verification existed; those accounts predate
  // the requirement, so they read as verified rather than nagging admins.
  emailVerified: user.emailVerified ?? true,
});

adminRouter.get('/users', authenticate, requirePermission(P.USER_READ), asyncHandler(async (_req, res) => {
  const users = await User.find({}, { passwordHash: 0 }).sort({ _id: 1 }).lean();
  res.json(users.map(adminUserView));
}));

adminRouter.post('/users', authenticate, requirePermission(P.USER_CREATE), validateBody(userCreateSchema), asyncHandler(async (req, res) => {
  if (await User.exists({ email: req.body.email })) throw ApiError.conflict('An account with this email already exists');
  const user = await User.create({ _id: await nextId('user', 'USR', 3), ...req.body, passwordHash: await hashPassword(req.body.password), active: true, emailVerified: true, emailVerifiedAt: new Date() });
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'user.created', resource: 'User', resourceId: user._id, requestId: req.requestId, newState: { id: user._id, role: user.role }, ip: req.ip });
  res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role, hospitalId: user.hospitalId, ambulanceId: user.ambulanceId, active: user.active, emailVerified: true });
}));

adminRouter.patch('/users/:id', authenticate, requirePermission(P.USER_UPDATE), validateBody(userUpdateSchema), asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!/^USR-\d{1,10}$/.test(id)) throw ApiError.badRequest('Malformed user id');
  const fields = Object.keys(req.body);
  if (fields.includes('role') && !req.auth!.permissions.includes(P.USER_ASSIGN_ROLE)) throw ApiError.forbidden('You may not change roles');
  if (fields.includes('active') && req.body.active === false && !req.auth!.permissions.includes(P.USER_DEACTIVATE)) throw ApiError.forbidden('You may not deactivate users');
  if (!fields.length) throw ApiError.badRequest('No user fields supplied');
  if (id === req.auth!.userId && req.body.active === false) throw ApiError.badRequest('You cannot deactivate your own account');
  const previous = await User.findById(id).lean();
  if (!previous) throw ApiError.notFound(`User ${id} not found`);
  const user = await User.findByIdAndUpdate(id, { $set: req.body }, { new: true, runValidators: true });
  if (!user) throw ApiError.notFound(`User ${id} not found`);
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'user.updated', resource: 'User', resourceId: id, requestId: req.requestId, previousState: { role: previous.role, active: previous.active }, newState: { role: user.role, active: user.active }, ip: req.ip });
  res.json({ id: user._id, name: user.name, email: user.email, role: user.role, hospitalId: user.hospitalId, ambulanceId: user.ambulanceId, organizationId: user.organizationId, active: user.active });
}));
