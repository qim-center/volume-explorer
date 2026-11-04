import { Color } from "three";
import { ControlPoint, Lut, View3d, Volume } from "../../../src";
import { HistogramOpacityPoint, HistogramSelection } from "../state/stateService";
import { clamp01, formatHistogramValue, histogramBinFromX, histogramBinToLut, lutToHistogramBin } from "../utils/math";

interface HistogramControllerOptions {
  canvas: HTMLCanvasElement | null;
  pointTag: HTMLElement | null;
  selection: HistogramSelection;
  getVolume: () => Volume;
  getView3D: () => View3d;
  /** Ordered colormap stops (hex colors) for the current colormap, or null to draw the gray silhouette. */
  getColormapStops?: () => string[] | null;
  /** Colormap range in 0–255 LUT space (maps the x-axis of the colormap across the histogram). */
  getColormapRange?: () => { min: number; max: number };
  onLutUpdated?: (volume: Volume, channelIndex: number) => void;
}

const sampleColormapStops = (stopColors: Color[], t: number): [number, number, number] => {
  if (stopColors.length === 0) {
    return [255, 255, 255];
  }
  if (stopColors.length === 1) {
    const only = stopColors[0];
    return [Math.round(only.r * 255), Math.round(only.g * 255), Math.round(only.b * 255)];
  }

  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stopColors.length - 1);
  const index = Math.min(stopColors.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const a = stopColors[index];
  const b = stopColors[index + 1];
  const r = a.r + (b.r - a.r) * frac;
  const g = a.g + (b.g - a.g) * frac;
  const bcol = a.b + (b.b - a.b) * frac;
  return [Math.round(r * 255), Math.round(g * 255), Math.round(bcol * 255)];
};

const COLORS = {
  silhouette: "#c9c9c3",
  rampFill: "rgba(255, 255, 255, 0.22)",
  ink: "#1b1c1b",
  white: "#ffffff",
};

// accent color is defined once as the --accent CSS variable; the canvas reads it at draw time
const getAccentColor = (): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return value || "#fc7323";
};

const LINE_WIDTH = 1.5;
const POINT_RADIUS = 6;
const POINT_HOVER_BONUS = 1.5;
const POINT_HIT_RADIUS = 12;
const TAG_GAP = 4;

export function createHistogramController(options: HistogramControllerOptions) {
  const { canvas, pointTag, selection, getVolume, getView3D, getColormapStops, getColormapRange, onLutUpdated } =
    options;

  const resizeCanvasToDisplay = (): { width: number; height: number; dpr: number } | null => {
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(rect.width * dpr));
    const targetHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    return { width: canvas.width, height: canvas.height, dpr };
  };

  const pointToCanvas = (
    point: HistogramOpacityPoint,
    binCount: number,
    width: number,
    height: number
  ): [number, number] => [(point.bin / binCount) * width, (1 - point.opacity) * height];

  const updateTag = (hist: any, binCount: number): void => {
    if (!pointTag || !canvas) {
      return;
    }
    const point = selection.dragging ?? selection.hover;
    pointTag.hidden = !point || isHistogramDisabled();
    if (!point || pointTag.hidden) {
      return;
    }

    const valueMin = hist.getValueFromBinIndex(0);
    const valueMax = hist.getValueFromBinIndex(binCount);
    const valueMaxAbs = Math.max(Math.abs(valueMin), Math.abs(valueMax));
    const rect = canvas.getBoundingClientRect();
    const step = (valueMax - valueMin) / (rect.width > 0 ? rect.width : binCount);
    const value = formatHistogramValue(hist.getValueFromBinIndex(point.bin), step, valueMaxAbs);
    pointTag.textContent = `${value} · ${Math.round(point.opacity * 100)}%`;

    const [x, y] = pointToCanvas(point, binCount, rect.width, rect.height);
    const reach = pointTag.offsetWidth / 2;
    const left = rect.width > 2 * reach ? Math.min(Math.max(x, reach), rect.width - reach) : x;
    const above = y - POINT_RADIUS - TAG_GAP - pointTag.offsetHeight;
    pointTag.style.left = `${left}px`;
    pointTag.style.top = `${above >= 0 ? above : y + POINT_RADIUS + TAG_GAP}px`;
  };

  const drawHistogramFromVolume = (volume: Volume, channelIndex: number): void => {
    if (!canvas) {
      return;
    }

    const sized = resizeCanvasToDisplay();
    if (!sized) {
      return;
    }
    const { width: w, height: h, dpr } = sized;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const hist = volume.getHistogram(channelIndex) as any;
    const bins: number[] | Uint32Array | undefined = hist.bins ?? hist.histogram;

    ctx.clearRect(0, 0, w, h);
    if (!bins || bins.length === 0) {
      return;
    }

    const binCount = (i: number): number => (i === 0 ? 0 : bins[i]);

    let maxLog = 0;
    for (let i = 0; i < bins.length; i++) {
      const v = Math.log1p(binCount(i));
      if (v > maxLog) {
        maxLog = v;
      }
    }

    if (maxLog === 0) {
      return;
    }

    const barWidth = w / bins.length;

    // colour the bars with the active colormap when one is available (like the original UI),
    // otherwise fall back to the gray silhouette
    let stopColors: Color[] | null = null;
    let cmMin = 0;
    let cmMax = 0;
    const stops = getColormapStops?.();
    if (stops && stops.length > 0) {
      stopColors = stops.map((stop) => new Color(stop));
      const range = getColormapRange?.() ?? { min: 0, max: 255 };
      cmMin = lutToHistogramBin(hist, range.min);
      cmMax = lutToHistogramBin(hist, range.max);
    }

    for (let i = 0; i < bins.length; i++) {
      const v0 = Math.log1p(binCount(i)) / maxLog;
      const barHeight = v0 * h;
      if (stopColors) {
        const t = (i - cmMin) / (cmMax - cmMin || 1);
        const [r, g, b] = sampleColormapStops(stopColors, t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      } else {
        ctx.fillStyle = COLORS.silhouette;
      }
      // overdraw by 1px so sub-pixel anti-aliasing never leaves a seam between adjacent bars
      ctx.fillRect(i * barWidth, h - barHeight, Math.max(1, Math.ceil(barWidth) + 1), barHeight);
    }

    if (!isHistogramDisabled()) {
      const curve = selection.points.map((point) =>
        pointToCanvas(point, bins.length, w / dpr, h / dpr).map((v) => v * dpr)
      );
      const outline = [[0, curve[0][1]], ...curve, [w, curve[curve.length - 1][1]]];

      ctx.fillStyle = COLORS.rampFill;
      ctx.beginPath();
      ctx.moveTo(0, h);
      outline.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = getAccentColor();
      ctx.lineWidth = LINE_WIDTH * dpr;
      ctx.beginPath();
      outline.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.stroke();

      selection.points.forEach((point, i) => {
        const active = point === selection.hover || point === selection.dragging;
        ctx.beginPath();
        ctx.arc(curve[i][0], curve[i][1], (POINT_RADIUS + (active ? POINT_HOVER_BONUS : 0)) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.white;
        ctx.fill();
        ctx.stroke();
      });
    }

    updateTag(hist, bins.length);
  };

  const isHistogramDisabled = (): boolean => {
    const view3d = getView3D();
    return view3d.isHistogramDisabled?.() ?? false;
  };

  const applyHistogramLutFromBins = (channelIndex: number): void => {
    const volume = getVolume();
    if (!volume) {
      return;
    }

    const hist = volume.getHistogram(channelIndex);
    const { points } = selection;
    const controlPoints: ControlPoint[] = points.map((point) => ({
      x: histogramBinToLut(hist, point.bin),
      opacity: point.opacity,
      color: [255, 255, 255],
    }));
    controlPoints.unshift({ x: 0, opacity: points[0].opacity, color: [255, 255, 255] });
    controlPoints.push({ x: 255, opacity: points[points.length - 1].opacity, color: [255, 255, 255] });

    const view3d = getView3D();
    const lut = isHistogramDisabled()
      ? new Lut().createNoTransparency()
      : new Lut().createFromControlPoints(controlPoints);
    volume.setLut(channelIndex, lut);
    onLutUpdated?.(volume, channelIndex);
    view3d.updateLuts(volume);
    drawHistogramFromVolume(volume, channelIndex);
  };

  const setupInteractions = (): void => {
    if (!canvas) {
      return;
    }

    let grabOffset = { x: 0, y: 0 };
    const getPointer = (
      event: MouseEvent
    ): { x: number; y: number; bin: number; opacity: number; binCount: number } | null => {
      const volume = getVolume();
      if (!volume) {
        return null;
      }
      const hist = volume.getHistogram(0) as any;
      const bins = hist.bins ?? hist.histogram;
      if (!bins) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left + grabOffset.x;
      const y = event.clientY - rect.top + grabOffset.y;
      const opacity = clamp01(1 - y / rect.height);
      return { x, y, bin: histogramBinFromX(x, canvas, bins.length), opacity, binCount: bins.length };
    };

    const findPointAt = (x: number, y: number, binCount: number): HistogramOpacityPoint | null => {
      const rect = canvas.getBoundingClientRect();
      let nearest: HistogramOpacityPoint | null = null;
      let nearestDistance = POINT_HIT_RADIUS;
      for (const point of selection.points) {
        const [px, py] = pointToCanvas(point, binCount, rect.width, rect.height);
        const distance = Math.hypot(x - px, y - py);
        if (distance <= nearestDistance) {
          nearest = point;
          nearestDistance = distance;
        }
      }
      return nearest;
    };

    const redraw = (): void => {
      const volume = getVolume();
      if (volume) {
        drawHistogramFromVolume(volume, 0);
      }
    };

    canvas.addEventListener("pointerdown", (event) => {
      const pointer = getPointer(event);
      if (!pointer || isHistogramDisabled()) {
        return;
      }
      const hit = findPointAt(pointer.x, pointer.y, pointer.binCount);
      if (!hit) {
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      const rect = canvas.getBoundingClientRect();
      const [px, py] = pointToCanvas(hit, pointer.binCount, rect.width, rect.height);
      grabOffset = { x: px - pointer.x, y: py - pointer.y };
      selection.dragging = hit;
      redraw();
    });

    // double-click adds a ramp point, or removes one (at least two are kept)
    canvas.addEventListener("dblclick", (event) => {
      const pointer = getPointer(event);
      if (!pointer || isHistogramDisabled()) {
        return;
      }

      const { points } = selection;
      const hit = findPointAt(pointer.x, pointer.y, pointer.binCount);
      if (!hit) {
        points.push({ bin: pointer.bin, opacity: pointer.opacity });
        points.sort((a, b) => a.bin - b.bin);
      } else if (points.length > 2) {
        points.splice(points.indexOf(hit), 1);
        selection.hover = null;
      }
      applyHistogramLutFromBins(0);
    });

    canvas.addEventListener("pointermove", (event) => {
      const pointer = getPointer(event);
      if (!pointer) {
        return;
      }

      if (isHistogramDisabled()) {
        selection.dragging = null;
        selection.hover = null;
        canvas.style.cursor = "default";
        return;
      }

      if (selection.dragging) {
        selection.dragging.bin = pointer.bin;
        selection.dragging.opacity = pointer.opacity;
        selection.points.sort((a, b) => a.bin - b.bin);
        applyHistogramLutFromBins(0);
        return;
      }

      const nextHover = findPointAt(pointer.x, pointer.y, pointer.binCount);
      if (nextHover !== selection.hover) {
        selection.hover = nextHover;
        redraw();
      }
      canvas.style.cursor = nextHover ? "move" : "default";
    });

    canvas.addEventListener("lostpointercapture", () => {
      selection.dragging = null;
      grabOffset = { x: 0, y: 0 };
      redraw();
    });

    canvas.addEventListener("pointerleave", () => {
      if (selection.dragging) {
        return;
      }
      selection.hover = null;
      canvas.style.cursor = "default";
      redraw();
    });
  };

  return {
    applyHistogramLutFromBins,
    drawHistogramFromVolume,
    setupInteractions,
  };
}
