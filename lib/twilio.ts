import twilio from 'twilio'

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const from = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`

export async function sendWhatsAppMessage(to: string, body: string): Promise<void> {
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`
  await client.messages.create({ from, to: toFormatted, body })
}

// Valida que el request viene realmente de Twilio usando su firma HMAC-SHA1.
export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN!,
    signature,
    url,
    params
  )
}
