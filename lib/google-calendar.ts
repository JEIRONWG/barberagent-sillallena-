import { google } from 'googleapis'
import { supabaseAdmin } from './supabase'
import type { Barber, Appointment, GoogleTokens } from './supabase'

function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
}

// Genera la URL para que el barbero autorice el acceso a su Google Calendar.
export function getAuthUrl(barberId: string): string {
  const oauth2Client = buildOAuthClient()
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: barberId,
    prompt: 'consent',
  })
}

// Intercambia el código de autorización por tokens y los guarda en Supabase.
export async function exchangeCodeForTokens(
  barberId: string,
  code: string
): Promise<void> {
  const oauth2Client = buildOAuthClient()
  const { tokens } = await oauth2Client.getToken(code)
  await supabaseAdmin
    .from('barbers')
    .update({ google_tokens: tokens })
    .eq('id', barberId)
}

// Obtiene un cliente OAuth autenticado para un barbero.
// Refresca el access_token automáticamente si expiró.
async function getAuthenticatedClient(barber: Barber) {
  if (!barber.google_tokens) {
    throw new Error(`Barber ${barber.id} has no Google tokens`)
  }

  const oauth2Client = buildOAuthClient()
  oauth2Client.setCredentials(barber.google_tokens)

  // Refrescar token si está vencido (con 60 segundos de margen)
  const expiryDate = barber.google_tokens.expiry_date
  if (expiryDate && Date.now() >= expiryDate - 60_000) {
    const { credentials } = await oauth2Client.refreshAccessToken()
    const updatedTokens: GoogleTokens = {
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token ?? barber.google_tokens.refresh_token,
      expiry_date: credentials.expiry_date ?? expiryDate,
    }
    oauth2Client.setCredentials(updatedTokens)
    await supabaseAdmin
      .from('barbers')
      .update({ google_tokens: updatedTokens })
      .eq('id', barber.id)
  }

  return oauth2Client
}

// Crea un evento en Google Calendar y retorna el google_event_id.
export async function createCalendarEvent(
  barber: Barber,
  appointment: Pick<Appointment, 'service' | 'appointment_date' | 'appointment_time' | 'duration_mins'>,
  clientName: string
): Promise<string> {
  const auth = await getAuthenticatedClient(barber)
  const calendar = google.calendar({ version: 'v3', auth })

  const startDateTime = `${appointment.appointment_date}T${appointment.appointment_time}`
  const endDate = new Date(`${appointment.appointment_date}T${appointment.appointment_time}`)
  endDate.setMinutes(endDate.getMinutes() + appointment.duration_mins)
  const endDateTime = endDate.toISOString().slice(0, 19)

  const event = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: `${appointment.service} — ${clientName}`,
      description: `Cita agendada via WhatsApp por Barber Agent`,
      start: { dateTime: startDateTime, timeZone: 'America/Puerto_Rico' },
      end: { dateTime: endDateTime, timeZone: 'America/Puerto_Rico' },
    },
  })

  return event.data.id!
}

// Elimina un evento de Google Calendar.
export async function deleteCalendarEvent(
  barber: Barber,
  googleEventId: string
): Promise<void> {
  const auth = await getAuthenticatedClient(barber)
  const calendar = google.calendar({ version: 'v3', auth })
  await calendar.events.delete({ calendarId: 'primary', eventId: googleEventId })
}
