import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Mic, MicOff, CheckCircle, AlertTriangle, Volume2 } from 'lucide-react';
import { mockVoiceReport } from '../mocks/data';

export function VoicePage() {
  const [isRecording, setIsRecording] = useState(false);
  const report = mockVoiceReport;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Volume2 size={24} className="text-[var(--primary)]" />
          Voice Emergency Reporting
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">AI-powered voice transcription and incident extraction</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recording Interface */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Voice Input</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex flex-col items-center justify-center py-8">
              <button
                onClick={() => setIsRecording(!isRecording)}
                className={`relative flex h-24 w-24 items-center justify-center rounded-full transition-all ${
                  isRecording
                    ? 'bg-red-500 shadow-lg shadow-red-500/30 scale-110'
                    : 'bg-[var(--primary)] hover:scale-105'
                }`}
              >
                {isRecording ? (
                  <MicOff size={32} className="text-white" />
                ) : (
                  <Mic size={32} className="text-white" />
                )}
                {isRecording && (
                  <span className="absolute inset-0 rounded-full animate-ping bg-red-500/30" />
                )}
              </button>
              <p className="mt-4 text-sm font-medium">
                {isRecording ? 'Recording...' : 'Tap to record'}
              </p>
              {isRecording && (
                <div className="mt-3 flex items-center gap-1">
                  {Array.from({ length: 20 }).map((_, i) => (
                    <div
                      key={i}
                      className="w-1 bg-[var(--primary)] rounded-full animate-pulse"
                      style={{ height: `${Math.random() * 24 + 8}px`, animationDelay: `${i * 50}ms` }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Transcript */}
            <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--surface)]">
              <p className="text-xs text-[var(--muted-foreground)] mb-2">Transcript:</p>
              <p className="text-sm leading-relaxed">{report.transcript}</p>
            </div>
          </CardContent>
        </Card>

        {/* AI Extracted Information */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">AI Extracted Information</CardTitle>
              <Badge variant="warning">DRAFT — Requires Confirmation</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle size={12} />
                AI output is a draft requiring human confirmation before emergency creation
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                <span className="text-sm text-[var(--muted-foreground)]">Incident Type</span>
                <Badge variant="outline">{report.extractedData.incidentType?.replace(/_/g, ' ')}</Badge>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                <span className="text-sm text-[var(--muted-foreground)]">Location</span>
                <span className="text-sm font-medium">{report.extractedData.location}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                <span className="text-sm text-[var(--muted-foreground)]">Victim Count</span>
                <span className="text-sm font-medium">{report.extractedData.victimCount}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-[var(--border)]">
                <span className="text-sm text-[var(--muted-foreground)]">Confidence</span>
                <span className="text-sm font-mono font-bold">{report.confidence}%</span>
              </div>
              <div className="py-2">
                <span className="text-sm text-[var(--muted-foreground)]">Description:</span>
                <p className="text-sm mt-1">{report.extractedData.description}</p>
              </div>
            </div>

            <div className="flex gap-2 pt-4 border-t border-[var(--border)]">
              <Button variant="outline" className="flex-1">
                <MicOff size={14} className="mr-1" /> Discard
              </Button>
              <Button className="flex-1">
                <CheckCircle size={14} className="mr-1" /> Confirm & Create Emergency
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
