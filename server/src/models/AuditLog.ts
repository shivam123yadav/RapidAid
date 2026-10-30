import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { ROLES } from '../validation/constants.js';

const auditLogSchema = new Schema(
  {
    _id: { type: String, required: true }, // A001
    actor: { type: String, required: true },
    actorId: { type: String, index: true },
    actorRole: { type: String, enum: ROLES, required: true },
    action: { type: String, required: true, index: true },
    resource: { type: String, required: true },
    resourceId: { type: String, required: true },
    timestamp: { type: Date, required: true, index: true },
    requestId: { type: String, required: true },
    details: { type: String },
    previousState: { type: Schema.Types.Mixed },
    newState: { type: Schema.Types.Mixed },
    reason: { type: String, maxlength: 1000 },
    userAgent: { type: String, maxlength: 500 },
    /**
     * Outcome of the attempt. Defaults to SUCCESS because the overwhelming
     * majority of entries are successful actions; denials and other failures
     * must state it explicitly.
     */
    result: { type: String, enum: ['SUCCESS', 'FAILURE'], default: 'SUCCESS' },
    /** Actor's IP at the time of the action, when the request carried one. */
    ip: { type: String },
  },
  baseSchemaOptions,
);

auditLogSchema.index({ timestamp: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLog: Model<AuditLogDoc> = model<AuditLogDoc>('AuditLog', auditLogSchema);
