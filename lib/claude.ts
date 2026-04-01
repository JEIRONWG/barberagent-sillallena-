import Anthropic from '@anthropic-ai/sdk'
import type { ConversationMessage } from './supabase'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function chat(
  systemPrompt: string,
  messages: ConversationMessage[]
): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  })

  const block = response.content[0]
  if (block.type !== 'text') {
    throw new Error('Unexpected response type from Claude')
  }
  return block.text
}
