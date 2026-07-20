// scripts/test_analyze_failure_modes.js
//
// Smoke test del handler — aislado, sin bus, sin Docker, sin Postgres.
// Uso: node scripts/test_analyze_failure_modes.js
//
// Valida:
//   - El handler ejecuta sin excepciones y retorna la estructura canónica {event, asset, data}
//   - event.type === 'FMEA_CRITICAL_FOUND'
//   - data.failure_modes es array con al menos 1 elemento
//   - data.criticalItems >= 1 (umbral estricto RPN > 100, AIAG FMEA-4 §4.4)
//   - Cada modo de falla tiene rpn = severity x occurrence x detectability
//   - data.maintenance_strategy en enum válido
//   - criticalItems >= 1 escala severity del evento a 'critical'
//   - Funciona con distintos asset_type (motor, pump, default)
//   - analysisType 'fmea' | 'rcm' | 'both' y las 4 estrategias del árbol RCM
//     (PM-time-based, PM-condition-based, rediseño, run-to-failure)
//
// meta.consumes está vacío hoy: no hay regla en communication-rules.json que
// conecte execute_condition_monitoring -> analyze_failure_modes, así que este
// evento CONDITION_DEGRADED es una simulación manual del disparo, no uno real del bus.

import { handler, meta } from '../src/tools/analyze_failure_modes.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let passed = 0;
let failed = 0;

function assert (label, condition, detail = '') {
  if (condition) {
    console.log(`  ${GREEN}✔${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}✘${RESET} ${label}${detail ? ` — ${RED}${detail}${RESET}` : ''}`);
    failed++;
  }
}

// Evento disparador simulado (CONDITION_DEGRADED), como lo emitiría
// execute_condition_monitoring cuando conditionIndex < 60.
const makeEvent = (assetType, overrideData = {}) => ({
  event_id: '01JWQ9999888877776666AAAA1',
  timestamp: '2026-06-18T23:30:00.000Z',
  module: {
    id: 'execute_condition_monitoring',
    version: '1.0.0'
  },
  asset: {
    asset_id: `plant_01-manufacturing-line_2-${assetType}_01`,
    asset_type: assetType,
    plant_id: 'plant_01',
    area_id: 'manufacturing',
    line_id: 'line_2'
  },
  event: {
    type: 'CONDITION_DEGRADED',
    category: 'maintenance',
    severity: 'high'
  },
  data: {
    assetId: `plant_01-manufacturing-line_2-${assetType}_01`,
    assetType,
    conditionIndex: 42,
    analysisType: 'fmea',
    includeHistoricalFailures: true,
    recommendedAction: 'inspect',
    ...overrideData
  }
});

console.log(`\n${BOLD}${CYAN}=== Smoke Test - analyze_failure_modes ===${RESET}`);
console.log(`${CYAN}Tool:    ${RESET}${meta.id}  v${meta.version}`);
console.log(`${CYAN}Consume: ${RESET}${meta.consumes.join(', ') || '(vacío — invocación manual, sin regla automática en communication-rules.json)'}`);
console.log(`${CYAN}Produce: ${RESET}${meta.produces.join(', ')}\n`);

// CASO 1: Activo tipo motor
console.log(`${BOLD}CASO 1 — Activo tipo "motor" (PFMEA con biblioteca de motores)${RESET}`);
const result1 = await handler(makeEvent('motor'));

assert('Retorno no es null', result1 !== null);
assert('Tiene campo event', result1?.event !== undefined);
assert('Tiene campo asset', result1?.asset !== undefined);
assert('Tiene campo data', result1?.data !== undefined);
assert(
  'event.type === FMEA_CRITICAL_FOUND',
  result1?.event?.type === 'FMEA_CRITICAL_FOUND',
  `Recibido: ${result1?.event?.type}`
);
assert(
  'event.category === maintenance',
  result1?.event?.category === 'maintenance',
  `Recibido: ${result1?.event?.category}`
);
assert(
  'event.severity en enum válido',
  ['low', 'medium', 'high', 'critical'].includes(result1?.event?.severity),
  `Recibido: ${result1?.event?.severity}`
);
assert('data.failure_modes es array', Array.isArray(result1?.data?.failure_modes));
assert('data.failure_modes.length >= 1', (result1?.data?.failure_modes?.length ?? 0) >= 1);
assert(
  'data.criticalItems >= 1 (RPN >= 100)',
  (result1?.data?.criticalItems ?? 0) >= 1,
  `criticalItems: ${result1?.data?.criticalItems}`
);

// Validar que rpn == severity x occurrence x detectability en cada modo
const rpnConsistent = result1?.data?.failure_modes?.every(
  m => m.rpn === m.severity * m.occurrence * m.detectability
);
assert('RPN = S x O x D para todos los modos', rpnConsistent === true);

assert(
  'data.maintenance_strategy en enum válido',
  ['predictive', 'preventive', 'corrective'].includes(result1?.data?.maintenance_strategy),
  `Recibido: ${result1?.data?.maintenance_strategy}`
);
assert('data.iso_clause === 6.1', result1?.data?.iso_clause === '6.1');
assert(
  'event.severity === critical (motor: todos los modos tienen RPN >= 100)',
  result1?.event?.severity === 'critical',
  `Recibido: ${result1?.event?.severity}`
);

console.log(`\n${BOLD}Output Caso 1:${RESET}`);
console.log(JSON.stringify(result1, null, 2));

// CASO 2: Activo tipo pump
console.log(`\n${BOLD}CASO 2 — Activo tipo "pump" (PFMEA con biblioteca de bombas)${RESET}`);
const result2 = await handler(makeEvent('pump'));

assert('Retorno no es null', result2 !== null);
assert('Tiene modos de falla', (result2?.data?.failure_modes?.length ?? 0) >= 1);
assert('criticalItems >= 1', (result2?.data?.criticalItems ?? 0) >= 1);
assert(
  'El modo con mayor RPN tiene is_critical === true',
  result2?.data?.failure_modes?.[0]?.is_critical === true,
  `RPN top: ${result2?.data?.failure_modes?.[0]?.rpn}`
);
assert(
  'Modos ordenados por RPN descendente',
  (() => {
    const modes = result2?.data?.failure_modes ?? [];
    for (let i = 0; i < modes.length - 1; i++) {
      if (modes[i].rpn < modes[i + 1].rpn) return false;
    }
    return true;
  })(),
  'Los modos deben estar ordenados de mayor a menor RPN'
);

// CASO 3: Activo genérico (default) con assetType desconocido
console.log(`\n${BOLD}CASO 3 — Activo genérico/conveyor (fallback a biblioteca default)${RESET}`);
const result3 = await handler(makeEvent('conveyor'));

assert('Retorno no es null', result3 !== null);
assert('criticalItems >= 1', (result3?.data?.criticalItems ?? 0) >= 1);
assert(
  'Sin marcas _placeholder en v1.0.0',
  result3?.data?._placeholder === undefined,
  `_placeholder: ${result3?.data?._placeholder}`
);

// CASO 4: Evento con asset vacío (robustez del handler)
console.log(`\n${BOLD}CASO 4 — Evento con asset vacío (robustez)${RESET}`);
const eventNoAsset = {
  event_id: '01JWQ0000000000000000ZZZZ1',
  timestamp: '2026-06-18T23:45:00.000Z',
  module: { id: 'execute_condition_monitoring', version: '1.0.0' },
  asset: {},
  event: { type: 'CONDITION_DEGRADED', category: 'maintenance', severity: 'high' },
  data: { conditionIndex: 35 }
};
const result4 = await handler(eventNoAsset);
assert(
  'No lanza excepción con asset vacío',
  result4 !== undefined,
  'El handler debe manejar input sin asset.asset_id'
);
assert('Usa asset_id por defecto', result4?.data?.asset_id !== undefined);

// CASO 5: FMEA puro — sin campo rcm_strategy en los modos (analysisType no incluye 'rcm')
console.log(`\n${BOLD}CASO 5 — FMEA puro: sin rcm_strategy en los modos${RESET}`);
const result5 = await handler(makeEvent('motor', { analysisType: 'fmea' }));
assert('Retorno no es null', result5 !== null);
assert(
  'Ningún modo trae rcm_strategy',
  result5?.data?.failure_modes?.every(m => m.rcm_strategy === undefined)
);
assert('data.maintenance_strategy sigue el heurístico por RPN (preventive: maxRpn=180)',
  result5?.data?.maintenance_strategy === 'preventive',
  `Recibido: ${result5?.data?.maintenance_strategy}`);

// CASO 6: RCM — falla oculta (no evidente) que compromete seguridad → rediseño
console.log(`\n${BOLD}CASO 6 — RCM: oculta + compromete seguridad → rediseño${RESET}`);
const result6 = await handler(makeEvent('motor', {
  analysisType: 'rcm', isEvident: false, affectsSafety: true, affectsProduction: true
}));
assert('Retorno no es null', result6 !== null);
assert('Todos los modos traen rcm_strategy === rediseño',
  result6?.data?.failure_modes?.every(m => m.rcm_strategy === 'rediseño'));
assert('data.maintenance_strategy === rediseño (dominante = salida del árbol RCM)',
  result6?.data?.maintenance_strategy === 'rediseño',
  `Recibido: ${result6?.data?.maintenance_strategy}`);

// CASO 7: RCM — evidente + compromete seguridad → PM-condition-based
console.log(`\n${BOLD}CASO 7 — RCM: evidente + compromete seguridad → PM-condition-based${RESET}`);
const result7 = await handler(makeEvent('motor', {
  analysisType: 'rcm', isEvident: true, affectsSafety: true, affectsProduction: false
}));
assert('data.maintenance_strategy === PM-condition-based',
  result7?.data?.maintenance_strategy === 'PM-condition-based',
  `Recibido: ${result7?.data?.maintenance_strategy}`);

// CASO 8: RCM — oculta + solo compromete producción → PM-time-based
console.log(`\n${BOLD}CASO 8 — RCM: oculta + solo producción → PM-time-based${RESET}`);
const result8 = await handler(makeEvent('motor', {
  analysisType: 'rcm', isEvident: false, affectsSafety: false, affectsProduction: true
}));
assert('data.maintenance_strategy === PM-time-based',
  result8?.data?.maintenance_strategy === 'PM-time-based',
  `Recibido: ${result8?.data?.maintenance_strategy}`);

// CASO 9: RCM — evidente + solo producción → PM-condition-based
console.log(`\n${BOLD}CASO 9 — RCM: evidente + solo producción → PM-condition-based${RESET}`);
const result9 = await handler(makeEvent('motor', {
  analysisType: 'rcm', isEvident: true, affectsSafety: false, affectsProduction: true
}));
assert('data.maintenance_strategy === PM-condition-based',
  result9?.data?.maintenance_strategy === 'PM-condition-based',
  `Recibido: ${result9?.data?.maintenance_strategy}`);

// CASO 10: RCM — sin impacto en seguridad ni producción → run-to-failure
console.log(`\n${BOLD}CASO 10 — RCM: sin impacto → run-to-failure${RESET}`);
const result10 = await handler(makeEvent('motor', {
  analysisType: 'rcm', isEvident: true, affectsSafety: false, affectsProduction: false
}));
assert('data.maintenance_strategy === run-to-failure',
  result10?.data?.maintenance_strategy === 'run-to-failure',
  `Recibido: ${result10?.data?.maintenance_strategy}`);

// CASO 11: both — combina RPN/isCritical (FMEA) con rcm_strategy (RCM) en cada modo
console.log(`\n${BOLD}CASO 11 — both: cada modo trae RPN y rcm_strategy a la vez${RESET}`);
const result11 = await handler(makeEvent('motor', {
  analysisType: 'both', isEvident: false, affectsSafety: true, affectsProduction: true
}));
assert('Retorno no es null', result11 !== null);
assert('data.analysis_type === both', result11?.data?.analysis_type === 'both');
assert(
  'Cada modo trae rpn, is_critical y rcm_strategy',
  result11?.data?.failure_modes?.every(m =>
    typeof m.rpn === 'number' && typeof m.is_critical === 'boolean' && m.rcm_strategy === 'rediseño'
  )
);

// CASO 12: umbral estricto RPN > 100 (no >=). Ningún modo del catálogo actual
// tiene RPN exactamente 100 (motor: 105/120/180 — todos por encima), así que
// esta prueba no puede ejercer el límite exacto sin modificar la biblioteca;
// deja constancia de que el modo más cercano al umbral (105) sigue siendo
// crítico bajo el criterio estricto, y que el umbral documentado es 100.
console.log(`\n${BOLD}CASO 12 — Umbral estricto: RPN > 100 (no >=)${RESET}`);
const result12 = await handler(makeEvent('motor'));
const desbalance = result12?.data?.failure_modes?.find(m => m.rpn === 105);
assert('Modo con RPN=105 (>100) sí es crítico', desbalance?.is_critical === true);
assert('data.rpn_threshold === 100', result12?.data?.rpn_threshold === 100);

console.log(`\n${BOLD}==============================================${RESET}`);
console.log(`${BOLD}Resultado: ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ''}${failed} failed${RESET}`);
if (failed > 0) {
  console.log(`${RED}Smoke test FALLIDO — revisa los errores arriba.${RESET}`);
  process.exit(1);
} else {
  console.log(`${GREEN}Smoke test PASADO — handler listo para el bus.${RESET}`);
}
