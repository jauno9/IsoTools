// src/tools/detect_out_of_control_signals.js
// Reglas de Nelson (8) y Western Electric (4) sobre cartas de control X-bar
// (ISO 9001:2015 — Cláusula 8.3, Etapa 5: Operación). isoEvent: "out_of_control_signal".
export const meta = {
  id: 'detect_out_of_control_signals',
  name: 'Detección de Señales Fuera de Control',
  version: '1.0.0',
  category: 'quality',
  consumes: ['CHART_POINTS_UPDATED'],
  produces: ['OUT_OF_CONTROL_DETECTED'],
  description: 'Aplica las 8 reglas de Nelson o las 4 reglas fundamentales de Western Electric (según rulesSet), con ventana deslizante, para detectar patrones de causa asignable en cartas de control SPC.'
};

// ─── Zonas A/B/C ────────────────────────────────────────────────────────────
// Se divide en tercios la distancia CL→UCL (lado superior) y CL→LCL (lado
// inferior): zona C = 1 tercio (más cercana a CL), zona B = 2 tercios,
// zona A = 3 tercios (= UCL/LCL). Se calculan por lado porque UCL/LCL no
// siempre son simétricos respecto a la centerLine.
function computeZoneWidths (ucl, lcl, centerLine) {
  return {
    widthAbove: (ucl - centerLine) / 3,
    widthBelow: (centerLine - lcl) / 3
  };
}

// Lado del punto respecto a la CL: 'above' | 'below' | null (justo sobre CL)
function sideOf (value, centerLine) {
  if (value > centerLine) return 'above';
  if (value < centerLine) return 'below';
  return null;
}

// Cuántos "anchos de zona" está el punto lejos de la CL, en su propio lado
// (0 = sobre la CL, 1 = borde zona C, 2 = borde zona B, 3 = borde zona A/UCL-LCL).
function zoneDeviation (value, centerLine, widths) {
  const side = sideOf(value, centerLine);
  if (side === 'above') return (value - centerLine) / widths.widthAbove;
  if (side === 'below') return (centerLine - value) / widths.widthBelow;
  return 0;
}

// ─── Regla 1 (Nelson/WE): punto fuera de UCL/LCL (±3σ, zona A) ─────────────
function evaluateRule1 (points, ucl, lcl, ruleName) {
  const violatingIndices = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i] > ucl || points[i] < lcl) {
      violatingIndices.push(i);
    }
  }
  if (violatingIndices.length === 0) return [];
  return [{
    rule: ruleName,
    points: violatingIndices,
    description: `${violatingIndices.length} punto(s) fuera de los límites de control ±3σ`
  }];
}

// ─── N puntos consecutivos en el mismo lado de la CL ───────────────────────
// Nelson 2 usa N=9; Western Electric 4 usa N=8. Un punto exactamente sobre
// la CL interrumpe la racha.
function evaluateRunSameSide (points, centerLine, threshold, ruleName) {
  const violations = [];
  if (points.length < threshold) return violations;

  let runStart = 0;
  let runSide = null;
  let runLen = 0;

  const flush = () => {
    if (runLen >= threshold) {
      violations.push({
        rule: ruleName,
        points: Array.from({ length: runLen }, (_, k) => runStart + k),
        description: `${runLen} puntos consecutivos ${runSide === 'above' ? 'por encima' : 'por debajo'} de la línea central`
      });
    }
  };

  for (let i = 0; i < points.length; i++) {
    const side = sideOf(points[i], centerLine);

    if (side === null) {
      flush();
      runStart = i + 1;
      runSide = null;
      runLen = 0;
    } else if (side === runSide) {
      runLen++;
    } else {
      flush();
      runStart = i;
      runSide = side;
      runLen = 1;
    }
  }
  flush();

  return violations;
}

// ─── Nelson 3: 6+ puntos consecutivos en tendencia monotónica ──────────────
// Un paso plano interrumpe la racha; el punto de quiebre entre dos
// tendencias pertenece a la nueva racha (solape estándar SPC).
function evaluateNelson3 (points) {
  const violations = [];
  if (points.length < 6) return violations;

  let runStart = 0;
  let runDir = 0; // 1 = creciente, -1 = decreciente, 0 = sin dirección
  let runLen = 1;

  const flush = () => {
    if (runLen >= 6) {
      violations.push({
        rule: 'Nelson 3',
        points: Array.from({ length: runLen }, (_, k) => runStart + k),
        description: `${runLen} puntos consecutivos en tendencia monotónica ${runDir > 0 ? 'creciente' : 'decreciente'}`
      });
    }
  };

  for (let i = 0; i < points.length - 1; i++) {
    const stepDir = Math.sign(points[i + 1] - points[i]);

    if (stepDir === 0) {
      flush();
      runStart = i + 1;
      runDir = 0;
      runLen = 1;
    } else if (runDir === 0 || stepDir === runDir) {
      runDir = stepDir;
      runLen++;
    } else {
      flush();
      runStart = i;
      runDir = stepDir;
      runLen = 2;
    }
  }
  flush();

  return violations;
}

// ─── Nelson 4: 14+ puntos consecutivos alternando de dirección (zigzag) ────
// Misma mecánica que Nelson 3 pero exige alternancia estricta en vez de
// mantener la misma dirección; un paso plano también interrumpe la racha.
function evaluateNelson4 (points) {
  const violations = [];
  if (points.length < 14) return violations;

  let runStart = 0;
  let runLastDir = 0;
  let runLen = 1;

  const flush = () => {
    if (runLen >= 14) {
      violations.push({
        rule: 'Nelson 4',
        points: Array.from({ length: runLen }, (_, k) => runStart + k),
        description: `${runLen} puntos consecutivos alternando de dirección (patrón zigzag)`
      });
    }
  };

  for (let i = 0; i < points.length - 1; i++) {
    const stepDir = Math.sign(points[i + 1] - points[i]);

    if (stepDir === 0) {
      flush();
      runStart = i + 1;
      runLastDir = 0;
      runLen = 1;
    } else if (runLastDir === 0 || stepDir === -runLastDir) {
      runLastDir = stepDir;
      runLen++;
    } else {
      flush();
      runStart = i;
      runLastDir = stepDir;
      runLen = 2;
    }
  }
  flush();

  return violations;
}

// ─── k de n puntos consecutivos más allá de un umbral de zona, mismo lado ──
// Nelson 5 = 2 de 3 más allá de zona B (>2 anchos); Nelson 6 = 4 de 5 más
// allá de zona C (>1 ancho); Western Electric 2/3 reutilizan la misma
// mecánica con idénticos umbrales. Ventanas consecutivas que disparan se
// fusionan en una sola violación (unión de los índices que sí califican),
// igual que las rachas de las otras reglas.
function evaluateKOfNBeyondZone (points, centerLine, widths, windowSize, threshold, zoneWidthsFromCl, side, ruleName) {
  const violations = [];
  const n = points.length;
  if (n < windowSize) return violations;

  const isFlagged = (i) => {
    if (sideOf(points[i], centerLine) !== side) return false;
    return zoneDeviation(points[i], centerLine, widths) > zoneWidthsFromCl;
  };

  let activePoints = null;
  let lastWindowEnd = -1;

  const flush = () => {
    if (activePoints && activePoints.size > 0) {
      const sorted = Array.from(activePoints).sort((a, b) => a - b);
      violations.push({
        rule: ruleName,
        points: sorted,
        description: `${sorted.length} punto(s) más allá de ${zoneWidthsFromCl}σ ${side === 'above' ? 'por encima' : 'por debajo'} de la línea central (criterio: ${threshold} de ${windowSize} consecutivos)`
      });
    }
    activePoints = null;
  };

  for (let i = 0; i <= n - windowSize; i++) {
    const flaggedIdx = [];
    for (let k = 0; k < windowSize; k++) {
      if (isFlagged(i + k)) flaggedIdx.push(i + k);
    }

    if (flaggedIdx.length >= threshold) {
      if (activePoints && i <= lastWindowEnd) {
        flaggedIdx.forEach(idx => activePoints.add(idx));
      } else {
        flush();
        activePoints = new Set(flaggedIdx);
      }
      lastWindowEnd = i + windowSize - 1;
    }
  }
  flush();

  return violations;
}

// ─── Nelson 7: 15+ puntos consecutivos dentro de zona C (±1σ) ──────────────
// Indica estratificación: variabilidad sospechosamente baja.
function evaluateNelson7 (points, centerLine, widths) {
  const violations = [];
  const threshold = 15;
  if (points.length < threshold) return violations;

  const withinZoneC = (i) => zoneDeviation(points[i], centerLine, widths) <= 1;

  let runStart = 0;
  let runLen = 0;

  const flush = () => {
    if (runLen >= threshold) {
      violations.push({
        rule: 'Nelson 7',
        points: Array.from({ length: runLen }, (_, k) => runStart + k),
        description: `${runLen} puntos consecutivos dentro de zona C (±1σ) — posible estratificación`
      });
    }
  };

  for (let i = 0; i < points.length; i++) {
    if (withinZoneC(i)) {
      if (runLen === 0) runStart = i;
      runLen++;
    } else {
      flush();
      runLen = 0;
    }
  }
  flush();

  return violations;
}

// ─── Nelson 8: 8+ puntos consecutivos fuera de zona C, en ambos lados ──────
// Indica mezcla de dos procesos distintos (patrón "en ambos lados").
function evaluateNelson8 (points, centerLine, widths) {
  const violations = [];
  const threshold = 8;
  if (points.length < threshold) return violations;

  const beyondZoneC = (i) => zoneDeviation(points[i], centerLine, widths) > 1;

  let runStart = 0;
  let runLen = 0;
  let sidesInRun = new Set();

  const flush = () => {
    if (runLen >= threshold && sidesInRun.size === 2) {
      violations.push({
        rule: 'Nelson 8',
        points: Array.from({ length: runLen }, (_, k) => runStart + k),
        description: `${runLen} puntos consecutivos fuera de zona C, alternando ambos lados de la línea central`
      });
    }
  };

  for (let i = 0; i < points.length; i++) {
    if (beyondZoneC(i)) {
      if (runLen === 0) sidesInRun = new Set();
      if (runLen === 0) runStart = i;
      runLen++;
      sidesInRun.add(sideOf(points[i], centerLine));
    } else {
      flush();
      runLen = 0;
      sidesInRun = new Set();
    }
  }
  flush();

  return violations;
}

// ─── Conjuntos de reglas ────────────────────────────────────────────────────
function runNelsonRuleset (points, ucl, lcl, centerLine, widths) {
  const violations = [];
  violations.push(...evaluateRule1(points, ucl, lcl, 'Nelson 1'));
  violations.push(...evaluateRunSameSide(points, centerLine, 9, 'Nelson 2'));
  violations.push(...evaluateNelson3(points));
  violations.push(...evaluateNelson4(points));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 3, 2, 2, 'above', 'Nelson 5'));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 3, 2, 2, 'below', 'Nelson 5'));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 5, 4, 1, 'above', 'Nelson 6'));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 5, 4, 1, 'below', 'Nelson 6'));
  violations.push(...evaluateNelson7(points, centerLine, widths));
  violations.push(...evaluateNelson8(points, centerLine, widths));
  return violations;
}

function runWesternElectricRuleset (points, ucl, lcl, centerLine, widths) {
  const violations = [];
  violations.push(...evaluateRule1(points, ucl, lcl, 'Western Electric 1'));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 3, 2, 2, 'above', 'Western Electric 2'));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 3, 2, 2, 'below', 'Western Electric 2'));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 5, 4, 1, 'above', 'Western Electric 3'));
  violations.push(...evaluateKOfNBeyondZone(points, centerLine, widths, 5, 4, 1, 'below', 'Western Electric 3'));
  violations.push(...evaluateRunSameSide(points, centerLine, 8, 'Western Electric 4'));
  return violations;
}

const RULES_APPLIED = {
  nelson: ['Nelson 1', 'Nelson 2', 'Nelson 3', 'Nelson 4', 'Nelson 5', 'Nelson 6', 'Nelson 7', 'Nelson 8'],
  western_electric: ['Western Electric 1', 'Western Electric 2', 'Western Electric 3', 'Western Electric 4']
};
RULES_APPLIED.both = [...RULES_APPLIED.nelson, ...RULES_APPLIED.western_electric];

export async function handler (inputEvent) {
  const input = inputEvent.data || {};

  const chartId = input.chartId;
  const plotPoints = Array.isArray(input.plotPoints) ? input.plotPoints : [];
  const ucl = typeof input.ucl === 'number' ? input.ucl : null;
  const lcl = typeof input.lcl === 'number' ? input.lcl : null;
  const centerLine = typeof input.centerLine === 'number' ? input.centerLine : null;
  const rulesSet = ['nelson', 'western_electric', 'both'].includes(input.rulesSet) ? input.rulesSet : 'nelson';

  // Guard: sin datos mínimos no emitimos nada
  if (!chartId || plotPoints.length === 0 || ucl === null || lcl === null || centerLine === null) {
    return null;
  }

  const widths = computeZoneWidths(ucl, lcl, centerLine);

  const violations = [];
  if (rulesSet === 'nelson' || rulesSet === 'both') {
    violations.push(...runNelsonRuleset(plotPoints, ucl, lcl, centerLine, widths));
  }
  if (rulesSet === 'western_electric' || rulesSet === 'both') {
    violations.push(...runWesternElectricRuleset(plotPoints, ucl, lcl, centerLine, widths));
  }

  // Sin violaciones → no emitimos (rule-qual-003 usa triggerCondition: "violationsDetected == true")
  if (violations.length === 0) return null;

  // Punto fuera de ±3σ (Nelson 1 / Western Electric 1) o múltiples reglas activas → high
  const hasBeyond3Sigma = violations.some(v => v.rule === 'Nelson 1' || v.rule === 'Western Electric 1');
  const severity = (hasBeyond3Sigma || violations.length > 1) ? 'high' : 'medium';

  return {
    event: {
      type: 'OUT_OF_CONTROL_DETECTED',
      category: 'quality',
      severity
    },
    asset: inputEvent.asset,
    data: {
      // chartId se mantiene en camelCase: manage_nonconformances.js (rule-qual-003) lee
      // input.chartId directamente en su handler, no solo en el triggerCondition.
      chartId,
      // violationsDetected se mantiene en camelCase: es el campo exacto que evalúa
      // el triggerCondition de rule-qual-003 ("violationsDetected == true").
      violationsDetected: true,
      violations,
      rules_applied: RULES_APPLIED[rulesSet],
      total_points_analyzed: plotPoints.length,
      iso_clause: '8.3',
      iso_stage: 'Operación'
    }
  };
}
