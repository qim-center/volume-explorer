import { File as H5File, Dataset as H5Dataset, Group as H5Group } from "jsfive";
import { Box3, Vector3 } from "three";

import type { ImageInfo } from "../ImageInfo.js";
import type { VolumeDims } from "../VolumeDims.js";
import { ARRAY_CONSTRUCTORS, type NumberType, type TypedArray } from "../types.js";
import { getDataRange } from "../utils/num_utils.js";
import { remapUri } from "../utils/url_utils.js";
import {
  ThreadableVolumeLoader,
  LoadSpec,
  type RawChannelDataCallback,
  type LoadedVolumeInfo,
} from "./IVolumeLoader.js";
import { computePackedAtlasDims, MAX_ATLAS_EDGE } from "./VolumeLoaderUtils.js";
import { VolumeLoadError, VolumeLoadErrorType, wrapVolumeLoadError } from "./VolumeLoadError.js";

/**
 * Options for configuring the H5Loader.
 *
 * The loader expects HDF5 files to contain one or more 3-D (ZYX) or 4-D (CZYX) datasets. Metadata is read from the
 * following optional HDF5 attributes on the chosen dataset:
 *
 *   - `spacing`        → number[3]  physical voxel size [sz, sy, sx]
 *   - `unit`           → string     spatial unit symbol, e.g. "µm"
 *   - `channel_names`  → string[]   one name per channel
 *   - `channel_colors` → number[][] one [r, g, b] triple per channel
 */
export type H5LoaderOptions = {
  /**
   * Path inside the HDF5 file to the dataset to load, e.g. `"volume"` or `"entry/data"`. Required when the file
   * contains more than one dataset with ndim 3 or 4. When omitted and only one such dataset exists, the loader
   * selects it automatically.
   */
  datasetName?: string;
};

/** A jsfive dtype string (e.g. "<u2", ">f4", "|u1") parsed into its kind and width in bits. */
type SourceDtype = { kind: "i" | "u" | "f"; bits: number };

const INT32_RANGES: Partial<Record<NumberType, [number, number]>> = {
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
};

/** Parse a jsfive dtype string into the kind/width pair the rest of the loader works with. */
function parseJsfiveDtype(dtype: unknown, datasetKey: string): SourceDtype {
  const match = typeof dtype === "string" ? dtype.match(/^[<>=|]?(i|u|f)(\d+)$/) : null;
  if (!match) {
    throw new VolumeLoadError(`Dataset "${datasetKey}" has an unsupported HDF5 datatype "${String(dtype)}"`, {
      type: VolumeLoadErrorType.INVALID_METADATA,
    });
  }

  const [, kind, sizeStr] = match;
  return { kind: kind as SourceDtype["kind"], bits: Number(sizeStr) * 8 };
}

/**
 * Map a source dtype to the NumberType passed to the renderer
 *
 * WebGL2 has no 64-bit texture formats, so 64-bit datasets must be narrowed to 32 bits: 
 * float64 becomes float32 (the same as OmeZarrLoader functions), and 
 * int64/uint64 become int32/uint32
 */
function renderableNumberType({ kind, bits }: SourceDtype): NumberType {
  switch (kind) {
    case "i":
      return bits <= 8 ? "int8" : bits <= 16 ? "int16" : "int32";
    case "u":
      return bits <= 8 ? "uint8" : bits <= 16 ? "uint16" : "uint32";
    default:
      return "float32";
  }
}

/**
 * Convert a flat number[] (as returned by jsfive's Dataset.value) into a typed array (dtype) that can be rendered
 */
function toTypedArray(
  data: number[],
  source: SourceDtype,
  dtype: NumberType,
  datasetKey: string
): TypedArray<NumberType> {
  const targetRange = source.kind !== "f" && source.bits === 64 ? INT32_RANGES[dtype] : undefined;
  if (targetRange) {
    const [min, max] = getDataRange(data);
    if (min < targetRange[0] || max > targetRange[1]) {
      throw new VolumeLoadError(
        `Dataset "${datasetKey}" is ${source.kind === "i" ? "int64" : "uint64"}, which must be narrowed to ` +
          `${dtype} to be rendered, but its values span [${min}, ${max}] and do not fit that range.`,
        { type: VolumeLoadErrorType.INVALID_METADATA }
      );
    }
  }

  const ctor = ARRAY_CONSTRUCTORS[dtype];
  return new ctor(data) as TypedArray<NumberType>;
}

/**
 * Resample a `[Z, Y, X]` volume to `[z, ty, tx]` using nearest-neighbor sampling in X and Y. Returns `data`
 * unchanged if it's already at the target size.
 */
function downsampleXY<T extends NumberType>(
  data: TypedArray<T>,
  dtype: T,
  z: number,
  y: number,
  x: number,
  ty: number,
  tx: number
): TypedArray<T> {
  if (ty === y && tx === x) {
    return data;
  }

  const ctor = ARRAY_CONSTRUCTORS[dtype];
  const out = new ctor(z * ty * tx) as TypedArray<T>;
  for (let zi = 0; zi < z; zi++) {
    for (let yi = 0; yi < ty; yi++) {
      const srcY = Math.min(y - 1, Math.floor((yi * y) / ty));
      for (let xi = 0; xi < tx; xi++) {
        const srcX = Math.min(x - 1, Math.floor((xi * x) / tx));
        out[zi * ty * tx + yi * tx + xi] = data[zi * y * x + srcY * x + srcX];
      }
    }
  }
  return out;
}

/** Walk the HDF5 file tree and return every dataset path whose rank is between `minNdim` and `maxNdim`. */
function collectDatasetKeys(group: H5Group, minNdim: number, maxNdim: number, prefix = ""): string[] {
  const keys: string[] = [];
  for (const key of group.keys) {
    const fullKey = prefix ? `${prefix}/${key}` : key;
    const item = group.get(key);
    if (item instanceof H5Dataset) {
      const ndim = item.shape?.length ?? 0;
      if (ndim >= minNdim && ndim <= maxNdim) {
        keys.push(fullKey);
      }
    } else if (item instanceof H5Group) {
      keys.push(...collectDatasetKeys(item, minNdim, maxNdim, fullKey));
    }
  }
  return keys;
}

class H5Loader extends ThreadableVolumeLoader {
  /** Shape of the chosen dataset: `[C, Z, Y, X]` or `[Z, Y, X]`. */
  private readonly datasetShape: number[];
  /** `0` when the dataset has a leading channel axis (4-D), `-1` when absent (3-D). */
  private readonly channelAxisIndex: 0 | -1;
  private readonly sourceDtype: SourceDtype;
  private readonly dtype: NumberType;
  /** Physical voxel spacing `[sz, sy, sx]`. */
  private readonly spacing: [number, number, number];
  /** Spatial unit symbol, e.g. "µm". */
  private readonly spaceUnit: string;
  /** Display name for each channel. */
  private readonly channelNames: string[];
  /** Optional RGB colour hints for each channel. */
  private readonly channelColors: ([number, number, number] | undefined)[];

  /** Whether all channels should be delivered to `onData` in a single call. */
  private syncChannels = false;
  /** Cache of the dataset's full contents, converted to a typed array. */
  private cachedData?: TypedArray<NumberType>;

  private constructor(private readonly file: H5File, private readonly datasetKey: string) {
    super();

    const ds = this.file.get(this.datasetKey) as H5Dataset;
    const shape = ds.shape;
    if (!shape || shape.length < 3 || shape.length > 4) {
      throw new VolumeLoadError(
        `Dataset "${this.datasetKey}" has ${shape?.length ?? 0} dimensions; expected 3 (ZYX) or 4 (CZYX).`,
        { type: VolumeLoadErrorType.INVALID_METADATA }
      );
    }
    this.datasetShape = shape;
    this.channelAxisIndex = shape.length === 4 ? 0 : -1;
    this.sourceDtype = parseJsfiveDtype(ds.dtype, this.datasetKey);
    this.dtype = renderableNumberType(this.sourceDtype);

    const attrs = ds.attrs;
    const spacingAttr = attrs["spacing"];
    this.spacing =
      Array.isArray(spacingAttr) && spacingAttr.length >= 3
        ? [spacingAttr[0], spacingAttr[1], spacingAttr[2]]
        : [1, 1, 1];

    const unitAttr = attrs["unit"];
    this.spaceUnit = typeof unitAttr === "string" ? unitAttr : "";

    const n = this.channelCount;
    const namesAttr = attrs["channel_names"];
    this.channelNames =
      Array.isArray(namesAttr) && namesAttr.length === n
        ? namesAttr
        : Array.from({ length: n }, (_, i) => `Channel ${i}`);

    const colorsAttr = attrs["channel_colors"];
    this.channelColors =
      Array.isArray(colorsAttr) && colorsAttr.length === n
        ? colorsAttr.map((c: number[]): [number, number, number] => [c[0], c[1], c[2]])
        : Array.from({ length: n }, () => undefined);
  }

  /** Creates a new `H5Loader` by fetching and parsing the HDF5 file at `url`. */
  static async createLoader(url: string, options: H5LoaderOptions = {}): Promise<H5Loader> {
    const remappedUrl = remapUri(url);

    const response = await fetch(remappedUrl).catch<Response>(
      wrapVolumeLoadError(`Could not open HDF5 file at ${remappedUrl}`, VolumeLoadErrorType.NOT_FOUND)
    );
    if (!response.ok) {
      throw new VolumeLoadError(
        `Could not open HDF5 file at ${remappedUrl}: ${response.status} ${response.statusText}`,
        { type: VolumeLoadErrorType.NOT_FOUND }
      );
    }

    const buffer = await response
      .arrayBuffer()
      .catch<ArrayBuffer>(
        wrapVolumeLoadError(`Failed to read HDF5 file at ${remappedUrl}`, VolumeLoadErrorType.LOAD_DATA_FAILED)
      );

    const file = new H5File(buffer, remappedUrl);
    const datasetKeys = collectDatasetKeys(file, 3, 4);

    if (datasetKeys.length === 0) {
      throw new VolumeLoadError(`No 3-D or 4-D datasets found in "${remappedUrl}"`, {
        type: VolumeLoadErrorType.INVALID_METADATA,
      });
    }

    let chosenKey: string;
    if (datasetKeys.length === 1) {
      chosenKey = datasetKeys[0];
    } else if (options.datasetName && datasetKeys.includes(options.datasetName)) {
      chosenKey = options.datasetName;
    } else {
      throw new VolumeLoadError(
        `Multiple datasets found in "${remappedUrl}": ${datasetKeys.join(", ")}. ` +
          `Specify one with the 'datasetName' option.`,
        { type: VolumeLoadErrorType.INVALID_METADATA }
      );
    }

    return new H5Loader(file, chosenKey);
  }

  private get channelCount(): number {
    return this.channelAxisIndex === -1 ? 1 : this.datasetShape[0];
  }

  /** Spatial extents `[Z, Y, X]`, regardless of whether a channel axis is present. */
  private get spatialShape(): [number, number, number] {
    return this.channelAxisIndex === -1
      ? [this.datasetShape[0], this.datasetShape[1], this.datasetShape[2]]
      : [this.datasetShape[1], this.datasetShape[2], this.datasetShape[3]];
  }

  /**
   * Computes the texture atlas layout for this volume's Z slices, downsampling the X/Y tile size as needed so
   * that the resulting atlas doesn't exceed `MAX_ATLAS_EDGE` in either dimension.
   */
  private getAtlasLayout(): { atlasCols: number; atlasRows: number; tileX: number; tileY: number } {
    const [z, y, x] = this.spatialShape;
    const atlasDims = computePackedAtlasDims(z, x, y);
    const tileX = Math.min(x, Math.floor(MAX_ATLAS_EDGE / atlasDims.x));
    const tileY = Math.min(y, Math.floor(MAX_ATLAS_EDGE / atlasDims.y));
    return { atlasCols: atlasDims.x, atlasRows: atlasDims.y, tileX, tileY };
  }

  /** Reads (and caches) the full dataset, converted to a typed array in `[C, Z, Y, X]`/`[Z, Y, X]` order. */
  private getFullData(): TypedArray<NumberType> {
    if (!this.cachedData) {
      const ds = this.file.get(this.datasetKey) as H5Dataset;
      this.cachedData = toTypedArray(ds.value, this.sourceDtype, this.dtype, this.datasetKey);
    }
    return this.cachedData;
  }

  async loadDims(_loadSpec: LoadSpec): Promise<VolumeDims[]> {
    const [z, y, x] = this.spatialShape;
    const [sz, sy, sx] = this.spacing;

    const dims: VolumeDims = {
      spaceUnit: this.spaceUnit,
      timeUnit: "",
      shape: [1, this.channelCount, z, y, x],
      spacing: [1, 1, sz, sy, sx],
      dataType: this.dtype,
    };

    return [dims];
  }

  async createImageInfo(loadSpec: LoadSpec): Promise<LoadedVolumeInfo> {
    const [z, y, x] = this.spatialShape;
    const [sz, sy, sx] = this.spacing;
    const { atlasCols, atlasRows, tileX, tileY } = this.getAtlasLayout();

    const volDims: VolumeDims = {
      spaceUnit: this.spaceUnit,
      timeUnit: "",
      shape: [1, this.channelCount, z, tileY, tileX],
      spacing: [1, 1, sz, (sy * y) / tileY, (sx * x) / tileX],
      dataType: this.dtype,
    };

    const imageInfo: ImageInfo = {
      name: this.datasetKey,

      atlasTileDims: [atlasCols, atlasRows],
      subregionSize: [tileX, tileY, z],
      subregionOffset: [0, 0, 0],

      numChannelsPerSource: [this.channelCount],
      channelNames: this.channelNames,
      channelColors: this.channelColors,

      multiscaleLevel: 0,
      multiscaleLevelDims: [volDims],

      transform: {
        translation: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    };

    // H5Loader always loads the full volume, so the loaded subregion is the entire unit cube.
    const adjustedLoadSpec: LoadSpec = {
      ...loadSpec,
      subregion: new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1)),
      multiscaleLevel: 0,
    };

    return { imageInfo, loadSpec: adjustedLoadSpec };
  }

  async loadRawChannelData(
    imageInfo: ImageInfo,
    loadSpec: LoadSpec,
    onUpdateMetadata: (imageInfo: ImageInfo) => void,
    onData: RawChannelDataCallback
  ): Promise<void> {
    onUpdateMetadata(imageInfo);

    const data = this.getFullData();
    const [z, y, x] = this.spatialShape;
    const spatialSize = z * y * x;
    const { tileX, tileY } = this.getAtlasLayout();

    const channelIndices = loadSpec.channels ?? Array.from({ length: this.channelCount }, (_, i) => i);

    const syncIndices: number[] = [];
    const syncDtypes: NumberType[] = [];
    const syncData: TypedArray<NumberType>[] = [];
    const syncRanges: [number, number][] = [];

    for (const ch of channelIndices) {
      const fullChannelData =
        this.channelAxisIndex === -1
          ? data
          : (data.subarray(ch * spatialSize, (ch + 1) * spatialSize) as typeof data);
      const channelData = downsampleXY(fullChannelData, this.dtype, z, y, x, tileY, tileX);
      const range = getDataRange(channelData);

      if (this.syncChannels) {
        syncIndices.push(ch);
        syncDtypes.push(this.dtype);
        syncData.push(channelData);
        syncRanges.push(range);
      } else {
        onData([ch], [this.dtype], [channelData], [range]);
      }
    }

    if (this.syncChannels && syncIndices.length > 0) {
      onData(syncIndices, syncDtypes, syncData, syncRanges);
    }
  }

  syncMultichannelLoading(sync: boolean): void {
    this.syncChannels = sync;
  }
}

export { H5Loader };
