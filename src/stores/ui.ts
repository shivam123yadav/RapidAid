import { create } from 'zustand';

interface UIState {
  sidebarCollapsed: boolean;
  sidebarMobileOpen: boolean;
  commandPaletteOpen: boolean;
  notificationDrawerOpen: boolean;
  selectedEmergencyId: string | null;
  mapMode: 'standard' | 'satellite' | 'terrain';
  toggleSidebar: () => void;
  setSidebarMobileOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setNotificationDrawerOpen: (open: boolean) => void;
  setSelectedEmergencyId: (id: string | null) => void;
  setMapMode: (mode: 'standard' | 'satellite' | 'terrain') => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  sidebarMobileOpen: false,
  commandPaletteOpen: false,
  notificationDrawerOpen: false,
  selectedEmergencyId: null,
  mapMode: 'standard',
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarMobileOpen: (open) => set({ sidebarMobileOpen: open }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setNotificationDrawerOpen: (open) => set({ notificationDrawerOpen: open }),
  setSelectedEmergencyId: (id) => set({ selectedEmergencyId: id }),
  setMapMode: (mode) => set({ mapMode: mode }),
}));
