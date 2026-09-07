import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Eye, AlertTriangle, CheckCircle, XCircle, Camera, Clock } from 'lucide-react';
import type { AIDetection, DetectionStatus } from '../types';

const statusVariant = (s: DetectionStatus) => {
  const map: Record<DetectionStatus, 'warning' | 'success' | 'destructive' | 'info'> = {
    PENDING_REVIEW: 'warning',
    CONFIRMED: 'success',
    REJECTED: 'destructive',
    CONVERTED_TO_INCIDENT: 'info',
  };
  return map[s];
};

export function AIVisionPage() {
  const { data: detections, isLoading } = useQuery({
    queryKey: ['detections'],
    queryFn: api.vision.detections,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Eye size={24} className="text-[var(--primary)]" />
            AI Vision Workspace
          </h2>
          <p className="text-sm text-[var(--muted-foreground)]">CCTV-powered accident detection and monitoring</p>
        </div>
        <Badge variant="outline" className="gap-1">
          <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
          AI MODEL: RapidVision V3.2.1
        </Badge>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle size={14} />
          AI Detection Safety Protocol
        </p>
        <p className="text-xs text-[var(--muted-foreground)] mt-1">
          AI detections are candidates requiring human review. They do NOT automatically create emergencies.
          All detections must be reviewed and validated before incident creation.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {(detections || []).map((det: AIDetection) => (
          <Card key={det.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Camera size={14} />
                  {det.cameraId}
                </CardTitle>
                <Badge variant={statusVariant(det.status)}>
                  {det.status.replace(/_/g, ' ')}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Simulated detection visualization */}
              <div className="relative h-40 rounded-lg bg-[var(--muted)] overflow-hidden border border-[var(--border)]">
                <div className="absolute inset-0 flex items-center justify-center text-[var(--muted-foreground)]">
                  <Camera size={32} className="opacity-30" />
                </div>
                {det.boundingBoxes.map((box, i) => (
                  <div
                    key={i}
                    className="absolute border-2 border-red-500 bg-red-500/10"
                    style={{
                      left: `${(box.x / 640) * 100}%`,
                      top: `${(box.y / 480) * 100}%`,
                      width: `${(box.width / 640) * 100}%`,
                      height: `${(box.height / 480) * 100}%`,
                    }}
                  >
                    <span className="absolute -top-4 left-0 text-[9px] bg-red-500 text-white px-1 rounded">
                      {box.label} {box.confidence.toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">Detected Event</span>
                  <span className="font-medium">{det.detectedEvent.replace(/_/g, ' ')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">Confidence</span>
                  <span className="font-mono font-bold">{det.confidence}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">Location</span>
                  <span className="text-right max-w-[60%] truncate">{det.cameraLocation.address}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--muted-foreground)]">Timestamp</span>
                  <span>{new Date(det.timestamp).toLocaleString()}</span>
                </div>
              </div>

              {det.status === 'PENDING_REVIEW' && (
                <div className="flex gap-2 pt-2 border-t border-[var(--border)]">
                  <Button size="sm" variant="outline" className="flex-1">
                    <Eye size={12} className="mr-1" /> Review
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1">
                    <XCircle size={12} className="mr-1" /> Reject
                  </Button>
                  <Button size="sm" className="flex-1">
                    <CheckCircle size={12} className="mr-1" /> Create Incident
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
