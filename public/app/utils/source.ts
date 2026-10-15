import { VolumeFileFormat } from "../../../src";
import { getFileTypeHintCandidates, remapUri } from "../../../src/utils/url_utils";

// zarr v3 keeps group metadata in `zarr.json`, v2 in `.zattrs`
const ZARR_METADATA_FILES = ["zarr.json", ".zattrs"];

async function hasZarrMetadata(sourceUrl: string): Promise<boolean> {
  const base = remapUri(sourceUrl).replace(/\/+$/, "");
  const isJsonFile = async (file: string): Promise<boolean> => {
    try {
      const response = await fetch(`${base}/${file}`);
      return response.ok && typeof (await response.json()) === "object";
    } catch {
      return false;
    }
  };
  return (await Promise.all(ZARR_METADATA_FILES.map(isJsonFile))).some(Boolean);
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
  return (await hasZarrMetadata(sourceUrl)) ? VolumeFileFormat.ZARR : null;
}
