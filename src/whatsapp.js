const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';

function phoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function token() {
  return process.env.WHATSAPP_TOKEN;
}

async function sendMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId()}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WhatsApp API ${res.status}: ${errBody}`);
  }

  return res.json();
}

// Verifica que el webhook realmente venga de Meta (firma HMAC con el App Secret).
// Si no hay WHATSAPP_APP_SECRET configurado, no verifica (no recomendado en producción).
function verifySignature(rawBody, signatureHeader) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true;
  if (!signatureHeader) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sendMessage, verifySignature };
