(function (global) {
  'use strict';

  var VERSION = '27';

  function createEngine(THREE, userOptions) {
    if (!THREE) throw new Error('MOJA PRECISION: missing THREE.');

    var options = Object.assign({
      angularTolerance: 0.006,
      minWorldRadius: 0.0025,
      maxWorldRadius: 0.12,
      depthWindowFactor: 3.0,
      stickyFactor: 1.65,
      stickyHoldMs: 260,
      maxNeighbourCells: 4,
      useFaceReferencePoints: false,
      priority: {
        center: 0.00,
        vertex: 0.07,
        midpoint: 0.13,
        edge: 0.22,
        face: 0.34
      }
    }, userOptions || {});

    var data = null;
    var ready = false;
    var pointCandidates = [];
    var segmentCandidates = [];
    var pointGrid = new Map();
    var segmentGrid = new Map();
    var bbox = new THREE.Box3();
    var cellSize = 0.05;
    var rootObject = null;
    var lastSnap = null;
    var lastSnapAt = 0;

    var temp = {
      inverse: new THREE.Matrix4(),
      rayLocal: new THREE.Ray(),
      hitLocal: new THREE.Vector3(),
      worldPoint: new THREE.Vector3(),
      localPoint: new THREE.Vector3(),
      closestRay: new THREE.Vector3(),
      closestSegment: new THREE.Vector3(),
      line: new THREE.Line3(),
      rootScale: new THREE.Vector3(),
      boxSize: new THREE.Vector3(),
      queryPoint: new THREE.Vector3()
    };

    function finitePointArray(value) {
      return Array.isArray(value) && value.length >= 3 &&
        Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1])) && Number.isFinite(Number(value[2]));
    }

    function vectorFromArray(value) {
      return new THREE.Vector3(Number(value[0]), Number(value[1]), Number(value[2]));
    }

    function keyForCell(ix, iy, iz) {
      return ix + '|' + iy + '|' + iz;
    }

    function cellCoords(point) {
      return {
        x: Math.floor(point.x / cellSize),
        y: Math.floor(point.y / cellSize),
        z: Math.floor(point.z / cellSize)
      };
    }

    function addToGrid(grid, point, index) {
      var c = cellCoords(point);
      var key = keyForCell(c.x, c.y, c.z);
      var list = grid.get(key);
      if (!list) {
        list = [];
        grid.set(key, list);
      }
      list.push(index);
    }

    function addPointCandidate(kind, pointArray, id, component, label, extra) {
      if (!finitePointArray(pointArray)) return;
      var point = vectorFromArray(pointArray);
      var candidate = {
        id: id || (kind + '-' + pointCandidates.length),
        kind: kind,
        point: point,
        component: component || '',
        label: label || '',
        extra: extra || null
      };
      bbox.expandByPoint(point);
      pointCandidates.push(candidate);
    }

    function addSegmentCandidate(item, index) {
      if (!item || !finitePointArray(item.a) || !finitePointArray(item.b)) return;
      var a = vectorFromArray(item.a);
      var b = vectorFromArray(item.b);
      if (a.distanceToSquared(b) < 1e-16) return;
      var midpoint = a.clone().add(b).multiplyScalar(0.5);
      var candidate = {
        id: item.id || ('edge-' + index),
        kind: 'edge',
        a: a,
        b: b,
        midpoint: midpoint,
        component: item.component || '',
        label: item.label || ''
      };
      bbox.expandByPoint(a);
      bbox.expandByPoint(b);
      segmentCandidates.push(candidate);
      addPointCandidate('midpoint', [midpoint.x, midpoint.y, midpoint.z], candidate.id + '-mid', candidate.component, 'CAD MIDPOINT', {segmentId: candidate.id});
    }

    function buildIndexes() {
      pointGrid = new Map();
      segmentGrid = new Map();
      if (bbox.isEmpty()) {
        cellSize = 0.05;
        return;
      }
      bbox.getSize(temp.boxSize);
      var diagonal = Math.max(temp.boxSize.length(), 0.01);
      cellSize = Math.max(0.002, Math.min(0.25, diagonal / 96));
      pointCandidates.forEach(function (candidate, index) {
        addToGrid(pointGrid, candidate.point, index);
      });
      segmentCandidates.forEach(function (candidate, index) {
        addToGrid(segmentGrid, candidate.midpoint, index);
        addToGrid(segmentGrid, candidate.a, index);
        addToGrid(segmentGrid, candidate.b, index);
      });
    }

    function setData(json) {
      data = json || null;
      ready = false;
      pointCandidates = [];
      segmentCandidates = [];
      bbox.makeEmpty();
      lastSnap = null;
      lastSnapAt = 0;

      if (!json || !json.features) return false;
      var features = json.features;

      (Array.isArray(features.circles) ? features.circles : []).forEach(function (item, index) {
        addPointCandidate('center', item.c, item.id || ('circle-' + index), item.component, 'CAD HOLE / CIRCLE CENTER', {
          radius: Number(item.r) || 0,
          normal: finitePointArray(item.n) ? item.n.slice(0, 3) : null
        });
      });

      (Array.isArray(features.vertices) ? features.vertices : []).forEach(function (item, index) {
        addPointCandidate('vertex', item.p, item.id || ('vertex-' + index), item.component, 'CAD VERTEX');
      });

      (Array.isArray(features.edges) ? features.edges : []).forEach(addSegmentCandidate);

      if (options.useFaceReferencePoints) {
        (Array.isArray(features.faces) ? features.faces : []).forEach(function (item, index) {
          addPointCandidate('face', item.p, item.id || ('face-' + index), item.component, 'CAD FACE REFERENCE', {
            normal: finitePointArray(item.n) ? item.n.slice(0, 3) : null,
            surfaceType: item.surfaceType || ''
          });
        });
      }

      buildIndexes();
      ready = pointCandidates.length > 0 || segmentCandidates.length > 0;
      return ready;
    }

    function load(url) {
      return fetch(url, {cache: 'no-store'})
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (json) {
          setData(json);
          return json;
        });
    }

    function getRootScale(object) {
      if (!object) return 1;
      object.getWorldScale(temp.rootScale);
      return Math.max(Math.abs(temp.rootScale.x), Math.abs(temp.rootScale.y), Math.abs(temp.rootScale.z), 1e-9);
    }

    function localizeRayAndHit(rayWorld, hitWorld, object) {
      object.updateMatrixWorld(true);
      temp.inverse.copy(object.matrixWorld).invert();
      temp.rayLocal.copy(rayWorld).applyMatrix4(temp.inverse);
      temp.hitLocal.copy(hitWorld).applyMatrix4(temp.inverse);
    }

    function queryGrid(grid, point, radius) {
      var c = cellCoords(point);
      var cellRadius = Math.max(1, Math.min(options.maxNeighbourCells, Math.ceil(radius / cellSize)));
      var found = new Set();
      for (var x = c.x - cellRadius; x <= c.x + cellRadius; x += 1) {
        for (var y = c.y - cellRadius; y <= c.y + cellRadius; y += 1) {
          for (var z = c.z - cellRadius; z <= c.z + cellRadius; z += 1) {
            var list = grid.get(keyForCell(x, y, z));
            if (!list) continue;
            list.forEach(function (index) { found.add(index); });
          }
        }
      }
      return Array.from(found);
    }

    function rayDistanceToPoint(ray, point) {
      ray.closestPointToPoint(point, temp.closestRay);
      return temp.closestRay.distanceTo(point);
    }

    function rayParameter(ray, point) {
      return point.clone().sub(ray.origin).dot(ray.direction);
    }

    function scorePointCandidate(candidate, hitLocal, rayLocal, radiusLocal, hitT, stickyId) {
      var hitDistance = candidate.point.distanceTo(hitLocal);
      var rayDistance = rayDistanceToPoint(rayLocal, candidate.point);
      if (rayDistance > radiusLocal) return null;
      var t = rayParameter(rayLocal, candidate.point);
      if (t < 0) return null;
      var priority = options.priority[candidate.kind] != null ? options.priority[candidate.kind] : 0.5;
      var score;

      if (candidate.kind === 'center') {
        var circleRadius = candidate.extra && Number(candidate.extra.radius) ? Number(candidate.extra.radius) : 0;
        var centerDepthWindow = Math.max(radiusLocal * options.depthWindowFactor, Math.min(0.20, Math.max(0.03, circleRadius * 0.40)));
        if (Math.abs(t - hitT) > centerDepthWindow) return null;
        score = (rayDistance / radiusLocal) * 0.82 + Math.min(1, Math.abs(t - hitT) / centerDepthWindow) * 0.18 + priority;
      } else {
        if (hitDistance > radiusLocal * 1.8) return null;
        if (Math.abs(t - hitT) > radiusLocal * options.depthWindowFactor) return null;
        score = (rayDistance / radiusLocal) * 0.62 + (hitDistance / (radiusLocal * 1.8)) * 0.38 + priority;
      }

      if (candidate.id === stickyId) score -= 0.22;
      return {candidate: candidate, point: candidate.point, score: score};
    }

    function scoreSegmentCandidate(candidate, hitLocal, rayLocal, radiusLocal, hitT, stickyId) {
      temp.line.set(candidate.a, candidate.b);
      temp.line.closestPointToPoint(hitLocal, true, temp.closestSegment);
      var hitDistance = temp.closestSegment.distanceTo(hitLocal);
      if (hitDistance > radiusLocal * 1.55) return null;
      var rayDistance = rayDistanceToPoint(rayLocal, temp.closestSegment);
      if (rayDistance > radiusLocal) return null;
      var t = rayParameter(rayLocal, temp.closestSegment);
      if (t < 0 || Math.abs(t - hitT) > radiusLocal * options.depthWindowFactor) return null;
      var score = (rayDistance / radiusLocal) * 0.68 + (hitDistance / (radiusLocal * 1.55)) * 0.32 + options.priority.edge;
      if (candidate.id === stickyId) score -= 0.18;
      return {candidate: candidate, point: temp.closestSegment.clone(), score: score};
    }

    function kindLabel(kind) {
      if (kind === 'center') return 'CAD HOLE CENTER';
      if (kind === 'vertex') return 'CAD VERTEX';
      if (kind === 'midpoint') return 'CAD MIDPOINT';
      if (kind === 'edge') return 'CAD EDGE';
      if (kind === 'face') return 'CAD FACE';
      return 'CAD POINT';
    }

    function snap(rayWorld, hitWorld, object, snapOptions) {
      snapOptions = snapOptions || {};
      if (!ready || !rayWorld || !hitWorld || !object) return null;
      rootObject = object;
      localizeRayAndHit(rayWorld, hitWorld, object);

      var rootScale = getRootScale(object);
      var distanceWorld = rayWorld.origin.distanceTo(hitWorld);
      var angularTolerance = Number(snapOptions.angularTolerance) || options.angularTolerance;
      var worldRadius = Math.max(options.minWorldRadius, Math.min(options.maxWorldRadius, distanceWorld * angularTolerance));
      var radiusLocal = worldRadius / rootScale;
      var hitT = rayParameter(temp.rayLocal, temp.hitLocal);
      var stickyId = lastSnap && (performance.now() - lastSnapAt <= options.stickyHoldMs) ? lastSnap.id : '';
      var best = null;

      var pointIndexSet = new Set(queryGrid(pointGrid, temp.hitLocal, radiusLocal * 1.8));
      var probeDepths = [radiusLocal * 3, 0.025 / rootScale, 0.06 / rootScale, 0.12 / rootScale];
      probeDepths.forEach(function (depth) {
        var probeT = Math.max(0, hitT - depth);
        temp.rayLocal.at(probeT, temp.queryPoint);
        queryGrid(pointGrid, temp.queryPoint, radiusLocal * 1.4).forEach(function (index) { pointIndexSet.add(index); });
      });
      pointIndexSet.forEach(function (index) {
        var scored = scorePointCandidate(pointCandidates[index], temp.hitLocal, temp.rayLocal, radiusLocal, hitT, stickyId);
        if (scored && (!best || scored.score < best.score)) best = scored;
      });

      queryGrid(segmentGrid, temp.hitLocal, radiusLocal * 1.8).forEach(function (index) {
        var scored = scoreSegmentCandidate(segmentCandidates[index], temp.hitLocal, temp.rayLocal, radiusLocal, hitT, stickyId);
        if (scored && (!best || scored.score < best.score)) best = scored;
      });

      if (!best) {
        if (lastSnap && performance.now() - lastSnapAt > options.stickyHoldMs) lastSnap = null;
        return null;
      }

      temp.worldPoint.copy(best.point).applyMatrix4(object.matrixWorld);
      lastSnap = {id: best.candidate.id, kind: best.candidate.kind, local: best.point.clone()};
      lastSnapAt = performance.now();

      return {
        point: temp.worldPoint.clone(),
        object: object,
        kind: best.candidate.kind,
        label: kindLabel(best.candidate.kind),
        source: 'cad',
        component: best.candidate.component || '',
        id: best.candidate.id,
        radiusWorld: worldRadius,
        sourceIntersection: snapOptions.sourceIntersection || null
      };
    }

    function resetSticky() {
      lastSnap = null;
      lastSnapAt = 0;
    }

    function stats() {
      return {
        ready: ready,
        points: pointCandidates.length,
        segments: segmentCandidates.length,
        sourceStats: data && data.stats ? data.stats : null,
        version: data && data.version ? data.version : null
      };
    }

    return {
      version: VERSION,
      load: load,
      setData: setData,
      snap: snap,
      resetSticky: resetSticky,
      isReady: function () { return ready; },
      stats: stats
    };
  }

  global.MOJA_PRECISION = {
    VERSION: VERSION,
    createEngine: createEngine
  };
})(window);
