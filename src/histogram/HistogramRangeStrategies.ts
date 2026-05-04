export type HistogramBins = ArrayLike<number>;

export interface HistogramRangeStrategy {
  findRange(bins: HistogramBins): [number, number];
}

const sumBins = (bins: HistogramBins): number => {
  let sum = 0;
  for (let i = 0; i < bins.length; i++) {
    sum += bins[i];
  }
  return sum;
};

// Find bins at 10th / 90th percentile
export class PercentileStrategy implements HistogramRangeStrategy {
  public findRange(bins: HistogramBins): [number, number] {
    const pixcount = sumBins(bins);
    const limit = pixcount / 10;

    let i = 0;
    let count = 0;
    for (i = 1; i < bins.length; ++i) {
      count += bins[i];
      if (count > limit) {
        break;
      }
    }
    const hmin = i;

    count = 0;
    for (i = bins.length - 1; i >= 1; --i) {
      count += bins[i];
      if (count > limit) {
        break;
      }
    }
    const hmax = i;

    return [hmin, hmax];
  }
}

// Find min and max bins attempting to replicate ImageJ's "Auto" button
export class ImageJAutoStrategy implements HistogramRangeStrategy {
  public findRange(bins: HistogramBins): [number, number] {
    // note that consecutive applications of this should modify the auto threshold. see:
    // https://github.com/imagej/ImageJ/blob/7746fcb0f5744a7a7758244c5dcd2193459e6e0e/ij/plugin/frame/ContrastAdjuster.java#L816
    const AUTO_THRESHOLD = 5000;
    const pixcount = sumBins(bins);
    const limit = pixcount / 10;
    const threshold = pixcount / AUTO_THRESHOLD;

    // this will skip the "zero" bin which contains pixels of zero intensity.
    let hmin = bins.length - 1;
    let hmax = 1;
    for (let i = 1; i < bins.length; ++i) {
      if (bins[i] > threshold && bins[i] <= limit) {
        hmin = i;
        break;
      }
    }
    for (let i = bins.length - 1; i >= 1; --i) {
      if (bins[i] > threshold && bins[i] <= limit) {
        hmax = i;
        break;
      }
    }

    if (hmax < hmin) {
      hmin = 0;
      hmax = 255;
    }

    return [hmin, hmax];
  }
}

// Find min and max bins using a percentile of the most commonly occurring value
export class ThresholdStrategy implements HistogramRangeStrategy {
  public findRange(bins: HistogramBins): [number, number] {
    // get the bin with the most frequently occurring NONZERO value
    let maxBin = 1;
    let max = bins[1];
    for (let i = 1; i < bins.length; i++) {
      if (bins[i] > max) {
        maxBin = i;
        max = bins[i];
      }
    }

    // simple linear mapping cutting elements with small appearence
    // get 10% threshold
    const PERCENTAGE = 0.1;
    const th = Math.floor(bins[maxBin] * PERCENTAGE);
    let b = 0;
    let e = bins.length - 1;
    for (let x = 1; x < bins.length; ++x) {
      if (bins[x] > th) {
        b = x;
        break;
      }
    }
    for (let x = bins.length - 1; x >= 1; --x) {
      if (bins[x] > th) {
        e = x;
        break;
      }
    }
    return [b, e];
  }
}
