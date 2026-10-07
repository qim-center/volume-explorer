export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

export const OPACITY_MULTIPLIER = 0.25;

export function densitySliderToView3D(density: number): number {
  return (density / 50.0) * OPACITY_MULTIPLIER;
}

export function gammaSliderToImageValues(sliderValues: [number, number, number]): [number, number, number] {
  let min = Number(sliderValues[0]);
  let mid = Number(sliderValues[1]);
  let max = Number(sliderValues[2]);

  if (mid > max || mid < min) {
    mid = 0.5 * (min + max);
  }
  const div = 255;
  min /= div;
  max /= div;
  mid /= div;
  const diff = max - min;
  const x = (mid - min) / diff;
  let scale = 4 * x * x;
  if ((mid - 0.5) * (mid - 0.5) < 0.0005) {
    scale = 1.0;
  }
  return [min, max, scale];
}

export function histogramBinFromX(x: number, canvas: HTMLCanvasElement, binCount: number): number {
  const displayWidth = canvas.getBoundingClientRect().width;
  const t = x / displayWidth;
  // fractional, so the handles follow the cursor instead of snapping to bins
  return Math.max(0, Math.min(binCount, t * binCount));
}

export function formatColormapRangeValue(value: number): string {
  if (!Number.isFinite(value)) {
    return `${value}`;
  }
  const abs = Math.abs(value);
  if (abs === 0 || (abs >= 1e-3 && abs < 1e6)) {
    // Number() drops trailing zeros
    return `${Number(value.toFixed(3))}`;
  }
  const [significand, exponent] = value.toExponential(3).split("e");
  return `${Number(significand)}e${exponent.replace("+", "")}`;
}

const LUT_MAX = 255;

interface HistogramDataRange {
  getDataMin(): number;
  getDataMax(): number;
  getValueFromBinIndex(binIndex: number): number;
  findFractionalBinOfValue(value: number): number;
}

export function histogramBinToLut(histogram: HistogramDataRange, binIndex: number): number {
  const min = histogram.getDataMin();
  const range = histogram.getDataMax() - min;
  if (!(range > 0)) {
    return 0;
  }
  const lut = ((histogram.getValueFromBinIndex(binIndex) - min) / range) * LUT_MAX;
  return Math.max(0, Math.min(LUT_MAX, lut));
}

export function lutToHistogramValue(histogram: HistogramDataRange, lut: number): number {
  const min = histogram.getDataMin();
  return min + (lut / LUT_MAX) * (histogram.getDataMax() - min);
}

export function histogramValueToLut(histogram: HistogramDataRange, value: number): number {
  const min = histogram.getDataMin();
  const range = histogram.getDataMax() - min;
  if (!(range > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(LUT_MAX, ((value - min) / range) * LUT_MAX));
}

export function lutToHistogramBin(histogram: HistogramDataRange, lut: number): number {
  return histogram.findFractionalBinOfValue(lutToHistogramValue(histogram, lut));
}

const HISTOGRAM_LABEL_MAX_DECIMALS = 3;

export function formatHistogramValue(value: number, step: number, rangeMaxAbs: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return `${value}`;
  }
  if (Math.abs(value) < step / 2) {
    return "0";
  }

  const stepExponent = Math.floor(Math.log10(step) + 1e-9);

  if (-stepExponent <= HISTOGRAM_LABEL_MAX_DECIMALS && rangeMaxAbs < 1e6) {
    const decimals = Math.max(0, -stepExponent);
    return `${Number(value.toFixed(decimals))}`;
  }

  const valueExponent = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.min(15, Math.max(0, valueExponent - stepExponent));
  const [significand, exponent] = value.toExponential(decimals).split("e");
  return `${Number(significand)}e${exponent.replace("+", "")}`;
}
