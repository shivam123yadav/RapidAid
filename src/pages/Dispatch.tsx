import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Radio, Truck, Clock, MapPin, Zap, CheckCircle } from 'lucide-react';
import type { DispatchRecommendation, HospitalRecommendation } from '../types';

export function DispatchPage() {
  const { data: recommendations, isLoading } = useQuery({
    queryKey: ['dispatch-recommendations'],
    queryFn: () => api.dispatch.getRecommendations('EMG-20481'),
  });

  const { data: hospitalRecs, isLoading: loadingHospitals } = useQuery({
    queryKey: ['hospital-recommendations'],
    queryFn: () => api.dispatch.getHospitalRecommendations('EMG-20481'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Radio size={24} className="text-[var(--primary)]" />
          Dispatch Intelligence
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">AI-powered ambulance and hospital recommendations for EMG-20481</p>
      </div>

      <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
        <p className="text-xs text-[var(--muted-foreground)]">
          <strong>Note:</strong> Recommendations are AI-generated suggestions. The dispatcher must review and explicitly assign.
          Recommendation ≠ Assignment.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ambulance Recommendations */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Truck size={16} />
              Ambulance Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)
            ) : (
              (recommendations || []).map((rec: DispatchRecommendation, i: number) => (
                <div key={rec.ambulanceId} className={`rounded-lg border p-3 ${i === 0 ? 'border-[var(--primary)] bg-[var(--primary)]/5' : 'border-[var(--border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold">{rec.ambulanceId}</span>
                      {i === 0 && <Badge variant="default" className="text-xs">RECOMMENDED</Badge>}
                    </div>
                    <span className="text-lg font-bold text-[var(--primary)]">{rec.score}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                    <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
                      <Clock size={10} /> ETA: {Math.floor(rec.eta / 60)}:{(rec.eta % 60).toString().padStart(2, '0')}
                    </span>
                    <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
                      <MapPin size={10} /> {(rec.distance / 1000).toFixed(1)} km
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {rec.capabilities.map(cap => (
                      <span key={cap} className="text-[10px] bg-[var(--success)]/10 text-[var(--success)] px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                        <CheckCircle size={8} /> {cap}
                      </span>
                    ))}
                  </div>
                  <div className="border-t border-[var(--border)] pt-2">
                    <p className="text-[10px] text-[var(--muted-foreground)] mb-1">Why this recommendation:</p>
                    <ul className="space-y-0.5">
                      {rec.reasons.map((r, j) => (
                        <li key={j} className="text-xs text-[var(--muted-foreground)]">• {r}</li>
                      ))}
                    </ul>
                  </div>
                  {i === 0 && (
                    <Button size="sm" className="w-full mt-2">
                      <Zap size={12} className="mr-1" /> Assign {rec.ambulanceId}
                    </Button>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Hospital Recommendations */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <MapPin size={16} />
              Hospital Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingHospitals ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)
            ) : (
              (hospitalRecs || []).map((rec: HospitalRecommendation, i: number) => (
                <div key={rec.hospitalId} className={`rounded-lg border p-3 ${i === 0 ? 'border-[var(--primary)] bg-[var(--primary)]/5' : 'border-[var(--border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold">{rec.hospitalId}</span>
                      {i === 0 && <Badge variant="default" className="text-xs">RECOMMENDED</Badge>}
                    </div>
                    <span className="text-lg font-bold text-[var(--primary)]">{rec.score}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                    <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
                      <Clock size={10} /> ETA: {Math.floor(rec.eta / 60)}:{(rec.eta % 60).toString().padStart(2, '0')}
                    </span>
                    <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
                      <MapPin size={10} /> {(rec.distance / 1000).toFixed(1)} km
                    </span>
                  </div>
                  <div className="flex gap-2 mb-2">
                    <Badge variant={rec.traumaAvailable ? 'success' : 'destructive'} className="text-[10px]">
                      Trauma: {rec.traumaAvailable ? 'YES' : 'NO'}
                    </Badge>
                    <Badge variant={rec.emergencyCapacity === 'AVAILABLE' ? 'success' : 'warning'} className="text-[10px]">
                      ED: {rec.emergencyCapacity}
                    </Badge>
                    <Badge variant={rec.icuCapacity === 'AVAILABLE' ? 'success' : 'warning'} className="text-[10px]">
                      ICU: {rec.icuCapacity}
                    </Badge>
                  </div>
                  <div className="border-t border-[var(--border)] pt-2">
                    <p className="text-[10px] text-[var(--muted-foreground)] mb-1">Why this recommendation:</p>
                    <ul className="space-y-0.5">
                      {rec.reasons.map((r, j) => (
                        <li key={j} className="text-xs text-[var(--muted-foreground)]">• {r}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
