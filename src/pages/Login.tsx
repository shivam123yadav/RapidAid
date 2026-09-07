import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Heart, Loader2, AlertCircle, Mail, Lock, User, Eye, EyeOff } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { useAuthStore } from '../stores/auth';
import { cn } from '../lib/utils';
import type { UserRole } from '../types';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.string().min(1, 'Please select your role'),
});

type LoginFormData = z.infer<typeof loginSchema>;

const ROLE_LABELS: Record<UserRole, string> = {
  CITIZEN: 'Citizen',
  AMBULANCE_CREW: 'Ambulance Crew',
  DISPATCHER: 'Dispatcher',
  HOSPITAL_STAFF: 'Hospital Staff',
  SUPERVISOR: 'Supervisor',
  ANALYST: 'Analyst',
  AUDITOR: 'Auditor',
  ADMIN: 'Administrator',
};

export function LoginPage() {
  const navigate = useNavigate();
  const login = useAuthStore((state) => state.login);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
      role: 'DISPATCHER',
    },
  });

  const selectedRole = watch('role');

  const onSubmit = async (data: LoginFormData) => {
    setError(null);
    const success = await login(data.email, data.password, data.role as UserRole);
    
    if (success) {
      navigate('/command-center');
    } else {
      setError('Invalid credentials. Please check your email, password, and role.');
    }
  };

  const fillDemoCredentials = (role: string) => {
    const demoMap: Record<string, { email: string; password: string }> = {
      DISPATCHER: { email: 'dispatcher@rapidaid.com', password: 'demo123' },
      AMBULANCE_CREW: { email: 'crew@rapidaid.com', password: 'demo123' },
      HOSPITAL_STAFF: { email: 'hospital@rapidaid.com', password: 'demo123' },
      ADMIN: { email: 'admin@rapidaid.com', password: 'demo123' },
    };

    const creds = demoMap[role];
    if (creds) {
      setValue('email', creds.email);
      setValue('password', creds.password);
      setValue('role', role);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-background via-background to-primary/5">
      {/* Background Pattern */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(14,165,233,0.1),transparent_50%)]" />
      
      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2 mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary shadow-lg">
              <Heart className="h-6 w-6 text-white" />
            </div>
            <span className="text-2xl font-bold">RapidAid</span>
          </Link>
          <p className="text-sm text-muted-foreground">AI-Powered Emergency Response Network</p>
        </div>

        {/* Login Card */}
        <Card className="shadow-2xl border-border/50 backdrop-blur-sm bg-card/95">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl font-semibold">Welcome back</CardTitle>
            <CardDescription>Sign in to access the emergency response system</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              {/* Error Message */}
              {error && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}

              {/* Role Selection */}
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Select
                  value={selectedRole}
                  onValueChange={(value: string) => setValue('role', value)}
                >
                  <SelectTrigger id="role" className={cn(errors.role && 'border-destructive')}>
                    <SelectValue placeholder="Select your role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DISPATCHER">Dispatcher</SelectItem>
                    <SelectItem value="AMBULANCE_CREW">Ambulance Crew</SelectItem>
                    <SelectItem value="HOSPITAL_STAFF">Hospital Staff</SelectItem>
                    <SelectItem value="ADMIN">Administrator</SelectItem>
                  </SelectContent>
                </Select>
                {errors.role && (
                  <p className="text-xs text-destructive">{errors.role.message}</p>
                )}
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    className={cn('pl-10', errors.email && 'border-destructive')}
                    {...register('email')}
                    autoComplete="email"
                  />
                </div>
                {errors.email && (
                  <p className="text-xs text-destructive">{errors.email.message}</p>
                )}
              </div>

              {/* Password */}
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    className={cn('pl-10 pr-10', errors.password && 'border-destructive')}
                    {...register('password')}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.password && (
                  <p className="text-xs text-destructive">{errors.password.message}</p>
                )}
              </div>

              {/* Submit Button */}
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  <>
                    <User className="mr-2 h-4 w-4" />
                    Sign In
                  </>
                )}
              </Button>

              {/* Demo Credentials */}
              <div className="pt-4 border-t border-border/50">
                <p className="text-xs text-muted-foreground text-center mb-3">
                  Demo credentials for testing:
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fillDemoCredentials('DISPATCHER')}
                    className="text-xs"
                  >
                    Dispatcher
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fillDemoCredentials('AMBULANCE_CREW')}
                    className="text-xs"
                  >
                    Crew
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fillDemoCredentials('HOSPITAL_STAFF')}
                    className="text-xs"
                  >
                    Hospital
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fillDemoCredentials('ADMIN')}
                    className="text-xs"
                  >
                    Admin
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="text-center mt-6 space-y-2">
          <p className="text-xs text-muted-foreground">
            Don't have an account?{' '}
            <Link to="/register" className="text-primary hover:underline font-medium">
              Request access
            </Link>
          </p>
          <p className="text-xs text-muted-foreground">
            <Link to="/" className="hover:underline">
              ← Back to home
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
