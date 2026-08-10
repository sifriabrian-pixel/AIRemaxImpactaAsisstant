// Configuración de sesiones de entrevista — editar via variables de entorno en Railway

function getSesionConfig() {
  return {
    dia: process.env.SESION_DIA || 'jueves',
    fecha: process.env.SESION_FECHA || '',
    hora: process.env.SESION_HORA || '14:30',
    cupoMax: parseInt(process.env.SESION_CUPO_MAX || '10'),
    diaSiguiente: process.env.SESION_DIA_SIGUIENTE || 'jueves',
    fechaSiguiente: process.env.SESION_FECHA_SIGUIENTE || '',
  };
}

function getIbarraSesionConfig() {
  return {
    dia: process.env.SESION_IBARRA_DIA || 'jueves',
    fecha: process.env.SESION_IBARRA_FECHA || '',
    hora: process.env.SESION_IBARRA_HORA || '14:30',
    cupoMax: parseInt(process.env.SESION_IBARRA_CUPO_MAX || '10'),
    diaSiguiente: process.env.SESION_IBARRA_DIA_SIGUIENTE || 'jueves',
    fechaSiguiente: process.env.SESION_IBARRA_FECHA_SIGUIENTE || '',
  };
}

// Cuenta agendados para una sesión específica por fecha
function getCuposUsados(sesionFecha, todos) {
  if (!sesionFecha) return 0;
  return Object.values(todos).filter(e =>
    e.datos?.entrevistaConfirmada === true &&
    e.datos?.entrevistaFecha === sesionFecha
  ).length;
}

module.exports = { getSesionConfig, getIbarraSesionConfig, getCuposUsados };
