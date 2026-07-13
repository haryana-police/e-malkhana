// Shared types between client and server (mirrored on the server side)

export type ViewName = 'dashboard' | 'caseproperty' | 'movements' | 'templates' | 'alerts';

export type CaseStatus =
  | 'Seized'
  | 'Expert Opinion Pending'
  | 'In Malkhana'
  | 'With FSL'
  | 'In Court'
  | 'Disposed';

export interface CaseRow {
  id: string;                 // "FIR 214/2026" or "DD 41/2026"
  itemType: string;           // "Country-made pistol (.315 bore)"
  itemSub: string;            // "1 unit, with 2 live cartridges"
  quantity?: string;          // parsed count, e.g. "2" (decorated server-side)
  itemTypeId?: number | null; // FK to item_types master row (controlled vocab)
  description?: string;       // free-text specifics, e.g. "80 grams, sealed poly bag"
  lastMovement?: string;      // YYYY-MM-DD of last movement-log entry (decorated server-side)
  section: string;            // "PART B" — letter reference, never display
  sectionName: string;        // "Weapons Almirah" — joined from sections table at read time
  sectionLetter?: string;     // "B" — convenience for the UI; same as section.replace('PART ', '')
  status: CaseStatus;
  seizingOfficer: string;
  seizedOn: string;           // "02 Jun 2026"
  itemId: string;             // "MK-2026-000214"
  imageUrl?: string;          // "/uploads/case-FIR-214-2026.svg"
  docRef?: string;            // "/uploads/doc-FIR-214-2026.pdf" (seizure memo)
  legalSection?: string;      // "101" — BNS section no. (without "BNS " prefix)
  legalSectionTitle?: string; // "Murder" — denormalised title for offline render
  createdAt: string;
}

// One BNS (Bharatiya Nyaya Sanhita, 2023) section row.  Sourced from the
// bns_sections table on the server; the client uses the typeahead on
// "Register New Case Property" to pick a section.
export interface BnsSection {
  sectionNo: string;          // "101"
  title: string;              // "Murder"
  description?: string;
  category?: string;          // "Offences against human body"
}

export interface MovementEvent {
  title: string;
  meta: string;               // "by ... · date · note"
}

export interface MovementRow {
  fir: string;
  item: string;
  movement: string;
  by: string;
  time: string;
  events?: MovementEvent[];   // optional timeline (for log modal)
}

// The raw row stored in the append-only log on the server.
export interface MovementLogRow {
  id: number;
  caseId: string;
  fromLocation: string;
  toLocation: string;
  movedBy: string;
  timestamp: string;
  purpose: string;
  docRef: string;
}

export interface AlertRow {
  level: 'urgent' | 'warn';
  title: string;
  desc: string;
  days: string;
}

export interface DashboardStats {
  totalProperty: number;
  pendingDisposal: number;
  expertPending: number;
  withFSL: number;
  inspectionDue: string;       // e.g. "2 days"
  station: string;             // "PS Sector-5, Panchkula"
  asOf: string;                // "05 Jul 2026, 10:42 AM"
}

// Standardised "Item Type" master row (controlled vocabulary per section).
// Mirrors the server's ItemType shape exactly.
export interface ItemType {
  id: number;
  sectionLetter: string;     // "A".."E"
  name: string;
  sortOrder: number;
  active: boolean;            // false = soft-deleted (hidden from dropdown)
  caseCount: number;          // how many cases currently use this type
}

export interface RackItem {
  letter: string;              // "A" or "AA"
  name: string;                // "Narcotics Rack"
  count: number;               // 18
  active?: boolean;            // false = hidden from "Register New" dropdown
}

export interface Officer {
  initials: string;
  name: string;
  rank: string;
}

export interface DashboardData {
  officer: Officer;
  racks: RackItem[];
  stats: DashboardStats;
  recentMovements: MovementRow[];
  priorityAlerts: AlertRow[];
}

export interface AlertConfig {
  fslDays: number;
  expertDays: number;
  courtDays: number;
  inspectionCycleDays: number;
  lastInspection: string;
  // Editable police-station name (was hardcoded). The dashboard subheader,
  // report letterhead, and login response all read from this single field.
  station: string;
}

export interface NewCaseInput {
  firOrDd: string;
  itemType: string;
  itemSub?: string;
  section: string;          // letter "A".."E"
  seizingOfficer: string;
  seizedOn: string;
  status?: CaseStatus;
  itemId?: string;
  photo?: string;            // OPTIONAL — URL of the uploaded photo of the seized object
  supportingDoc?: string;   // OPTIONAL — URL of the seizure memo / supporting document
  legalSection?: string;    // OPTIONAL — BNS section no. (e.g. "101" or "BNS 101"); server validates
  itemTypeId?: number | null; // OPTIONAL — FK to the item_types master row
  description?: string;       // OPTIONAL — free-text specifics, e.g. "80 grams, sealed poly bag"
}

export interface ScanInput {
  payload?: string;         // raw QR text (JSON or case id)
  caseId?: string;
  toLocation?: string;
  movedBy?: string;
  purpose?: string;
  docRef?: string;
  setStatus?: CaseStatus;
}

export interface User {
  id: string;
  initials: string;
  name: string;
  rank: string;
  designation: string;
  station: string;
}

export interface UploadResult {
  url: string;
  filename: string;
  mime: string;
  bytes: number;
}

export interface AuditEntry {
  id: number;
  timestamp: string;        // ISO
  userId: string;           // "MM-001" or "system" or "anonymous"
  userName: string;         // "SI Rakesh Sharma"
  action: string;           // "case.create" | "case.status" | "movement.record" | "section.rename" | "alerts.config" | "login" | "file.upload" | "scan.read" | "scan.record"
  target: string;           // e.g. "FIR 214/2026" or "thresholds"
  details: string;          // human-readable description
}
