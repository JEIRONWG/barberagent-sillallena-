import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Cliente con service_role — bypasses RLS. Usar SOLO en server-side (API routes, lib/).
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
})

// Cliente con anon key — respeta RLS. Usar en frontend/dashboard.
export const supabaseClient = createClient(supabaseUrl, supabaseAnonKey)

// ─── Tipos de las tablas ──────────────────────────────────

export interface DaySchedule {
  open: string   // "09:00"
  close: string  // "18:00"
  active: boolean
}

export interface Service {
  name: string
  price: number
  duration_mins: number
}

export interface GoogleTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
}

export interface Barber {
  id: string
  user_id: string | null
  name: string
  phone: string
  whatsapp_number: string
  shop_name: string | null
  location: string | null
  slot_duration_mins: number
  google_tokens: GoogleTokens | null
  schedule: Record<string, DaySchedule>
  services: Service[]
  is_active: boolean
  created_at: string
}

export interface Client {
  id: string
  barber_id: string
  name: string
  phone: string
  last_visit: string | null
  created_at: string
}

export type AppointmentStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'

export interface Appointment {
  id: string
  barber_id: string
  client_id: string
  service: string
  appointment_date: string  // "YYYY-MM-DD"
  appointment_time: string  // "HH:MM:SS"
  duration_mins: number
  status: AppointmentStatus
  google_event_id: string | null
  channel: string
  notes: string | null
  created_at: string
}

export type ConversationStatus = 'active' | 'completed' | 'abandoned'

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface Conversation {
  id: string
  barber_id: string
  client_phone: string
  messages: ConversationMessage[]
  status: ConversationStatus
  created_at: string
  updated_at: string
}
