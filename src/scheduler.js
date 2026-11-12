const cron = require('node-cron');
const memory = require('./memory');
const whatsapp = require('./whatsapp');
const stats = require('./stats');
const { getAsesorDeGuardia } = require('./guardias');

// Después de estos eventos no tiene sentido enviar seguimientos de diciembre
const EVENTO_FIN_MS = new Date('2026-12-04T00:00:00-05:00').getTime();

function nicoleParam(texto) {
  return texto.replace(/\n+/g, ' | ').replace(/\s{5,}/g, '    ');
}


function init() {
  // Cada minuto: revisar follow-ups de propietarios fuera de horario
  cron.schedule('* * * * *', async () => {
    const asesor = await getAsesorDeGuardia();

    const todos = memory.getAll();
    for (const [numero, estado] of Object.entries(todos)) {
      if (estado.followupPendiente && estado.flujo === 'propietario' && estado.datos?.handoffListo) {
        if (asesor) {
          try {
            await enviarResumenPropietario(asesor, numero, estado.datos);
            memory.set(numero, { followupPendiente: false });
            console.log(`[scheduler] Resumen enviado a ${asesor.nombre} por lead ${numero}`);
          } catch (e) {
            console.error('[scheduler] Error enviando resumen:', e.message);
          }
        } else if (!estado.nicoleNotificadaSinAsesor) {
          // Sin asesor disponible: notificar a Nicole y liberar la cola
          const nicoleNumero = process.env.WHATSAPP_NICOLE;
          if (nicoleNumero) {
            try {
              const resumen = formatResumenPropietario(numero, estado.datos);
              const msgNicole = `📋 CAPTACIÓN — ${estado.datos?.nombre || numero} · sin asesor disponible\n\n` + resumen;
              await whatsapp.sendTemplate(nicoleNumero, 'notificacion_lead_nicole_v2', 'es_EC', { '1': nicoleParam(msgNicole) });
              console.log(`[scheduler] Nicole notificada por lead sin asesor: ${numero}`);
            } catch (e) {
              console.error('[scheduler] Error notificando Nicole (sin asesor):', e.message);
            }
          }
          memory.set(numero, { followupPendiente: false, nicoleNotificadaSinAsesor: true });
        }
      }
    }
  });

  // Follow-ups a leads que no completaron + recordatorios de entrevista (revisar cada hora)
  cron.schedule('0 * * * *', async () => {
    const ahora = new Date();
    const todos = memory.getAll();

    for (const [numero, estado] of Object.entries(todos)) {
      if (!estado.ultimoMensaje) continue;
      const diff = (ahora - new Date(estado.ultimoMensaje)) / 1000 / 60 / 60; // horas

      if (estado.flujo === 'propietario' && !estado.datos?.handoffListo) {
        if (diff >= 24 && !estado.followup24h) {
          await enviarFollowup(numero, estado, '24h_propietario');
          memory.set(numero, { followup24h: true });
        }
      }

      if (estado.flujo === 'evento' && !estado.datos?.handoffListo && ahora.getTime() < EVENTO_FIN_MS) {
        if (diff >= 72 && !estado.followup72h) {
          await enviarFollowup(numero, estado, '72h_asesor');
          memory.set(numero, { followup72h: true });
        } else if (diff >= 24 && !estado.followup24h) {
          await enviarFollowup(numero, estado, '24h_asesor');
          memory.set(numero, { followup24h: true });
        }
      }

      // Reactivar propietarios fuera de cobertura a los 30 días (por si cambió su situación)
      if (estado.datos?.fueraCobertura && diff >= 720 && !estado.followup30d_cobertura) {
        await enviarFollowup(numero, estado, '30d_cobertura');
        memory.set(numero, { followup30d_cobertura: true });
      }

    }
  });
}


async function enviarFollowup(numero, estado, tipo) {
  const nombre = estado.datos?.nombre || '';
  const sector = estado.datos?.sector || '';

  const textosPorTipo = {
    '24h_propietario': `[Seguimiento automático 24h] Hola${nombre ? ' ' + nombre : ''}, ¿pudo revisar la información que le compartimos sobre vender su propiedad en ${sector || 'su zona'}? Quedamos a su disposición 🏠`,
    '24h_asesor':      `[Seguimiento automático 24h] Hola${nombre ? ' ' + nombre : ''}, ¿pudiste pensar si te animas a nuestro evento de diciembre? Todavía hay cupos — con gusto te confirmo los detalles.`,
    '72h_asesor':      `[Seguimiento automático 72h] Hola${nombre ? ' ' + nombre : ''}, los eventos de diciembre (Ibarra y Quito) se acercan. Si quieres asistir, es el momento — los cupos son limitados.`,
    '7d_asesor':       `[Seguimiento automático 7d] Hola${nombre ? ' ' + nombre : ''}, hace una semana conversamos sobre la oportunidad en RE/MAX Impacta. ¿Sigue siendo de su interés?`,
    '30d_asesor':      `[Reactivación 30d] Hola${nombre ? ' ' + nombre : ''}, le escribimos desde RE/MAX Impacta. ¿Ha tenido oportunidad de evaluar unirse a nuestro equipo?`,
    '48h_propietario': `[Seguimiento automático 48h] ${nombre || 'Hola'}, solo quería asegurarme de que no quedó con dudas. Cuando quiera retomar, acá estamos 🏠`,
    '30d_cobertura':   `[Reactivación 30d] ¡Hola${nombre ? ' ' + nombre : ''}! Le escribo desde RE/MAX Impacta. ¿Su propiedad sigue disponible? Si la situación cambió y necesita apoyo, con gusto le orientamos 🏠`,
  };

  // Todos los follow-ups usan plantillas aprobadas (obligatorio fuera de la ventana de 24hs)
  const plantillas = {
    '24h_propietario': () => whatsapp.sendTemplate(numero, 'recordatorio_propietario_24h', 'es_EC', {
      nombre: nombre || 'cliente',
      sector: sector || 'su zona',
    }),
    '24h_asesor':  () => whatsapp.sendTemplate(numero, 'seguimiento_asesor_24h',  'es_EC', { customer_name: nombre || 'cliente' }),
    '72h_asesor':  () => whatsapp.sendTemplate(numero, 'seguimiento_asesor_72h',  'es_EC', { nombre: nombre || 'cliente' }),
    '7d_asesor':   () => whatsapp.sendTemplate(numero, 'seguimiento_asesor_7d',   'es_EC', { nombre: nombre || 'cliente' }),
    '30d_asesor':  () => whatsapp.sendTemplate(numero, 'reactivacion_asesor_30d', 'es_EC', { nombre: nombre || 'cliente' }),
  };

  if (plantillas[tipo]) {
    try {
      await plantillas[tipo]();
      memory.addMessage(numero, 'assistant', textosPorTipo[tipo] || `[Seguimiento automático: ${tipo}]`);
      console.log(`[scheduler] Plantilla ${tipo} enviada a ${numero}`);
      // Registrar seguimiento para calcular tasa de reactivación
      if (tipo === '24h_propietario' || tipo === '24h_asesor') stats.logEvent('seguimiento_24h', numero);
      else if (tipo === '72h_asesor') stats.logEvent('seguimiento_72h', numero);
    } catch (e) {
      console.error(`[scheduler] Error enviando plantilla ${tipo} a ${numero}:`, e.message);
    }
    return;
  }

  const texto = textosPorTipo[tipo] || '';
  if (texto) {
    try {
      await whatsapp.sendMessage(numero, texto);
      memory.addMessage(numero, 'assistant', texto);
      console.log(`[scheduler] Followup ${tipo} enviado a ${numero}`);
    } catch (e) {
      console.error(`[scheduler] Error enviando followup ${tipo} a ${numero}:`, e.message);
    }
  }
}

async function enviarResumenPropietario(asesor, numeroLead, datos) {
  const resumen = formatResumenPropietario(numeroLead, datos);
  await whatsapp.sendTemplate(asesor.whatsapp, 'notificacion_lead_guardia', 'es_EC', { resumen: nicoleParam(resumen) });
  const nicoleNumero = process.env.WHATSAPP_NICOLE;
  if (nicoleNumero) {
    try {
      const msgNicole = `📋 CAPTACIÓN — ${datos.nombre || numeroLead} → ${asesor.nombre}\n\n` + resumen;
      await whatsapp.sendTemplate(nicoleNumero, 'notificacion_lead_nicole_v2', 'es_EC', { '1': nicoleParam(msgNicole) });
      console.log(`[scheduler] Resumen propietario enviado a Nicole`);
    } catch (e) {
      console.error(`[scheduler] FALLO notificación a Nicole (propietario guardia):`, e.message);
    }
  }
}

function formatResumenPropietario(telefono, datos) {
  return `🔔 Nuevo lead calificado

Propietario: ${datos.nombre || '-'} · ${telefono}
Relación: ${datos.relacion || '-'}

Propiedad: ${datos.tipo || '-'} ${datos.dormitorios || ''} · ${datos.sector || '-'} · ${datos.superficie || '-'}
Operación: ${datos.operacion || '-'}
Motivo: ${datos.motivo || '-'}
Ocupación: ${datos.ocupacion || '-'}
Precio estimado: ${datos.precio || 'necesita tasación'}
Urgencia: ${datos.urgencia || '-'} · trabaja con otra inmobiliaria: ${datos.otraInmobiliaria || '-'}
Disponibilidad: ${datos.disponibilidad || '-'}
Cumpleaños: ${datos.cumpleanos || 'no proporcionó'}

Zona: ${datos.zona || '-'}
Antigüedad: ${datos.antiguedad || 'no informada'}
Prioridad: ${datos.prioridad || 'Media'}
Observación: ${datos.observacion || '-'}`;
}

module.exports = { init, enviarResumenPropietario, formatResumenPropietario };
