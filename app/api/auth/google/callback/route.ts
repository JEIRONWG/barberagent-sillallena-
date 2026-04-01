import type { NextRequest } from 'next/server'
import { exchangeCodeForTokens } from '@/lib/google-calendar'

export const runtime = 'nodejs'

// GET /api/auth/google/callback?code=<code>&state=<barber_id>
export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const barberId = searchParams.get('state')

  if (!code || !barberId) {
    return Response.json({ error: 'Missing code or state' }, { status: 400 })
  }

  await exchangeCodeForTokens(barberId, code)

  // Redirigir al dashboard de configuración del barbero
  return Response.redirect(new URL('/dashboard/configuracion?google=connected', request.url))
}
