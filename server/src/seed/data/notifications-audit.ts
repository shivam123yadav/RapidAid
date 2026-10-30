export const DEMO_NOTIFICATIONS = [
  { _id: 'N001', category: 'CRITICAL', title: 'Critical Emergency — Vehicle Collision', message: 'EMG-20481: Multi-vehicle collision detected by AI Vision. 3 victims.', timestamp: new Date('2026-01-15T08:23:14Z'), read: false, linkedEmergency: 'EMG-20481', audienceRoles: ['ADMIN', 'SUPERVISOR', 'DISPATCHER', 'ANALYST', 'AUDITOR'] },
  { _id: 'N002', category: 'WARNING', title: 'Hospital Capacity Alert', message: 'HOSP-08 ICU capacity changed to LIMITED.', timestamp: new Date('2026-01-15T09:05:00Z'), read: false, linkedResource: 'HOSP-08', audienceRoles: ['ADMIN', 'SUPERVISOR', 'DISPATCHER', 'HOSPITAL_STAFF'], hospitalId: 'HOSP-08' },
  { _id: 'N003', category: 'INFO', title: 'Ambulance Status Update', message: 'AMB-042 entered maintenance mode.', timestamp: new Date('2026-01-15T06:00:00Z'), read: true, linkedResource: 'AMB-042', audienceRoles: ['ADMIN', 'SUPERVISOR', 'DISPATCHER', 'ANALYST', 'AUDITOR'] },
  { _id: 'N004', category: 'SUCCESS', title: 'Emergency Completed', message: 'EMG-20484: Patient admitted successfully.', timestamp: new Date('2026-01-15T08:15:00Z'), read: true, linkedEmergency: 'EMG-20484', audienceRoles: ['ADMIN', 'SUPERVISOR', 'DISPATCHER', 'HOSPITAL_STAFF', 'AMBULANCE_CREW'] },
  { _id: 'N005', category: 'WARNING', title: 'AI Detection Awaiting Review', message: 'DET-003: Vehicle collision detected with 91.2% confidence.', timestamp: new Date('2026-01-15T09:20:00Z'), read: false, linkedResource: 'DET-003', audienceRoles: ['ADMIN', 'SUPERVISOR', 'DISPATCHER', 'ANALYST', 'AUDITOR'] },
  { _id: 'N006', category: 'INFO', title: 'System Update', message: 'RapidVision model updated to v3.2.1.', timestamp: new Date('2026-01-15T04:00:00Z'), read: true, audienceRoles: ['ADMIN', 'SUPERVISOR', 'ANALYST', 'AUDITOR'] },
];

export const DEMO_AUDIT = [
  { _id: 'A001', actor: 'System (AI Vision)', actorRole: 'ADMIN', action: 'emergency.created', resource: 'Emergency', resourceId: 'EMG-20481', timestamp: new Date('2026-01-15T08:23:14Z'), requestId: 'req_ai_001', details: 'Auto-created from AI detection DET-001' },
  { _id: 'A002', actor: 'Dispatcher Khan', actorRole: 'DISPATCHER', action: 'dispatch.assigned', resource: 'Ambulance', resourceId: 'AMB-017', timestamp: new Date('2026-01-15T08:25:10Z'), requestId: 'req_disp_001', details: 'Assigned to EMG-20481' },
  { _id: 'A003', actor: 'Citizen App', actorRole: 'CITIZEN', action: 'emergency.created', resource: 'Emergency', resourceId: 'EMG-20482', timestamp: new Date('2026-01-15T08:45:00Z'), requestId: 'req_cit_001' },
  { _id: 'A004', actor: 'Dispatcher Khan', actorRole: 'DISPATCHER', action: 'dispatch.assigned', resource: 'Ambulance', resourceId: 'AMB-023', timestamp: new Date('2026-01-15T08:46:50Z'), requestId: 'req_disp_002', details: 'Assigned to EMG-20482' },
  { _id: 'A005', actor: 'Dr. Reddy', actorRole: 'AMBULANCE_CREW', action: 'emergency.completed', resource: 'Emergency', resourceId: 'EMG-20484', timestamp: new Date('2026-01-15T08:15:00Z'), requestId: 'req_crew_001', details: 'Patient admitted, case closed' },
  { _id: 'A006', actor: 'Admin System', actorRole: 'ADMIN', action: 'system.config.updated', resource: 'System', resourceId: 'SYS-001', timestamp: new Date('2026-01-15T04:00:00Z'), requestId: 'req_sys_001', details: 'AI model version updated to 3.2.1' },
];
