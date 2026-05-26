/* ── constants ─────────────────────────────────────────────────────────── */
const TOTAL_STAGES = 6;
const CELL_DEG     = 0.5;

// VPD × fire bivariate palette  [fire_bin 0-2][vpd_bin 0-2]
const BIVARIATE_VPD = [
  ["#f5f0e8", "#f0e0b8", "#e8c040"],   // low fire: cream → warm yellow
  ["#e8a860", "#d08838", "#b86820"],   // mid fire: amber
  ["#d05020", "#b83010", "#8b1208"],   // high fire: orange-red → dark crimson
];

// RH × fire bivariate (low RH = risky; palette mirrors VPD but on rh axis)
// [fire_bin 0-2][rh_bin 0-2]  rh_bin 0 = LOW rh (dangerous), 2 = HIGH rh (safe)
const BIVARIATE_RH = [
  ["#f0c860", "#f0e8c0", "#dce8f0"],   // low fire: yellow(dry) → cream → sky
  ["#e8a828", "#d4b880", "#88b8d4"],   // mid fire
  ["#c04010", "#b07040", "#4488b0"],   // high fire: red(dry) → brown → teal(wet)
];

const STATE_REGIONS = {
  "West":             ["California","Oregon","Washington","Nevada","Arizona"],
  "Mountain/Plains":  ["Colorado","Utah","Idaho","Montana","Wyoming","New Mexico",
                       "North Dakota","South Dakota","Nebraska","Kansas","Oklahoma"],
  "South-Central":    ["Texas","Louisiana","Mississippi","Arkansas","Alabama",
                       "Georgia","Florida","South Carolina"],
  "East":             ["Tennessee","Kentucky","Virginia","West Virginia","North Carolina",
                       "Delaware","Maryland","Pennsylvania","New York","New Jersey",
                       "Connecticut","Rhode Island","Massachusetts","Vermont",
                       "New Hampshire","Maine","Ohio","Indiana","Michigan","Wisconsin",
                       "Illinois","Iowa","Minnesota","Missouri"],
};
const REGION_COLORS = {
  "West":            "#e0532a",
  "Mountain/Plains": "#f6b042",
  "South-Central":   "#4cc2ff",
  "East":            "#a78bfa",
};

// Notable states to label in scatter
const LABEL_STATES = new Set([
  "California","Oregon","Idaho","Montana","Wyoming","Nevada","Utah",
  "Arizona","Washington","Texas","Florida","New Mexico",
]);

/* ── globals ────────────────────────────────────────────────────────────── */
let usTopo, fires, stateClimate, stateWeekly, correlations;
let stateFC, weeks;
let stateClimateMap = new Map();   // name → climate row
let stateWeekMap    = new Map();   // "week__name" → weekly climate row
let stateCache      = new Map();
let fireCellStateCache = new Map(); // "lat,lon" → state name (precomputed)
let vpdBreaks, fireBreaks, rhBreaks;
let currentStage = 1;
let panelRevealTimer = null;

const STAGES = {
  1: { render: renderStage1, controls: stage1Controls, showPanel: false, panelDelay: 0 },
  2: { render: renderStage2, controls: stage2Controls, showPanel: false, panelDelay: 0 },
  3: { render: renderStage3, controls: () => "", showPanel: true,  panelDelay: 600 },
  4: { render: renderStage4, controls: () => "", showPanel: false, panelDelay: 0 },
  5: { render: renderStage5, controls: () => "", showPanel: false, panelDelay: 0 },
  6: { render: renderStage6, controls: () => "", showPanel: false, panelDelay: 0 },
};

/* ── helpers ────────────────────────────────────────────────────────────── */
function clearViz() { d3.select("#main-viz").selectAll("*").remove(); }

function buildMap(width, height) {
  const svg = d3.select("#main-viz").append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("width", "100%").style("height", "100%");
  const projection = d3.geoAlbersUsa()
    .scale(width * 1.3).translate([width / 2, height / 2]);
  const path = d3.geoPath(projection);
  return { svg, projection, path };
}

function paintStateBase(svg, path, fillFn) {
  return svg.append("g").selectAll("path")
    .data(stateFC.features).enter()
    .append("path").attr("class", "state-fill").attr("d", path)
    .attr("fill", fillFn || "#fbfaf7")
    .attr("stroke", "#1f1f1f").attr("stroke-width", 1.8);
}

function findState(lon, lat) {
  const k = `${lon.toFixed(2)},${lat.toFixed(2)}`;
  if (stateCache.has(k)) return stateCache.get(k);
  for (const f of stateFC.features) {
    if (d3.geoContains(f, [lon, lat])) { stateCache.set(k, f.properties.name); return f.properties.name; }
  }
  stateCache.set(k, null);
  return null;
}
function findStateForCell(d) {
  return findState(d.lon + CELL_DEG / 2, d.lat + CELL_DEG / 2);
}

function regionFor(stateName) {
  for (const [reg, states] of Object.entries(STATE_REGIONS)) {
    if (states.includes(stateName)) return reg;
  }
  return "East";
}

function linReg(data, xKey, yKey) {
  const n  = data.length;
  const mx = d3.mean(data, d => d[xKey]);
  const my = d3.mean(data, d => d[yKey]);
  const num = d3.sum(data, d => (d[xKey] - mx) * (d[yKey] - my));
  const den = d3.sum(data, d => (d[xKey] - mx) ** 2);
  const b = den ? num / den : 0;
  const a = my - b * mx;
  return { a, b };
}

/* ── precompute ─────────────────────────────────────────────────────────── */
function precompute() {
  weeks = [...new Set(fires.map(d => d.week))].sort();

  // state climate lookup
  for (const d of stateClimate) stateClimateMap.set(d.state, d);

  // weekly climate lookup
  for (const d of stateWeekly) stateWeekMap.set(`${d.week}__${d.state}`, d);

  // fire quantile breaks across states
  const activeStates = stateClimate.filter(s => s.totalFire > 0);
  const sortedFire   = activeStates.map(s => s.totalFire).sort(d3.ascending);
  fireBreaks = [d3.quantile(sortedFire, 0.33), d3.quantile(sortedFire, 0.66)];

  const sortedVpd = activeStates.map(s => s.vpd).sort(d3.ascending);
  vpdBreaks = [d3.quantile(sortedVpd, 0.33), d3.quantile(sortedVpd, 0.66)];

  const sortedRh = activeStates.map(s => s.rmin).sort(d3.ascending);
  rhBreaks = [d3.quantile(sortedRh, 0.33), d3.quantile(sortedRh, 0.66)];

  // warm the cell→state cache for all unique fire cells
  const uniqueCells = [...new Map(fires.map(d => [`${d.lat},${d.lon}`, d])).values()];
  for (const d of uniqueCells) {
    const key = `${d.lon.toFixed(2)},${d.lat.toFixed(2)}`;
    if (!stateCache.has(key)) {
      const lon = d.lon + CELL_DEG / 2;
      const lat = d.lat + CELL_DEG / 2;
      let found = null;
      for (const f of stateFC.features) {
        if (d3.geoContains(f, [lon, lat])) { found = f.properties.name; break; }
      }
      stateCache.set(key, found);
    }
  }
}

function binFire(v) { return v <= fireBreaks[0] ? 0 : v <= fireBreaks[1] ? 1 : 2; }
function binVpd(v)  { return v <= vpdBreaks[0]  ? 0 : v <= vpdBreaks[1]  ? 1 : 2; }
function binRh(v)   { return v <= rhBreaks[0]   ? 0 : v <= rhBreaks[1]   ? 1 : 2; }

/* ── navigation ─────────────────────────────────────────────────────────── */
function buildStageDots() {
  const wrap = d3.select("#stage-dots");
  wrap.selectAll("*").remove();
  for (let i = 1; i <= TOTAL_STAGES; i++) {
    wrap.append("div").attr("class", "dot").attr("data-stage", i)
      .on("click", () => goToStage(i));
  }
}

function goToStage(n) {
  if (n < 1 || n > TOTAL_STAGES) return;
  currentStage = n;
  const cfg = STAGES[n];

  d3.selectAll(".stage-dots .dot").classed("active", function() {
    return +this.dataset.stage === n;
  });
  d3.selectAll(".step").classed("active", function() {
    return +this.dataset.stage === n;
  });

  const vizArea = document.querySelector(".viz-area");
  const panel   = document.getElementById("state-panel");
  if (panelRevealTimer) { clearTimeout(panelRevealTimer); panelRevealTimer = null; }

  if (cfg.showPanel) {
    panel.innerHTML = `<div class="state-panel-placeholder">Click any state to see its climate profile.</div>`;
    if (cfg.panelDelay > 0) {
      vizArea.classList.add("fullwidth"); panel.classList.add("hidden");
      panelRevealTimer = setTimeout(() => {
        vizArea.classList.remove("fullwidth"); panel.classList.remove("hidden");
      }, cfg.panelDelay);
    } else {
      vizArea.classList.remove("fullwidth"); panel.classList.remove("hidden");
    }
  } else {
    vizArea.classList.add("fullwidth"); panel.classList.add("hidden");
  }

  document.getElementById("stage-controls").innerHTML = cfg.controls();
  cfg.render();
}

/* ── scrollytelling IntersectionObserver ────────────────────────────────── */
function setupScrolly() {
  // Gate: ignore observer callbacks until the user actually starts scrolling.
  // Without this, the observer fires for every step visible at page load
  // and jumps away from stage 1 before the user scrolls.
  let scrollActive = false;
  window.addEventListener("scroll", () => { scrollActive = true; }, { once: true, passive: true });

  const obs = new IntersectionObserver(entries => {
    if (!scrollActive) return;
    let best = null, bestRatio = 0;
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio > bestRatio) {
        best = e; bestRatio = e.intersectionRatio;
      }
    }
    if (best) {
      const s = +best.target.dataset.stage;
      if (s !== currentStage) goToStage(s);
    }
  }, { threshold: [0.3, 0.5, 0.7] });

  document.querySelectorAll(".step").forEach(el => obs.observe(el));
}

/* ══════════════════════════════════════════════════════════════════════════
   STAGE 1 – weekly fire animation
═══════════════════════════════════════════════════════════════════════════ */
function stage1Controls() {
  return `
    <label for="week-slider">Week starting: <span id="week-label"></span></label>
    <input type="range" id="week-slider" min="0" max="${weeks.length - 1}" value="0" step="1">
  `;
}

function renderStage1() {
  clearViz();
  const { svg, projection, path } = buildMap(900, 540);
  paintStateBase(svg, path);
  const layer = svg.append("g");
  const tip   = d3.select("#tooltip");

  const projFires = fires.map(d => {
    if (findStateForCell(d) === null) return null;
    const p = projection([d.lon, d.lat]);
    return p ? { ...d, _x: p[0], _y: p[1] } : null;
  }).filter(Boolean);

  const sizeScale  = d3.scaleSqrt().domain([1, d3.max(projFires, d => d.power) || 1]).range([2, 14]);
  const colorScale = d3.scaleSequential(d3.interpolateOrRd).domain([0, d3.max(projFires, d => d.maxPower) || 1]);

  const weekTotals = d3.rollup(projFires, v => d3.sum(v, d => d.power), d => d.week);
  const defaultWk  = d3.greatest(weeks, w => weekTotals.get(w) || 0);

  const slider = document.getElementById("week-slider");
  slider.value = weeks.indexOf(defaultWk);
  const label = document.getElementById("week-label");

  function draw() {
    const w      = weeks[+slider.value];
    label.textContent = w;
    const wkData = projFires.filter(d => d.week === w);
    const sel    = layer.selectAll("circle").data(wkData, d => `${d.lat},${d.lon}`);
    sel.enter().append("circle")
      .attr("stroke", "#1a1a1a").attr("stroke-opacity", 0.35)
      .on("mousemove", (event, d) => {
        tip.style("display", "block")
          .style("left", (event.pageX + 14) + "px").style("top", (event.pageY + 14) + "px")
          .html(`<strong>Fire cell ${d.lat.toFixed(1)}°N, ${Math.abs(d.lon).toFixed(1)}°W</strong><br>
                 Week of ${d.week}<br>Total power: ${d.power.toLocaleString(undefined,{maximumFractionDigits:0})} MW`);
      })
      .on("mouseleave", () => tip.style("display", "none"))
      .merge(sel)
      .attr("cx", d => d._x).attr("cy", d => d._y)
      .attr("r",  d => sizeScale(d.power))
      .attr("fill", d => colorScale(d.maxPower))
      .attr("fill-opacity", 0.85);
    sel.exit().remove();
  }
  slider.addEventListener("input", draw);
  draw();
}

/* ══════════════════════════════════════════════════════════════════════════
   STAGE 2 – VPD choropleth + fire circles
═══════════════════════════════════════════════════════════════════════════ */
function stage2Controls() {
  return `
    <label for="week-slider">Week starting: <span id="week-label"></span></label>
    <input type="range" id="week-slider" min="0" max="${weeks.length - 1}" value="0" step="1">
  `;
}

function renderStage2() {
  clearViz();
  const W = 900, H = 540;
  const { svg, projection, path } = buildMap(W, H);

  const vpdMax   = d3.max(stateWeekly, d => d.vpd) || 4;
  const vpdColor = d3.scaleSequential().domain([0.3, vpdMax]).interpolator(d3.interpolateOrRd);

  const statePaths = svg.append("g").selectAll("path")
    .data(stateFC.features).enter()
    .append("path").attr("d", path)
    .attr("fill", "#f5f0e8").attr("stroke", "#1f1f1f").attr("stroke-width", 1.8);

  // fire circles
  const projFires = fires.map(d => {
    const p = projection([d.lon, d.lat]);
    return p ? { ...d, _x: p[0], _y: p[1] } : null;
  }).filter(Boolean);
  const sizeScale = d3.scaleSqrt().domain([1, d3.max(projFires, d => d.power) || 1]).range([1.5, 14]);
  const circleLayer = svg.append("g");
  const tip = d3.select("#tooltip");

  // VPD gradient legend
  const defs = svg.append("defs");
  const lgId  = "vpd-grad";
  const lg    = defs.append("linearGradient").attr("id", lgId).attr("x1","0%").attr("x2","100%");
  [0,0.25,0.5,0.75,1].forEach(t => {
    const v = 0.3 + (vpdMax - 0.3) * t;
    lg.append("stop").attr("offset", `${t*100}%`).attr("stop-color", vpdColor(v));
  });
  const lgG = svg.append("g").attr("transform", "translate(14, 390)");
  lgG.append("rect").attr("width",130).attr("height",10).attr("rx",2).style("fill", `url(#${lgId})`);
  lgG.append("text").attr("y",-4).style("font-size","9px").style("font-family","Helvetica Neue,sans-serif")
    .style("text-transform","uppercase").style("letter-spacing","1px").style("fill","#6b6b6b")
    .text("Vapor Pressure Deficit");
  lgG.append("text").attr("y",22).style("font-size","9px").style("fill","#6b6b6b").text("Low (0.3 kPa)");
  lgG.append("text").attr("x",130).attr("y",22).attr("text-anchor","end").style("font-size","9px").style("fill","#6b6b6b")
    .text(`High (${vpdMax.toFixed(1)} kPa)`);

  // fire circle legend
  const lc = svg.append("g").attr("transform", "translate(14, 445)");
  lc.append("text").style("font-size","9px").style("font-family","Helvetica Neue,sans-serif")
    .style("text-transform","uppercase").style("letter-spacing","1px").style("fill","#6b6b6b")
    .text("● Active fire cell (size = MW)");

  function draw() {
    const w = weeks[+document.getElementById("week-slider").value];
    document.getElementById("week-label").textContent = w;

    // update choropleth
    statePaths.attr("fill", d => {
      const row = stateWeekMap.get(`${w}__${d.properties.name}`);
      return row ? vpdColor(row.vpd) : "#f5f0e8";
    });

    // update fire circles
    const wkFires = projFires.filter(d => d.week === w);
    const sel = circleLayer.selectAll("circle").data(wkFires, d => `${d.lat},${d.lon}`);
    sel.enter().append("circle")
      .attr("stroke", "#fff").attr("stroke-width", 0.6)
      .on("mousemove", (event, d) => {
        tip.style("display","block")
          .style("left",(event.pageX+14)+"px").style("top",(event.pageY+14)+"px")
          .html(`<strong>Fire cell</strong><br>${d.lat.toFixed(1)}°N, ${Math.abs(d.lon).toFixed(1)}°W<br>
                 Power: ${d.power.toLocaleString(undefined,{maximumFractionDigits:0})} MW`);
      })
      .on("mouseleave", () => tip.style("display","none"))
      .merge(sel)
      .attr("cx", d => d._x).attr("cy", d => d._y)
      .attr("r",  d => sizeScale(d.power))
      .attr("fill", "#ff4500").attr("fill-opacity", 0.75);
    sel.exit().remove();
  }

  const slider = document.getElementById("week-slider");
  // default to peak fire week
  const weekTotals = d3.rollup(projFires, v => d3.sum(v, d => d.power), d => d.week);
  const peakWk = d3.greatest(weeks, w => weekTotals.get(w) || 0);
  slider.value = weeks.indexOf(peakWk);
  slider.addEventListener("input", draw);
  draw();
}

/* ══════════════════════════════════════════════════════════════════════════
   STAGE 3 – VPD × fire bivariate choropleth
═══════════════════════════════════════════════════════════════════════════ */
function renderStage3() {
  clearViz();
  const { svg, path } = buildMap(720, 460);
  const tip = d3.select("#tooltip");
  const noData = "#fbfaf7";

  function bivColor(stateName) {
    const d = stateClimateMap.get(stateName);
    if (!d || (d.totalFire === 0 && d.vpd === 0)) return noData;
    return BIVARIATE_VPD[binFire(d.totalFire)][binVpd(d.vpd)];
  }

  const statePaths = svg.append("g").selectAll("path")
    .data(stateFC.features).enter()
    .append("path").attr("d", path)
    .attr("fill", noData).attr("stroke","#1f1f1f").attr("stroke-width",1.8)
    .style("cursor","pointer");

  statePaths
    .on("mousemove", function(event, d) {
      const sc = stateClimateMap.get(d.properties.name);
      tip.style("display","block")
        .style("left",(event.pageX+14)+"px").style("top",(event.pageY+14)+"px")
        .html(`<strong>${d.properties.name}</strong><br>
               Avg summer VPD: ${sc ? sc.vpd.toFixed(2) + " kPa" : "n/a"}<br>
               Total fire power: ${sc && sc.totalFire > 0 ? sc.totalFire.toLocaleString(undefined,{maximumFractionDigits:0}) + " MW" : "none"}<br>
               <em>click for climate profile</em>`);
      statePaths.attr("stroke-width", x => x.properties.name === d.properties.name ? 3.2 : 1.8)
                .attr("stroke", x => x.properties.name === d.properties.name ? "#b8453a" : "#1f1f1f");
    })
    .on("mouseleave", () => {
      tip.style("display","none");
      statePaths.attr("stroke-width",1.8).attr("stroke","#1f1f1f");
    })
    .on("click", (event, d) => {
      renderClimatePanel(d.properties.name);
      statePaths.attr("stroke-width", x => x.properties.name === d.properties.name ? 3.2 : 1.8)
                .attr("stroke", x => x.properties.name === d.properties.name ? "#b8453a" : "#1f1f1f");
    });

  statePaths.transition().delay((d,i) => i * 12).duration(700)
    .attr("fill", d => bivColor(d.properties.name));

  // bivariate legend
  const lg = svg.append("g").attr("class","legend-group").style("opacity",0);
  drawVpdBivLegend(lg);
  lg.transition().delay(800).duration(450).style("opacity",1);
}

function drawVpdBivLegend(g) {
  const size = 20, left = 10, top = 330;
  g.append("rect").attr("x",left-4).attr("y",top-22).attr("width",130).attr("height",110)
    .attr("fill","rgba(251,250,247,0.96)").attr("stroke","#1f1f1f");
  g.append("text").attr("x",left+26).attr("y",top-7).attr("fill","#6b6b6b")
    .style("font-size","9px").style("text-transform","uppercase").style("letter-spacing","1px")
    .text("VPD →");
  g.append("text").attr("x",left+8).attr("y",top+40)
    .attr("transform",`rotate(-90,${left+8},${top+40})`).attr("fill","#6b6b6b")
    .style("font-size","9px").style("text-transform","uppercase").style("letter-spacing","1px")
    .text("Fire →");
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      g.append("rect")
        .attr("x", left+24+col*size).attr("y", top+(2-row)*size)
        .attr("width",size).attr("height",size)
        .attr("fill", BIVARIATE_VPD[row][col])
        .attr("stroke","#fbfaf7").attr("stroke-width",1);
    }
  }
}

function renderClimatePanel(stateName) {
  const panel = d3.select("#state-panel");
  panel.selectAll("*").remove();
  const sc = stateClimateMap.get(stateName);
  if (!sc) {
    panel.append("div").attr("class","state-panel-placeholder").text("No data for " + stateName);
    return;
  }
  panel.append("h3").text(stateName);
  panel.append("div").attr("class","panel-sub").text("Fire season 2024 average");

  const rows = [
    ["Avg VPD",      sc.vpd.toFixed(2) + " kPa",  "vpd"],
    ["Avg max temp", sc.tmax.toFixed(1) + " °F",   ""],
    ["Min humidity", sc.rmin.toFixed(1) + " %",    ""],
    ["Burning Index",sc.bi.toFixed(1),              ""],
    ["Total fire MW",(sc.totalFire > 0 ? sc.totalFire.toLocaleString(undefined,{maximumFractionDigits:0}) + " MW" : "none"), "fire"],
  ];
  const rd = panel.append("div");
  rows.forEach(([label, val, cls]) => {
    rd.append("div").attr("class","stat-row")
      .html(`<span class="stat-label">${label}</span>
             <span class="stat-val ${cls}">${val}</span>`);
  });

  // mini bar chart of weekly fire
  const W = 175, H = 90, M = {top:6,right:6,bottom:18,left:26};
  const chart = panel.append("div").attr("class","panel-chart")
    .append("svg").attr("viewBox",`0 0 ${W} ${H}`).style("width","100%").style("height",H+"px");
  const series = weeks.map(w => ({
    week: w,
    vpd:  (stateWeekMap.get(`${w}__${stateName}`)?.vpd) || 0,
    fire: 0, // fill from fires agg below
  }));
  // crude fire agg per week per state (just for panel)
  const fireTotals = d3.rollup(
    fires.filter(d => findStateForCell(d) === stateName),
    v => d3.sum(v, d => d.power), d => d.week
  );
  series.forEach(s => { s.fire = fireTotals.get(s.week) || 0; });

  const x = d3.scaleBand().domain(weeks).range([M.left,W-M.right]).padding(0.1);
  const yFire = d3.scaleLinear().domain([0,d3.max(series,d=>d.fire)||1]).range([H-M.bottom,M.top]);
  const yVpd  = d3.scaleLinear().domain([0,d3.max(series,d=>d.vpd)||1]).range([H-M.bottom,M.top]);

  chart.append("g").selectAll("rect").data(series).enter().append("rect")
    .attr("x",d=>x(d.week)).attr("y",d=>yFire(d.fire))
    .attr("width",x.bandwidth()).attr("height",d=>H-M.bottom-yFire(d.fire))
    .attr("fill","#e0532a").attr("fill-opacity",0.85);

  const vpdLine = d3.line().x(d=>x(d.week)+x.bandwidth()/2).y(d=>yVpd(d.vpd)).curve(d3.curveMonotoneX);
  chart.append("path").datum(series).attr("d",vpdLine)
    .attr("fill","none").attr("stroke","#b8453a").attr("stroke-width",2).attr("stroke-dasharray","4 2");

  const tickWeeks = [weeks[0], weeks[Math.floor(weeks.length/2)], weeks[weeks.length-1]];
  chart.append("g").attr("class","axis").attr("transform",`translate(0,${H-M.bottom})`)
    .call(d3.axisBottom(x).tickValues(tickWeeks).tickFormat(d=>d.slice(5)));

  panel.append("div").attr("class","panel-sub").style("text-align","center").style("margin-top","0")
    .html(`<span style="color:#e0532a">■</span> fire MW &nbsp;
           <span style="color:#b8453a">╌</span> VPD`);

  const verdict = sc.totalFire > 50000
    ? `High fire season. Mean VPD ${sc.vpd.toFixed(2)} kPa suggests strong atmospheric dryness.`
    : sc.totalFire > 0
      ? `Moderate fire activity. VPD of ${sc.vpd.toFixed(2)} kPa is ${sc.vpd > 1.5 ? "elevated" : "moderate"}.`
      : `No major fire activity. VPD of ${sc.vpd.toFixed(2)} kPa is relatively ${sc.vpd < 1.0 ? "low" : "moderate"}.`;
  panel.append("div").attr("class","panel-verdict").html(verdict);
}

/* ══════════════════════════════════════════════════════════════════════════
   STAGE 4 – side-by-side scatter: VPD vs fire / lightning vs fire
═══════════════════════════════════════════════════════════════════════════ */
function renderStage4() {
  clearViz();
  const W = 900, H = 520;
  const svg = d3.select("#main-viz").append("svg")
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("preserveAspectRatio","xMidYMid meet")
    .style("width","100%").style("height","100%");

  const tip = d3.select("#tooltip");

  // filter states with fire data
  const states = stateClimate.filter(s => s.totalFire > 0);
  const logFire = s => Math.log10(s.totalFire + 1);

  const regionColor = d3.scaleOrdinal()
    .domain(Object.keys(STATE_REGIONS))
    .range(Object.values(REGION_COLORS));

  // ── left panel: VPD vs fire ──
  const M1 = {top:36, right:12, bottom:52, left:52};
  const PW = (W - 20) / 2, PH = H;

  function drawPanel(xAccessor, xLabel, corrR, panelOffsetX, highlight) {
    const xVals = states.map(xAccessor);
    const yVals = states.map(logFire);

    const x = d3.scaleLinear().domain(d3.extent(xVals)).nice().range([M1.left, PW-M1.right]);
    const y = d3.scaleLinear().domain(d3.extent(yVals)).nice().range([PH-M1.bottom, M1.top]);

    const g = svg.append("g").attr("transform", `translate(${panelOffsetX},0)`);

    // grid lines
    g.append("g").attr("class","grid").attr("transform",`translate(${M1.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(PW-M1.left-M1.right)).tickFormat(""));
    g.append("g").attr("class","grid").attr("transform",`translate(0,${PH-M1.bottom})`)
      .call(d3.axisBottom(x).ticks(5).tickSize(-(PH-M1.top-M1.bottom)).tickFormat(""));

    // regression line
    const { a, b } = linReg(states.map((s,i)=>({x:xVals[i],y:yVals[i]})), "x", "y");
    const [x0,x1] = d3.extent(xVals);
    g.append("line").attr("class","reg-line")
      .attr("x1",x(x0)).attr("y1",y(a+b*x0))
      .attr("x2",x(x1)).attr("y2",y(a+b*x1));

    // axes
    g.append("g").attr("class","axis").attr("transform",`translate(0,${PH-M1.bottom})`)
      .call(d3.axisBottom(x).ticks(5))
      .append("text").attr("x",PW/2).attr("y",38).attr("fill","currentColor")
      .attr("text-anchor","middle").style("font-size","11px").text(xLabel);
    g.append("g").attr("class","axis").attr("transform",`translate(${M1.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(d => d > 0 ? `10^${d.toFixed(0)}` : "0"))
      .append("text").attr("x",-(PH/2)).attr("y",-38)
      .attr("transform","rotate(-90)").attr("fill","currentColor")
      .attr("text-anchor","middle").style("font-size","11px").text("Fire power (MW, log)");

    // dots
    g.append("g").selectAll("circle").data(states).enter().append("circle")
      .attr("cx", (s,i) => x(xVals[i]))
      .attr("cy", s => y(logFire(s)))
      .attr("r", 5.5)
      .attr("fill", s => regionColor(regionFor(s.state)))
      .attr("fill-opacity", 0.82)
      .attr("stroke","#fbfaf7").attr("stroke-width",0.8)
      .on("mousemove", (event, s) => {
        tip.style("display","block")
          .style("left",(event.pageX+14)+"px").style("top",(event.pageY+14)+"px")
          .html(`<strong>${s.state}</strong><br>
                 VPD: ${s.vpd.toFixed(2)} kPa<br>
                 Fire: ${s.totalFire.toLocaleString(undefined,{maximumFractionDigits:0})} MW<br>
                 Lightning: ${s.lightning.toFixed(1)} avg flashes`);
      })
      .on("mouseleave", () => tip.style("display","none"));

    // labels for notable states
    const labelData = states.map((s,i) => ({...s, _xi: i})).filter(s => LABEL_STATES.has(s.state));
    g.append("g").selectAll("text.state-lbl").data(labelData).enter()
      .append("text").attr("class","state-lbl")
      .attr("x", s => x(xVals[s._xi]) + 7)
      .attr("y", s => y(logFire(s)) + 4)
      .style("font-size","9px")
      .style("font-family","Helvetica Neue,sans-serif")
      .style("fill","#3a3a3a")
      .text(s => s.state.length > 10 ? s.state.split(" ")[0] : s.state);

    // correlation badge
    const rText = `r = ${corrR >= 0 ? "+" : ""}${corrR.toFixed(2)}`;
    const isStrong = Math.abs(corrR) > 0.3;
    g.append("text")
      .attr("x", PW - M1.right - 6).attr("y", M1.top + 4)
      .attr("text-anchor","end")
      .style("font-family","Helvetica Neue,sans-serif")
      .style("font-size","13px").style("font-weight","700")
      .style("fill", isStrong ? "#b8453a" : "#6b6b6b")
      .text(rText);

    // panel title
    g.append("text")
      .attr("x", M1.left).attr("y", 18)
      .style("font-family","Helvetica Neue,sans-serif")
      .style("font-size","11px").style("text-transform","uppercase")
      .style("letter-spacing","1.5px").style("font-weight","700")
      .style("fill", isStrong ? "#b8453a" : "#6b6b6b")
      .text(highlight);
  }

  drawPanel(s => s.vpd,       "Mean Summer VPD (kPa)",  0.64, 0,      "VPD vs Fire");
  drawPanel(s => s.lightning, "Avg Prior Lightning",    0.04, PW+20,  "Lightning vs Fire");

  // region legend (bottom center)
  const legG = svg.append("g").attr("transform",`translate(${W/2-90},${H-16})`);
  Object.entries(REGION_COLORS).forEach(([reg, col], i) => {
    legG.append("circle").attr("cx", i * 130).attr("cy",0).attr("r",5).attr("fill",col);
    legG.append("text").attr("x", i * 130 + 9).attr("y",4)
      .style("font-size","10px").style("font-family","Helvetica Neue,sans-serif")
      .style("fill","#6b6b6b").text(reg);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   STAGE 5 – Relative Humidity × fire bivariate choropleth
═══════════════════════════════════════════════════════════════════════════ */
function renderStage5() {
  clearViz();
  const { svg, path } = buildMap(720, 460);
  const tip = d3.select("#tooltip");
  const noData = "#fbfaf7";

  function bivColorRh(stateName) {
    const d = stateClimateMap.get(stateName);
    if (!d || d.totalFire === 0 && d.rmin === 0) return noData;
    // rh_bin: 0 = LOW (dangerous), 2 = HIGH (safe) — invert for binRh
    return BIVARIATE_RH[binFire(d.totalFire)][binRh(d.rmin)];
  }

  const statePaths = svg.append("g").selectAll("path")
    .data(stateFC.features).enter()
    .append("path").attr("d", path)
    .attr("fill", noData).attr("stroke","#1f1f1f").attr("stroke-width",1.8)
    .style("cursor","pointer");

  statePaths
    .on("mousemove", function(event, d) {
      const sc = stateClimateMap.get(d.properties.name);
      tip.style("display","block")
        .style("left",(event.pageX+14)+"px").style("top",(event.pageY+14)+"px")
        .html(`<strong>${d.properties.name}</strong><br>
               Min humidity: ${sc ? sc.rmin.toFixed(1) + " %" : "n/a"}<br>
               Total fire power: ${sc && sc.totalFire > 0 ? sc.totalFire.toLocaleString(undefined,{maximumFractionDigits:0}) + " MW" : "none"}`);
      statePaths.attr("stroke-width", x => x.properties.name === d.properties.name ? 3.2 : 1.8)
                .attr("stroke", x => x.properties.name === d.properties.name ? "#2e7aaa" : "#1f1f1f");
    })
    .on("mouseleave", () => {
      tip.style("display","none");
      statePaths.attr("stroke-width",1.8).attr("stroke","#1f1f1f");
    });

  statePaths.transition().delay((d,i) => i*12).duration(700)
    .attr("fill", d => bivColorRh(d.properties.name));

  // legend
  const lg = svg.append("g").style("opacity",0);
  drawRhBivLegend(lg);
  lg.transition().delay(800).duration(450).style("opacity",1);
}

function drawRhBivLegend(g) {
  const size = 20, left = 10, top = 330;
  g.append("rect").attr("x",left-4).attr("y",top-22).attr("width",140).attr("height",110)
    .attr("fill","rgba(251,250,247,0.96)").attr("stroke","#1f1f1f");
  g.append("text").attr("x",left+30).attr("y",top-7).attr("fill","#6b6b6b")
    .style("font-size","9px").style("text-transform","uppercase").style("letter-spacing","1px")
    .text("Humid →");
  g.append("text").attr("x",left+4).attr("y",top-7).attr("text-anchor","middle").attr("fill","#6b6b6b")
    .style("font-size","9px").text("Dry");
  g.append("text").attr("x",left+8).attr("y",top+40)
    .attr("transform",`rotate(-90,${left+8},${top+40})`).attr("fill","#6b6b6b")
    .style("font-size","9px").style("text-transform","uppercase").style("letter-spacing","1px")
    .text("Fire →");
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      g.append("rect")
        .attr("x",left+24+col*size).attr("y",top+(2-row)*size)
        .attr("width",size).attr("height",size)
        .attr("fill", BIVARIATE_RH[row][col])
        .attr("stroke","#fbfaf7").attr("stroke-width",1);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   STAGE 6 – correlation bar chart
═══════════════════════════════════════════════════════════════════════════ */
function renderStage6() {
  clearViz();
  const W = 900, H = 480;
  const M = {top: 28, right: 130, bottom: 30, left: 220};

  const svg = d3.select("#main-viz").append("svg")
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("preserveAspectRatio","xMidYMid meet")
    .style("width","100%").style("height","100%");

  // Sort by |r_log| descending
  const data = [...correlations].sort((a,b) => Math.abs(b.r_log) - Math.abs(a.r_log));

  const x = d3.scaleLinear().domain([0, 0.8]).range([M.left, W-M.right]);
  const y = d3.scaleBand().domain(data.map(d => d.label)).range([M.top, H-M.bottom]).padding(0.28);

  // gridlines
  svg.append("g").attr("class","grid").attr("transform",`translate(0,${H-M.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(-(H-M.top-M.bottom)).tickFormat(""))
    .select(".domain").remove();

  // axis
  svg.append("g").attr("class","axis").attr("transform",`translate(0,${H-M.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d => `r = ${d}`));

  // "lightning" threshold line
  const lightningR = data.find(d => d.variable === "mean_lightning")?.r_log || 0;

  // bars
  const barG = svg.append("g");
  data.forEach((d, i) => {
    const isLightning = d.variable === "mean_lightning";
    const isVpd       = d.variable === "mean_vpd_kPa";
    const isRh        = d.variable === "mean_rmin_pct";
    const absR        = Math.abs(d.r_log);

    let fill = "#c07040";
    if (isLightning) fill = "#c0b090";
    else if (d.r_log < 0) fill = "#4888b8";
    else if (absR > 0.5) fill = "#b8453a";

    const bar = barG.append("rect")
      .attr("x", M.left)
      .attr("y", y(d.label))
      .attr("width", 0)
      .attr("height", y.bandwidth())
      .attr("fill", fill)
      .attr("opacity", isLightning ? 0.55 : 0.88);

    bar.transition().delay(i * 80).duration(500)
      .attr("width", x(absR) - M.left);

    // r value label
    barG.append("text")
      .attr("x", x(absR) + 6)
      .attr("y", y(d.label) + y.bandwidth() / 2 + 4)
      .style("font-size","11px")
      .style("font-family","Helvetica Neue,sans-serif")
      .style("font-weight","700")
      .style("fill", isLightning ? "#9b9080" : "#3a3a3a")
      .style("opacity",0)
      .text((d.r_log < 0 ? "−" : "+") + absR.toFixed(2))
      .transition().delay(i * 80 + 400).duration(300).style("opacity",1);

    // variable label
    barG.append("text")
      .attr("x", M.left - 8)
      .attr("y", y(d.label) + y.bandwidth() / 2 + 4)
      .attr("text-anchor","end")
      .style("font-size","11.5px")
      .style("font-family","Helvetica Neue,sans-serif")
      .style("font-weight", (isVpd || isRh || isLightning) ? "700" : "400")
      .style("fill", isLightning ? "#9b9080" : isVpd ? "#b8453a" : isRh ? "#2e7aaa" : "#3a3a3a")
      .text(d.label);

    // annotations
    if (isVpd) {
      barG.append("text")
        .attr("x", x(absR) + 46).attr("y", y(d.label) + y.bandwidth()/2 + 4)
        .style("font-size","9px").style("font-family","Helvetica Neue,sans-serif")
        .style("fill","#b8453a").style("font-weight","700").text("← climate driver");
    }
    if (isLightning) {
      barG.append("text")
        .attr("x", x(absR) + 46).attr("y", y(d.label) + y.bandwidth()/2 + 4)
        .style("font-size","9px").style("font-family","Helvetica Neue,sans-serif")
        .style("fill","#9b9080").text("← lightning");
    }
  });

  // title
  svg.append("text").attr("x",M.left).attr("y",16)
    .style("font-family","Helvetica Neue,sans-serif").style("font-size","11px")
    .style("text-transform","uppercase").style("letter-spacing","1.5px")
    .style("font-weight","700").style("fill","#6b6b6b")
    .text("Pearson |r| vs state wildfire intensity (log scale) · 2024 fire season");

  // direction legend
  const dl = svg.append("g").attr("transform",`translate(${M.left},${H-14})`);
  dl.append("rect").attr("width",12).attr("height",8).attr("y",-8).attr("fill","#b8453a").attr("opacity",0.88);
  dl.append("text").attr("x",16).style("font-size","10px").style("fill","#6b6b6b")
    .style("font-family","Helvetica Neue,sans-serif").text("positive (more X = more fire)");
  dl.append("rect").attr("x",210).attr("width",12).attr("height",8).attr("y",-8).attr("fill","#4888b8").attr("opacity",0.88);
  dl.append("text").attr("x",226).style("font-size","10px").style("fill","#6b6b6b")
    .style("font-family","Helvetica Neue,sans-serif").text("negative (more X = less fire)");
}

/* ══════════════════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════════════════ */
async function init() {
  [usTopo, fires, stateClimate, stateWeekly, correlations] = await Promise.all([
    d3.json("data/us-states.topo.json"),
    d3.csv("data/fires_weekly_2024.csv", d => ({
      week:     d.week,
      lat:      +d.lat_bin,
      lon:      +d.lon_bin,
      fires:    +d.fire_count,
      power:    +d.fire_power_MW,
      maxPower: +d.max_power_MW,
      priorLightning: +d.prior_lightning_count,
    })),
    d3.csv("data/state_climate_2024.csv", d => ({
      state:     d.state,
      totalFire: +d.total_fire_power_MW,
      fireCount: +d.fire_count,
      vpd:       +d.mean_vpd_kPa,
      tmax:      +d.mean_tmax_F,
      precip:    +d.total_precip_mm,
      wind:      +d.mean_wind_ms,
      rmin:      +d.mean_rmin_pct,
      bi:        +d.mean_bi,
      erc:       +d.mean_erc,
      lightning: +d.mean_lightning,
    })),
    d3.csv("data/state_weekly_climate_2024.csv", d => ({
      week:  d.week,
      state: d.state,
      vpd:   +d.mean_vpd,
      tmax:  +d.mean_tmax,
      rmin:  +d.mean_rmin,
      bi:    +d.mean_bi,
    })),
    d3.csv("data/correlations_2024.csv", d => ({
      variable: d.variable,
      label:    d.label,
      r_raw:    +d.pearson_r_raw,
      r_log:    +d.pearson_r_log,
    })),
  ]);

  stateFC = topojson.feature(usTopo, usTopo.objects.states);
  precompute();
  buildStageDots();
  setupScrolly();
  goToStage(1);
}

init();
