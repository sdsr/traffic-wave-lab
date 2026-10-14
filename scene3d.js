/* Traffic Wave Lab — Three.js scene. The view never changes simulation state.
 * x is the front-bumper coordinate in metres; all dimensions below are metres.
 */
(function (root) {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function create({ canvas, onSelect = () => {}, onChange = () => {} }) {
    const T = root.THREE;
    if (!T) throw new Error('3D 렌더러를 불러오지 못했습니다.');
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    const scene = new T.Scene();
    scene.background = new T.Color(0xc4d5db);
    scene.fog = new T.Fog(0xc4d5db, 240, 1350);
    const camera = new T.PerspectiveCamera(39, 1, 0.15, 20000);
    const hemi = new T.HemisphereLight(0xe6f0ff, 0x677347, 2.8);
    scene.add(hemi);
    const sun = new T.DirectionalLight(0xfff0d5, 3.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -85, right: 85, top: 85, bottom: -85, near: 1, far: 240 });
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);

    const resources = new Set();
    const own = value => { resources.add(value); return value; };
    const material = (color, extra = {}) => own(new T.MeshStandardMaterial({ color, roughness: 0.8, ...extra }));
    const geomBox = own(new T.BoxGeometry(1, 1, 1));
    const mats = {
      ground: material(0x94a17a), verge: material(0xaeba98), road: material(0x46504f), shoulder: material(0x707875),
      stripe: material(0xf1f0dd), rail: material(0xacb8b4, { metalness: 0.55, roughness: 0.5 }),
      bark: material(0x706850), leaves: material(0x4e7055), leavesLight: material(0x77925e),
      tire: material(0x202524), hub: material(0xc5cece, { metalness: 0.65, roughness: 0.3 }),
      window: material(0x1c3e48, { metalness: 0.32, roughness: 0.19 }),
      dark: material(0x27312f), frontLight: material(0xf8f1d3, { emissive: 0xffe5a4, emissiveIntensity: 0.35 }),
      selected: material(0x265f52, { metalness: 0.24, roughness: 0.28 }),
      leader: material(0xba6547, { metalness: 0.25, roughness: 0.3 }),
      tail: material(0x405976, { metalness: 0.25, roughness: 0.3 })
    };
    const carPaints = [0xe9e5d8, 0x768985, 0xa2adb2, 0x53696e, 0xbcb5a3].map(c => material(c, { metalness: 0.26, roughness: 0.3 }));
    function box(parent, mat, x, y, z, sx, sy, sz, cast = false) {
      const mesh = new T.Mesh(geomBox, mat);
      mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
      mesh.castShadow = cast; mesh.receiveShadow = true; parent.add(mesh); return mesh;
    }
    const terrain = box(scene, mats.ground, 0, -0.16, 0, 2800, 0.2, 600);
    const verges = box(scene, mats.verge, 0, -0.045, 0, 2800, 0.055, 17);
    const shoulder = box(scene, mats.shoulder, 0, -0.006, 0, 2800, 0.03, 9.8);
    const road = box(scene, mats.road, 0, 0.018, 0, 2800, 0.035, 7.2);
    const edges = [-3.48, 3.48].map(z => box(scene, mats.stripe, 0, 0.044, z, 2800, 0.011, 0.12));
    const rails = [-5.4, 5.4].map(z => box(scene, mats.rail, 0, 0.79, z, 2800, 0.24, 0.09));
    const lowerRails = [-5.4, 5.4].map(z => box(scene, mats.rail, 0, 0.60, z, 2800, 0.065, 0.1));
    const stripes = new T.InstancedMesh(geomBox, mats.stripe, 4096);
    const posts = new T.InstancedMesh(geomBox, mats.rail, 8192);
    const reflectors = new T.InstancedMesh(geomBox, mats.stripe, 8192);
    const treeTrunks = new T.InstancedMesh(own(new T.CylinderGeometry(0.18, 0.26, 3.4, 6)), mats.bark, 1600);
    const treeCrowns = new T.InstancedMesh(own(new T.IcosahedronGeometry(2.25, 1)), mats.leaves, 1600);
    const shrubs = new T.InstancedMesh(own(new T.IcosahedronGeometry(1, 1)), mats.leavesLight, 1600);
    [stripes, posts, reflectors, treeTrunks, treeCrowns, shrubs].forEach(mesh => { mesh.frustumCulled = false; mesh.receiveShadow = true; scene.add(mesh); });
    const dummy = new T.Object3D();
    function instance(mesh, i, x, y, z, sx, sy, sz) {
      dummy.position.set(x, y, z); dummy.scale.set(sx, sy, sz); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
    }
    let worldKey = '';
    function textSprite(text, dark = false) {
      const c = document.createElement('canvas'); c.width = 160; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = dark ? '#244e43' : '#f6f7f0';
      ctx.beginPath(); ctx.roundRect(2, 2, 156, 60, 12); ctx.fill();
      ctx.fillStyle = dark ? '#fffdf2' : '#35463b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 28px "Segoe UI", "Malgun Gothic", sans-serif'; ctx.fillText(text, 80, 33);
      const texture = own(new T.CanvasTexture(c)); texture.colorSpace = T.SRGBColorSpace;
      const sprite = new T.Sprite(own(new T.SpriteMaterial({ map: texture, depthTest: false, transparent: true })));
      sprite.scale.set(4.6, 1.84, 1); sprite.renderOrder = 5; return sprite;
    }
    function updateWorld(center, span) {
      const length = Math.max(2200, Math.ceil((span + 1400) / 240) * 240);
      const anchor = Math.round(center / 240) * 240;
      const key = anchor + ':' + length;
      if (key === worldKey) return;
      worldKey = key;
      [terrain, verges, shoulder, road, ...edges, ...rails, ...lowerRails].forEach(mesh => { mesh.position.x = anchor; mesh.scale.x = length; });
      const start = Math.floor((anchor - length / 2) / 12) * 12;
      const stripeCount = Math.min(4096, Math.ceil(length / 12));
      for (let i = 0; i < stripeCount; i++) instance(stripes, i, start + i * 12, 0.045, 0, 5, 0.012, 0.13);
      stripes.count = stripeCount; stripes.instanceMatrix.needsUpdate = true;
      const postStart = Math.floor((anchor - length / 2) / 16) * 16;
      const postCount = Math.min(4096, Math.ceil(length / 16));
      for (let i = 0; i < postCount; i++) for (let side = 0; side < 2; side++) {
        const z = side ? 5.4 : -5.4;
        instance(posts, i * 2 + side, postStart + i * 16, 0.46, z, 0.11, 0.88, 0.12);
        instance(reflectors, i * 2 + side, postStart + i * 16, 0.88, z, 0.2, 0.13, 0.14);
      }
      posts.count = reflectors.count = postCount * 2; posts.instanceMatrix.needsUpdate = reflectors.instanceMatrix.needsUpdate = true;
      const treeStart = Math.floor((anchor - length / 2) / 42);
      const treeCount = Math.min(800, Math.ceil(length / 42));
      for (let i = 0; i < treeCount; i++) for (let side = 0; side < 2; side++) {
        const k = treeStart + i, variation = (Math.sin(k * 93.7 + side * 53.9) + 1) / 2;
        // Keep the default roadside sightline clear; the near tree line begins
        // behind the initial camera, while the far side supplies the backdrop.
        const x = k * 42 + variation * 17, z = side ? 75 + variation * 32 : -(15 + variation * 32);
        const s = 0.8 + variation * 0.85, j = i * 2 + side;
        instance(treeTrunks, j, x, 1.6 * s, z, s, s, s);
        instance(treeCrowns, j, x, 4.0 * s, z, 1.1 * s, 1.3 * s, s);
        instance(shrubs, j, x + 11, 0.9, (side ? 1 : -1) * (8.5 + variation * 5), 2.5, 1.0, 1.5);
      }
      [treeTrunks, treeCrowns, shrubs].forEach(mesh => { mesh.count = treeCount * 2; mesh.instanceMatrix.needsUpdate = true; });
    }

    const bodyShape = new T.Shape();
    bodyShape.moveTo(-2.25, 0.48); bodyShape.lineTo(-2.19, 0.87); bodyShape.lineTo(-1.71, 1.00);
    bodyShape.lineTo(1.33, 1.00); bodyShape.lineTo(2.18, 0.82); bodyShape.lineTo(2.25, 0.47); bodyShape.closePath();
    const bodyGeometry = own(new T.ExtrudeGeometry(bodyShape, { depth: 1.76, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.055, bevelThickness: 0.055 }));
    // Normalize the measured bevel bounds to the exact simulated bumper length.
    bodyGeometry.translate(0, 0, -0.88); bodyGeometry.computeBoundingBox();
    const bodyBounds = bodyGeometry.boundingBox;
    const bodyWidth = bodyBounds.max.x - bodyBounds.min.x;
    bodyGeometry.translate(-(bodyBounds.max.x + bodyBounds.min.x) / 2, 0, 0);
    bodyGeometry.scale(4.5 / bodyWidth, 1, 1);
    const cabinShape = new T.Shape();
    cabinShape.moveTo(-1.43, 0.99); cabinShape.lineTo(-0.86, 1.62); cabinShape.lineTo(0.55, 1.62); cabinShape.lineTo(1.19, 0.99); cabinShape.closePath();
    const cabinGeometry = own(new T.ExtrudeGeometry(cabinShape, { depth: 1.43, bevelEnabled: false, steps: 1 })); cabinGeometry.translate(0, 0, -0.715);
    const tireGeometry = own(new T.CylinderGeometry(0.335, 0.335, 0.23, 16)); tireGeometry.rotateX(Math.PI / 2);
    const hubGeometry = own(new T.CylinderGeometry(0.19, 0.19, 0.243, 12)); hubGeometry.rotateX(Math.PI / 2);
    const ring = new T.Mesh(own(new T.RingGeometry(2.7, 2.82, 64)), own(new T.MeshBasicMaterial({ color: 0x6f9c72, transparent: true, opacity: 0.85, depthWrite: false, side: T.DoubleSide })));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.07; scene.add(ring);
    const pickables = [], cars = [];
    function makeCar(index) {
      const group = new T.Group(); group.userData.vehicleIndex = index;
      const paint = carPaints[index % carPaints.length];
      const body = new T.Mesh(bodyGeometry, paint); body.castShadow = true; body.receiveShadow = true; group.add(body); pickables.push(body);
      const cabin = new T.Mesh(cabinGeometry, mats.window); cabin.castShadow = true; group.add(cabin);
      const painted = [body,
        box(group, paint, -0.14, 1.634, 0, 1.44, 0.07, 1.49, true),
        box(group, paint, -0.2, 1.29, 0, 0.095, 0.62, 1.49),
        box(group, paint, -1.38, 1.00, 0, 0.11, 0.12, 1.5),
        box(group, paint, 1.14, 1.01, 0, 0.13, 0.10, 1.5)
      ];
      box(group, mats.dark, 2.15, 0.57, 0, 0.08, 0.13, 0.77);
      box(group, mats.dark, -2.13, 0.47, 0, 0.08, 0.1, 1.1);
      box(group, mats.hub, -2.17, 0.69, 0, 0.025, 0.14, 0.36);
      for (const z of [-0.59, 0.59]) box(group, mats.frontLight, 2.18, 0.75, z, 0.045, 0.14, 0.36);
      const brake = material(0x7d2420, { emissive: 0xff2113, emissiveIntensity: 0.08, roughness: 0.35 });
      for (const z of [-0.65, 0.65]) box(group, brake, -2.19, 0.78, z, 0.045, 0.15, 0.28);
      box(group, brake, -1.0, 1.53, 0, 0.05, 0.065, 0.48);
      for (const z of [-0.965, 0.965]) { painted.push(box(group, paint, 0.62, 1.02, z, 0.28, 0.15, 0.22, true)); }
      const wheels = [];
      for (const x of [-1.43, 1.42]) for (const z of [-0.86, 0.86]) {
        const wheel = new T.Group(); wheel.position.set(x, 0.355, z);
        const tire = new T.Mesh(tireGeometry, mats.tire); tire.castShadow = true; wheel.add(tire);
        wheel.add(new T.Mesh(hubGeometry, mats.hub));
        box(wheel, mats.dark, 0, 0, z > 0 ? 0.125 : -0.125, 0.25, 0.045, 0.013);
        group.add(wheel); wheels.push(wheel);
      }
      const label = textSprite(index === 0 ? '선두' : `${index + 1}번`, index !== 0); label.position.set(0, 3.05, 0); group.add(label);
      scene.add(group); return { group, painted, paint, brake, wheels, label };
    }
    let state = null, previousFrame = null, view = 'follow', zoom = 1, azimuth = -0.53, elevation = 0.34;
    let roadsideAnchor = null, selectedIndex = 0, disposed = false;
    const cameraTarget = new T.Vector3();
    function fitCamera() {
      if (!state) return;
      const { frame, config } = state, positions = frame.x;
      const first = positions[0], last = positions[positions.length - 1] - config.vehicleLength;
      const span = Math.max(10, first - last);
      const angle = view === 'overview' ? clamp(elevation + 0.40, 0.20, 1.42) : elevation;
      let radius;
      if (view === 'overview') {
        cameraTarget.set((first + last) / 2, 0, 1.8);
        const tanVertical = Math.tan(T.MathUtils.degToRad(camera.fov / 2));
        const tanHorizontal = tanVertical * camera.aspect;
        // Fit each corner in camera space. The nearer end of an oblique platoon
        // is larger in perspective, so a width-only fit can clip that end.
        const sinAz = Math.sin(azimuth), cosAz = Math.cos(azimuth);
        const sinEl = Math.sin(angle), cosEl = Math.cos(angle);
        let fittedRadius = 75;
        for (const x of [last, first]) for (const y of [0, 1.9]) for (const z of [0.7, 2.9]) {
          const dx = x - cameraTarget.x, dy = y - cameraTarget.y, dz = z - cameraTarget.z;
          const horizontal = cosAz * dx - sinAz * dz;
          const vertical = -sinAz * sinEl * dx + cosEl * dy - cosAz * sinEl * dz;
          const towardCamera = sinAz * cosEl * dx + sinEl * dy + cosAz * cosEl * dz;
          fittedRadius = Math.max(fittedRadius,
            towardCamera + Math.abs(horizontal) / (tanHorizontal * 0.88),
            towardCamera + Math.abs(vertical) / (tanVertical * 0.88));
        }
        radius = fittedRadius * zoom;
      } else {
        const followX = positions[selectedIndex] - config.vehicleLength / 2;
        if (view === 'roadside' && roadsideAnchor === null) roadsideAnchor = followX + 12;
        cameraTarget.set(view === 'roadside' ? roadsideAnchor : followX + 10, 0.6, 1.8);
        radius = (view === 'roadside' ? 65 : 78) * zoom;
      }
      const horizontal = radius * Math.cos(angle);
      camera.position.set(cameraTarget.x + Math.sin(azimuth) * horizontal, cameraTarget.y + Math.sin(angle) * radius, cameraTarget.z + Math.cos(azimuth) * horizontal);
      camera.lookAt(cameraTarget);
      camera.far = Math.max(5000, radius * 4 + span * 2); camera.updateProjectionMatrix();
      scene.fog.near = view === 'overview' ? radius * 1.7 : 240;
      scene.fog.far = view === 'overview' ? radius * 4.5 : 1350;
      updateWorld(cameraTarget.x, view === 'overview' ? span * 1.6 : 400);
      sun.position.set(cameraTarget.x - 48, 85, 42); sun.target.position.set(cameraTarget.x, 0, 0);
    }
    function resize() {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
      if (canvas.width !== Math.round(width * renderer.getPixelRatio()) || canvas.height !== Math.round(height * renderer.getPixelRatio())) renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    function update(nextState) {
      if (disposed || !nextState?.frame?.x?.length) return;
      state = nextState;
      const { frame, config } = state;
      selectedIndex = clamp(Number(state.selected) || 0, 0, frame.x.length - 1);
      while (cars.length < frame.x.length) cars.push(makeCar(cars.length));
      const dt = previousFrame ? frame.t - previousFrame.t : 0;
      cars.forEach((car, i) => {
        car.group.visible = i < frame.x.length;
        if (!car.group.visible) return;
        car.group.position.set(frame.x[i] - config.vehicleLength / 2, 0, 1.8);
        car.group.scale.x = config.vehicleLength / 4.5;
        const paint = i === selectedIndex ? mats.selected : i === 0 ? mats.leader : i === frame.x.length - 1 ? mats.tail : car.paint;
        car.painted.forEach(mesh => { mesh.material = paint; });
        const a = Number.isFinite(frame.a?.[i]) ? frame.a[i] : dt > 0 && dt < 0.6 && previousFrame.v.length === frame.v.length ? (frame.v[i] - previousFrame.v[i]) / dt : 0;
        car.brake.emissiveIntensity = a < -0.3 ? 2.5 : 0.08;
        car.brake.color.setHex(a < -0.3 ? 0xe33120 : 0x7d2420);
        car.wheels.forEach(wheel => { wheel.rotation.z = -frame.x[i] / 0.335; });
        car.label.visible = view !== 'overview' && (i === selectedIndex || i === 0);
        car.label.scale.x = 4.6 / car.group.scale.x;
      });
      ring.position.x = frame.x[selectedIndex] - config.vehicleLength / 2; ring.position.z = 1.8;
      ring.visible = view !== 'overview'; ring.scale.set(config.vehicleLength / 4.5, 0.8, 1);
      previousFrame = frame;
      resize(); fitCamera(); renderer.render(scene, camera);
    }
    function changed() { if (state) update(state); onChange(); }
    function resetCamera() { zoom = 1; azimuth = -0.53; elevation = view === 'roadside' ? 0.22 : 0.34; roadsideAnchor = null; changed(); }
    function setView(value) { if (!['follow', 'overview', 'roadside'].includes(value)) return; view = value; resetCamera(); }
    function setZoom(factor) { if (Number.isFinite(factor) && factor > 0) { zoom = clamp(zoom * factor, 0.22, 4); changed(); } }
    const pointers = new Map(); let down = null, moved = false, pinchDistance = null;
    const ray = new T.Raycaster(); const ndc = new T.Vector2();
    function pointerDown(e) {
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId);
      down = { x: e.clientX, y: e.clientY, id: e.pointerId }; moved = false;
      if (pointers.size === 2) { const p = [...pointers.values()]; pinchDistance = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); moved = true; }
      canvas.style.cursor = 'grabbing';
    }
    function pointerMove(e) {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const p = [...pointers.values()], d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        if (pinchDistance && d > 0) setZoom(pinchDistance / d); pinchDistance = d; moved = true; return;
      }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) moved = true;
      if (!moved) return;
      azimuth -= (e.clientX - prev.x) * 0.007;
      elevation = clamp(elevation + (e.clientY - prev.y) * 0.005, 0.09, 1.35);
      changed();
    }
    function pointerUp(e) {
      if (!pointers.has(e.pointerId)) return;
      const click = !moved && down && down.id === e.pointerId && e.type !== 'pointercancel';
      pointers.delete(e.pointerId); pinchDistance = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = 'grab';
      if (click && state) {
        const rect = canvas.getBoundingClientRect();
        ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        const hit = ray.intersectObjects(pickables.filter(mesh => mesh.parent.visible), false)[0];
        if (hit) { const i = hit.object.parent.userData.vehicleIndex; if (i > 0) onSelect(i); }
      }
      down = null;
    }
    function wheel(e) { e.preventDefault(); setZoom(Math.exp(clamp(e.deltaY, -150, 150) * 0.0015)); }
    canvas.style.touchAction = 'none'; canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp);
    canvas.addEventListener('wheel', wheel, { passive: false });
    function dispose() {
      disposed = true;
      canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointercancel', pointerUp); canvas.removeEventListener('wheel', wheel);
      resources.forEach(resource => resource.dispose()); renderer.dispose();
    }
    resize();
    return { update, setView, setZoom, resetCamera, resize, dispose };
  }
  root.TrafficScene3D = Object.freeze({ create });
})(typeof globalThis !== 'undefined' ? globalThis : this);
