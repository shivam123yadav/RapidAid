import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { useTheme } from '../stores/theme';
import { cn } from '../lib/utils';
import {
  Heart, Siren, Eye, Truck, Building2, Brain, MapPin,
  Shield, Clock, Zap, Activity, Radio, Mic, BarChart3,
  ArrowRight, CheckCircle2, Globe, TrafficCone, Sun, Moon, Monitor
} from 'lucide-react';

export function LandingPage() {
  const { mode, setMode } = useTheme();

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--border)] bg-[var(--background)]/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)]">
              <Heart size={18} className="text-white" />
            </div>
            <span className="text-xl font-bold">RapidAid</span>
          </div>
          <div className="hidden md:flex items-center gap-6 text-sm">
            <a href="#features" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">Features</a>
            <a href="#how-it-works" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">How It Works</a>
            <a href="#intelligence" className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">Intelligence</a>
          </div>
          <div className="flex items-center gap-3">
            {/* Theme Toggle */}
            <div className="flex items-center gap-1 border border-[var(--border)] rounded-lg p-1">
              <button
                onClick={() => setMode('light')}
                className={cn(
                  'rounded-md p-1.5 transition-colors',
                  mode === 'light' ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                )}
                title="Light Mode"
              >
                <Sun size={14} />
              </button>
              <button
                onClick={() => setMode('dark')}
                className={cn(
                  'rounded-md p-1.5 transition-colors',
                  mode === 'dark' ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                )}
                title="Dark Mode"
              >
                <Moon size={14} />
              </button>
              <button
                onClick={() => setMode('system')}
                className={cn(
                  'rounded-md p-1.5 transition-colors',
                  mode === 'system' ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                )}
                title="System Theme"
              >
                <Monitor size={14} />
              </button>
            </div>
            <Link to="/command-center">
              <Button variant="outline" size="sm">Command Center</Button>
            </Link>
            <Link to="/command-center">
              <Button size="sm">
                <Siren size={14} className="mr-1" />
                Report Emergency
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-32 pb-20 px-6 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[var(--primary)]/5 to-transparent" />
        <div className="absolute top-20 left-1/4 w-96 h-96 bg-[var(--primary)]/5 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-[var(--info)]/5 rounded-full blur-3xl" />
        
        <div className="relative max-w-7xl mx-auto text-center">
          <Badge variant="outline" className="mb-6 gap-1.5">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            AI-Powered Emergency Response
          </Badge>
          
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
            <span className="bg-gradient-to-r from-[var(--primary)] to-[var(--info)] bg-clip-text text-transparent">
              RapidAid
            </span>
          </h1>
          
          <p className="text-xl md:text-2xl text-[var(--muted-foreground)] max-w-3xl mx-auto mb-4">
            AI-Powered Emergency Response Network
          </p>
          
          <p className="text-lg text-[var(--muted-foreground)] max-w-2xl mx-auto mb-8">
            From Incident to Outcome — Faster. Intelligent dispatch, real-time tracking, 
            and AI-powered coordination that saves critical minutes.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Link to="/command-center">
              <Button size="lg" className="gap-2">
                <Activity size={18} />
                Open Command Center
                <ArrowRight size={16} />
              </Button>
            </Link>
            <Link to="/command-center">
              <Button variant="outline" size="lg" className="gap-2">
                <Eye size={18} />
                Explore Platform
              </Button>
            </Link>
          </div>

          {/* Hero Visualization */}
          <div className="relative max-w-4xl mx-auto">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl">
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
                {[
                  { label: 'Active', value: '4', color: 'text-red-500' },
                  { label: 'Critical', value: '1', color: 'text-red-500' },
                  { label: 'Ambulances', value: '6', color: 'text-blue-500' },
                  { label: 'Available', value: '2', color: 'text-green-500' },
                  { label: 'Hospitals', value: '4', color: 'text-cyan-500' },
                  { label: 'Avg ETA', value: '7:12', color: 'text-amber-500' },
                ].map((m, i) => (
                  <div key={i} className="text-center p-3 rounded-lg bg-[var(--surface)]">
                    <p className={`text-2xl font-bold ${m.color}`}>{m.value}</p>
                    <p className="text-xs text-[var(--muted-foreground)]">{m.label}</p>
                  </div>
                ))}
              </div>
              <div className="h-48 rounded-lg bg-[var(--muted)] flex items-center justify-center relative overflow-hidden">
                <div className="absolute inset-0 opacity-20">
                  <svg className="w-full h-full" viewBox="0 0 400 200">
                    <path d="M 0 100 Q 100 50 200 100 Q 300 150 400 100" fill="none" stroke="var(--primary)" strokeWidth="2" strokeDasharray="5 5" />
                    <circle cx="50" cy="95" r="6" fill="var(--destructive)" />
                    <circle cx="200" cy="100" r="6" fill="var(--primary)" />
                    <circle cx="350" cy="100" r="6" fill="var(--success)" />
                  </svg>
                </div>
                <div className="text-center z-10">
                  <MapPin size={32} className="mx-auto text-[var(--primary)] mb-2" />
                  <p className="text-sm font-medium">Live Operations Map</p>
                  <p className="text-xs text-[var(--muted-foreground)]">Real-time emergency, ambulance & hospital tracking</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-20 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Incident → Intelligence → Response → Outcome</h2>
            <p className="text-[var(--muted-foreground)] max-w-2xl mx-auto">
              Every second counts in emergency response. RapidAid compresses the timeline from incident detection to patient outcome.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {[
              { icon: <Siren size={24} />, title: 'Incident', desc: 'Multiple detection channels: citizen reports, AI vision, voice AI', color: 'bg-red-500/10 text-red-500' },
              { icon: <Brain size={24} />, title: 'Intelligence', desc: 'AI triage, priority assessment, and resource recommendation', color: 'bg-purple-500/10 text-purple-500' },
              { icon: <Truck size={24} />, title: 'Response', desc: 'Smart dispatch, optimal routing, green corridor activation', color: 'bg-blue-500/10 text-blue-500' },
              { icon: <CheckCircle2 size={24} />, title: 'Outcome', desc: 'Hospital coordination, patient tracking, outcome analytics', color: 'bg-green-500/10 text-green-500' },
            ].map((step, i) => (
              <Card key={i} className="text-center">
                <CardContent className="pt-6">
                  <div className={`inline-flex h-12 w-12 items-center justify-center rounded-xl ${step.color} mb-4`}>
                    {step.icon}
                  </div>
                  <h3 className="font-bold mb-2">{step.title}</h3>
                  <p className="text-sm text-[var(--muted-foreground)]">{step.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 px-6 bg-[var(--surface)]">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Platform Capabilities</h2>
            <p className="text-[var(--muted-foreground)]">Comprehensive emergency response intelligence</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: <Eye size={20} />, title: 'AI Vision Detection', desc: 'CCTV-powered accident detection with confidence scoring and human review workflow' },
              { icon: <Radio size={20} />, title: 'Smart Dispatch', desc: 'AI-ranked ambulance recommendations with explainable scoring and capability matching' },
              { icon: <Building2 size={20} />, title: 'Hospital Intelligence', desc: 'Real-time capacity monitoring, intelligent hospital recommendation, and load balancing' },
              { icon: <MapPin size={20} />, title: 'Live Tracking', desc: 'Smooth real-time ambulance movement with GPS interpolation and ETA prediction' },
              { icon: <Mic size={20} />, title: 'Voice AI', desc: 'Natural language emergency reporting with AI transcript analysis and data extraction' },
              { icon: <TrafficCone size={20} />, title: 'Green Corridor', desc: 'Traffic signal simulation for optimized emergency routes and reduced response times' },
              { icon: <BarChart3 size={20} />, title: 'Analytics', desc: 'Comprehensive operational metrics, response time analysis, and performance trends' },
              { icon: <Shield size={20} />, title: 'Audit & Compliance', desc: 'Complete action logging, role-based access, and regulatory compliance tracking' },
              { icon: <Globe size={20} />, title: 'Simulations', desc: 'Scenario modeling for mass casualty events, fleet stress tests, and capacity planning' },
            ].map((feature, i) => (
              <Card key={i} className="hover:shadow-md transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)] mb-4">
                    {feature.icon}
                  </div>
                  <h3 className="font-bold mb-2">{feature.title}</h3>
                  <p className="text-sm text-[var(--muted-foreground)]">{feature.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to Experience RapidAid?</h2>
          <p className="text-[var(--muted-foreground)] mb-8">
            Explore the full command center with live demo data, AI vision workspace, 
            dispatch intelligence, and real-time tracking.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/command-center">
              <Button size="lg" className="gap-2">
                <Activity size={18} />
                Launch Command Center
              </Button>
            </Link>
            <Link to="/ai-vision">
              <Button variant="outline" size="lg" className="gap-2">
                <Eye size={18} />
                AI Vision Demo
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[var(--border)] py-8 px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--primary)]">
              <Heart size={14} className="text-white" />
            </div>
            <span className="font-bold">RapidAid</span>
            <Badge variant="outline" className="text-[10px]">DEMO</Badge>
          </div>
          <p className="text-xs text-[var(--muted-foreground)]">
            AI-Powered Emergency Response Network • Demo Environment • No Real Integrations
          </p>
          <p className="text-xs text-[var(--muted-foreground)]">
            © 2026 RapidAid. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
