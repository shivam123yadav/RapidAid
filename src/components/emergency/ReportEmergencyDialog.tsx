import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ImagePlus, Loader2, MapPin, Siren, X } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { cn } from '../../lib/utils';
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  formatBytes,
  stageImageAttachments,
  toAttachmentPayload,
} from '../../lib/imageAttachments';
import type { StagedAttachment } from '../../lib/imageAttachments';
import type {
  CreateEmergencyRequest,
  Emergency,
  EmergencyPriority,
  EmergencySource,
  IncidentType,
  UserRole,
} from '../../types';

/**
 * Runtime option lists mirroring server/src/validation/constants.ts. They only
 * drive the UI — the server re-validates every field with zod and rejects
 * anything that drifts, so the client can never bypass the contract.
 */
const INCIDENT_TYPES = [
  'VEHICLE_COLLISION',
  'MEDICAL_EMERGENCY',
  'FALL_INJURY',
  'CARDIAC_ARREST',
  'STROKE',
  'RESPIRATORY_DISTRESS',
  'SEIZURE',
  'POISONING',
  'BURN',
  'DROWNING',
  'ELECTROCUTION',
  'OBSTETRIC_EMERGENCY',
  'ASSAULT',
  'FIRE',
  'EXPLOSION',
  'GAS_LEAK',
  'STRUCTURAL_COLLAPSE',
  'MASS_CASUALTY',
  'OTHER',
] as const;

const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  VEHICLE_COLLISION: 'Vehicle Collision',
  MEDICAL_EMERGENCY: 'Medical Emergency',
  FALL_INJURY: 'Fall Injury',
  CARDIAC_ARREST: 'Cardiac Arrest',
  STROKE: 'Stroke',
  RESPIRATORY_DISTRESS: 'Respiratory Distress',
  SEIZURE: 'Seizure',
  POISONING: 'Poisoning / Overdose',
  BURN: 'Burn',
  DROWNING: 'Drowning',
  ELECTROCUTION: 'Electrocution',
  OBSTETRIC_EMERGENCY: 'Obstetric Emergency',
  ASSAULT: 'Assault / Violence',
  FIRE: 'Fire',
  EXPLOSION: 'Explosion',
  GAS_LEAK: 'Gas Leak',
  STRUCTURAL_COLLAPSE: 'Structural Collapse',
  MASS_CASUALTY: 'Mass Casualty Incident',
  OTHER: 'Other',
};

const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

const PRIORITY_LABELS: Record<EmergencyPriority, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/** Only operator-facing sources make sense for a manual console report. */
const SOURCES = ['CITIZEN_REPORT', 'DISPATCHER'] as const;

const SOURCE_LABELS: Record<EmergencySource, string> = {
  CITIZEN_REPORT: 'Citizen Report',
  DISPATCHER: 'Dispatcher Entry',
  AI_VISION: 'AI Vision',
  VOICE_REPORT: 'Voice Report',
};

/** Sources a human can pick here (AI/voice reports arrive through their own flows). */
type ReportSource = (typeof SOURCES)[number];

/** Field rules mirror createEmergencySchema on the server. Exported so the
 *  client contract can be exercised directly (server re-validates anyway). */
export const reportEmergencySchema = z.object({
  incidentType: z.enum(INCIDENT_TYPES),
  priority: z.enum(PRIORITIES),
  description: z
    .string()
    .trim()
    .min(5, 'Description must be at least 5 characters')
    .max(2000, 'Description must be 2000 characters or fewer'),
  victimCount: z
    .number({ message: 'Enter the number of victims' })
    .int('Victims must be a whole number')
    .min(0, 'Victims cannot be negative')
    .max(999, 'Victims must be 999 or fewer'),
  address: z.string().trim().max(300, 'Address must be 300 characters or fewer'),
  lat: z
    .number({ message: 'Latitude is required' })
    .min(-90, 'Latitude must be between -90 and 90')
    .max(90, 'Latitude must be between -90 and 90'),
  lng: z
    .number({ message: 'Longitude is required' })
    .min(-180, 'Longitude must be between -180 and 180')
    .max(180, 'Longitude must be between -180 and 180'),
  source: z.enum(SOURCES),
});

export type ReportFormData = z.infer<typeof reportEmergencySchema>;

/** Console operators report as DISPATCHER; field/citizen roles as citizens. */
function defaultSource(role?: UserRole): ReportSource {
  return role && role !== 'CITIZEN' && role !== 'AMBULANCE_CREW' && role !== 'HOSPITAL_STAFF'
    ? 'DISPATCHER'
    : 'CITIZEN_REPORT';
}

/** New Delhi city centre — same reference point as the seeded incidents. */
function buildDefaults(role?: UserRole): ReportFormData {
  return {
    incidentType: 'MEDICAL_EMERGENCY',
    priority: 'MEDIUM',
    description: '',
    victimCount: 1,
    address: '',
    lat: 28.6139,
    lng: 77.209,
    source: defaultSource(role),
  };
}

function toPayload(
  values: ReportFormData,
  attachments: StagedAttachment[],
): CreateEmergencyRequest {
  const address = values.address.trim();
  return {
    incidentType: values.incidentType,
    priority: values.priority,
    source: values.source,
    description: values.description,
    victimCount: values.victimCount,
    location: {
      lat: values.lat,
      lng: values.lng,
      ...(address ? { address } : {}),
    },
    // Photos travel as base64 data URLs alongside the report fields.
    attachments: toAttachmentPayload(attachments),
  };
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

export interface ReportEmergencyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created incident so the page can confirm and refresh. */
  onCreated?: (emergency: Emergency) => void;
}

/**
 * Report-emergency form wired to POST /api/emergencies. Creations always start
 * at REPORTED server-side; the timeline entry is written by the API, not here.
 */
export function ReportEmergencyDialog({ open, onOpenChange, onCreated }: ReportEmergencyDialogProps) {
  const queryClient = useQueryClient();
  const role = useAuthStore((state) => state.user?.role);
  const [submitError, setSubmitError] = useState<{ message: string; requestId?: string } | null>(null);
  // Photos staged in the dialog (data URLs) until the report is posted.
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
  const [readingPhotos, setReadingPhotos] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Stable idempotency key for this logical submission attempt; reused on retries
  const idempotencyKeyRef = useRef<string>(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `idemp-${Date.now()}`);

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((photo) => photo.id !== id));
  };

  const handleFilesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    // Clear the input right away so re-picking the same file still fires change.
    event.target.value = '';
    if (!files || files.length === 0) return;

    setReadingPhotos(true);
    try {
      const { accepted, rejected } = await stageImageAttachments(files, attachments);
      if (accepted.length > 0) {
        setAttachments((current) => [...current, ...accepted]);
      }
      setAttachmentErrors(rejected);
    } finally {
      setReadingPhotos(false);
    }
  };

  const clearAttachments = () => {
    setAttachments([]);
    setAttachmentErrors([]);
  };

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ReportFormData>({
    resolver: zodResolver(reportEmergencySchema),
    defaultValues: buildDefaults(role),
  });

  const mutation = useMutation({
    mutationFn: (values: ReportFormData) =>
      api.emergencies.create(toPayload(values, attachments), idempotencyKeyRef.current),
    onMutate: () => setSubmitError(null),
    onSuccess: (created) => {
      // Newest-first list, the bell badge and analytics all move together.
      queryClient.setQueryData(['emergency', created.id], created);
      void queryClient.invalidateQueries({ queryKey: ['emergencies'] });
      void queryClient.invalidateQueries({ queryKey: ['emergency', created.id] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
      reset(buildDefaults(role));
      clearAttachments();
      idempotencyKeyRef.current = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `idemp-${Date.now()}`;
      onOpenChange(false);
      onCreated?.(created);
    },
    onError: (err) =>
      setSubmitError(
        err instanceof ApiError
          ? { message: err.message, requestId: err.requestId }
          : { message: 'Could not report the emergency. Please try again.' },
      ),
  });

  // Every open starts from a clean draft (never a half-filled previous report).
  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    idempotencyKeyRef.current = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `idemp-${Date.now()}`;
    reset(buildDefaults(role));
    clearAttachments();
    // Only the dialog opening (and the signed-in role) should reset the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Siren size={18} className="text-[var(--destructive)]" />
            Report Emergency
          </DialogTitle>
          <DialogDescription>
            The incident is created as <span className="font-medium">REPORTED</span> and dispatch is notified.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit((values) => mutation.mutate(values))} className="space-y-4" noValidate>
          {submitError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="space-y-0.5">
                <p className="text-sm text-destructive">{submitError.message}</p>
                {submitError.requestId && (
                  <p className="font-mono text-[10px] text-[var(--muted-foreground)]">
                    Reference: {submitError.requestId}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="incidentType">Incident type</Label>
              <Select
                value={watch('incidentType')}
                onValueChange={(value: string) =>
                  setValue('incidentType', value as IncidentType, { shouldValidate: true })
                }
              >
                <SelectTrigger id="incidentType">
                  <SelectValue placeholder="Select incident type" />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {INCIDENT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.incidentType?.message} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Select
                value={watch('priority')}
                onValueChange={(value: string) =>
                  setValue('priority', value as EmergencyPriority, { shouldValidate: true })
                }
              >
                <SelectTrigger id="priority">
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {PRIORITY_LABELS[priority]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.priority?.message} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="victimCount">Victims</Label>
              <Input
                id="victimCount"
                type="number"
                min={0}
                max={999}
                step={1}
                inputMode="numeric"
                className={cn(errors.victimCount && 'border-destructive')}
                aria-invalid={!!errors.victimCount}
                {...register('victimCount', { valueAsNumber: true })}
              />
              <FieldError message={errors.victimCount?.message} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="source">Source</Label>
              <Select
                value={watch('source')}
                onValueChange={(value: string) =>
                  setValue('source', value as ReportSource, { shouldValidate: true })
                }
              >
                <SelectTrigger id="source">
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  {SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {SOURCE_LABELS[source]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.source?.message} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Location</Label>
            <Input
              id="address"
              placeholder="e.g. Connaught Place, New Delhi"
              className={cn(errors.address && 'border-destructive')}
              aria-invalid={!!errors.address}
              {...register('address')}
            />
            <FieldError message={errors.address?.message} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="lat">Latitude</Label>
              <Input
                id="lat"
                type="number"
                step="0.0001"
                className={cn('font-mono', errors.lat && 'border-destructive')}
                aria-invalid={!!errors.lat}
                {...register('lat', { valueAsNumber: true })}
              />
              <FieldError message={errors.lat?.message} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lng">Longitude</Label>
              <Input
                id="lng"
                type="number"
                step="0.0001"
                className={cn('font-mono', errors.lng && 'border-destructive')}
                aria-invalid={!!errors.lng}
                {...register('lng', { valueAsNumber: true })}
              />
              <FieldError message={errors.lng?.message} />
            </div>
          </div>

          <p className="flex items-start gap-1.5 text-xs text-[var(--muted-foreground)]">
            <MapPin size={12} className="mt-0.5 flex-shrink-0" />
            Coordinates drive dispatch scoring (nearest suitable ambulance + hospital), so keep them close to the scene.
          </p>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              rows={4}
              placeholder="What happened, how many people are hurt, anything the crew should know…"
              className={cn(errors.description && 'border-destructive')}
              aria-invalid={!!errors.description}
              {...register('description')}
            />
            <FieldError message={errors.description?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="emergencyPhotos">
              Photos
              <span className="ml-1 font-normal text-[var(--muted-foreground)]">(optional)</span>
            </Label>

            <input
              ref={fileInputRef}
              id="emergencyPhotos"
              type="file"
              accept={ATTACHMENT_ACCEPT}
              multiple
              className="sr-only"
              onChange={(event) => void handleFilesSelected(event)}
            />

            {attachments.length < MAX_ATTACHMENTS && (
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={readingPhotos || mutation.isPending}
                className="w-full border-dashed"
              >
                {readingPhotos ? (
                  <>
                    <Loader2 size={14} className="mr-1 animate-spin" />
                    Reading photos…
                  </>
                ) : (
                  <>
                    <ImagePlus size={14} className="mr-1" />
                    Add photos
                  </>
                )}
              </Button>
            )}

            <p className="text-xs text-[var(--muted-foreground)]">
              Up to {MAX_ATTACHMENTS} images (PNG, JPEG, WebP or GIF), 2 MB each. Photos are sent with the
              report so dispatch can see the scene.
            </p>

            {attachments.length > 0 && (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {attachments.map((photo) => (
                  <li
                    key={photo.id}
                    className="group relative overflow-hidden rounded-lg border border-[var(--border)]"
                  >
                    <img
                      src={photo.dataUrl}
                      alt={photo.name}
                      className="h-24 w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(photo.id)}
                      disabled={mutation.isPending}
                      aria-label={`Remove ${photo.name}`}
                      className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white transition hover:bg-destructive"
                    >
                      <X size={12} />
                    </button>
                    <p className="truncate px-1.5 py-1 text-[10px] text-[var(--muted-foreground)]">
                      {formatBytes(photo.size)}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {attachmentErrors.length > 0 && (
              <ul className="space-y-1">
                {attachmentErrors.map((error) => (
                  <li key={error} className="flex items-start gap-1.5 text-xs text-destructive">
                    <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                    {error}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending || readingPhotos}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="emergency"
              disabled={mutation.isPending || readingPhotos}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 size={14} className="mr-1 animate-spin" />
                  Reporting…
                </>
              ) : (
                <>
                  <Siren size={14} className="mr-1" />
                  Report Emergency
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}




