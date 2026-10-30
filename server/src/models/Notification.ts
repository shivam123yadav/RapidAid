import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { NOTIFICATION_CATEGORIES } from '../validation/constants.js';

const deliveryStatusSchema = new Schema(
  {
    inApp: { type: String, enum: ['DELIVERED', 'FAILED'], default: 'DELIVERED' },
    email: { type: String, enum: ['DELIVERED', 'MOCK_DELIVERED', 'FAILED', 'SKIPPED'], default: 'SKIPPED' },
    sms: { type: String, enum: ['DELIVERED', 'MOCK_DELIVERED', 'FAILED', 'SKIPPED'], default: 'SKIPPED' },
    push: { type: String, enum: ['DELIVERED', 'MOCK_DELIVERED', 'FAILED', 'SKIPPED'], default: 'SKIPPED' },
  },
  { _id: false },
);

const notificationSchema = new Schema(
  {
    _id: { type: String, required: true }, // N001
    category: { type: String, enum: NOTIFICATION_CATEGORIES, required: true, default: 'INFO' },
    eventType: { type: String, required: true, default: 'GENERAL', index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    createdAt: { type: Date, default: Date.now },
    read: { type: Boolean, required: true, default: false, index: true },
    readAt: { type: Date },
    ownerId: { type: String, index: true }, // recipient user ID
    recipientRole: { type: String, index: true },
    audienceRoles: { type: [String], default: [] },
    hospitalId: { type: String, index: true },
    linkedEmergency: { type: String, index: true },
    linkedResource: { type: String },
    idempotencyKey: { type: String, unique: true, sparse: true, index: true },
    channels: { type: [String], default: ['inApp'] },
    deliveryStatus: {
      type: deliveryStatusSchema,
      default: () => ({ inApp: 'DELIVERED', email: 'SKIPPED', sms: 'SKIPPED', push: 'SKIPPED' }),
    },
    metadata: { type: Schema.Types.Mixed },
  },
  baseSchemaOptions,
);

notificationSchema.index({ ownerId: 1, timestamp: -1 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema>;
export const Notification: Model<NotificationDoc> = model<NotificationDoc>('Notification', notificationSchema);
