import type { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'

// GET /api/slots?barber_id=<uuid>&date=<YYYY-MM-DD>
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl
  const barberId = searchParams.get('barber_id')
  const date = searchParams.get('date')

  if (!barberId || !date) {
    return Response.json({ error: 'barber_id and date are required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin.rpc('get_available_slots', {
    p_barber_id: barberId,
    p_date: date,
  })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const slots: string[] = (data ?? []).map((r: { slot: string }) => r.slot.slice(0, 5))
  return Response.json({ slots })
}
