"""Generate original seamless PBR maps; no photos, downloads or image editing.

Requires NumPy and Pillow. These maps are intentionally visual approximations,
not measured Soyang material samples. Run before building the Blender scene.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image

DEST = Path(__file__).resolve().parent / 'textures'
RNG = np.random.default_rng(530123)


def smooth_noise(n, cells):
    """Periodic bilinear value noise, with no visible texture boundary."""
    grid = RNG.random((cells, cells)).astype(np.float32)
    xy = np.arange(n, dtype=np.float32) * cells / n
    lo = np.floor(xy).astype(int)
    t = xy - lo
    t = t*t*(3-2*t)
    a = grid[lo[:, None] % cells, lo[None, :] % cells]
    b = grid[lo[:, None] % cells, (lo[None, :]+1) % cells]
    c = grid[(lo[:, None]+1) % cells, lo[None, :] % cells]
    d = grid[(lo[:, None]+1) % cells, (lo[None, :]+1) % cells]
    return (a*(1-t)[None, :] + b*t[None, :])*(1-t)[:, None] + (c*(1-t)[None, :] + d*t[None, :])*t[:, None]


def fbm(n):
    return sum(weight*smooth_noise(n, cells) for cells, weight in [(4,.38),(13,.26),(37,.19),(101,.11),(239,.06)])


def export(name, rgb, height, roughness, repeat_m):
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    Image.fromarray(rgb).save(DEST / f'{name}-basecolor.jpg', quality=93, subsampling=0)
    # OpenGL tangent normals: increasing U/V height bends the normal backward.
    m_per_pixel = repeat_m / height.shape[0]
    dx = (np.roll(height,-1,axis=1)-np.roll(height,1,axis=1))/(2*m_per_pixel)
    dy = (np.roll(height,-1,axis=0)-np.roll(height,1,axis=0))/(2*m_per_pixel)
    normal = np.stack([-dx, dy, np.ones_like(dx)], axis=-1)
    normal /= np.linalg.norm(normal,axis=-1,keepdims=True)
    Image.fromarray(np.clip((normal*.5+.5)*255,0,255).astype(np.uint8)).save(DEST / f'{name}-normal.png')
    rough = np.clip(roughness*255,0,255).astype(np.uint8)
    Image.fromarray(rough).save(DEST / f'{name}-roughness.png')
    return {'repeatMeters':repeat_m, 'size':list(height.shape), 'normalConvention':'OpenGL', 'source':'original procedural texture; not measured'}


def stones(n=1536, cells=29):
    """Irregular Voronoi stones with narrow recessed joints and bevel relief."""
    yy, xx = np.mgrid[0:n,0:n].astype(np.float32)*cells/n
    # Broken quarried edges and mixed sizes; an unwarped cell pattern would
    # suggest neatly fitted paving stones instead of loose rock armour.
    xx += (smooth_noise(n,43)-.5)*.34+(smooth_noise(n,157)-.5)*.065
    yy += (smooth_noise(n,39)-.5)*.34+(smooth_noise(n,163)-.5)*.065
    ix, iy = xx.astype(int), yy.astype(int)
    centers = RNG.uniform(.015,.985,(cells,cells,2)).astype(np.float32)
    palette = RNG.uniform(.61,1.32,(cells,cells)).astype(np.float32)
    weights = RNG.uniform(-.16,.16,(cells,cells)).astype(np.float32)
    first = np.full((n,n), 1e5, np.float32)
    second = first.copy()
    tone = np.zeros_like(first)
    for oy in [-1,0,1]:
        for ox in [-1,0,1]:
            cx,cy=ix+ox,iy+oy
            sx = cx+centers[cy%cells,cx%cells,0]
            sy = cy+centers[cy%cells,cx%cells,1]
            distance=(xx-sx)**2+(yy-sy)**2+weights[cy%cells,cx%cells]
            nearer=distance<first
            second=np.where(nearer,first,np.minimum(second,distance))
            tone=np.where(nearer,palette[cy%cells,cx%cells],tone)
            first=np.minimum(first,distance)
    edge=second-first
    joint=(.09+.085*smooth_noise(n,91))
    relief=np.clip(edge/joint,0,1)
    relief=relief*relief*(3-2*relief)
    grain=fbm(n)
    fine=RNG.normal(0,7.0,(n,n)).astype(np.float32)
    mineral=smooth_noise(n,417)
    flecks=np.clip((mineral-.62)*4,0,1)*37-np.clip((.34-mineral)*4,0,1)*29
    warm=smooth_noise(n,9)-.5
    value=39+86*relief*tone+53*(grain-.5)+fine+flecks
    rgb=np.stack([value+7+warm*15,value+6+warm*8,value+warm*2],axis=-1)
    height=.068*relief+(.035*grain+.008*mineral)*relief
    roughness=.76+.18*(1-grain)+.06*(1-relief)
    return export('rockfill',rgb,height,roughness,24.0)


def concrete(n=1024):
    noise=fbm(n)
    streak=smooth_noise(n,44)
    streak=np.mean(np.stack([np.roll(streak,i,axis=0) for i in range(-24,25,4)]),axis=0)
    fine=RNG.normal(0,2.3,(n,n)).astype(np.float32)
    pits=np.clip((smooth_noise(n,252)-.80)*5,0,1)
    value=158+34*(noise-.5)+17*(streak-.5)+fine-22*pits
    rgb=np.stack([value+3,value+3,value-3],axis=-1)
    return export('concrete',rgb,.006*noise-.003*pits,.78+.12*noise,7.0)


def terrain(n=1024):
    noise=fbm(n)
    patch=smooth_noise(n,7)
    detail=smooth_noise(n,132)
    # Low-contrast leaf litter and forest-floor soil. Large dark/bright patches
    # at a 115 m repeat looked like camouflage when seen across the valley.
    green=np.stack([np.full_like(noise,68),np.full_like(noise,77),np.full_like(noise,52)],axis=-1)
    earth=np.stack([np.full_like(noise,84),np.full_like(noise,80),np.full_like(noise,61)],axis=-1)
    mix=np.clip(.22+(patch-.5)*.85,.02,.55)[...,None]
    rgb=green*(1-mix)+earth*mix+(noise[...,None]-.5)*16+(detail[...,None]-.5)*9
    return export('terrain',rgb,.035*noise+.008*detail,.86+.12*noise,32.0)


def foliage(n=768):
    noise=fbm(n)
    clump=smooth_noise(n,54)
    leaf=smooth_noise(n,170)
    value=.66+.52*noise+.20*(clump-.5)+.16*(leaf-.5)
    rgb=np.stack([64*value,89*value,43*value],axis=-1)
    return export('foliage',rgb,.045*clump+.014*leaf,.84+.13*noise,7.0)


def generate():
    DEST.mkdir(parents=True,exist_ok=True)
    metadata={name:fn() for name,fn in [('rockfill',stones),('concrete',concrete),('terrain',terrain),('foliage',foliage)]}
    (DEST/'materials.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'generated':str(DEST),'materials':metadata,'bytes':sum(p.stat().st_size for p in DEST.iterdir())}))


if __name__=='__main__':
    generate()
