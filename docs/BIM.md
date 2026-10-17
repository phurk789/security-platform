# Bringing real building models (BIM) into the digital twin

The twin draws buildings from their footprints with BIM-style detail (levels, glass ground floor,
entrances, fire exits). For a faithful site, replace them with your own models and ground image.
Everything is optional and described by one file: `apps/web/public/media/twin.json`.

```json
{
  "ground": { "ortho": "media/site-ortho.jpg" },
  "models": [
    { "src": "media/site.glb", "origin": { "x": 0, "y": 0 }, "rotationDeg": 0, "scale": 1, "elevation": 0, "replaces": "*" }
  ]
}
```

| Field | Meaning |
|---|---|
| `ground.ortho` | Orthophoto / satellite image covering exactly the site rectangle (`SITE.width × SITE.height` m, north up). It replaces the painted site plan |
| `models[].src` | glTF (`.glb` or `.gltf`) in metres, **Y up**, with **north = −Z**. Textures embedded or next to the file |
| `origin` | Site-grid position (metres; x east, y south from the north-west corner) of the model's origin |
| `rotationDeg` | Turn the model clockwise (seen from above) if its north does not match |
| `scale`, `elevation` | Unit fix (e.g. 0.001 for millimetres) and height of the model origin above ground |
| `replaces` | Ids of footprint buildings the model stands in for (`"B1"`, …) or `"*"` for all. Their labels, level outlines and entrance markers stay; clicking the model still opens the building panel |

Building information (levels, floor height, floor area, occupancy, entrances, fire exits,
hydrants, systems) lives in `packages/shared/src/site.ts` (`BUILDINGS`). Fill it from the model's
property sets or the facility register; the panel and the level outlines use it.

## Exporting from BIM tools

| From | How |
|---|---|
| **Revit** | File → Export → IFC (IFC4, coordinates "Shared"), then convert with IfcOpenShell: `IfcConvert model.ifc site.glb --use-element-guids`; or a glTF exporter add-in (several free ones) with "metres" and "Y up" |
| **ArchiCAD** | File → Save as → IFC, then IfcConvert as above |
| **SketchUp** | glTF export extension, units metres |
| **Blender (+ Bonsai/BlenderBIM)** | Import IFC → File → Export → glTF 2.0 (`.glb`, "+Y up", apply modifiers) |
| **Point cloud / photogrammetry** (drone scan) | Mesh to glTF from RealityCapture / Metashape; decimate to < 500k triangles |

Keep models under ~30 MB. Remove interiors and furniture for the site twin; keep façades, roofs,
canopies and ground features. Put the site origin at the north-west corner of the site rectangle
or set `origin` accordingly. Check the fit by overlaying the orthophoto.

## Rendering quality

Layers → *High quality 3D* turns on bloom (lamps, windows), MSAA and reflections. Turn it off on
laptops without a dedicated GPU. Reflections come from a small painted environment, so they work
in every view, including the camera feeds rendered from the twin.
