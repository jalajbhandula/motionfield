import torch
import nvdiffrast.torch as dr


def rasterise(verts):
    ctx = dr.RasterizeCudaContext()
    return ctx
