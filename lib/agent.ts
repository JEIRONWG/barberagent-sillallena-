import { supabaseAdmin } from './supabase'
import { sendWhatsAppMessage } from './twilio'
import { createCalendarEvent } from './google-calendar'
import type { Barber, Client, Appointment, Conversation, ConversationMessage } from './supabase'

// ─── Tipos locales ────────────────────────────────────────

export interface BookingData {
  nombre_cliente: string
  servicio: string
  fecha: string   // YYYY-MM-DD
  hora: string    // HH:MM
  telefono: string
}

// ─── buildSystemPrompt ────────────────────────────────────

// Convierte "HH:MM" (24h) a "h:MM AM/PM" (12h, formato Puerto Rico)
function to12h(time: string): string {
  const [hStr, mStr] = time.split(':')
  let h = parseInt(hStr, 10)
  const m = mStr ?? '00'
  const period = h >= 12 ? 'PM' : 'AM'
  if (h === 0) h = 12
  else if (h > 12) h -= 12
  return `${h}:${m} ${period}`
}

export function buildSystemPrompt(barber: Barber, availableSlots: string[]): string {
  const servicesText = barber.services
    .map((s) => `  - ${s.name}`)
    .join('\n')

  const scheduleLines = Object.entries(barber.schedule)
    .filter(([, day]) => day.active)
    .map(([name, day]) => `  ${name}: ${to12h(day.open)} – ${to12h(day.close)}`)
    .join('\n')

  const slotsText =
    availableSlots.length > 0
      ? availableSlots.map(to12h).join(', ')
      : 'No hay slots disponibles para hoy. Ofrece fechas alternativas.'

  return `Eres ${barber.name}, barbero de ${barber.shop_name ?? 'tu barbería'}.
Tu único propósito es ayudar al cliente a agendar una cita de forma rápida y sin complicaciones.

Habla en primera persona, tono casual y directo. Respuestas cortas — máximo 2-3 líneas por mensaje. Una sola pregunta a la vez.

---

SERVICIOS DISPONIBLES:
${servicesText}

HORARIO:
${scheduleLines}

SLOTS DISPONIBLES HOY:
${slotsText}

UBICACIÓN: ${barber.location ?? 'Contáctame para la dirección'}

---

FLUJO:
1. Saluda brevemente y pregunta qué servicio quiere.
2. Pide su nombre si no lo sabes.
3. Ofrece fecha y hora disponible. Usa siempre formato 12 horas (ej: 10:00 AM, 2:30 PM).
4. Confirma: nombre, servicio, día y hora. Una línea.
5. Cierra con mensaje corto y amigable.

---

REGLAS:
- Nunca menciones precios. Los precios se discuten personalmente.
- Nunca inventes disponibilidad.
- Siempre usa formato 12 horas (AM/PM) al hablar de horarios.
- Máximo 2-3 líneas por respuesta.

---

DATOS A CAPTURAR:
- nombre_cliente
- servicio
- fecha (formato: YYYY-MM-DD)
- hora (formato: HH:MM en 24h — solo para el sistema, no para el cliente)
- telefono (del canal de WhatsApp)

Una vez confirmados todos los datos, incluye al final:

<BOOKING_DATA>
{
  "nombre_cliente": "",
  "servicio": "",
  "fecha": "",
  "hora": "",
  "telefono": ""
}
</BOOKING_DATA>

El cliente nunca verá este bloque.`
}

// ─── parseBookingData ─────────────────────────────────────

const BOOKING_DATA_REGEX = /<BOOKING_DATA>([\s\S]*?)<\/BOOKING_DATA>/

export function parseBookingData(claudeResponse: string): BookingData | null {
  const match = BOOKING_DATA_REGEX.exec(claudeResponse)
  if (!match) return null

  try {
    const parsed = JSON.parse(match[1].trim()) as BookingData
    // Validación mínima: todos los campos deben estar presentes y no vacíos
    if (parsed.nombre_cliente && parsed.servicio && parsed.fecha && parsed.hora) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

// Elimina el bloque <BOOKING_DATA> del texto antes de enviarlo al cliente.
export function stripBookingData(claudeResponse: string): string {
  return claudeResponse.replace(BOOKING_DATA_REGEX, '').trim()
}

// ─── getOrCreateConversation ──────────────────────────────

export async function getOrCreateConversation(
  barberId: string,
  clientPhone: string
): Promise<Conversation> {
  // Buscar conversación activa existente
  const { data: existing } = await supabaseAdmin
    .from('conversations')
    .select('*')
    .eq('barber_id', barberId)
    .eq('client_phone', clientPhone)
    .eq('status', 'active')
    .maybeSingle()

  if (existing) return existing as Conversation

  // Crear nueva conversación
  const { data: created, error } = await supabaseAdmin
    .from('conversations')
    .insert({ barber_id: barberId, client_phone: clientPhone })
    .select()
    .single()

  if (error) throw new Error(`Failed to create conversation: ${error.message}`)
  return created as Conversation
}

// ─── appendMessage ────────────────────────────────────────

export async function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<void> {
  const { data: conv, error: fetchError } = await supabaseAdmin
    .from('conversations')
    .select('messages')
    .eq('id', conversationId)
    .single()

  if (fetchError) throw new Error(`Failed to fetch conversation: ${fetchError.message}`)

  const messages = (conv.messages as ConversationMessage[]) ?? []
  messages.push({ role, content })

  const { error: updateError } = await supabaseAdmin
    .from('conversations')
    .update({ messages, updated_at: new Date().toISOString() })
    .eq('id', conversationId)

  if (updateError) throw new Error(`Failed to update conversation: ${updateError.message}`)
}

// ─── getOrCreateClient ────────────────────────────────────

async function getOrCreateClient(
  barberId: string,
  phone: string,
  name: string
): Promise<Client> {
  const { data: existing } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('barber_id', barberId)
    .eq('phone', phone)
    .maybeSingle()

  if (existing) {
    // Actualizar nombre si lo sabemos ahora
    if (existing.name !== name) {
      await supabaseAdmin.from('clients').update({ name }).eq('id', existing.id)
    }
    return existing as Client
  }

  const { data: created, error } = await supabaseAdmin
    .from('clients')
    .insert({ barber_id: barberId, phone, name })
    .select()
    .single()

  if (error) throw new Error(`Failed to create client: ${error.message}`)
  return created as Client
}

// ─── createAppointment ────────────────────────────────────

export async function createAppointment(
  barber: Barber,
  bookingData: BookingData
): Promise<Appointment> {
  const clientPhone = bookingData.telefono || 'unknown'
  const client = await getOrCreateClient(barber.id, clientPhone, bookingData.nombre_cliente)

  // Determinar duración según el servicio
  const service = barber.services.find(
    (s) => s.name.toLowerCase() === bookingData.servicio.toLowerCase()
  )
  const durationMins = service?.duration_mins ?? barber.slot_duration_mins

  const appointmentPayload = {
    barber_id: barber.id,
    client_id: client.id,
    service: bookingData.servicio,
    appointment_date: bookingData.fecha,
    appointment_time: bookingData.hora,
    duration_mins: durationMins,
    status: 'confirmed' as const,
    channel: 'whatsapp',
  }

  const { data: appointment, error } = await supabaseAdmin
    .from('appointments')
    .insert(appointmentPayload)
    .select()
    .single()

  if (error) throw new Error(`Failed to create appointment: ${error.message}`)

  // Crear evento en Google Calendar si el barbero tiene tokens
  if (barber.google_tokens) {
    try {
      const googleEventId = await createCalendarEvent(
        barber,
        {
          service: bookingData.servicio,
          appointment_date: bookingData.fecha,
          appointment_time: bookingData.hora,
          duration_mins: durationMins,
        },
        bookingData.nombre_cliente
      )
      await supabaseAdmin
        .from('appointments')
        .update({ google_event_id: googleEventId })
        .eq('id', appointment.id)
    } catch (calendarError) {
      // No bloquear la cita si falla Google Calendar
      console.error('Google Calendar error (non-fatal):', calendarError)
    }
  }

  // Actualizar last_visit del cliente
  await supabaseAdmin
    .from('clients')
    .update({ last_visit: new Date().toISOString() })
    .eq('id', client.id)

  return appointment as Appointment
}

// ─── notifyBarber ─────────────────────────────────────────

export async function notifyBarber(
  barber: Barber,
  bookingData: BookingData
): Promise<void> {
  const message =
    `Nueva cita agendada!\n` +
    `Cliente: ${bookingData.nombre_cliente}\n` +
    `Servicio: ${bookingData.servicio}\n` +
    `Fecha: ${bookingData.fecha}\n` +
    `Hora: ${bookingData.hora}`

  await sendWhatsAppMessage(barber.phone, message)
}
