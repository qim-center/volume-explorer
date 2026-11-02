import { ARRAY_CONSTRUCTORS, type NumberType, type TypedArray } from "../types.js";

type XYZ = [number, number, number];

export function extractSubvolume<T extends TypedArray<NumberType>>(data: T, dims: XYZ, offset: XYZ, size: XYZ): T {
  const [dx, dy] = dims;
  const [ox, oy, oz] = offset;
  const [sx, sy, sz] = size;

  for (let i = 0; i < 3; ++i) {
    if (offset[i] < 0 || size[i] < 0 || offset[i] + size[i] > dims[i]) {
      throw new RangeError(`Subvolume [${offset}] + [${size}] is out of bounds of volume [${dims}]`);
    }
  }
  if (sx === dims[0] && sy === dims[1] && sz === dims[2]) {
    return data;
  }

  const ctor = data.constructor as new (length: number) => T;
  const result = new ctor(sx * sy * sz);
  for (let z = 0; z < sz; ++z) {
    for (let y = 0; y < sy; ++y) {
      const src = ox + (oy + y) * dx + (oz + z) * dx * dy;
      result.set(data.subarray(src, src + sx) as ArrayLike<number>, (z * sy + y) * sx);
    }
  }
  return result;
}

export interface ImageJTiffOptions {
  /** Size of the volume in pixels, XYZ order */
  size: XYZ;
  /** Pixel data of each channel, `size[0] * size[1] * size[2]` elements each, x fastest */
  channels: TypedArray<NumberType>[];
  dtype: NumberType;
  /** Physical size of one voxel, XYZ order */
  physicalPixelSize?: XYZ;
  /** Spatial unit of `physicalPixelSize`, e.g. "μm" */
  spatialUnit?: string;
}

// TIFF SampleFormat: 1 = unsigned int, 2 = signed int, 3 = IEEE float
const SAMPLE_FORMAT: Record<NumberType, number> = {
  uint8: 1,
  uint16: 1,
  uint32: 1,
  int8: 2,
  int16: 2,
  int32: 2,
  float32: 3,
  float64: 3,
};

const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

const NUM_TAGS = 15;
const IFD_BYTES = 2 + NUM_TAGS * 12 + 4;
const MAX_UINT32 = 0xffffffff;

function toImageJUnit(unit: string): string {
  if (unit === "μm" || unit === "µm") {
    return "micron";
  }
  // ImageDescription is an ASCII tag
  return unit.replace(/[^\x20-\x7e]/g, "");
}

/** Approximates a positive number as a TIFF RATIONAL (two uint32s) */
function toRational(value: number): [number, number] {
  if (!(value > 0 && Number.isFinite(value))) {
    return [1, 1];
  }
  const denominator = Math.max(1, Math.min(1e6, Math.floor(MAX_UINT32 / value)));
  return [Math.max(1, Math.round(value * denominator)), denominator];
}

function buildImageJDescription({ channels, size, spatialUnit, physicalPixelSize }: ImageJTiffOptions): string {
  const lines = ["ImageJ=1.11a", `images=${channels.length * size[2]}`];
  if (channels.length > 1) {
    lines.push(`channels=${channels.length}`, "hyperstack=true", "mode=composite");
  }
  lines.push(`slices=${size[2]}`);
  if (spatialUnit) {
    lines.push(`unit=${toImageJUnit(spatialUnit)}`);
  }
  if (physicalPixelSize) {
    lines.push(`spacing=${physicalPixelSize[2]}`);
  }
  lines.push("loop=false");
  return lines.join("\n") + "\n";
}

/**
 * Encodes a (multi-channel) 3D volume as an uncompressed, ImageJ-style multi-page TIFF:
 * File layout: header | ImageDescription | X/Y resolution | all page IFDs | all pixel data
 */
export function writeImageJTiff(options: ImageJTiffOptions): Blob {
  const { size, channels, dtype, physicalPixelSize = [1, 1, 1] } = options;
  const [width, height, depth] = size;
  const planeLength = width * height;
  const bytesPerSample = ARRAY_CONSTRUCTORS[dtype].BYTES_PER_ELEMENT;
  const planeBytes = planeLength * bytesPerSample;
  const numPages = channels.length * depth;

  if (numPages === 0 || planeLength === 0) {
    throw new RangeError("Cannot write an empty TIFF");
  }

  const description = buildImageJDescription(options) + "\0";
  const descriptionOffset = 8;
  const resolutionOffset = descriptionOffset + description.length + (description.length % 2);
  const firstIfdOffset = resolutionOffset + 16;
  const dataOffset = firstIfdOffset + numPages * IFD_BYTES;

  if (dataOffset + numPages * planeBytes > MAX_UINT32) {
    throw new RangeError("Volume is too large for a TIFF file (maximum is 4 GB)");
  }

  const header = new DataView(new ArrayBuffer(dataOffset));
  header.setUint16(0, 0x4949); // "II": little-endian
  header.setUint16(2, 42, true);
  header.setUint32(4, firstIfdOffset, true);
  for (let i = 0; i < description.length; ++i) {
    header.setUint8(descriptionOffset + i, description.charCodeAt(i));
  }
  const resolution = [...toRational(1 / physicalPixelSize[0]), ...toRational(1 / physicalPixelSize[1])];
  resolution.forEach((value, i) => header.setUint32(resolutionOffset + i * 4, value, true));

  for (let page = 0; page < numPages; ++page) {
    const ifdOffset = firstIfdOffset + page * IFD_BYTES;
    // [tag, type, count, value or offset], sorted by tag
    const tags = [
      [254, LONG, 1, 0], // NewSubfileType
      [256, LONG, 1, width], // ImageWidth
      [257, LONG, 1, height], // ImageLength
      [258, SHORT, 1, bytesPerSample * 8], // BitsPerSample
      [259, SHORT, 1, 1], // Compression: none
      [262, SHORT, 1, 1], // PhotometricInterpretation: BlackIsZero
      [270, ASCII, description.length, descriptionOffset], // ImageDescription
      [273, LONG, 1, dataOffset + page * planeBytes], // StripOffsets
      [277, SHORT, 1, 1], // SamplesPerPixel
      [278, LONG, 1, height], // RowsPerStrip
      [279, LONG, 1, planeBytes], // StripByteCounts
      [282, RATIONAL, 1, resolutionOffset], // XResolution
      [283, RATIONAL, 1, resolutionOffset + 8], // YResolution
      [296, SHORT, 1, 1], // ResolutionUnit: none (the unit is in ImageDescription)
      [339, SHORT, 1, SAMPLE_FORMAT[dtype]], // SampleFormat
    ];

    header.setUint16(ifdOffset, NUM_TAGS, true);
    tags.forEach(([tag, type, count, value], i) => {
      const entry = ifdOffset + 2 + i * 12;
      header.setUint16(entry, tag, true);
      header.setUint16(entry + 2, type, true);
      header.setUint32(entry + 4, count, true);
      // SHORT values are left-justified in the 4-byte value field
      if (type === SHORT) {
        header.setUint16(entry + 8, value, true);
      } else {
        header.setUint32(entry + 8, value, true);
      }
    });
    const nextIfdOffset = page < numPages - 1 ? ifdOffset + IFD_BYTES : 0;
    header.setUint32(ifdOffset + 2 + NUM_TAGS * 12, nextIfdOffset, true);
  }

  const parts: BlobPart[] = [header.buffer];
  for (let z = 0; z < depth; ++z) {
    for (const data of channels) {
      parts.push(data.subarray(z * planeLength, (z + 1) * planeLength) as BlobPart);
    }
  }
  return new Blob(parts, { type: "image/tiff" });
}
