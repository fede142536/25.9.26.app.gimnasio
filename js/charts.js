/**
 * Gráficos SVG livianos, sin librerías externas, siguiendo la guía interna
 * de dataviz: línea 2px, marcadores >=8px con anillo de superficie, grilla
 * hairline recesiva en valores redondos, tooltip por hover/touch. El color
 * de la serie es el del grupo muscular (variables CSS categóricas).
 */

/**
 * Gráfico de línea de una sola serie (ej: peso máximo por sesión en el tiempo).
 * points: [{ x: 'YYYY-MM-DD', y: number, label?: string, hollow?: boolean }]
 * `hollow` dibuja el punto vacío (ej. sesiones de descarga: livianas a propósito).
 */
export function lineChart(container, points, opts = {}) {
  // includeZero: false para medidas corporales, donde lo que importa es la variación (78,9 vs 80,4 kg)
  const { width = 320, height = 160, seriesColorVar = '--series-1', unit = '', includeZero = true } = opts;
  container.innerHTML = '';
  if (!points.length) {
    container.innerHTML = '<div class="chart-empty">Todavía no hay datos para graficar.</div>';
    return;
  }

  const pad = { top: 14, right: 12, bottom: 22, left: 34 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const ys = points.map(p => p.y);
  const lo = includeZero ? Math.min(...ys, 0) : Math.min(...ys);
  const hi = includeZero ? (Math.max(...ys) * 1.1 || 1) : Math.max(...ys);
  const tickStep = niceStep(Math.max(hi - lo, includeZero ? 0 : Math.max(...ys) * 0.04, 0.5) / 3);
  const minY = includeZero ? lo : Math.floor(lo / tickStep - 0.5) * tickStep;
  const maxY = Math.ceil((includeZero ? hi : hi + tickStep * 0.5) / tickStep) * tickStep;
  const xFor = i => pad.left + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const yFor = v => pad.top + h - ((v - minY) / (maxY - minY || 1)) * h;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'viz-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.ariaLabel || 'Gráfico de progreso');

  // grilla horizontal en valores redondos (0, 20, 40, 60…), hairline recesiva
  for (let v = minY; v <= maxY + 1e-9; v += tickStep) {
    const y = yFor(v);
    svg.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: 'viz-grid' }));
    svg.appendChild(svgEl('text', { x: pad.left - 6, y: y + 3, class: 'viz-tick', 'text-anchor': 'end' }, fmt(v)));
  }

  // línea 2px
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.y)}`).join(' ');
  svg.appendChild(svgEl('path', { d, class: 'viz-line', style: `stroke: var(${seriesColorVar})` }));

  // marcadores (r=4 => 8px) con anillo de superficie
  points.forEach((p, i) => {
    const cx = xFor(i), cy = yFor(p.y);
    svg.appendChild(svgEl('circle', { cx, cy, r: 5.5, class: 'viz-dot-ring' }));
    svg.appendChild(svgEl('circle', p.hollow
      ? { cx, cy, r: 3.5, class: 'viz-dot', style: `fill: var(--chart-surface); stroke: var(${seriesColorVar}); stroke-width: 2`, 'data-i': i }
      : { cx, cy, r: 4, class: 'viz-dot', style: `fill: var(${seriesColorVar})`, 'data-i': i }));
  });

  // etiqueta directa en el último punto (el valor final, el que importa)
  const lastI = points.length - 1;
  svg.appendChild(svgEl('text', {
    x: xFor(lastI), y: yFor(points[lastI].y) - 10, class: 'viz-end-label', 'text-anchor': 'middle',
  }, `${fmt(points[lastI].y)}${unit}`));

  // capa de interacción: crosshair + tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'viz-tooltip';
  tooltip.hidden = true;
  const crosshair = svgEl('line', { x1: 0, x2: 0, y1: pad.top, y2: pad.top + h, class: 'viz-crosshair', visibility: 'hidden' });
  svg.appendChild(crosshair);

  const hitLayer = svgEl('rect', { x: pad.left, y: pad.top, width: w, height: h, fill: 'transparent', style: 'cursor: crosshair' });
  svg.appendChild(hitLayer);

  function showAt(i) {
    const p = points[i];
    crosshair.setAttribute('x1', xFor(i));
    crosshair.setAttribute('x2', xFor(i));
    crosshair.setAttribute('visibility', 'visible');
    tooltip.hidden = false;
    // se acota para que el cartel no se salga de la pantalla en los puntos de los bordes
    tooltip.style.left = `${Math.min(80, Math.max(20, (xFor(i) / width) * 100))}%`;
    tooltip.style.top = `${(yFor(p.y) / height) * 100}%`;
    tooltip.innerHTML = `<b>${fmt(p.y)}${unit}</b><span>${p.label || p.x}</span>`;
  }
  hitLayer.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    let closest = 0, best = Infinity;
    points.forEach((p, i) => { const dist = Math.abs(xFor(i) - relX); if (dist < best) { best = dist; closest = i; } });
    showAt(closest);
  });
  hitLayer.addEventListener('mouseleave', () => { tooltip.hidden = true; crosshair.setAttribute('visibility', 'hidden'); });
  hitLayer.addEventListener('touchstart', (e) => {
    const rect = svg.getBoundingClientRect();
    const touch = e.touches[0];
    const relX = ((touch.clientX - rect.left) / rect.width) * width;
    let closest = 0, best = Infinity;
    points.forEach((p, i) => { const dist = Math.abs(xFor(i) - relX); if (dist < best) { best = dist; closest = i; } });
    showAt(closest);
  }, { passive: true });

  const wrap = document.createElement('div');
  wrap.className = 'viz-root';
  wrap.style.position = 'relative';
  wrap.appendChild(svg);
  wrap.appendChild(tooltip);
  container.appendChild(wrap);
}

function svgEl(tag, attrs, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

/** Paso de grilla "redondo" (1, 2, 2,5, 5 × 10ⁿ) para un rango dado. */
function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

/** Número con coma decimal y sin decimales de más (42,5 · 60). */
function fmt(v) { return String(Math.round(v * 10) / 10).replace('.', ','); }
