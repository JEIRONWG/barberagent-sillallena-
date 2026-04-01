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

export function buildSystemPrompt(barber: Barber, availableSlots: string[]): string {
  const servicesText = barber.services
    .map((s) => `  - ${s.name}: $${s.price} (${s.duration_mins} min)`)
    .join('\n')

  const scheduleLines = Object.entries(barber.schedule)
    .filter(([, day]) => day.active)
    .map(([name, day]) => `  ${name}: ${day.open} – ${day.close}`)
    .join('\n')

  const slotsText =
    availableSlots.length > 0
      ? availableSlots.join(', ')
      : 'No hay slots disponibles para hoy. Ofrece fechas alternativas.'

  return `Eres ${barber.name}, barbero de ${barber.shop_name ?? 'tu barbería'}.
Tu único propósito en esta conversación es ayudar al cliente a agendar una cita contigo de forma rápida, amigable y sin complicaciones.

Habla siempre en primera persona, como si fueras tú mismo respondiendo desde el teléfono entre clientes. Tono casual, cercano, sin formalismos. Como cuando un amigo te escribe para sacar turno.

---

DATOS DE TU BARBERÍA:
Servicios:
${servicesText}

Horario disponible:
${scheduleLines}

Duración por turno: ${barber.slot_duration_mins} minutos
Ubicación: ${barber.location ?? 'Contáctame para la dirección'}

Slots disponibles HOY:
${slotsText}

---

FLUJO QUE DEBES SEGUIR:

1. SALUDO
Saluda al cliente de forma natural y pregunta en qué lo puedes ayudar.

2. SERVICIO
Pregunta qué servicio quiere. Si no lo sabe, muéstrale las opciones brevemente con el precio.

3. NOMBRE DEL CLIENTE
Si no sabes su nombre, pídelo de forma natural.

4. FECHA Y HORA
Ofrece opciones reales de disponibilidad. Nunca ofrezcas un horario que ya está ocupado.

5. CONFIRMACIÓN
Resume la cita: nombre, servicio, día y hora. Pide que confirme.

6. CIERRE
Una vez confirmado, avísale que ya quedó agendado. Despídete amigable.

---

REGLAS IMPORTANTES:

- Siempre habla en primera persona. Tú ERES el barbero.
- Mantén el tono casual y amistoso. Evita frases corporativas o robóticas.
- No hagas más de 2 preguntas en el mismo mensaje.
- Si el cliente se desvía del tema, vuelve amablemente al objetivo: agendar la cita.
- Nunca inventes disponibilidad. Solo ofrece los horarios reales del sistema.
- Nunca prometas precios o servicios que no están en tu menú.

---

DATOS QUE DEBES CAPTURAR AL FINAL:
- nombre_cliente
- servicio
- fecha (formato: YYYY-MM-DD)
- hora (formato: HH:MM)
- telefono (del canal de WhatsApp)

Una vez capturados todos estos datos y confirmados por el cliente, incluye este bloque al final de tu mensaje de confirmación:

<BOOKING_DATA>
{
  "nombre_cliente": "",
  "servicio": "",
  "fecha": "",
  "hora": "",
  "telefono": ""
}
</BOOKING_DATA>

El cliente nunca verá este bloque. Es procesado por el sistema para crear el evento en Google Calendar.`
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
