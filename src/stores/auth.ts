import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserRole } from '../types';

interface AuthState {
  isAuthenticated: boolean;
  user: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
    avatar?: string;
  } | null;
  login: (email: string, password: string, role: UserRole) => Promise<boolean>;
  logout: () => void;
}

// Demo users for different roles
const DEMO_USERS = [
  {
    email: 'dispatcher@rapidaid.com',
    password: 'demo123',
    user: {
      id: 'USR-001',
      name: 'Arjun Khan',
      email: 'dispatcher@rapidaid.com',
      role: 'DISPATCHER' as UserRole,
    },
  },
  {
    email: 'crew@rapidaid.com',
    password: 'demo123',
    user: {
      id: 'USR-002',
      name: 'Dr. Priya Sharma',
      email: 'crew@rapidaid.com',
      role: 'AMBULANCE_CREW' as UserRole,
    },
  },
  {
    email: 'hospital@rapidaid.com',
    password: 'demo123',
    user: {
      id: 'USR-003',
      name: 'Dr. Rajesh Patel',
      email: 'hospital@rapidaid.com',
      role: 'HOSPITAL_STAFF' as UserRole,
    },
  },
  {
    email: 'admin@rapidaid.com',
    password: 'demo123',
    user: {
      id: 'USR-004',
      name: 'System Administrator',
      email: 'admin@rapidaid.com',
      role: 'ADMIN' as UserRole,
    },
  },
];

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      login: async (email: string, password: string, role: UserRole) => {
        // Simulate API call
        await new Promise((resolve) => setTimeout(resolve, 800));

        const demoUser = DEMO_USERS.find(
          (u) => u.email === email && u.password === password && u.user.role === role
        );

        if (demoUser) {
          set({
            isAuthenticated: true,
            user: demoUser.user,
          });
          return true;
        }

        return false;
      },
      logout: () => {
        set({
          isAuthenticated: false,
          user: null,
        });
      },
    }),
    {
      name: 'rapidaid-auth',
    }
  )
);
