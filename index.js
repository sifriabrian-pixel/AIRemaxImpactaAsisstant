require('dotenv').config();
const path = require('path');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');

const { chat, extraerDatos } = require('./src/claude');
const memory = require('./src/memory');
const scheduler = require('./src/scheduler');
const guardias = require('./src/guardias');
const stats = require('./src/stats');

const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'sessions');

// Crear la carpeta de sesión si no existe
const fs = require('fs');
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}
const NUMEROS_AUTORIZADOS = (process.env.NUMEROS_AUTORIZADOS || '').split(',').map(n => n.trim()).filter(Boolean);

const TRIGGERS = [
  'HANDOFF_PROPIETARIO',
  'HANDOFF_IMBABURA_NICOLE',
  'FOLLOWUP_PROPIETARIO',
  'FOLLOWUP_PROPIETARIO_FUERA_COBERTURA',
  'HANDOFF_ASESOR',
  'FOLLOWUP_ASESOR',
  'HANDOFF_COMPRADOR',
  'HANDOFF_ARRENDATARIO',
  'HANDOFF_GENERAL',
  'CONSENT_GRANTED',
];

function extractTrigger(text) {
  for (const t of TRIGGERS) {
    if (text.includes(`[${t}]`)) return t;
  }
  return null;
}

function cleanResponse(text) {
  let cleaned = text;
  for (const t of TRIGGERS) {
    cleaned = cleaned.replace(`[${t}]`, '').trim();
  }
  return cleaned;
}

function formatResumenAsesor(telefono, datos) {
  return `🔔 Nuevo prospecto asesor calificado

Nombre: ${datos.nombre || '-'} · ${telefono}
Edad: ${datos.edad || '-'}
Ciudad: ${datos.ciudad || '-'}

Experiencia: ${datos.experiencia || '-'}
Situación actual: ${datos.situacion || '-'}
Disponibilidad: ${datos.disponibilidad || '-'}
Motivación: ${datos.motivacion || '-'}
Otra inmobiliaria: ${datos.otraInmobiliaria || '-'}
Fondo inicial: ${datos.fondoInicial || '-'}
Modelo comisión: ${datos.modeloComision || '-'}

[Le compartí el test DISC y le pedí su hoja de vida. Queda a la espera de tu contacto.]`;
}

function formatResumenComprador(telefono, datos) {
  return `🔔 Nuevo lead comprador

Contacto: ${datos.nombre || '-'} · ${telefono}
Tipo: ${datos.tipo || '-'}
Sector: ${datos.sector || '-'}
Dormitorios: ${datos.dormitorios || '-'}
Presupuesto: ${datos.presupuesto || '-'}`;
}

function formatResumenArrendatario(telefono, datos) {
  return `🔔 Nuevo lead arrendatario

Contacto: ${datos.nombre || '-'} · ${telefono}
Tipo: ${datos.tipo || '-'}
Sector: ${datos.sector || '-'}
Dormitorios: ${datos.dormitorios || '-'}
Presupuesto mensual: ${datos.presupuesto || '-'}`;
}

async function handleTrigger(sock, trigger, remitente, datos) {
  const numeroLimpio = remitente.replace('@s.whatsapp.net', '');

  try {
    switch (trigger) {
      case 'HANDOFF_PROPIETARIO': {
        const asesor = await guardias.getAsesorDeGuardia();
        if (asesor) {
          const resumen = require('./src/scheduler').formatResumenPropietario(numeroLimpio, datos);
          await sock.sendMessage(asesor.whatsapp + '@s.whatsapp.net', { text: resumen });
          memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true } });
          stats.logEvent('handoff_propietario', numeroLimpio);
          console.log(`[handoff] Propietario derivado a ${asesor.nombre}`);
        } else {
          memory.set(numeroLimpio, {
            followupPendiente: true,
            datos: { ...datos, handoffListo: true },
          });
          stats.logEvent('fuera_horario', numeroLimpio);
          console.log('[handoff] Fuera de horario — lead encolado');
        }
        break;
      }

      case 'HANDOFF_IMBABURA_NICOLE': {
        const resumen = require('./src/scheduler').formatResumenPropietario(numeroLimpio, { ...datos, zona: 'Imbabura' });
        if (process.env.WHATSAPP_NICOLE) {
          await sock.sendMessage(process.env.WHATSAPP_NICOLE + '@s.whatsapp.net', { text: resumen });
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true } });
        stats.logEvent('handoff_imbabura', numeroLimpio);
        console.log(`[handoff] Propietario Imbabura derivado a Nicole`);
        break;
      }

      case 'FOLLOWUP_PROPIETARIO': {
        memory.set(numeroLimpio, {
          followupPendiente: true,
          datos: { ...datos, handoffListo: true },
        });
        stats.logEvent('fuera_horario', numeroLimpio);
        console.log('[followup] Propietario encolado para próximo turno');
        break;
      }

      case 'FOLLOWUP_PROPIETARIO_FUERA_COBERTURA': {
        memory.set(numeroLimpio, {
          datos: { ...datos, fueraCobertura: true },
        });
        console.log('[followup] Propietario fuera de cobertura — registrado para 30 días');
        break;
      }

      case 'HANDOFF_ASESOR': {
        const resumen = formatResumenAsesor(numeroLimpio, datos);
        if (process.env.WHATSAPP_NICOLE) {
          await sock.sendMessage(process.env.WHATSAPP_NICOLE + '@s.whatsapp.net', { text: resumen });
        }
        if (process.env.WHATSAPP_GRUPO_RECLUTAMIENTO) {
          await sock.sendMessage(process.env.WHATSAPP_GRUPO_RECLUTAMIENTO + '@g.us', { text: resumen });
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true } });
        stats.logEvent('handoff_asesor', numeroLimpio);
        console.log(`[handoff] Asesor derivado a Nicole`);
        break;
      }

      case 'FOLLOWUP_ASESOR': {
        memory.set(numeroLimpio, {
          datos: { ...datos, descalificado: datos.descalificado || false },
        });
        console.log('[followup] Asesor registrado para follow-up');
        break;
      }

      case 'HANDOFF_COMPRADOR': {
        if (process.env.WHATSAPP_BACKUP) {
          const resumen = formatResumenComprador(numeroLimpio, datos);
          await sock.sendMessage(process.env.WHATSAPP_BACKUP + '@s.whatsapp.net', { text: resumen });
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true } });
        stats.logEvent('handoff_comprador', numeroLimpio);
        break;
      }

      case 'HANDOFF_ARRENDATARIO': {
        if (process.env.WHATSAPP_BACKUP) {
          const resumen = formatResumenArrendatario(numeroLimpio, datos);
          await sock.sendMessage(process.env.WHATSAPP_BACKUP + '@s.whatsapp.net', { text: resumen });
        }
        memory.set(numeroLimpio, { datos: { ...datos, handoffListo: true } });
        stats.logEvent('handoff_arrendatario', numeroLimpio);
        break;
      }

      case 'HANDOFF_GENERAL': {
        if (process.env.WHATSAPP_BACKUP) {
          const texto = `🔔 Consulta general\n\nContacto: ${numeroLimpio}\nMensaje sin flujo definido. Requiere atención manual.`;
          await sock.sendMessage(process.env.WHATSAPP_BACKUP + '@s.whatsapp.net', { text: texto });
        }
        stats.logEvent('handoff_general', numeroLimpio);
        break;
      }
    }
  } catch (e) {
    console.error(`[handoff] Error procesando ${trigger}:`, e.message);
  }
}

function handleOverrideCommand(texto, remitente) {
  const numeroLimpio = remitente.replace('@s.whatsapp.net', '');
  if (!NUMEROS_AUTORIZADOS.includes(numeroLimpio)) return false;

  // Formato: !guardia nombre completo 593XXXXXXXXX HH:MM
  const match = texto.match(/^!guardia\s+(.+?)\s+(593\d{9})\s+(\d{1,2}:\d{2})$/i);
  if (!match) return 'formato_incorrecto';

  const nombre = match[1].trim();
  const telefono = match[2].trim();
  const hora = match[3].trim();
  guardias.setOverride(nombre, telefono, hora);
  return true;
}

let isConnecting = false;
let lastQR = null;
let waConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // tope de 5 minutos entre reintentos

function nextDelay() {
  reconnectAttempts++;
  return Math.min(3000 * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY);
}

function renderStatsPage(fechaFiltro) {
  const s = stats.getStats(fechaFiltro);
  const desde = new Date(s.instaladoDesde).toLocaleDateString('es-EC');
  const actualizado = new Date().toLocaleString('es-EC');

  const box = (valor, label) => `
    <div style="background:#f3f4f6;border-radius:12px;padding:24px;text-align:center;">
      <div style="font-size:32px;font-weight:800;color:#0b3d2e;">${valor}</div>
      <div style="color:#555;margin-top:4px;">${label}</div>
    </div>`;

  const flujoLabels = {
    propietario: 'Propietarios',
    asesor: 'Prospectos asesor',
    comprador: 'Compradores',
    arrendatario: 'Arrendatarios',
  };
  const filasFlujo = Object.entries(s.porFlujo)
    .map(([flujo, cantidad]) => `<tr><td style="padding:4px 12px;">${flujoLabels[flujo] || flujo}</td><td style="padding:4px 12px;text-align:right;font-weight:700;">${cantidad}</td></tr>`)
    .join('');

  return `
    <html>
      <head>
        <meta http-equiv="refresh" content="60">
        <meta charset="utf-8">
      </head>
      <body style="background:#0b3d2e;min-height:100vh;margin:0;display:flex;justify-content:center;align-items:flex-start;padding:40px 16px;font-family:sans-serif;">
        <div style="background:white;border-radius:20px;padding:32px;max-width:600px;width:100%;">
          <h2 style="margin:0;color:#0b3d2e;">🏠 REMAX Impacta — Valentina</h2>
          <p style="color:#666;margin-top:4px;">Estadísticas del agente desde ${desde}</p>

          <form method="GET" action="/stats" style="margin:16px 0;display:flex;gap:8px;align-items:center;">
            <input type="date" name="fecha" value="${fechaFiltro || ''}" style="padding:6px 10px;border-radius:8px;border:1px solid #ccc;">
            <button type="submit" style="padding:6px 14px;border-radius:8px;border:none;background:#0b3d2e;color:white;cursor:pointer;">Filtrar</button>
            <a href="/stats" style="color:#0b3d2e;text-decoration:underline;">Ver todo</a>
          </form>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px;">
            ${box(s.leadsAtendidos, 'Leads atendidos')}
            ${box(s.fichasEnviadas, 'Fichas enviadas')}
            ${box(s.leadsDerivados, 'Leads derivados')}
            ${box(s.fueraHorario, 'Fuera de horario')}
          </div>

          <h3 style="color:#0b3d2e;margin-top:28px;">Desglose por tipo de lead</h3>
          <table style="width:100%;border-collapse:collapse;">${filasFlujo}</table>

          <hr style="margin-top:24px;border:none;border-top:1px solid #eee;">
          <p style="color:#999;font-size:13px;text-align:center;">Actualizado: ${actualizado} · Se refresca cada 60s</p>
        </div>
      </body>
    </html>
  `;
}

function startQRServer() {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');

    if (parsedUrl.pathname === '/stats') {
      const fechaFiltro = parsedUrl.searchParams.get('fecha') || null;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStatsPage(fechaFiltro));
      return;
    }

    if (req.url !== '/qr' && req.url !== '/') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (waConnected) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>✅ WhatsApp ya está conectado.</h2>');
      return;
    }

    if (!lastQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Generando QR... refrescá en unos segundos.</h2>');
      return;
    }

    try {
      const dataUrl = await QRCode.toDataURL(lastQR, { width: 320 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <head><meta http-equiv="refresh" content="20"></head>
          <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px;">
            <h2>Escaneá con WhatsApp → Dispositivos vinculados</h2>
            <img src="${dataUrl}" />
          </body>
        </html>
      `);
    } catch (e) {
      res.writeHead(500);
      res.end('Error generando QR: ' + e.message);
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[qr] Servidor QR escuchando en puerto ${PORT}`));
}

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
      return { conversation: '' };
    },
  });

  sock.ev.on('creds.update', saveCreds);


  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      console.log('\n📱 Escaneá este QR con WhatsApp → Dispositivos vinculados (o abrí /qr en el navegador):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      isConnecting = false;
      waConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[ws] Conexión cerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        const delay = nextDelay();
        console.log(`[ws] Reintentando en ${Math.round(delay / 1000)}s (intento ${reconnectAttempts})`);
        setTimeout(() => connectToWhatsApp(), delay);
      } else {
        // Sesión deslogueada: las credenciales viejas ya no sirven.
        // Borramos solo el CONTENIDO de SESSION_PATH (no la carpeta en sí,
        // que es el punto de montaje del volumen y no se puede eliminar).
        console.log('[ws] Sesión deslogueada — limpiando credenciales para generar QR nuevo');
        try {
          for (const entry of fs.readdirSync(SESSION_PATH)) {
            fs.rmSync(path.join(SESSION_PATH, entry), { recursive: true, force: true });
          }
        } catch (e) {
          console.error('[ws] Error limpiando sesión:', e.message);
        }
        const delay = nextDelay();
        console.log(`[ws] Reintentando en ${Math.round(delay / 1000)}s (intento ${reconnectAttempts})`);
        setTimeout(() => connectToWhatsApp(), delay);
      }
    } else if (connection === 'open') {
      isConnecting = false;
      waConnected = true;
      lastQR = null;
      reconnectAttempts = 0;
      console.log('[ws] Conectado a WhatsApp ✅');
      scheduler.init(sock);
    }
  });

  sock.ev.process(async (events) => {
    if (!events['messages.upsert']) return;
    const { messages, type } = events['messages.upsert'];
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const remitente = msg.key.remoteJid;
      if (!remitente || remitente.endsWith('@g.us')) continue; // ignorar grupos

      const texto =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!texto) continue;

      console.log(`[msg] ${remitente}: ${texto}`);

      // Override de guardia
      if (texto.startsWith('!guardia')) {
        const procesado = handleOverrideCommand(texto, remitente);
        if (procesado === true) {
          await sock.sendMessage(remitente, { text: '✅ Override de guardia activado.' });
        } else if (procesado === 'formato_incorrecto') {
          await sock.sendMessage(remitente, {
            text: '⚠️ Formato incorrecto. Usá:\n!guardia Nombre Apellido 593XXXXXXXXX HH:MM\n\nEjemplo:\n!guardia Carlos López 593987654321 17:30',
          });
        }
        continue;
      }

      const numeroLimpio = remitente.replace('@s.whatsapp.net', '');
      const estado = memory.get(numeroLimpio);

      // Si es el primer mensaje de este número, registrar lead atendido
      if (estado.historial.length === 0) {
        stats.logEvent('lead_atendido', numeroLimpio);
      }

      // Agregar mensaje al historial
      memory.addMessage(numeroLimpio, 'user', texto);

      let historial = estado.historial.filter(m => m.role === 'user' || m.role === 'assistant');

      // Llamar a Claude
      let respuesta;
      try {
        respuesta = await chat(historial);
      } catch (e) {
        console.error('[claude] Error:', e.message);
        await sock.sendMessage(remitente, {
          text: 'Hubo un inconveniente técnico. Por favor intente nuevamente en unos minutos.',
        });
        continue;
      }

      // Detectar triggers (CONSENT_GRANTED se procesa aparte — puede venir junto a otro trigger)
      const trigger = extractTrigger(respuesta);
      const consentEnEstaRespuesta = respuesta.includes('[CONSENT_GRANTED]');
      const textoLimpio = cleanResponse(respuesta);

      // Guardar respuesta en historial
      memory.addMessage(numeroLimpio, 'assistant', respuesta);

      // Marcar consentimiento si aplica
      if (consentEnEstaRespuesta) {
        memory.set(numeroLimpio, { consentimiento: true });
        console.log(`[consent] Consentimiento registrado para ${numeroLimpio}`);
      }

      // Enviar respuesta al usuario
      if (textoLimpio) {
        try {
          await sock.sendMessage(remitente, { text: textoLimpio });
        } catch (e) {
          console.error(`[ws] Error enviando mensaje a ${remitente}:`, e.message);
        }
      }

      // Procesar trigger principal (excluye CONSENT_GRANTED que ya fue manejado arriba)
      if (trigger && trigger !== 'CONSENT_GRANTED') {
        const estadoActual = memory.get(numeroLimpio);

        // Detectar flujo desde el trigger para extraer datos correctamente
        const flujoDelTrigger =
          trigger.includes('PROPIETARIO') || trigger.includes('IMBABURA') ? 'propietario' :
          trigger.includes('ASESOR') ? 'asesor' :
          trigger.includes('COMPRADOR') ? 'comprador' :
          trigger.includes('ARRENDATARIO') ? 'arrendatario' : null;

        let datosExtraidos = estadoActual.datos || {};
        if (flujoDelTrigger) {
          stats.logEvent(`flujo_${flujoDelTrigger}`, numeroLimpio);
          const historialActual = estadoActual.historial.filter(m => m.role === 'user' || m.role === 'assistant');
          const extraidos = await extraerDatos(historialActual, flujoDelTrigger);
          datosExtraidos = { ...datosExtraidos, ...extraidos };
          memory.set(numeroLimpio, { datos: datosExtraidos });
        }

        await handleTrigger(sock, trigger, remitente, datosExtraidos);
      }
    }
  });

  return sock;
}

startQRServer();
connectToWhatsApp().catch(console.error);
