import { Color, DataTexture, FloatType, RGBAFormat, RedFormat, RedIntegerFormat, LinearFilter, UnsignedByteType } from "three";

function getSquarestTextureDimensions(size: number): [number, number] {
  const width = Math.ceil(Math.sqrt(size));
  const height = Math.ceil(size / width);

  return [width, height];
}

function loadColormap(colorStops: string[]): DataTexture {
  const colorColorStops = colorStops.map((color) => new Color(color));
  const dataArr = colorColorStops.flatMap((col) => [col.r, col.g, col.b, 1]);
  const colormapTex = new DataTexture(new Float32Array(dataArr), colorColorStops.length, 1, RGBAFormat, FloatType);
  // if (this.type === ColorRampType.HARD_STOP) {
  //   this.texture.minFilter = NearestFilter;
  //   this.texture.magFilter = NearestFilter;
  // } else {
  colormapTex.minFilter = LinearFilter;
  colormapTex.magFilter = LinearFilter;
  // }
  colormapTex.internalFormat = "RGBA32F";
  colormapTex.needsUpdate = true;

  return colormapTex;
}

function loadFeature(): { featureTex: DataTexture; featureMin: number; featureMax: number, outlierData: DataTexture, inRangeIds: DataTexture } {
  const idsToFeatureValue = new Float32Array(256 * 256);
  // fill with random between 0 and 1
  for (let i = 0; i < idsToFeatureValue.length; i++) {
    idsToFeatureValue[i] = Math.random();
  }
  const featTex = new DataTexture(
    idsToFeatureValue,
    ...getSquarestTextureDimensions(idsToFeatureValue.length),
    RedFormat,
    FloatType
  );
  featTex.internalFormat = "R32F";
  featTex.needsUpdate = true;

  // create outlier data texture (same size as feature texture)
  const outlierData = new Uint8Array(256 * 256);
  for (let i = 0; i < outlierData.length; i++) {
    outlierData[i] = Math.random() < 0.01 ? 1 : 0; // 1% chance of being an outlier
  }
  const outlierTex = new DataTexture(
    outlierData,
    ...getSquarestTextureDimensions(outlierData.length),
    RedIntegerFormat,
    UnsignedByteType,
  );
  outlierTex.internalFormat = "R8UI";
  outlierTex.needsUpdate = true;

  // create inRangeIds texture (same size as feature texture)
  const inRangeIds = new Uint8Array(256 * 256);
  for (let i = 0; i < inRangeIds.length; i++) {
    inRangeIds[i] = Math.random() < 0.8 ? 1 : 0; // 80% chance of being in range
  }
  const inRangeTex = new DataTexture(
    inRangeIds,
    ...getSquarestTextureDimensions(inRangeIds.length),
    RedIntegerFormat,
    UnsignedByteType,
  );
  inRangeTex.internalFormat = "R8UI";
  inRangeTex.needsUpdate = true;

  return {
    featureTex: featTex,
    outlierData: outlierTex,
    inRangeIds: inRangeTex,
    featureMin: 0.0,
    featureMax: 1.0,
  };
}

// colormaps from matplotlib
const colorstops = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838'],
  grayscale: ['#000000', '#ffffff']
};

export const colormaps = {
  ...Object.fromEntries(
    Object.entries(colorstops).map(([name, stops]) => [name, { stops, tex: loadColormap(stops) }])
  ),
};

export const features = {
  feature1: loadFeature(),
  feature2: loadFeature(),
};
