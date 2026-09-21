// Onboarding vocabulary - OFFLINE FALLBACKS only.
//
// The live vocabulary is fetched from GET /api/tag-vocab (see
// services/apiService.getTagVocab) so mobile stays in sync with the backend
// CSVs. Every value below is a VALID controlled-vocabulary code (the backend
// silently drops invalid values on save, so labels like "Mumbai, India" or
// "RFE Received" must never be sent - codes only).

export const VISA_CATEGORIES = [
  'H-1B',
  'H-4',
  'F-1',
  'F-2',
  'L-1',
  'L-1A',
  'L-1B',
  'L-2',
  'O-1',
  'J-1',
  'B-1',
  'B-2',
  'K-1',
  'TN',
  'E-3',
  'IR-1',
  'EB-1',
  'EB-2',
  'EB-3',
  'EB-5',
];

// Curated popular consulates as {code, label} - the CODE is what the backend
// stores (1.4); the label is display-only.
export interface ConsulateOption {
  code: string;
  label: string;
}

export const CONSULATE_OPTIONS: ConsulateOption[] = [
  { code: 'BOM', label: 'Mumbai, India' },
  { code: 'MAA', label: 'Chennai, India' },
  { code: 'DEL', label: 'New Delhi, India' },
  { code: 'HYD', label: 'Hyderabad, India' },
  { code: 'CCU', label: 'Kolkata, India' },
  { code: 'YYZ', label: 'Toronto, Canada' },
  { code: 'YVR', label: 'Vancouver, Canada' },
  { code: 'LHR', label: 'London, UK' },
  { code: 'MNL', label: 'Manila, Philippines' },
  { code: 'MEX', label: 'Mexico City, Mexico' },
  { code: 'CJS', label: 'Ciudad Juarez, Mexico' },
  { code: 'GRU', label: 'São Paulo, Brazil' },
  { code: 'SYD', label: 'Sydney, Australia' },
  { code: 'ICN', label: 'Seoul, South Korea' },
  { code: 'PEK', label: 'Beijing, China' },
  { code: 'PVG', label: 'Shanghai, China' },
  { code: 'CAN', label: 'Guangzhou, China' },
  { code: 'HND', label: 'Tokyo, Japan' },
  { code: 'FRA', label: 'Frankfurt, Germany' },
  { code: 'PAR', label: 'Paris, France' },
  { code: 'LOS', label: 'Lagos, Nigeria' },
  { code: 'ACC', label: 'Accra, Ghana' },
];

// Miscellaneous tags & topics - valid 1.3 abbreviations + 1.10 topics only
// (forms and outcomes live under key stages, mirroring the website).
export const TAGS = [
  'NIW',
  'premium-processing',
  'consular-processing',
  'AOS',
  'OPT',
  'EAD',
  'NVC',
  'PERM',
  'cap-gap',
  'cap-subject',
  'POE',
  'travel-ban',
];

// Forms used as key_stages_or_info KEYS (1.5/1.3); their VALUE is an outcome.
export const KEY_STAGES = [
  { key: 'I-140', label: 'I-140' },
  { key: 'I-485', label: 'I-485' },
  { key: 'I-130', label: 'I-130' },
  { key: 'I-129', label: 'I-129' },
  { key: 'I-765', label: 'I-765 (EAD)' },
  { key: 'I-131', label: 'I-131 (AP)' },
  { key: 'DS-160', label: 'DS-160' },
  { key: 'DS-260', label: 'DS-260' },
  { key: 'PERM', label: 'PERM' },
];

// Valid 1.9 outcomes (the value domain for form keys).
export const STAGE_OUTCOMES = [
  'not-filed-yet',
  'filed',
  'received',
  'pending',
  'in-progress',
  'RFE',
  'approved',
  'denied',
  'refused',
  'issued',
  'withdrawn',
];

// Valid 1.8 date keys.
export const KEY_DATE_TYPES = [
  { key: 'priority_date', label: 'Priority Date' },
  { key: 'i140_filed_date', label: 'I-140 Filed' },
  { key: 'i140_approved_date', label: 'I-140 Approved' },
  { key: 'i485_filed_date', label: 'I-485 Filed' },
  { key: 'labor_cert_filed_date', label: 'PERM Filed' },
  { key: 'perm_approved_date', label: 'PERM Approved' },
  { key: 'visa_interview_date', label: 'Visa Interview' },
  { key: 'visa_stamp_date', label: 'Visa Stamping' },
  { key: 'admission_date', label: 'US Arrival' },
  { key: 'ead_approved_date', label: 'EAD Approved' },
  { key: 'biometrics_appointment_date', label: 'Biometrics' },
];

// Journey milestones - free-form: the backend slugifies and accepts any value.
export const MILESTONES = [
  { key: 'visa_interview', label: 'Visa Interview' },
  { key: 'visa_stamping', label: 'Visa Stamping' },
  { key: 'port_of_entry', label: 'Port of Entry' },
  { key: 'h1b_registration', label: 'H-1B Registration' },
  { key: 'h1b_lottery', label: 'H-1B Lottery' },
  { key: 'h1b_filing', label: 'H-1B Filing' },
  { key: 'h1b_approval', label: 'H-1B Approval' },
  { key: 'h1b_rfe', label: 'H-1B RFE' },
  { key: 'opt_application', label: 'OPT Application' },
  { key: 'stem_opt', label: 'STEM OPT' },
  { key: 'perm_filing', label: 'PERM Filing' },
  { key: 'perm_approval', label: 'PERM Approval' },
  { key: 'i140_filing', label: 'I-140 Filing' },
  { key: 'i140_approval', label: 'I-140 Approval' },
  { key: 'priority_date_current', label: 'Priority Date Current' },
  { key: 'i485_filing', label: 'I-485 Filing' },
  { key: 'biometrics', label: 'Biometrics' },
  { key: 'ead_approval', label: 'EAD Approval' },
  { key: 'advance_parole', label: 'Advance Parole' },
  { key: 'aos_interview', label: 'AOS Interview' },
  { key: 'green_card', label: 'Green Card Received' },
  { key: 'naturalization_interview', label: 'Naturalization Interview' },
  { key: 'oath_ceremony', label: 'Oath Ceremony' },
  { key: 'consular_221g', label: 'Consular 221(g)' },
  { key: 'nvc_processing', label: 'NVC Processing' },
  { key: 'other', label: 'Other Milestone' },
];

export interface OnboardingProfile {
  backgroundText: string;
  currentStatus: string[];
  applyingFor: string[];
  consulates: string[]; // 1.4 CODES (labels are display-only)
  tags: string[];
  keyStages: { [key: string]: string };
  keyDates: { [key: string]: string };
}

export interface JourneyEntry {
  milestone: string;
  date: string;
  experience: string;
  shared: boolean;
  // Set by the backend when a shared experience has been published; MUST be
  // carried through edits or re-saving would re-publish duplicates.
  experience_case_id?: string;
}

export const createEmptyProfile = (): OnboardingProfile => ({
  backgroundText: '',
  currentStatus: [],
  applyingFor: [],
  consulates: [],
  tags: [],
  keyStages: {},
  keyDates: {},
});

// ---------------------------------------------------------------------------
// Mapping between the mobile OnboardingProfile shape and the backend
// ProfilePayload shape (used by PUT /api/profile and POST /api/onboard).
// ---------------------------------------------------------------------------

export interface BackendProfileShape {
  username?: string;
  current_visa_or_greencard_category: string[];
  visa_applying_for: string[];
  primary_consulate: string;
  consulates: string[];
  tags: string[];
  key_stages_or_info: Record<string, string>;
  key_dates: Record<string, string>;
  background_text: string;
  journey?: JourneyEntry[];
}

export function toBackendProfile(
  p: OnboardingProfile,
  journey: JourneyEntry[] = []
): BackendProfileShape {
  return {
    current_visa_or_greencard_category: p.currentStatus,
    visa_applying_for: p.applyingFor,
    consulates: p.consulates,
    primary_consulate: p.consulates[0] || '',
    tags: p.tags,
    key_stages_or_info: p.keyStages,
    key_dates: p.keyDates,
    background_text: p.backgroundText,
    journey,
  };
}

export function fromBackendProfile(
  b:
    | {
        background_text?: string;
        current_visa_or_greencard_category?: string[];
        visa_applying_for?: string[];
        consulates?: string[];
        tags?: string[];
        key_stages_or_info?: Record<string, string>;
        key_dates?: Record<string, string>;
      }
    | null
    | undefined
): OnboardingProfile {
  return {
    backgroundText: b?.background_text || '',
    currentStatus: b?.current_visa_or_greencard_category || [],
    applyingFor: b?.visa_applying_for || [],
    consulates: b?.consulates || [],
    tags: b?.tags || [],
    keyStages: b?.key_stages_or_info || {},
    keyDates: b?.key_dates || {},
  };
}
