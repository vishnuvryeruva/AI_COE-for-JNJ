const config = require('./config');

let orchestrationModule = null;

async function getOrchestrationModule() {
  if (!orchestrationModule) {
    orchestrationModule = await import('@sap-ai-sdk/orchestration');
  }
  return orchestrationModule;
}

function hasVcapAicoreBinding() {
  if (!process.env.VCAP_SERVICES) return false;
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES);
    return Boolean(vcap.aicore);
  } catch {
    return false;
  }
}

function isConfigured() {
  return Boolean(config.aicoreServiceKey) || hasVcapAicoreBinding();
}

async function createClient({ model, modelParams } = {}) {
  const { OrchestrationClient } = await getOrchestrationModule();
  return new OrchestrationClient({
    promptTemplating: {
      model: {
        name: model || config.aicoreModel,
        ...(modelParams && { params: modelParams }),
      },
    },
  });
}

async function generateText({ systemInstruction, userPrompt, model, modelParams }) {
  const client = await createClient({ model, modelParams });
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  messages.push({ role: 'user', content: userPrompt });

  const response = await client.chatCompletion({ messages });
  return response.getContent().trim();
}

/**
 * Models wrap JSON in prose or fences often enough that this is worth doing
 * properly rather than trusting JSON.parse on the raw content.
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[{[]/);
  if (start === -1) throw new Error(`No JSON found in model output: ${text.slice(0, 200)}`);

  // Walk to the matching close so trailing prose doesn't break the parse.
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error(`Unbalanced JSON in model output: ${text.slice(0, 200)}`);
}

async function generateJson({ systemInstruction, userPrompt, model }) {
  const raw = await generateText({
    systemInstruction,
    userPrompt,
    model,
    modelParams: { temperature: 0 },
  });
  return extractJson(raw);
}

module.exports = { isConfigured, generateText, generateJson, extractJson };
