import { VolumeFileFormat } from "../../../src";
import { getFileTypeHintCandidates, remapUri } from "../../../src/utils/url_utils";

async function hasZarrJson(sourceUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${remapUri(sourceUrl).replace(/\/+$/, "")}/zarr.json`);
    return response.ok && typeof (await response.json()) === "object";
  } catch {
    return false;
  }
}

export async function inferVolumeFileFormat(sourceUrl: string): Promise<VolumeFileFormat | null> {
  const candidates = getFileTypeHintCandidates(sourceUrl);
  if (
    candidates.some(
      (candidate) => candidate.includes(".ome.zarr") || candidate.endsWith(".zarr") || candidate.includes(".zarr/")
    )
  ) {
    return VolumeFileFormat.ZARR;
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.endsWith(".ome.tiff") ||
        candidate.endsWith(".tiff") ||
        candidate.endsWith(".ome.tif") ||
        candidate.endsWith(".tif")
    )
  ) {
    return VolumeFileFormat.TIFF;
  }
  if (candidates.some((candidate) => candidate.endsWith(".h5") || candidate.endsWith(".hdf5"))) {
    return VolumeFileFormat.H5;
  }
  return (await hasZarrJson(sourceUrl)) ? VolumeFileFormat.ZARR : null;
}
