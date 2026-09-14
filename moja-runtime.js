(function (global) {
  'use strict';
  // Shared by the desktop viewer and A-Frame. Units remain GLB metres.
  function create(THREE) {
    const edges = new WeakMap();
    const edgeMaterial = new THREE.LineBasicMaterial({color: 0x34465b, transparent: true, opacity: 0.26, depthWrite: false, toneMapped: false});
    function visible(object) {
      for (let node = object; node; node = node.parent) if (!node.visible) return false;
      return true;
    }
    function prepare(root) {
      const geometries = new Set();
      let meshes = 0, triangles = 0;
      root.traverse(object => {
        if (!object.isMesh || !object.geometry || object.userData.mojaOverlay) return;
        meshes++;
        const geometry = object.geometry;
        triangles += (geometry.index ? geometry.index.count : geometry.attributes.position?.count || 0) / 3;
        if (!geometries.has(geometry)) {
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
          geometries.add(geometry);
        }
        // THREE raycasting itself does not exclude invisible meshes/ancestors.
        if (!object.userData.mojaVisibilityRaycast) {
          const original = object.raycast;
          object.raycast = function (raycaster, hits) { if (visible(this)) original.call(this, raycaster, hits); };
          object.userData.mojaVisibilityRaycast = true;
        }
      });
      return {meshes, geometries: geometries.size, triangles: Math.round(triangles)};
    }
    function addEdges(root) {
      const meshes = [];
      root.traverse(object => { if (object.isMesh && object.geometry && !object.userData.mojaOverlay) meshes.push(object); });
      meshes.forEach(mesh => {
        if (mesh.userData.mojaEdgesAdded) return;
        let geometry = edges.get(mesh.geometry);
        if (!geometry) { geometry = new THREE.EdgesGeometry(mesh.geometry, 32); edges.set(mesh.geometry, geometry); }
        const overlay = new THREE.LineSegments(geometry, edgeMaterial);
        overlay.name = '__MOJA_EDGES__';
        overlay.userData.mojaEdgeOverlay = true;
        overlay.raycast = function () {};
        mesh.add(overlay);
        mesh.userData.mojaEdgesAdded = true;
      });
    }
    function highlight() {
      const group = new THREE.Group();
      const material = new THREE.MeshBasicMaterial({color: 0x38bdf8, transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1});
      let current = [];
      return {
        group,
        set(meshes) {
          if (meshes.length === current.length && meshes.every((mesh, i) => mesh === current[i])) return;
          group.clear(); current = meshes.slice();
          current.forEach(mesh => {
            const overlay = new THREE.Mesh(mesh.geometry, material);
            overlay.matrixAutoUpdate = false;
            overlay.userData.mojaOverlay = true;
            overlay.raycast = function () {};
            group.add(overlay);
          });
          this.update();
        },
        update() {
          group.updateWorldMatrix(true, false);
          const inverse = group.matrixWorld.clone().invert();
          group.children.forEach((overlay, i) => {
            const mesh = current[i];
            overlay.visible = visible(mesh);
            overlay.matrix.multiplyMatrices(inverse, mesh.matrixWorld);
          });
        },
        dispose() { group.removeFromParent(); group.clear(); material.dispose(); current = []; }
      };
    }
    function arcball(x, y, rect) {
      const radius = Math.min(rect.width, rect.height) * 0.5;
      const point = new THREE.Vector3((x - rect.left - rect.width / 2) / radius, (rect.top + rect.height / 2 - y) / radius, 0);
      const lengthSq = point.lengthSq();
      if (lengthSq <= 1) point.z = Math.sqrt(1 - lengthSq);
      else point.normalize();
      return point;
    }
    // Hysteresis: enter the 1:1 detent at 2%, leave at 5%. No integer rounding.
    function scaleDetent(percent, held) {
      const value = Math.max(1, Math.min(500, Number.isFinite(percent) ? percent : 100));
      const snapped = Math.abs(value - 100) <= (held ? 5 : 2);
      return {value: snapped ? 100 : value, snapped};
    }
    function surfacePose(point, normal, size, scale) {
      const x = new THREE.Vector3(), y = normal.clone().normalize(), z = new THREE.Vector3(0, 0, 1);
      z.addScaledVector(y, -z.dot(y));
      if (z.lengthSq() < 0.01) { z.set(0, 1, 0); z.addScaledVector(y, -z.dot(y)); }
      z.normalize(); x.crossVectors(y, z).normalize(); z.crossVectors(x, y).normalize();
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      // The normalised CAD bottom is always local Y=0, including walls and slopes.
      const support = new THREE.Vector3();
      const position = point.clone().sub(support.clone().multiplyScalar(scale).applyQuaternion(quaternion));
      return {position, quaternion, support};
    }
    function surfaceTracker() {
      const point = new THREE.Vector3();
      const normal = new THREE.Vector3(0, 1, 0);
      let started = null, previous = null, freshAt = -Infinity, ready = false;
      return {
        point, normal,
        reset() { started = null; previous = null; ready = false; freshAt = -Infinity; },
        sample(position, candidateNormal, time) {
          if (!position || !candidateNormal || !Number.isFinite(position.lengthSq()) || !Number.isFinite(candidateNormal.lengthSq()) || candidateNormal.lengthSq() < 0.9) { this.reset(); return false; }
          if (!previous || previous.distanceTo(position) > 0.035 || time - freshAt > 120 || normal.dot(candidateNormal) < 0.99) {
            started = time; point.copy(position); normal.copy(candidateNormal);
          } else {
            point.lerp(position, 0.35); normal.lerp(candidateNormal, 0.25).normalize();
          }
          previous = position.clone(); freshAt = time;
          ready = time - started >= 220;
          return ready;
        },
        valid(time) { return ready && time - freshAt < 120; }
      };
    }
    return {prepare, visible, addEdges, highlight, arcball, scaleDetent, surfaceTracker, surfacePose};
  }
  global.MOJA_RUNTIME = {create};
})(typeof window !== 'undefined' ? window : globalThis);
