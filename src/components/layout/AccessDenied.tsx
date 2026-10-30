import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Lock, ShieldAlert } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { useAuthStore } from '../../stores/auth';
import { ROLE_LABELS, homeRouteFor, navItemsFor, pageTitleFor } from '../../lib/navigation';

/**
 * Shown by the route guard when a role deep-links into a page outside its
 * workspace (stale bookmark, shared link, hand-typed URL). The server would
 * answer 403 anyway — this explains *why* and offers the pages the role does
 * have, instead of a blank or broken screen.
 */
export function AccessDenied() {
  const user = useAuthStore((state) => state.user);
  const { pathname } = useLocation();
  const role = user?.role;
  const pages = navItemsFor(role, user?.permissions);
  const home = homeRouteFor(role);
  const requested = pageTitleFor(pathname);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-2xl items-center py-8">
      <Card className="relative w-full overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_srgb,var(--destructive)_10%,transparent),transparent_75%)]"
        />
        <CardContent className="relative p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/10 text-[var(--destructive)]">
              <Lock size={20} />
            </div>
            <div className="min-w-0">
              <p className="eyebrow">Restricted route</p>
              <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-[-0.035em]">
                Not part of your workspace
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-[var(--muted-foreground)]">
                <span className="font-medium text-[var(--foreground)]">{requested}</span> is not
                available for the {role ? ROLE_LABELS[role] : 'signed-in'} role.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              Signed in as {user?.name ?? 'unknown user'}
              {role ? ` · ${ROLE_LABELS[role]}` : ''}
            </Badge>
            <Badge variant="outline" className="font-mono text-[9px]">403 boundary</Badge>
          </div>

          <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_55%,transparent)] p-3.5">
            <ShieldAlert size={15} className="mt-0.5 flex-none text-[var(--warning)]" />
            <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
              Page access is decided by your role on the server (RBAC), so this URL would answer{' '}
              <span className="font-mono text-[var(--foreground)]">403 Forbidden</span> even if it
              rendered. Ask an administrator if you need this capability.
            </p>
          </div>

          <div className="mt-6">
            <p className="text-sm font-semibold">Pages you can open</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {pages.map((page) => (
                <Link key={page.path} to={page.path}>
                  <Button variant="outline" size="sm" className="gap-2">
                    <page.icon size={14} />
                    {page.label}
                  </Button>
                </Link>
              ))}
              {pages.length === 0 && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  No workspace pages are attached to this session.
                </p>
              )}
            </div>
          </div>

          <div className="mt-7 border-t border-[var(--border)] pt-5">
            <Link to={home}>
              <Button variant="emergency" className="gap-2">
                Go to my workspace
                <ArrowRight size={16} />
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
