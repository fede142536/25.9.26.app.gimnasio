/**
 * Gráficos SVG livianos, sin librerías externas, siguiendo la guía interna
 * de dataviz: línea 2px, marcadores >=8px con anillo de superficie, barras
 * con esquina redondeada de 4px y separación de 2px, grilla hairline
 * recesiva, tooltip por hover/touch. Los colores por grupo muscular se
 * toman de las variables CSS categóricas (mismo orden siempre).
 */

/**
 * Gráfico de línea de una sola serie (ej: peso máximo por sesión en el tiempo).
 * points: [{ x: 'YYYY-MM-DD', y: number, label?: string }]
 */
export function lineChart(container, points, opts = {}) {
  const { width = 320, height = 160, seriesColorVar = '--series-1', unit = '' } = opts;
  container.innerHTML = '';
  if (!points.length) {
    container.innerHTML = '<div class="chart-empty">Todavía no hay datos para graficar.</div>';
    return;
  }

  const pad = { top: 14, right: 12, bottom: 22, left: 34 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const ys = points.map(p => p.y);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys) * 1.1 || 1;
  const xFor = i => pad.left + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const yFor = v => pad.top + h - ((v - minY) / (maxY - minY || 1)) * h;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'viz-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.ariaLabel || 'Gráfico de progreso');

  // grilla horizontal (3 líneas), hairline recesiva
  const gridSteps = 3;
  let lastTickLabel = null;
  for (let i = 0; i <= gridSteps; i++) {
    const v = minY + ((maxY - minY) * i) / gridSteps;
    const y = yFor(v);
    svg.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: 'viz-grid' }));
    const label = roundTick(v);
    if (label !== lastTickLabel) {
      svg.appendChild(svgEl('text', { x: pad.left - 6, y: y + 3, class: 'viz-tick', 'text-anchor': 'end' }, label));
      lastTickLabel = label;
    }
  }

  // línea 2px
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.y)}`).join(' ');
  svg.appendChild(svgEl('path', { d, class: 'viz-line', style: `stroke: var(${seriesColorVar})` }));

  // marcadores (r=4 => 8px) con anillo de superficie
  points.forEach((p, i) => {
    const cx = xFor(i), cy = yFor(p.y);
    svg.appendChild(svgEl('circle', { cx, cy, r: 5.5, class: 'viz-dot-ring' }));
    svg.appendChild(svgEl('circle', { cx, cy, r: 4, class: 'viz-dot', style: `fill: var(${seriesColorVar})`, 'data-i': i }));
  });

  // etiqueta directa en el último punto (el valor final, el que importa)
  const lastI = points.length - 1;
  svg.appendChild(svgEl('text', {
    x: xFor(lastI), y: yFor(points[lastI].y) - 10, class: 'viz-end-label', 'text-anchor': 'middle',
  }, `${points[lastI].y}${unit}`));

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
    tooltip.style.left = `${(xFor(i) / width) * 100}%`;
    tooltip.style.top = `${(yFor(p.y) / height) * 100}%`;
    tooltip.innerHTML = `<b>${p.y}${unit}</b><span>${p.label || p.x}</span>`;
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

/**
 * Gráfico de barras categórico (ej: volumen por ejercicio dentro de un grupo muscular).
 * bars: [{ label, value, colorVar }]
 */
export function barChart(container, bars, opts = {}) {
  const { width = 320, height = 180, unit = '' } = opts;
  container.innerHTML = '';
  if (!bars.length) {
    container.innerHTML = '<div class="chart-empty">Todavía no hay datos para graficar.</div>';
    return;
  }

  const pad = { top: 14, right: 12, bottom: 34, left: 12 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const maxV = Math.max(...bars.map(b => b.value)) || 1;
  const gap = 2;
  const slot = w / bars.length;
  const barW = Math.min(24, slot - gap);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'viz-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.ariaLabel || 'Gráfico de barras');

  svg.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: pad.top + h, y2: pad.top + h, class: 'viz-baseline' }));

  const tooltip = document.createElement('div');
  tooltip.className = 'viz-tooltip';
  tooltip.hidden = true;

  bars.forEach((b, i) => {
    const barH = Math.max(2, (b.value / maxV) * h);
    const x = pad.left + i * slot + (slot - barW) / 2;
    const y = pad.top + h - barH;
    const rectEl = svgEl('rect', {
      x, y, width: barW, height: barH, rx: 4, ry: 4,
      style: `fill: var(${b.colorVar})`, class: 'viz-bar',
    });
    svg.appendChild(rectEl);
    svg.appendChild(svgEl('text', {
      x: x + barW / 2, y: pad.top + h + 14, class: 'viz-tick', 'text-anchor': 'middle',
    }, truncate(b.label, 10)));

    rectEl.addEventListener('mouseenter', (e) => {
      tooltip.hidden = false;
      tooltip.style.left = `${((x + barW / 2) / width) * 100}%`;
      tooltip.style.top = `${(y / height) * 100}%`;
      tooltip.innerHTML = `<b>${b.value}${unit}</b><span>${b.label}</span>`;
    });
    rectEl.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });

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

function roundTick(v) {
  if (Math.abs(v) >= 100) return Math.round(v).toString();
  return (Math.round(v * 2) / 2).toString();
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
