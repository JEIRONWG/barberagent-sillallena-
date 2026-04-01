import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import type { AppointmentStatus } from '@/lib/supabase'

export const runtime = 'nodejs'

// GET /api/appointments?barber_id=<uuid>&date=<YYYY-MM-DD>
// GET /api/appointments?barber_id=<uuid>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl
  const barberId = searchParams.get('barber_id')

  if (!barberId) {
    return Response.json({ error: 'barber_id is required' }, { status: 400 })
  }

  let query = supabaseAdmin
    .from('appointments')
    .select(`
      *,
      clients (id, name, phone)
    `)
    .eq('barber_id', barberId)
    .order('appointment_date', { ascending: true })
    .order('appointment_time', { ascending: true })

  const date = searchParams.get('date')
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  if (date) {
    query = query.eq('appointment_date', date)
  } else if (from && to) {
    query = query.gte('appointment_date', from).lte('appointment_date', to)
  }

  const { data, error } = await query

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ appointments: data })
}

// PATCH /api/appointments?id=<uuid>
// Body: { status: AppointmentStatus }
export async function PATCH(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl
  const id = searchParams.get('id')

  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 })
  }

  const body = (await request.json()) as { status?: AppointmentStatus }

  if (!body.status) {
    return Response.json({ error: 'status is required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('appointments')
    .update({ status: body.status })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ appointment: data })
}

// DELETE /api/appointments?id=<uuid>
export async function DELETE(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl
  const id = searchParams.get('id')

  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 })
  }

  // Obtener el google_event_id y datos del barbero antes de cancelar
  const { data: appointment, error: fetchError } = await supabaseAdmin
    .from('appointments')
    .select('google_event_id, barber_id, barbers(google_tokens)')
    .eq('id', id)
    .single()

  if (fetchError) {
    return Response.json({ error: fetchError.message }, { status: 500 })
  }

  // Cancelar en lugar de eliminar — conserva historial
  const { error: updateError } = await supabaseAdmin
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', id)

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  // Eliminar de Google Calendar si existe el evento
  if (appointment?.google_event_id) {
    try {
      const { deleteCalendarEvent } = await import('@/lib/google-calendar')
      const { data: barber } = await supabaseAdmin
        .from('barbers')
        .select('*')
        .eq('id', appointment.barber_id)
        .single()
      if (barber?.google_tokens) {
        await deleteCalendarEvent(barber, appointment.google_event_id)
      }
    } catch (err) {
      console.error('Failed to delete Google Calendar event (non-fatal):', err)
    }
  }

  return Response.json({ success: true })
}
