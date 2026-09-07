import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { useTheme } from '../stores/theme';
import { Settings as SettingsIcon, Monitor, Sun, Moon, Bell, Shield, User, Building2 } from 'lucide-react';

export function SettingsPage() {
  const { mode, setMode } = useTheme();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <SettingsIcon size={24} className="text-[var(--primary)]" />
          Settings
        </h2>
        <p className="text-sm text-[var(--muted-foreground)]">Application preferences and configuration</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Appearance */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Monitor size={16} />
              Appearance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-3">Theme</p>
              <div className="grid grid-cols-3 gap-2">
                {(['light', 'dark', 'system'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors ${
                      mode === m ? 'border-[var(--primary)] bg-[var(--primary)]/5' : 'border-[var(--border)] hover:bg-[var(--muted)]'
                    }`}
                  >
                    {m === 'light' && <Sun size={20} />}
                    {m === 'dark' && <Moon size={20} />}
                    {m === 'system' && <Monitor size={20} />}
                    <span className="text-xs font-medium capitalize">{m}</span>
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Bell size={16} />
              Notifications
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium">Critical Alerts</p>
                <p className="text-xs text-[var(--muted-foreground)]">Emergency and system-critical notifications</p>
              </div>
              <div className="h-5 w-9 rounded-full bg-[var(--primary)] relative cursor-pointer">
                <div className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-white" />
              </div>
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium">Dispatch Updates</p>
                <p className="text-xs text-[var(--muted-foreground)]">Ambulance assignment and status changes</p>
              </div>
              <div className="h-5 w-9 rounded-full bg-[var(--primary)] relative cursor-pointer">
                <div className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-white" />
              </div>
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium">AI Detection Alerts</p>
                <p className="text-xs text-[var(--muted-foreground)]">New AI vision detections requiring review</p>
              </div>
              <div className="h-5 w-9 rounded-full bg-[var(--primary)] relative cursor-pointer">
                <div className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-white" />
              </div>
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium">System Updates</p>
                <p className="text-xs text-[var(--muted-foreground)]">Maintenance and version updates</p>
              </div>
              <div className="h-5 w-9 rounded-full bg-[var(--muted)] relative cursor-pointer">
                <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--muted-foreground)]" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Account */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <User size={16} />
              Account
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted-foreground)]">Name</span>
              <span className="font-medium">Dispatcher Khan</span>
            </div>
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted-foreground)]">Role</span>
              <Badge variant="outline">DISPATCHER</Badge>
            </div>
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted-foreground)]">Email</span>
              <span className="font-medium">khan@rapidaid.demo</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-[var(--muted-foreground)]">Organization</span>
              <span className="font-medium">Delhi Emergency Services</span>
            </div>
          </CardContent>
        </Card>

        {/* Security */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield size={16} />
              Security
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted-foreground)]">Two-Factor Auth</span>
              <Badge variant="success">Enabled</Badge>
            </div>
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted-foreground)]">Last Login</span>
              <span>Today, 08:15 AM</span>
            </div>
            <div className="flex justify-between py-2 border-b border-[var(--border)]">
              <span className="text-[var(--muted-foreground)]">Session Timeout</span>
              <span>30 minutes</span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-[var(--muted-foreground)]">API Access</span>
              <Badge variant="outline">Restricted</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
