// scripts/test_detect_out_of_control_signals.js
//
// Smoke test del handler — aislado, sin bus, sin Docker, sin Postgres.
// Uso: node scripts/test_detect_out_of_control_signals.js
//
// Valida:
//   - Estructura canónica {event, asset, data}
//   - Nelson 1-8 completas (zonas A/B/C, rachas, k-de-n, zigzag, estratificación, mezcla)
//   - Western Electric 4 reglas fundamentales, incluido el umbral de racha (8 vs 9 de Nelson)
//   - rulesSet: 'nelson' (default), 'western_electric' y 'both'
//   - Sin violaciones → null (no emite evento)
//   - Input incompleto → null

import { handler, meta } from '../src/tools/detect_out_of_control_signals.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
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

// Sobre base (CHART_POINTS_UPDATED), tal como lo emite calculate_control_charts
const BASE_EVENT = {
  event_id: '01JWQ1234567890ABCDEF00001',
  timestamp: '2026-06-18T23:00:00.000Z',
  module: { id: 'calculate_control_charts', version: '1.0.0' },
  asset: {
    asset_id: 'plant_01-assembly-line_1-press_02',
    asset_type: 'press',
    plant_id: 'plant_01',
    area_id: 'assembly',
    line_id: 'line_1',
    location: 'station_3'
  },
  event: { type: 'CHART_POINTS_UPDATED', category: 'quality', severity: 'medium' }
};

// Parámetros de carta compartidos (sigma = (ucl - CL) / 3 = 0.02)
const CHART_PARAMS = { ucl: 10.06, lcl: 9.94, centerLine: 10.00 };

console.log(`\n${BOLD}${CYAN}=== Smoke Test - detect_out_of_control_signals ===${RESET}`);
console.log(`${CYAN}Tool:    ${RESET}${meta.id}  v${meta.version}`);
console.log(`${CYAN}Consume: ${RESET}${meta.consumes.join(', ')}`);
console.log(`${CYAN}Produce: ${RESET}${meta.produces.join(', ')}\n`);

// CASO 1: Nelson 1 — dos puntos fuera de UCL/LCL
// plotPoints[7]  = 10.09 > UCL (10.06)
// plotPoints[12] = 9.91  < LCL (9.94)
console.log(`${BOLD}CASO 1 — Nelson 1: puntos fuera de UCL/LCL${RESET}`);
const result1 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-01',
    rulesSet: 'nelson',
    plotPoints: [10.01, 9.98, 10.03, 9.99, 10.02, 10.00, 9.97, 10.09,
      10.01, 9.98, 10.00, 9.96, 9.91, 9.99, 10.02]
  }
});

assert('Retorno no es null', result1 !== null);
assert('Tiene campo event', result1?.event !== undefined);
assert('Tiene campo asset', result1?.asset !== undefined);
assert('Tiene campo data', result1?.data !== undefined);
assert('event.type === OUT_OF_CONTROL_DETECTED',
  result1?.event?.type === 'OUT_OF_CONTROL_DETECTED',
  `Recibido: ${result1?.event?.type}`);
assert('event.severity === high (Rule 1 siempre es high)',
  result1?.event?.severity === 'high',
  `Recibido: ${result1?.event?.severity}`);
assert('data.violationsDetected === true', result1?.data?.violationsDetected === true);
assert('data.violations es array no vacío', (result1?.data?.violations?.length ?? 0) >= 1);
assert('data.total_points_analyzed === 15', result1?.data?.total_points_analyzed === 15);
assert('Nelson 1 reporta índices 7 y 12',
  result1?.data?.violations?.some(
    v => v.rule === 'Nelson 1' && v.points.includes(7) && v.points.includes(12)
  ));
assert('data.rules_applied lista Nelson 1-3',
  result1?.data?.rules_applied?.includes('Nelson 1') &&
  result1?.data?.rules_applied?.includes('Nelson 2') &&
  result1?.data?.rules_applied?.includes('Nelson 3'));
assert('No hay marcas _placeholder en data', result1?.data?._placeholder === undefined);
assert('iso_clause === 8.3', result1?.data?.iso_clause === '8.3');

// CASO 2: Nelson 2 — 9 puntos consecutivos por encima del CL
// 9 puntos todos > centerLine=10.00, todos dentro de [9.94, 10.06] (sin Nelson 1)
console.log(`\n${BOLD}CASO 2 — Nelson 2: 9 puntos mismo lado (ventana deslizante)${RESET}`);
const result2 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-02',
    plotPoints: [10.05, 10.03, 10.01, 10.04, 10.02, 10.05, 10.01, 10.03, 10.02]
  }
});

assert('Retorno no es null (Nelson 2 detectado)', result2 !== null);
assert('Viola exactamente Nelson 2',
  result2?.data?.violations?.some(v => v.rule === 'Nelson 2'),
  `Violaciones: ${JSON.stringify(result2?.data?.violations?.map(v => v.rule))}`);
assert('La racha cubre los 9 índices [0..8]',
  result2?.data?.violations?.some(
    v => v.rule === 'Nelson 2' && v.points.length === 9
  ));
assert('Sin Nelson 1 (puntos dentro de límites)',
  !result2?.data?.violations?.some(v => v.rule === 'Nelson 1'));
assert('severity === medium (solo Rule 2, no Rule 1)',
  result2?.event?.severity === 'medium',
  `Recibido: ${result2?.event?.severity}`);

// CASO 3: Nelson 3 — 7 puntos en tendencia creciente estricta
console.log(`\n${BOLD}CASO 3 — Nelson 3: tendencia monótona creciente (ventana deslizante)${RESET}`);
const result3 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-03',
    plotPoints: [9.96, 9.97, 9.98, 9.99, 10.00, 10.01, 10.02]
  }
});

assert('Retorno no es null (Nelson 3 detectado)', result3 !== null);
assert('Viola exactamente Nelson 3',
  result3?.data?.violations?.some(v => v.rule === 'Nelson 3'),
  `Violaciones: ${JSON.stringify(result3?.data?.violations?.map(v => v.rule))}`);
assert('La racha cubre los 7 índices [0..6]',
  result3?.data?.violations?.some(
    v => v.rule === 'Nelson 3' && v.points.length === 7
  ));
assert('Sin Nelson 1 (puntos dentro de límites)',
  !result3?.data?.violations?.some(v => v.rule === 'Nelson 1'));
assert('severity === medium (solo Rule 3, no Rule 1)',
  result3?.event?.severity === 'medium',
  `Recibido: ${result3?.event?.severity}`);

// CASO 4: Todo en control → null
console.log(`\n${BOLD}CASO 4 — Todo en control → null${RESET}`);
const result4 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-04',
    plotPoints: [10.01, 9.98, 10.03, 9.99, 10.02, 10.00, 9.97, 10.01, 9.96]
  }
});
assert('Retorna null cuando todo está en control',
  result4 === null, `Recibido: ${JSON.stringify(result4)}`);
console.log(`  Output Caso 4: ${YELLOW}null${RESET} (correcto)`);

// CASO 5: Input incompleto (sin chartId) → null
console.log(`\n${BOLD}CASO 5 — Input incompleto (sin chartId) → null${RESET}`);
const result5 = await handler({ ...BASE_EVENT, data: { plotPoints: [10.01, 9.98] } });
assert('Retorna null con input incompleto', result5 === null);

// CASO 6: Nelson 4 — 14 puntos alternando de dirección (zigzag)
console.log(`\n${BOLD}CASO 6 — Nelson 4: zigzag de 14 puntos${RESET}`);
const result6 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-06',
    plotPoints: [10.000, 10.005, 9.995, 10.005, 9.995, 10.005, 9.995,
      10.005, 9.995, 10.005, 9.995, 10.005, 9.995, 10.005]
  }
});
assert('Retorno no es null (Nelson 4 detectado)', result6 !== null);
assert('Viola exactamente Nelson 4',
  result6?.data?.violations?.some(v => v.rule === 'Nelson 4'),
  `Violaciones: ${JSON.stringify(result6?.data?.violations?.map(v => v.rule))}`);
assert('La racha cubre los 14 índices [0..13]',
  result6?.data?.violations?.some(v => v.rule === 'Nelson 4' && v.points.length === 14));
assert('severity === medium (solo Rule 4)', result6?.event?.severity === 'medium');

// CASO 7: Nelson 5 — 2 de 3 puntos más allá de zona B (2σ), mismo lado
console.log(`\n${BOLD}CASO 7 — Nelson 5: 2 de 3 más allá de zona B${RESET}`);
const result7 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-07',
    plotPoints: [10.05, 9.99, 10.05, 10.00, 9.98, 10.01, 9.99]
  }
});
assert('Retorno no es null (Nelson 5 detectado)', result7 !== null);
assert('Viola exactamente Nelson 5',
  result7?.data?.violations?.some(v => v.rule === 'Nelson 5'),
  `Violaciones: ${JSON.stringify(result7?.data?.violations?.map(v => v.rule))}`);
assert('Reporta los índices 0 y 2',
  result7?.data?.violations?.some(v => v.rule === 'Nelson 5' && v.points.includes(0) && v.points.includes(2)));
assert('severity === medium (solo Rule 5)', result7?.event?.severity === 'medium');

// CASO 8: Nelson 6 — 4 de 5 puntos más allá de zona C (1σ), mismo lado
console.log(`\n${BOLD}CASO 8 — Nelson 6: 4 de 5 más allá de zona C${RESET}`);
const result8 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-08',
    plotPoints: [10.03, 10.03, 9.99, 10.03, 10.03, 10.00]
  }
});
assert('Retorno no es null (Nelson 6 detectado)', result8 !== null);
assert('Viola exactamente Nelson 6',
  result8?.data?.violations?.some(v => v.rule === 'Nelson 6'),
  `Violaciones: ${JSON.stringify(result8?.data?.violations?.map(v => v.rule))}`);
assert('Reporta 4 puntos', result8?.data?.violations?.find(v => v.rule === 'Nelson 6')?.points?.length === 4);
assert('severity === medium (solo Rule 6)', result8?.event?.severity === 'medium');

// CASO 9: Nelson 7 — 15 puntos consecutivos dentro de zona C (estratificación)
console.log(`\n${BOLD}CASO 9 — Nelson 7: 15 puntos dentro de zona C${RESET}`);
const result9 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-09',
    plotPoints: [10.000, 10.005, 10.010, 10.005, 10.015, 10.000, 9.995,
      10.010, 9.990, 10.005, 10.015, 9.995, 10.000, 10.010, 9.995]
  }
});
assert('Retorno no es null (Nelson 7 detectado)', result9 !== null);
assert('Viola exactamente Nelson 7',
  result9?.data?.violations?.some(v => v.rule === 'Nelson 7'),
  `Violaciones: ${JSON.stringify(result9?.data?.violations?.map(v => v.rule))}`);
assert('La racha cubre los 15 puntos',
  result9?.data?.violations?.find(v => v.rule === 'Nelson 7')?.points?.length === 15);

// CASO 10: Nelson 8 — 8 puntos fuera de zona C alternando ambos lados
console.log(`\n${BOLD}CASO 10 — Nelson 8: 8 puntos fuera de zona C, ambos lados${RESET}`);
const result10 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-10',
    plotPoints: [10.03, 9.97, 10.03, 9.97, 10.03, 9.97, 10.03, 9.97]
  }
});
assert('Retorno no es null (Nelson 8 detectado)', result10 !== null);
assert('Viola exactamente Nelson 8',
  result10?.data?.violations?.some(v => v.rule === 'Nelson 8'),
  `Violaciones: ${JSON.stringify(result10?.data?.violations?.map(v => v.rule))}`);
assert('La racha cubre los 8 puntos',
  result10?.data?.violations?.find(v => v.rule === 'Nelson 8')?.points?.length === 8);

// CASO 11: rulesSet 'western_electric' — umbral de 8 (vs 9 de Nelson) para racha del mismo lado
console.log(`\n${BOLD}CASO 11 — rulesSet western_electric: WE-4 dispara con 8 (Nelson 2 necesita 9)${RESET}`);
const sameSide8 = [10.005, 10.005, 10.005, 10.005, 10.005, 10.005, 10.005, 10.005];
const result11a = await handler({
  ...BASE_EVENT,
  data: { ...CHART_PARAMS, chartId: 'CHART-XBAR-DIAM-11A', plotPoints: sameSide8 }
});
assert('Con rulesSet nelson (default), 8 puntos NO disparan Nelson 2 (necesita 9)', result11a === null);

const result11b = await handler({
  ...BASE_EVENT,
  data: { ...CHART_PARAMS, chartId: 'CHART-XBAR-DIAM-11B', plotPoints: sameSide8, rulesSet: 'western_electric' }
});
assert('Con rulesSet western_electric, 8 puntos SÍ disparan Western Electric 4', result11b !== null);
assert('Viola exactamente Western Electric 4',
  result11b?.data?.violations?.every(v => v.rule === 'Western Electric 4'),
  `Violaciones: ${JSON.stringify(result11b?.data?.violations?.map(v => v.rule))}`);
assert('data.rules_applied lista las 4 reglas de Western Electric',
  result11b?.data?.rules_applied?.length === 4 &&
  result11b?.data?.rules_applied?.every(r => r.startsWith('Western Electric')));

// CASO 12: rulesSet 'both' — un mismo punto puede violar Nelson 1 y Western Electric 1 a la vez
console.log(`\n${BOLD}CASO 12 — rulesSet both: Nelson 1 + Western Electric 1 sobre el mismo punto${RESET}`);
const result12 = await handler({
  ...BASE_EVENT,
  data: {
    ...CHART_PARAMS,
    chartId: 'CHART-XBAR-DIAM-12',
    rulesSet: 'both',
    plotPoints: [10.01, 9.98, 10.03, 9.99, 10.02, 10.00, 9.97, 10.09, 10.01, 9.98]
  }
});
assert('Retorno no es null', result12 !== null);
assert('Viola Nelson 1', result12?.data?.violations?.some(v => v.rule === 'Nelson 1'));
assert('Viola Western Electric 1', result12?.data?.violations?.some(v => v.rule === 'Western Electric 1'));
assert('data.rules_applied lista las 12 reglas combinadas', result12?.data?.rules_applied?.length === 12);

console.log(`\n${BOLD}==============================================${RESET}`);
console.log(`${BOLD}Resultado: ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : ''}${failed} failed${RESET}`);
if (failed > 0) {
  console.log(`${RED}Smoke test FALLIDO — revisa los errores arriba.${RESET}`);
  process.exit(1);
} else {
  console.log(`${GREEN}Smoke test PASADO — handler listo para el bus.${RESET}`);
}
