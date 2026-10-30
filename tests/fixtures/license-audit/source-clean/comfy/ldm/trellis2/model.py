import torch
import math
import comfy.model_management


def rasterise(verts, faces):
    return verts @ faces
