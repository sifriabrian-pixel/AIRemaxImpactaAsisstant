const fs = require('fs');
const path = require('path');
const memory = require('./memory');

const STATS_FILE = process.env.SESSION_PATH
  ? path.join(process.env.SESSION_PATH, 'stats.json')
  : path.join(__dirname, '../stats.json');

let events = [];
let instaladoDesde = null;

function load() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      events = data.events || [];
      instaladoDesde = data.instaladoDesde || null;
    }
  } catch (e) {
    console.error('[stats] Error loading:', e.message);
  }
  if (!instaladoDesde) {
    instaladoDesde = new Date().toISOString();
    save();
  }
}

function save() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ events, instaladoDesde }, null, 2));
  } catch (e) {
    console.error('[stats] Error saving:', e.message);
  }
}

function logEvent(tipo, numero) {
  events.push({ tipo, numero, fecha: new Date().toISOString() });
  save();
}

const HANDOFF_TIPOS = [
  'handoff_propietario',
  'handoff_imbabura',
  'handoff_asesor',
  'handoff_comprador',
  'handoff_arrendatario',
  'handoff_general',
];

const FLUJO_TIPOS = ['propietario', 'asesor', 'comprador', 'arrendatario'];

function filtrarPorRango(evts, fechaDesde, fechaHasta) {
  return evts.filter(e => {
    const d = e.fecha.slice(0, 10);
    if (fechaDesde && d < fechaDesde) return false;
    if (fechaHasta && d > fechaHasta) return false;
    return true;
  });
}

const IBARRA_KEYWORDS = ['ibarra', 'imbabura', 'otavalo', 'cotacachi', 'atuntaqui', 'antonio ante', 'pimampiro', 'urcuquí'];
const VALLES_KEYWORDS = ['cumbayá', 'tumbaco', 'sangolquí', 'los chillos', 'chillos', 'conocoto', 'guangopolo', 'valle'];

function clasificarCiudad(datos) {
  const zona = (datos?.zona || '').toLowerCase();
  const sector = (datos?.sector || '').toLowerCase();
  const ref = zona || sector;
  if (!ref) return 'Sin especificar';
  if (ref.includes('fuera')) return 'Fuera de cobertura';
  if (IBARRA_KEYWORDS.some(k => ref.includes(k))) return 'Imbabura';
  if (VALLES_KEYWORDS.some(k => ref.includes(k))) return 'Valles';
  return 'Quito';
}

function calcularTasaLectura(fechaDesde, fechaHasta) {
  const todos = memory.getAll();
  const nicoleNumero = process.env.WHATSAPP_NICOLE || '';
  let leidos = 0;
  let entregadosOLeidos = 0;

  for (const [numero, estado] of Object.entries(todos)) {
    if (estado.esGuardia || numero === nicoleNumero) continue;
    for (const m of estado.historial || []) {
      if (m.role !== 'assistant' || !m.estadoEnvio) continue;
      const d = (m.ts || '').slice(0, 10);
      if (fechaDesde && d < fechaDesde) continue;
      if (fechaHasta && d > fechaHasta) continue;
      if (m.estadoEnvio === 'entregado' || m.estadoEnvio === 'leido') {
        entregadosOLeidos++;
        if (m.estadoEnvio === 'leido') leidos++;
      }
    }
  }

  return entregadosOLeidos > 0 ? Math.round((leidos / entregadosOLeidos) * 100) : null;
}

function serieDiaria(dias = 14) {
  const hoy = new Date();
  const diasArr = [];
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - i);
    diasArr.push(d.toISOString().slice(0, 10));
  }
  const porDia = {};
  for (const dia of diasArr) porDia[dia] = 0;
  for (const e of events) {
    if (e.tipo !== 'lead_atendido') continue;
    const dia = e.fecha.slice(0, 10);
    if (dia in porDia) porDia[dia]++;
  }
  return diasArr.map((fecha) => ({ fecha, cantidad: porDia[fecha] }));
}

function compararPeriodos() {
  const ahora = Date.now();
  const DIA_MS = 24 * 60 * 60 * 1000;

  const contarUnicos = (desde, hasta) => {
    const nums = new Set();
    for (const e of events) {
      if (e.tipo !== 'lead_atendido') continue;
      const t = new Date(e.fecha).getTime();
      if (t >= desde && t < hasta) nums.add(e.numero);
    }
    return nums.size;
  };

  const actual = contarUnicos(ahora - 7 * DIA_MS, ahora);
  const anterior = contarUnicos(ahora - 14 * DIA_MS, ahora - 7 * DIA_MS);
  let cambioPorcentual = null;
  if (anterior > 0) cambioPorcentual = Math.round(((actual - anterior) / anterior) * 100);
  else if (actual > 0) cambioPorcentual = 100;

  return { actual, anterior, cambioPorcentual };
}

function desgloseGeografico(fechaDesde, fechaHasta) {
  const todos = memory.getAll();
  const nicoleNumero = process.env.WHATSAPP_NICOLE || '';
  const filtrados = filtrarPorRango(events, fechaDesde, fechaHasta);
  const numeros = new Set(filtrados.filter(e => e.tipo === 'lead_atendido').map(e => e.numero));

  const conteo = { Quito: 0, Valles: 0, Imbabura: 0, 'Fuera de cobertura': 0, 'Sin especificar': 0 };
  for (const numero of numeros) {
    const estado = todos[numero];
    if (!estado || estado.esGuardia || numero === nicoleNumero) continue;
    const ciudad = clasificarCiudad(estado.datos);
    conteo[ciudad] = (conteo[ciudad] || 0) + 1;
  }
  return conteo;
}

function desgloseOperacionPropietario(fechaDesde, fechaHasta) {
  const todos = memory.getAll();
  const filtrados = filtrarPorRango(events, fechaDesde, fechaHasta);
  const numeros = new Set(filtrados.filter(e => e.tipo === 'flujo_propietario').map(e => e.numero));

  let venta = 0, arriendo = 0, sinEspecificar = 0;
  for (const numero of numeros) {
    const op = (todos[numero]?.datos?.operacion || '').toLowerCase();
    if (op.includes('arriendo')) arriendo++;
    else if (op.includes('venta')) venta++;
    else sinEspecificar++;
  }
  return { venta, arriendo, sinEspecificar };
}

function getStats(fechaDesde, fechaHasta) {
  const filtrados = filtrarPorRango(events, fechaDesde, fechaHasta);

  const porTipo = (tipo) => filtrados.filter(e => e.tipo === tipo);
  const unicos = (lista) => new Set(lista.map(e => e.numero)).size;

  const fichas = filtrados.filter(e => HANDOFF_TIPOS.includes(e.tipo));

  const porFlujo = {};
  for (const flujo of FLUJO_TIPOS) {
    porFlujo[flujo] = unicos(porTipo(`flujo_${flujo}`));
  }

  const leadsAtendidos = unicos(porTipo('lead_atendido'));
  const leadsDerivados = unicos(fichas);
  const tasaCalificacion = leadsAtendidos > 0 ? Math.round((leadsDerivados / leadsAtendidos) * 100) : null;

  const conSeguimiento = unicos([...porTipo('seguimiento_24h'), ...porTipo('seguimiento_72h')]);
  const reactivados = unicos(porTipo('reactivado'));
  const tasaReactivacion = conSeguimiento > 0 ? Math.round((reactivados / conSeguimiento) * 100) : null;

  const operacionPropietario = desgloseOperacionPropietario(fechaDesde, fechaHasta);

  return {
    leadsAtendidos,
    fichasEnviadas: fichas.length,
    leadsDerivados,
    fueraHorario: porTipo('fuera_horario').length,
    porFlujo,
    instaladoDesde,
    tasaCalificacion,
    tasaLectura: calcularTasaLectura(fechaDesde, fechaHasta),
    tasaReactivacion,
    conSeguimiento,
    reactivados,
    serieTendencia: serieDiaria(14),
    comparacionPeriodo: compararPeriodos(),
    desgloseCiudad: desgloseGeografico(fechaDesde, fechaHasta),
    desgloseOperacion: {
      venta: operacionPropietario.venta,
      arriendo: operacionPropietario.arriendo,
      compra: porFlujo.comprador,
      alquiler: porFlujo.arrendatario,
    },
  };
}

const CATEGORIAS = {
  atendidos: ['lead_atendido'],
  fichas: HANDOFF_TIPOS,
  derivados: HANDOFF_TIPOS,
  fuera_horario: ['fuera_horario'],
  reactivados: ['reactivado'],
  flujo_propietario: ['flujo_propietario'],
  flujo_asesor: ['flujo_asesor'],
  flujo_comprador: ['flujo_comprador'],
  flujo_arrendatario: ['flujo_arrendatario'],
};

function listarPorCategoria(categoria, fechaDesde, fechaHasta) {
  const tipos = CATEGORIAS[categoria];
  if (!tipos) return [];

  const filtrados = filtrarPorRango(events, fechaDesde, fechaHasta);
  const lista = filtrados.filter(e => tipos.includes(e.tipo));

  if (categoria !== 'derivados') {
    return [...lista].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  }

  const porNumero = new Map();
  for (const e of lista) {
    const anterior = porNumero.get(e.numero);
    if (!anterior || e.fecha > anterior.fecha) porNumero.set(e.numero, e);
  }
  return [...porNumero.values()].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

load();

module.exports = { logEvent, getStats, listarPorCategoria };
