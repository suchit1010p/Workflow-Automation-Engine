const stepKeys = {
  task: new Set(['id', 'type', 'label', 'output', 'next']),
  condition: new Set(['id', 'type', 'field', 'operator', 'value', 'trueNext', 'falseNext']),
  wait: new Set(['id', 'type', 'durationMs', 'next']),
  message: new Set(['id', 'type', 'message', 'next']),
}
const operators = new Set(['equals', 'not_equals', 'greater_than', 'less_than'])
const identifier = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

export class WorkflowGenerationError extends Error {
  constructor(message, status = 422) {
    super(message)
    this.name = 'WorkflowGenerationError'
    this.status = status
  }
}

export function validateWorkflowDefinition(definition, { requireOrderTrigger = false } = {}) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return 'definition must be an object'
  if (Object.keys(definition).some((key) => !['trigger', 'startAt', 'steps'].includes(key))) return 'definition contains unsupported properties'
  if (typeof definition.startAt !== 'string' || !Array.isArray(definition.steps) || !definition.steps.length) return 'definition must include startAt and a non-empty steps array'

  if (requireOrderTrigger && !definition.trigger) return 'definition must include an order_created trigger'
  if (definition.trigger) {
    if (typeof definition.trigger !== 'object' || Array.isArray(definition.trigger)) return 'trigger must be an object'
    if (Object.keys(definition.trigger).some((key) => key !== 'type') || definition.trigger.type !== 'order_created') return 'trigger type must be order_created'
  }

  const ids = new Set()
  for (const step of definition.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return 'each step must be an object'
    if (typeof step.id !== 'string' || !identifier.test(step.id) || ids.has(step.id)) return 'each step must have a unique valid id'
    if (!stepKeys[step.type]) return `unsupported step type: ${step.type}`
    if (Object.keys(step).some((key) => !stepKeys[step.type].has(key))) return `step ${step.id} contains unsupported properties`
    ids.add(step.id)
  }
  if (!ids.has(definition.startAt)) return 'startAt must reference an existing step'

  const checkReference = (reference, stepId, property) => {
    if (reference !== null && (typeof reference !== 'string' || !ids.has(reference))) return `step ${stepId} ${property} must be null or reference an existing step`
    return null
  }
  for (const step of definition.steps) {
    if (step.type === 'condition') {
      if (typeof step.field !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.field)) return `step ${step.id} has an invalid condition field`
      if (!operators.has(step.operator)) return `step ${step.id} has an unsupported condition operator`
      if (!Object.hasOwn(step, 'value') || !['string', 'number', 'boolean'].includes(typeof step.value) || (typeof step.value === 'number' && !Number.isFinite(step.value))) return `step ${step.id} must have a simple condition value`
      if (['greater_than', 'less_than'].includes(step.operator) && (typeof step.value !== 'number' || !Number.isFinite(step.value))) return `step ${step.id} requires a numeric value for ${step.operator}`
      if (!Object.hasOwn(step, 'trueNext') || !Object.hasOwn(step, 'falseNext')) return `step ${step.id} must define trueNext and falseNext`
      const trueError = checkReference(step.trueNext, step.id, 'trueNext')
      if (trueError) return trueError
      const falseError = checkReference(step.falseNext, step.id, 'falseNext')
      if (falseError) return falseError
    } else {
      if (!Object.hasOwn(step, 'next')) return `step ${step.id} must define next`
      const nextError = checkReference(step.next, step.id, 'next')
      if (nextError) return nextError
    }
    if (step.type === 'wait' && (!Number.isInteger(step.durationMs) || step.durationMs < 1 || step.durationMs > 2_592_000_000)) return `step ${step.id} wait duration must be between 1 ms and 30 days`
    if (step.type === 'message' && (typeof step.message !== 'string' || !step.message.trim() || step.message.length > 2000)) return `step ${step.id} must include message content (up to 2000 characters)`
    if (step.type === 'task' && (('label' in step && typeof step.label !== 'string') || ('output' in step && typeof step.output !== 'string'))) return `step ${step.id} task label and output must be text`
  }
  return null
}

function parseAmount(description) {
  const match = description.match(/(?:amount|total|order value)[^.!?]{0,48}?\b(above|over|greater than|more than|exceeds?|below|under|less than)\s*(?:\$\s*|usd\s*)?([\d,]+(?:\.\d+)?)/i)
  if (!match) throw new WorkflowGenerationError('Describe an order amount condition, such as “amount is above $1000”.')
  const value = Number(match[2].replaceAll(',', ''))
  if (!Number.isFinite(value)) throw new WorkflowGenerationError('The amount threshold must be a valid number.')
  const operator = /^(below|under|less than)$/i.test(match[1]) ? 'less_than' : 'greater_than'
  return { operator, value }
}

function parseWait(description) {
  const match = description.match(/\b(?:wait|delay)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)\b/i)
  if (!match) throw new WorkflowGenerationError('Include a wait duration, such as “wait 10 seconds”.')
  const duration = Number(match[1]) * (/^m/i.test(match[2]) ? 60_000 : 1000)
  const durationMs = Math.round(duration)
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 2_592_000_000) throw new WorkflowGenerationError('Wait duration must be between 1 ms and 30 days.')
  return durationMs
}

function parseMessage(description) {
  const quoted = description.match(/\b(?:send|write|create)\b[^“”"']*[“"']([^“”"']{1,2000})[”"']/i)
  if (quoted?.[1]?.trim()) return quoted[1].trim()
  const explicit = description.match(/\b(?:send|write|create)\s+(?:a\s+|an\s+|the\s+)?(?:message|follow[- ]?up message)\s+(?:saying|that says|with text)\s+(.+?)(?:[.!?]|$)/i)
  if (explicit?.[1]?.trim()) return explicit[1].trim().replace(/^['“"]|['”"]$/g, '')
  const descriptorMatch = description.match(/\b(?:send|write|create)\s+(?:a\s+|an\s+|the\s+)?(.{1,80}?)\s+message\b/i)
  if (!descriptorMatch) throw new WorkflowGenerationError('Describe the message to send, for example “send a thank-you message”.')
  const descriptor = descriptorMatch[1].trim().toLowerCase()
  if (/vip/.test(descriptor)) return 'Thank you for your order! We truly appreciate you as a VIP customer.'
  if (/thank/.test(descriptor)) return 'Thank you for your order! We appreciate your business.'
  if (/follow[- ]?up/.test(descriptor)) return 'Thanks for your order! We’ll be in touch with a follow-up shortly.'
  return `Thanks for your order! This is your ${descriptor.replaceAll('-', ' ')} message.`
}

export function generateFallbackWorkflow(description) {
  if (typeof description !== 'string' || !description.trim() || description.length > 1000) throw new WorkflowGenerationError('Description must be between 1 and 1000 characters.')
  if (!/\bnew\s+order\b|\border\s+(?:arrives?|comes?\s+in|is\s+created)\b|\bwhen\s+an?\s+order\b/i.test(description)) throw new WorkflowGenerationError('Describe an order trigger, such as “when a new order arrives”.')
  const condition = parseAmount(description)
  const durationMs = parseWait(description)
  const message = parseMessage(description)
  const amountLabel = `${condition.operator === 'greater_than' ? 'over' : 'under'} $${condition.value}`
  const name = /vip/i.test(message) || /vip/i.test(description) ? 'VIP order follow-up' : `Order follow-up ${amountLabel}`
  const definition = {
    trigger: { type: 'order_created' },
    startAt: 'check_amount',
    steps: [
      { id: 'check_amount', type: 'condition', field: 'amount', operator: condition.operator, value: condition.value, trueNext: 'wait_before_message', falseNext: 'below_threshold' },
      { id: 'wait_before_message', type: 'wait', durationMs, next: 'send_message' },
      { id: 'send_message', type: 'message', message, next: null },
      { id: 'below_threshold', type: 'task', label: 'Order did not meet the amount condition', output: 'No message was sent.', next: null },
    ],
  }
  const error = validateWorkflowDefinition(definition, { requireOrderTrigger: true })
  if (error) throw new WorkflowGenerationError(`Fallback workflow is invalid: ${error}`)
  return { name, definition }
}

async function generateWithGroq(description, apiKey) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      temperature: 0.1,
      max_completion_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Convert the user description into one workflow. Return only JSON with exactly the shape {"name":"string","definition":{"trigger":{"type":"order_created"},"startAt":"step-id","steps":[...]}}. The definition may only use the order_created trigger and task, condition, wait, and message steps. Each step must use only its supported schema fields. Conditions support equals, not_equals, greater_than, less_than. References must point to defined step IDs or null. Wait durationMs must be an integer from 1 to 2592000000. Message content is plain text. Never include code, scripts, expressions, credentials, or unsupported steps. Use trigger data field amount for order amounts. Include both trueNext and falseNext on conditions and next on other steps. Make the order_created path lead to the requested steps.' },
        { role: 'user', content: description },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Groq returned HTTP ${response.status}`)
  const payload = await response.json()
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('Groq returned no workflow JSON')
  const generated = JSON.parse(content)
  if (!generated || typeof generated.name !== 'string' || !generated.name.trim() || generated.name.length > 120) throw new WorkflowGenerationError('Generated workflow must include a name up to 120 characters.')
  const error = validateWorkflowDefinition(generated.definition, { requireOrderTrigger: true })
  if (error) throw new WorkflowGenerationError(`Generated workflow is invalid: ${error}`)
  return { name: generated.name.trim(), definition: generated.definition }
}

export async function generateWorkflow(description, apiKey = process.env.GROQ_API_KEY) {
  if (typeof description !== 'string' || !description.trim() || description.length > 1000) throw new WorkflowGenerationError('Description must be between 1 and 1000 characters.')
  if (!apiKey) return { ...generateFallbackWorkflow(description), source: 'fallback' }
  try {
    return { ...await generateWithGroq(description.trim(), apiKey), source: 'groq' }
  } catch (error) {
    if (error instanceof WorkflowGenerationError) throw error
    try {
      return { ...generateFallbackWorkflow(description), source: 'fallback', notice: 'Groq was unavailable; the rule-based parser generated this workflow.' }
    } catch (fallbackError) {
      if (fallbackError instanceof WorkflowGenerationError) throw fallbackError
      throw new WorkflowGenerationError('Workflow generation failed.')
    }
  }
}
