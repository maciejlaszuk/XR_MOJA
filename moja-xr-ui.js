(function () {
  'use strict';
  const THREE = AFRAME.THREE;
  const runtime = window.MOJA_RUNTIME.create(THREE);

  // Filter environment depth at its own resolution, before rendering the CAD
  // scene. Four MSAA depth samples approximate a soft visibility mask without
  // changing any model/UI material, alpha, sorting, or interaction behavior.
  function createDepthEdgeFilter() {
    let mesh = null, original = null, passes = [], renderer = null;
    let targets = null, prepScene = null, prepMaterial = null, prepGeometry = null;
    let size = new THREE.Vector2(), nextTarget = 0, lastTime = null, historyValid = false, targetsChecked = false;
    const previous = [null, null], savedViewport = new THREE.Vector4(), savedScissor = new THREE.Vector4();
    const uniforms = {
      depthColor: {value: null}, depthWidth: {value: 1}, depthHeight: {value: 1},
      depthRange: {value: new THREE.Vector2(0.1, 100)},
      filtered0: {value: null}, filtered1: {value: null}, filterSize: {value: size}
    };
    const vertexShader = 'varying vec2 filterUV; void main() { filterUV = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const depthMath = `
uniform vec2 depthRange;
float toMeters(float z, vec2 range) {
  // range.y == 0 represents an infinite far plane. Avoid inf / inf and NaNs.
  return range.y == 0.0 ? range.x / max(0.000001, 1.0 - z) :
    range.x * range.y / max(0.000001, range.y - z * (range.y - range.x));
}
float fromMeters(float metres) {
  if (depthRange.y == 0.0) return clamp(1.0 - depthRange.x / metres, 0.0, 1.0);
  return clamp(depthRange.y * (metres - depthRange.x) / (metres * (depthRange.y - depthRange.x)), 0.0, 1.0);
}
`;
    const filteredSampling = `
uniform vec2 filterSize;
vec4 filteredSample(sampler2D source, vec2 uv) {
#ifdef FILTER_LINEAR
  return texture2D(source, clamp(uv, 0.5 / filterSize, 1.0 - 0.5 / filterSize));
#else
  // Float-linear filtering is optional. Never rely on it silently.
  vec2 p = uv * filterSize - 0.5, f = fract(p), base = floor(p);
  vec2 lo = clamp((base + 0.5) / filterSize, 0.5 / filterSize, 1.0 - 0.5 / filterSize);
  vec2 hi = clamp((base + 1.5) / filterSize, 0.5 / filterSize, 1.0 - 0.5 / filterSize);
  return mix(mix(texture2D(source, lo), texture2D(source, vec2(hi.x, lo.y)), f.x),
             mix(texture2D(source, vec2(lo.x, hi.y)), texture2D(source, hi), f.x), f.y);
#endif
}
`;
    const prepUniforms = {
      depthColor: uniforms.depthColor, depthRange: uniforms.depthRange, filterSize: uniforms.filterSize,
      eye: {value: 0}, history: {value: null}, historyWeight: {value: 0},
      historyRange: {value: new THREE.Vector2()}, currentToPrevious: {value: new THREE.Matrix4()}
    };
    function initialize(nextRenderer, width, height) {
      if (renderer && renderer !== nextRenderer) release();
      renderer = nextRenderer;
      const linear = renderer.extensions.has('OES_texture_float_linear');
      if (!prepScene) {
        prepMaterial = new THREE.ShaderMaterial({
          uniforms: prepUniforms, vertexShader, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
          defines: linear ? {FILTER_LINEAR: 1} : {},
          fragmentShader: depthMath + filteredSampling + `
uniform highp sampler2DArray depthColor;
uniform sampler2D history;
uniform float eye;
uniform float historyWeight;
uniform vec2 historyRange;
uniform mat4 currentToPrevious;
varying vec2 filterUV;
void main() {
  vec2 uv = filterUV, stepUV = 1.0 / filterSize;
  float depths[9]; float weights[9];
  float low = 1.0, high = 0.0, total = 0.0;
  // A small Gaussian kernel in DEPTH pixels, not display pixels. This removes
  // the coarse staircase even when one sensor sample spans many display pixels.
  for (int y = 0; y < 3; y++) for (int x = 0; x < 3; x++) {
    int i = y * 3 + x;
    vec2 p = clamp(uv + vec2(float(x - 1), float(y - 1)) * stepUV, stepUV * 0.5, 1.0 - stepUV * 0.5);
    float d = texture(depthColor, vec3(p, eye)).r;
    d = (d >= 0.0 && d <= 1.0) ? d : 1.0;
    float w = (x == 1 ? 2.0 : 1.0) * (y == 1 ? 2.0 : 1.0);
    depths[i] = d; weights[i] = w; low = min(low, d); high = max(high, d); total += d * w;
  }
  float lowMetres = toMeters(low, depthRange), highMetres = toMeters(high, depthRange);
  float split = fromMeters((lowMetres + highMetres) * 0.5);
  float nearSum = 0.0, farSum = 0.0, nearWeight = 0.0, farWeight = 0.0;
  for (int i = 0; i < 9; i++) {
    if (depths[i] <= split) { nearSum += depths[i] * weights[i]; nearWeight += weights[i]; }
    else { farSum += depths[i] * weights[i]; farWeight += weights[i]; }
  }
  float front = nearWeight > 0.0 ? nearSum / nearWeight : low;
  float back = farWeight > 0.0 ? farSum / farWeight : high;
  float coverage = nearWeight / 16.0;
  if (highMetres - lowMetres < max(0.035, lowMetres * 0.02)) {
    front = total / 16.0; back = front; coverage = 1.0;
  }
  // Stabilize the silhouette in the previous EYE pose. Blend coverage only;
  // never accumulate stale depths or average unaligned camera frames.
  if (historyWeight > 0.0 && back - front > 0.000001) {
    vec4 clip = currentToPrevious * vec4(uv * 2.0 - 1.0, depths[4] * 2.0 - 1.0, 1.0);
    if (clip.w > 0.0) {
      vec3 previousNDC = clip.xyz / clip.w;
      vec2 previousUV = previousNDC.xy * 0.5 + 0.5;
      if (all(greaterThan(previousUV, vec2(0.0))) && all(lessThan(previousUV, vec2(1.0)))) {
        vec4 old = filteredSample(history, previousUV);
        bool sameEdge = old.g - old.r > 0.000001 &&
          abs(toMeters(old.r, historyRange) - toMeters(front, depthRange)) < max(0.08, lowMetres * 0.04) &&
          abs(toMeters(old.g, historyRange) - toMeters(back, depthRange)) < max(0.08, highMetres * 0.04);
        if (sameEdge && previousNDC.z >= -1.0 && previousNDC.z <= 1.0) {
          // Limit trails from moving furniture/hands and reveal newly visible
          // areas promptly, even when their depth happens to remain similar.
          coverage = mix(coverage, clamp(old.b, coverage - 0.15, coverage + 0.15), historyWeight);
        }
      }
    }
  }
  gl_FragColor = vec4(front, back, coverage, depths[4]);
}`
        });
        prepGeometry = new THREE.PlaneGeometry(2, 2);
        prepScene = new THREE.Scene(); prepScene.add(new THREE.Mesh(prepGeometry, prepMaterial));
        const options = {type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
          minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter, magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter};
        targets = [0, 1].map(() => [new THREE.WebGLRenderTarget(width, height, options), new THREE.WebGLRenderTarget(width, height, options)]);
      }
      if (size.x !== width || size.y !== height) {
        size.set(width, height); targets.flat().forEach(target => target.setSize(width, height));
        historyValid = false; targetsChecked = false; previous.fill(null);
      }
      return linear;
    }
    function attach(nextMesh, linear) {
      if (mesh === nextMesh) return;
      detach(); mesh = nextMesh;
      original = {material: mesh.material, renderOrder: mesh.renderOrder, frustumCulled: mesh.frustumCulled};
      for (let index = 0; index < 4; index++) {
        const passUniforms = Object.assign({}, uniforms, {
          quantile: {value: (3.5 - index) / 4}, sampleCoverage: {value: (4 - index) / 4}
        });
        const material = new THREE.ShaderMaterial({
          uniforms: passUniforms, vertexShader, colorWrite: false, depthWrite: true, depthTest: true,
          alphaToCoverage: index > 0, defines: linear ? {FILTER_LINEAR: 1} : {},
          fragmentShader: depthMath + filteredSampling + `
uniform sampler2D filtered0;
uniform sampler2D filtered1;
uniform float depthWidth;
uniform float depthHeight;
uniform float quantile;
uniform float sampleCoverage;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(depthWidth, depthHeight);
  float eye = 0.0;
#ifdef VIEW_ID
  eye = float(VIEW_ID);
#else
  if (uv.x >= 1.0) { uv.x -= 1.0; eye = 1.0; }
#endif
  vec4 distribution = eye < 0.5 ? filteredSample(filtered0, uv) : filteredSample(filtered1, uv);
  float fraction = clamp(distribution.b, 0.0, 1.0);
  float d, localQuantile;
  if (quantile < fraction) {
    d = distribution.r; localQuantile = quantile / max(fraction, 0.000001);
  } else {
    d = distribution.g; localQuantile = (quantile - fraction) / max(1.0 - fraction, 0.000001);
  }
  float metres = toMeters(d, depthRange);
  // A short, one-sided contact fade (12–30 mm) keeps an object sitting ON a
  // wall/floor fully visible, and softly hides it as it enters that surface.
  float contactBand = clamp(metres * 0.006, 0.012, 0.03);
  gl_FragDepth = fromMeters(metres + contactBand * localQuantile);
  gl_FragColor = vec4(0.0, 0.0, 0.0, sampleCoverage);
}`
        });
        if (index === 0) mesh.material = material;
        else {
          const child = new THREE.Mesh(mesh.geometry, material);
          child.frustumCulled = false; child.renderOrder = -1000000 + index;
          child.raycast = function () {}; mesh.add(child); passes.push(child);
        }
      }
      mesh.renderOrder = -1000000; mesh.frustumCulled = false;
    }
    function detach() {
      if (!mesh) return;
      mesh.material.dispose();
      passes.forEach(pass => { pass.removeFromParent(); pass.material.dispose(); }); passes = [];
      mesh.material = original.material; mesh.renderOrder = original.renderOrder; mesh.frustumCulled = original.frustumCulled;
      mesh = null; original = null;
    }
    function resetHistory() { historyValid = false; lastTime = null; previous.fill(null); }
    function disable() { detach(); resetHistory(); uniforms.depthColor.value = null; }
    function release() {
      disable(); targets?.flat().forEach(target => target.dispose());
      prepGeometry?.dispose(); prepMaterial?.dispose();
      targets = null; prepScene = null; prepGeometry = null; prepMaterial = null; renderer = null; size.set(0, 0);
      uniforms.filtered0.value = null; uniforms.filtered1.value = null;
    }
    function viewState(view, range) {
      if (!view?.projectionMatrix || !view.transform?.matrix) return null;
      const projection = new THREE.Matrix4().fromArray(view.projectionMatrix);
      const near = range.x, far = range.y;
      projection.elements[10] = far === 0 ? -1 : -(far + near) / (far - near);
      projection.elements[14] = far === 0 ? -2 * near : -2 * far * near / (far - near);
      const world = new THREE.Matrix4().fromArray(view.transform.matrix);
      return {world, projection, viewProjection: projection.clone().multiply(world.clone().invert()), range: range.clone()};
    }
    const prepCamera = new THREE.Camera();
    return {
      uniforms,
      apply(depthMesh, viewport, near, far, samples, frameData = {}) {
        const source = mesh === depthMesh && original ? original.material : depthMesh?.material;
        const texture = source?.uniforms?.depthColor?.value;
        const nextRenderer = frameData.renderer, width = frameData.width, height = frameData.height;
        if (!texture || !(viewport?.z > 0 && viewport?.w > 0) || !Number.isFinite(near) || near <= 0 || !(far > near) ||
            !(samples >= 4) || !nextRenderer?.extensions.has('EXT_color_buffer_float') || nextRenderer.getContext().isContextLost() ||
            !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 2048 || height > 2048) {
          disable(); return false;
        }
        const linear = initialize(nextRenderer, width, height);
        uniforms.depthColor.value = texture;
        uniforms.depthRange.value.set(near, Number.isFinite(far) ? far : 0);
        uniforms.depthWidth.value = viewport.z; uniforms.depthHeight.value = viewport.w;
        const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        renderer.getViewport(savedViewport); renderer.getScissor(savedScissor);
        const scissorTest = renderer.getScissorTest(), xrEnabled = renderer.xr.enabled, autoClear = renderer.autoClear;
        const time = frameData.time, dt = Number.isFinite(time) && lastTime !== null ? time - lastTime : 0;
        const views = frameData.views || [];
        try {
          renderer.xr.enabled = false; renderer.autoClear = false; renderer.setScissorTest(false);
          for (let eye = 0; eye < 2; eye++) {
            const current = viewState(views[eye], uniforms.depthRange.value), old = previous[eye];
            let weight = 0;
            if (historyValid && current && old && dt > 0 && dt < 120) {
              const position = new THREE.Vector3().setFromMatrixPosition(current.world);
              const oldPosition = new THREE.Vector3().setFromMatrixPosition(old.world);
              const angle = new THREE.Quaternion().setFromRotationMatrix(current.world).angleTo(new THREE.Quaternion().setFromRotationMatrix(old.world));
              if (position.distanceTo(oldPosition) < 0.15 && angle < 0.2) {
                prepUniforms.currentToPrevious.value.copy(old.viewProjection).multiply(current.world).multiply(current.projection.clone().invert());
                prepUniforms.historyRange.value.copy(old.range); weight = Math.min(0.7, Math.exp(-dt / 40));
              }
            }
            prepUniforms.eye.value = eye; prepUniforms.historyWeight.value = weight;
            prepUniforms.history.value = targets[eye][1 - nextTarget].texture;
            renderer.setRenderTarget(targets[eye][nextTarget]);
            if (!targetsChecked) {
              const gl = renderer.getContext();
              if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Float depth filter target is incomplete.');
            }
            renderer.render(prepScene, prepCamera); previous[eye] = current;
          }
          targetsChecked = true;
          uniforms.filtered0.value = targets[0][nextTarget].texture; uniforms.filtered1.value = targets[1][nextTarget].texture;
          nextTarget = 1 - nextTarget; lastTime = Number.isFinite(time) ? time : null; historyValid = true;
        } finally {
          renderer.setRenderTarget(target, face, mip); renderer.setViewport(savedViewport); renderer.setScissor(savedScissor);
          renderer.setScissorTest(scissorTest); renderer.autoClear = autoClear; renderer.xr.enabled = xrEnabled;
        }
        attach(depthMesh, linear);
        original.material.uniforms.depthWidth.value = viewport.z; original.material.uniforms.depthHeight.value = viewport.w;
        return true;
      },
      disable,
      dispose: release
    };
  }


  AFRAME.registerComponent('room-occlusion', {
    init: function () {
      this.entries = new Map(); this.group = new THREE.Group(); this.el.object3D.add(this.group);
      this.material = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: true, side: THREE.DoubleSide});
      this.edgeFilter = createDepthEdgeFilter();
      this.onConfigure = () => {
        const configuration = this.el.systems.webxr?.sessionConfiguration;
        if (configuration) configuration.depthSensing = {usagePreference: ['gpu-optimized'], dataFormatPreference: ['unsigned-short'], matchDepthView: true};
      };
      this.onChanged = event => { if (event.detail?.name === 'webxr') this.onConfigure(); };
      this.onEnd = () => { this.edgeFilter.dispose(); this.clear(); this.setStatus('REAL-WORLD OCCLUSION: WAITING FOR MR'); };
      this.el.addEventListener('componentchanged', this.onChanged);
      this.el.addEventListener('loaded', this.onConfigure);
      this.el.addEventListener('exit-vr', this.onEnd);
      this.onConfigure();
    },
    setStatus: function (status) {
      if (this.status === status) return;
      const label = document.getElementById('occlusionStatus');
      if (label) { label.setAttribute('value', status); this.status = status; }
    },
    clear: function () {
      this.entries.forEach(entry => entry.mesh.geometry.dispose());
      this.entries.clear(); this.group.clear();
    },
    geometry: function (surface, isMesh) {
      const geometry = new THREE.BufferGeometry();
      if (isMesh) {
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(surface.vertices), 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(surface.indices), 1));
      } else {
        const polygon = Array.from(surface.polygon);
        const contour = polygon.map(point => new THREE.Vector2(point.x, point.z));
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(polygon.flatMap(point => [point.x, point.y, point.z]), 3));
        geometry.setIndex(THREE.ShapeUtils.triangulateShape(contour, []).flat());
      }
      geometry.computeBoundingSphere(); return geometry;
    },
    tick: function (time) {
      const xr = this.el.renderer?.xr, frame = this.el.frame, session = xr?.getSession();
      if (!session || !frame || window.QUEST_MODE !== 'mr') { this.edgeFilter.disable(); this.group.visible = false; return; }
      let freshDepth = false, depthInfo = null, depthViews = [];
      // Do not display the engine's previous depth texture after tracking is lost.
      try {
        if (session.depthUsage === 'gpu-optimized' && session.depthActive !== false) {
          const pose = frame.getViewerPose(xr.getReferenceSpace());
          const views = pose?.views;
          depthViews = views ? Array.from(views) : [];
          const binding = xr.getBinding?.();
          freshDepth = Boolean(views?.length && binding && Array.from(views).every(view => {
            const depth = binding.getDepthInformation(view);
            if (!depthInfo) depthInfo = depth;
            return depth && depth.isValid !== false && depth.texture && (!depth.textureType || depth.textureType === 'texture-array');
          }));
        }
      } catch (_) { freshDepth = false; }
      const depthMesh = xr.getDepthSensingMesh?.();
      if (depthMesh) {
        depthMesh.visible = freshDepth;
        depthMesh.frustumCulled = false;
        depthMesh.material.colorWrite = false;
        depthMesh.material.depthWrite = true;
        const viewport = xr.getCamera().cameras[0]?.viewport;
        if (viewport && depthMesh.material.uniforms.depthWidth) {
          depthMesh.material.uniforms.depthWidth.value = viewport.z;
          depthMesh.material.uniforms.depthHeight.value = viewport.w;
        }
      }
      if (freshDepth && depthMesh) {
        const near = depthInfo?.depthNear ?? session.renderState.depthNear, far = depthInfo?.depthFar ?? session.renderState.depthFar;
        // Projection layers use Three's multisampled render target; older base
        // layers expose antialias directly. Never use alpha-to-coverage without MSAA.
        const target = this.el.renderer.getRenderTarget();
        const samples = target?.samples || (xr.getBaseLayer?.()?.antialias ? 4 : 0);
        let smooth = false;
        try {
          smooth = this.edgeFilter.apply(depthMesh, xr.getCamera().cameras[0]?.viewport, near, far, samples, {
            renderer: this.el.renderer, width: depthInfo.width, height: depthInfo.height, views: depthViews, time
          });
        } catch (error) {
          this.edgeFilter.disable();
          if (!this.filterWarning) { console.warn('Environment depth filter unavailable; using native occlusion.', error); this.filterWarning = true; }
        }
        this.group.visible = false; this.setStatus(smooth ? 'REAL-WORLD OCCLUSION: LIVE / SOFT' : 'REAL-WORLD OCCLUSION: LIVE'); return;
      }
      this.edgeFilter.disable();
      this.group.visible = true;
      const surfaces = new Map();
      try { for (const mesh of frame.detectedMeshes || []) surfaces.set(mesh, true); } catch (_) { /* Optional room permission was not granted. */ }
      // Prefer the actual room mesh; planes are only a coarse fallback.
      if (!surfaces.size) {
        try { for (const plane of frame.detectedPlanes || []) surfaces.set(plane, false); } catch (_) { /* No plane data on this session. */ }
      }
      for (const [surface, entry] of this.entries) {
        if (!surfaces.has(surface)) { entry.mesh.geometry.dispose(); this.group.remove(entry.mesh); this.entries.delete(surface); }
      }
      let visible = 0;
      for (const [surface, isMesh] of surfaces) {
        let entry = this.entries.get(surface);
        if (!entry) {
          const mesh = new THREE.Mesh(this.geometry(surface, isMesh), this.material);
          mesh.matrixAutoUpdate = false; mesh.renderOrder = -1000; mesh.raycast = function () {};
          this.group.add(mesh); entry = {mesh, changed: surface.lastChangedTime}; this.entries.set(surface, entry);
        } else if (entry.changed !== surface.lastChangedTime) {
          entry.mesh.geometry.dispose(); entry.mesh.geometry = this.geometry(surface, isMesh); entry.changed = surface.lastChangedTime;
        }
        const pose = frame.getPose(isMesh ? surface.meshSpace : surface.planeSpace, xr.getReferenceSpace());
        entry.mesh.visible = Boolean(pose);
        if (pose) { entry.mesh.matrix.fromArray(pose.transform.matrix); visible++; }
      }
      this.setStatus(visible ? 'REAL-WORLD OCCLUSION: ROOM SCAN' : 'REAL-WORLD OCCLUSION: NO ROOM DATA');
    },
    remove: function () {
      this.removed = true;
      this.edgeFilter.dispose(); this.clear(); this.group.removeFromParent(); this.material.dispose();
      this.el.removeEventListener('componentchanged', this.onChanged); this.el.removeEventListener('loaded', this.onConfigure);
      this.el.removeEventListener('exit-vr', this.onEnd);
    }
  });

  AFRAME.registerComponent('surface-placement', {
    init: function () {
      this.tracker = runtime.surfaceTracker();
      this.matrix = new THREE.Matrix4(); this.position = new THREE.Vector3(); this.normal = new THREE.Vector3();
      this.onStart = this.start.bind(this); this.onEnd = this.stop.bind(this);
      this.onSelect = this.select.bind(this); this.onSources = this.requestSource.bind(this);
      this.el.addEventListener('enter-vr', this.onStart); this.el.addEventListener('exit-vr', this.onEnd);
      this.generation = 0;
      this.preview = new THREE.Group(); this.preview.visible = false; this.el.object3D.add(this.preview);
      this.previewMesh = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({color:0x2dd4bf,transparent:true,opacity:0.7}));
      this.previewMesh.raycast = function () {}; this.preview.add(this.previewMesh);
    },
    start: function () {
      if (window.QUEST_MODE !== 'mr') return;
      this.stop();
      this.session = this.el.renderer.xr.getSession();
      if (!this.session) return;
      const viewer = this.el.components['quest-viewer'];
      viewer.rig.object3D.position.set(0, 0, 0); viewer.rig.object3D.quaternion.identity();
      viewer.resetPlacement();
      this.session.addEventListener('select', this.onSelect);
      this.session.addEventListener('inputsourceschange', this.onSources);
      this.session.addEventListener('end', this.onEnd);
      this.requestSource();
    },
    requestSource: async function () {
      const session = this.session, generation = ++this.generation;
      if (this.source) this.source.cancel(); this.source = null; this.tracker.reset();
      if (!session) return;
      this.input = Array.from(session.inputSources).find(input => input.handedness === 'right') || null;
      try {
        const space = this.input ? this.input.targetRaySpace : await session.requestReferenceSpace('viewer');
        const source = await session.requestHitTestSource({space});
        if (generation !== this.generation || session !== this.session) { source.cancel(); return; }
        this.source = source;
      } catch (error) { this.status('Surface scan unavailable. Check room setup and MR access.'); }
    },
    status: function (value) {
      if (value === this.lastStatus) return;
      this.lastStatus = value;
      const text = document.getElementById('modeText'); if (text) text.setAttribute('value', value);
    },
    tick: function (time) {
      const viewer = this.el.components['quest-viewer'];
      if (!viewer || viewer.placed || window.QUEST_MODE !== 'mr') { this.preview.visible = false; return; }
      const reticle = viewer.reticle;
      const frame = this.el.frame;
      if (!this.source || !frame) { if (reticle) reticle.object3D.visible = false; this.preview.visible=false; return; }
      const reference = this.el.renderer.xr.getReferenceSpace();
      const hit = frame.getHitTestResults(this.source)[0];
      const pose = hit && hit.getPose(reference);
      if (!pose) {
        this.tracker.reset(); reticle.object3D.visible = false; this.preview.visible=false;
        this.status('Point at a surface · floor, table or wall'); return;
      }
      this.matrix.fromArray(pose.transform.matrix);
      this.position.setFromMatrixPosition(this.matrix);
      this.normal.set(0, 1, 0).transformDirection(this.matrix);
      const towardCamera = viewer.camera.object3D.getWorldPosition(new THREE.Vector3()).sub(this.position);
      if (this.normal.dot(towardCamera) < 0) this.normal.negate();
      const ready = this.tracker.sample(this.position, this.normal, performance.now());
      // Keep the hit-test position. Never project it to a made-up distance.
      reticle.object3D.position.copy(this.tracker.point);
      reticle.object3D.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.tracker.normal);
      reticle.object3D.visible = true;
      const color = ready ? '#2DD4BF' : '#FBBF24';
      if (color !== this.reticleColor) { reticle.setAttribute('color', color); this.reticleColor = color; }
      this.status(ready ? 'Surface ready · right trigger to place' : 'Hold the pointer steady…');
      if (viewer.ready) {
        const pose = runtime.surfacePose(this.tracker.point, this.tracker.normal, viewer.baseSize, viewer.scalePercent / 100, this.tracker.quaternion);
        this.preview.position.copy(pose.position); this.preview.quaternion.copy(pose.quaternion); this.preview.scale.setScalar(viewer.scalePercent/100);
        this.previewMesh.scale.copy(viewer.baseSize); this.previewMesh.position.set(0, viewer.baseSize.y/2, 0);
        this.preview.visible=true;
      }
    },
    select: function (event) {
      const viewer = this.el.components['quest-viewer'];
      if (!viewer || !viewer.ready || viewer.placed || !this.tracker.valid(performance.now())) return;
      if (this.input && event.inputSource !== this.input) return;
      if (event.inputSource && event.inputSource.handedness === 'left') return;
      const ray = viewer.right?.components['trigger-ray'];
      const target = MOJA.getInteractiveEl(ray && ray.currentIntersection);
      if (ray?.pressedUI || target?.classList.contains('ui-click')) return;
      viewer.placeAtReticle();
    },
    stop: function () {
      ++this.generation;
      if (this.source) this.source.cancel(); this.source = null;
      if (this.session) {
        this.session.removeEventListener('select', this.onSelect);
        this.session.removeEventListener('inputsourceschange', this.onSources);
        this.session.removeEventListener('end', this.onEnd);
      }
      this.session = null; this.tracker.reset();
      this.preview.visible = false;
      const viewer = this.el.components['quest-viewer'];
      if (viewer) { viewer.cancelGrabs(); if (viewer.reticle) viewer.reticle.object3D.visible = false; }
    },
    remove: function () {
      this.stop(); this.el.removeEventListener('enter-vr', this.onStart); this.el.removeEventListener('exit-vr', this.onEnd);
      this.preview.removeFromParent(); this.previewMesh.geometry.dispose(); this.previewMesh.material.dispose();
    }
  });

  // Rounded geometry retains the regular A-Frame material and raycast behaviour.
  AFRAME.registerComponent('soft-card', {
    schema: {radius: {default: 0.016}},
    init: function () { this.rebuild = this.build.bind(this); this.el.addEventListener('object3dset', this.rebuild); this.build(); },
    build: function () {
      const mesh = this.el.getObject3D('mesh'); if (!mesh || this.mesh === mesh) return;
      this.mesh = mesh;
      const width = Number(this.el.getAttribute('width')) || 1, height = Number(this.el.getAttribute('height')) || 1;
      const x = -width / 2, y = -height / 2, r = Math.min(this.data.radius, height / 3, width / 3);
      const shape = new THREE.Shape();
      shape.moveTo(x + r, y); shape.lineTo(x + width - r, y); shape.quadraticCurveTo(x + width, y, x + width, y + r);
      shape.lineTo(x + width, y + height - r); shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      shape.lineTo(x + r, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - r);
      shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
      this.geometry = new THREE.ShapeGeometry(shape, 5); mesh.geometry = this.geometry;
      runtime.prepare(mesh);
    },
    remove: function () { this.el.removeEventListener('object3dset', this.rebuild); if (this.geometry) this.geometry.dispose(); }
  });

  // Capture a comfortable world pose on opening. Wrist tremor no longer moves the list.
  AFRAME.registerComponent('workspace-panel', {
    init: function () {
      this.wasVisible = false; this.world = new THREE.Matrix4(); this.local = new THREE.Matrix4();
      this.point = new THREE.Vector3(); this.direction = new THREE.Vector3(); this.quaternion = new THREE.Quaternion();
      this.up = new THREE.Vector3(0, 1, 0); this.scale = new THREE.Vector3(0.85, 0.85, 0.85);
      this.blocker = this.el.querySelector(':scope > a-plane');
      if (this.blocker) { this.blocker.classList.add('ui-click'); this.blocker.setAttribute('soft-card', 'radius: 0.035'); }
      const width = Number(this.blocker?.getAttribute('width')) || 1.1;
      const height = Number(this.blocker?.getAttribute('height')) || 0.9;
      this.handle = document.createElement('a-plane');
      this.handle.classList.add('ui-click', 'panel-drag-handle');
      this.handle.setAttribute('width', width);
      this.handle.setAttribute('height', 0.08);
      this.handle.setAttribute('position', `0 ${height / 2 + 0.035} 0.015`);
      this.handle.setAttribute('material', 'shader: flat; color: #19334D; depthTest: false; depthWrite: false');
      this.handle.setAttribute('soft-card', 'radius: 0.018');
      const label = document.createElement('a-text');
      label.setAttribute('value', 'MOVE WINDOW  /  HOLD TRIGGER OR GRIP');
      label.setAttribute('width', width * 0.82); label.setAttribute('wrap-count', 42);
      label.setAttribute('align', 'center'); label.setAttribute('position', '-0.025 0 0.006');
      label.setAttribute('color', '#B9DCF3'); this.handle.appendChild(label);
      this.close = document.createElement('a-plane');
      this.close.classList.add('ui-click', 'panel-close');
      this.close.setAttribute('width', 0.065); this.close.setAttribute('height', 0.06);
      this.close.setAttribute('position', `${width / 2 - 0.045} 0 0.012`);
      this.close.setAttribute('material', 'shader: flat; color: #294A67');
      const cross = document.createElement('a-text');
      cross.setAttribute('value', 'X'); cross.setAttribute('align', 'center'); cross.setAttribute('width', 0.08); cross.setAttribute('wrap-count', 2);
      cross.setAttribute('position', '0 0 0.006'); this.close.appendChild(cross);
      this.onClose = () => this.el.sceneEl.components['xr-workspace']?.closePanel(this.el);
      this.close.addEventListener('moja-ui-activate', this.onClose);
      this.handle.appendChild(this.close); this.el.appendChild(this.handle);
      // A workspace remains usable if a controller loses tracking or is lowered.
      this.attachToScene = () => {
        this.originalParent = this.el.object3D.parent;
        this.el.sceneEl.object3D.attach(this.el.object3D);
      };
      this.el.sceneEl.addEventListener('loaded', this.attachToScene, {once:true});
    },
    tick: function () {
      const object = this.el.object3D, isVisible = object.visible;
      if (this.blocker) this.blocker.classList.toggle('ray-target', isVisible);
      this.handle.classList.toggle('ray-target', isVisible); this.close.classList.toggle('ray-target', isVisible);
      if (!isVisible) {
        if (this.wasVisible) this.el.sceneEl.components['xr-workspace']?.endPanelDrag(null, this.el);
        this.wasVisible = false; return;
      }
      const scene = this.el.sceneEl;
      if (!this.wasVisible) {
        // Only one workspace at a time; controller dock can always reopen it.
        scene.querySelectorAll('[workspace-panel]').forEach(panel => {
          if (panel !== this.el && panel.object3D.visible) {
            scene.components['xr-workspace']?.closePanel(panel);
          }
        });
        const camera = document.getElementById('camera').object3D;
        camera.getWorldPosition(this.point); camera.getWorldQuaternion(this.quaternion);
        this.direction.set(0, 0, -1).applyQuaternion(this.quaternion); this.direction.y = 0; this.direction.normalize();
        this.point.addScaledVector(this.direction, 1.05); this.point.y -= 0.14;
        this.quaternion.setFromAxisAngle(this.up, Math.atan2(-this.direction.x, -this.direction.z));
        this.world.compose(this.point, this.quaternion, this.scale);
        this.wasVisible = true;
        scene.components['quest-viewer']?.refreshRaycaster();
      }
      object.parent.updateWorldMatrix(true, false);
      this.local.copy(object.parent.matrixWorld).invert().multiply(this.world);
      this.local.decompose(object.position, object.quaternion, object.scale);
    },
    remove: function () {
      this.el.sceneEl?.removeEventListener('loaded',this.attachToScene);
      this.close.removeEventListener('moja-ui-activate', this.onClose); this.handle.remove();
      this.el.sceneEl?.components['xr-workspace']?.endPanelDrag(null, this.el);
      if (this.originalParent) this.originalParent.add(this.el.object3D);
    }
  });

  AFRAME.registerComponent('xr-workspace', {
    init: function () {
      this.hover = runtime.highlight(); this.el.object3D.add(this.hover.group);
      this.lastTime = 0;
      this.menuVisible = false; this.drag = null;
      this.onResetUI = this.resetUI.bind(this);
      this.el.addEventListener('exit-vr', this.onResetUI);
      this.el.addEventListener('enter-vr', this.onResetUI);
      this.onPause = () => { this.endPanelDrag(); this.el.components['quest-viewer']?.cancelGrabs(); };
      this.onSessionStart = () => {
        this.xrSession = this.el.renderer?.xr.getSession();
        this.xrSession?.addEventListener('visibilitychange', this.onPause);
      };
      this.el.addEventListener('enter-vr', this.onSessionStart);
      this.onAction = this.action.bind(this); this.el.addEventListener('viewer-ui-action', this.onAction);
      this.onPanelMesh = event => {
        const entity = event.target;
        if (!entity.closest?.('[workspace-panel], #workspaceDock')) return;
        entity.object3D?.traverse(object => {
          object.renderOrder = 100;
          const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          materials.forEach(material => { material.depthTest = false; material.depthWrite = false; });
        });
      };
      this.el.addEventListener('object3dset', this.onPanelMesh, true);
      this.el.addEventListener('loaded', () => {
        this.setMenuVisible(false);
        this.el.querySelectorAll('.ui-click').forEach(control => { if (control.tagName.toLowerCase() === 'a-plane') control.setAttribute('soft-card', ''); });
        this.el.querySelectorAll('.ui-click > a-text').forEach(label => {
          const control=label.parentElement, width=Number(control.getAttribute('width'));
          if(!width || control.closest('#componentList') || control.classList.contains('panel-close')) return;
          const value=String(label.getAttribute('value')||'');
          if (control.closest('#workspaceDock')) {
            label.setAttribute('width', width * 0.88);
            label.setAttribute('wrap-count', 10);
            label.setAttribute('text', 'whiteSpace', 'nowrap');
            return;
          }
          label.setAttribute('width',width*0.92);
          label.setAttribute('wrap-count',Math.max(6,Math.round(width*0.92/0.023),value.length+1));
        });
      });
      this.prepareLighting = () => {
        if (this.environment || !this.el.renderer) return;
        const studio = new THREE.Scene();
        const geometry = new THREE.BoxGeometry(12, 12, 12);
        const materials = [0xcbd5e1,0x8291a5,0xffffff,0x4c596b,0xe2e8f0,0x9ba9bb].map(color=>new THREE.MeshBasicMaterial({color,side:THREE.BackSide}));
        studio.add(new THREE.Mesh(geometry,materials));
        const pmrem = new THREE.PMREMGenerator(this.el.renderer);
        this.environment = pmrem.fromScene(studio,0.025);
        this.el.object3D.environment = this.environment.texture;
        pmrem.dispose(); geometry.dispose(); materials.forEach(material=>material.dispose());
      };
      this.el.addEventListener('renderstart',this.prepareLighting);
      this.prepareLighting();
    },
    setMenuVisible: function (visible) {
      this.menuVisible = Boolean(visible);
      const dock = document.getElementById('workspaceDock');
      if (!dock) return;
      dock.object3D.visible = this.menuVisible;
      dock.querySelectorAll('.ui-click').forEach(control => control.classList.toggle('ray-target', this.menuVisible));
      this.el.components['quest-viewer']?.refreshRaycaster();
    },
    closePanel: function (panel) {
      const viewer = this.el.components['quest-viewer']; if (!viewer || !panel) return;
      this.endPanelDrag(null, panel);
      if (panel.id === 'measurePanel') viewer.getMeasurement()?.setPanelVisible(false);
      else if (panel.id === 'componentPanel') viewer.getSelection()?.setPanelVisible(false);
      else if (panel.id === 'scalePanel') viewer.setScalePanelVisible(false);
      else if (panel.id === 'lightingPanel') this.el.components['lighting-control']?.setPanelVisible(false);
      else if (panel.id === 'annotationPanel') viewer.getAnnotation()?.setPanelVisible(false);
      else if (panel.id === 'annotationKeyboard') {
        viewer.getAnnotation()?.setKeyboardVisible(false); viewer.getAnnotation()?.setPanelVisible(false);
      }
      panel.object3D.visible = false;
      panel.querySelectorAll('.ray-target').forEach(control => control.classList.remove('ray-target'));
      viewer.refreshRaycaster();
    },
    closePanels: function () {
      this.el.querySelectorAll('[workspace-panel]').forEach(panel => { if (panel.object3D.visible) this.closePanel(panel); });
    },
    toggleMenu: function () {
      if (!this.el.components['quest-viewer']?.ready) return;
      const hasPanel = Array.from(this.el.querySelectorAll('[workspace-panel]')).some(panel => panel.object3D.visible);
      if (hasPanel) { this.closePanels(); this.setMenuVisible(true); }
      else this.setMenuVisible(!this.menuVisible);
    },
    resetUI: function () {
      this.endPanelDrag(); this.closePanels(); this.setMenuVisible(false);
      this.xrSession?.removeEventListener('visibilitychange', this.onPause); this.xrSession = null;
    },
    beginPanelDrag: function (button) {
      if (this.drag) return true;
      const viewer = this.el.components['quest-viewer'], controller = viewer?.right;
      const pointer = controller?.components['trigger-ray'];
      const hit = pointer?.currentIntersection, target = MOJA.getInteractiveEl(hit);
      const panel = target?.closest('[workspace-panel]'), component = panel?.components['workspace-panel'];
      if (!component || !panel.object3D.visible || !hit?.point) return false;
      if (target !== component.handle && !(button === 'grip' && target === component.blocker)) return false;
      const ray = controller.components.raycaster?.raycaster?.ray;
      if (!ray) return false;
      viewer.cancelGrabs();
      component.tick();
      const point = new THREE.Vector3().setFromMatrixPosition(component.world);
      this.drag = {button, panel, component, distance: ray.origin.distanceTo(hit.point), offset: point.clone().sub(hit.point), point, target: point.clone()};
      pointer.suppressSelect = true;
      component.handle.setAttribute('material', 'color', '#176E80');
      return true;
    },
    usingPanelScroll: function () {
      const viewer = this.el.components['quest-viewer'], selection = viewer?.getSelection();
      if (!selection?.enabled || !selection.panelVisible || this.drag) return false;
      const axes = viewer.axes.right;
      if (Math.abs(axes.y) < 0.45 || Math.abs(axes.x) >= Math.abs(axes.y)) return false;
      const target = MOJA.getInteractiveEl(viewer.right?.components['trigger-ray']?.currentIntersection);
      return target?.closest('[workspace-panel]') === selection.panel;
    },
    endPanelDrag: function (button, panel) {
      if (!this.drag || (button && this.drag.button !== button) || (panel && this.drag.panel !== panel)) return false;
      this.drag.component.handle.setAttribute('material', 'color', '#19334D');
      this.drag = null;
      return true;
    },
    updatePanelDrag: function (delta) {
      if (!this.drag) return;
      const controller = this.el.components['quest-viewer']?.right;
      const ray = controller?.components.raycaster?.raycaster?.ray;
      if (!ray || !this.drag.panel.object3D.visible || !controller.object3D.visible) { this.endPanelDrag(); return; }
      const drag = this.drag;
      ray.at(drag.distance, drag.target).add(drag.offset);
      drag.point.lerp(drag.target, 1 - Math.exp(-24 * Math.min((delta || 16) / 1000, 0.05)));
      drag.component.world.setPosition(drag.point);
      drag.component.tick();
    },
    action: function (event) {
      const viewer = this.el.components['quest-viewer']; if (!viewer) return;
      const action = event.detail.action;
      const modes = {'mode-move': viewer.modeType === 'mr' ? 'move' : 'nav', 'mode-select': 'select', 'mode-measure': 'measure', 'mode-annotate': 'annotate'};
      if (modes[action]) {
        if (!viewer.ready || !viewer.placed) return;
        this.closePanels(); this.setMenuVisible(false);
        viewer.setMode(modes[action]);
        if (modes[action] === 'select') viewer.getSelection().setPanelVisible(true);
        if (modes[action] === 'measure') viewer.getMeasurement().setPanelVisible(true);
        if (modes[action] === 'annotate') viewer.getAnnotation().setPanelVisible(true);
        if (modes[action] === 'move') viewer.setScalePanelVisible(true);
      }
      const selection = viewer.getSelection();
      if (action === 'component-parent' && selection?.selected.size) {
        const index = Array.from(selection.selected).pop();
        const parent = selection.treeNodes[index].parentIndex;
        if (parent >= 0) { selection.clearSelection(false); selection.toggleIndex(parent, true); }
      }
    },
    tick: function (time, delta) {
      this.updatePanelDrag(delta);
      this.hover.update();
      if (time - this.lastTime < 45) return; this.lastTime = time;
      const viewer = this.el.components['quest-viewer'], selection = viewer?.getSelection();
      const hasPanel=Array.from(this.el.querySelectorAll('[workspace-panel]')).some(panel=>panel.object3D.visible);
      const modeLabel=document.getElementById('modeText');
      if(modeLabel?.parentElement.object3D) modeLabel.parentElement.object3D.visible=!hasPanel;
      const ray = viewer?.right?.components['trigger-ray'];
      const intersection = ray?.currentIntersection;
      let index = -1;
      if (viewer?.interactionMode === 'select' && intersection) index = selection.findIndexFromIntersection(intersection);
      this.hover.set(index >= 0 ? selection.treeNodes[index].meshes : []);
      if (index !== this.hoverIndex) {
        this.hoverIndex = index;
        const name = document.getElementById('componentHoverName');
        if (name) name.setAttribute('value', index >= 0 ? selection.treeNodes[index].label : 'Point to preview · trigger to select');
      }
    },
    remove: function () {
      this.resetUI();
      this.el.removeEventListener('exit-vr', this.onResetUI); this.el.removeEventListener('enter-vr', this.onResetUI);
      this.el.removeEventListener('enter-vr', this.onSessionStart);
      this.el.removeEventListener('object3dset', this.onPanelMesh, true);
      this.el.removeEventListener('viewer-ui-action', this.onAction); this.el.removeEventListener('renderstart',this.prepareLighting);
      this.hover.dispose(); if(this.environment) this.environment.dispose();
    }
  });
})();
