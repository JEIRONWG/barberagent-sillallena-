import type { NextRequest } from 'next/server'
import { exchangeCodeForTokens, getAuthUrl } from '@/lib/google-calendar'

export const runtime = 'nodejs'

// GET /api/auth/google?barber_id=<uuid>
// Inicia el flujo OAuth — redirige al barbero a Google
export async function GET(request: NextRequest): Promise<Response> {
  const barberId = request.nextUrl.searchParams.get('barber_id')
  if (!barberId) {
    return Response.json({ error: 'barber_id is required' }, { status: 400 })
  }
  const url = getAuthUrl(barberId)
  return Response.redirect(url)
}

// GET /api/auth/google/callback?code=<code>&state=<barber_id>
// Google redirige aquí tras la autorización
