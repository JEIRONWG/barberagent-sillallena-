import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { chat } from '@/lib/claude'
import { sendWhatsAppMessage, validateTwilioSignature } from '@/lib/twilio'
import {
  buildSystemPrompt,
  parseBookingData,
  stripBookingData,
  getOrCreateConversation,
  appendMessage,
  createAppointment,
  notifyBarber,
} from '@/lib/agent'
import type { Barber, ConversationMessage } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(request: NextRequest): Promise<Response> {
  // ── 1. Parsear body form-urlencoded de Twilio ─────────────
  const rawBody = await request.text()
  const params = Object.fromEntries(new URLSearchParams(rawBody))

  const clientPhone: string = params['From'] ?? ''
  const messageBody: string = params['Body'] ?? ''
  const toNumber: string = params['To'] ?? ''

  if (!clientPhone || !messageBody || !toNumber) {
    return new Response('Bad Request', { status: 400 })
  }

  // ── 2. Validar firma de Twilio ────────────────────────────
  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${request.nextUrl.protocol}//${request.nextUrl.host}/api/webhook`

  if (!validateTwilioSignature(signature, url, params)) {
    return new Response('Unauthorized', { status: 401 })
  }

  // ── 3. Buscar barbero por whatsapp_number ─────────────────
  // Twilio envía el número destino con prefijo "whatsapp:+1..."
  const whatsappNumber = toNumber.replace('whatsapp:', '')

  const { data: barber, error: barberError } = await supabaseAdmin
    .from('barbers')
    .select('*')
    .eq('whatsapp_number', whatsappNumber)
    .eq('is_active', true)
    .maybeSingle()

  if (barberError || !barber) {
    console.error('Barber not found for number:', whatsappNumber)
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: 200, headers: { 'Content-Type': 'text/xml' } }) // Responder 200 para que Twilio no reintente
  }

  const barberData = barber as Barber

  try {
    // ── 4. Obtener o crear conversación ───────────────────────
    const conversation = await getOrCreateConversation(barberData.id, clientPhone)

    // ── 5. Obtener slots disponibles para hoy ─────────────────
    const today = new Date().toISOString().split('T')[0]
    const { data: slotsRaw } = await supabaseAdmin.rpc('get_available_slots', {
      p_barber_id: barberData.id,
      p_date: today,
    })
    const availableSlots: string[] = (slotsRaw ?? []).map((r: { slot: string }) =>
      r.slot.slice(0, 5)
    )

    // ── 6. Construir system prompt ────────────────────────────
    const systemPrompt = buildSystemPrompt(barberData, availableSlots)

    // ── 7. Añadir mensaje del cliente al historial ────────────
    await appendMessage(conversation.id, 'user', messageBody)

    // ── 8. Llamar a Claude con el historial completo ──────────
    const history: ConversationMessage[] = [
      ...(conversation.messages as ConversationMessage[]),
      { role: 'user', content: messageBody },
    ]
    const claudeResponse = await chat(systemPrompt, history)

    // ── 9. Detectar BOOKING_DATA ──────────────────────────────
    const bookingData = parseBookingData(claudeResponse)
    const messageToClient = stripBookingData(claudeResponse)

    if (bookingData) {
      // Rellenar teléfono si Claude no lo capturó
      if (!bookingData.telefono) {
        bookingData.telefono = clientPhone.replace('whatsapp:', '')
      }

      // Crear cita en Supabase + Google Calendar
      await createAppointment(barberData, bookingData)

      // Notificar al barbero
      await notifyBarber(barberData, bookingData)

      // Marcar conversación como completada
      await supabaseAdmin
        .from('conversations')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', conversation.id)

      // Guardar respuesta del asistente (sin el bloque BOOKING_DATA)
      await appendMessage(conversation.id, 'assistant', messageToClient)
    } else {
      // Conversación en curso — guardar respuesta
      await appendMessage(conversation.id, 'assistant', claudeResponse)
    }

    // ── 10. Enviar respuesta al cliente por WhatsApp ──────────
    await sendWhatsAppMessage(clientPhone, messageToClient)

    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: 200, headers: { 'Content-Type': 'text/xml' } })
  } catch (err) {
    console.error('Webhook error:', err)
    // Responder 200 para que Twilio no reintente indefinidamente
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: 200, headers: { 'Content-Type': 'text/xml' } })
  }
}
