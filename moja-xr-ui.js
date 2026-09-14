(function () {
  'use strict';
  const THREE = AFRAME.THREE;
  const runtime = window.MOJA_RUNTIME.create(THREE);

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
        const pose = runtime.surfacePose(this.tracker.point, this.tracker.normal, viewer.baseSize, viewer.scalePercent / 100);
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
      if (!isVisible) { this.wasVisible = false; return; }
      const scene = this.el.sceneEl;
      if (!this.wasVisible) {
        // Only one workspace at a time; controller dock can always reopen it.
        scene.querySelectorAll('[workspace-panel]').forEach(panel => {
          if (panel !== this.el && panel.object3D.visible) {
            panel.object3D.visible = false;
            panel.querySelectorAll('.ray-target').forEach(control => control.classList.remove('ray-target'));
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
      if (this.originalParent) this.originalParent.add(this.el.object3D);
    }
  });

  AFRAME.registerComponent('xr-workspace', {
    init: function () {
      this.hover = runtime.highlight(); this.el.object3D.add(this.hover.group);
      this.lastTime = 0;
      this.onAction = this.action.bind(this); this.el.addEventListener('viewer-ui-action', this.onAction);
      this.el.addEventListener('loaded', () => {
        this.el.querySelectorAll('.ui-click').forEach(control => { if (control.tagName.toLowerCase() === 'a-plane') control.setAttribute('soft-card', ''); });
        this.el.querySelectorAll('.ui-click > a-text').forEach(label => {
          const control=label.parentElement, width=Number(control.getAttribute('width'));
          if(!width || control.closest('#componentList')) return;
          const value=String(label.getAttribute('value')||'');
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
    action: function (event) {
      const viewer = this.el.components['quest-viewer']; if (!viewer) return;
      const action = event.detail.action;
      const modes = {'mode-move': viewer.modeType === 'mr' ? 'move' : 'nav', 'mode-select': 'select', 'mode-measure': 'measure', 'mode-annotate': 'annotate'};
      if (modes[action]) {
        if (!viewer.ready || !viewer.placed) return;
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
    tick: function (time) {
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
      this.el.removeEventListener('viewer-ui-action', this.onAction); this.el.removeEventListener('renderstart',this.prepareLighting);
      this.hover.dispose(); if(this.environment) this.environment.dispose();
    }
  });
})();
