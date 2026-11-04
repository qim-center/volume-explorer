import { Volume } from "../../../src";
import { extractSubvolume, writeImageJTiff } from "../../../src/utils/volume_export";
import { CROP_AXES, CropAxis } from "../state/stateService";

export type CropIndexBounds = Record<CropAxis, { left: number; right: number }>;

const LOADING_MESSAGE = "The cropped region is still loading. Try exporting again once loading has finished.";

function getExportFileName(volume: Volume, crop: CropIndexBounds): string {
  const baseName = (volume.name || "volume").replace(/[^\w.-]+/g, "_");
  const ranges = CROP_AXES.map((axis) => `${axis}${crop[axis].left}-${crop[axis].right}`).join("_");
  return `${baseName}_L${volume.imageInfo.multiscaleLevel}_${ranges}.tif`;
}

/**
 * Encodes the loaded channels of the cropped in-memory volume
 */
export function exportCroppedVolumeToTiff(
  volume: Volume,
  channelIndices: number[],
  crop: CropIndexBounds
): { blob: Blob; fileName: string } {

  const size: [number, number, number] = [
    crop.x.right - crop.x.left,
    crop.y.right - crop.y.left,
    crop.z.right - crop.z.left,
  ];
  if (size.some((s) => s <= 0)) {
    throw new Error("The cropped region is empty.");
  }

  const loadedOffset = volume.imageInfo.subregionOffset;
  const loadedSize = volume.imageInfo.subregionSize;
  const offset: [number, number, number] = [
    crop.x.left - loadedOffset.x,
    crop.y.left - loadedOffset.y,
    crop.z.left - loadedOffset.z,
  ];
  const dims: [number, number, number] = [loadedSize.x, loadedSize.y, loadedSize.z];
  if (offset.some((o, i) => o < 0 || o + size[i] > dims[i])) {
    throw new Error(LOADING_MESSAGE);
  }

  const channels = channelIndices.map((index) => volume.getChannel(index));
  if (channels.some((channel) => !channel.loaded || channel.dims.some((d, i) => d !== dims[i]))) {
    throw new Error(LOADING_MESSAGE);
  }

  const dtype = channels[0].dtype;
  const spacing = volume.imageInfo.currentLevelDims.spacing;
  const blob = writeImageJTiff({
    size,
    channels: channels.map((channel) => extractSubvolume(channel.volumeData, dims, offset, size)),
    dtype,
    physicalPixelSize: [spacing[4], spacing[3], spacing[2]],
    spatialUnit: volume.imageInfo.spatialUnit,
  });

  return { blob, fileName: getExportFileName(volume, crop) };
}
