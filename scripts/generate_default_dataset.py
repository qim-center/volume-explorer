#!/usr/bin/env python3
"""
Generate the default OME-Zarr (NGFF 0.5) dataset for the QIM Volume
Explorer.

The default dataset is the built-in synthetic 3D + time volume used for
demos, tests and development of the volume explorer. It is generated with
qim3d and is expected to evolve over time (e.g. adding color channels or
other dimensions); everything scene-specific below is grouped in its own
parameter section so the content can be swapped without touching the
OME-Zarr export logic.

Current scene: twisted rope
    A rope (``qim3d.generate.rope``) runs along Z through the full cube
    length, centered in the YX plane. Its twist rate follows one full
    cosine period over the time range: the twist starts loose, tightens
    mid-way and loosens again, so the first frame and the frame "after"
    the last one are identical and the animation loops seamlessly.

Resulting layout (multi-resolution pyramid, 64^3 chunks everywhere):

    default_omezarr.zarr
    ├── 0   15 x 1024 x 1024 x 1024   level 0 (full resolution)
    ├── 1   15 x  512 x  512 x  512   level 1 (2x downsampled)
    ├── 2   15 x  256 x  256 x  256   level 2
    ├── 3   15 x  128 x  128 x  128   level 3
    └── 4   15 x   64 x  64 x  64   level 4 (fits in a single chunk)

Every level uses (1, 64, 64, 64) chunks: 64^3 spatial cubes, one time
frame per chunk. Axis order is "tzyx" (time first, spatial "zyx" last),
as recommended by the OME-Zarr 0.5 specification
(https://ngff.openmicroscopy.org/0.5/).

qim3d usage
-----------
- ``qim3d.generate.rope``        : rope geometry, regenerated per frame with
                                   a different ``twist_rate``
- ``qim3d.generate.background``  : optional background noise
- ``qim3d.io.import_ome_zarr``   : final validation read of the dataset

Note: ``qim3d.io.export_ome_zarr`` only supports 3D data, so the 4D export
below reuses the same ``ome_zarr`` package calls that qim3d's exporter
uses internally (``parse_url`` + ``CurrentFormat`` +
``write_multiscales_metadata``), extended with the time axis.

Requirements:
    python with numpy, zarr, ome-zarr and qim3d installed, e.g. the
    qim3d development environment.

Run:
    python generate_default_dataset.py
"""

from __future__ import annotations

import logging
import os
import shutil
import time

import numpy as np
import zarr
from ome_zarr.io import parse_url
from ome_zarr.writer import CurrentFormat, write_multiscales_metadata

from qim3d.generate import background, rope
from qim3d.io import import_ome_zarr

# ============================================================================
# PARAMETERS  --  adjust these to change the dataset
# ============================================================================

# --- Output -----------------------------------------------------------------
# Name of the default dataset (also written to the OME-Zarr metadata). The
# store is written to DEFAULT_DATASET_NAME + ".zarr" next to this script.
DEFAULT_DATASET_NAME = "default_omezarr"
OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    f"{DEFAULT_DATASET_NAME}.zarr",
)
REPLACE = True  # overwrite OUTPUT_PATH if it already exists

# --- Dataset dimensions -------------------------------------------------------
CUBE_SIZE = 1024      # level-0 ZYX size (cubic)
N_FRAMES = 15         # number of time frames
CHUNK_SIZE = 64       # OME-Zarr chunk size (64x64x64 cubes, 1 frame per chunk)
DOWNSAMPLE_RATE = 2   # pyramid factor between levels (2 = half size per level)

# --- Current scene: twisted rope ---------------------------------------------
# The scene below is what the default dataset currently shows. It is
# expected to change or grow over time (e.g. more channels); keep new
# scene parameters grouped here.
#
# The rope runs along Z across the full cube length; its (D x D)
# cross-section is centered in the YX plane.
SCENE_OBJECT_SIZE = 512     # rope cross-section size
SCENE_NUM_THREADS = 24      # number of threads in the rope
SCENE_THREAD_THICKNESS = 20 # thickness of an individual thread (voxels)
SCENE_THREAD_SPACING = 0.8  # spacing between threads (ratio of thread thickness)
SCENE_COMPRESSION_FACTOR = 0.0  # thread compression at overlaps (0-1)
SCENE_NOISE_SCALE = 0.03    # thread surface texture
SCENE_SEED = 42             # random seed (same seed on every frame => no
                            # flicker; the twist_rate is the only thing that
                            # changes over time)

# Twist animation (qim3d rope twist_rate over time).
# twist(t) = TWIST_MIN + (TWIST_MAX - TWIST_MIN) * 0.5 * (1 - cos(2*pi*t/N))
# One full cosine period over the whole frame range: the twist starts loose,
# tightens to TWIST_MAX mid-way, loosens again and returns to the starting
# state => the animation loops seamlessly.
TWIST_MIN = 0.5   # loosest twist (minimum twist_rate)
TWIST_MAX = 3.0   # tightest twist (maximum twist_rate)

# --- Optional background noise (qim3d.generate.background) ----------------------
# Maximum noise amplitude (0-255); 0 disables the background noise entirely.
BACKGROUND_NOISE = 32

# --- OME-Zarr metadata ------------------------------------------------------------
# Physical units written to the axes metadata (or None to omit them).
AXES_UNITS = {
    "t": "second",
    "z": "micrometer",
    "y": "micrometer",
    "x": "micrometer",
}


# ============================================================================
# Implementation
# ============================================================================


def twist_rate_for_frame(
    t: int, n_frames: int, twist_min: float, twist_max: float
) -> float:
    """Twist rate for frame ``t``: one full cosine period over the loop.

    ``twist_rate_for_frame(0) == twist_rate_for_frame(n_frames)`` so the
    last frame wraps seamlessly back to the first one.
    """
    phase = 2.0 * np.pi * t / n_frames
    return twist_min + (twist_max - twist_min) * 0.5 * (1.0 - np.cos(phase))


def pyramid_sizes(cube_size: int, chunk_size: int, downsample_rate: int) -> list[int]:
    """Spatial sizes of the pyramid levels, largest first.

    Repeatedly downsamples ``cube_size`` by ``downsample_rate`` until the
    level fits into a single ``chunk_size`` cube (inclusive).
    """
    sizes = [cube_size]
    while sizes[-1] > chunk_size:
        if sizes[-1] % downsample_rate != 0:
            raise ValueError(
                f"Level size {sizes[-1]} is not divisible by downsample_rate "
                f"{downsample_rate}. Pick a CUBE_SIZE that is a power-of-{downsample_rate} "
                f"multiple of CHUNK_SIZE."
            )
        sizes.append(sizes[-1] // downsample_rate)
    return sizes


def coarsen_cube(volume: np.ndarray, factor: int = 2) -> np.ndarray:
    """Exact block-mean downsampling of a cubic volume.

    Mirrors qim3d's ``OMEScaler.scaleZYXdask_coarsen``
    (``dask.coarsen(np.mean, ..., trim_excess=True)``) on a single cube.
    """
    n = volume.shape[0] // factor * factor
    if n != volume.shape[0]:
        volume = volume[:n, :n, :n]
    m = n // factor
    # Shape is (block, within-block) per axis, so the output index is the
    # block index (z // factor, ...) and the mean runs over the factor^3
    # voxels inside each block.
    reshaped = volume.reshape(m, factor, m, factor, m, factor)
    return reshaped.mean(axis=(1, 3, 5)).astype(volume.dtype)


def make_frame(
    t: int,
    n_frames: int,
    cube_size: int,
    object_size: int,
) -> np.ndarray:
    """Generate one (Z, Y, X) frame of the current scene: object centered
    in a full cube."""
    twist = twist_rate_for_frame(t, n_frames, TWIST_MIN, TWIST_MAX)
    logging.info(f"Frame {t:2d}/{n_frames}: rope twist_rate = {twist:.3f}")

    rope_vol = rope(
        shape=(cube_size, object_size, object_size),
        num_threads=SCENE_NUM_THREADS,
        thread_thickness=SCENE_THREAD_THICKNESS,
        twist_rate=twist,
        compression_factor=SCENE_COMPRESSION_FACTOR,
        thread_spacing=SCENE_THREAD_SPACING,
        noise_scale=SCENE_NOISE_SCALE,
        seed=SCENE_SEED,
    )

    frame = np.zeros((cube_size,) * 3, dtype=np.uint8)
    offset = (cube_size - object_size) // 2
    frame[
        :,
        offset : offset + object_size,
        offset : offset + object_size,
    ] = rope_vol

    if BACKGROUND_NOISE > 0:
        noise = background(
            background_shape=(cube_size,) * 3,
            baseline_value=0,
            min_noise_value=0,
            max_noise_value=BACKGROUND_NOISE,
            seed=SCENE_SEED + 1000,
        )
        frame = np.clip(frame.astype(np.uint16) + noise, 0, 255).astype(np.uint8)

    return frame


def create_arrays(root: "zarr.core.Group", sizes: list[int]) -> list:
    """Create one Zarr array per pyramid level (shape T x Z x Y x X)."""
    arrays = []
    for i, s in enumerate(sizes):
        arrays.append(
            root.create_array(
                str(i),
                shape=(N_FRAMES, s, s, s),
                dtype="uint8",
                chunks=(1, CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE),
                dimension_names=("t", "z", "y", "x"),
            )
        )
    return arrays


def write_metadata(root: "zarr.core.Group", sizes: list[int]) -> None:
    """Write the NGFF 0.5 'multiscales' metadata for the 4D pyramid."""
    datasets = [
        {
            "path": str(i),
            "coordinateTransformations": [
                {
                    "type": "scale",
                    "scale": [
                        1.0,
                        DOWNSAMPLE_RATE**i,
                        DOWNSAMPLE_RATE**i,
                        DOWNSAMPLE_RATE**i,
                    ],
                }
            ],
        }
        for i in range(len(sizes))
    ]
    write_multiscales_metadata(
        root,
        datasets=datasets,
        fmt=CurrentFormat(),
        axes="tzyx",
        axes_units=AXES_UNITS,
        name=DEFAULT_DATASET_NAME,
    )


def validate_dataset(path: str, n_levels: int) -> None:
    """Read the dataset back with qim3d and print a summary."""
    logging.info("Validating the dataset with qim3d.io.import_ome_zarr ...")
    for i in range(n_levels):
        arr = import_ome_zarr(path, scale=i, load=False)  # lazy: nothing loaded
        logging.info(
            f"  scale {i}: shape={arr.shape}, dtype={arr.dtype}, chunks={arr.chunks}"
        )
    logging.info("Validation finished: dataset is readable by qim3d.")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s](message)s",
    )

    # ---- sanity checks -------------------------------------------------------
    if TWIST_MIN < 0 or TWIST_MAX < TWIST_MIN:
        raise ValueError(
            f"Invalid twist range: TWIST_MIN={TWIST_MIN}, TWIST_MAX={TWIST_MAX} "
            f"(need 0 <= TWIST_MIN <= TWIST_MAX)."
        )
    if not 0 <= SCENE_COMPRESSION_FACTOR <= 1:
        raise ValueError("SCENE_COMPRESSION_FACTOR must be in [0, 1].")
    if not SCENE_THREAD_THICKNESS < SCENE_OBJECT_SIZE // 2:
        raise ValueError(
            "SCENE_THREAD_THICKNESS must be smaller than SCENE_OBJECT_SIZE / 2."
        )
    if not (SCENE_OBJECT_SIZE < CUBE_SIZE):
        raise ValueError("SCENE_OBJECT_SIZE must be smaller than CUBE_SIZE.")
    if CUBE_SIZE % CHUNK_SIZE != 0:
        raise ValueError("CUBE_SIZE should be a multiple of CHUNK_SIZE.")

    sizes = pyramid_sizes(CUBE_SIZE, CHUNK_SIZE, DOWNSAMPLE_RATE)
    if sizes[-1] > CHUNK_SIZE:
        raise ValueError("Lowest level does not fit in a single chunk.")
    logging.info(
        f"Pyramid levels (Z): {sizes} -> {len(sizes)} levels, "
        f"{N_FRAMES} frames, chunk size {CHUNK_SIZE}."
    )

    # ---- prepare the output store ---------------------------------------------
    out_dir = os.path.dirname(os.path.abspath(OUTPUT_PATH))
    os.makedirs(out_dir, exist_ok=True)
    if os.path.exists(OUTPUT_PATH):
        if not REPLACE:
            raise ValueError(
                f"OUTPUT_PATH {OUTPUT_PATH} already exists. "
                f"Set REPLACE = True to overwrite it."
            )
        shutil.rmtree(OUTPUT_PATH)

    store = parse_url(OUTPUT_PATH, mode="w").store
    root = zarr.group(store=store)

    arrays = create_arrays(root, sizes)
    write_metadata(root, sizes)

    # ---- generate the time series, level by level -----------------------------
    t_start = time.time()
    for t in range(N_FRAMES):
        t0 = time.time()

        frame = make_frame(t, N_FRAMES, CUBE_SIZE, SCENE_OBJECT_SIZE)

        # Multi-resolution pyramid for this frame (level 0 = full resolution)
        pyramid = [frame]
        for _ in range(len(sizes) - 1):
            pyramid.append(coarsen_cube(pyramid[-1], DOWNSAMPLE_RATE))

        # Write the frame at all levels (one time slice per level)
        for i, level in enumerate(pyramid):
            arrays[i][(t,)] = level

        logging.info(
            f"Frame {t:2d}/{N_FRAMES} done in {time.time() - t0:.1f}s "
            f"(scene + pyramid + {len(sizes)} level writes)"
        )

    logging.info(f"All {N_FRAMES} frames written in {time.time() - t_start:.1f}s")

    # ---- validation ---------------------------------------------------------------
    validate_dataset(OUTPUT_PATH, len(sizes))
    logging.info(f"Done! OME-Zarr dataset available at: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
