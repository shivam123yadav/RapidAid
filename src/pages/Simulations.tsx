import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Globe, AlertTriangle, FlaskConical } from 'lucide-react';

export function SimulationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <FlaskConical size={24} className="text-[var(--primary)]" />
          Simulations
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">Emergency response scenario modeling and what-if analysis</p>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
          <AlertTriangle size={14} />
          SIMULATION ENVIRONMENT
        </p>
        <p className="text-xs text-[var(--muted-foreground)] mt-1">
          All simulations are modeled scenarios. No real-world systems are affected.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="hover:shadow-md transition-shadow cursor-pointer">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Globe size={14} />
              Mass Casualty Event
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-[var(--muted-foreground)] text-xs">Simulate response to a mass casualty incident with 20+ victims across multiple locations.</p>
            <div className="flex gap-2 pt-2">
              <Badge variant="outline" className="text-[10px]">20+ Victims</Badge>
              <Badge variant="outline" className="text-[10px]">Multi-location</Badge>
            </div>
            <Badge variant="info" className="text-[10px] mt-2">Ready to Run</Badge>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow cursor-pointer">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Globe size={14} />
              Fleet Capacity Stress Test
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-[var(--muted-foreground)] text-xs">Test ambulance fleet capacity under peak demand scenarios with simultaneous emergencies.</p>
            <div className="flex gap-2 pt-2">
              <Badge variant="outline" className="text-[10px]">Fleet Analysis</Badge>
              <Badge variant="outline" className="text-[10px]">Peak Load</Badge>
            </div>
            <Badge variant="info" className="text-[10px] mt-2">Ready to Run</Badge>
          </CardContent>
        </Card>

        <Card className="hover:shadow-md transition-shadow cursor-pointer">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Globe size={14} />
              Hospital Overflow Scenario
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-[var(--muted-foreground)] text-xs">Model hospital capacity overflow and patient redistribution across the network.</p>
            <div className="flex gap-2 pt-2">
              <Badge variant="outline" className="text-[10px]">Capacity</Badge>
              <Badge variant="outline" className="text-[10px]">Redistribution</Badge>
            </div>
            <Badge variant="info" className="text-[10px] mt-2">Ready to Run</Badge>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
