"""Create a new Soyang-reference presentation scene (1.4 detail and 1.5 precision passes included).

No Blender data is changed by importing this file. Call build(output_dir) to construct and export a new independent scene. The current scene is kept
and restored. This is an original visual approximation, NOT a surveyed model,
CFD mesh, actual gate model, or hydraulic safety result.

Example only:
  import importlib.util
  spec = importlib.util.spec_from_file_location('backup_soyang', SCRIPT_PATH)
  module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
  module.build(OUTPUT_DIRECTORY)

Coordinate convention while constructing: metres, Blender Z-up, upstream +Y.
GLB export converts to Y-up: Blender (x,y,z) -> manifest (x,z,-y).
"""
from pathlib import Path
import json
import math
import random
import time
import uuid


def build(output_dir, render_preview=False):
    import bpy
    from mathutils import Vector

    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    rng = random.Random(470123)
    tag = 'TWIN_Soyang_Model_' + uuid.uuid4().hex[:8]
    old_scene = bpy.context.window.scene if bpy.context.window else None
    scene = bpy.data.scenes.new(tag)
    model = bpy.data.collections.new(tag + '_STATIC_MODEL')
    preview = bpy.data.collections.new(tag + '_PREVIEW_ONLY')
    scene.collection.children.link(model)
    scene.collection.children.link(preview)
    model_objects = []
    texture_dir = Path(__file__).resolve().parent / 'textures'
    texture_metadata = json.loads((texture_dir/'materials.json').read_text(encoding='utf-8'))
    texture_images = {}

    def enum_value(property_rna, preferences):
        """Use a value only after inspecting the active Blender RNA enum."""
        available = {item.identifier for item in property_rna.enum_items}
        if not available and property_rna.identifier == 'export_format':
            # Blender 5.1's glTF formats are dynamic; RNA enum_items is empty.
            # Query the installed add-on's actual callback instead of guessing.
            import io_scene_gltf2
            available = {item[0] for item in io_scene_gltf2.get_format_items(scene, bpy.context) if item}
        for value in preferences:
            if value in available:
                return value
        raise RuntimeError('None of %r available in %r' % (preferences, available))

    def shader_node(tree, node_type):
        if not hasattr(bpy.types, node_type):
            raise RuntimeError('Shader node unavailable: ' + node_type)
        return tree.nodes.new(node_type)

    def socket(node, *identifiers):
        expected = {s.casefold().replace(' ', '_') for s in identifiers}
        for item in node.inputs:
            if item.identifier.casefold().replace(' ', '_') in expected or item.name.casefold().replace(' ', '_') in expected:
                return item
        return None

    def material(name, color, roughness=.8, metallic=0.0, vertex=False, texture=None, normal_strength=1.0):
        mat = bpy.data.materials.new(tag + '_' + name)
        mat.diffuse_color = (*color, 1)
        # Blender 5.x creates a node tree automatically; older versions may not.
        if mat.node_tree is None and hasattr(mat, 'use_nodes'):
            mat.use_nodes = True
        tree = mat.node_tree
        if tree is None:
            raise RuntimeError('Material node tree was not created: ' + name)
        principled = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not principled:
            principled = shader_node(tree, 'ShaderNodeBsdfPrincipled')
        for ids, val in [(('Base Color',), (*color, 1)), (('Roughness',), roughness), (('Metallic',), metallic)]:
            target = socket(principled, *ids)
            if target:
                target.default_value = val
        color_source = None
        if texture:
            mat['twin_texture_key'] = texture
            mat['twin_texture_repeat_m'] = texture_metadata[texture]['repeatMeters']
            mat['twin_vertex_tint_reference'] = list(color)
            for channel, suffix in [('basecolor','jpg'),('normal','png'),('roughness','png')]:
                key = texture+'-'+channel
                if key not in texture_images:
                    image = bpy.data.images.load(str(texture_dir/(key+'.'+suffix)),check_existing=False)
                    if channel != 'basecolor':
                        image.colorspace_settings.name = 'Non-Color'
                    image.pack()
                    texture_images[key] = image
                node = shader_node(tree,'ShaderNodeTexImage')
                node.image = texture_images[key]
                node.extension = enum_value(node.bl_rna.properties['extension'],['REPEAT'])
                node.label = texture+' '+channel+' (metre-scaled UV)'
                if channel=='basecolor':
                    color_source = node.outputs['Color']
                elif channel=='normal':
                    normal = shader_node(tree,'ShaderNodeNormalMap')
                    socket(normal,'Strength').default_value = normal_strength
                    tree.links.new(node.outputs['Color'],socket(normal,'Color'))
                    tree.links.new(normal.outputs['Normal'],socket(principled,'Normal'))
                else:
                    tree.links.new(node.outputs['Color'],socket(principled,'Roughness'))
        if vertex:
            color_node = shader_node(tree, 'ShaderNodeVertexColor')
            color_node.layer_name = 'Color'
            color_output = next(o for o in color_node.outputs if o.name == 'Color')
            if color_source:
                # glTF exporter recognises image * vertex colour; original
                # texture maps remain embedded, not a Blender-only shader.
                multiply = shader_node(tree,'ShaderNodeMix')
                multiply.data_type = enum_value(multiply.bl_rna.properties['data_type'],['RGBA'])
                multiply.blend_type = enum_value(multiply.bl_rna.properties['blend_type'],['MULTIPLY'])
                socket(multiply,'Factor').default_value=1.0
                tree.links.new(color_source,socket(multiply,'A_Color'))
                tree.links.new(color_output,socket(multiply,'B_Color'))
                color_source=next(o for o in multiply.outputs if o.type=='RGBA')
            else:
                color_source=color_output
        if color_source:
            tree.links.new(color_source,socket(principled,'Base Color'))
        return mat

    mat_forest = material('Forest_Leaf_Clusters', (.09,.16,.055), .96, vertex=True,texture='foliage',normal_strength=.65)
    mat_ground = material('Terrain_Grass_Earth', (.065,.135,.04), 1, vertex=True,texture='terrain',normal_strength=.8)
    mat_rock = material('Rockfill_Granite_PBR', (.22,.224,.205), .95, vertex=True,texture='rockfill')
    mat_concrete = material('Weathered_Concrete', (.39,.41,.36), .87,texture='concrete')
    mat_concrete_light = material('Pale_Concrete', (.50,.52,.46), .8,texture='concrete',normal_strength=.6)
    mat_concrete_dark = material('Concrete_Joints', (.235,.25,.215), .88)
    mat_teal = material('Teal_Gate_Steel', (.055, .31, .30), .44, .28)
    mat_roof = material('Powerhouse_Turquoise_Roof', (.09, .42, .34), .62, .12)
    mat_glass = material('Window_Blue_Glass', (.025, .09, .105), .22, .4)
    mat_road = material('Asphalt', (.24, .27, .255), .94)
    mat_line = material('Road_And_Rail_Light', (.88, .87, .76), .62)
    mat_dark = material('Outlet_Interior', (.035, .05, .045), 1)
    mat_bark = material('Tree_Bark', (.17, .13, .085), 1)
    mat_grass = material('Grass_Bench', (.16,.24,.10), 1,texture='terrain',normal_strength=.4)
    mat_valley_bed = material('Earthy_Valley_Bed', (.085, .105, .060), 1)
    mat_water = material('Preview_Water_Only', (.08, .32, .37), .23, .2)
    # 1.4 detail pass materials: painted steel and a red staff-gauge band.
    mat_steel = material('Painted_Steel_Grey', (.36, .40, .39), .52, .55)
    mat_red = material('Gauge_Red_Band', (.62, .10, .08), .6)

    def mesh_obj(name, vertices, faces, mat, colors=None, smooth=False, collection=model):
        mesh = bpy.data.meshes.new(tag + '_' + name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(tag + '_' + name, mesh)
        collection.objects.link(obj)
        if mat:
            mesh.materials.append(mat)
        if mat and 'twin_texture_repeat_m' in mat:
            # Continuous metre-scaled UVs on horizontal land/dam surfaces;
            # box projection on steep architectural walls. No guessed unwrap
            # operators and no scale-dependent Generated coordinates.
            repeat=float(mat['twin_texture_repeat_m'])
            uv=mesh.uv_layers.new(name='UVMap')
            for polygon in mesh.polygons:
                n=polygon.normal
                if name=='Joined_Forest_Canopies' or abs(n.z)>.26:
                    axes=(0,1)
                elif abs(n.x)>abs(n.y):
                    axes=(1,2)
                else:
                    axes=(0,2)
                for loop_index in polygon.loop_indices:
                    co=mesh.vertices[mesh.loops[loop_index].vertex_index].co
                    uv.data[loop_index].uv=(co[axes[0]]/repeat,co[axes[1]]/repeat)
        if smooth:
            for face in mesh.polygons:
                face.use_smooth = True
        if colors:
            params = mesh.color_attributes.bl_rna.functions['new'].parameters
            kind = enum_value(params['type'], ['BYTE_COLOR', 'FLOAT_COLOR'])
            domain = enum_value(params['domain'], ['CORNER'])
            attr = mesh.color_attributes.new(name='Color', type=kind, domain=domain)
            for loop in mesh.loops:
                c = colors[loop.vertex_index]
                if mat and 'twin_vertex_tint_reference' in mat:
                    reference=mat['twin_vertex_tint_reference']
                    # Preserve regional/species variation without multiplying
                    # a dark photograph by already dark absolute colours.
                    if mat.get('twin_texture_key')=='terrain':
                        # Channel-wise division by a very green reference made
                        # neutral downstream earth pink. Keep soil chroma in
                        # the texture, with restrained vertex brightness only.
                        brightness=max(.73,min(.95,.80*sum(c[:3])/max(.04,sum(reference))))
                        c=(brightness*.98,brightness,brightness*.94)
                    else:
                        c=tuple(max(.38,min(1.0,.78*c[i]/max(.015,reference[i]))) for i in range(3))
                attr.data[loop.index].color = (*c[:3], c[3] if len(c) > 3 else 1)
        if collection == model:
            model_objects.append(obj)
        return obj

    def box(name, center, size, mat, bevel=0):
        x, y, z = center
        a, b, c = (v / 2 for v in size)
        verts = [(x+i*a, y+j*b, z+k*c) for k in [-1, 1] for j in [-1, 1] for i in [-1, 1]]
        faces = [(0,2,3,1),(4,5,7,6),(0,1,5,4),(1,3,7,5),(3,2,6,7),(2,0,4,6)]
        obj = mesh_obj(name, verts, faces, mat)
        if bevel:
            modifier = obj.modifiers.new('Subtle_Edge_Highlights', 'BEVEL')
            modifier.width = bevel
            modifier.segments = 2
            # Supported options are discovered instead of assuming enum values.
            modifier.limit_method = enum_value(modifier.bl_rna.properties['limit_method'], ['ANGLE', 'NONE'])
        return obj

    def tube(name, points, radius, mat, segments=8):
        verts, faces = [], []
        for index, p in enumerate(points):
            p = Vector(p)
            tangent = Vector(points[min(len(points)-1, index+1)]) - Vector(points[max(0,index-1)])
            tangent.normalize()
            ref = Vector((0,0,1)) if abs(tangent.z) < .95 else Vector((0,1,0))
            a = tangent.cross(ref).normalized()
            b = tangent.cross(a).normalized()
            for j in range(segments):
                q = p + radius*(a*math.cos(j*math.tau/segments)+b*math.sin(j*math.tau/segments))
                verts.append(tuple(q))
            if index:
                for j in range(segments):
                    a0 = (index-1)*segments+j
                    a1 = (index-1)*segments+(j+1)%segments
                    b0 = index*segments+j
                    b1 = index*segments+(j+1)%segments
                    faces.append((a0,a1,b1,b0))
        faces.extend([tuple(reversed(range(segments))), tuple(range(len(verts)-segments,len(verts)))])
        return mesh_obj(name, verts, faces, mat, smooth=True)

    def ribbon(name, points, width, mat, thickness=0):
        verts, faces = [], []
        for i, p in enumerate(points):
            before = Vector(points[max(0,i-1)])
            after = Vector(points[min(len(points)-1,i+1)])
            tangent = after-before
            side = Vector((-tangent.y,tangent.x,0))
            if side.length < 1e-6:
                side = Vector((1,0,0))
            side.normalize()
            for sign in [-1,1]:
                v = Vector(p)+side*width*.5*sign
                verts.append(tuple(v))
            if i:
                # Upward winding: Solidify must extend below roads/chute,
                # leaving the animated water path above the concrete surface.
                faces.append((2*i-2,2*i,2*i+1,2*i-1))
        obj = mesh_obj(name, verts, faces, mat)
        if thickness:
            solidify = obj.modifiers.new('Road_Thickness','SOLIDIFY')
            solidify.thickness = thickness
            solidify.offset = -1.0
        return obj

    def embankment(name, points, top_width, slope=1.5, base_z=-1.0, drop=0.2):
        """Closed earth fill under a road: flat top `drop` below the road surface,
        side slopes `slope` horizontal per 1 vertical down to base_z, vertical end faces."""
        verts, faces, colors = [], [], []
        for i, (x, y, z) in enumerate(points):
            before = Vector(points[max(0, i-1)][:2]); after = Vector(points[min(len(points)-1, i+1)][:2])
            tangent = (after-before).normalized()
            side = Vector((-tangent.y, tangent.x))
            top = z-drop
            half = top_width*.5
            spread = half+max(0.0, top-base_z)*slope
            for off, zz in ((-half, top), (half, top), (spread, base_z), (-spread, base_z)):
                verts.append((x+side.x*off, y+side.y*off, zz))
            colors.extend([(.085, .14, .05), (.085, .14, .05), (.11, .12, .06), (.11, .12, .06)])
            if i:
                for k in range(4):
                    a = (i-1)*4+k; b = (i-1)*4+(k+1) % 4
                    c = i*4+(k+1) % 4; d = i*4+k
                    faces.append((a, b, c, d))
        faces.extend([tuple(reversed(range(4))), tuple(range(len(verts)-4, len(verts)))])
        return mesh_obj(name, verts, faces, mat_ground, colors, True)

    def cylinder(name, center, radius, height, mat, segments=16):
        x,y,z = center
        return tube(name, [(x,y,z-height*.5),(x,y,z+height*.5)], radius, mat, segments)

    def oriented_box(name, center, size, yaw, mat, bevel=0):
        """Box rotated about Z. size=(along yaw, across, up); yaw in radians."""
        cx, cy, cz = center
        a, b, c = (v / 2 for v in size)
        ca, sa = math.cos(yaw), math.sin(yaw)
        verts = []
        for k in [-1, 1]:
            for j in [-1, 1]:
                for i in [-1, 1]:
                    lx, ly = i*a, j*b
                    verts.append((cx+lx*ca-ly*sa, cy+lx*sa+ly*ca, cz+k*c))
        faces = [(0,2,3,1),(4,5,7,6),(0,1,5,4),(1,3,7,5),(3,2,6,7),(2,0,4,6)]
        obj = mesh_obj(name, verts, faces, mat)
        if bevel:
            modifier = obj.modifiers.new('Subtle_Edge_Highlights', 'BEVEL')
            modifier.width = bevel
            modifier.segments = 2
            modifier.limit_method = enum_value(modifier.bl_rna.properties['limit_method'], ['ANGLE', 'NONE'])
        return obj

    def sagging_line(name, start, end, radius=.12, sag_ratio=.045, steps=10, mat=None):
        """Overhead conductor drawn as a parabola; a presentation shape, not a catenary design."""
        p0, p1 = Vector(start), Vector(end)
        sag = (p1-p0).length*sag_ratio
        points = []
        for i in range(steps+1):
            t = i/steps
            q = p0.lerp(p1, t)
            q.z -= 4*sag*t*(1-t)
            points.append(tuple(q))
        return tube(name, points, radius, mat or mat_concrete_dark, 5)

    def lattice_tower(name, x, y, z0, height=38.0, base=4.6, top=1.5, yaw=0.0):
        """Simplified four-leg lattice pylon. Returns three conductor attachment points
        (lower arm -y, lower arm +y, top bracket) in the pylon's local line frame."""
        ca, sa = math.cos(yaw), math.sin(yaw)
        def corner(sx, sy, z):
            w = base+(top-base)*((z-z0)/height)
            lx, ly = sx*w, sy*w
            return (x+lx*ca-ly*sa, y+lx*sa+ly*ca, z)
        corners = [(-1,-1),(1,-1),(1,1),(-1,1)]
        for sx, sy in corners:
            tube(name+'_Leg', [corner(sx,sy,z0), corner(sx,sy,z0+height)], .30, mat_steel, 6)
        fractions = (0, .22, .44, .66, .88)
        for f in fractions[1:]:
            z = z0+height*f
            for i in range(4):
                a, b = corners[i], corners[(i+1) % 4]
                tube(name+'_Belt', [corner(*a, z), corner(*b, z)], .13, mat_steel, 5)
        for i in range(4):
            a, b = corners[i], corners[(i+1) % 4]
            for k in range(4):
                lo, hi = z0+height*fractions[k], z0+height*fractions[k+1]
                if k % 2 == 0:
                    tube(name+'_Brace', [corner(*a, lo), corner(*b, hi)], .11, mat_steel, 5)
                else:
                    tube(name+'_Brace', [corner(*b, lo), corner(*a, hi)], .11, mat_steel, 5)
        attachments = []
        z_arm, half = z0+height-9.0, 7.5
        oriented_box(name+'_Crossarm', (x, y, z_arm), (0.7, 2*half+1.6, 0.7), yaw, mat_steel)
        for sy in [-1, 1]:
            ax, ay = x-sy*half*sa, y+sy*half*ca
            tube(name+'_Insulator', [(ax, ay, z_arm-.3), (ax, ay, z_arm-2.1)], .17, mat_line, 6)
            attachments.append((ax, ay, z_arm-2.1))
        tube(name+'_Peak', [(x, y, z0+height), (x, y, z0+height+2.6)], .14, mat_steel, 5)
        tube(name+'_Peak_Insulator', [(x, y, z0+height+2.6), (x, y, z0+height+4.2)], .17, mat_line, 6)
        attachments.append((x, y, z0+height+4.2))
        return attachments

    def gauss(x,y,cx,cy,sx,sy):
        return math.exp(-((x-cx)/sx)**2-((y-cy)/sy)**2)

    def terrain_height(x,y):
        h = 8 + 295*gauss(x,y,-675,240,360,650)
        h += 285*gauss(x,y,805,285,345,620)
        h += 150*gauss(x,y,-900,-575,370,430)
        h += 205*gauss(x,y,850,-620,310,450)
        h += 225*gauss(x,y,-190,1340,530,420)
        h += 145*gauss(x,y,800,1390,580,440)
        h += 9*math.sin(x*.012+y*.007)+6*math.cos(x*.021-y*.009)
        h += 3.5*math.sin(x*.055)*math.cos(y*.042)
        # 1.5: ridge and gully detail on high slopes only. Amplitude is zero below
        # 135 m, so every lake-edge and dam-abutment height is unchanged.
        amp = max(0.0, min(1.0, (h-135.0)/90.0))
        if amp > 0:
            h += amp*(4.6*math.sin(x*.041+y*.023)+3.4*math.cos(x*.017-y*.047)+2.1*math.sin(x*.093)*math.cos(y*.071)+1.2*math.sin(x*.19+y*.13))
        return max(3,h)

    # Terrain is several smoothly shaded patches; its open valley makes the dam
    # and reservoir legible instead of hiding them in a generic solid mountain.
    terrain_patches = [(-1250,-265,-850,1460,96,160),(390,1320,-850,1460,92,160),(-1250,1320,1040,1750,192,60)]
    for patch, (xmin,xmax,ymin,ymax,nx,ny) in enumerate(terrain_patches):
        verts,faces,colors=[],[],[]
        for j in range(ny+1):
            y=ymin+(ymax-ymin)*j/ny
            for i in range(nx+1):
                x=xmin+(xmax-xmin)*i/nx
                z=terrain_height(x,y)
                verts.append((x,y,z))
                variation=.86+.18*math.sin(x*.027+y*.031)+rng.uniform(-.05,.05)
                base=(.06,.13,.035) if z>40 else (.20,.18,.12)
                colors.append(tuple(max(0,min(1,c*variation)) for c in base))
                if i<nx and j<ny:
                    a=j*(nx+1)+i
                    faces.extend([(a,a+1,a+nx+2),(a,a+nx+2,a+nx+1)])
        mesh_obj('Forest_Terrain_%02d'%patch,verts,faces,mat_ground,colors,True)
        # Close the formerly open terrain patch edge with a sloping natural bank.
        # Top vertices match the terrain exactly; its foot remains below water.
        bank_v, bank_f, bank_c = [], [], []
        count = ny if patch < 2 else nx
        bands = 6
        for j in range(count+1):
            if patch == 0:
                x, y = xmax, ymin+(ymax-ymin)*j/count
                inward = (86, 0)
            elif patch == 1:
                x, y = xmin, ymin+(ymax-ymin)*j/count
                inward = (-76, 0)
            else:
                x, y = xmin+(xmax-xmin)*j/count, ymin
                inward = (0, -100)
            top = terrain_height(x,y)
            foot = min(top-1.5, 84.0) if y > 30 else -0.8
            for k in range(bands+1):
                t = k/bands
                ease = t*t*(3-2*t)
                bank_v.append((x+inward[0]*t,y+inward[1]*t,top*(1-ease)+foot*ease))
                # The exposed shore is earthier than the vegetated upper slope.
                bank_c.append(tuple(a*(1-ease)+b*ease for a,b in zip((.06,.13,.035),(.13,.125,.075))))
                if k < bands and j < count:
                    a = j*(bands+1)+k
                    face = (a,a+1,a+bands+2,a+bands+1)
                    if patch == 1:
                        face = tuple(reversed(face))
                    bank_f.append(face)
        mesh_obj('Sloping_Shore_Closure_%02d'%patch,bank_v,bank_f,mat_ground,bank_c,True)

    # A closed base bed has subtle shoreline color; it lies below animated water.
    box('Valley_Bed',(50,350,-10),(1100,2500,18),mat_valley_bed)
    bed_v,bed_f,bed_c=[],[],[]
    bnx,bny=48,100
    for j in range(bny+1):
        y=-895+2490*j/bny
        for i in range(bnx+1):
            x=-495+1090*i/bnx
            h=-.36+.20*math.sin(x*.033)*math.cos(y*.023)+.11*math.cos(x*.011+y*.02)
            bed_v.append((x,y,h))
            n=.85+.15*math.sin(x*.016+y*.010)+.09*math.cos(x*.051-y*.013)
            bed_c.append((.083*n,.108*n,.056*n))
            if i<bnx and j<bny:
                a=j*(bnx+1)+i
                bed_f.append((a,a+1,a+bnx+2,a+bnx+1))
    mesh_obj('Textured_Earth_Valley',bed_v,bed_f,mat_ground,bed_c,True)
    # This is an under-terrain render boundary, NOT a surveyed shoreline.
    # All side/rear edges are buried inside high ground. The visible shoreline
    # is therefore the terrain/water intersection at every display level,
    # rather than an exposed, vertically cut edge of a small water polygon.
    reservoir_polygon=[(-570,-4),(700,-4),(700,1300),(-570,1300)]
    reservoir_min_z,reservoir_max_z=116.0,121.5
    lake_verts=[(x,y,118.5) for x,y in reservoir_polygon]
    mesh_obj('Preview_Reservoir',lake_verts,[tuple(range(len(lake_verts)))],mat_water,collection=preview)

    # Rockfill body: trapezoidal section with separate upstream and downstream
    # slopes. A slight toe flare gives the broad 530m crest its reference shape.
    crest_z=123.0
    def face_point(u,t,upstream=False):
        width=265+36*t
        x=(2*u-1)*width
        y=(6+192*t) if upstream else (-6-274*t)
        z=crest_z*(1-t)+3*t
        if 0<t<1:
            z+=.11*math.sin(x*.071+y*.14)+.065*math.cos(x*.11-y*.06)
        return (x,y,z)

    for upstream in [False,True]:
        verts,faces,colors=[],[],[]
        nx,ny=106,47
        for j in range(ny+1):
            t=j/ny
            for i in range(nx+1):
                p=face_point(i/nx,t,upstream)
                verts.append(p)
                n=.94+.07*math.sin(p[0]*.03+p[1]*.022)+rng.uniform(-.015,.015)
                colors.append((.22*n,.224*n,.205*n))
                if i<nx and j<ny:
                    a=j*(nx+1)+i
                    faces.extend([(a,a+nx+1,a+1),(a+1,a+nx+1,a+nx+2)])
        if upstream:
            faces = [tuple(reversed(face)) for face in faces]
        mesh_obj('Upstream_Armoring' if upstream else 'Downstream_Rockfill',verts,faces,mat_rock,colors,True)
    # Seal both triangular rockfill ends rather than exposing hollow sheets.
    for side in [-1,1]:
        cap_v=[(side*265,6,123),(side*265,-6,123),(side*301,-280,3),(side*301,198,3)]
        face=tuple(range(4)) if side==1 else tuple(reversed(range(4)))
        mesh_obj('Rockfill_Endcap_'+str(side),cap_v,[face],mat_rock,[(.215,.222,.20)]*4)
    # Closed abutment saddles complete the front reservoir boundary. The
    # original high-water plane could pass around both rockfill end caps into
    # the low valley because the neighbouring terrain is only 55--85 m high.
    # These landforms meet the dam/gate structure and merge into high terrain.
    def abutment_saddle(name, xmin, xmax, dam_side):
        nx,ny=34,20
        verts,faces,colors=[],[],[]
        ymin,ymax=-76.0,112.0
        for j in range(ny+1):
            y=ymin+(ymax-ymin)*j/ny
            # A broad but rounded ridge crosses the water's front boundary.
            profile=math.exp(-((y-1.0)/43.0)**4)
            for i in range(nx+1):
                x=xmin+(xmax-xmin)*i/nx
                native=terrain_height(x,y)
                distance=abs(x-dam_side)
                crest=123.2+2.4*min(1.0,distance/24.0)
                raised=max(0.0,crest-native)*profile
                z=native+raised
                verts.append((x,y,z))
                tint=.88+.05*math.sin(x*.035+y*.042)
                colors.append((.075*tint,.137*tint,.043*tint))
                if i<nx and j<ny:
                    a=j*(nx+1)+i
                    faces.extend([(a,a+1,a+nx+2),(a,a+nx+2,a+nx+1)])
        # The saddle is a closed volume; all four outer edges descend to the
        # existing valley bed, so low viewpoints cannot look under a sheet.
        outline=[]
        outline.extend(range(nx+1))
        outline.extend(j*(nx+1)+nx for j in range(1,ny+1))
        outline.extend(ny*(nx+1)+i for i in range(nx-1,-1,-1))
        outline.extend(j*(nx+1) for j in range(ny-1,0,-1))
        base=len(verts)
        for idx in outline:
            x,y,_=verts[idx]; verts.append((x,y,-.8)); colors.append((.10,.12,.065))
        for i,top in enumerate(outline):
            nxt=(i+1)%len(outline)
            faces.append((top,base+i,base+nxt,outline[nxt]))
        faces.append(tuple(reversed(range(base,len(verts)))))
        return mesh_obj(name,verts,faces,mat_ground,colors,True)

    abutment_saddle('Left_Abutment_Closed_Land',-470,-261,-265)
    abutment_saddle('Right_Abutment_Closed_Land',349,570,349)

    box('Crest_Road',(0,0,123.6),(545,12,1.1),mat_road,.18)
    box('Crest_Centreline',(0,0,124.19),(540,.26,.025),mat_line)
    for y in [-6.1,6.1]:
        box('Crest_Parapet',(0,y,124.8),(545,.65,1.3),mat_concrete_light,.10)
        tube('Crest_Handrail',[(-272,y,126),(272,y,126)],.11,mat_line,6)
        for x in range(-270,271,15):
            box('Crest_Rail_Post',(x,y,125.55),(.14,.14,1.0),mat_line)

    # Reference-like switchback service path across the grey downstream face.
    bench_nodes=[(-252,-28,114),(239,-78,92),(-260,-145,63),(250,-202,39),(-223,-251,18)]
    # 1.5: each switchback leg is its own constant-width ribbon (a single polyline
    # pinched to a point at every hairpin), with a turnaround pad at each bend.
    for leg,(a,b) in enumerate(zip(bench_nodes,bench_nodes[1:])):
        ribbon('Zigzag_Grass_Border_%d'%leg,[a,b],12.0,mat_grass,.2)
        ribbon('Zigzag_Service_Path_%d'%leg,[(a[0],a[1],a[2]+.12),(b[0],b[1],b[2]+.12)],4.2,mat_concrete,.1)
    for k,(x,y,z) in enumerate(bench_nodes[1:-1]):
        cylinder('Zigzag_Turnaround_%d'%k,(x,y,z+.14),7.5,.24,mat_concrete,20)
    for i in range(13):
        y=-23-i*18
        z=123*(1-(-y-6)/274)+.7
        ribbon('Face_Drain_%02d'%i,[(-265,y,z),(270,y,z)],.22,mat_concrete_dark)

    # Angular granite pieces embedded into the armoured face, with bounded
    # relief. The finer aggregate is supplied by the metre-scaled PBR maps.
    rock_verts,rock_faces,rock_colors=[],[],[]
    for i in range(3300):
        u,t=rng.random(),rng.uniform(.04,.97)
        x,y,z=face_point(u,t)
        radius=rng.uniform(.32,1.02)
        base=len(rock_verts)
        shape=[(-.75,-.5,-.28),(.8,-.48,-.20),(.64,.64,-.22),(-.62,.52,-.18),(-.60,-.40,.25),(.55,-.37,.37),(.48,.50,.28),(-.42,.39,.39)]
        angle=rng.random()*math.tau
        ca,sa=math.cos(angle),math.sin(angle)
        n=rng.uniform(.76,1.08)
        for a,b,c in shape:
            # Follow the downstream slope so stones sit on it instead of
            # appearing as randomly tilted triangular paper fragments.
            aa,bb=(a*ca-b*sa)*radius,(a*sa+b*ca)*radius
            rock_verts.append((x+aa,y+bb,z+bb*(120/274)+c*radius))
            rock_colors.append((.205*n,.212*n,.193*n))
        rock_faces.extend(tuple(base+k for k in f) for f in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
    mesh_obj('Individual_Riprap',rock_verts,rock_faces,mat_rock,rock_colors)

    # Distinct spillway to the viewer's right. Five teal gate bays and a broad
    # concrete chute remain separate from the rockfill body.
    chute_x=315
    chute_points=[(chute_x,4,115),(chute_x,-28,111),(chute_x,-80,96),(chute_x,-155,70),(chute_x,-230,43),(chute_x,-305,17),(chute_x,-350,7)]
    # 1.5: flip bucket. The chute toe curves up on a radius-22 arc so the flow
    # leaves as a free jet into a plunge pool (the reference photo shows a
    # bucket, not a baffled basin). Arc and jet are presentation geometry.
    bucket_radius=22.0
    toe_angle=math.atan2(10.0,45.0)
    bucket_center=(-350.0-bucket_radius*math.sin(toe_angle),7.0+bucket_radius*math.cos(toe_angle))
    bucket_points=[]
    for i in range(1,9):
        alpha=-toe_angle+(math.radians(32.0)+toe_angle)*i/8
        bucket_points.append((chute_x,bucket_center[0]-bucket_radius*math.sin(alpha),bucket_center[1]-bucket_radius*math.cos(alpha)))
    chute_points=chute_points+bucket_points
    lip=bucket_points[-1]
    jet_speed=20.0
    jet_points=[]
    for t in (0.5,1.0,1.5,2.0,2.4,2.78):
        jet_points.append((chute_x,lip[1]-jet_speed*math.cos(math.radians(32.0))*t,lip[2]+jet_speed*math.sin(math.radians(32.0))*t-4.9*t*t))
    jet_points.append((chute_x,-426.0,2.4))
    # Closed earth support below the chute connects to the right bank. Its
    # upper face lies below the concrete, never above the animated flow path.
    support_v,support_f,support_c=[],[],[]
    for i,(_,y,z) in enumerate(chute_points):
        top=z-2.6
        ring=[(279.0,y,top),(352.0,y,top),(390.0,y,terrain_height(390.0,y)),(390.0,y,-.8),(279.0,y,-.8)]
        support_v.extend(ring)
        support_c.extend([(.15,.155,.09),(.15,.16,.085),(.062,.13,.035),(.08,.10,.055),(.12,.135,.07)])
        if i:
            for j in range(5):
                a=(i-1)*5+j; b=(i-1)*5+(j+1)%5
                c=i*5+(j+1)%5; d=i*5+j
                support_f.append((a,d,c,b))
    support_f.extend([tuple(range(5)),tuple(reversed(range(len(support_v)-5,len(support_v))))])
    mesh_obj('Earth_Support_Below_Spillway',support_v,support_f,mat_ground,support_c,True)
    # A submerged, widening approach slab joins the reservoir to the gate
    # sill. Its closed retaining walls replace the former 40 m open void.
    forebay_sections=[(4.0,115.0,67.0),(40.0,111.5,86.0),(100.0,105.0,112.0)]
    approach_v,approach_f=[],[]
    for y,z,width in forebay_sections:
        approach_v.extend([(315-width/2,y,z),(315+width/2,y,z)])
    for i in range(len(forebay_sections)-1):
        approach_f.append((2*i,2*i+1,2*i+3,2*i+2))
    approach_count=len(approach_v)
    approach_v.extend([(x,y,z-2.4) for x,y,z in approach_v[:approach_count]])
    for face in approach_f[:]:
        approach_f.append(tuple(i+approach_count for i in reversed(face)))
    rim=[0,1,3,5,4,2]
    for i,a in enumerate(rim):
        b=rim[(i+1)%len(rim)]
        approach_f.append((a,a+approach_count,b+approach_count,b))
    mesh_obj('Spillway_Forebay_Closed_Floor',approach_v,approach_f,mat_concrete_light)

    def retaining_wall(name,points,thickness,mat):
        # Each section supplies centre x/y, bottom and top elevations.
        verts,faces=[],[]
        for i,(x,y,bottom,top) in enumerate(points):
            before=Vector(points[max(0,i-1)][:2]); after=Vector(points[min(len(points)-1,i+1)][:2])
            tangent=(after-before).normalized()
            side=Vector((-tangent.y,tangent.x))*thickness*.5
            verts.extend([(x-side.x,y-side.y,bottom),(x+side.x,y+side.y,bottom),
                          (x+side.x,y+side.y,top),(x-side.x,y-side.y,top)])
            if i:
                for k in range(4):
                    a=(i-1)*4+k; b=(i-1)*4+(k+1)%4
                    c=i*4+(k+1)%4; d=i*4+k
                    faces.append((a,b,c,d))
        faces.extend([tuple(reversed(range(4))),tuple(range(len(verts)-4,len(verts)))])
        return mesh_obj(name,verts,faces,mat)

    for side in [-1,1]:
        points=[]
        for y,z,width in forebay_sections:
            # The far end submerges into the open lake without a cross-wall.
            top=125.2 if y<41 else 111.0
            points.append((315+side*width*.5,y,z-2.4,top))
        retaining_wall('Spillway_Forebay_Wingwall_'+str(side),points,3.0,mat_concrete_light)
    # High lake water draws down after passing the gate; the original round
    # chute kerb was below that short transition and let the surface protrude.
    # Closed tapered returns contain the inlet then meet the lower chute wall.
    for side in [-1,1]:
        x=315+side*33.5
        retaining_wall('Gate_Chute_Returnwall_'+str(side),
                       [(x,4,112.6,125.2),(x,-28,108.6,114.8)],3.0,mat_concrete_light)
    # A short, closed left abutment joins the cap to the gate pier. Without
    # this saddle a wedge of the valley remains visible between both meshes.
    wing_v=[(260,-8,123.2),(282,-8,125.2),(282,20,125.2),(264,20,114.2),
            (260,-8,3),(282,-8,3),(282,20,3),(264,20,3)]
    wing_f=[(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    mesh_obj('Dam_Gate_Abutment_Closed_Saddle',wing_v,wing_f,mat_rock,[(.22,.224,.205)]*8)

    ribbon('Spillway_Chute',chute_points,67,mat_concrete_light,2)
    for edge in [-1,1]:
        retaining_wall('Spillway_Training_Wall_'+str(edge),[(x+edge*34.4,y,z-1.2,z+3.4) for x,y,z in chute_points[1:]],1.4,mat_concrete_light)
        box('Spillway_Training_Wall_Cap_'+str(edge),(chute_x+edge*34.4,-28,114.9),(1.8,2.0,.3),mat_concrete)
    for lane in range(1,5):
        ribbon('Chute_Expansion_Joint_%d'%lane,[(x-33.5+lane*13.4,y,z+.12) for x,y,z in chute_points],.2,mat_concrete_dark)
    for row in range(1,13):
        t=row/13
        y=-25-290*t
        z=111-(111-13)*t
        ribbon('Chute_Cross_Joint_%d'%row,[(282,y,z+.06),(348,y,z+.06)],.15,mat_concrete_dark)
    # 1.5: radial (Tainter) gates. A cylindrical skin plate faces the lake, two
    # radial arms per side carry it to a trunnion pin in the piers. Dimensions
    # are plausible for the bay width; they are not the real gate drawings.
    gate_trunnion_y, gate_trunnion_z, gate_radius = -9.0, 119.5, 12.5
    def radial_gate(bay, bay_x, theta0=-25.0, theta1=32.0, segments=16, width=10.0, thickness=0.36):
        half=width/2
        verts,faces=[],[]
        for i in range(segments+1):
            a=math.radians(theta0+(theta1-theta0)*i/segments)
            oy,oz=gate_trunnion_y+gate_radius*math.cos(a),gate_trunnion_z+gate_radius*math.sin(a)
            iy,iz=gate_trunnion_y+(gate_radius-thickness)*math.cos(a),gate_trunnion_z+(gate_radius-thickness)*math.sin(a)
            verts+=[(bay_x-half,oy,oz),(bay_x+half,oy,oz),(bay_x+half,iy,iz),(bay_x-half,iy,iz)]
        for i in range(segments):
            a=i*4; b=(i+1)*4
            faces+=[(a,b,b+1,a+1),(a+3,a+2,b+2,b+3),(a+1,b+1,b+2,a+2),(a,a+3,b+3,b)]
        n=len(verts)
        faces+=[(0,1,2,3),(n-4,n-1,n-2,n-3)]
        mesh_obj('Radial_Gate_Skin_%d'%bay,verts,faces,mat_teal,smooth=True)
        for k,theta in enumerate((-14.0,4.0,22.0)):
            a=math.radians(theta)
            y=gate_trunnion_y+(gate_radius-thickness-.2)*math.cos(a); z=gate_trunnion_z+(gate_radius-thickness-.2)*math.sin(a)
            tube('Radial_Gate_Rib_%d_%d'%(bay,k),[(bay_x-half+.1,y,z),(bay_x+half-.1,y,z)],.24,mat_teal,6)
        for side in (-1,1):
            ax=bay_x+side*4.3
            for theta in (-13.0,24.0):
                a=math.radians(theta)
                tube('Radial_Gate_Arm_%d_%d'%(bay,side),[(ax,gate_trunnion_y+(gate_radius-.6)*math.cos(a),gate_trunnion_z+(gate_radius-.6)*math.sin(a)),(ax,gate_trunnion_y+1.0,gate_trunnion_z)],.28,mat_teal,6)
            a0,a1=math.radians(-13.0),math.radians(24.0)
            tube('Radial_Gate_Arm_Brace_%d_%d'%(bay,side),[(ax,gate_trunnion_y+(gate_radius-.6)*math.cos(a0),gate_trunnion_z+(gate_radius-.6)*math.sin(a0)),(ax,gate_trunnion_y+(gate_radius-4.5)*math.cos(a1),gate_trunnion_z+(gate_radius-4.5)*math.sin(a1))],.14,mat_teal,5)
        tube('Radial_Gate_Trunnion_%d'%bay,[(bay_x-6.3,gate_trunnion_y,gate_trunnion_z),(bay_x+6.3,gate_trunnion_y,gate_trunnion_z)],.5,mat_steel,10)
        for side in (-1,1):
            box('Radial_Gate_Trunnion_Block_%d_%d'%(bay,side),(bay_x+side*5.9,gate_trunnion_y,gate_trunnion_z),(1.0,2.4,2.4),mat_concrete_light)
    for bay in range(5):
        x=288.2+bay*13.4
        box('Gate_Sill_Shadow_%d'%bay,(x,1.0,114.64),(10.4,6,.055),mat_dark)
        radial_gate(bay,x)
        box('Gate_Hoist',(x,0,134),(3,4.0,2.3),mat_teal,.2)
    for pier in range(6):
        x=281.5+13.4*pier
        box('Gate_Pier_%d'%pier,(x,-1.5,121.5),(2.6,23,20),mat_concrete_light,.22)
        cylinder('Gate_Pier_Nose_%d'%pier,(x,10.0,121.5),1.3,20,mat_concrete_light,16)
        box('Gate_Pier_Cap_%d'%pier,(x,-1.5,131.55),(2.9,23.3,.3),mat_concrete)
    box('Gate_Bridge',(315,1.5,132.5),(73,11,1.8),mat_concrete_light,.16)
    for y in (-4.2,7.2):
        tube('Gate_Bridge_Rail',[(279,y,134.4),(351,y,134.4)],.13,mat_teal,6)
        for x in range(280,352,6):
            box('Gate_Bridge_Rail_Post',(x,y,133.95),(.14,.14,1.1),mat_teal)
    for x in (288.2,315.0,341.8):
        tube('Gate_Bridge_Lamp',[(x,7.0,133.4),(x,7.0,139.0),(x,5.6,139.2)],.11,mat_concrete_light,6)
        box('Gate_Bridge_Lamp_Head',(x,5.6,139.2),(.7,1.6,.3),mat_teal)
    # Plunge pool below the bucket: deep floor, side walls, downstream sill.
    box('Plunge_Pool_Floor',(315,-398,-4.0),(82,60,4.0),mat_concrete)
    for x in [274,356]:
        box('Plunge_Pool_Wall',(x,-398,1.75),(3.0,62,11.5),mat_concrete,.25)
    # Concrete face under the bucket lip; the pool is wetted by the river reach.
    box('Bucket_Lip_Wall',(315,-367.4,3.2),(82,1.6,8.8),mat_concrete_light)
    box('Plunge_Pool_Sill',(315,-427,-0.4),(82,4.0,3.2),mat_concrete_light)
    for x in range(282,349,22):
        box('Plunge_Pool_Sill_Tooth',(x,-427,1.5),(3.0,4.2,1.0),mat_concrete)
    ribbon('Spillway_Crest_Connector',[(260,0,123.6),(276,3,128),(284,4,132.6)],12,mat_road,1)

    # Powerhouse, pale penstocks, tall windows and deep downstream outlet bays.
    box('Powerhouse_Platform',(-116.25,-330,8),(172.5,96,13),mat_concrete,.8)
    box('Powerhouse_Main',(-148,-328,24),(113,48,32),mat_concrete_light,.55)
    box('Powerhouse_Green_Roof',(-148,-328,40.7),(117,52,2.3),mat_roof,.20)
    box('Powerhouse_Annex',(-58,-321,17),(44,45,18),mat_concrete_light,.45)
    box('Annex_Roof',(-58,-321,26.8),(47,48,1.7),mat_roof,.12)
    for bay in range(9):
        x=-195+12*bay
        box('Powerhouse_Front_Window_%d'%bay,(x,-352.1,29.2),(7.8,.3,12.4),mat_glass,.10)
        for dz in [-3,3]:
            box('Window_Mullion',(x,-352.32,29.2+dz),(8.0,.24,.16),mat_line)
    # 1.5: two draft-tube outlets for two units, three piers, stoplog guides.
    for x in [-172,-134]:
        box('Turbine_Outlet_Shadow',(x,-377,8),(26,7,12),mat_dark,.4)
        for dx in (-13.4,13.4):
            box('Outlet_Stoplog_Guide',(x+dx,-381.6,10.5),(.6,1.2,15),mat_teal)
    for x in [-190,-153,-116]:
        box('Outlet_Pier',(x,-378,10),(4.0,11,18),mat_concrete_light,.15)
    # The three turbine bays discharge into one open collector apron. Its
    # downstream face remains open for the runtime tailrace surface.
    box('Powerhouse_Outlet_Collector_Apron',(-153,-390,4.3),(103,30,2.4),mat_concrete)
    for x in [-205,-101]:
        retaining_wall('Powerhouse_Collector_Sidewall_'+str(x),
                       [(x,-377,3.1,12),(x,-405,3.1,10)],2.8,mat_concrete_light)
    penstock_paths=[[(-214,-141,63),(-206,-201,44),(-186,-269,18),(-172,-309,17)],[(-196,-141,63),(-180,-201,44),(-150,-269,18),(-134,-309,17)]]
    for i,path in enumerate(penstock_paths):
        tube('Penstock_%d'%i,path,3.9,mat_concrete_light,14)
        for y_target in (-202,-244,-277):
            # support saddle under the pipe at the given y, interpolated along the path
            for (x0,y0,z0),(x1,y1,z1) in zip(path,path[1:]):
                if y0>=y_target>=y1:
                    t=(y0-y_target)/(y0-y1); x=x0+(x1-x0)*t; z=z0+(z1-z0)*t
                    box('Penstock_Support_%d'%i,(x,y_target,z-4.2),(8,4,6.5),mat_concrete)
                    break
    box('Turbine_Hall_Roof_Lights',(-153,-327,42.6),(44,15,2.2),mat_glass,.35)
    for x in [-187,-157,-127,-97]:
        box('Roof_Vent',(x,-313,43),(4,4,3),mat_concrete_light,.15)
    # 1.4: the access road continues on an embankment down to the switchyard
    # gate instead of ending 14 m above the valley floor.
    # 1.5: the yard ramp leaves the parking apron southwards at 9-14 % and reaches the
    # switchyard gate from the south; the earlier 25-30 % stub is gone.
    yard_ramp=[(20,-332,14.3),(24,-350,12.6),(30,-372,10.0),(36,-394,7.2),(46,-412,4.4),(62,-420,3.0),(80,-412,2.8),(90,-394,2.7),(92,-374,2.6),(92,-362,2.6)]
    embankment('Yard_Ramp_Embankment',yard_ramp,9.5)
    ribbon('Powerhouse_Access',yard_ramp,7.5,mat_road,.5)
    ribbon('Powerhouse_Platform_Road',[(10,-322,14.45),(-15,-320,14.55),(-56,-300,14.6),(-128,-291,14.6)],7.5,mat_road,.3)
    box('Powerhouse_Parking_Apron',(-8,-322,7.0),(62,20,14.6),mat_concrete)
    for x in range(-36,20,7):
        box('Parking_Marking',(x,-322,14.35),(.15,7,.025),mat_line)
    for i in range(5):
        x=-28+i*8
        box('Maintenance_Vehicle_%d'%i,(x,-321,15.6),(3.1,6.0,2.4),mat_teal if i%2 else mat_line,.5)

    # Cylindrical upstream intake and its narrow service bridge.
    cylinder('Intake_Tower',(-252,108,89),11,78,mat_concrete_light,24)
    cylinder('Intake_Tower_Cap',(-252,108,129),13.5,4,mat_teal,24)
    cylinder('Intake_Tower_Top',(-252,108,134),7.2,6,mat_concrete_light,16)
    ribbon('Intake_Service_Bridge',[(-264,8,124.2),(-259,55,128),(-252,108,131.0)],5.2,mat_concrete_light,.8)
    for side in [-1,1]:
        tube('Intake_Bridge_Rail',[(-264+side*2.6,8,125.6),(-259+side*2.6,55,129.4),(-252+side*2.6,108,132.4)],.13,mat_teal,6)

    # Left access road climbs past the powerhouse into the forest.
    # 1.5: the former winding road sat inside the hill. The crest road now ends at a
    # service building on the left abutment plateau instead.
    # The saddle plateau is ~125.6 m between x=-290 and -325; the hill rises to 137 m
    # by x=-358, so the pad sits on the plateau and the road climbs 2 m from the crest.
    ribbon('Crest_Left_Service_Road',[(-272,0,124.25),(-282,-.5,125.3),(-291,-1,126.3)],9.0,mat_road,3.5)
    box('Left_Service_Pad',(-306,-3,125.0),(32,24,2.6),mat_concrete_light,.1)
    box('Left_Service_Building',(-310,3,129.4),(14,9,6.2),mat_concrete_light,.15)
    box('Left_Service_Roof',(-310,3,132.75),(15.2,10.2,.5),mat_roof,.08)
    box('Left_Service_Glass',(-302.85,3,129.35),(.3,7.0,3.2),mat_glass)
    box('Left_Service_Door',(-302.85,-0.5,127.45),(.3,1.2,2.2),mat_dark)
    for k in range(4):
        box('Left_Service_Parking_%d'%k,(-297-k*3.0,-10,126.32),(.12,5.0,.03),mat_line)
    box('Left_Service_Car',(-298.5,-10,127.05),(2.0,4.4,1.5),mat_line,.3)
    tube('Left_Service_Flagpole',[(-314,-10,126.3),(-314,-10,135.0)],.09,mat_line,6)
    box('Left_Service_Flag',(-312.8,-10,134.3),(2.2,.06,1.3),mat_teal)
    tube('Left_Service_Lamp',[(-294,8,126.3),(-294,8,132.3),(-295.4,8,132.5)],.12,mat_concrete_light,6)
    box('Left_Service_Lamp_Head',(-295.4,8,132.5),(2.0,.7,.3),mat_teal)
    for x in range(-225,230,64):
        tube('Crest_Lamp',[(x,-5.0,125),(x,-5.0,132.2),(x+2.1,-5.0,132.5)],.13,mat_concrete_light,6)
        box('Lamp_Head',(x+2.0,-5.0,132.5),(2.2,.7,.35),mat_teal,.1)

    # ------------------------------------------------------------------
    # 1.4 detail pass. Presentation geometry only: no measured dimensions,
    # no selective-withdrawal design, no electrical or structural function.
    # ------------------------------------------------------------------

    # A. Intake tower: three illustrative withdrawal tiers (upper/middle/lower),
    # vertical gate guides, a staff gauge on the lake-facing side, and a hoist
    # portal on the cap. The tiers only illustrate the research idea of
    # choosing an intake depth; the operating model has no such variable yet.
    ix, iy = -252, 108
    for angle_deg in [90, 210, 330]:
        a = math.radians(angle_deg)
        ca, sa = math.cos(a), math.sin(a)
        for side in [-1, 1]:
            oriented_box('Intake_Gate_Guide_%d_%d' % (angle_deg, side),
                         (ix+11.35*ca-side*3.1*sa, iy+11.35*sa+side*3.1*ca, 104.0), (0.5, 0.9, 48.0), a, mat_teal)
        for tier, z in [('upper', 121.0), ('middle', 104.0), ('lower', 87.0)]:
            oriented_box('Intake_Opening_%s_%d' % (tier, angle_deg), (ix+10.6*ca, iy+10.6*sa, z), (1.0, 5.2, 5.0), a, mat_dark)
            for dz in [-2.75, 2.75]:
                oriented_box('Intake_Frame_%s_%d' % (tier, angle_deg), (ix+11.3*ca, iy+11.3*sa, z+dz), (0.6, 6.4, 0.5), a, mat_teal)
            for k in range(-2, 3):
                t = k*1.1
                oriented_box('Intake_Grille_%s_%d_%d' % (tier, angle_deg, k), (ix+11.25*ca-t*sa, iy+11.25*sa+t*ca, z), (0.35, 0.22, 5.0), a, mat_teal)
    gauge_angle = math.radians(135)
    for i in range(14):
        oriented_box('Intake_Staff_Gauge_%02d' % i,
                     (ix+11.2*math.cos(gauge_angle), iy+11.2*math.sin(gauge_angle), 113.5+i), (0.3, 1.2, 1.0),
                     gauge_angle, mat_line if i % 2 == 0 else mat_red)
    for dx in [-9.0, 9.0]:
        box('Intake_Hoist_Column', (ix+dx, iy, 136.5), (1.0, 1.0, 11.0), mat_teal)
    box('Intake_Hoist_Beam', (ix, iy, 142.6), (20.0, 1.3, 1.3), mat_teal, .1)
    box('Intake_Hoist_Trolley', (ix-3.0, iy, 141.4), (3.2, 2.2, 1.2), mat_steel)
    for dx in [-4.0, -2.0]:
        tube('Intake_Hoist_Cable', [(ix+dx, iy, 140.8), (ix+dx, iy, 137.2)], .07, mat_concrete_dark, 5)

    # B. Spillway gate gantries: a steel portal over each hoist with two wire
    # ropes to the gate leaf, plus crane rails on the gate bridge.
    for bay in range(5):
        x = 288.2+bay*13.4
        for dx in [-4.6, 4.6]:
            for dy in [-3.2, 3.2]:
                box('Gate_Gantry_Post_%d' % bay, (x+dx, dy, 137.5), (0.6, 0.6, 8.2), mat_teal)
            box('Gate_Gantry_Beam_Y_%d' % bay, (x+dx, 0, 141.8), (0.7, 7.1, 0.7), mat_teal)
        for dy in [-3.2, 3.2]:
            box('Gate_Gantry_Beam_X_%d' % bay, (x, dy, 141.8), (9.9, 0.7, 0.7), mat_teal)
        box('Gate_Hoist_House_%d' % bay, (x, 0, 143.5), (4.4, 5.2, 2.6), mat_teal, .15)
        for dx in [-2.6, 2.6]:
            tube('Gate_Wire_Rope_%d' % bay, [(x+dx, 1.4, 141.4), (x+dx, 1.4, 126.4)], .09, mat_concrete_dark, 5)
    for y in [-3.0, 6.0]:
        box('Gate_Crane_Rail', (315, y, 133.55), (73, 0.3, 0.25), mat_steel)

    # C. Switchyard downstream of the powerhouse (clear of the rockfill toe),
    # three pylons and sagging conductors heading down the valley and up the
    # right bank. Positions are illustrative; the real yard, line route and
    # voltages were not surveyed.
    yard_cx, yard_cy = 76.0, -330.0
    yard_x0, yard_x1 = yard_cx-36.0, yard_cx+36.0
    yard_y0, yard_y1 = yard_cy-26.0, yard_cy+26.0
    box('Switchyard_Pad', (yard_cx, yard_cy, 0.8), (72, 52, 3.6), mat_concrete)
    pad_top = 2.6
    for fx in range(int(yard_x0), int(yard_x1)+1, 4):
        for fy in (yard_y0, yard_y1):
            box('Switchyard_Fence_Post', (fx, fy, pad_top+1.2), (0.14, 0.14, 2.4), mat_steel)
    for fy in range(int(yard_y0)+4, int(yard_y1), 4):
        for fx in (yard_x0, yard_x1):
            box('Switchyard_Fence_Post', (fx, fy, pad_top+1.2), (0.14, 0.14, 2.4), mat_steel)
    for z in (pad_top+0.9, pad_top+2.3):
        tube('Switchyard_Fence_Rail', [(yard_x0, yard_y0, z), (yard_x1, yard_y0, z)], .035, mat_steel, 4)
        tube('Switchyard_Fence_Rail', [(yard_x0, yard_y1, z), (yard_x1, yard_y1, z)], .035, mat_steel, 4)
        tube('Switchyard_Fence_Rail', [(yard_x0, yard_y0, z), (yard_x0, yard_y1, z)], .035, mat_steel, 4)
        tube('Switchyard_Fence_Rail', [(yard_x1, yard_y0, z), (yard_x1, yard_y1, z)], .035, mat_steel, 4)
    phase_y = [yard_cy-8.0, yard_cy, yard_cy+8.0]
    for tx in [yard_cx-20.0, yard_cx, yard_cx+20.0]:
        box('Transformer_Tank_%d' % tx, (tx, yard_cy, pad_top+2.3), (6.4, 4.2, 4.6), mat_steel, .12)
        for sx in [-1, 1]:
            box('Transformer_Radiator_%d_%d' % (tx, sx), (tx+sx*3.35, yard_cy, pad_top+2.0), (0.5, 3.6, 3.8), mat_concrete_dark)
        tube('Transformer_Conservator_%d' % tx, [(tx, yard_cy-3.4, pad_top+6.0), (tx, yard_cy+3.4, pad_top+6.0)], .75, mat_steel, 10)
        for py in phase_y:
            cylinder('Transformer_Bushing_%d_%d' % (tx, py), (tx, py, pad_top+5.8), .22, 2.4, mat_line, 8)
            tube('Transformer_Jumper_%d_%d' % (tx, py), [(tx, py, 12.6), (tx, py, pad_top+7.0)], .06, mat_concrete_dark, 4)
    portal_insulators = {}
    for px in [yard_x0+2.0, yard_x1-2.0]:
        for py in (yard_cy-14.0, yard_cy+14.0):
            box('Switchyard_Portal_Post', (px, py, pad_top+6.0), (0.6, 0.6, 12.0), mat_steel)
        box('Switchyard_Portal_Beam', (px, yard_cy, pad_top+12.0), (0.6, 29.2, 0.6), mat_steel)
        for py in phase_y:
            tube('Switchyard_Portal_Insulator', [(px, py, pad_top+11.7), (px, py, 12.6)], .17, mat_line, 6)
            portal_insulators[(px, py)] = (px, py, 12.6)
    west_portal, east_portal = yard_x0+2.0, yard_x1-2.0
    for py in phase_y:
        tube('Switchyard_Bus_%d' % py, [(west_portal, py, 12.6), (east_portal, py, 12.6)], .09, mat_concrete_dark, 5)
    box('Switchyard_Control_Building', (yard_x0+12.0, yard_y1-10.0, pad_top+2.1), (12, 7, 4.2), mat_concrete_light, .1)
    box('Switchyard_Control_Roof', (yard_x0+12.0, yard_y1-10.0, pad_top+4.45), (12.6, 7.6, 0.5), mat_roof)
    for wx in [yard_x0+8.5, yard_x0+12.0, yard_x0+15.5]:
        box('Switchyard_Control_Window', (wx, yard_y1-6.45, pad_top+2.4), (1.6, 0.1, 1.3), mat_glass)
    # 1.5: generator leads run in a covered cable duct from the annex to the yard
    # (the former overhead feeders sagged through the access ramp).
    box('Powerhouse_Cable_Duct_Top', (-6.0, -314, 14.65), (60.0, 2.4, .5), mat_concrete_light)
    box('Powerhouse_Cable_Duct_Drop', (23.6, -314, 8.6), (1.2, 2.4, 12.0), mat_concrete_light)
    box('Powerhouse_Cable_Duct_Yard', (31.0, -314, 2.85), (14.0, 2.4, .5), mat_concrete_light)
    box('Powerhouse_Cable_Duct_Yard_Turn', (38.0, -324, 2.85), (2.4, 22.0, .5), mat_concrete_light)
    for py in phase_y:
        cylinder('Cable_Termination_%d' % py, (west_portal+2.2, py, pad_top+1.6), .28, 3.2, mat_line, 8)
        tube('Cable_Termination_Jumper_%d' % py, [(west_portal+2.2, py, pad_top+3.2), (west_portal, py, 12.6)], .07, mat_concrete_dark, 4)
    # Outgoing line: east portal -> pylon 1 (valley) -> pylon 2 (below the basin, east of the river) -> pylon 3 (right-bank hill).
    pylon_sites = [(170, -345, -0.6), (330, -470, -0.6), (470, -560, terrain_height(470, -560)-1.0)]
    attachments = []
    for index, (tx, ty, tz) in enumerate(pylon_sites):
        nxt = pylon_sites[min(index+1, len(pylon_sites)-1)]
        prev = pylon_sites[max(index-1, 0)]
        direction = Vector((nxt[0]-prev[0], nxt[1]-prev[1], 0))
        yaw = math.atan2(direction.y, direction.x) if direction.length > 1e-6 else 0.0
        attachments.append(lattice_tower('Pylon_%d' % (index+1), tx, ty, tz, yaw=yaw))
    for py, point in zip(phase_y, attachments[0]):
        sagging_line('Line_Yard_To_Pylon1_%d' % py, portal_insulators[(east_portal, py)], point, .11)
    for index in range(len(attachments)-1):
        for phase, (p, q) in enumerate(zip(attachments[index], attachments[index+1])):
            sagging_line('Line_Pylon%d_%d_%d' % (index+1, index+2, phase), p, q, .12)

    # D. Downstream road bridge over the river, approach embankments, a small
    # gauging-station hut and a staff gauge. The river water, banks and the
    # valley apron below are generated by the browser; piers extend below them.
    bridge_y = -600.0
    bridge_x0, bridge_x1 = 125.6, 343.0
    bridge_cx = (bridge_x0+bridge_x1)/2
    bridge_len = bridge_x1-bridge_x0
    deck_top = 15.05
    box('Bridge_Deck', (bridge_cx, bridge_y, 14.3), (bridge_len, 9.0, 1.5), mat_concrete_light, .15)
    box('Bridge_Asphalt', (bridge_cx, bridge_y, deck_top+0.06), (bridge_len-2, 7.2, 0.12), mat_road)
    box('Bridge_Centreline', (bridge_cx, bridge_y, deck_top+0.13), (bridge_len-4, 0.25, 0.02), mat_line)
    for sy in [-1, 1]:
        box('Bridge_Kerb', (bridge_cx, bridge_y+sy*3.95, deck_top+0.25), (bridge_len, 0.5, 0.38), mat_concrete_light)
        for k in range(int(bridge_len//6)+1):
            px = bridge_x0+1.0+k*6.0
            if px > bridge_x1-1.0:
                break
            box('Bridge_Rail_Post', (px, bridge_y+sy*4.1, deck_top+0.95), (0.14, 0.14, 1.1), mat_line)
        for z in (deck_top+0.95, deck_top+1.45):
            tube('Bridge_Rail', [(bridge_x0+0.8, bridge_y+sy*4.1, z), (bridge_x1-0.8, bridge_y+sy*4.1, z)], .06, mat_line, 4)
    for px in [160, 196, 239, 282, 318]:
        box('Bridge_Pier_%d' % px, (px, bridge_y, 6.6), (2.8, 7.5, 16.2), mat_concrete)
        box('Bridge_Pier_Cap_%d' % px, (px, bridge_y, 13.3), (3.8, 8.8, 1.0), mat_concrete_light)
    for px in [bridge_x0-2.4, bridge_x1+2.4]:
        box('Bridge_Abutment', (px, bridge_y, 6.4), (6.0, 10.5, 16.0), mat_concrete)
    # 1.5: approach embankments have 1.5:1 side slopes instead of vertical 17 m faces.
    left_approach = [(bridge_x0, bridge_y, deck_top), (100, -600, 11.5), (70, -600, 7.2), (40, -600, 3.8), (10, -596, 2.7), (-8, -584, 2.5), (-14, -560, 2.6), (-14, -530, 3.4), (-14, -498, 7.2), (-14, -462, 11.0)]
    embankment('Bridge_Left_Approach_Embankment', left_approach, 10.5)
    ribbon('Bridge_Left_Approach', left_approach, 8.5, mat_road, .5)
    # Tailrace bridge: the valley road crosses the powerhouse tailrace on a short deck.
    # The deck clears the browser-generated bank crests (water + 3.8 m) under it.
    tb_x = -14.0
    box('Tailrace_Bridge_Deck', (tb_x, -430, 10.4), (10.0, 64, 1.2), mat_road, .1)
    for y in (-452, -409):
        box('Tailrace_Bridge_Pier_%d' % y, (tb_x, y, 3.3), (2.6, 7.0, 13.4), mat_concrete)
    for y in (-464, -396):
        box('Tailrace_Bridge_Abutment_%d' % y, (tb_x, y, 4.6), (12.0, 4.0, 12.8), mat_concrete)
    for sx in (-1, 1):
        for y in range(-460, -399, 6):
            box('Tailrace_Bridge_Rail_Post', (tb_x+sx*4.6, y, 11.55), (.14, .14, 1.1), mat_line)
        tube('Tailrace_Bridge_Rail', [(tb_x+sx*4.6, -461, 12.05), (tb_x+sx*4.6, -399, 12.05)], .06, mat_line, 4)
    valley_link = [(tb_x, -398, 11.0), (-10, -376, 12.2), (-2, -352, 13.5), (2, -330, 14.35)]
    embankment('Powerhouse_Valley_Link_Embankment', valley_link, 10.5)
    ribbon('Powerhouse_Valley_Link', valley_link, 8.5, mat_road, .5)
    # Right bank: the road follows the sloping shore closure northwards above
    # the stilling basin and ends at a small overlook with a turnaround.
    def closure_height(x, y):
        top = terrain_height(390.0, y)
        foot = min(top-1.5, 84.0) if y > 30 else -0.8
        t = (390.0-x)/76.0
        ease = t*t*(3-2*t)
        return top*(1-ease)+foot*ease
    right_road = []
    for (rx, ry) in [(bridge_x1, bridge_y), (346.5, -586), (349, -565), (350, -540), (350, -500), (351, -462), (352, -432)]:
        right_road.append((rx, ry, max(deck_top, closure_height(rx, ry)+0.35) if ry == bridge_y else closure_height(rx, ry)+0.35))
    ribbon('Bridge_Right_Hillside_Road', right_road, 7.0, mat_road, 9.0)
    box('Hillside_Overlook_Pad', (352, -424, right_road[-1][2]-1.0), (15, 15, 2.4), mat_road)
    for side in [-1, 1]:
        tube('Hillside_Road_Guardrail', [(x+side*3.7, y, z+0.8) for x, y, z in right_road], .07, mat_line, 4)
    box('Gauging_Station_Hut', (150, -579, 5.6), (4.2, 4.2, 3.2), mat_line, .05)
    box('Gauging_Station_Roof', (150, -579, 7.4), (4.8, 4.8, 0.4), mat_concrete_dark)
    box('Gauging_Station_Door', (150, -581.12, 5.0), (0.9, 0.08, 2.0), mat_dark)
    box('Gauging_Station_Panel', (150, -579, 7.7), (1.6, 1.0, 0.08), mat_glass)
    tube('Gauging_Station_Mast', [(151.6, -577.6, 7.5), (151.6, -577.6, 12.2)], .05, mat_steel, 4)
    for i in range(7):
        box('River_Staff_Gauge_%d' % i, (181.5, -590, 0.5+i), (0.5, 0.3, 1.0), mat_line if i % 2 == 0 else mat_red)

    # E. Right-abutment viewing plaza linked to the gate bridge by a ramp:
    # paved terrace, small visitor building, railing, flagpoles, a marker
    # stone, parking bays and lamps. All illustrative.
    plaza_top = 126.2
    box('Plaza_Terrace', (448, 3, 122.85), (60, 34, 6.7), mat_concrete_light, .12)
    ribbon('Plaza_Link_Ramp', [(351.5, 1.5, 133.4), (372, 1.5, 131.6), (396, 1.5, 128.6), (418.5, 1.5, plaza_top+0.05)], 10, mat_road, 10.0)
    for side in [-1, 1]:
        tube('Plaza_Ramp_Rail', [(x, 1.5+side*5.2, z+1.1) for x, _, z in [(351.5, 0, 133.4), (372, 0, 131.6), (396, 0, 128.6), (418.5, 0, plaza_top+0.05)]], .09, mat_line, 5)
    box('Plaza_Visitor_Building', (462, 10, plaza_top+3.25), (20, 11, 6.5), mat_concrete_light, .15)
    box('Plaza_Visitor_Roof', (462, 10, plaza_top+6.75), (21.2, 12.2, 0.5), mat_roof, .08)
    box('Plaza_Visitor_Glass_Front', (451.85, 10, plaza_top+3.2), (0.3, 9.0, 3.6), mat_glass)
    for wy in [6.0, 10.0, 14.0]:
        box('Plaza_Visitor_Side_Window', (472.15, wy, plaza_top+3.4), (0.3, 2.2, 1.6), mat_glass)
    box('Plaza_Visitor_Door', (451.85, 5.2, plaza_top+1.1), (0.3, 1.2, 2.2), mat_dark)
    for ry in range(-13, 21, 3):
        box('Plaza_Rail_Post', (418.4, ry, plaza_top+0.55), (0.14, 0.14, 1.1), mat_line)
    for rx in range(419, 478, 3):
        box('Plaza_Rail_Post', (rx, -13.6, plaza_top+0.55), (0.14, 0.14, 1.1), mat_line)
    for z in (plaza_top+0.55, plaza_top+1.05):
        tube('Plaza_Rail', [(418.4, -13.6, z), (418.4, 20, z)], .06, mat_line, 4)
        tube('Plaza_Rail', [(418.4, -13.6, z), (478, -13.6, z)], .06, mat_line, 4)
    for i, fy in enumerate([-10, -6, -2]):
        tube('Plaza_Flagpole_%d' % i, [(426, fy, plaza_top), (426, fy, plaza_top+10.0)], .09, mat_line, 6)
        box('Plaza_Flag_%d' % i, (427.2, fy, plaza_top+9.3), (2.2, 0.06, 1.3), mat_teal if i != 1 else mat_line)
    box('Plaza_Marker_Stone', (432, 8, plaza_top+1.5), (2.2, 1.0, 3.0), mat_concrete_dark, .1)
    box('Plaza_Marker_Plaque', (430.85, 8, plaza_top+1.7), (0.1, 1.3, 0.8), mat_line)
    for k in range(7):
        box('Plaza_Parking_Marking_%d' % k, (452+k*3.0, -8, plaza_top+0.015), (0.12, 5.0, 0.03), mat_line)
    for k, vx in enumerate([453.5, 459.5, 465.5]):
        box('Plaza_Visitor_Car_%d' % k, (vx, -8, plaza_top+0.75), (2.0, 4.4, 1.5), mat_line if k == 1 else mat_teal, .3)
    for lx in [424, 445, 470]:
        tube('Plaza_Lamp', [(lx, 18.5, plaza_top), (lx, 18.5, plaza_top+6.5), (lx, 17.0, plaza_top+6.7)], .12, mat_concrete_light, 6)
        box('Plaza_Lamp_Head', (lx, 17.0, plaza_top+6.7), (0.7, 2.0, 0.35), mat_teal, .08)

    # Joined mixed deciduous forest. Three smaller irregular leaf masses replace
    # each single spherical crown. Leaf maps and species/height variation break
    # the smooth toy-like silhouettes, while keeping web geometry bounded.
    leaf_v,leaf_f,leaf_c=[],[],[]
    bark_v,bark_f=[],[]
    segments=6
    template_v=[(0,0,-1)]
    for ring in range(1,4):
        latitude=-math.pi/2+ring*math.pi/4
        for j in range(segments):
            angle=j*math.tau/segments
            template_v.append((math.cos(latitude)*math.cos(angle),math.cos(latitude)*math.sin(angle),math.sin(latitude)))
    template_v.append((0,0,1))
    template_f=[]
    for j in range(segments):
        template_f.append((0,1+(j+1)%segments,1+j))
        for ring in range(2):
            a=1+ring*segments+j; b=1+ring*segments+(j+1)%segments
            template_f.extend([(a,b,a+segments),(b,b+segments,a+segments)])
        template_f.append((1+3*segments,1+2*segments+j,1+2*segments+(j+1)%segments))

    def crown(x,y,z,radius,height,base_color):
        base=len(leaf_v)
        angle=rng.random()*math.tau
        ca,sa=math.cos(angle),math.sin(angle)
        for u,v,w in template_v:
            jitter=rng.uniform(.79,1.16)
            leaf_v.append((x+(u*ca-v*sa)*radius*jitter,y+(u*sa+v*ca)*radius*jitter,z+w*height*jitter))
            light=.75+.25*(w+1)/2+rng.uniform(-.08,.08)
            leaf_c.append(tuple(max(.015,min(.8,c*light)) for c in base_color))
        leaf_f.extend(tuple(base+i for i in face) for face in template_f)

    forest_count=0
    trials=0
    while forest_count<5400 and trials<50000:
        trials+=1
        patch=terrain_patches[rng.choices([0,1,2],[.40,.40,.20])[0]]
        xmin,xmax,ymin,ymax,*_=patch
        x=rng.uniform(xmin+7,xmax-7); y=rng.uniform(ymin+7,ymax-7)
        z=terrain_height(x,y)
        if z<35 or (abs(x+320)<40 and -350<y<40) or (-570<x<700 and -4<y<1300 and z<124.2):
            continue
        # 1.4: keep the viewing plaza and the pylon footprints clear of crowns.
        if (412<x<484 and -18<y<26) or any(math.hypot(x-px,y-py)<13 for px,py,_ in pylon_sites):
            continue
        height=rng.uniform(11,23)
        radius=rng.uniform(5.6,10.8)
        warm=rng.random()
        base_color=(.071+.058*warm,.126+.075*warm,.041+.040*warm)
        crown(x,y,z+height*.72,radius*.76,height*.33,base_color)
        lobe_angle=rng.random()*math.tau
        lobes=2 if rng.random()<.82 else 1
        for lobe in range(lobes):
            a=lobe_angle+lobe*2.7
            crown(x+math.cos(a)*radius*.63,y+math.sin(a)*radius*.63,z+height*rng.uniform(.45,.65),radius*rng.uniform(.62,.80),height*.27,base_color)
        base=len(bark_v)
        r=.22+height*.012
        for dz in [0,height*.48]:
            bark_v.extend([(x-r,y-r,z+dz),(x+r,y-r,z+dz),(x+r,y+r,z+dz),(x-r,y+r,z+dz)])
        bark_f.extend(tuple(base+k for k in face) for face in [(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
        forest_count+=1
    mesh_obj('Joined_Forest_Canopies',leaf_v,leaf_f,mat_forest,leaf_c,True)
    mesh_obj('Joined_Forest_Trunks',bark_v,bark_f,mat_bark,smooth=True)

    # Manifests use exported Y-up coordinates, never raw Blender Z-up values.
    def yup(p):
        return [round(p[0],4),round(p[2],4),round(-p[1],4)]
    river_points=[(315,-372,2.3),(315,-428,2.3),(300,-446,2.2),(270,-465,2.1),(212,-555,2.0),(230,-700,1.6),(295,-850,1.0)]
    river_widths=[79,79,70,68,68,68,68]
    turbine_points=[(-153,-379,8),(-153,-401,7.6),(-90,-410,6.6),(20,-440,4.8),(180,-469,3.4),(270,-465,2.1)]
    for name, points, width in [('River',river_points,68),('Turbine_Tailrace',turbine_points,34)]:
        water=ribbon('Preview_'+name,points,width,mat_water)
        model.objects.unlink(water); preview.objects.link(water); model_objects.remove(water)
    cameras_blender={
        'overview':((650,-800,500),(10,-55,75)),
        'upstream':((-665,615,433),(28,30,94)),
        'spillway':((524,-476,272),(312,-135,67)),
        'downstream':((223,-840,195),(37,-125,75)),
        'top':((45,-130,1450),(45,-130,0)),
        'inlet':((454,183,186),(309,20,119)),
        'shoreline':((689,846,250),(410,620,119)),
        'plaza':((474,-6,134.5),(250,40,122)),
        'powerhouse':((-20,-560,120),(-150,-345,22)),
        'bucket':((430,-500,74),(308,-398,6)),
    }
    manifest={
        'model':'twin-dam.glb',
        'assetRevision':tag,
        'name':'소양강댐 외형 참고 모델',
        'version':4,
        'powerhouseUnits':2,
        'description':'Original visual approximation; synthetic operating data; no surveyed bathymetry or CFD.',
        'reservoir':{'center':[65,118.5,-648],'size':[1270,1304],'minY':reservoir_min_z,'maxY':reservoir_max_z,'polygon':[[x,-y] for x,y in reservoir_polygon],'depthM':45,'hydraulicAssumptions':True,'boundaryMode':'under-terrain; visible shoreline is terrain intersection','maxWaveDisplacementM':.45,'displayLevelNote':'Compressed illustrative elevations; operating water levels stay unchanged'},
        'river':{'points':[yup(p) for p in river_points],'width':68,'widths':river_widths,'roughnessN':.035,'hydraulicAssumptions':True},
        'channels':[
            {'name':'spillway-visual','kind':'spill','interpolation':'linear','width':61,'widths':[67]+[61]*(len(chute_points)-1)+[61]*(len(jet_points)-2)+[66,70],'points':[yup((x,y,z+.34)) for x,y,z in chute_points+jet_points],'bedPoints':[yup(p) for p in chute_points+jet_points],'bedOffsetM':-.34,'roughnessN':.016,'hydraulicAssumptions':True,'freeJetFrom':len(chute_points)-1},
            {'name':'powerhouse-tailrace-visual','kind':'turbine','width':30,'widths':[100,92,30,30,30,30],'points':[yup(p) for p in turbine_points],'roughnessN':.028,'hydraulicAssumptions':True},
        ],
        'cameras':{key:{'position':yup(position),'target':yup(target)} for key,(position,target) in cameras_blender.items()},
        'shadowRadius':850,
        'boundaryContract':{
            'coordinateSystem':'exported Y-up; reservoir polygon is [x,z]',
            'renderLevelRangeM':[reservoir_min_z,reservoir_max_z],
            'frontBoundaryBlenderY':-4,
            'frontSeals':['rockfill body','closed abutment saddles','gate piers and forebay'],
            'shorelineEdges':'All polygon sides except front must overlap terrain above 122 m including waves',
            'forebayFloorPoints':[yup((315,y,z)) for y,z,width in forebay_sections],
            'unmeasuredIllustrativeGeometry':True,
        },
        'referenceDimensions':{'crestLengthM':530,'damHeightM':123,'status':'visual reference only; operating config remains synthetic'},
        'hydraulicAssumptions':{'status':'uncalibrated visual assumptions only','reservoirDepthM':45,'roughness':'Manning n estimates; no measured channel survey or hydraulic calibration'},
        'materials':{'source':'original procedural PBR maps; no external media','uvScale':'metres','maps':['base color','tangent normal','roughness'],'foliage':'5400 multi-lobed irregular broadleaf trees'},
        'detailPass':{'version':'1.5','items':['radial gates with trunnion arms, pier noses, bridge rails and lamps','flip bucket, free jet, plunge pool, training walls','two generating units','terrain 2x resolution with high-slope detail','left-abutment service building on the saddle plateau','valley road on sloped embankments, tailrace bridge with abutments, 5-14 % ramps','cable duct instead of sagging feeders','intake tower withdrawal tiers, gate guides, staff gauge, hoist portal','spillway gate gantries, wire ropes, crane rails','switchyard, three pylons, conductors','downstream road bridge, approach roads, gauging hut, river staff gauge','right-abutment viewing plaza, link ramp, visitor building'],'status':'illustrative; not surveyed; no operating or electrical meaning'},
    }

    # Only the newly created scene receives light, camera, renderer settings.
    world=bpy.data.worlds.new(tag+'_World')
    if world.node_tree is None and hasattr(world, 'use_nodes'):
        world.use_nodes=True
    if world.node_tree is None:
        raise RuntimeError('World node tree was not created.')
    scene.world=world
    background=next((n for n in world.node_tree.nodes if n.type=='BACKGROUND'),None)
    if background:
        color_input=socket(background,'Color'); strength_input=socket(background,'Strength')
        if color_input: color_input.default_value=(.58,.72,.84,1)
        if strength_input: strength_input.default_value=.7
    light_data=bpy.data.lights.new(tag+'_Sun',type='SUN')
    light_data.energy=3.0; light_data.angle=math.radians(14)
    sun=bpy.data.objects.new(tag+'_Sun',light_data); preview.objects.link(sun)
    sun.rotation_euler=(math.radians(27),math.radians(-21),math.radians(-29))
    cam_data=bpy.data.cameras.new(tag+'_Camera')
    camera=bpy.data.objects.new(tag+'_Camera',cam_data); preview.objects.link(camera)
    position,target=cameras_blender['overview']
    camera.location=position
    camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler()
    cam_data.lens=45; cam_data.clip_end=7500; scene.camera=camera
    scene.render.resolution_x=1600; scene.render.resolution_y=1050; scene.render.resolution_percentage=100
    scene.render.engine=enum_value(scene.render.bl_rna.properties['engine'],['BLENDER_EEVEE_NEXT','BLENDER_EEVEE','CYCLES'])
    if hasattr(scene,'cycles'): scene.cycles.samples=32
    try:
        scene.view_settings.view_transform=enum_value(scene.view_settings.bl_rna.properties['view_transform'],['AgX','Filmic','Standard'])
    except RuntimeError:
        pass
    scene.render.image_settings.file_format=enum_value(scene.render.image_settings.bl_rna.properties['file_format'],['PNG'])
    scene.render.film_transparent=False
    scene.render.filepath=str(output/'preview.png')
    scene['twin_visual_approximation']=True
    scene['twin_reference']='Soyang Dam public appearance; dimensions 530m crest / 123m height are visual references only.'
    scene['twin_operating_data']='synthetic; independent of visual model dimensions'
    scene['twin_maker']='TWIN local procedural model generator; original reference-based geometry'
    triangle_estimate=sum(max(0,len(poly.vertices)-2) for obj in model_objects for poly in obj.data.polygons)
    if triangle_estimate>1000000:
        raise RuntimeError('Model exceeds requested pre-modifier triangle budget: %d'%triangle_estimate)

    try:
        if bpy.context.window:
            bpy.context.window.scene=scene
        with bpy.context.temp_override(scene=scene,view_layer=scene.view_layers[0]):
            for obj in scene.objects:
                obj.select_set(False)
            for obj in model_objects:
                obj.select_set(True)
            scene.view_layers[0].objects.active=model_objects[0]
            props=bpy.ops.export_scene.gltf.get_rna_type().properties
            kwargs={'filepath':str(output/'twin-dam.glb')}
            # All optional exporter flags are checked against this installation.
            for key,value in [('use_selection',True),('use_active_scene',True),('export_yup',True),('export_apply',True),('export_cameras',False),('export_lights',False),('export_texcoords',True),('export_normals',True),('export_materials','EXPORT'),('export_vertex_color','MATERIAL'),('export_all_vertex_colors',False),('export_image_format','AUTO')]:
                if key in props:
                    if props[key].type=='ENUM':
                        try: value=enum_value(props[key],[value])
                        except RuntimeError: continue
                    kwargs[key]=value
            kwargs['export_format']=enum_value(props['export_format'],['GLB'])
            bpy.ops.export_scene.gltf(**kwargs)
            (output/'twin-dam.scene.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            bpy.data.libraries.write(str(output/'twin-dam.blend'),{scene},fake_user=True,compress=True)
            if render_preview:
                bpy.ops.render.render(write_still=True,scene=scene.name)
    finally:
        if old_scene and bpy.context.window:
            bpy.context.window.scene=old_scene
    size=(output/'twin-dam.glb').stat().st_size
    receipt={
        'scene':scene.name,'forestTrees':forest_count,'estimatedTrianglesBeforeModifiers':triangle_estimate,
        'glbBytes':size,'under40MiB':size<40*1024*1024,
        'pbrTextureSets':list(texture_metadata),'texturesEmbedded':True,
        'files':['twin-dam.glb','twin-dam.blend','twin-dam.scene.json'] + (['preview.png'] if render_preview else []),
        'scope':'visual approximation only; no CFD; no measured operations',
    }
    (output/'build-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(receipt,ensure_ascii=False))
    return receipt


if __name__ == '__main__':
    # Explicit script execution requires an output path; importing is inert.
    import sys
    trailing=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    if len(trailing)!=1:
        raise SystemExit('Explicit output directory required after --. This backup is not auto-executed.')
    build(trailing[0])
