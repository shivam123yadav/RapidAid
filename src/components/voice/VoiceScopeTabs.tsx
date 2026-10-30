export interface ScopeTabDef {
  key: string;
  label: string;
  scope?: string;
  status?: string;
}

export function getTabsForRole(role?: string): ScopeTabDef[] {
  switch (role) {
    case 'ADMIN':
      return [
        { key: 'all', label: 'All Reports' },
        { key: 'active', label: 'Active', scope: 'active' },
        { key: 'historical', label: 'Historical', scope: 'historical' },
        { key: 'own', label: 'My Reports', scope: 'own' },
      ];
    case 'SUPERVISOR':
      return [
        { key: 'active', label: 'Operational (Active)', scope: 'active' },
        { key: 'all', label: 'All Accessible' },
        { key: 'historical', label: 'Historical', scope: 'historical' },
      ];
    case 'DISPATCHER':
      return [
        { key: 'active', label: 'Review Queue & Active', scope: 'active' },
        { key: 'own', label: 'My Calls', scope: 'own' },
      ];
    case 'AMBULANCE_CREW':
      return [
        { key: 'assigned', label: 'Assigned Emergencies' },
        { key: 'own', label: 'My Reports', scope: 'own' },
      ];
    case 'HOSPITAL_STAFF':
      return [
        { key: 'hospital', label: 'Routed to My Hospital' },
        { key: 'own', label: 'My Reports', scope: 'own' },
      ];
    case 'ANALYST':
      return [
        { key: 'analytical', label: 'Confirmed Data & Transcripts', scope: 'analytical' },
      ];
    case 'AUDITOR':
      return [
        { key: 'evidence', label: 'Confirmed Evidence', scope: 'evidence' },
        { key: 'rejected', label: 'Rejected Drafts', scope: 'rejected' },
      ];
    case 'CITIZEN':
      return [
        { key: 'own', label: 'My Voice Reports', scope: 'own' },
      ];
    default:
      return [{ key: 'all', label: 'Reports' }];
  }
}
