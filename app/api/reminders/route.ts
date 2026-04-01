import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { sendWhatsAppMessage } from '@/lib/twilio'

function to12h(time: string): string {
  const [hStr, mStr] = time.split(':')
  let h = parseInt(hStr, 10)
  const m = mStr ?? '00'
  const period = h >= 12 ? 'PM' : 'AM'
  if (h === 0) h = 12
  else if (h > 12) h -= 12
  return `${h}:${m} ${period}`
}

export const runtime = 'nodejs'

// Este endpoint es llamado por Vercel Cron cada 5 minutos.
// Busca citas que están a ~2h o ~30min y envía recordatorio por WhatsApp al cliente.
// Usa reminders_sent[] para no enviar el mismo recordatorio dos veces.

interface ReminderWindow {
  key: '2h' | '30m'
  minutesBefore: number
  windowMins: number  // margen de tolerancia para el cron
  message: (clientName: string, barberName: string, time: string) => string
}

const REMINDER_WINDOWS: ReminderWindow[] = [
  {
    key: '2h',
    minutesBefore: 120,
    windowMins: 5,
    message: (clientName, barberName, time) =>
      `Hola ${clientName}! 👋 Te recuerdo que tienes cita con ${barberName} hoy a las ${to12h(time)}. ¡Te esperamos! ✂️`,
  },
  {
    key: '30m',
    minutesBefore: 30,
    windowMins: 5,
    message: (clientName, barberName, time) =>
      `${clientName}, tu cita con ${barberName} es en 30 minutos (${to12h(time)}). ¡Ya casi es tu hora! ✂️`,
  },
]

export async function GET(request: NextRequest): Promise<Response> {
  // Verificar que el request viene de Vercel Cron (o de un admin autorizado)
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const now = new Date()
  let totalSent = 0
  const errors: string[] = []

  for (const window of REMINDER_WINDOWS) {
    // Calcular la ventana de tiempo: citas que empiezan entre (now + minutesBefore - windowMins) y (now + minutesBefore + windowMins)
    const targetTime = new Date(now.getTime() + window.minutesBefore * 60_000)
    const rangeStart = new Date(targetTime.getTime() - window.windowMins * 60_000)
    const rangeEnd = new Date(targetTime.getTime() + window.windowMins * 60_000)

    const targetDate = targetTime.toISOString().split('T')[0]
    const timeStart = rangeStart.toTimeString().slice(0, 5)
    const timeEnd = rangeEnd.toTimeString().slice(0, 5)

    // Buscar citas en esa ventana que no hayan recibido este recordatorio aún
    const { data: appointments, error } = await supabaseAdmin
      .from('appointments')
      .select(`
        id,
        appointment_time,
        service,
        reminders_sent,
        clients (name, phone),
        barbers (name, phone)
      `)
      .eq('appointment_date', targetDate)
      .eq('status', 'confirmed')
      .gte('appointment_time', timeStart)
      .lte('appointment_time', timeEnd)
      .not('reminders_sent', 'cs', `{"${window.key}"}`)  // no contiene este key

    if (error) {
      errors.push(`Error fetching appointments for ${window.key}: ${error.message}`)
      continue
    }

    for (const appt of appointments ?? []) {
      const client = (Array.isArray(appt.clients) ? appt.clients[0] : appt.clients) as { name: string; phone: string } | null
      const barber = (Array.isArray(appt.barbers) ? appt.barbers[0] : appt.barbers) as { name: string; phone: string } | null

      if (!client || !barber) continue

      const timeFormatted = (appt.appointment_time as string).slice(0, 5)
      const message = window.message(client.name, barber.name, timeFormatted)

      try {
        await sendWhatsAppMessage(client.phone, message)

        // Marcar este recordatorio como enviado
        await supabaseAdmin
          .from('appointments')
          .update({
            reminders_sent: [...(appt.reminders_sent as string[]), window.key],
          })
          .eq('id', appt.id)

        totalSent++
      } catch (sendError) {
        errors.push(`Failed to send ${window.key} reminder for appt ${appt.id}: ${sendError}`)
      }
    }
  }

  return Response.json({
    ok: true,
    sent: totalSent,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: now.toISOString(),
  })
}
