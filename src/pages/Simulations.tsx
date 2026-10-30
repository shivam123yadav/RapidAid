import { Link } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { PageHeader } from '../components/ui/page-header';
import { StatCard } from '../components/ui/stat-card';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  FlaskConical,
  Globe2,
  ShieldCheck,
  TrafficCone,
  Truck,
} from 'lucide-react';

const SCENARIOS = [
  {
    title: 'Mass casualty event',
    description: 'Model a multi-location incident with a high victim count and constrained transport capacity.',
    tags: ['High volume', 'Multi-location'],
    icon: Globe2,
    status: 'Scenario template',
  },
  {
    title: 'Fleet capacity stress test',
    description: 'Explore how the available fleet behaves under simultaneous peak demand.',
    tags: ['Fleet analysis', 'Peak load'],
    icon: Truck,
    status: 'Scenario template',
  },
  {
    title: 'Hospital overflow',
    description: 'Model capacity pressure and patient redistribution across the hospital network.',
    tags: ['Capacity', 'Redistribution'],
    icon: Building2,
    status: 'Scenario template',
  },
];

export function SimulationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Planning / simulation"
        title="Simulations"
        description="Modeled scenarios for planning and training. Simulated results never change a real incident, vehicle, hospital or traffic signal."
        icon={<FlaskConical size={21} />}
        status={<Badge variant="outline" className="gap-1.5"><ShieldCheck size={11} /> Isolated environment</Badge>}
        actions={
          <Link to="/green-corridor">
            <Button variant="outline">
              <TrafficCone size={15} />
              Green Corridor simulator
              <ArrowRight size={14} />
            </Button>
          </Link>
        }
      />

      <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warning)]/35 bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] p-3.5">
        <AlertTriangle size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
        <div>
          <p className="text-xs font-semibold text-[var(--warning)]">Simulation environment</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">
            Every scenario on this page is a planning model. No real-world systems are affected, and no
            modeled figure is presented as an actual incident outcome.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Scenario templates" value={SCENARIOS.length} icon={<FlaskConical size={17} />} tone="info" hint="Planning models on this page" />
        <StatCard label="Executable now" value={1} icon={<TrafficCone size={17} />} tone="success" hint="Green Corridor route simulation" />
        <StatCard label="Operational side effects" value={0} icon={<ShieldCheck size={17} />} tone="neutral" hint="No real systems are touched" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {SCENARIOS.map(({ title, description, tags, icon: Icon, status }) => (
          <Card key={title} className="flex flex-col">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] text-[var(--primary)]">
                  <Icon size={16} />
                </div>
                <Badge variant="outline" className="text-[9px]">{status}</Badge>
              </div>
              <CardTitle className="mt-2 text-sm">{title}</CardTitle>
              <CardDescription className="text-[11px] leading-relaxed">{description}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                    {tag}
                  </span>
                ))}
              </div>
              <p className="border-t border-[var(--border)] pt-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                No run endpoint is exposed for this template, so it is presented as reference material
                rather than an actionable control.
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-[color-mix(in_srgb,var(--success)_28%,var(--border))]">
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--success)_30%,var(--border))] bg-[color-mix(in_srgb,var(--success)_9%,transparent)] text-[var(--success)]">
              <TrafficCone size={18} />
            </div>
            <div>
              <p className="text-sm font-semibold">Green Corridor route simulation</p>
              <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-[var(--muted-foreground)]">
                The one simulation backed by a real endpoint. It models signal coordination for an active
                incident and never controls actual traffic infrastructure.
              </p>
            </div>
          </div>
          <Link to="/green-corridor" className="flex-none">
            <Button variant="outline" size="sm">
              Open simulator
              <ArrowRight size={13} />
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
