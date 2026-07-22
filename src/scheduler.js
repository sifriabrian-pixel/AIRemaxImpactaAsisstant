const cron = require('node-cron');
const memory = require('./memory');
const whatsapp = require('./whatsapp');
const { getAsesorDeGuardia } = require('./guardias');

function init() {
  // Cada minuto: revisar follow-ups de propietarios fuera de horario
  cron.schedule('* * * * *', async () => {
    const asesor = await getAsesorDeGuardia();
    if (!asesor) return;

    const todos = memory.getAll();
    for (const [numero, estado] of Object.entries(todos)) {
      if (estado.followupPendiente && estado.flujo === 'propietario' && estado.datos?.handoffListo) {
        try {
          await enviarResumenPropietario(asesor, numero, estado.datos);
          memory.set(numero, { followupPendiente: false });
          console.log(`[scheduler] Resumen enviado a ${asesor.nombre} por lead ${numero}`);
        } catch (e) {
          console.error('[scheduler] Error enviando resumen:', e.message);
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
        if (diff >= 48) {
          await enviarFollowup(numero, estado, '48h_propietario');
        } else if (diff >= 24 && !estado.followup24h) {
          await enviarFollowup(numero, estado, '24h_propietario');
          memory.set(numero, { followup24h: true });
        }
      }

      if (estado.flujo === 'asesor' && !estado.datos?.handoffListo) {
        if (diff >= 168 && !estado.followup7d) { // 7 días
          await enviarFollowup(numero, estado, '7d_asesor');
          memory.set(numero, { followup7d: true });
        } else if (diff >= 72 && !estado.followup72h) {
          await enviarFollowup(numero, estado, '72h_asesor');
          memory.set(numero, { followup72h: true });
        } else if (diff >= 24 && !estado.followup24h) {
          await enviarFollowup(numero, estado, '24h_asesor');
          memory.set(numero, { followup24h: true });
        }
      }

      // Recordatorios de entrevista agendada (24h y 4h antes)
      if (estado.flujo === 'asesor' && estado.datos?.entrevistaConfirmada && estado.datos?.entrevistaFecha) {
        const entrevistaMs = parseFechaHoraEntrevista(estado.datos.entrevistaFecha, estado.datos.entrevistaHora || '14:30');
        if (entrevistaMs) {
          const horasHasta = (entrevistaMs - ahora.getTime()) / (1000 * 60 * 60);
          if (horasHasta > 0 && horasHasta <= 4 && !estado.recordatorio4h) {
            await enviarFollowup(numero, estado, 'recordatorio_entrevista_4h');
            memory.set(numero, { recordatorio4h: true });
          } else if (horasHasta > 4 && horasHasta <= 25 && !estado.recordatorio24h) {
            await enviarFollowup(numero, estado, 'recordatorio_entrevista_24h');
            memory.set(numero, { recordatorio24h: true });
          }
        }
      }

      // Reactivar propietarios fuera de cobertura a los 30 días (por si cambió su situación)
      if (estado.datos?.fueraCobertura && diff >= 720 && !estado.followup30d_cobertura) {
        await enviarFollowup(numero, estado, '30d_cobertura');
        memory.set(numero, { followup30d_cobertura: true });
      }

      // Reactivar asesores descalificados a los 30 días
      if (estado.flujo === 'asesor' && estado.datos?.descalificado && diff >= 720 && !estado.followup30d) {
        await enviarFollowup(numero, estado, '30d_asesor');
        memory.set(numero, { followup30d: true });
      }
    }
  });
}

// fecha: DD/MM/YYYY, hora: HH:MM (Ecuador UTC-5 = UTC+0-5h → sumar 5h para obtener UTC)
function parseFechaHoraEntrevista(fecha, hora) {
  if (!fecha) return null;
  const parts = fecha.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(Number);
  const [h, min] = (hora || '14:30').split(':').map(Number);
  return Date.UTC(y, m - 1, d, h + 5, min, 0);
}

async function enviarFollowup(numero, estado, tipo) {
  const nombre = estado.datos?.nombre || '';
  const sector = estado.datos?.sector || '';
  const entrevistaFecha = estado.datos?.entrevistaFecha || '';
  const entrevistaHora = estado.datos?.entrevistaHora || '14:30';

  const textosPorTipo = {
    '24h_propietario': `[Seguimiento automático 24h] Hola${nombre ? ' ' + nombre : ''}, ¿pudo revisar la información que le compartimos sobre vender su propiedad en ${sector || 'su zona'}? Quedamos a su disposición 🏠`,
    '24h_asesor':      `[Seguimiento automático 24h] Hola${nombre ? ' ' + nombre : ''}, ¿tuvo oportunidad de revisar la información sobre unirse a RE/MAX Impacta? Con gusto le respondemos cualquier duda.`,
    '72h_asesor':      `[Seguimiento automático 72h] Hola${nombre ? ' ' + nombre : ''}, seguimos interesados en su perfil. ¿Le gustaría retomar la conversación sobre su carrera inmobiliaria?`,
    '7d_asesor':       `[Seguimiento automático 7d] Hola${nombre ? ' ' + nombre : ''}, hace una semana conversamos sobre la oportunidad en RE/MAX Impacta. ¿Sigue siendo de su interés?`,
    '30d_asesor':      `[Reactivación 30d] Hola${nombre ? ' ' + nombre : ''}, le escribimos desde RE/MAX Impacta. ¿Ha tenido oportunidad de evaluar unirse a nuestro equipo?`,
    '48h_propietario': `[Seguimiento automático 48h] ${nombre || 'Hola'}, solo quería asegurarme de que no quedó con dudas. Cuando quiera retomar, acá estamos 🏠`,
    '30d_cobertura':   `[Reactivación 30d] ¡Hola${nombre ? ' ' + nombre : ''}! Le escribo desde RE/MAX Impacta. ¿Su propiedad sigue disponible? Si la situación cambió y necesita apoyo, con gusto le orientamos 🏠`,
    'recordatorio_entrevista_24h': `[Recordatorio 24h] Hola${nombre ? ' ' + nombre : ''} 👋 Le recuerdo su entrevista mañana${entrevistaFecha ? ' ' + entrevistaFecha : ''} a las ${entrevistaHora}, en Centro Comercial la Y, Local 025, Quito, con Nicole Vinueza. ¿Confirma su asistencia?`,
    'recordatorio_entrevista_4h':  `[Recordatorio 4h] ${nombre || 'Hola'}, en unas horas es su entrevista — hoy a las ${entrevistaHora} en Centro Comercial la Y, Local 025, Quito. La espera Nicole Vinueza. ¿Todo listo para asistir?`,
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
    // Plantillas pendientes de crear en Meta Business Suite:
    'recordatorio_entrevista_24h': () => whatsapp.sendTemplate(numero, 'recordatorio_entrevista_24h', 'es_EC', { nombre: nombre || 'candidato', fecha: entrevistaFecha || '', hora: entrevistaHora }),
    'recordatorio_entrevista_4h':  () => whatsapp.sendTemplate(numero, 'recordatorio_entrevista_4h',  'es_EC', { nombre: nombre || 'candidato', hora: entrevistaHora }),
  };

  if (plantillas[tipo]) {
    try {
      await plantillas[tipo]();
      memory.addMessage(numero, 'assistant', textosPorTipo[tipo] || `[Seguimiento automático: ${tipo}]`);
      console.log(`[scheduler] Plantilla ${tipo} enviada a ${numero}`);
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
  await whatsapp.sendMessage(asesor.whatsapp, resumen);
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
