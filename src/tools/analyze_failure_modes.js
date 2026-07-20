// src/tools/analyze_failure_modes.js
// PFMEA/DFMEA cuantitativo (ISO 9001:2015 — Cláusula 6.1, Etapa 3: Planificación y Riesgos).
// Metodología AIAG FMEA-4 / VDA 6.3: RPN = Severity (S) x Occurrence (O) x Detectability (D).
// isoEvent: "fmea_analysis_result".
export const meta = {
  id: 'analyze_failure_modes',
  name: 'Análisis de Modos de Falla (FMEA)',
  version: '1.0.0',
  category: 'maintenance',
  consumes: [],
  produces: ['FMEA_CRITICAL_FOUND'],
  description: 'Ejecuta análisis cuantitativo PFMEA/DFMEA y RCM (ISO 9001 cláusula 6.1): calcula RPN por modo de falla, aplica el árbol de decisión RCM y deriva la estrategia de mantenimiento dominante.'
};

// Biblioteca de modos de falla por tipo de activo. Factores S/O/D en escala 1-10 (AIAG FMEA-4).
const FAILURE_MODE_LIBRARY = {
  default: [
    {
      mode: 'Desgaste abrasivo de rodamiento',
      function: 'Transmisión de par/rotación',
      failure_effect: 'Vibración excesiva / parada imprevista',
      severity: 8,
      occurrence: 6,
      detectability: 5,
      recommended_action: 'Implementar monitoreo de vibración ISO 10816 y establecer intervalo de lubricación preventiva'
    },
    {
      mode: 'Pérdida de lubricación por contaminación',
      function: 'Reducción de fricción interna',
      failure_effect: 'Sobrecalentamiento → falla catastrófica',
      severity: 9,
      occurrence: 4,
      detectability: 6,
      recommended_action: 'Instalar sensor de temperatura en carcasa y definir límite de alarma temprana'
    },
    {
      mode: 'Fatiga de material en eje de transmisión',
      function: 'Transmisión de carga mecánica',
      failure_effect: 'Fractura súbita → parada total de línea',
      severity: 10,
      occurrence: 2,
      detectability: 7,
      recommended_action: 'Incluir inspección por ultrasonido cada 3 meses en el plan de PM'
    }
  ],
  motor: [
    {
      mode: 'Falla de aislamiento de bobinado',
      function: 'Conversión energía eléctrica → mecánica',
      failure_effect: 'Cortocircuito → disparo de protecciones / incendio',
      severity: 10,
      occurrence: 3,
      detectability: 4,
      recommended_action: 'Prueba de aislamiento (Megger) anual y monitoreo de corriente por fase'
    },
    {
      mode: 'Desbalance de rotor por acumulación de proceso',
      function: 'Rotación a velocidad nominal',
      failure_effect: 'Vibración → fatiga de cojinetes y estructura',
      severity: 7,
      occurrence: 5,
      detectability: 3,
      recommended_action: 'Balanceo dinámico semestral y limpieza de rotor en cada PM'
    },
    {
      mode: 'Corrosión en terminales de conexión',
      function: 'Conexión eléctrica segura',
      failure_effect: 'Alta resistencia de contacto → calentamiento → falla intermitente',
      severity: 6,
      occurrence: 6,
      detectability: 5,
      recommended_action: 'Termografía anual en tablero de potencia; aplicar protector de contactos'
    }
  ],
  pump: [
    {
      mode: 'Cavitación por subpresión de succión',
      function: 'Transporte de fluido a presión nominal',
      failure_effect: 'Erosión de impeler → pérdida de caudal y presión',
      severity: 8,
      occurrence: 5,
      detectability: 4,
      recommended_action: 'Monitorear presión de succión en línea; ajustar NPSH disponible'
    },
    {
      mode: 'Fuga en sello mecánico',
      function: 'Sellado del eje contra fuga de proceso',
      failure_effect: 'Contaminación del área / pérdida de producto',
      severity: 7,
      occurrence: 7,
      detectability: 2,
      recommended_action: 'Reemplazar sello mecánico según intervalo del fabricante o por señal de fuga'
    },
    {
      mode: 'Obstrucción de impulsor',
      function: 'Succión y descarga del fluido',
      failure_effect: 'Reducción de caudal → parada por protección térmica',
      severity: 6,
      occurrence: 4,
      detectability: 3,
      recommended_action: 'Instalar filtro en línea de succión; revisar en cada paro programado'
    }
  ]
};

function selectFailureModes (assetType) {
  const type = (assetType || '').toLowerCase();
  if (type.includes('motor')) return FAILURE_MODE_LIBRARY.motor;
  if (type.includes('pump') || type.includes('bomba')) return FAILURE_MODE_LIBRARY.pump;
  return FAILURE_MODE_LIBRARY.default;
}

// RPN = Severity x Occurrence x Detectability (AIAG FMEA-4). Umbral crítico: RPN >= 100 (§4.4).
const RPN_CRITICAL_THRESHOLD = 100;

function calculateRPN (mode) {
  return mode.severity * mode.occurrence * mode.detectability;
}

// ─── Árbol de decisión RCM ───────────────────────────────────────────────────
// Se resuelve con las 3 banderas del payload: ¿la falla es evidente al ocurrir?
// ¿compromete seguridad? ¿compromete producción? Lógica:
//   - Oculta + compromete seguridad         -> rediseño (la tarea preventiva no basta)
//   - Evidente + compromete seguridad       -> PM-condition-based (monitoreo continuo)
//   - Oculta + compromete solo producción   -> PM-time-based (inspección programada / failure-finding)
//   - Evidente + compromete solo producción -> PM-condition-based (monitorear y programar el paro óptimo)
//   - Sin impacto en seguridad ni producción -> run-to-failure (monitorear cuesta más que dejarla fallar)
const RCM_STRATEGY = {
  REDESIGN: 'rediseño',
  PM_TIME_BASED: 'PM-time-based',
  PM_CONDITION_BASED: 'PM-condition-based',
  RUN_TO_FAILURE: 'run-to-failure'
};

function decideRcmStrategy (isEvident, affectsSafety, affectsProduction) {
  if (!isEvident && affectsSafety) return RCM_STRATEGY.REDESIGN;
  if (affectsSafety) return RCM_STRATEGY.PM_CONDITION_BASED;
  if (!isEvident && affectsProduction) return RCM_STRATEGY.PM_TIME_BASED;
  if (affectsProduction) return RCM_STRATEGY.PM_CONDITION_BASED;
  return RCM_STRATEGY.RUN_TO_FAILURE;
}

export async function handler (inputEvent) {
  const input = inputEvent.data || {};
  const assetInfo = inputEvent.asset || {};

  const assetId = input.assetId || assetInfo.asset_id || 'asset-undefined';
  const analysisType = ['fmea', 'rcm', 'both'].includes(input.analysisType) ? input.analysisType : 'fmea';
  const assetType = assetInfo.asset_type || input.assetType || 'default';

  const runRcm = analysisType === 'rcm' || analysisType === 'both';

  // Banderas del árbol RCM, leídas del payload. Si faltan (p.ej. analysisType
  // no incluye 'rcm'), se asumen valores conservadores: falla evidente, sin
  // riesgo de seguridad, con impacto en producción — el escenario típico de
  // un activo bajo monitoreo de condición.
  const isEvident = typeof input.isEvident === 'boolean' ? input.isEvident : true;
  const affectsSafety = typeof input.affectsSafety === 'boolean' ? input.affectsSafety : false;
  const affectsProduction = typeof input.affectsProduction === 'boolean' ? input.affectsProduction : true;

  const rcmStrategy = runRcm ? decideRcmStrategy(isEvident, affectsSafety, affectsProduction) : null;

  // El RPN se calcula siempre (independiente de analysisType): es la base
  // numérica de criticidad que necesita rule-maint-004/rule-pkg-002 vía
  // criticalItems, incluso en un análisis puramente 'rcm'.
  const rawModes = selectFailureModes(assetType);
  const failureModes = rawModes.map(m => {
    const rpn = calculateRPN(m);
    const entry = {
      mode: m.mode,
      function: m.function,
      failure_effect: m.failure_effect,
      severity: m.severity,
      occurrence: m.occurrence,
      detectability: m.detectability,
      rpn,
      // Umbral estricto de la especificación: RPN > 100 (no >=).
      is_critical: rpn > RPN_CRITICAL_THRESHOLD,
      recommended_action: m.recommended_action
    };
    if (runRcm) {
      entry.rcm_strategy = rcmStrategy;
    }
    return entry;
  });

  // Ordenar por RPN descendente (los más críticos primero)
  failureModes.sort((a, b) => b.rpn - a.rpn);

  const criticalItems = failureModes.filter(m => m.is_critical).length;

  // Estrategia de mantenimiento dominante: si se ejecutó RCM, su árbol de
  // decisión manda (es el método más riguroso); si es FMEA puro, se deriva
  // del RPN máximo como antes.
  const maxRpn = failureModes[0]?.rpn ?? 0;
  let maintenanceStrategy;
  if (runRcm) {
    maintenanceStrategy = rcmStrategy;
  } else if (maxRpn >= 200) {
    maintenanceStrategy = 'predictive';
  } else if (maxRpn >= 100) {
    maintenanceStrategy = 'preventive';
  } else {
    maintenanceStrategy = 'corrective';
  }

  // Cualquier modo con RPN > 100 justifica escalar a 'critical' (AIAG FMEA-4 §4.4)
  const severity = criticalItems >= 1 ? 'critical' : 'medium';

  return {
    event: {
      type: 'FMEA_CRITICAL_FOUND',
      category: 'maintenance',
      severity
    },
    asset: inputEvent.asset,
    data: {
      asset_id: assetId,
      analysis_type: analysisType,
      failure_modes: failureModes,
      // criticalItems se mantiene en camelCase: es el campo exacto que evalúan los
      // triggerCondition de rule-maint-004 y rule-pkg-002 ("criticalItems > 0").
      criticalItems,
      maintenance_strategy: maintenanceStrategy,
      rpn_threshold: RPN_CRITICAL_THRESHOLD,
      methodology: 'AIAG FMEA-4 / VDA 6.3',
      iso_clause: '6.1',
      iso_stage: 'Planificación y Riesgos'
    }
  };
}
