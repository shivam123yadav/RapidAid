import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { TrafficCone, Clock, Zap, AlertTriangle, Play, MapPin } from 'lucide-react';
import { mockGreenCorridor } from '../mocks/data';
import { formatTime } from '../lib/utils';

export function GreenCorridorPage() {
  const [simulating, setSimulating] = useState(false);
  const [simComplete, setSimComplete] = useState(true);
  const sim = mockGreenCorridor;

  const handleSimulate = () => {
    setSimulating(true);
    setSimComplete(false);
    setTimeout(() => {
      setSimulating(false);
      setSimComplete(true);
    }, 3000);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <TrafficCone size={24} className="text-[var(--primary)]" />
            Green Corridor Simulation
          </h2>
          <p className="text-sm text-[var(--muted-foreground)]">Simulate optimized emergency routes with traffic signal coordination</p>
        </div>
        <Button onClick={handleSimulate} disabled={simulating}>
          <Play size={14} className="mr-1" />
          {simulating ? 'Simulating...' : 'Run Simulation'}
        </Button>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle size={14} />
          SIMULATION — NO REAL TRAFFIC SIGNAL CONTROL
        </p>
        <p className="text-xs text-[var(--muted-foreground)] mt-1">
          This is a simulation environment. No actual traffic signals are being controlled.
          Results are modeled estimates for planning purposes only.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Route Visualization */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <MapPin size={14} />
              Route: AMB-017 → AIIMS Trauma Center
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative h-64 rounded-lg bg-[var(--muted)] border border-[var(--border)] overflow-hidden">
              {/* Simulated route visualization */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative w-full h-full p-8">
                  {/* Route line */}
                  <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 200">
                    <path
                      d="M 50 150 Q 100 100 150 120 Q 200 140 250 100 Q 300 60 350 50"
                      fill="none"
                      stroke={simComplete ? 'var(--success)' : simulating ? 'var(--warning)' : 'var(--muted-foreground)'}
                      strokeWidth="3"
                      strokeDasharray={simulating ? '8 4' : 'none'}
                      className={simulating ? 'animate-pulse' : ''}
                    />
                    {/* Signal points */}
                    {[80, 130, 180, 230, 280, 320].map((x, i) => (
                      <circle
                        key={i}
                        cx={x}
                        cy={150 - (i * 15) + Math.sin(i) * 20}
                        r="6"
                        fill={simComplete ? 'var(--success)' : 'var(--warning)'}
                        opacity={simComplete ? 1 : 0.5}
                      />
                    ))}
                    {/* Start marker */}
                    <circle cx="50" cy="150" r="8" fill="var(--primary)" />
                    <text x="50" y="175" textAnchor="middle" className="fill-[var(--muted-foreground)]" fontSize="10">AMB-017</text>
                    {/* End marker */}
                    <circle cx="350" cy="50" r="8" fill="var(--success)" />
                    <text x="350" y="35" textAnchor="middle" className="fill-[var(--muted-foreground)]" fontSize="10">Hospital</text>
                  </svg>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Simulation Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {simulating ? (
              <div className="space-y-3">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : simComplete ? (
              <>
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <p className="text-xs text-[var(--muted-foreground)]">Baseline ETA</p>
                  <p className="text-xl font-mono font-bold">{formatTime(sim.baselineETA)}</p>
                </div>
                <div className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/5 p-3">
                  <p className="text-xs text-[var(--muted-foreground)]">Simulated ETA</p>
                  <p className="text-xl font-mono font-bold text-[var(--success)]">{formatTime(sim.simulatedETA)}</p>
                </div>
                <div className="rounded-lg border border-[var(--primary)]/30 bg-[var(--primary)]/5 p-3">
                  <p className="text-xs text-[var(--muted-foreground)]">Time Saved</p>
                  <p className="text-xl font-mono font-bold text-[var(--primary)]">{formatTime(sim.timeSaved)}</p>
                </div>
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <p className="text-xs text-[var(--muted-foreground)]">Signals Affected</p>
                  <p className="text-xl font-mono font-bold">{sim.signalsAffected}</p>
                </div>
                <div className="pt-2 border-t border-[var(--border)]">
                  <div className="flex items-center gap-2 text-sm">
                    <Zap size={14} className="text-[var(--success)]" />
                    <span>
                      {Math.round((sim.timeSaved / sim.baselineETA) * 100)}% improvement
                    </span>
                  </div>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
