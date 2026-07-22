const Anthropic = require('@anthropic-ai/sdk');
const buildPrompt = require('../prompts/impacta');
const { getFAQPrompt } = require('./faq');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function chat(historial, sesionContext) {
  const systemPrompt = buildPrompt(sesionContext || {}) + getFAQPrompt();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: historial,
  });

  return response.content[0].text;
}

// Schemas de extracción por flujo
const SCHEMAS = {
  propietario: `{
  "nombre": "nombre completo del propietario",
  "relacion": "propietario / familiar / representante / otro — relación con el inmueble",
  "tipo": "tipo de propiedad (casa/departamento/local/terreno/otro)",
  "sector": "sector o barrio",
  "dormitorios": "número de dormitorios",
  "superficie": "superficie aproximada",
  "ocupacion": "ocupada o desocupada",
  "operacion": "venta o arriendo",
  "motivo": "motivo de venta o arriendo",
  "precio": "precio estimado o null si necesita tasación",
  "urgencia": "plazo o urgencia",
  "otraInmobiliaria": "sí o no",
  "disponibilidad": "día y preferencia horaria (mañana/tarde) para ser contactado",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó",
  "zona": "Quito / Valles / Imbabura / fuera de cobertura",
  "antiguedad": "nueva / 1-5 años / 6-10 años / +10 años / no sabe",
  "prioridad": "Alta / Media / Baja según urgencia y disposición",
  "observacion": "contexto relevante para el asesor, máximo 1 oración"
}`,
  asesor: `{
  "nombre": "nombre completo",
  "edad": "edad si fue mencionada o null",
  "ciudad": "ciudad o sector donde vive",
  "experiencia": "experiencia previa en ventas o áreas comerciales o null",
  "situacion": "situación laboral actual o null",
  "disponibilidad": "inmediata / parcial / no tiene",
  "motivacion": "motivación principal expresada",
  "descalificado": "true si fue descalificado, false si calificó",
  "entrevistaConfirmada": "true si el candidato confirmó asistir a la entrevista, false si no",
  "entrevistaFecha": "fecha exacta de la entrevista confirmada en formato DD/MM/YYYY o null",
  "entrevistaHora": "hora de la entrevista confirmada (ej: 14:30) o null"
}`,
  comprador: `{
  "nombre": "nombre completo si fue mencionado",
  "tipo": "tipo de propiedad",
  "sector": "sector o barrio en Quito",
  "dormitorios": "número de dormitorios",
  "presupuesto": "presupuesto estimado",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó"
}`,
  arrendatario: `{
  "nombre": "nombre completo si fue mencionado",
  "tipo": "tipo de propiedad",
  "sector": "sector o barrio en Quito",
  "dormitorios": "número de dormitorios",
  "presupuesto": "presupuesto mensual",
  "cumpleanos": "fecha de cumpleaños o null si no proporcionó"
}`,
};

async function extraerDatos(historial, flujo) {
  const schema = SCHEMAS[flujo];
  if (!schema) return {};

  const conversacion = historial
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Valentina'}: ${m.content}`)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: 'Sos un extractor de datos. Analizás conversaciones de WhatsApp y extraés datos estructurados en JSON. Solo devolvés el JSON, sin texto adicional, sin markdown.',
      messages: [
        {
          role: 'user',
          content: `Extraé los datos de esta conversación y devolvelos como JSON con esta estructura exacta:\n${schema}\n\nConversación:\n${conversacion}\n\nSi un dato no fue mencionado, usá null. Solo devolvé el JSON.`,
        },
      ],
    });

    const raw = response.content[0].text.trim();
    // Limpiar posible markdown
    const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[claude] Error extrayendo datos:', e.message);
    return {};
  }
}

module.exports = { chat, extraerDatos };
