import { Lut, View3d, Volume } from "../../../src";
import { HistogramSelection } from "../state/stateService";
import { histogramBinFromX } from "../utils/math";

interface HistogramControllerOptions {
  canvas: HTMLCanvasElement | null;
  minTag: HTMLElement | null;
  maxTag: HTMLElement | null;
  selection: HistogramSelection;
  getVolume: () => Volume;
  getView3D: () => View3d;
  onLutUpdated?: (volume: Volume, channelIndex: number) => void;
}

const COLORS = {
  silhouette: "#c9c9c3",
  rampFill: "rgba(31, 122, 77, 0.22)",
  accent: "#1f7a4d",
  ink: "#1b1c1b",
  white: "#ffffff",
};

const HANDLE_WIDTH = 1.5;
const GRIP_RADIUS = 6;
const GRIP_HOVER_BONUS = 1.5;

export function createHistogramController(options: HistogramControllerOptions) {
  const { canvas, minTag, maxTag, selection, getVolume, getView3D, onLutUpdated } = options;
  let histogramHandleAnimationFrame: number | null = null;

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

  const updateTags = (hist: any, minBin: number, maxBin: number, binCount: number): void => {
    if (minTag) {
      minTag.textContent = `${Math.round(hist.getValueFromBinIndex(minBin))}`;
      minTag.style.left = `${(minBin / binCount) * 100}%`;
    }
    if (maxTag) {
      maxTag.textContent = `${Math.round(hist.getValueFromBinIndex(maxBin))}`;
      maxTag.style.left = `${(maxBin / binCount) * 100}%`;
    }
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

    bins[0] = 0;

    let maxLog = 0;
    for (let i = 0; i < bins.length; i++) {
      const v = Math.log1p(bins[i]);
      if (v > maxLog) {
        maxLog = v;
      }
    }

    if (maxLog === 0) {
      return;
    }

    const barWidth = w / bins.length;

    // gray silhouette of the distribution, anchored to the bottom edge
    ctx.fillStyle = COLORS.silhouette;
    for (let i = 0; i < bins.length; i++) {
      const v0 = Math.log1p(bins[i]) / maxLog;
      const barHeight = v0 * h;
      ctx.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth), barHeight);
    }

    if (!isHistogramDisabled()) {
      const minB = selection.minBin;
      const maxB = selection.maxBin;
      const x0 = (minB / bins.length) * w;
      const x1 = (maxB / bins.length) * w;

      if (x1 > x0) {
        // opacity ramp: translucent triangle under the slope + solid accent slope edge
        ctx.fillStyle = COLORS.rampFill;
        ctx.beginPath();
        ctx.moveTo(x0, h);
        ctx.lineTo(x1, 0);
        ctx.lineTo(x1, h);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = HANDLE_WIDTH * dpr;
        ctx.beginPath();
        ctx.moveTo(x0, h);
        ctx.lineTo(x1, 0);
        ctx.stroke();
      }

      // right of the max handle: full opacity
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(x1, 0, Math.max(0, w - x1), h);

      const minHover = selection.hover === "min" || selection.dragging === "min";
      const maxHover = selection.hover === "max" || selection.dragging === "max";
      const minWeight = minHover ? Math.max(selection.minHandleHoverWeight, 0.01) : selection.minHandleHoverWeight;
      const maxWeight = maxHover ? Math.max(selection.maxHandleHoverWeight, 0.01) : selection.maxHandleHoverWeight;

      const drawHandle = (x: number, hoverWeight: number): void => {
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = HANDLE_WIDTH * dpr;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        const gripRadius = (GRIP_RADIUS + GRIP_HOVER_BONUS * hoverWeight) * dpr;
        ctx.beginPath();
        ctx.arc(x, h / 2, gripRadius, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.white;
        ctx.fill();
        ctx.stroke();
      };

      drawHandle(x0, minWeight);
      drawHandle(x1, maxWeight);
    }

    updateTags(hist, selection.minBin, selection.maxBin, bins.length);
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

    const min = selection.minBin;
    const max = selection.maxBin;

    const hist = volume.getHistogram(channelIndex) as any;
    const numBins = (hist.bins ?? hist.histogram)?.length;
    const scale = numBins && numBins > 1 ? 255 / (numBins - 1) : 1;
    const lutMin = Math.round(min * scale);
    const lutMax = Math.round(max * scale);

    const view3d = getView3D();
    const lut = isHistogramDisabled() ? new Lut().createNoTransparency() : new Lut().createFromMinMax(lutMin, lutMax);
    volume.setLut(channelIndex, lut);
    onLutUpdated?.(volume, channelIndex);
    view3d.updateLuts(volume);
    drawHistogramFromVolume(volume, channelIndex);
  };

  const animateHistogramHandleHover = () => {
    const volume = getVolume();
    if (!volume) {
      selection.minHandleHoverWeight = 0;
      selection.maxHandleHoverWeight = 0;
      histogramHandleAnimationFrame = null;
      return;
    }

    const targetMin = selection.hover === "min" || selection.dragging === "min" ? 1 : 0;
    const targetMax = selection.hover === "max" || selection.dragging === "max" ? 1 : 0;
    const easing = 0.25;

    selection.minHandleHoverWeight += (targetMin - selection.minHandleHoverWeight) * easing;
    selection.maxHandleHoverWeight += (targetMax - selection.maxHandleHoverWeight) * easing;

    const minDone = Math.abs(targetMin - selection.minHandleHoverWeight) < 0.01;
    const maxDone = Math.abs(targetMax - selection.maxHandleHoverWeight) < 0.01;

    if (minDone) {
      selection.minHandleHoverWeight = targetMin;
    }
    if (maxDone) {
      selection.maxHandleHoverWeight = targetMax;
    }

    drawHistogramFromVolume(volume, 0);

    if (minDone && maxDone) {
      histogramHandleAnimationFrame = null;
      return;
    }

    histogramHandleAnimationFrame = window.requestAnimationFrame(animateHistogramHandleHover);
  };

  const requestHistogramHandleAnimation = () => {
    if (histogramHandleAnimationFrame !== null) {
      return;
    }
    histogramHandleAnimationFrame = window.requestAnimationFrame(animateHistogramHandleHover);
  };

  const setupInteractions = (): void => {
    if (!canvas) {
      return;
    }

    canvas.addEventListener("mousedown", (event) => {
      const volume = getVolume();
      if (!volume || isHistogramDisabled()) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;

      const hist = volume.getHistogram(0) as any;
      const bins = hist.bins ?? hist.histogram;
      if (!bins) {
        return;
      }

      const b = histogramBinFromX(x, canvas, bins.length);

      const dMin = Math.abs(b - selection.minBin);
      const dMax = Math.abs(b - selection.maxBin);

      selection.dragging = dMin < dMax ? "min" : "max";
      requestHistogramHandleAnimation();
    });

    canvas.addEventListener("mousemove", (event) => {
      const volume = getVolume();
      if (!volume) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;

      const hist = volume.getHistogram(0) as any;
      const bins = hist.bins ?? hist.histogram;
      if (!bins) {
        return;
      }

      if (selection.dragging && !isHistogramDisabled()) {
        const b = histogramBinFromX(x, canvas, bins.length);

        if (selection.dragging === "min") {
          selection.minBin = Math.min(b, selection.maxBin);
        } else {
          selection.maxBin = Math.max(b, selection.minBin);
        }

        applyHistogramLutFromBins(0);
        drawHistogramFromVolume(volume, 0);
        requestHistogramHandleAnimation();
        return;
      }

      if (isHistogramDisabled()) {
        selection.dragging = null;
        selection.hover = null;
        canvas.style.cursor = "default";
        return;
      }

      const displayWidth = canvas.getBoundingClientRect().width;
      const minX = (selection.minBin / bins.length) * displayWidth;
      const maxX = (selection.maxBin / bins.length) * displayWidth;
      const distMin = Math.abs(x - minX);
      const distMax = Math.abs(x - maxX);
      const nextHover = Math.min(distMin, distMax) <= 6 ? (distMin <= distMax ? "min" : "max") : null;

      if (nextHover !== selection.hover) {
        selection.hover = nextHover;
        requestHistogramHandleAnimation();
      }

      canvas.style.cursor = nextHover ? "ew-resize" : "default";
    });

    canvas.addEventListener("mouseup", () => {
      selection.dragging = null;
      requestHistogramHandleAnimation();
    });

    canvas.addEventListener("mouseleave", () => {
      selection.dragging = null;
      selection.hover = null;
      canvas.style.cursor = "default";
      requestHistogramHandleAnimation();
    });
  };

  const setSelectionBins = (minBin: number, maxBin: number): void => {
    selection.minBin = minBin;
    selection.maxBin = maxBin;
  };

  return {
    applyHistogramLutFromBins,
    drawHistogramFromVolume,
    setSelectionBins,
    setupInteractions,
  };
}
