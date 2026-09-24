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
   * Path inside the HDF5 file to the dataset to load, required when the file contains more than one dataset.
   */
  datasetName?: string;

  /**
   * Memory ceiling, in bytes, for datasets that can't use the contiguous fast path (chunked and/or compressed datasets)
   * Defaults to 2 GiB.
   */
  maxFallbackBytes?: number;
};

const DEFAULT_MAX_FALLBACK_BYTES = 2 * 1024 ** 3;

/** A jsfive dtype string (e.g. "<u2", ">f4", "|u1") parsed into its kind, width in bits, and byte order. */
type SourceDtype = { kind: "i" | "u" | "f"; bits: number; littleEndian: boolean };

const INT32_RANGES: Partial<Record<NumberType, [number, number]>> = {
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
};

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Parse a jsfive dtype string into the kind/width/byte-order triple the rest of the loader works with.
 */
function parseJsfiveDtype(dtype: unknown, datasetKey: string): SourceDtype {
  const match = typeof dtype === "string" ? dtype.match(/^([<>=!|])?(i|u|f)(\d+)$/) : null;
  if (!match) {
    throw new VolumeLoadError(`Dataset "${datasetKey}" has an unsupported HDF5 datatype "${String(dtype)}"`, {
      type: VolumeLoadErrorType.INVALID_METADATA,
    });
  }

  const [, byteOrder, kind, sizeStr] = match;
  const bigEndian = byteOrder === ">" || byteOrder === "!";
  const littleEndian = byteOrder === "<" ? true : bigEndian ? false : HOST_IS_LITTLE_ENDIAN;
  return { kind: kind as SourceDtype["kind"], bits: Number(sizeStr) * 8, littleEndian };
}

function narrowsFrom64BitInteger({ kind, bits }: SourceDtype): boolean {
  return kind !== "f" && bits === 64;
}

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
 * Narrow values read from a 64-bit integer dataset into dtype, the 32-bit type renderableNumberType picked for it.
 */
function narrowInto32BitInteger(
  data: ArrayLike<number>,
  source: SourceDtype,
  dtype: NumberType,
  datasetKey: string
): TypedArray<NumberType> {
  const targetRange = INT32_RANGES[dtype];
  const [min, max] = getDataRange(data);
  if (targetRange && (min < targetRange[0] || max > targetRange[1])) {
    throw new VolumeLoadError(
      `Dataset "${datasetKey}" is ${source.kind === "i" ? "int64" : "uint64"}, which must be narrowed to ` +
        `${dtype} to be rendered, but its values span [${min}, ${max}] and do not fit that range.`,
      { type: VolumeLoadErrorType.INVALID_METADATA }
    );
  }

  const ctor = ARRAY_CONSTRUCTORS[dtype];
  return new ctor(data) as TypedArray<NumberType>;
}

function toTypedArray(
  data: number[],
  source: SourceDtype,
  dtype: NumberType,
  datasetKey: string
): TypedArray<NumberType> {
  if (narrowsFrom64BitInteger(source)) {
    return narrowInto32BitInteger(data, source, dtype, datasetKey);
  }

  const ctor = ARRAY_CONSTRUCTORS[dtype];
  return new ctor(data) as TypedArray<NumberType>;
}

/** HDF5 "Data Layout" message type, and the layout class value that means contiguous storage. */
const DATA_STORAGE_MSG_TYPE = 0x0008;
const LAYOUT_CLASS_CONTIGUOUS = 1;

/**
 * Per-element readers for contiguous files (one span of bytes in C order, so any sub-region can be read directly
 */
const BYTE_READERS: Record<string, ((view: DataView, offset: number, littleEndian: boolean) => number) | undefined> = {
  i8: (v, o) => v.getInt8(o),
  u8: (v, o) => v.getUint8(o),
  i16: (v, o, le) => v.getInt16(o, le),
  u16: (v, o, le) => v.getUint16(o, le),
  i32: (v, o, le) => v.getInt32(o, le),
  u32: (v, o, le) => v.getUint32(o, le),
  i64: (v, o, le) => Number(v.getBigInt64(o, le)),
  u64: (v, o, le) => Number(v.getBigUint64(o, le)),
  f32: (v, o, le) => v.getFloat32(o, le),
  f64: (v, o, le) => v.getFloat64(o, le),
};

function getContiguousDataOffset(ds: H5Dataset, source: SourceDtype, expectedBytes: number): number | undefined {
  if (!BYTE_READERS[`${source.kind}${source.bits}`]) {
    return undefined;
  }

  try {
    const dataObjects = ds._dataobjects;
    const msgOffset = dataObjects.find_msg_type(DATA_STORAGE_MSG_TYPE)[0]?.get("offset_to_message");
    if (msgOffset === undefined) {
      return undefined;
    }

    const [, , layoutClass, propertyOffset] = dataObjects._get_data_message_properties(msgOffset);
    if (layoutClass !== LAYOUT_CLASS_CONTIGUOUS || dataObjects.filter_pipeline) {
      return undefined;
    }

    const view = new DataView(dataObjects.fh);
    const low = view.getUint32(propertyOffset, true);
    const high = view.getUint32(propertyOffset + 4, true);
    if (low === 0xffffffff && high === 0xffffffff) {
      return undefined;
    }

    const address = high * 0x100000000 + low;
    return address + expectedBytes > dataObjects.fh.byteLength ? undefined : address;
  } catch (_e) {
    // These internals are not part of jsfive's public API, so if errors are cought, revert back
    return undefined;
  }
}

/**
 * Read one channel of a contiguously stored dataset directly out of the file buffer, decimating X and Y to the
 * atlas tile size as each Z slice is read.
 *
 * This mirrors what FetchTiffWorker does for TIFF: the destination is allocated at its final size and a
 * full-resolution copy of the volume never exists. Only the voxels the atlas will show are read, so for volumes
 * far larger than the atlas this also skips most of the file.
 */
function readContiguousChannel(
  buffer: ArrayBuffer,
  dataOffset: number,
  source: SourceDtype,
  dtype: NumberType,
  datasetKey: string,
  [z, y, x]: [number, number, number],
  ty: number,
  tx: number,
  channel: number
): TypedArray<NumberType> {
  const read = BYTE_READERS[`${source.kind}${source.bits}`]!;
  const view = new DataView(buffer);
  const bytes = source.bits / 8;
  const littleEndian = source.littleEndian;

  // Precompute which source row and column each destination row and column samples
  const rowOffsets = new Float64Array(ty);
  for (let yi = 0; yi < ty; yi++) {
    rowOffsets[yi] = Math.min(y - 1, Math.floor((yi * y) / ty)) * x * bytes;
  }
  const colOffsets = new Float64Array(tx);
  for (let xi = 0; xi < tx; xi++) {
    colOffsets[xi] = Math.min(x - 1, Math.floor((xi * x) / tx)) * bytes;
  }

  // 64-bit integers are collected as plain numbers first so narrowInto32BitInteger sees their true values
  const narrows64 = narrowsFrom64BitInteger(source);
  const ctor = narrows64 ? ARRAY_CONSTRUCTORS.float64 : ARRAY_CONSTRUCTORS[dtype];
  const out = new ctor(z * ty * tx) as TypedArray<NumberType>;

  const sliceBytes = y * x * bytes;
  const channelBase = dataOffset + channel * z * sliceBytes;
  let i = 0;
  for (let zi = 0; zi < z; zi++) {
    const sliceBase = channelBase + zi * sliceBytes;
    for (let yi = 0; yi < ty; yi++) {
      const rowBase = sliceBase + rowOffsets[yi];
      for (let xi = 0; xi < tx; xi++) {
        out[i++] = read(view, rowBase + colOffsets[xi], littleEndian);
      }
    }
  }

  return narrows64 ? narrowInto32BitInteger(out, source, dtype, datasetKey) : out;
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

  private readonly contiguousDataOffset?: number;

  // load everything in a single call
  private syncChannels = false;
  private cachedData?: TypedArray<NumberType>;

  private constructor(
    private readonly file: H5File,
    private readonly buffer: ArrayBuffer,
    private readonly datasetKey: string,
    maxFallbackBytes: number
  ) {
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
    const elementCount = shape.reduce((a, b) => a * b, 1);
    const expectedBytes = elementCount * (this.sourceDtype.bits / 8);
    this.contiguousDataOffset = getContiguousDataOffset(ds, this.sourceDtype, expectedBytes);

    if (this.contiguousDataOffset === undefined) {
      const fallbackBytes = elementCount * 8;
      if (fallbackBytes > maxFallbackBytes) {
        throw new VolumeLoadError(
          `Volume is ~` + `${(fallbackBytes / 1024 ** 3).toFixed(1)} GiB and is prevented from loading to avoid OOM.
           Increase the H5Loader's 'maxFallbackBytes or use contiguous H5.`,
          { type: VolumeLoadErrorType.TOO_LARGE }
        );
      }
    }

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

    return new H5Loader(file, buffer, chosenKey, options.maxFallbackBytes ?? DEFAULT_MAX_FALLBACK_BYTES);
  }

  private get channelCount(): number {
    return this.channelAxisIndex === -1 ? 1 : this.datasetShape[0];
  }

  private get spatialShape(): [number, number, number] {
    return this.channelAxisIndex === -1
      ? [this.datasetShape[0], this.datasetShape[1], this.datasetShape[2]]
      : [this.datasetShape[1], this.datasetShape[2], this.datasetShape[3]];
  }

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

  /**
   * Reads one channel, already decimated to the atlas tile size.
   *
   * Contiguous, unfiltered datasets are read straight out of the file buffer one slice at a time, so only the
   * decimated result is ever allocated. Everything else goes through jsfive's Dataset.value, which materializes
   * the whole dataset before it can be downsampled.
   */
  private readChannel(channel: number, ty: number, tx: number): TypedArray<NumberType> {
    const [z, y, x] = this.spatialShape;

    if (this.contiguousDataOffset !== undefined) {
      // A 3-D dataset has no channel axis, so there is no per-channel offset to skip.
      const channelIndex = this.channelAxisIndex === -1 ? 0 : channel;
      return readContiguousChannel(
        this.buffer,
        this.contiguousDataOffset,
        this.sourceDtype,
        this.dtype,
        this.datasetKey,
        [z, y, x],
        ty,
        tx,
        channelIndex
      );
    }

    const data = this.getFullData();
    const spatialSize = z * y * x;
    const fullChannelData =
      this.channelAxisIndex === -1
        ? data
        : (data.subarray(channel * spatialSize, (channel + 1) * spatialSize) as typeof data);
    return downsampleXY(fullChannelData, this.dtype, z, y, x, ty, tx);
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

    const { tileX, tileY } = this.getAtlasLayout();

    const channelIndices = loadSpec.channels ?? Array.from({ length: this.channelCount }, (_, i) => i);

    const syncIndices: number[] = [];
    const syncDtypes: NumberType[] = [];
    const syncData: TypedArray<NumberType>[] = [];
    const syncRanges: [number, number][] = [];

    for (const ch of channelIndices) {
      const channelData = this.readChannel(ch, tileY, tileX);
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
