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

const colorstops = {
  viridis: ["#440154", "#3a528b", "#20908c", "#5ec961", "#fde724"],
  plasma: ["#0d0887", "#46039f", "#7201a8", "#ab5dc2", "#d878b9", "#fca726", "#f0f921"],
  
  inferno: ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"],
  magma:   ["#000004", "#140e36", "#3b0f70", "#641a80", "#8c2981", "#b5367a", "#de4968", "#f66e5b", "#fe9f6d", "#fecf92", "#fcfdbf"],
  cividis: ["#00204c", "#2e3f6e", "#576c75", "#809b78", "#aecd6f", "#d8e35b", "#fdea45"],
};

export const colormaps = {
  viridis: { stops: colorstops.viridis, tex: loadColormap(colorstops.viridis) },
  plasma:  { stops: colorstops.plasma,  tex: loadColormap(colorstops.plasma) },

  inferno: { stops: colorstops.inferno, tex: loadColormap(colorstops.inferno) },
  magma:   { stops: colorstops.magma,   tex: loadColormap(colorstops.magma) },
  cividis: { stops: colorstops.cividis, tex: loadColormap(colorstops.cividis) },
};

export const features = {
  feature1: loadFeature(),
  feature2: loadFeature(),
};
