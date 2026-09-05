"""Local Blender authoring. Run main(repo, rig) through Blender MCP.

The shipped deform armature, skin indices and bind pose are never edited.
A separate anatomical control rig solves hands/feet; sampled motion is baked
onto a copy of the original 62-bone rig. pack-blender-animation.mjs converts
Blender joint axes back to the original glTF axes, with an explicit bind map.
"""
import bpy
import json
import math
from pathlib import Path
from mathutils import Matrix, Vector

FPS = 30
END = 120


def flat(matrix):
    return [float(matrix[r][c]) for r in range(4) for c in range(4)]


def main(repo, rig):
    repo = Path(repo)
    out = repo / 'assets/vendor/authoring'
    out.mkdir(parents=True, exist_ok=True)
    # Preserve any open local work before creating an isolated authoring scene.
    bpy.ops.wm.save_as_mainfile(filepath=str(out / f'pre-authoring-{rig}.blend'))
    scene = bpy.data.scenes.new(f'StreamPolis Social Dance {rig}')
    bpy.context.window.scene = scene
    scene.render.fps = FPS
    scene.frame_start = 0
    scene.frame_end = END
    actions_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(out / f'{rig}.glb'))
    source = next(o for o in scene.objects if o.type == 'ARMATURE')
    original = {b.name: flat(b.matrix_local) for b in source.data.bones}
    names = list(original)
    assert len(names) == 62
    for track in list(source.animation_data.nla_tracks):
        source.animation_data.nla_tracks.remove(track)
    # The matching package's relaxed idle establishes gender-specific posture.
    idle = next(a for a in bpy.data.actions if a not in actions_before and a.name.split('.')[0].endswith('|Idle'))
    source.animation_data.action = idle
    scene.frame_set(0)
    bpy.context.view_layer.update()
    idle_world = {b.name: source.matrix_world @ b.matrix.copy() for b in source.pose.bones}
    bind_world = {b.name: source.matrix_world @ b.matrix_local for b in source.data.bones}
    source.animation_data_clear()

    data = bpy.data.armatures.new(f'AuthorControls_{rig}')
    control = bpy.data.objects.new(f'AuthorControls_{rig}', data)
    scene.collection.objects.link(control)
    bpy.context.view_layer.objects.active = control
    control.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    chain_end = {'UpperArm.L': 'LowerArm.L', 'LowerArm.L': 'Wrist.L',
                 'UpperArm.R': 'LowerArm.R', 'LowerArm.R': 'Wrist.R',
                 'UpperLeg.L': 'LowerLeg.L', 'LowerLeg.L': 'Foot.L',
                 'UpperLeg.R': 'LowerLeg.R', 'LowerLeg.R': 'Foot.R'}
    for name in names:
        bone = data.edit_bones.new(name)
        bone.head = idle_world[name].translation
        children = list(source.data.bones[name].children)
        end = chain_end.get(name)
        if end:
            bone.tail = idle_world[end].translation
        elif children and (idle_world[children[0].name].translation - bone.head).length > .012:
            bone.tail = idle_world[children[0].name].translation
        else:
            bone.tail = bone.head + Vector((0, 0, .045))
        if (bone.tail - bone.head).length < .001:
            bone.tail = bone.head + Vector((0, 0, .045))
        bone.use_deform = False
    for name in names:
        parent = source.data.bones[name].parent
        if parent:
            data.edit_bones[name].parent = data.edit_bones[parent.name]
    # Foot controls are independent on the shipped rig. Anatomical helpers can
    # have a connected leg chain without changing any shipped parent or bind.
    for side in ['L', 'R']:
        data.edit_bones[f'Foot.{side}'].parent = data.edit_bones[f'LowerLeg.{side}']
    bpy.ops.object.mode_set(mode='OBJECT')
    offsets = {name: data.bones[name].matrix_local.inverted() @ idle_world[name] for name in names}
    targets = {}
    for side in ['L', 'R']:
        sign = 1 if side == 'L' else -1
        for label, bone_name in [('Hand', f'Wrist.{side}'), ('Foot', f'Foot.{side}')]:
            target = bpy.data.objects.new(f'IK_{label}_{side}', None)
            scene.collection.objects.link(target)
            target.empty_display_type = 'SPHERE'
            target.empty_display_size = .06
            target.location = idle_world[bone_name].translation
            targets[(label, side)] = target
            driven = control.pose.bones[f'LowerArm.{side}' if label == 'Hand' else f'LowerLeg.{side}']
            constraint = driven.constraints.new('IK')
            constraint.name = f'Authoring IK {label} {side}'
            constraint.target = target
            constraint.chain_count = 2
            constraint.use_stretch = False
            driven.ik_stretch = 0
            control.pose.bones[f'UpperArm.{side}' if label == 'Hand' else f'UpperLeg.{side}'].ik_stretch = 0
    bases = {key: ob.location.copy() for key, ob in targets.items()}
    # A gentle four-second side-to-side groove. Author controls describe arcs
    # in metres; Blender solves all joint rotations and foot placement.
    body = control.pose.bones['Body']
    torso = control.pose.bones['Chest']
    head = control.pose.bones['Head']
    for frame in range(0, END + 1, 5):
        t = frame / FPS
        phase = 2 * math.pi * t / 4
        sway = .045 * math.sin(phase)
        dip = -.045 - .012 * (1 - math.cos(phase * 4))
        body.location = data.bones['Body'].matrix_local.to_3x3().inverted() @ Vector((sway, 0, dip))
        body.keyframe_insert('location', frame=frame)
        for pb, amplitude in [(torso, .055), (head, -.04)]:
            pb.rotation_mode = 'QUATERNION'
            local_axis = data.bones[pb.name].matrix_local.to_3x3().inverted() @ Vector((0, 0, 1))
            from mathutils import Quaternion
            pb.rotation_quaternion = Quaternion(local_axis, amplitude * math.sin(phase))
            pb.keyframe_insert('rotation_quaternion', frame=frame)
        for side in ['L', 'R']:
            sign = 1 if side == 'L' else -1
            hand = targets[('Hand', side)]
            hand.location = bases[('Hand', side)] + Vector((sway * .6 + sign * .025 * math.sin(phase * 2), -.06 + .025 * math.cos(phase * 2 + sign*.4), .035 + .045 * math.sin(phase * 2 + sign*.5)))
            hand.keyframe_insert('location', frame=frame)
            foot = targets[('Foot', side)]
            # Feet remain planted while the pelvis shifts and knees absorb dip.
            foot.location = bases[('Foot', side)]
            foot.keyframe_insert('location', frame=frame)

    # Preserve the author controls and their IK, then bake all 62 deform bones.
    source.animation_data_create()
    action = bpy.data.actions.new(f'SocialDance_{rig}')
    source.animation_data.action = action
    samples = []
    for frame in range(END + 1):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        posed_world = {name: control.matrix_world @ control.pose.bones[name].matrix @ offsets[name] for name in names}
        # The shipped feet are independent Root children. Keep their sole
        # orientation planted; the anatomical helper shins solve above them.
        for side in ['L', 'R']:
            posed_world[f'Foot.{side}'] = idle_world[f'Foot.{side}'].copy()
        for name in names:
            pb = source.pose.bones[name]
            pb.rotation_mode = 'QUATERNION'
            pb.matrix = source.matrix_world.inverted() @ posed_world[name]
            bpy.context.view_layer.update()
            pb.keyframe_insert('location', frame=frame, group=name)
            pb.keyframe_insert('rotation_quaternion', frame=frame, group=name)
            pb.keyframe_insert('scale', frame=frame, group=name)
        bpy.context.view_layer.update()
        samples.append({name: flat(source.matrix_world @ source.pose.bones[name].matrix) for name in names})
    assert original == {b.name: flat(b.matrix_local) for b in source.data.bones}, 'Deform bind was modified'
    assert names == [b.name for b in source.data.bones]
    payload = {'rig': rig, 'fps': FPS, 'duration': 4, 'names': names,
               'bindWorld': {n: flat(bind_world[n]) for n in names}, 'frames': samples,
               'controls': [o.name for o in targets.values()], 'sourceBoneCount': len(names)}
    (out / f'dance-{rig}-samples.json').write_text(json.dumps(payload), encoding='utf8')
    # Independent geometry oracle: exported clips must deform the actual source
    # meshes like Blender, not merely have finite/closed keyframe arrays.
    checks = []
    for frame in [0, 30, 60, 90, 120]:
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        deps = bpy.context.evaluated_depsgraph_get()
        points = []
        for ob in scene.objects:
            if ob.type != 'MESH':
                continue
            evaluated = ob.evaluated_get(deps)
            mesh = evaluated.to_mesh()
            for vertex in mesh.vertices:
                p = evaluated.matrix_world @ vertex.co
                points.append([p.x, p.z, -p.y])
            evaluated.to_mesh_clear()
        checks.append({'time': frame/FPS, 'min': [min(p[i] for p in points) for i in range(3)],
                       'max': [max(p[i] for p in points) for i in range(3)]})
    oracle_path = repo / 'assets/blender-dance-reference.json'
    oracle = json.loads(oracle_path.read_text()) if oracle_path.exists() else {}
    oracle[rig] = checks
    oracle_path.write_text(json.dumps(oracle, indent=2) + '\n')
    scene.frame_set(0)
    control.hide_render = True
    control.show_in_front = True
    source.show_in_front = True
    # Preview stage is saved for reproducible visual review, not game export.
    bpy.ops.object.camera_add(location=(3.1, -5.3, 2.5))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 0, .85)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 2.3
    scene.camera = camera
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x = 640
    scene.render.resolution_y = 800
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new(f'Studio_{rig}')
    scene.world.color = (.18, .18, .18)
    for loc, power, size in [((3,-4,5), 550, 4), ((-3,-1,3), 350, 3)]:
        bpy.ops.object.light_add(type='AREA', location=loc)
        light=bpy.context.object
        light.data.energy=power
        light.data.shape='DISK'
        light.data.size=size
        light.rotation_euler=(Vector((0,0,.85))-light.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.wm.save_as_mainfile(filepath=str(out / f'social-dance-{rig}.blend'))
    scene.render.filepath = str(out / f'dance-{rig}-preview.png')
    bpy.ops.render.render(write_still=True)
    print(json.dumps({'rig': rig, 'frames':len(samples), 'bones':len(names), 'blend':str(out / f'social-dance-{rig}.blend'), 'samples':str(out / f'dance-{rig}-samples.json')}))
